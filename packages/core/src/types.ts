/**
 * Murmur 核心类型契约：归一化事件模型与会话状态。
 *
 * 各 agent adapter（agents/）把私有数据源（hook payload、wire.jsonl、sqlite 事件表）
 * 统一翻译成 AgentEvent，喂给 status-engine 做状态机迁移，最终由 AppSnapshot
 * 输出给桌面壳渲染。本文档是全链路的类型真源，双端改动必须同步。
 */

/** 支持的编码 agent 标识。 */
export type AgentId = 'kimi' | 'zcode' | 'opencode' | 'codex' | 'cursor';

/** 会话状态：working=干活中 waiting=轮到你了/等批准 idle=空闲 stale=疑似卡住 ended=已结束。 */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'stale' | 'ended';

/** waiting 的细分原因：approval=等批准输入 turn-end=回合结束等你下一步。 */
export type WaitingReason = 'approval' | 'turn-end' | 'question';

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
  cwd?: string;
  title?: string;
  model?: string;
  lastEventAt: number;
  startedAt: number;
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
  /** 今日本地台账：token 合计与估算成本（quota API 之外始终可用）。 */
  today?: { tokens: number; costUsd: number };
  /** 近 7 日本地台账（用量页用）。 */
  week?: { tokens: number; costUsd: number };
}

/** 整个应用的渲染快照。 */
export interface AppSnapshot {
  agents: AgentSnapshot[];
  /** 聚合态：任何会话 working→working，无 working 但有 waiting→waiting，依次退化。 */
  overall: AgentStatus;
  generatedAt: number;
}
