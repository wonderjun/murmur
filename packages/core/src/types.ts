/**
 * Murmur 核心类型契约：归一化事件模型与会话状态。
 *
 * 各 agent adapter（agents/）把私有数据源（hook payload、wire.jsonl、sqlite 事件表）
 * 统一翻译成 AgentEvent，喂给 status-engine 做状态机迁移，最终由 AppSnapshot
 * 输出给桌面壳渲染。本文档是全链路的类型真源，双端改动必须同步。
 */

/** 支持的编码 agent 标识。 */
export type AgentId =
  'kimi' | 'zcode' | 'opencode' | 'codex' | 'cursor' | 'devin' | 'qoder' | 'minimax' | 'omp' | 'claude-code';

/** 会话状态：working=干活中 waiting=轮到你了/等批准 idle=空闲 stale=疑似卡住 ended=已结束。 */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'stale' | 'ended';

/** waiting 的细分原因：approval=等批准输入 turn-end=回合结束等你下一步。 */
export type WaitingReason = 'approval' | 'turn-end' | 'question';

/**
 * working 的细分相位：thinking=模型往返/思考中（turn.start 与 PostToolUse 之间）、
 * tool=工具执行中（PreToolUse/tool.call 起）。由既有事件流推导，不承诺更细
 * （排队/重试/压缩不可分辨）；无细粒度源的 agent 恒缺省，UI 按普通「工作中」渲染。
 */
export type WorkingPhase = 'thinking' | 'tool';

/**
 * token 计量口径：字段互斥，合计 = input + output + cacheRead + cacheWrite。
 *   input = 非缓存输入；cacheRead/cacheWrite = 命中/写入缓存的输入分量；
 *   reasoning 是 output 的细分（信息字段，不参与合计）。
 * adapter 翻译时若上游把 cache 计入总输入（zcode 的 inputTokens 实测如此），
 * 必须先减去 cache 分量再进 input——否则 token 与成本双计。
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** 归一化事件：adapter 输出、engine 输入。 */
export interface AgentEvent {
  agent: AgentId;
  /** 会话标识（agent 各自的 session id）。 */
  sessionId: string;
  /** 工作目录，用于会话归属与展示。 */
  cwd?: string;
  kind:
    | 'session.start'
    | 'session.end'
    | 'turn.start'
    | 'turn.end'
    | 'permission.request'
    | 'tool.call'
    | 'usage'
    | 'status';
  /** kind=status 时的目标态。 */
  status?: AgentStatus;
  /** kind=waiting 相关事件的细分原因。 */
  waitingReason?: WaitingReason;
  /** working 细分相位（turn.start/tool.call/status 事件可携带）。 */
  phase?: WorkingPhase;
  /**
   * 上下文对象摘要（≤80 字符）：permission.request/question 事件是等待对象
   * （审批命令/问题文本），tool.call 是工具名。来自 hook payload 的原文一律截断，
   * 含完整 prompt 的字段不进此字段（zcode 约定）。
   */
  detail?: string;
  /** 会话标题/摘要（若数据源携带）。 */
  title?: string;
  /** kind=usage 时的计量。 */
  tokens?: TokenUsage;
  model?: string;
  /** 事件时间戳（ms epoch）。 */
  at: number;
  /** 原始 payload，排查与回放用。 */
  raw?: unknown;
}

/** 引擎输出的单个会话快照。 */
export interface SessionSnapshot {
  agent: AgentId;
  sessionId: string;
  status: AgentStatus;
  waitingReason?: WaitingReason;
  /** 等待对象摘要（≤80 字符）：approval=审批命令/工具名，question=问题文本。离开 waiting 即清。 */
  waitingDetail?: string;
  /** working 细分相位（status=working 时可有）；无细粒度源的会话恒缺省。 */
  phase?: WorkingPhase;
  /** 最近工具名：phase=tool 时是当前执行中的工具，其余时刻是时间线的「最近工具调用」。 */
  toolName?: string;
  /** 进入当前状态的时刻（ms epoch）——「等了 N 分钟」「工作中 N 分钟」的计时起点。 */
  statusAt: number;
  /** 最近一次 turn.start 时刻（轻量时间线「发起」位）；无则缺省。 */
  turnStartAt?: number;
  /** 最近一次 tool.call 时刻（轻量时间线「工具」位）；无则缺省。 */
  toolCallAt?: number;
  cwd?: string;
  title?: string;
  model?: string;
  lastEventAt: number;
  startedAt: number;
  /** 结束时刻（ms epoch，≈状态迁移时刻）；仅 recentlyEnded 清单携带，活跃会话不出。 */
  endedAt?: number;
  /** 累计 token 与估算成本（USD）。 */
  tokens: TokenUsage;
  costUsd: number;
}

/** 单个额度窗口快照。 */
export interface QuotaWindow {
  /** 窗口语义：5h/weekly/monthly/cycle 等。 */
  label: string;
  /** 已用量与上限（单位因 provider 而异：token 数/请求数/美元）。 */
  used?: number;
  limit?: number;
  usedPct: number;
  /** 重置时间（ms epoch），无则为 null。 */
  resetsAt: number | null;
}

