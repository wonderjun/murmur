/**
 * codex adapter。
 *
 * pull 平面：watch ~/.codex/sessions 下的 rollout-*.jsonl，行形如
 *   {"type":"session_meta"|"response_item"|"event_msg"|"turn_context", "payload":{...}}；
 *   event_msg 里的 agent_message/token_count/task_complete 等映射状态与用量。
 * push 平面双通道：
 *   1. ~/.codex/hooks.json 注入全 12 个生命周期事件（官方 schema，stdin JSON，
 *      async 后台执行不阻塞 agent）——PermissionRequest 比 rollout 落行更早，
 *      但非 managed hook 需用户在 codex /hooks 里 trust 后才执行；
 *   2. ~/.codex/config.toml 写 notify = ["<script>"]（legacy，免 trust，
 *      仅 agent-turn-complete）兜底。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HOOKS_DIR,
  isHookInstalled,
  mergeCodexHooks,
  removeHookScript,
  unmergeCodexNotify,
  unmergeJsonHooks,
  writeHookScript,
} from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { fetchCodexQuota } from '../../quota/codex';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { JsonlTailer, clip, pick, serialScan, type AgentAdapter, type DataSourceRef } from '../base';
import { deleteCodexSessions, listRollouts, ROLLOUT_UUID_RE, scanCodexSessions } from './files';

/**
 * rollout 行 → 会话 id：文件名尾段 uuid 为唯一口径（push 侧 hookSessionId 同样抽它）。
 * response_item 的 payload.id 是条目 id（如 fc_x / rs_x）而非会话 id，不能吃；
 * session_meta 的 payload.id 才是会话 uuid，在文件名非标时作兜底。
 */
function rolloutSessionId(path: string, type: string, payload: Record<string, unknown>): string {
  return (
    ROLLOUT_UUID_RE.exec(path)?.[1] ??
    (type === 'session_meta' ? pick(payload, 'id') : undefined) ??
    pick(payload, 'session_id', 'sessionId') ??
    path.split('/').pop()?.replace('.jsonl', '') ??
    'unknown'
  );
}

/** rollout 行 → 归一化事件。 */
export function translateRolloutLine(path: string, obj: Record<string, unknown>): AgentEvent[] {
  const type = String(obj.type ?? '');
  const payload = (obj.payload ?? {}) as Record<string, unknown>;
  const sessionId = rolloutSessionId(path, type, payload);
  const at = obj.timestamp ? Date.parse(String(obj.timestamp)) || 0 : 0; // 无时间戳按历史处理，防回放幽灵会话。
  const base = { agent: 'codex' as const, sessionId, at, raw: obj };

  if (type === 'session_meta') {
    return [{ ...base, kind: 'session.start', cwd: pick(payload, 'cwd') }];
  }
  if (type === 'event_msg') {
    const sub = String(payload.type ?? '');
    if (sub === 'task_started' || sub === 'turn_started') return [{ ...base, kind: 'turn.start' }];
    if (sub === 'task_complete' || sub === 'turn_complete' || sub === 'agent_message_delta_done') {
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    }
    if (sub === 'token_count' || sub === 'token_usage') {
      const t = (payload.info ?? payload) as Record<string, unknown>;
      // last_token_usage 是本 turn 增量；total_token_usage 是累计值，兜底用（会高估）。
      const usage = (t.last_token_usage ?? t.total_token_usage ?? {}) as Record<string, number>;
      // codex 的 input_tokens 是非缓存输入，cached_input_tokens 单列（TokenUsage 互斥口径）。
      const tokens: TokenUsage = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cached_input_tokens ?? 0,
        reasoning: usage.reasoning_output_tokens ?? 0,
      };
      return [{ ...base, kind: 'usage', tokens, model: pick(t, 'model') }];
    }
    if (sub === 'exec_approval_request' || sub === 'apply_patch_approval_request') {
      // 审批对象：exec 是命令串（数组形），apply_patch 是补丁摘要。
      const cmd = Array.isArray(payload.command) ? (payload.command as unknown[]).join(' ') : pick(payload, 'command', 'call_id');
      return [{ ...base, kind: 'permission.request', detail: clip(cmd) }];
    }
    return [{ ...base, kind: 'status' }];
  }
  if (type === 'response_item') {
    const itemType = String(payload.type ?? '');
    if (itemType === 'function_call' || itemType === 'local_shell_call') {
      return [{ ...base, kind: 'tool.call', detail: clip(pick(payload, 'name', 'tool')) }];
    }
    return [{ ...base, kind: 'status' }];
  }
  return [{ ...base, kind: 'status' }];
}

