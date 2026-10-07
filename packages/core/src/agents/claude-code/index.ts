/**
 * claude-code adapter（Anthropic Claude Code：终端 CLI + IDE/桌面宿主共享数据根）。
 *
 * 架构事实（官方文档 v2.x；transcript 是内部格式、版本敏感，行解析全部防御式）：
 * 数据根 ~/.claude（CLAUDE_CONFIG_DIR 可整体搬迁），终端 CLI 与 IDE/桌面扩展
 * 宿主共用——同一 sessionId 落在 projects/<slug>/<uuid>.jsonl 与各宿主的
 * ~/.claude.json projects 条目。
 *
 * push 平面：merge 进 ~/.claude/settings.json 的 hooks 键——官方 matcher-group
 *   形状（{matcher?,hooks:[{type:command,...}]}），条目带 async:true 后台执行
 *   不阻塞会话；stdin payload 带 session_id/transcript_path/cwd/
 *   hook_event_name/permission_mode。官方明示改配置即生效、无 trust 门槛；
 *   stdout {} 是合法 JSON 不被注入（仅 SessionStart/UserPromptSubmit 注入
 *   纯文本 stdout，async 脚本无决策语义）。settings.json 是共享用户配置
 *   （permissions/env/model 同住），merge 只碰 hooks 子树、卸载只摘我方条目。
 * pull 平面：tail projects/<slug>/*.jsonl（orphaned/superseded 变体同 uuid
 *   归并）——行带 ISO timestamp、cwd 与 message.usage 全量 token
 *   （input/cache_read/cache_creation/output 互斥口径原生吻合）；summary/
 *   custom-title 行给标题；isSidechain 行（Task 子代理）只作父会话心跳、
 *   usage 照计。<uuid>/subagents/ 下的独立转录文件不 tail——子代理不建
 *   独立顶层会话。usage 只能靠 pull（hook payload 无计量字段）。
 * quota 平面：登录 Keychain "Claude Code-credentials"（CLAUDE_CONFIG_DIR
 *   自定义时 service 带 sha256 后缀）→ .credentials.json 兜底，OAuth
 *   accessToken 打 api.anthropic.com/api/oauth/usage；凭据严格只读、
 *   过期不代刷（旋转 refresh 事故先例），降级 unavailable。
 * 会话产物：见 ./files.ts——projects 转录 + file-history/tasks/session-env/
 *   todos/debug 旁路归并，~/.claude.json 与 settings.json 不碰。
 */

import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  HOOKS_DIR,
  claudeHooksRegistered,
  isHookInstalled,
  mergeClaudeHooks,
  removeHookScript,
  unmergeJsonHooks,
} from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { fetchClaudeQuota, hasClaudeOAuth } from '../../quota/claude';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { JsonlTailer, clip, pick, serialScan, slugToPath, type AgentAdapter, type DataSourceRef } from '../base';
import { deleteClaudeSessions, scanClaudeSessions } from './files';

/**
 * claude hook 事件：生命周期 + 工具 + 审批 + 问询 + 任务/子代理粒度全收；
 * 文件级/噪音事件（FileChanged、CwdChanged、ConfigChange、WorktreeCreate 等）
 * 与阻塞语义事件（PreModelSwitch、Setup）不挂——纯观察者只读不拦。
 */
const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'PermissionDenied',
  'Elicitation',
  'ElicitationResult',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'Notification',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
];

