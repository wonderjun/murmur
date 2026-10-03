/**
 * kimi-code adapter。
 *
 * 数据源（v0.41 实测）：$KIMI_CODE_HOME（默认 ~/.kimi-code）
 *   sessions/<wdHash>/<sessionId>/agents/<agent>/wire.jsonl —— 逐行事件流
 *   sessions/<wdHash>/<sessionId>/state.json —— title / workDir / lastPrompt
 *   session_index.jsonl —— 官方 sessionId → workDir 索引
 *
 * push 平面（0.41 实测 payload）：config.toml `[[hooks]]` 挂 19 事件 → ingest；
 *   恒带 session_id/cwd/client_type，无任何 usage 字段——token 台账只能靠 pull。
 * pull 平面保留：wire.jsonl 的 usage.record 是 token 唯一真源，另管 title
 *   （state.json）、历史回填与装 hook 前已跑会话的覆盖；interaction.request
 *   的 kind 细分（approval→permission.request / question→waiting(question)）
 *   也走这里——hook 侧没有提问事件，提问等待只能靠 pull（≤5s 延迟）。
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';

import { HOOKS_DIR, isHookInstalled, mergeTomlHooks, removeHookScript, tomlHookInstalled, unmergeTomlHooks } from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { fetchKimiQuota } from '../../quota/kimi';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { JsonlTailer, pick, serialScan, type AgentAdapter, type DataSourceRef } from '../base';
import { deleteKimiSessions, loadSessionIndex, scanKimiSessions } from './files';

/**
 * wire.jsonl 真实 schema（v0.41 实测）：
 *   顶层 { type, agentId, time(ms), ...payload }
 *   关键 type：
 *     turn.prompt                用户发起 turn（含 prompt 文本）
 *     turn.ended                 turn 收尾（reason: completed/cancelled/…）
 *     context.append_loop_event  {event:{type: step.begin|content.part|tool.call|tool.result|step.end}}
 *     usage.record               {model, usage:{inputOther,output,inputCacheRead,inputCacheCreation}, usageScope:"turn"}
 *     interaction.request        审批/提问请求（kind 细分）
 *     context.append_message     消息落库（role/content）
 * 其余（config.update / file_history / goal / metadata 等）是簿记噪音，跳过。
 */
interface WireMessage {
  type?: string;
  agentId?: string;
  /** ms epoch。 */
  time?: number;
  event?: { type?: string };
  model?: string;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  interaction?: { kind?: string };
  kind?: string;
}

/** 递归找 sessions/ 下所有 wire.jsonl（兼容 <sid>/wire.jsonl 与 <sid>/agents/<agent>/wire.jsonl 两种布局）。 */
function listWireFiles(sessionsDir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 5 || !existsSync(sessionsDir)) return out;
  for (const name of readdirSync(sessionsDir)) {
    const p = join(sessionsDir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    const direct = join(p, 'wire.jsonl');
    if (existsSync(direct)) {
      out.push(direct);
      continue;
    }
    out.push(...listWireFiles(p, depth + 1));
  }
  return out;
}

/** 从 wire 路径推 sessionId：<sid>/wire.jsonl 或 <sid>/agents/<agent>/wire.jsonl。 */
function wireMeta(path: string): { sessionId: string } {
  const parts = path.split('/');
  // …/agents/<agentId>/wire.jsonl → sessionId 在 agents 上一级
  const agentsIdx = parts.lastIndexOf('agents');
  if (agentsIdx > 0 && parts.length - agentsIdx === 3) {
    return { sessionId: parts[agentsIdx - 1] ?? 'unknown' };
  }
  return { sessionId: parts[parts.length - 2] ?? 'unknown' };
}

/** wire 路径 → 会话目录（向上爬到 basename === sessionId，兼容 agents/ 嵌套）。 */
function sessionDirOf(wirePath: string, sessionId: string): string {
  let dir = dirname(wirePath);
  for (let i = 0; i < 5 && dir !== '/' && dir.split('/').pop() !== sessionId; i++) dir = dirname(dir);
  return dir;
}