/** codex notify 回调 argv JSON → 归一化事件。 */
export function translateNotifyPayload(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const sessionId = pick(p, 'session-id', 'session_id', 'sessionId', 'thread-id') ?? 'unknown';
  const type = pick(p, 'type', 'event') ?? '';
  const base = {
    agent: 'codex' as const,
    sessionId,
    cwd: pick(p, 'cwd', 'turn-context'),
    at: Date.now(),
    raw: payload,
  };
  if (type.includes('complete') || type.includes('agent-turn-complete')) {
    return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
  }
  return [{ ...base, kind: 'status' }];
}

/** hooks.json 事件全挂清单：观察面全收，映射不了的在翻译层落 status 心跳。 */
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
];

/** hook stdin payload → sessionId：优先 transcript_path 的 rollout uuid，兜底各 id 字段。 */
function hookSessionId(p: Record<string, unknown>): string {
  const transcript = pick(p, 'transcript_path');
  const m = transcript ? ROLLOUT_UUID_RE.exec(transcript) : null;
  if (m) return m[1];
  return pick(p, 'session_id', 'session-id', 'sessionId', 'thread_id', 'thread-id') ?? 'unknown';
}

/** codex hooks.json 事件（stdin JSON,hook_event_name 分发）→ 归一化事件。 */
export function translateCodexHookEvent(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const base = {
    agent: 'codex' as const,
    sessionId: hookSessionId(p),
    cwd: pick(p, 'cwd'),
    model: pick(p, 'model'),
    at: Date.now(),
    raw: payload,
  };
  switch (String(p.hook_event_name ?? '')) {
    case 'SessionStart':
      return [{ ...base, kind: 'session.start' }];
    case 'UserPromptSubmit': {
      // 用户回车即触发——全链路最早的 working 信号；prompt 顺带当会话标题。
      const prompt = pick(p, 'prompt');
      return [{ ...base, kind: 'turn.start', ...(prompt ? { title: prompt.slice(0, 120) } : {}) }];
    }
    case 'PreToolUse':
      // 工具执行前触发，比 rollout 的 response_item 落行更早。
      return [{ ...base, kind: 'tool.call', detail: clip(pick(p, 'tool_name', 'toolName')) }];
    case 'PermissionRequest':
      return [{ ...base, kind: 'permission.request', detail: clip(pick(p, 'tool_name', 'toolName')) }];
    case 'Stop':
    case 'Interrupt':
      // 回合停/被中断——都是「轮到你了」。
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'SessionEnd':
      return [{ ...base, kind: 'session.end' }];
    default:
      // PostToolUse/PreCompact/PostCompact/Subagent*/未知事件：回模型往返的心跳。
      return [{ ...base, kind: 'status', phase: 'thinking' }];
  }
}

/** hook POST payload 分发：hooks.json 事件认 hook_event_name，其余按 legacy notify argv 格式翻。 */
export function translateCodexHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p.hook_event_name === 'string' && p.hook_event_name) return translateCodexHookEvent(payload);
  return translateNotifyPayload(payload);
}

/** hooks.json 里是否已有我们的条目（脚本路径片段判归属）。 */
function hooksJsonRegistered(home: string): boolean {
  try {
    return readFileSync(join(home, 'hooks.json'), 'utf8').includes('agent-hooks/codex.sh');
  } catch {
    // 文件不存在或不可读都算未注册。
    return false;
  }
}

