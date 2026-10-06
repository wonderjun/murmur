/**
 * qoder adapter（新「Qoder」产品 com.qoder.app + qodercli 共享 runtime）。
 *
 * 架构事实（1.1.51 runtime / app 0.4.3 实测）：Qoder 桌面端经内嵌 qodercli 跑
 * 会话（qoder-data.v1.json 的 runtimes[] 写明 builtin qodercli），与终端 CLI
 * 共用 ~/.qoder 数据根——同一份 sessionId 同时出现在 transcript 与 app 的
 * main.sqlite.chat_sessions。故 CLI 会话自然搭车，不拆条目也不需区分来源。
 *
 * push 平面：merge 进 ~/.qoder/settings.json 的 hooks 键——Claude 兼容
 *   matcher-group 形状（{matcher?,hooks:[{type:command,...}]}），stdin payload
 *   带 session_id/transcript_path/cwd/hook_event_name；官方文档明示改配置即
 *   生效、无 trust 门槛；stdout {} 是合法 JSON 不被注入（仅 SessionStart/
 *   UserPromptSubmit 注入纯文本 stdout）。settings.json 是共享配置
 *   （providers 里有用户 API key），merge 只碰 hooks 子树。
 * pull 平面双通道：
 *   1. tail ~/.qoder/projects/<slug>/<uuid>.jsonl（含 transcript/ 子目录的
 *      委派任务转录）——Claude 兼容行，带 ISO timestamp 与 message.usage 全量
 *      token（input/cache_read/cache_creation/output 互斥口径原生吻合），
 *      ai-title 行给标题；usage 只能靠 pull（hook payload 无计量字段）。
 *   2. 只读轮询 app 的 main.sqlite（com.qoder.app.stable，darwin）——
 *      chat_sessions 是官方会话注册表（title/cwd/model/updated_at），
 *      chat_session_turn_states 是活跃 turn 瞬态表（有行即 working）。
 * quota 平面：v1 缺席——.auth/user 加密 blob 读不了，/api/v2/quota/usage
 *   需 bearer；PAT（QODER_PERSONAL_ACCESS_TOKEN）BYOK 通路留待验证。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  HOOKS_DIR,
  isHookInstalled,
  mergeQoderHooks,
  qoderHooksRegistered,
  removeHookScript,
  unmergeJsonHooks,
} from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { readJsonFile } from '../../quota/common';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { JsonlTailer, clip, pick, serialScan, type AgentAdapter, type DataSourceRef } from '../base';
import { deleteQoderSessions, scanQoderSessions, slugToPath } from './files';

/** qoder hook 事件：生命周期 + 工具 + 审批 + 任务粒度全收，文件级噪音（FileChanged 等）不挂。 */
const QODER_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Elicitation',
  'ElicitationResult',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
];

/** qoder hook stdin payload → 归一化事件。字段契约：session_id/cwd/hook_event_name（+事件增量）。 */
export function translateQoderHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const base = {
    agent: 'qoder' as const,
    sessionId: pick(p, 'session_id', 'sessionId') ?? 'unknown',
    cwd: pick(p, 'cwd', 'project_dir'),
    at: Date.now(),
    raw: payload,
  };
  switch (String(p.hook_event_name ?? p.hookEventName ?? p.event ?? '')) {
    case 'SessionStart':
      return [{ ...base, kind: 'session.start' }];
    case 'UserPromptSubmit': {
      // 用户回车即触发——最早 working 信号；prompt 顺带当会话标题。
      const prompt = pick(p, 'prompt');
      return [{ ...base, kind: 'turn.start', ...(prompt ? { title: prompt.slice(0, 120) } : {}) }];
    }
    case 'PreToolUse':
    case 'SubagentStart':
    case 'TaskCreated':
      return [{ ...base, kind: 'tool.call', detail: clip(pick(p, 'tool_name', 'toolName')) }];
    case 'PermissionRequest':
      return [{ ...base, kind: 'permission.request', detail: clip(pick(p, 'tool_name', 'toolName')) }];
    case 'Elicitation': {
      // agent 发起问询——在等用户输入；payload 里取问题原文做等待对象。
      const qs = Array.isArray(p.questions) ? (p.questions as Array<Record<string, unknown>>) : [];
      const q = pick(qs[0], 'question', 'header') ?? pick(p, 'question', 'message', 'prompt', 'title');
      return [{ ...base, kind: 'status', status: 'waiting', waitingReason: 'question', detail: clip(q) }];
    }
    case 'Stop':
    case 'StopFailure':
      // 回合停——「轮到你了」。
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'SessionEnd':
      return [{ ...base, kind: 'session.end' }];
    default:
      // PostToolUse*/PermissionDenied/ElicitationResult/SubagentStop/TaskCompleted/Notification/
      // Compact 等：回模型往返的心跳，防 stale。
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
  }
}