/** 读会话 state.json 的 title（isCustomTitle 是字符串 'False'，不能按布尔判——直接取 title）。 */
function loadSessionTitle(wirePath: string): string | undefined {
  const { sessionId } = wireMeta(wirePath);
  try {
    const state = JSON.parse(readFileSync(join(sessionDirOf(wirePath, sessionId), 'state.json'), 'utf8')) as {
      title?: string;
    };
    return state.title || undefined;
  } catch {
    return undefined;
  }
}

/** 单行 wire 事件 → 归一化事件列表。 */
export function translateWireLine(path: string, obj: WireMessage, title?: string): AgentEvent[] {
  const { sessionId } = wireMeta(path);
  // 无 time 的行（实测仅 metadata）按历史处理——0 表示不可定日期，engine 走回填语义不算活跃；
  // 非数字 time 钳回 0——NaN 会经 Math.max 把 lastEventAt 毒化成 NaN，会话永久隐形。
  const at = typeof obj.time === 'number' && Number.isFinite(obj.time) ? Math.round(obj.time) : 0;
  const base = { agent: 'kimi' as const, sessionId, at, title, model: obj.model, raw: obj };

  switch (obj.type) {
    case 'turn.prompt':
      return [
        { ...base, kind: 'session.start' },
        { ...base, kind: 'turn.start' },
      ];
    case 'turn.ended':
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'context.append_loop_event': {
      const et = obj.event?.type;
      if (et === 'tool.call') return [{ ...base, kind: 'tool.call' }];
      // step.begin/content.part/tool.result/step.end → 活动心跳（保持 working）。
      return [{ ...base, kind: 'status', status: 'working' }];
    }
    case 'usage.record': {
      const u = obj.usage ?? {};
      // inputOther 已是非缓存分量（实测与 inputCacheRead 互斥），cacheCreation 只归 cacheWrite——
      // 再并入 input 会在合计与成本里双计。
      const tokens: TokenUsage = {
        input: u.inputOther ?? 0,
        output: u.output ?? 0,
        cacheRead: u.inputCacheRead ?? 0,
        cacheWrite: u.inputCacheCreation ?? 0,
      };
      return [{ ...base, kind: 'usage', tokens }];
    }
    case 'interaction.request':
      return [{ ...base, kind: 'permission.request' }];
    default:
      return [];
  }
}

/**
 * kimi hook 事件全集（0.41 实测）。SessionHeartbeat 刻意不挂——订阅会让 agent
 * 每 60s 醒一次计时器，而 3min stale 扫描已够覆盖「疑似卡住」场景。
 */
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'UserPromptQueued',
  'TurnStarted',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'Stop',
  'StopFailure',
  'Interrupt',
  'TaskStarted',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PreCompact',
  'PostCompact',
];

/**
 * kimi hook stdin payload → 归一化事件。
 * 实测公共字段：hook_event_name/session_id/cwd/client_type；事件增量字段如
 * tool_name/tool_input（PreToolUse）、source/model（SessionStart）；无任何
 * usage 数据。payload 无时间戳——push 即当下，at 取 ingest 时刻。
 */
export function translateKimiHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const base = {
    agent: 'kimi' as const,
    sessionId: pick(p, 'session_id', 'sessionId') ?? 'unknown',
    cwd: pick(p, 'cwd'),
    title: pick(p, 'session_title', 'sessionTitle'),
    model: pick(p, 'model'),
    at: Date.now(),
    raw: payload,
  };
  switch (pick(p, 'hook_event_name', 'hookEventName')) {
    case 'SessionStart':
      return [{ ...base, kind: 'session.start' }];
    case 'SessionEnd':
      return [{ ...base, kind: 'session.end' }];
    case 'UserPromptSubmit':
    case 'TurnStarted':
      return [{ ...base, kind: 'turn.start' }];
    case 'PreToolUse':
    case 'SubagentStart':
      return [{ ...base, kind: 'tool.call' }];
    case 'PermissionRequest':
      return [{ ...base, kind: 'permission.request' }];
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
      // 正常收尾/失败/用户 Esc 都是「轮到你了」。
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'UserPromptQueued':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionResult':
    case 'SubagentStop':
    case 'TaskStarted':
    case 'PreCompact':
    case 'PostCompact':
      return [{ ...base, kind: 'status', status: 'working' }];
    default:
      // Notification 与未来新增事件：只刷活性，不迁移状态。
      return [{ ...base, kind: 'status' }];
  }
}

