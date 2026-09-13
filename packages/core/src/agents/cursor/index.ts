/**
 * cursor adapter。
 *
 * push 平面：往 ~/.cursor/hooks.json 的 "hooks" key 合并注入（直挂 command 条目 +
 *   顶层 version:1——嵌套组形状 cursor-agent CLI 不触发），payload 走 stdin JSON，
 *   脚本先吐 {} 不干预决策链。
 * pull 平面：tail ~/.cursor/projects/<slug>/agent-transcripts/**.jsonl——
 *   行格式 {"role","message":{content:[text|tool_use]}} 加 turn_ended/error 状态行，
 *   无时间戳/无 sessionId/无 token（多工具实测一致）：at 取文件 mtime（真实最后写入
 *   时刻，活追加≈now 走 live 语义，旧文件走回填语义），sessionId 取文件名 uuid，
 *   subagents/ 下的行只作父会话活动心跳、不归并 turn 边界；
 *   另轮询 ~/.cursor/chats/<md5>/<uuid>/meta.json 覆盖 cursor-agent CLI 会话
 *   （updatedAtMs 前进→working、连续静默→waiting 的启发式；cwd 不可得，md5 不可逆）。
 * quota 平面：quota/cursor.ts（state.vscdb JWT → cursor.com/api/usage-summary）。
 *   ai-code-tracking.db 是 AI 代码溯源库（无 token 字段、实测为空），已弃用；
 *   本地无 per-token 计量源，today/week 台账恒空，用量面全靠 quota。
 */

import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

import { isHookInstalled, mergeJsonHooks, removeHookScript, unmergeJsonHooks } from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { readJsonFile } from '../../quota/common';
import { fetchCursorQuota, hasCursorCredentials } from '../../quota/cursor';
import type { AgentEvent, InstallInfo } from '../../types';
import { JsonlTailer, pick, serialScan, type AgentAdapter } from '../base';

// cursor 文档 hook 事件全集；CLI 只发其中子集（sessionStart/stop/postToolUse/
// afterFileEdit/*ShellExecution），多挂无害——不触发的事件只是占位。
const EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'afterAgentResponse',
  'afterAgentThought',
  'stop',
  'subagentStart',
  'subagentStop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'afterFileEdit',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
];

const TURN_END_EVENTS = new Set(['stop', 'afterAgentResponse']);
const TOOL_EVENTS = new Set([
  'preToolUse',
  'postToolUse',
  'afterFileEdit',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'subagentStart',
]);

/** cursor hook payload → 归一化事件。字段名以 hook_event_name/hookEventName 兼容。 */
export function translateHookPayload(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const event = pick(p, 'hook_event_name', 'hookEventName', 'event') ?? '';
  const sessionId = pick(p, 'conversation_id', 'conversationId', 'session_id', 'sessionId', 'composerId') ?? 'unknown';
  const base = {
    agent: 'cursor' as const,
    sessionId,
    cwd: pick(p, 'workspace_roots', 'cwd', 'workspaceFolder'),
    at: Date.now(),
    raw: payload,
  };
  if (event === 'sessionStart' || event === 'beforeSubmitPrompt') {
    return [
      { ...base, kind: 'session.start' },
      ...(event === 'beforeSubmitPrompt' ? [{ ...base, kind: 'turn.start' as const }] : []),
    ];
  }
  if (event === 'sessionEnd') return [{ ...base, kind: 'session.end' }];
  if (TURN_END_EVENTS.has(event)) return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
  if (TOOL_EVENTS.has(event)) return [{ ...base, kind: 'tool.call' }];
  // afterAgentThought/subagentStop 等 = turn 内活动心跳。
  return [{ ...base, kind: 'status', status: 'working' }];
}

/** transcript 路径 → 会话归属：subagents/ 下的文件归并到父会话 uuid。 */
function transcriptMeta(path: string): { sessionId: string; slug?: string; isSubagent: boolean } {
  const parts = path.split('/');
  const uuid = (parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '');
  const i = parts.lastIndexOf('agent-transcripts');
  const slug = i > 0 ? parts[i - 1] : undefined;
  const s = parts.lastIndexOf('subagents');
  if (s > 0 && i > 0 && s > i) return { sessionId: parts[s - 1] ?? uuid, slug, isSubagent: true };
  return { sessionId: uuid, slug, isSubagent: false };
}