/** transcript 路径 → sessionId：文件名去 .jsonl（task-*.session.execution 也算独立会话）。 */
function transcriptSessionId(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.jsonl$/, '') || 'unknown';
}

/** 行内 timestamp → ms：ISO 串（含微秒尾）或 epoch 数；缺省/坏值 0——按回填语义处理。 */
function lineAt(obj: Record<string, unknown>): number {
  const t = obj.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) return Math.round(t);
  if (typeof t === 'string') return Date.parse(t) || 0;
  return 0;
}

/** user/assistant 行的 message.content → 文本、块类型集合与首个工具名。 */
function messageShape(obj: Record<string, unknown>): { text: string; blocks: Set<string>; toolName?: string } {
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  const blocks = new Set<string>();
  let text = '';
  let toolName: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      const t = typeof b?.type === 'string' ? b.type : '';
      if (t) blocks.add(t);
      if (t === 'text' && typeof b.text === 'string') parts.push(b.text);
      if (!toolName && t === 'tool_use') toolName = pick(b, 'name');
    }
    text = parts.join('\n');
  }
  return { text, blocks, toolName };
}

/** usage 字段 → 互斥 TokenUsage（Anthropic 口径原生吻合：input_tokens 即非缓存输入）。 */
function usageOf(obj: Record<string, unknown>): { tokens: TokenUsage; model?: string } | null {
  const msg = obj.message as Record<string, unknown> | undefined;
  const u = msg?.usage as Record<string, unknown> | undefined;
  if (!u) return null;
  const tokens: TokenUsage = {
    input: Number(u.input_tokens ?? 0) || 0,
    output: Number(u.output_tokens ?? 0) || 0,
    cacheRead: Number(u.cache_read_input_tokens ?? 0) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens ?? 0) || 0,
  };
  if (!tokens.input && !tokens.output && !tokens.cacheRead && !tokens.cacheWrite) return null;
  return { tokens, model: typeof msg?.model === 'string' ? msg.model : undefined };
}

/**
 * transcript 行 → 归一化事件。
 * user 行要区分真实 prompt 与 tool_result 回填块（全 tool_result 的行是工具
 * 输出落行，不是新回合）；isSidechain 行只作父会话心跳，不搬 turn 边界。
 * assistant 的 stop_reason 非 tool_use 即回合收尾——pull 侧兜底 turn.end
 * （装了 hook 的会话由 Stop 事件给权威信号，两边重复设置 waiting 无害）。
 */
export function translateTranscriptLine(path: string, obj: Record<string, unknown>, title?: string): AgentEvent[] {
  const sessionId = pick(obj, 'sessionId', 'session_id') ?? transcriptSessionId(path);
  const base = {
    agent: 'qoder' as const,
    sessionId,
    cwd: pick(obj, 'cwd'),
    at: lineAt(obj),
    raw: obj,
    ...(title ? { title } : {}),
  };
  const type = String(obj.type ?? '');

  if (type === 'workspace-directories') {
    const dirs = Array.isArray(obj.directories) ? (obj.directories as unknown[]) : [];
    const cwd = dirs.find((d): d is string => typeof d === 'string' && d.length > 0);
    return [{ ...base, kind: 'session.start', ...(cwd ? { cwd } : {}) }];
  }
  if (type === 'ai-title') {
    const t = pick(obj, 'aiTitle', 'title');
    return t ? [{ ...base, kind: 'status', title: t }] : [];
  }
  if (type === 'user') {
    const { blocks } = messageShape(obj);
    if (obj.isSidechain === true) return [{ ...base, kind: 'status', status: 'working' }];
    // content 只有 tool_result 块 = 工具结果回填——工具已收尾回模型，非用户回合也非新调用。
    if (blocks.size > 0 && [...blocks].every((b) => b === 'tool_result')) {
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
    }
    const out: AgentEvent[] = [
      { ...base, kind: 'session.start' },
      { ...base, kind: 'turn.start' },
    ];
    return out;
  }
  if (type === 'assistant') {
    const events: AgentEvent[] = [];
    const usage = usageOf(obj);
    if (usage) events.push({ ...base, kind: 'usage', tokens: usage.tokens, model: usage.model });
    if (obj.isSidechain === true) {
      events.push({ ...base, kind: 'status', status: 'working', phase: 'thinking' });
      return events;
    }
    const { blocks, toolName } = messageShape(obj);
    if (blocks.has('tool_use')) {
      events.push({ ...base, kind: 'tool.call', detail: clip(toolName) });
      return events;
    }
    const msg = obj.message as Record<string, unknown> | undefined;
    const stop = typeof msg?.stop_reason === 'string' ? msg.stop_reason : '';
    if (stop && stop !== 'tool_use') {
      events.push({ ...base, kind: 'turn.end', waitingReason: 'turn-end' });
      return events;
    }
    events.push({ ...base, kind: 'status', status: 'working', phase: 'thinking' });
    return events;
  }
  // system/progress/session_meta/attachment/file-history-snapshot/active-leaf/
  // worktree-state/last-prompt/runtime-config 等簿记行：只刷活性不迁移。
  return [{ ...base, kind: 'status', status: 'working', phase: 'thinking', model: pick(obj, 'model') }];
}