/** claude hook stdin payload → 归一化事件。字段契约：session_id/cwd/hook_event_name（+事件增量）。 */
export function translateClaudeHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const base = {
    agent: 'claude-code' as const,
    sessionId: pick(p, 'session_id', 'sessionId') ?? 'unknown',
    cwd: pick(p, 'cwd'),
    at: Date.now(),
    raw: payload,
  };
  switch (String(p.hook_event_name ?? p.hookEventName ?? p.event ?? '')) {
    case 'SessionStart':
      // source（startup/resume/clear/compact）不改变语义：建档或复活即可。
      return [
        {
          ...base,
          kind: 'session.start',
          ...(pick(p, 'session_title') ? { title: pick(p, 'session_title') } : {}),
          ...(pick(p, 'model') ? { model: pick(p, 'model') } : {}),
        },
      ];
    case 'UserPromptSubmit': {
      // 用户回车即触发——最早 working 信号；prompt 顺带当会话标题。
      const prompt = pick(p, 'prompt');
      return [{ ...base, kind: 'turn.start', ...(prompt ? { title: prompt.slice(0, 120) } : {}) }];
    }
    case 'PreToolUse':
      return [{ ...base, kind: 'tool.call', detail: clip(pick(p, 'tool_name', 'toolName')) }];
    case 'PermissionRequest': {
      // 审批卡给谁看：工具名 + Bash 类命令原文（detail=工具名/命令，上限 80 字）。
      const input = (p.tool_input ?? p.toolInput) as Record<string, unknown> | undefined;
      const what = [pick(p, 'tool_name', 'toolName'), pick(input, 'command')].filter(Boolean).join(' · ');
      return [{ ...base, kind: 'permission.request', detail: clip(what || undefined) }];
    }
    case 'SubagentStart':
      return [{ ...base, kind: 'tool.call', detail: clip(pick(p, 'agent_type', 'agent_id') ?? 'subagent') }];
    case 'TaskCreated':
      return [{ ...base, kind: 'tool.call', detail: clip(pick(p, 'task_subject', 'task', 'subject') ?? 'task') }];
    case 'Elicitation': {
      // MCP elicitation——服务端向用户要输入；detail 拼 服务器名 · 问题原文（url 模式兜底 url）。
      const q = [pick(p, 'mcp_server_name'), pick(p, 'message', 'url')]
        .filter(Boolean)
        .join(' · ');
      return [{ ...base, kind: 'status', status: 'waiting', waitingReason: 'question', detail: clip(q || undefined) }];
    }
    case 'Stop':
    case 'StopFailure':
      // 回合停——「轮到你了」。
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'SessionEnd':
      return [{ ...base, kind: 'session.end' }];
    case 'PostModelSwitch':
      return [
        { ...base, kind: 'status', status: 'working', phase: 'thinking', model: pick(p, 'to_model', 'model') },
      ];
    case 'Notification': {
      // 通知按类型分诊：等权限/等输入/等回合的等待信号，其余只刷活性。
      switch (String(p.notification_type ?? '')) {
        case 'permission_prompt':
          return [{ ...base, kind: 'permission.request', detail: clip(pick(p, 'message')) }];
        case 'idle_prompt':
          return [{ ...base, kind: 'status', status: 'waiting', waitingReason: 'turn-end' }];
        case 'elicitation_dialog':
        case 'elicitation_url_dialog':
        case 'agent_needs_input':
          return [
            {
              ...base,
              kind: 'status',
              status: 'waiting',
              waitingReason: 'question',
              detail: clip(pick(p, 'message', 'title')),
            },
          ];
        case 'agent_completed':
          return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
        case 'quota_auto_resume_stale':
        case 'quota_auto_resume_disabled':
          // 配额没续上：回合实际已停，等待用户处置。
          return [
            {
              ...base,
              kind: 'status',
              status: 'waiting',
              waitingReason: 'turn-end',
              detail: clip(pick(p, 'message')),
            },
          ];
        case 'auth_success':
          // /login 完成不在回合内——只刷活性，不冒充 working。
          return [{ ...base, kind: 'status' }];
        default:
          // quota_auto_resume_fired/elicitation_complete/elicitation_response/未知类型：
          // 回合内活动心跳（elicitation 响应回模型即续跑）。
          return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
      }
    }
    default:
      // PostToolUse*/PostToolBatch/PermissionDenied/ElicitationResult/SubagentStop/
      // TaskCompleted/UserPromptExpansion/PreCompact/PostCompact 等：回合内活动心跳。
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
  }
}