/** agent 级额度快照：多窗口 + 套餐档 + 拉取时间。 */
export interface QuotaSnapshot {
  agent: AgentId;
  /** 套餐档位文案，如 Pro / Ultra / Team。 */
  plan?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  /** 拉取失败原因（失败时 windows 为空）。 */
  error?: string;
}

/** adapter 探测到的安装信息。 */
export interface InstallInfo {
  installed: boolean;
  version?: string;
  /** 是否持有可用于 quota 拉取的本地凭据。 */
  hasCredentials: boolean;
  /** 配置/数据根目录。 */
  homeDir: string;
  /** 我们的 hook/插件是否已注入。 */
  hookInstalled: boolean;
  /** quota 平面接受用户自带 API Key（BYOK）——UI 据此渲染 key 输入行。 */
  supportsByok?: boolean;
  note?: string;
}

/** 单个 agent 的运行态快照（给 UI）。 */
export interface AgentSnapshot {
  agent: AgentId;
  install: InstallInfo;
  /** 用户在设置里关掉了该 agent 的监听：sessions/quota/用量不挂，UI 据此过滤或标停用。 */
  disabled: boolean;
  sessions: SessionSnapshot[];
  quota?: QuotaSnapshot;
  /** BYOK 已配置状态（掩码，绝不含明文 key）。仅 supportsByok 的 agent 出现。 */
  byok?: { hasKey: boolean; preview?: string };
  /** 今日本地台账：token 合计与估算成本（quota API 之外始终可用）。 */
  today?: { tokens: number; costUsd: number };
  /** 近 7 日本地台账（用量页用）。 */
  week?: { tokens: number; costUsd: number };
}

/**
 * 磁盘会话条目（会话文件管理页一行）：adapter 盘点产物，UI 消费。
 * kind 决定删除语义——dir/file 进废纸篓可恢复，db 是库内行永久删除。
 */
export interface StoredSession {
  agent: AgentId;
  /** agent 内稳定 id（删除请求回传 key）。 */
  id: string;
  /** 会话标题（数据源携带时）。 */
  title?: string;
  /** 项目/工作目录绝对路径，不可得为空。 */
  project?: string;
  /** 磁盘占用字节：dir 递归和、file 本体、db 行内容字节估算。 */
  sizeBytes: number;
  /** 创建时间（ms epoch），不可考为 0。 */
  createdAt: number;
  /** 最后修改时间（ms epoch），列表默认按它倒序。 */
  modifiedAt: number;
  kind: 'dir' | 'file' | 'db';
  /** 进行中/等输入会话（快照命中或 mtime 新鲜）——禁删。 */
  active: boolean;
  /** 该会话占用的磁盘路径（db 行无）；供「在 Finder 显示」与排查用。 */
  paths?: string[];
}

/** 单个会话的删除结果。 */
export interface SessionDeleteResult {
  agent: AgentId;
  id: string;
  ok: boolean;
  /** 实际释放的字节数（db 行是估算，文件体积需 VACUUM 才回收）。 */
  freedBytes: number;
  error?: string;
  /** 库内删除提示：文件体积未回收，需压实数据库。 */
  needsVacuum?: boolean;
}

/** 管理台窗口 tab（RPC openManager 与 webview managerNav 共用）。 */
export type ManagerTab = 'doctor' | 'usage' | 'files' | 'skills' | 'settings';

/**
 * 技能/MCP 同步单元格状态（sync/engine.ts 盘点产出）：
 * synced=目标在且归我方（技能=软链指向源目录，MCP=sync-state 归属集内/同值）、
 * stale=旧版 .murmur-managed 实体拷贝待迁移成软链、
 * absent=目标缺席（下次同步会补）、conflict=同名但非我方写入（他人产物不碰）、
 * external=目标目录归 skillshare 等外部工具管辖、off=开关/无目标/缺 SKILL.md 跳过、
 * error=本轮读写失败。
 */
export type SyncItemState = 'synced' | 'stale' | 'absent' | 'conflict' | 'external' | 'off' | 'error';

/** 一处待裁决的同名冲突：syncAll(overwrite) 按此引用执行「覆盖」决定（默认跳过失位）。 */
export interface SyncConflict {
  kind: 'skill' | 'mcp';
  name: string;
  agent: AgentId;
  /** 冲突落点：技能=目标目录全路径，MCP=配置文件路径。 */
  path: string;
}

/** 单个条目 × 单个 agent 的同步状态格。 */
export interface SkillSyncCell {
  agent: AgentId;
  state: SyncItemState;
  /** 失败原因/冲突说明/被跳过的目标路径等补充信息。 */
  detail?: string;
}