const slugCache = new Map<string, string | undefined>();

/**
 * projects 目录名是工作区绝对路径把 '/' 换成 '-'（如 Users-chen-Documents-flow）。
 * 逐段贪心最长匹配真实目录还原（目录名本身含 '-' 的歧义靠 existsSync 裁决），
 * 还原不出宁可不填 cwd。
 */
function slugToPath(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  if (slugCache.has(slug)) return slugCache.get(slug);
  const segs = slug.split('-');
  let path = '';
  let i = 0;
  while (i < segs.length) {
    let hit = '';
    for (let j = segs.length; j > i; j--) {
      const cand = segs.slice(i, j).join('-');
      if (existsSync(join(path || '/', cand))) {
        hit = cand;
        break;
      }
    }
    if (!hit) break;
    path = join(path || '/', hit);
    i += hit.split('-').length;
  }
  const resolved = i === segs.length && path ? path : undefined;
  slugCache.set(slug, resolved);
  return resolved;
}

/** 首个 user 行 → 会话标题：优先 <user_query> 包裹文本，退化为首个 text 块。 */
function titleFromUserLine(obj: Record<string, unknown>): string | undefined {
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
  const text = content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
  const inner = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)?.[1] ?? text;
  const t = inner.trim().replace(/\s+/g, ' ').slice(0, 80);
  return t || undefined;
}

/** 判断 assistant 行是否含 tool_use 块。 */
function hasToolUse(obj: Record<string, unknown>): boolean {
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
  return content.some((b) => b.type === 'tool_use');
}

/**
 * transcript 行 → 归一化事件。at 由调用方传文件 mtime（行内无时间戳）。
 * 子代理行只产生父会话的活动信号，不搬 turn 边界（subagent turn_ended ≠ 父 turn 结束）。
 */
export function translateTranscriptLine(
  path: string,
  obj: Record<string, unknown>,
  at: number,
  title?: string,
): AgentEvent[] {
  const meta = transcriptMeta(path);
  const base = {
    agent: 'cursor' as const,
    sessionId: meta.sessionId,
    cwd: slugToPath(meta.slug),
    at,
    raw: obj,
    ...(title ? { title } : {}),
  };

  if (meta.isSubagent) {
    if (obj.role === 'assistant' && hasToolUse(obj)) return [{ ...base, kind: 'tool.call' }];
    return [{ ...base, kind: 'status', status: 'working' }];
  }
  if (obj.type === 'turn_ended' || obj.type === 'error') {
    return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
  }
  if (obj.role === 'user') {
    return [
      { ...base, kind: 'session.start' },
      { ...base, kind: 'turn.start' },
    ];
  }
  if (obj.role === 'assistant') {
    if (hasToolUse(obj)) return [{ ...base, kind: 'tool.call' }];
    return [{ ...base, kind: 'status', status: 'working' }];
  }
  return [{ ...base, kind: 'status' }];
}

/** 收集 projects 下全部 agent-transcripts jsonl（<uuid>.jsonl 与 <uuid>/<uuid>.jsonl、subagents/ 都收）。 */
function listTranscripts(projectsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const proj of readdirSync(projectsDir)) {
    walk(join(projectsDir, proj, 'agent-transcripts'), 0);
  }
  return out;
}

/** CLI 会话的轮询记忆：上次 updatedAtMs、是否刚报过 working、连续静默轮数。 */
interface CliSeen {
  updatedAt: number;
  working: boolean;
  quiet: number;
}

/**
 * cursor-agent CLI 会话探活：chats/<md5>/<uuid>/meta.json 的 updatedAtMs 是唯一
 * 免费的活性信号。前进→working，连续 ≥2 轮（≈10s+）不动且刚 working 过→waiting
 * （交互 CLI 静下来多半是在等输入；长工具跑也会写 blobs 推 updatedAt，误报率低）。
 */
