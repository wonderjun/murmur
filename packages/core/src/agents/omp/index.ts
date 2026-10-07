/**
 * omp adapter（oh-my-pi → omp CLI，Stencil Labs：Rust core + TS 扩展宿主）。
 *
 * push 平面：omp 没有 shell command hook——扩展是跑在 agent 进程内的 TS 模块
 *   （pi.on(event, handler) 订阅生命周期）。hooks/omp-script.ts 生成
 *   murmur-agent.ts，落 <agentDir>/extensions/（官方自动发现目录，无配置
 *   merge——这是与其它八家最不同的地方）。上报 payload 直传 omp snake_case
 *   事件名 + ctx.sessionManager 的 sessionId/cwd，翻译在本文件做。
 * pull 平面：tail <agentDir>/sessions/<slug>/<ts>_<uuid>.jsonl——v3 树形
 *   journal：session 头（id/cwd）、message（assistant 行带全量 usage/model/
 *   stopReason——独掌计量：push 的 message_end 同一数据须剥离防双计）、
 *   custom/tool_execution_start（带 toolName+
 *   intent——tool.call 最佳来源）、title/title_change、model_change。
 *   <ts>_<uuid>/ 子目录是 subagent 转录：归并父会话（usage 照计、不搬
 *   turn/session 边界，与 cursor subagents 同规）。命名 profile
 *   （<root>/profiles/<name>/agent/）一并枚举。
 * quota 平面：<agentDir>/agent.db 的 usage_history 是 omp 自采的 provider
 *   额度窗快照（used_fraction/resets_at/window_label）——本地只读即得
 *   QuotaWindow，零网络零凭据（auth_credentials 只用来探测 hasCredentials，
 *   credentials 列存真 token，永不 SELECT）。
 * 会话产物：sessions 下全部 .jsonl + subagent 目录归并到同一 sessionId；
 *   agent.db 行不动（omp 本体在写）。
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import {
  installOmpExtension,
  ompExtensionInstalled,
  ompExtensionPath,
  uninstallOmpExtension,
} from '../../hooks/omp-install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { JsonlTailer, clip, pick, serialScan, type AgentAdapter, type DataSourceRef } from '../base';
import {
  deleteOmpSessions,
  fileTimestamp,
  isSubagentFile,
  listSessionFiles,
  ompAgentDirs,
  scanOmpSessions,
  sessionFileId,
} from './files';
import { fetchOmpQuota, ompHasCredentials } from './quota';

/** 行内时间戳 → ms：多数行是 timestamp，title 行只有 updatedAt；再退文件名前缀，兜底 0。 */
function lineAt(obj: Record<string, unknown>, fileTs: number): number {
  const t = obj.timestamp ?? obj.updatedAt;
  if (typeof t === 'string') return Date.parse(t) || fileTs;
  if (typeof t === 'number' && Number.isFinite(t)) return Math.round(t);
  return fileTs;
}

/** 工具调用 detail：toolName + 常见参数字段的摘要（bash.command/edit.path/ask.question…）。 */
function toolDetail(name: string | undefined, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  const hint =
    pick(a, 'command', 'path', 'file_path', 'filePath', 'question', 'pattern', 'query', 'intent') ?? '';
  return clip(name ? `${name}${hint ? ` ${hint}` : ''}` : hint, 80);
}

/** assistant message.usage → TokenUsage（input/output/cacheRead/cacheWrite 原生吻合）。 */
function usageOf(msg: Record<string, unknown>): TokenUsage | undefined {
  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const t: TokenUsage = {
    input: Number(u.input ?? 0) || 0,
    output: Number(u.output ?? 0) || 0,
    cacheRead: Number(u.cacheRead ?? u.cache_read ?? 0) || 0,
    cacheWrite: Number(u.cacheWrite ?? u.cache_write ?? 0) || 0,
  };
  if (!t.input && !t.output && !t.cacheRead && !t.cacheWrite) return undefined;
  return t;
}