export function createKimiAdapter(): AgentAdapter {
  const paths = agentPaths('kimi');
  return {
    id: 'kimi',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home);
      const hasCredentials = existsSync(paths.credentials ?? '');
      let sessionCount = 0;
      try {
        sessionCount = existsSync(paths.sessions ?? '')
          ? readdirSync(paths.sessions ?? '', { withFileTypes: true }).filter((d) => d.isDirectory()).length
          : 0;
      } catch {}
      return {
        installed,
        hasCredentials,
        homeDir: paths.home,
        hookInstalled: isHookInstalled('kimi') && tomlHookInstalled(paths.hookConfig, 'kimi'),
        note: installed ? `${sessionCount} 个工作目录有会话` : '未发现 ~/.kimi-code',
      };
    },

    dataSources() {
      const out: DataSourceRef[] = [];
      if (paths.sessions) out.push({ label: '会话存储', path: paths.sessions, kind: 'dir' });
      if (paths.credentials) out.push({ label: '凭据', path: paths.credentials, kind: 'dir' });
      return out;
    },

    hookTargets: () => [paths.hookConfig ?? '', join(HOOKS_DIR, 'kimi.sh')].filter(Boolean),

    async installHooks() {
      if (!paths.hookConfig) return { changed: false };
      // kimi 无 stdout JSON 契约——不吐 {}，避免 UserPromptSubmit 把它注进上下文。
      return mergeTomlHooks(paths.hookConfig, 'kimi', HOOK_EVENTS, { stdoutAck: false });
    },

    async uninstallHooks() {
      if (!paths.hookConfig) return { changed: false };
      const r = unmergeTomlHooks(paths.hookConfig, 'kimi');
      removeHookScript('kimi');
      return r;
    },

    translateHook: translateKimiHook,

    async watch(emit, ledger: Ledger) {
      const tailer = new JsonlTailer(ledger);
      const sessionsDir = paths.sessions;
      if (!sessionsDir || !existsSync(sessionsDir)) return () => {};

      const tailAll = async (firstRun: boolean) => {
        // 每轮重读索引：新会话进来就能拿到 cwd。
        const index = loadSessionIndex(paths.home);
        const cutoff = Date.now() - BACKFILL_WINDOW_MS;
        for (const f of listWireFiles(sessionsDir)) {
          // 超出回填窗口没动过的文件不可能有新用量，整文件跳过。
          if ((statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) < cutoff) continue;
          const cwd = index.get(wireMeta(f).sessionId);
          const title = loadSessionTitle(f);
          await tailer.tail(f, firstRun, (obj) => {
            for (const e of translateWireLine(f, obj as WireMessage, title)) {
              emit(cwd && !e.cwd ? { ...e, cwd } : e);
            }
          });
        }
      };
      // watch 与定时器双入口 → 串行化，并发重入会重复读同一区间（usage 双计）。
      const rescan = serialScan(() => tailAll(false));

      await tailAll(true);
      const watcher = watch(sessionsDir, { recursive: true }, rescan);
      const rescanTimer = setInterval(rescan, 5000);
      return () => {
        watcher.close();
        clearInterval(rescanTimer);
      };
    },

    quota: fetchKimiQuota,

    scanSessions: scanKimiSessions,
    deleteSessions: deleteKimiSessions,
  };
}