function pollCliChats(chatsDir: string, emit: (e: AgentEvent) => void, seen: Map<string, CliSeen>) {
  if (!existsSync(chatsDir)) return;
  for (const ws of readdirSync(chatsDir)) {
    const wsPath = join(chatsDir, ws);
    if (!statSync(wsPath, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const sess of readdirSync(wsPath)) {
      const meta = readJsonFile(join(wsPath, sess, 'meta.json'));
      if (!meta) continue;
      const updatedAt = Number(meta.updatedAtMs ?? meta.createdAtMs ?? 0) || 0;
      const createdAt = Number(meta.createdAtMs ?? 0) || updatedAt;
      const title = typeof meta.title === 'string' ? meta.title : undefined;
      const base = { agent: 'cursor' as const, sessionId: sess };
      const st = seen.get(sess) ?? { updatedAt: 0, working: false, quiet: 0 };
      if (!seen.has(sess)) {
        // 建档即登记，否则无 updatedAtMs 的会话会每轮重发 session.start。
        emit({ ...base, kind: 'session.start', title, at: createdAt, raw: meta });
        seen.set(sess, { updatedAt, working: false, quiet: 0 });
        continue;
      }
      if (updatedAt > st.updatedAt) {
        emit({ ...base, kind: 'status', status: 'working', at: updatedAt });
        seen.set(sess, { updatedAt, working: true, quiet: 0 });
      } else if (st.working) {
        const quiet = st.quiet + 1;
        if (quiet >= 2) {
          emit({ ...base, kind: 'status', status: 'waiting', waitingReason: 'turn-end', at: updatedAt || Date.now() });
          seen.set(sess, { updatedAt, working: false, quiet });
        } else {
          seen.set(sess, { ...st, quiet });
        }
      }
    }
  }
}

export function createCursorAdapter(): AgentAdapter {
  const paths = agentPaths('cursor');
  return {
    id: 'cursor',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home);
      return {
        installed,
        hasCredentials: hasCursorCredentials(),
        homeDir: paths.home,
        hookInstalled: isHookInstalled('cursor'),
        note: installed ? undefined : '未发现 ~/.cursor',
      };
    },

    async installHooks() {
      if (!paths.hookConfig) return { changed: false };
      return mergeJsonHooks(paths.hookConfig, 'cursor', EVENTS);
    },

    async uninstallHooks() {
      if (!paths.hookConfig) return { changed: false };
      const r = unmergeJsonHooks(paths.hookConfig);
      removeHookScript('cursor');
      return r;
    },

    translateHook: translateHookPayload,

    async watch(emit, ledger: Ledger) {
      const projects = paths.sessions;
      const chatsDir = join(paths.home, 'chats');
      if ((!projects || !existsSync(projects)) && !existsSync(chatsDir)) return () => {};
      const tailer = new JsonlTailer(ledger);
      const titled = new Set<string>();
      const cliSeen = new Map<string, CliSeen>();

      const tailAll = async (firstRun: boolean) => {
        const cutoff = Date.now() - BACKFILL_WINDOW_MS;
        if (projects && existsSync(projects)) {
          for (const f of listTranscripts(projects)) {
            const st = statSync(f, { throwIfNoEntry: false });
            if (!st || st.mtimeMs < cutoff) continue;
            await tailer.tail(f, firstRun, (obj) => {
              let title: string | undefined;
              // 标题只取自首条 user 行，后续 user 行不覆盖（会话名以开场 prompt 为准）；
              // subagent 的首行是委派 prompt，不配当父会话标题。
              if (!titled.has(f) && obj.role === 'user' && !f.includes('/subagents/')) {
                title = titleFromUserLine(obj);
                titled.add(f);
              }
              for (const e of translateTranscriptLine(f, obj, st.mtimeMs, title)) emit(e);
            });
          }
        }
        try {
          pollCliChats(chatsDir, emit, cliSeen);
        } catch {
          // CLI 目录被并发改写时跳过本轮。
        }
      };

      // watch 与定时器双入口 → 串行化，并发重入会重复读同一区间。
      const rescan = serialScan(() => tailAll(false));
      await tailAll(true);
      const watcher = projects && existsSync(projects) ? watch(projects, { recursive: true }, rescan) : null;
      const rescanTimer = setInterval(rescan, 5000);
      return () => {
        watcher?.close();
        clearInterval(rescanTimer);
      };
    },

    quota: fetchCursorQuota,
  };
}