/** 同步盘点的一行 skill（源目录的一个包 × 各 agent 状态）。 */
export interface SyncSkillRow {
  name: string;
  description?: string;
  /** 源目录缺 SKILL.md 时列出但同步跳过。 */
  hasSkillMd: boolean;
  /** settings.disabledSkills 命中——保留源但不同步、清理在场拷贝。 */
  disabled: boolean;
  cells: SkillSyncCell[];
}

/** 同步盘点的一行 MCP server（~/.murmur/mcp.json 的一个条目 × 各 agent 状态）。 */
export interface McpSyncRow {
  name: string;
  disabled: boolean;
  cells: SkillSyncCell[];
}

/** 技能与 MCP 同步盘点快照（getSyncStatus/syncAll 响应）。 */
export interface SyncOverview {
  skills: SyncSkillRow[];
  mcps: McpSyncRow[];
  /** 本轮盘点出的全部同名冲突（与 cells 的 conflict 格同源，去重前逐目标枚举）。 */
  conflicts: SyncConflict[];
  scannedAt: number;
}

/** 导入技能结果：imported=新进源的包名，skipped=跳过原因（同名已存在/目录不可读）。 */
export interface SkillImportResult {
  imported: string[];
  skipped: { name: string; reason: string }[];
}

/** 删除源技能的响应：废纸篓失败时 ok=false 且 overview 缺席。 */
export interface SkillDeleteResult {
  ok: boolean;
  error?: string;
  overview?: SyncOverview;
}

/** MCP 探测结果（testMcp RPC）：ok=initialize 握手拿到 JSON-RPC 回包（stdio 一行 / remote 2xx）。 */
export interface McpTestResult {
  ok: boolean;
  latencyMs: number;
  /** 条目键名（mcpServers 多键探测时区分结果归属；单条探测可为空）。 */
  name?: string;
  /** 远端/子进程自报的 serverInfo.name-version（有则回显）。 */
  server?: string;
  error?: string;
}

/** 新建/更新源 MCP 条目的响应（saveMcp RPC）。 */
export interface McpSaveResult {
  ok: boolean;
  error?: string;
  overview?: SyncOverview;
}

/** 单个路径探针结果：数据源/配置文件的存在性、可读性与 sqlite 可开性。 */
export interface PathProbe {
  /** 探针语义标签（数据源名/配置名），UI 直出。 */
  label: string;
  path: string;
  kind: 'file' | 'dir' | 'sqlite';
  exists: boolean;
  readable: boolean;
  /** kind=sqlite 时：只读打开是否成功（他人正在写的 WAL 库开不了即 false）。 */
  openable?: boolean;
  note?: string;
}

/** 单个 agent 的诊断实况：三面（数据源/push/pull）+ 提示一句话。 */
export interface AgentDiagnostics {
  agent: AgentId;
  home: PathProbe;
  sources: PathProbe[];
  hook: {
    installed: boolean;
    /** 用户在设置里开了该 agent 的上报（settings.hooks 缺省 true）。 */
    enabled: boolean;
    /** hook 安装触碰的配置文件清单（展示/Finder 定位用）。 */
    targets: string[];
    /** 最近一次 hook 上报到达 ingest 的时刻；从未收到为 null。 */
    lastEventAt: number | null;
  };
  pull: {
    /** watcher 是否在跑（observed + installed 且有 watch 能力面）。 */
    active: boolean;
    /** 全部 pull 源游标的最新推进时间；无游标为 null。 */
    lastScanAt: number | null;
    /** watcher 启动抛错的最近一次消息（registry 记录）。 */
    error?: string;
    sources: { name: string; at: number }[];
  };
  spool: { pendingFiles: number; bytes: number };
  quota?: { fetchedAt: number; error?: string };
  /** 「为什么没数据」一句话提示（事实派生，措辞保守）。 */
  hint: string;
}

/** 诊断快照（RPC getDiagnostics 响应）。 */
export interface DiagnosticsSnapshot {
  agents: AgentDiagnostics[];
  ingest: { endpoint: string; ok: boolean };
  /** settings.json 尚未写过 = 首次启动（引导卡信号）。 */
  firstRun: boolean;
  generatedAt: number;
}

/** hook 链路自检的单步结果。 */
export interface HookTestStep {
  name: string;
  ok: boolean;
  detail?: string;
}

/** hook 链路自检结果（RPC testAgentHook 响应）。 */
export interface HookTestResult {
  agent: AgentId;
  ok: boolean;
  steps: HookTestStep[];
}

/** 整个应用的渲染快照。 */
export interface AppSnapshot {
  agents: AgentSnapshot[];
  /** 聚合态：任何会话 working→working，无 working 但有 waiting→waiting，依次退化。 */
  overall: AgentStatus;
  generatedAt: number;
  /**
   * grace 期内的最近结束会话（endedAt≈状态迁移时刻，副本只读）——「最近结束」
   * 折叠组数据源。可选字段：只增不改，既有消费者（mainview）typecheck 兜底。
   */
  recentlyEnded?: SessionSnapshot[];
}
