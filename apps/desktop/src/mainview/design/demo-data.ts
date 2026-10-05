/** 离线演示数据：设计板展件与 ?seed 快照共用。
 *  诊断替身覆盖四种健康态（已连接/需检查/等待数据/未安装），字段以
 *  @core/types 的 AgentDiagnostics 真形为准；会话文件桩跨 kimi/codex/cursor
 *  混合长短标题与 12KB–380MB 体量，含 1 条活跃禁删与 2 条库内行。
 */

import type { AgentDiagnostics, StoredSession } from "@core/types";

/** 接入诊断展件 · 正常态（已连接）。 */
export const DEMO_DIAG_OK: AgentDiagnostics = {
  agent: "kimi",
  home: { label: "数据根", path: "~/.kimi-code", kind: "dir", exists: true, readable: true },
  sources: [
    { label: "会话存储", path: "~/.kimi-code/sessions", kind: "dir", exists: true, readable: true },
    { label: "凭据", path: "~/.kimi-code/credentials", kind: "dir", exists: true, readable: true },
  ],
  hook: {
    installed: true,
    enabled: true,
    targets: ["~/.kimi-code/config.toml", "~/.murmur/agent-hooks/kimi.sh"],
    lastEventAt: Date.now() - 300_000,
  },
  pull: { active: true, lastScanAt: Date.now() - 90_000, sources: [{ name: "wire.jsonl", at: Date.now() - 90_000 }] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "数据源正常——暂无活跃会话",
};

/** 接入诊断展件 · 故障态（需检查：sqlite 打不开 + hook 未注入）。 */
export const DEMO_DIAG_BAD: AgentDiagnostics = {
  agent: "zcode",
  home: { label: "数据根", path: "~/.zcode", kind: "dir", exists: true, readable: true },
  sources: [
    {
      label: "任务库",
      path: "~/.zcode/v2/tasks-index.sqlite",
      kind: "sqlite",
      exists: true,
      readable: true,
      openable: false,
      note: "无法只读打开（被占用或损坏）",
    },
  ],
  hook: { installed: false, enabled: true, targets: ["~/.zcode/cli/config.json"], lastEventAt: null },
  pull: { active: false, lastScanAt: null, sources: [] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "hook 未注入——点「重新接入」或开启自动接入",
};

/** seed 补充 · codex 正常（双通道上报 + 游标在扫）。 */
export const DEMO_DIAG_CODEX: AgentDiagnostics = {
  agent: "codex",
  home: { label: "数据根", path: "~/.codex", kind: "dir", exists: true, readable: true },
  sources: [{ label: "会话记录", path: "~/.codex/sessions", kind: "dir", exists: true, readable: true }],
  hook: {
    installed: true,
    enabled: false,
    targets: ["~/.codex/hooks.json", "~/.murmur/agent-hooks/codex.sh"],
    lastEventAt: Date.now() - 1800_000,
  },
  pull: { active: true, lastScanAt: Date.now() - 60_000, sources: [{ name: "rollout-*.jsonl", at: Date.now() - 60_000 }] },
  spool: { pendingFiles: 0, bytes: 0 },
  quota: { fetchedAt: Date.now() - 300_000 },
  hint: "hook 上报已停用——本地读取仍在工作",
};

/** seed 补充 · cursor 已连接（本地读取活性，无 hook）。 */
export const DEMO_DIAG_CURSOR: AgentDiagnostics = {
  agent: "cursor",
  home: { label: "数据根", path: "~/.cursor", kind: "dir", exists: true, readable: true },
  sources: [
    { label: "会话转录", path: "~/.cursor/projects", kind: "dir", exists: true, readable: true },
    { label: "聊天元数据", path: "~/Library/Application Support/Cursor/User", kind: "dir", exists: true, readable: true },
  ],
  hook: { installed: false, enabled: true, targets: [], lastEventAt: null },
  pull: { active: true, lastScanAt: Date.now() - 120_000, sources: [{ name: "agent-transcripts", at: Date.now() - 120_000 }] },
  spool: { pendingFiles: 1, bytes: 14_000 },
  hint: "数据源正常——cursor 无审批/提问信号，只有相位",
};

/** seed 补充 · opencode 等待数据（家目录在、从未收到事件）。 */
export const DEMO_DIAG_OPENCODE: AgentDiagnostics = {
  agent: "opencode",
  home: { label: "数据根", path: "~/.local/share/opencode", kind: "dir", exists: true, readable: true },
  sources: [{ label: "事件库", path: "~/.local/share/opencode/opencode.db", kind: "sqlite", exists: true, readable: true, openable: true }],
  hook: { installed: true, enabled: true, targets: ["~/.config/opencode/opencode.json"], lastEventAt: null },
  pull: { active: true, lastScanAt: null, sources: [] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "已发现数据源——等第一条会话事件",
};

/** seed 补充 · devin 未安装（家目录不存在）。 */
export const DEMO_DIAG_DEVIN: AgentDiagnostics = {
  agent: "devin",
  home: { label: "数据根", path: "~/.devin", kind: "dir", exists: false, readable: false },
  sources: [],
  hook: { installed: false, enabled: true, targets: [], lastEventAt: null },
  pull: { active: false, lastScanAt: null, sources: [] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "未发现本机安装",
};

/** seed 补充 · qoder 等待数据。 */
export const DEMO_DIAG_QODER: AgentDiagnostics = {
  agent: "qoder",
  home: { label: "数据根", path: "~/.qoder", kind: "dir", exists: true, readable: true },
  sources: [{ label: "会话记录", path: "~/.qoder/projects", kind: "dir", exists: true, readable: true }],
  hook: { installed: true, enabled: true, targets: ["~/.qoder/settings.json"], lastEventAt: null },
  pull: { active: true, lastScanAt: null, sources: [] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "已发现数据源——等第一条会话事件",
};

/** seed 补充 · minimax 纯 pull（无 hook 面，targets 空表）。 */
export const DEMO_DIAG_MINIMAX: AgentDiagnostics = {
  agent: "minimax",
  home: { label: "数据根", path: "~/.minimax", kind: "dir", exists: true, readable: true },
  sources: [
    { label: "状态库", path: "~/.minimax/v2/sqlite/runtime-state.sqlite", kind: "sqlite", exists: true, readable: true, openable: true },
  ],
  hook: { installed: false, enabled: true, targets: [], lastEventAt: null },
  pull: { active: true, lastScanAt: null, sources: [] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "已发现数据源——等第一条会话事件",
};

/** seed 诊断全景：八家全列（zcode 故障默认展开用）。 */
export const SEED_DIAG_AGENTS: AgentDiagnostics[] = [
  DEMO_DIAG_OK,
  DEMO_DIAG_BAD,
  DEMO_DIAG_CODEX,
  DEMO_DIAG_CURSOR,
  DEMO_DIAG_OPENCODE,
  DEMO_DIAG_DEVIN,
  DEMO_DIAG_QODER,
  DEMO_DIAG_MINIMAX,
];

/** seed 会话文件桩：14 条跨三家，体量/时间/类型混合。 */
export function seedStoredSessions(now: number): StoredSession[] {
  const dayMs = 86400_000;
  const mk = (
    i: number,
    agent: StoredSession["agent"],
    title: string,
    sizeBytes: number,
    ageDays: number,
    kind: StoredSession["kind"] = "dir",
    extra: Partial<StoredSession> = {},
  ): StoredSession => ({
    agent,
    id: `seed-${agent}-${i}`,
    title,
    project: i % 3 === 0 ? "~/Documents/murmur" : i % 3 === 1 ? "~/Documents/flow" : "~/work/side-quest",
    sizeBytes,
    createdAt: now - (ageDays + 2) * dayMs,
    modifiedAt: now - ageDays * dayMs,
    kind,
    active: false,
    paths: kind === "db" ? undefined : [`~/.${agent}/sessions/seed-${i}`],
    ...extra,
  });
  return [
    mk(0, "kimi", "review一下 git 未提交的改动，看有没有 bug 或者可优化的地方", 380 * 1024 * 1024, 0, "dir", { active: true }),
    mk(1, "kimi", "修菜单栏闪烁", 12 * 1024, 1),
    mk(2, "kimi", "给状态机补 waiting 细分测试并跑全量回归", 4.6 * 1024 * 1024, 3),
    mk(3, "kimi", "暮色栖木 token 校对", 900 * 1024, 6, "db"),
    mk(4, "kimi", "prompt 缓存命中率排查", 2.1 * 1024 * 1024, 12),
    mk(5, "codex", "refactor datasource 三层架构为依赖注入", 68 * 1024 * 1024, 0),
    mk(6, "codex", "rollout jsonl tailer 半行缓存", 320 * 1024, 2),
    mk(7, "codex", "hooks.json matcher-group 形状核对", 96 * 1024, 9, "db"),
    mk(8, "codex", "长标题挤压版面高度测试——这个会话的标题故意写得非常非常长以验证表格列截断行为", 1.4 * 1024 * 1024, 18),
    mk(9, "cursor", "transcripts 目录监听抖动", 24 * 1024 * 1024, 1),
    mk(10, "cursor", "chats meta.json 活性启发式", 540 * 1024, 5),
    mk(11, "cursor", "subagent 归并父会话", 8.2 * 1024 * 1024, 11),
    mk(12, "cursor", "CLI 会话搭车 app 台账", 210 * 1024, 21),
    mk(13, "kimi", "wire.jsonl 增量游标收尾", 76 * 1024, 29),
  ];
}