/** transcript 路径 → sessionId：文件名首个 uuid 段（orphaned/superseded 变体归并同会话）。 */
function transcriptSessionId(path: string): string {
  const name = (path.split('/').pop() ?? '') || 'unknown';
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(name);
  return (m ? m[0].toLowerCase() : name.replace(/\.jsonl.*$/, '')) || 'unknown';
}

/** 行内 timestamp → ms：ISO 串；缺省/坏值 0——按回填语义处理。 */
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
 * transcript 行 → 归一化事件（内部格式版本敏感，未知行一律退化心跳）。
 * user 行要区分真实 prompt 与 tool_result 回填块（全 tool_result 的行是工具
 * 输出落行，不是新回合）；isMeta 簿记行（/clear、本地命令回执）只刷活性；
 * isSidechain 行（Task 子代理）不搬 turn 边界、usage 照计父会话。
 * assistant 的 stop_reason 非 tool_use 即回合收尾——pull 侧兜底 turn.end
 * （装了 hook 的会话由 Stop 事件给权威信号，两边重复设置 waiting 无害）。
 */
export function translateClaudeTranscriptLine(
  path: string,
  obj: Record<string, unknown>,
  title?: string,
): AgentEvent[] {
  const sessionId = pick(obj, 'sessionId', 'session_id') ?? transcriptSessionId(path);
  const base = {
    agent: 'claude-code' as const,
    sessionId,
    cwd: pick(obj, 'cwd'),
    at: lineAt(obj),
    raw: obj,
    ...(title ? { title } : {}),
  };
  const type = String(obj.type ?? '');

  if (type === 'summary' || type === 'custom-title' || type === 'ai-title') {
    const t = pick(obj, 'summary', 'customTitle', 'aiTitle', 'title');
    return t ? [{ ...base, kind: 'status', title: t }] : [];
  }
  if (type === 'system') {
    // init 行带 cwd/model/sessionId：补一轮建档（进程级首行）。
    if (obj.subtype === 'init') {
      return [
        { ...base, kind: 'session.start', ...(pick(obj, 'model') ? { model: pick(obj, 'model') } : {}) },
      ];
    }
    // compact_boundary/local_command 等：回合内簿记，心跳即可。
    return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
  }
  if (type === 'user') {
    const { blocks } = messageShape(obj);
    if (obj.isMeta === true) return [{ ...base, kind: 'status' }];
    if (obj.isSidechain === true) return [{ ...base, kind: 'status', status: 'working' }];
    // content 只有 tool_result 块 = 工具结果回填——工具已收尾回模型，非用户回合也非新调用。
    if (blocks.size > 0 && [...blocks].every((b) => b === 'tool_result')) {
      return [{ ...base, kind: 'status', status: 'working', phase: 'thinking' }];
    }
    return [
      { ...base, kind: 'session.start' },
      { ...base, kind: 'turn.start' },
    ];
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
  // progress/file-history-snapshot/queue-operation/attachment/last-prompt 等簿记行：
  // 只刷活性不迁移状态。
  return [{ ...base, kind: 'status', status: 'working', phase: 'thinking', model: pick(obj, 'model') }];
}

/** projects 下的主转录清单：<slug>/*.jsonl 一层（subagents/ 等子目录转录不收——子代理不建顶层会话）。 */
function listTranscripts(projectsDir: string): string[] {
  const out: string[] = [];
  try {
    for (const proj of readdirSync(projectsDir)) {
      const sdir = join(projectsDir, proj);
      if (!statSync(sdir, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const name of readdirSync(sdir)) {
        const p = join(sdir, name);
        if (!name.endsWith('.jsonl') && !name.includes('.jsonl.')) continue;
        if (statSync(p, { throwIfNoEntry: false })?.isFile()) out.push(p);
      }
    }
  } catch {
    // projects 目录被并发改写时本轮按空集处理。
  }
  return out;
}

/** transcript 路径所属项目 slug（projects/<slug>/...）。 */
function slugOf(path: string, projectsDir: string): string | undefined {
  const rel = path.slice(projectsDir.length + 1);
  const slug = rel.split('/')[0];
  return slug || undefined;
}

/** CLI 版本：`claude --version` 一发即走；shim 类二进制可能挂起，5s 杀进程降级。 */
async function detectVersion(): Promise<string | undefined> {
  try {
    if (!Bun.which('claude')) return undefined;
    const proc = Bun.spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // 已退出。
      }
    }, 5000);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    const s = code === 0 ? out.trim() : '';
    return s || undefined;
  } catch {
    return undefined;
  }
}