/** 往 config.toml 合并 notify（顶层单值键：已有顶层 notify 不覆盖，保 orca 等同类工具）。 */
function mergeCodexNotify(cfgPath: string): { changed: boolean } {
  const command = writeHookScript('codex');
  const scriptPath = command.match(/'([^']+\.sh)'/)?.[1] ?? '';
  const text = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  // notify 已指向我们的脚本且脚本在盘才算装好；路径对但脚本丢失时继续重写。
  if (text.includes(scriptPath) && isHookInstalled('codex')) return { changed: false };
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  // notify 是顶层键：查重与插入都限定在首个表头之前——EOF 属于最后一个
  // [table]，往文件尾追加会落进错的作用域，甚至与表内 notify 撞成重复键。
  const lines = text.split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const topRegion = (firstTable === -1 ? lines : lines.slice(0, firstTable)).join('\n');
  if (/^notify\s*=/m.test(topRegion)) return { changed: false };
  const inject = `# murmur hook: agent-turn-complete 通知\nnotify = ["${scriptPath}"]`;
  const next =
    firstTable === -1
      ? `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${inject}\n`
      : [...lines.slice(0, firstTable), '', inject, '', ...lines.slice(firstTable)].join('\n');
  const tmp = `${cfgPath}.murmur-tmp`;
  writeFileSync(tmp, next);
  chmodSync(tmp, 0o600);
  renameSync(tmp, cfgPath);
  return { changed: true };
}

export function createCodexAdapter(): AgentAdapter {
  const paths = agentPaths('codex');
  return {
    id: 'codex',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home);
      // hooks.json 有我们的条目不代表已生效——codex 要求非 managed hook 经 /hooks trust。
      const note = !installed
        ? '未发现 ~/.codex'
        : hooksJsonRegistered(paths.home)
          ? '全事件推送需在 codex 中 /hooks 信任 murmur 条目'
          : undefined;
      return {
        installed,
        hasCredentials: existsSync(paths.credentials ?? ''),
        homeDir: paths.home,
        hookInstalled: isHookInstalled('codex'),
        note,
      };
    },

    dataSources() {
      const out: DataSourceRef[] = [];
      if (paths.sessions) out.push({ label: '会话 rollout', path: paths.sessions, kind: 'dir' });
      if (paths.credentials) out.push({ label: '凭据', path: paths.credentials, kind: 'file' });
      return out;
    },

    // hooks.json 是全事件通道、config.toml 是 legacy notify 兜底——两文件都触碰。
    hookTargets: () =>
      [join(paths.home, 'hooks.json'), paths.hookConfig ?? '', join(HOOKS_DIR, 'codex.sh')].filter(Boolean),

    async installHooks() {
      const cfg = paths.hookConfig;
      if (!cfg) return { changed: false };
      const hooks = mergeCodexHooks(join(paths.home, 'hooks.json'), 'codex', CODEX_HOOK_EVENTS);
      const notify = mergeCodexNotify(cfg);
      return { changed: hooks.changed || notify.changed };
    },

    async uninstallHooks() {
      const hooks = unmergeJsonHooks(join(paths.home, 'hooks.json'));
      const notify = paths.hookConfig ? unmergeCodexNotify(paths.hookConfig, 'codex') : { changed: false };
      removeHookScript('codex');
      return { changed: hooks.changed || notify.changed };
    },

    translateHook: translateCodexHook,

    async watch(emit, ledger: Ledger) {
      const dir = paths.sessions;
      if (!dir || !existsSync(dir)) return () => {};
      const tailer = new JsonlTailer(ledger);
      const tailAll = async (firstRun: boolean) => {
        const cutoff = Date.now() - BACKFILL_WINDOW_MS;
        for (const f of listRollouts(dir)) {
          if ((statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) < cutoff) continue;
          await tailer.tail(f, firstRun, (obj) => {
            for (const e of translateRolloutLine(f, obj)) emit(e);
          });
        }
      };
      // watch 与定时器双入口 → 串行化，并发重入会重复读同一区间（usage 双计）。
      const rescan = serialScan(() => tailAll(false));
      await tailAll(true);
      const watcher = watch(dir, { recursive: true }, rescan);
      const rescanTimer = setInterval(rescan, 5000);
      return () => {
        watcher.close();
        clearInterval(rescanTimer);
      };
    },

    quota: fetchCodexQuota,

    scanSessions: scanCodexSessions,
    deleteSessions: deleteCodexSessions,
  };
}