/** 行内文本拼接（title 候选/ask 问题提取用）。 */
function contentText(msg: Record<string, unknown>): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return (c as Array<Record<string, unknown>>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/**
 * 会话 journal 行 → 归一化事件。
 * isSub 行只产生活动/usage/tool.call，不搬 session/turn 边界（subagent 的
 * stopReason 不是父会话回合收尾）。'ask' 工具的 toolCall 触发 waiting(question)
 * ——等用户答复，toolResult 落行后自动回 working。
 */
export function translateSessionLine(
  sessionId: string,
  isSub: boolean,
  obj: Record<string, unknown>,
  fileTs = 0,
  title?: string,
): AgentEvent[] {
  const base = {
    agent: 'omp' as const,
    sessionId,
    at: lineAt(obj, fileTs),
    raw: obj,
    ...(title ? { title } : {}),
  };
  const type = String(obj.type ?? '');

  if (type === 'session') {
    if (isSub) return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
    const t = pick(obj, 'title');
    return [
      {
        ...base,
        kind: 'session.start',
        cwd: pick(obj, 'cwd'),
        ...(t ? { title: t } : {}),
      },
    ];
  }
  if (type === 'title' || type === 'title_change') {
    const t = pick(obj, 'title')?.trim();
    return t ? [{ ...base, kind: 'status', title: t }] : [];
  }
  if (type === 'model_change') {
    return [{ ...base, kind: 'status', model: pick(obj, 'model') }];
  }
  if (type === 'custom') {
    if (obj.customType === 'tool_execution_start') {
      const d = (obj.data ?? {}) as Record<string, unknown>;
      const detail = clip(
        [pick(d, 'toolName'), pick(d, 'intent')].filter(Boolean).join(' · ') || undefined,
        80,
      );
      const out: AgentEvent[] = [{ ...base, kind: 'tool.call', detail }];
      // ask 是面向用户的提问工具——执行开始即在等答复（toolResult 落行回 working）。
      if (!isSub && pick(d, 'toolName') === 'ask') {
        out.push({ ...base, kind: 'status', status: 'waiting', waitingReason: 'question', detail });
      }
      return out;
    }
    // session_exit 是主会话真实收尾（sighup/kill/exit）——pull 侧的 session.end；
    // subagent 文件里的同名记录不拖死父会话，只作活性心跳。
    if (obj.customType === 'session_exit') {
      if (isSub) return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
      const d = (obj.data ?? {}) as Record<string, unknown>;
      return [{ ...base, kind: 'session.end', detail: pick(d, 'reason') }];
    }
    return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
  }
  if (type !== 'message') {
    // compaction/branch_summary/label/mode_change/ttsr_injection/session_init 等簿记行：
    // 只刷活性不迁移状态（与 qoder 同规）。
    return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
  }

  const msg = (obj.message ?? {}) as Record<string, unknown>;
  const role = typeof msg.role === 'string' ? msg.role : '';
  const cwd = pick(obj, 'cwd');

  if (role === 'user') {
    if (isSub) return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
    // title 只经调用方传入（watcher 的首 prompt 兜底）；此处不重取文本——
    // 否则每条新 prompt 都覆盖 omp 自己生成的标题。
    return [{ ...base, kind: 'turn.start', cwd }];
  }
  if (role === 'assistant') {
    const events: AgentEvent[] = [];
    const tokens = usageOf(msg);
    if (tokens) {
      events.push({ ...base, kind: 'usage', tokens, model: pick(msg, 'model') });
    }
    const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
    const calls = content.filter((b) => b?.type === 'toolCall');
    if (isSub) {
      for (const b of calls) {
        events.push({ ...base, kind: 'tool.call', detail: toolDetail(pick(b, 'name'), b.arguments) });
      }
      if (!calls.length) events.push({ ...base, kind: 'status', status: 'working', phase: 'thinking' });
      return events;
    }
    for (const b of calls) {
      const name = pick(b, 'name');
      events.push({ ...base, kind: 'tool.call', detail: toolDetail(name, b.arguments) });
      // 旧版本文件无 custom/tool_execution_start 记录：ask 在这里也兜一份等待信号。
      if (name === 'ask') {
        const a = (b.arguments ?? {}) as Record<string, unknown>;
        events.push({
          ...base,
          kind: 'status',
          status: 'waiting',
          waitingReason: 'question',
          detail: clip(pick(a, 'question', 'intent') ?? 'ask', 80),
        });
      }
    }
    const stop = typeof msg.stopReason === 'string' ? msg.stopReason : '';
    if (stop && stop !== 'toolUse') {
      // stop/length/error/aborted/endTurn 等非 toolUse 收尾 → 回合结束等你。
      events.push({ ...base, kind: 'turn.end', waitingReason: 'turn-end' });
      return events;
    }
    if (!calls.length) events.push({ ...base, kind: 'status', status: 'working', phase: 'thinking' });
    return events;
  }
  // toolResult/developer/fileMention：活性心跳（toolResult = 工具收尾回模型）。
  return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
}

/**
 * omp 扩展上报 payload → 归一化事件。
 * 契约：{hook_event_name:<omp 事件名>, session_id, cwd, session_file, ...}——
 * session_id 由 ctx.sessionManager.getSessionId() 提供；session_switch/branch
 * 的 previous_session_file 用文件名反解旧 sessionId 补发 session.end。
 */
export function translateOmpHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const base = {
    agent: 'omp' as const,
    sessionId: pick(p, 'session_id', 'sessionId') ?? 'unknown',
    cwd: pick(p, 'cwd'),
    at: Date.now(),
    raw: payload,
  };
  switch (String(p.hook_event_name ?? p.hookEventName ?? '')) {
    case 'session_start':
      return [{ ...base, kind: 'session.start' }];
    case 'session_switch':
    case 'session_branch': {
      const prevFile = pick(p, 'previous_session_file', 'previousSessionFile');
      const prev = prevFile ? fileIdFromName(prevFile) : '';
      const out: AgentEvent[] = [{ ...base, kind: 'session.start' }];
      if (prev && prev !== base.sessionId) out.push({ ...base, sessionId: prev, kind: 'session.end' });
      return out;
    }
    case 'session_shutdown':
      return [{ ...base, kind: 'session.end' }];
    case 'before_agent_start':
      // prompt 不落成 title——omp 自产标题（journal title 记录）会被每条新
      // prompt 顶掉（engine 对 title 是后到先赢）。标题归 pull 平面管。
      return [{ ...base, kind: 'turn.start' }];
    case 'agent_end':
      // willContinue=true 是续跑（如 auto-retry/steer），不是回合收尾。
      return p.will_continue === true || p.willContinue === true
        ? [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }]
        : [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'agent_settled':
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'turn_start':
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
    case 'tool_execution_start': {
      const d = toolDetail(pick(p, 'tool_name', 'toolName'), undefined);
      const events: AgentEvent[] = [{ ...base, kind: 'tool.call', detail: d }];
      const name = pick(p, 'tool_name', 'toolName');
      if (name === 'ask') events.push({ ...base, kind: 'status', status: 'waiting', waitingReason: 'question', detail: d });
      return events;
    }
    case 'tool_approval_requested':
      return [
        {
          ...base,
          kind: 'permission.request',
          detail: clip(
            [pick(p, 'tool_name', 'toolName'), pick(p, 'reason')].filter(Boolean).join(' · ') || undefined,
            80,
          ),
        },
      ];
    case 'tool_approval_resolved':
    case 'tool_execution_end':
      return [{ ...base, kind: 'status', status: 'working', phase: 'tool' }];
    case 'message_end':
      // usage 计量归 pull 平面 journal 独掌（opencode 同规）——assistant 行的
      // usage 在 journal 与 message_end 里是同一份数据，push 再记就双计。
      // message_end 只作活性心跳：定稿即一轮模型往返收尾。
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
    default:
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
  }
}