/** 递归收集 projects 下全部 transcript（<slug>/*.jsonl 与 transcript/、<uuid>/ 子目录都收）。 */
function listTranscripts(projectsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  try {
    for (const proj of readdirSync(projectsDir)) {
      walk(join(projectsDir, proj), 0);
    }
  } catch {
    // projects 目录被并发改写时本轮按空集处理。
  }
  return out;
}

/** 会话目录 slug → 工作区路径（'-'连接编码，逐段贪心还原；还原不出宁可空）。 */
function slugOf(path: string, projectsDir: string): string | undefined {
  const rel = path.slice(projectsDir.length + 1);
  const slug = rel.split('/')[0];
  return slug || undefined;
}

/** app 会话注册表的轮询记忆。 */
interface DbSeen {
  updatedAt: number;
  working: boolean;
  quiet: number;
  /** 已报过 ended（deleted_at 行常驻，防每轮重复 emit session.end）。 */
  ended?: boolean;
}

/** app 的 userData main.sqlite 绝对路径（darwin；其他平台返回 null）。 */
function appDbPath(): string | null {
  if (process.env.MURMUR_QODER_APP_DB) return process.env.MURMUR_QODER_APP_DB;
  if (process.platform !== 'darwin') return null;
  return join(homedir(), 'Library', 'Application Support', 'com.qoder.app.stable', 'main.sqlite');
}

