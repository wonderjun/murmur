/**
 * 接入诊断：把 agentPaths 声明路径与 adapter 自报数据源探成 PathProbe，
 * 与 pull 游标活性（cursors.updated_at）、push 上报活性（lastHookAt）、
 * spool 积压组装成 AgentDiagnostics，并派生「为什么没数据」一句话。
 *
 * hook 链路自检：murmur-selftest:<ts> marker 事件走全真链路
 * （POST /hook → translateHook → ingest_ → ledger → engine），验证
 * endpoint/token/翻译/台账/spool 补投逐段；验后 deleteSessionEvents
 * 清场 + 快照层过滤 marker 前缀，零污染。
 */

import { Database } from 'bun:sqlite';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readEndpointFile } from '../ingest/endpoint';
import { drainSpool } from '../ingest/spool';
import type { Ledger } from '../ledger/db';
import { MURMUR_HOME, agentPaths } from '../paths';
import type { AgentAdapter } from '../agents/base';
import type {
  AgentDiagnostics,
  AgentId,
  DiagnosticsSnapshot,
  HookTestResult,
  HookTestStep,
  InstallInfo,
  PathProbe,
  QuotaSnapshot,
} from '../types';

/** 自检 marker 会话前缀：快照层按此前缀过滤，台账验后即删。 */
export const SELFTEST_PREFIX = 'murmur-selftest:';

/** 游标「不推进即停滞」的判定窗口：pull 轮询间隔都是秒级，10 分钟无推进必有妖。 */
const CURSOR_STALE_MS = 10 * 60_000;

/**
 * 路径探针：存在 → 可读 →（sqlite）可只读打开。
 * sqlite 只读打开失败多半是他人在写的 WAL 库或文件损坏——不判死刑，如实上报。
 */
export function probePath(label: string, path: string, kind: PathProbe['kind']): PathProbe {
  const probe: PathProbe = { label, path, kind, exists: false, readable: false };
  if (!path) return { ...probe, note: '路径未配置' };
  probe.exists = existsSync(path);
  if (!probe.exists) return probe;
  try {
    accessSync(path, constants.R_OK);
    probe.readable = true;
  } catch {
    return probe;
  }
  if (kind === 'sqlite') {
    try {
      // readonly:true 等价 mode=ro，且不经 file: URI——路径带 ?/# 不会被 URI 解析坑。
      const db = new Database(path, { readonly: true });
      try {
        // bun:sqlite 惰性建库——不 query 不真读文件，坏库要真读才现形。
        db.query('SELECT name FROM sqlite_master LIMIT 1').all();
        probe.openable = true;
      } finally {
        db.close();
      }
    } catch {
      probe.openable = false;
      probe.note = '无法只读打开（被占用或损坏）';
    }
  }
  return probe;
}

/** 某 agent 的 spool 暂存情况：有 .jsonl 即存在未补投完的积压。 */
function spoolProbe(agent: AgentId): { pendingFiles: number; bytes: number } {
  const st = statSync(join(MURMUR_HOME, 'spool', `${agent}.jsonl`), { throwIfNoEntry: false });
  // 空文件不算「有暂存」——残壳（截断/刚补投完）报待投是误报。
  return st && st.size > 0 ? { pendingFiles: 1, bytes: st.size } : { pendingFiles: 0, bytes: 0 };
}

/**
 * 游标源归属判定：`<agent>:` 前缀命名约定（zcode:tasks / opencode:event /
 * devin:mn_rowid / opencode:jsonmsg:*），或 JsonlTailer 的 `jsonl:<path>`
 * 落在 agent home 下。
 */
export function cursorBelongsToAgent(source: string, agent: AgentId, home: string): boolean {
  if (source.startsWith(`${agent}:`)) return true;
  if (source.startsWith('jsonl:')) {
    const p = source.slice('jsonl:'.length);
    return home !== '' && p.startsWith(`${home}/`);
  }
  return false;
}

/** 游标源 → 展示名：jsonl 取文件名，命名游标去 agent 前缀。 */
export function cursorLabel(source: string): string {
  if (source.startsWith('jsonl:')) return source.split('/').pop() ?? source;
  const i = source.indexOf(':');
  return i >= 0 ? source.slice(i + 1) : source;
}

/** 源在停滞窗口内仍被写（mtime 新鲜）→ pull 理应持续产出。 */
function freshMtime(path: string): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  return (st?.mtimeMs ?? 0) > Date.now() - CURSOR_STALE_MS;
}