export function createClaudeCodeAdapter(): AgentAdapter {
  const paths = agentPaths('claude-code');
  return {
    id: 'claude-code',

    async detect(): Promise<InstallInfo> {
      // CLI 本体、数据根、全局 ~/.claude.json 三证任一即算装了（刚装未跑过只有其二）。
      const installed =
        existsSync(paths.home) || existsSync(join(homedir(), '.claude.json')) || Boolean(Bun.which('claude'));
      return {
        installed,
        version: await detectVersion(),
        hasCredentials: hasClaudeOAuth(),
        homeDir: paths.home,
        hookInstalled: isHookInstalled('claude-code') && claudeHooksRegistered(paths.hookConfig),
        note: installed ? undefined : `未发现 ${paths.home}`,
      };
    },

    dataSources() {
      const out: DataSourceRef[] = [];
      if (paths.sessions) out.push({ label: '会话 transcript', path: paths.sessions, kind: 'dir' });
      if (paths.credentials) out.push({ label: '凭据文件（Linux/兜底）', path: paths.credentials, kind: 'file' });
      return out;
    },

    hookTargets: () => [paths.hookConfig ?? '', join(HOOKS_DIR, 'claude-code.sh')].filter(Boolean),

    async installHooks() {
      if (!paths.hookConfig) return { changed: false };
      return mergeClaudeHooks(paths.hookConfig, 'claude-code', CLAUDE_HOOK_EVENTS);
    },

    async uninstallHooks() {
      const r = paths.hookConfig ? unmergeJsonHooks(paths.hookConfig) : { changed: false };
      removeHookScript('claude-code');
      return r;
    },

    translateHook: translateClaudeHook,

    async watch(emit, ledger: Ledger) {
      const projects = paths.sessions;
      if (!projects || !existsSync(projects)) return () => {};
      const tailer = new JsonlTailer(ledger);
      const titled = new Set<string>();

      const tailAll = async (firstRun: boolean) => {
        const cutoff = Date.now() - BACKFILL_WINDOW_MS;
        for (const f of listTranscripts(projects)) {
          const st = statSync(f, { throwIfNoEntry: false });
          if (!st || st.mtimeMs < cutoff) continue;
          const fallbackCwd = slugToPath(slugOf(f, projects));
          await tailer.tail(f, firstRun, (obj) => {
            let title: string | undefined;
            // 标题只取首条真实 user 行；tool_result 回填行与簿记行不算（后续真 prompt 仍有机会）。
            if (!titled.has(f) && obj.type === 'user' && obj.isSidechain !== true && obj.isMeta !== true) {
              const { text, blocks } = messageShape(obj);
              if (!blocks.has('tool_result')) {
                title = text.trim().replace(/\s+/g, ' ').slice(0, 80) || undefined;
                if (title) titled.add(f);
              }
            }
            for (const e of translateClaudeTranscriptLine(f, obj, title)) {
              emit(!e.cwd && fallbackCwd ? { ...e, cwd: fallbackCwd } : e);
            }
          });
        }
      };

      const rescan = serialScan(() => tailAll(false));
      await tailAll(true);
      const watcher = watch(projects, { recursive: true }, rescan);
      const rescanTimer = setInterval(rescan, 5000);
      return () => {
        watcher.close();
        clearInterval(rescanTimer);
      };
    },

    quota: () => fetchClaudeQuota(),

    scanSessions: scanClaudeSessions,
    deleteSessions: deleteClaudeSessions,
  };
}