/** app 版本：.qoder-app-status.json 优先（产品版本），bin/qodercli/version.txt（runtime）兜底。 */
function detectVersion(home: string): string | undefined {
  const status = readJsonFile(join(home, '.qoder-app-status.json'));
  const v = status?.version;
  if (typeof v === 'string' && v) return v;
  try {
    const s = readFileSync(join(home, 'bin/qodercli/version.txt'), 'utf8').trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

export function createQoderAdapter(): AgentAdapter {
  const paths = agentPaths('qoder');
  const dbPath = appDbPath();
  return {
    id: 'qoder',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home);
      return {
        installed,
        version: detectVersion(paths.home),
        hasCredentials: existsSync(paths.credentials ?? ''),
        homeDir: paths.home,
        hookInstalled: isHookInstalled('qoder') && qoderHooksRegistered(paths.hookConfig),
        note: installed ? undefined : '未发现 ~/.qoder',
      };
    },

    dataSources() {
      const out: DataSourceRef[] = [];
      if (paths.sessions) out.push({ label: '会话 transcript', path: paths.sessions, kind: 'dir' });
      if (dbPath) out.push({ label: 'app 台账', path: dbPath, kind: 'sqlite' });
      return out;
    },

    hookTargets: () => [paths.hookConfig ?? '', join(HOOKS_DIR, 'qoder.sh')].filter(Boolean),

    async installHooks() {
      if (!paths.hookConfig) return { changed: false };
      return mergeQoderHooks(paths.hookConfig, 'qoder', QODER_HOOK_EVENTS);
    },

    async uninstallHooks() {
      const r = paths.hookConfig ? unmergeJsonHooks(paths.hookConfig) : { changed: false };
      removeHookScript('qoder');
      return r;
    },

    translateHook: translateQoderHook,

    async watch(emit, ledger: Ledger) {
      const projects = paths.sessions;
      const hasProjects = Boolean(projects && existsSync(projects));
      const hasDb = Boolean(dbPath && existsSync(dbPath));
      if (!hasProjects && !hasDb) return () => {};
      const tailer = new JsonlTailer(ledger);
      const titled = new Set<string>();
      const dbSeen = new Map<string, DbSeen>();

      // 只读打开 app 台账（WAL 库、别人正在写：失败即降级 transcript 单通道）。
      let db: Database | null = null;
      if (hasDb && dbPath) {
        try {
          db = new Database(dbPath, { readonly: true });
        } catch {
          db = null;
        }
      }

      const tailAll = async (firstRun: boolean) => {
        const cutoff = Date.now() - BACKFILL_WINDOW_MS;
        if (!projects) return;
        for (const f of listTranscripts(projects)) {
          const st = statSync(f, { throwIfNoEntry: false });
          if (!st || st.mtimeMs < cutoff) continue;
          const fallbackCwd = slugToPath(slugOf(f, projects));
          await tailer.tail(f, firstRun, (obj) => {
            let title: string | undefined;
            // 标题只取首条真实 user 行；tool_result 回填行不算（后续真 prompt 仍有机会）。
            if (!titled.has(f) && obj.type === 'user' && obj.isSidechain !== true) {
              const { text, blocks } = messageShape(obj);
              if (!blocks.has('tool_result')) {
                title = text.trim().replace(/\s+/g, ' ').slice(0, 80) || undefined;
                titled.add(f);
              }
            }
            for (const e of translateTranscriptLine(f, obj, title)) {
              emit(!e.cwd && fallbackCwd ? { ...e, cwd: fallbackCwd } : e);
            }
          });
        }
      };

      /** app 台账轮询：注册表建档 + updated_at 活性启发式 + turn_states 活跃信号。 */
      const pollDb = () => {
        if (!db) return;
        try {
          const rows = db
            .query(
              `SELECT session_id, title, cwd, model, created_at, updated_at, deleted_at
               FROM chat_sessions ORDER BY updated_at DESC LIMIT 300`,
            )
            .all() as Array<{
            session_id: string;
            title: string | null;
            cwd: string | null;
            model: string | null;
            created_at: number;
            updated_at: number;
            deleted_at: number | null;
          }>;
          const cutoff = Date.now() - BACKFILL_WINDOW_MS;
          for (const row of rows) {
            const base = {
              agent: 'qoder' as const,
              sessionId: row.session_id,
              cwd: row.cwd ?? undefined,
              title: row.title ?? undefined,
              model: row.model ?? undefined,
            };
            const st = dbSeen.get(row.session_id);
            // 已删会话：建档过的落 ended 收尾（一次性），没见过的死档不建。
            if (row.deleted_at != null) {
              if (st && !st.ended) emit({ ...base, kind: 'session.end', at: row.deleted_at });
              dbSeen.set(row.session_id, { updatedAt: row.updated_at, working: false, quiet: 0, ended: true });
              continue;
            }
            if (!st) {
              if (row.created_at && row.created_at < cutoff && row.updated_at < cutoff) {
                // 死档不建档；但先登记 seen 防每轮重复 emit。
                dbSeen.set(row.session_id, { updatedAt: row.updated_at, working: false, quiet: 0 });
                continue;
              }
              emit({ ...base, kind: 'session.start', at: row.created_at || row.updated_at || Date.now() });
              dbSeen.set(row.session_id, { updatedAt: row.updated_at, working: false, quiet: 0 });
              continue;
            }
            if (row.updated_at > st.updatedAt) {
              emit({ ...base, kind: 'status', status: 'working', at: row.updated_at });
              dbSeen.set(row.session_id, { updatedAt: row.updated_at, working: true, quiet: 0 });
            } else if (st.working) {
              const quiet = st.quiet + 1;
              if (quiet >= 2) {
                emit({ ...base, kind: 'status', status: 'waiting', waitingReason: 'turn-end', at: st.updatedAt || Date.now() });
                dbSeen.set(row.session_id, { updatedAt: st.updatedAt, working: false, quiet });
              } else {
                dbSeen.set(row.session_id, { ...st, quiet });
              }
            }
          }
          // 活跃 turn 瞬态表：有行即 working（比 updated_at 更贴实时）。
          for (const row of db
            .query(`SELECT session_id FROM chat_session_turn_states GROUP BY session_id`)
            .all() as Array<{ session_id: string }>) {
            emit({ agent: 'qoder', sessionId: row.session_id, kind: 'status', status: 'working', at: Date.now() });
          }
        } catch {
          // DB 被占用/并发改写时跳过本轮。
        }
      };

      const rescan = serialScan(() => tailAll(false));
      await tailAll(true);
      pollDb();
      const watcher = hasProjects && projects ? watch(projects, { recursive: true }, rescan) : null;
      const rescanTimer = setInterval(rescan, 5000);
      const dbTimer = db ? setInterval(pollDb, 5000) : null;
      return () => {
        watcher?.close();
        clearInterval(rescanTimer);
        if (dbTimer) clearInterval(dbTimer);
        db?.close();
      };
    },

    scanSessions: scanQoderSessions,
    deleteSessions: deleteQoderSessions,
  };
}