/** 「为什么没数据」一句话：按优先级取第一条命中的事实解释，措辞保守。 */
export function deriveHint(diag: AgentDiagnostics, ctx: { observed: boolean; installed: boolean }): string {
  if (!ctx.installed) return `未发现数据目录 ${diag.home.path}`;
  if (!ctx.observed) return '已在设置中停用监听';
  if (diag.spool.pendingFiles > 0) return '有暂存事件待补投';
  const broken = diag.sources.find((s) => s.exists && (!s.readable || s.openable === false));
  if (broken) return `「${broken.label}」${broken.readable ? '数据库打不开（被占用或损坏）' : '存在但不可读'}`;
  if (diag.sources.length > 0 && diag.sources.every((s) => !s.exists)) {
    return '还没有本地数据——先用该工具跑一次任务';
  }
  if (diag.pull.sources.length === 0) return '尚未扫描过本地数据——可点「重扫」触发';
  // 停滞：watcher 在跑但游标超窗未推进，且任一源仍在被写 → 多半卡了。
  const stalled =
    diag.pull.active &&
    diag.pull.lastScanAt !== null &&
    Date.now() - diag.pull.lastScanAt > CURSOR_STALE_MS &&
    diag.sources.some((s) => s.exists && freshMtime(s.path));
  if (stalled) return '扫描可能停滞——试试「重扫」或重建台账';
  // 无 push 面的 agent（hookTargets 空表，如 minimax）永不进 hook 提示分支。
  if (diag.hook.targets.length > 0 && diag.hook.enabled && !diag.hook.installed) {
    return 'hook 未注入——点「重新接入」或开启自动接入';
  }
  if (diag.hook.targets.length > 0 && diag.hook.enabled && diag.hook.installed && diag.hook.lastEventAt === null) {
    return 'hook 已注入但尚未收到上报（codex 需在 /hooks 信任条目；其余重启该工具）';
  }
  return '数据源正常——暂无活跃会话';
}

/** 组装单 agent 诊断的输入（registry 注入其实时态）。 */
export interface AssembleInput {
  adapter: AgentAdapter;
  install: InstallInfo;
  observed: boolean;
  hookEnabled: boolean;
  hookLastEventAt: number | null;
  watchActive: boolean;
  watchError?: string;
  cursors: { source: string; cursor: string; updatedAt: number }[];
  quota?: QuotaSnapshot;
}

/** 组装单 agent 诊断：声明路径探针 + 运行态事实 + hint。 */
export function assembleAgentDiagnostics(input: AssembleInput): AgentDiagnostics {
  const { adapter, install } = input;
  const paths = agentPaths(adapter.id);
  const mine = input.cursors.filter((c) => cursorBelongsToAgent(c.source, adapter.id, paths.home));
  const diag: AgentDiagnostics = {
    agent: adapter.id,
    home: probePath('数据根', paths.home, 'dir'),
    sources: (adapter.dataSources?.() ?? []).map((s) => probePath(s.label, s.path, s.kind)),
    hook: {
      installed: install.hookInstalled,
      enabled: input.hookEnabled,
      targets: adapter.hookTargets?.() ?? [],
      lastEventAt: input.hookLastEventAt,
    },
    pull: {
      active: input.watchActive,
      lastScanAt: mine.length ? Math.max(...mine.map((c) => c.updatedAt)) : null,
      error: input.watchError,
      sources: mine.map((c) => ({ name: cursorLabel(c.source), at: c.updatedAt })),
    },
    spool: spoolProbe(adapter.id),
    quota: input.quota ? { fetchedAt: input.quota.fetchedAt, error: input.quota.error } : undefined,
    hint: '',
  };
  diag.hint = deriveHint(diag, { observed: input.observed, installed: install.installed });
  return diag;
}

/** 组装整份诊断快照的依赖（registry 注入）。 */
export interface DiagnosticsDeps {
  adapters: AgentAdapter[];
  installs: Map<AgentId, InstallInfo>;
  isObserved: (id: AgentId) => boolean;
  isHookEnabled: (id: AgentId) => boolean;
  hookLastEventAt: (id: AgentId) => number | null;
  watchActive: (id: AgentId) => boolean;
  watchError: (id: AgentId) => string | undefined;
  ledger: Ledger;
  quotas: Map<AgentId, QuotaSnapshot>;
  ingestEndpoint: string;
  firstRun: boolean;
}

/** 全量诊断快照（RPC getDiagnostics 响应体）。 */
export function assembleDiagnostics(deps: DiagnosticsDeps): DiagnosticsSnapshot {
  const cursors = deps.ledger.allCursors();
  return {
    agents: deps.adapters.map((a) =>
      assembleAgentDiagnostics({
        adapter: a,
        install: deps.installs.get(a.id) ?? {
          installed: false,
          hasCredentials: false,
          homeDir: '',
          hookInstalled: false,
        },
        observed: deps.isObserved(a.id),
        hookEnabled: deps.isHookEnabled(a.id),
        hookLastEventAt: deps.hookLastEventAt(a.id),
        watchActive: deps.watchActive(a.id),
        watchError: deps.watchError(a.id),
        cursors,
        quota: deps.quotas.get(a.id),
      }),
    ),
    ingest: { endpoint: deps.ingestEndpoint, ok: deps.ingestEndpoint !== '未启动' },
    firstRun: deps.firstRun,
    generatedAt: Date.now(),
  };
}

/**
 * 各 agent 的 marker payload：必须能经自家 translateHook 翻出 ≥1 条事件
 * （diagnostics.test.ts 对全量 adapter 断言此契约）。session.start 是
 * LEDGER_KINDS 成员，能同时验翻译与台账两条腿。
 */
