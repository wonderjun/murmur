/**
 * zcode adapter（ZCode —— z.ai/GLM 系桌面 coding agent）。
 *
 * 数据源（实测 ~/.zcode）：
 *   v2/tasks-index.sqlite —— tasks 表：task_id(sess_*)/title/task_status/model/
 *     workspace_path/created_at/updated_at。这是「当前状态表」而非事件流：
 *     轮询全表（百行级），按 (task_status, updated_at) 变化发事件。
 *   cli/rollout/model-io-*.jsonl —— 每次模型调用一行，response.usage
 *     {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens} 为真实增量。
 *     单行 ~300KB（request 内嵌完整 prompt/消息与 authorization 头），
 *     走 tailRaw + json-span 只局部 parse 目标字段，不物化全量负载。
 *   v2/credentials.json —— enc:v1 加密存储，quota 暂不可拉（留待 BYOK）。
 *
 * push 平面（可选增强）：往 ~/.zcode/cli/config.json 合并 hooks.events 七事件
 *   + enabled:true，command+async 旁路不干预决策链。给 permission/实时 turn.end
 *   这两个 pull 拿不到的信号；usage 与 session.end 仍只能靠上面两路 pull。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isHookInstalled, mergeZcodeHooks, removeHookScript, unmergeZcodeHooks, zcodeHookState } from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import type { AgentEvent, TokenUsage } from '../../types';
import { JsonlTailer, pick, serialScan, type AgentAdapter } from '../base';
import { stringAtSpan, topLevelString, topLevelValueSpan, topLevelValueSpans } from '../json-span';

/** zcode hook 事件全集（~/.zcode/cli/config.json 的 hooks.events.<Event>[]）。 */
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
];

/** running 系 task_status → working（tasks 表轮询时持续心跳保持）。 */
const RUNNING = new Set(['running', 'in_progress', 'dispatching', 'claimed', 'executing']);
/** 排队/草稿/暂停 → idle。 */
const IDLE = new Set(['pending', 'queued', 'scheduled', 'paused', 'draft']);
/** 完成 → turn.end（轮到用户验收）。 */
const DONE = new Set(['completed', 'done', 'succeeded']);
/** 失败/取消 → session.end。 */
const DEAD = new Set(['error', 'failed', 'cancelled', 'canceled', 'aborted']);
/** running 行超过该时长没再更新 → 任务随进程死了，落 session.end 而非 working。 */
const RUNNING_FRESH_MS = 10 * 60_000;
/** tasks 轮询周期。 */
const TASKS_POLL_MS = 3_000;

interface TaskRow {
  workspace_key: string;
  task_id: string;
  title: string;
  task_status: string | null;
  model: string | null;
  workspace_path: string;
  created_at: number;
  updated_at: number;
}