/** 裸文件名（previous_session_file 等）→ sessionId（剥目录与 .jsonl 取 '_' 尾段）。 */
function fileIdFromName(file: string): string {
  const stem = (file.split('/').pop() ?? '').replace(/\.jsonl$/, '');
  const i = stem.lastIndexOf('_');
  return (i >= 0 ? stem.slice(i + 1) : stem) || '';
}

/** 版本探测：<agentDir>/last-changelog-version 是 omp 自写的版本戳。 */
function detectVersion(agentDir: string): string | undefined {
  try {
    const s = readFileSync(join(agentDir, 'last-changelog-version'), 'utf8').trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

export function createOmpAdapter(): AgentAdapter {
  const paths = agentPaths('omp');
  const agentDir = join(paths.sessions ?? join(paths.home, 'agent', 'sessions'), '..');
  const extDir = (d: string) => join(d, 'extensions');
  const sessionsDir = (d: string) => join(d, 'sessions');
  const agentDirs = () => ompAgentDirs();

  return {
    id: 'omp',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(agentDir);
      return {
        installed,
        version: installed ? detectVersion(agentDir) : undefined,
        hasCredentials: ompHasCredentials(),
        homeDir: paths.home,
        hookInstalled: ompExtensionInstalled(extDir(agentDir)),
        note: installed ? undefined : '未发现 ~/.omp',
      };
    },

    dataSources(): DataSourceRef[] {
      const out: DataSourceRef[] = [];
      for (const d of agentDirs()) {
        out.push({ label: '会话 journal', path: sessionsDir(d), kind: 'dir' });
        const db = join(d, 'agent.db');
        if (existsSync(db)) out.push({ label: '状态/额度库', path: db, kind: 'sqlite' });
      }
      return out;
    },

    hookTargets: () => agentDirs().map((d) => ompExtensionPath(extDir(d))),

    async installHooks() {
      let changed = false;
      for (const d of agentDirs()) {
        // 只往真实存在的 agent 目录落扩展——不为缺席的 profile 造幽灵目录。
        if (!existsSync(d)) continue;
        changed = (await installOmpExtension(extDir(d))).changed || changed;
      }
      return { changed };
    },

    async uninstallHooks() {
      let changed = false;
      for (const d of agentDirs()) {
        changed = uninstallOmpExtension(extDir(d)).changed || changed;
      }
      return { changed };
    },

    translateHook: translateOmpHook,

    async watch(emit, ledger: Ledger) {
      const tailer = new JsonlTailer(ledger);
      const titled = new Set<string>();
      const seen = new Set<string>();
      const watchers: FSWatcher[] = [];
      const watched = new Set<string>();

      // sessions 根每轮重算：首装用户在 watch 起后才建 sessions/、或中途加
      // 命名 profile，都能被 rescan 补挂 watcher 收进来。
      const roots = () =>
        agentDirs()
          .map(sessionsDir)
          .filter((d) => existsSync(d));

      const tailAll = async (firstRun: boolean) => {
        const cutoff = Date.now() - BACKFILL_WINDOW_MS;
        for (const root of roots()) {
          for (const f of listSessionFiles(root)) {
            const st = statSync(f, { throwIfNoEntry: false });
            if (!st || st.mtimeMs < cutoff) continue;
            const sessionId = sessionFileId(root, f);
            const isSub = isSubagentFile(root, f);
            const fileTs = fileTimestamp(f);
            // 首次照面的文件从头读：运行中新建的 journal 头部就在文件头，
            // 按 tailer 的「无游标即 seek 到尾」会丢 session.start 等头几行。
            const fresh = !seen.has(f);
            seen.add(f);
            await tailer.tail(f, firstRun || fresh, (obj) => {
              let title: string | undefined;
              // 标题兜底只取首条 user 行，且让位 omp 自产标题——title/title_change/
              // session 头已带真标题的文件不再用 prompt 覆盖（行序即真相）。
              if (obj.type === 'title' || obj.type === 'title_change' || obj.type === 'session') {
                if (typeof obj.title === 'string' && obj.title.trim()) titled.add(f);
              } else if (!titled.has(f) && !isSub && obj.type === 'message') {
                const m = (obj.message ?? {}) as Record<string, unknown>;
                if (m.role === 'user') {
                  title = clip(contentText(m).replace(/\s+/g, ' '), 80) || undefined;
                  titled.add(f);
                }
              }
              for (const e of translateSessionLine(sessionId, isSub, obj, fileTs, title)) emit(e);
            });
          }
        }
      };

      const rescan = serialScan(async () => {
        for (const r of roots()) {
          if (!watched.has(r)) {
            watched.add(r);
            watchers.push(watch(r, { recursive: true }, rescan));
          }
        }
        await tailAll(false);
      });
      await tailAll(true);
      // sessions 根递归 watch；agent 目录再补一层非递归——sessions/ 的创建
      // 本身也是事件，首装用户跑第一次会话就能进视野，不用等重启。
      for (const r of roots()) {
        if (!watched.has(r)) {
          watched.add(r);
          watchers.push(watch(r, { recursive: true }, rescan));
        }
      }
      for (const d of agentDirs()) {
        if (existsSync(d) && !watched.has(d)) {
          watched.add(d);
          watchers.push(watch(d, rescan));
        }
      }
      const rescanTimer = setInterval(rescan, 5000);
      return () => {
        for (const w of watchers) w.close();
        clearInterval(rescanTimer);
      };
    },

    quota: fetchOmpQuota,

    scanSessions: scanOmpSessions,
    deleteSessions: deleteOmpSessions,
  };
}