export function selfTestPayload(agent: AgentId, sid: string): unknown {
  switch (agent) {
    case 'opencode':
      return {
        type: 'session.created',
        properties: { sessionID: sid, info: { title: 'murmur 自检', directory: '/tmp' } },
      };
    case 'cursor':
      // cursor 事件名是 camelCase（sessionStart），与其余家的 PascalCase 不同。
      return { hook_event_name: 'sessionStart', session_id: sid, sessionId: sid, cwd: '/tmp' };
    default:
      // kimi/zcode/codex/devin/qoder 均为 hook_event_name + session_id 契约。
      return { hook_event_name: 'SessionStart', session_id: sid, sessionId: sid, cwd: '/tmp' };
  }
}

/** 链路自检依赖（registry 注入真实部件；测试注入沙箱件）。 */
export interface HookTestDeps {
  agent: AgentId;
  adapter: AgentAdapter | undefined;
  ledger: Ledger;
  /** registry.translateHook：spool 补投走真回调，与运行态同路径。 */
  translate: (agent: AgentId, payload: unknown) => void;
  /** 监听关闭时 ingest_ 会丢事件——前置如实报，POST 仍会 202 但台账无行。 */
  observed: boolean;
  installed: boolean;
}

/**
 * hook 链路自检：前置 → endpoint 文件 → /health → POST marker（token 鉴权）
 * → 翻译 → 台账 → spool 补投，逐步记录；marker 走全真链路后清场。
 * POST 返回 202 时 translate 已同步跑完（server.ts 顺序保证），台账查询即刻有效。
 */
export async function runHookTest(deps: HookTestDeps): Promise<HookTestResult> {
  const steps: HookTestStep[] = [];
  const push = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, detail });
  const { agent } = deps;

  const preOk = deps.installed && deps.observed && Boolean(deps.adapter?.translateHook);
  push(
    '前置条件（已安装·监听中·有翻译器）',
    preOk,
    !deps.installed ? '未安装' : !deps.observed ? '监听已停用' : !deps.adapter?.translateHook ? '无 hook 翻译器' : undefined,
  );

  const ep = readEndpointFile();
  push('endpoint 文件可读', Boolean(ep), ep ? `127.0.0.1:${ep.port}` : '~/.murmur/endpoint 缺失或损坏');

  let healthOk = false;
  if (ep) {
    try {
      healthOk = (await fetch(`http://127.0.0.1:${ep.port}/health`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      // 服务不可达按失败记。
    }
  }
  push('ingest 服务健康', healthOk, healthOk ? 'GET /health 200' : 'GET /health 未通过');

  const sid = `${SELFTEST_PREFIX}${Date.now()}`;
  let postOk = false;
  if (ep && healthOk) {
    try {
      const res = await fetch(`http://127.0.0.1:${ep.port}/hook/${agent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Murmur-Hook-Token': ep.token },
        body: JSON.stringify(selfTestPayload(agent, sid)),
        signal: AbortSignal.timeout(3000),
      });
      postOk = res.status === 202;
      push('POST 上报（token 鉴权）', postOk, `HTTP ${res.status}`);
    } catch (e) {
      push('POST 上报（token 鉴权）', false, e instanceof Error ? e.message : String(e));
    }
  } else {
    push('POST 上报（token 鉴权）', false, '依赖端点与健康检查');
  }

  // 翻译验证：直调 translateHook 计事件数——独立于 POST 结果，能区分
  // 「链路断」与「payload 翻不出事件」两种失败。
  let translated = 0;
  try {
    translated = deps.adapter?.translateHook?.(selfTestPayload(agent, sid)).length ?? 0;
  } catch {
    // 翻译异常按 0 计。
  }
  push('payload 可翻译', translated > 0, `产生 ${translated} 条事件`);

  const ledgerOk = postOk && deps.ledger.sessionEventCount(sid) > 0;
  push('台账落库', ledgerOk, ledgerOk ? 'events 已记录' : postOk ? '未查到 marker 行' : '依赖 POST 成功');

  // spool 补投验证：写真实 spool 行 → drainSpool → 台账出现第二条 marker。
  // _spooledAt 钳回写盘时刻，仍在回填窗内会正常落库。
  const sid2 = `${sid}-spool`;
  let spoolOk = false;
  try {
    const dir = join(MURMUR_HOME, 'spool');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${agent}.jsonl`),
      `${JSON.stringify({ _spooledAt: Math.floor(Date.now() / 1000), p: selfTestPayload(agent, sid2) })}\n`,
    );
    drainSpool(deps.translate);
    spoolOk = deps.ledger.sessionEventCount(sid2) > 0;
  } catch {
    // 目录不可写等场景按失败记。
  }
  push('spool 暂存补投', spoolOk, spoolOk ? '补投已落库' : 'spool 链路未验证');

  // 清场：marker 事件不进长期审计流。
  deps.ledger.deleteSessionEvents(`${SELFTEST_PREFIX}%`);
  return { agent, ok: steps.every((s) => s.ok), steps };
}