/** rollout 文件名里的主会话 id（subagent 文件名的 sess_subagent_* 不匹配，走行内 sessionId）。 */
function rolloutSessionId(file: string): string | undefined {
  const m = /model-io-(sess_[0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(file);
  return m?.[1];
}

/** rollout 行需要提取的顶层字段（response 内再定位 usage，model 内再定位 modelId）。 */
const TOP_KEYS = ['response', 'model', 'sessionId', 'session_id', 'completedAt', 'startedAt'];

/** rollout 原始行 → usage 事件（模型调用逐次增量；单趟扫顶层，只局部 parse 目标子树）。 */
export function translateRolloutLine(file: string, line: string): AgentEvent[] {
  const top = topLevelValueSpans(line, TOP_KEYS);
  const resp = top.get('response');
  const usage = resp && topLevelValueSpan(line, 'usage', resp[0], resp[1]);
  if (!usage) return [];
  let u: Record<string, number>;
  try {
    u = JSON.parse(line.slice(usage[0], usage[1])) as Record<string, number>;
  } catch {
    return []; // usage 片段损坏：整行丢弃。
  }
  const total = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  if (total <= 0) return [];
  // 实测 inputTokens 含 cache 分量（totalTokens == input + output 恒成立）——
  // 归一化口径要求 input 与 cacheRead/Write 互斥，故先减去。
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const tokens: TokenUsage = {
    input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
    output: u.outputTokens ?? 0,
    cacheRead,
    cacheWrite,
  };
  const str = (k: string) => stringAtSpan(line, top.get(k));
  const sessionId = str('sessionId') ?? str('session_id') ?? rolloutSessionId(file) ?? 'unknown';
  const modelSpan = top.get('model');
  const modelId = modelSpan ? topLevelString(line, 'modelId', modelSpan[0], modelSpan[1]) : undefined;
  const at = Date.parse(str('completedAt') ?? str('startedAt') ?? '') || 0; // 无时间戳按历史处理。
  return [{ agent: 'zcode', sessionId, kind: 'usage', tokens, model: modelId, at, raw: undefined }];
}

/** zcode hook stdin payload → 归一化事件（hook_event_name/session_id，camelCase 双命名兼容）。 */
export function translateZcodeHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const sessionId = pick(p, 'session_id', 'sessionId') ?? 'unknown';
  // payload 可能含 prompt/tool_input 原文——不落库（同 rollout raw:undefined 的口径）。
  const base = { agent: 'zcode' as const, sessionId, cwd: pick(p, 'cwd'), at: Date.now(), raw: undefined };
  switch (pick(p, 'hook_event_name', 'hookEventName') ?? '') {
    case 'SessionStart':
      return [{ ...base, kind: 'session.start', model: pick(p, 'model') }];
    case 'UserPromptSubmit':
      return [{ ...base, kind: 'turn.start' }];
    case 'PreToolUse':
      return [{ ...base, kind: 'tool.call' }];
    case 'PermissionRequest':
      return [{ ...base, kind: 'permission.request' }];
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return [{ ...base, kind: 'status', status: 'working' }];
    case 'Stop':
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    default:
      return [];
  }
}

export function createZcodeAdapter(): AgentAdapter {
  return {
    id: 'zcode',

    async detect() {
      const paths = agentPaths('zcode');
      const tasksDb = join(paths.sessions ?? paths.home, 'tasks-index.sqlite');
      const rolloutDir = join(paths.home, 'cli', 'rollout');
      const installed = existsSync(tasksDb) || existsSync(rolloutDir);
      let taskCount = 0;
      try {
        if (existsSync(tasksDb)) {
          const db = new Database(`file:${tasksDb}?mode=ro`, { readonly: true });
          taskCount = (db.query('SELECT COUNT(*) n FROM tasks WHERE deleted=0').get() as { n: number }).n;
          db.close();
        }
      } catch {
        // DB 被占用或表结构不符时任务数按 0。
      }
      const hookState = zcodeHookState(paths.hookConfig);
      return {
        installed,
        hasCredentials: false, // credentials.json 是 enc:v1 加密存储，quota 拉不了。
        homeDir: paths.home,
        hookInstalled: hookState === 'active' && isHookInstalled('zcode'),
        note: installed
          ? `${taskCount} 个任务${hookState === 'disabled' ? '（hook 在 zcode 设置中被关闭）' : ''}`
          : '未发现 ~/.zcode/v2',
      };
    },

    async installHooks() {
      const paths = agentPaths('zcode');
      if (!paths.hookConfig) return { changed: false };
      return mergeZcodeHooks(paths.hookConfig, 'zcode', HOOK_EVENTS);
    },

    async uninstallHooks() {
      const paths = agentPaths('zcode');
      if (!paths.hookConfig) return { changed: false };
      const r = unmergeZcodeHooks(paths.hookConfig);
      removeHookScript('zcode');
      return r;
    },

    translateHook: translateZcodeHook,

    async watch(emit, ledger: Ledger) {
      const paths = agentPaths('zcode');
      const offs: Array<() => void> = [];

      // —— 任务状态轮询（v2/tasks-index.sqlite，当前状态表）。
      const tasksDb = join(paths.sessions ?? paths.home, 'tasks-index.sqlite');
      if (existsSync(tasksDb)) {
        const db = new Database(`file:${tasksDb}?mode=ro`, { readonly: true });
        // 续跑游标：上次见过的最大 updated_at；≤ 它的行不再重复发事件（防重启重复落账）。
        let minUpdated = Number(ledger.getCursor('zcode:tasks') ?? '0');
        const seen = new Map<string, string>(); // taskKey → `${status}:${updated_at}`
        const poll = () => {
          const now = Date.now();
          let rows: TaskRow[];
          try {
            rows = db
              .query(
                'SELECT workspace_key, task_id, title, task_status, model, workspace_path, created_at, updated_at FROM tasks WHERE deleted=0',
              )
              .all() as TaskRow[];
          } catch {
            return;
          }
          for (const r of rows) {
            const status = r.task_status ?? '';
            const key = `${r.workspace_key}:${r.task_id}`;
            const sig = `${status}:${r.updated_at}`;
            const base = {
              agent: 'zcode' as const,
              sessionId: r.task_id,
              cwd: r.workspace_path || undefined,
              title: r.title || undefined,
              model: r.model ?? undefined,
            };
            if (r.updated_at <= minUpdated && !seen.has(key)) {
              seen.set(key, sig);
              continue; // 上轮已建档过的历史行直接跳过。
            }
            const fresh = !seen.has(key) || seen.get(key) !== sig;
            if (!seen.has(key)) emit({ ...base, kind: 'session.start', at: r.created_at });
            if (fresh) {
              if (DONE.has(status)) emit({ ...base, kind: 'turn.end', waitingReason: 'turn-end', at: r.updated_at });
              else if (DEAD.has(status)) emit({ ...base, kind: 'session.end', at: r.updated_at });
              else if (IDLE.has(status)) emit({ ...base, kind: 'status', status: 'idle', at: r.updated_at });
            }
            if (RUNNING.has(status)) {
              if (now - r.updated_at < RUNNING_FRESH_MS) {
                // 状态表即当前态：行还在被写 → 任务活着。迁 working 只在签名变化
                // 时发；其余轮次发不迁移状态的裸 status 续 lastEventAt——否则
                // 每 3s 的 working 会压掉 push 平面刚送来的 waiting(approval)。
                emit(fresh ? { ...base, kind: 'status' as const, status: 'working' as const, at: now }
                           : { ...base, kind: 'status' as const, at: now });
              } else if (fresh) {
                // running 行长期不动 = 进程死在中途 → 已结束，不算"卡住"。
                emit({ ...base, kind: 'session.end', at: r.updated_at });
              }
            }
            seen.set(key, sig);
            if (r.updated_at > minUpdated) minUpdated = r.updated_at;
          }
          ledger.setCursor('zcode:tasks', String(minUpdated));
        };
        poll();
        const timer = setInterval(poll, TASKS_POLL_MS);
        offs.push(() => {
          clearInterval(timer);
          db.close();
        });
      }

      // —— 模型调用 rollout tail（cli/rollout/model-io-*.jsonl）。
      const rolloutDir = join(paths.home, 'cli', 'rollout');
      if (existsSync(rolloutDir)) {
        const tailer = new JsonlTailer(ledger);
        const tailAll = async (firstRun: boolean) => {
          const cutoff = Date.now() - BACKFILL_WINDOW_MS;
          let files: string[] = [];
          try {
            files = readdirSync(rolloutDir)
              .filter((f) => f.startsWith('model-io-') && f.endsWith('.jsonl'))
              .map((f) => join(rolloutDir, f));
          } catch {
            return;
          }
          for (const f of files) {
            if ((statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0) < cutoff) continue;
            await tailer.tailRaw(f, firstRun, (line) => {
              for (const e of translateRolloutLine(f, line)) emit(e);
            });
          }
        };
        // 定时器与手动触发同入口 → 串行化，并发重入会重复读同一区间（usage 双计）。
        const rescan = serialScan(() => tailAll(false));
        await tailAll(true);
        const timer = setInterval(rescan, 2000);
        offs.push(() => clearInterval(timer));
      }

      return () => {
        for (const off of offs) off();
      };
    },
  };
}
