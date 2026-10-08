/**
 * 主进程 ↔ webview 的 RPC 契约，双端共享。
 */

import type { RPCSchema } from "electrobun/main";

import type {
  AgentId,
  AppSnapshot,
  DiagnosticsSnapshot,
  HookTestResult,
  ManagerTab,
  McpSaveResult,
  McpTestResult,
  SessionDeleteResult,
  SkillDeleteResult,
  SkillImportResult,
  StoredSession,
  SyncConflict,
  SyncOverview,
} from "@core/types";
import type { MurmurSettings } from "@core/settings";

/** usageDaily 行（天 × agent × model 聚合明细）。 */
export interface UsageDailyRow {
  day: string;
  agent: string;
  model: string | null;
  tokens: number;
  costUsd: number;
}

/** 设置页快照：持久化设置 + 主进程运行时实况（dock/自启实际态、版本、端点）。 */
export interface SettingsSnapshot {
  settings: MurmurSettings;
  runtime: {
    /** Dock 图标实际显隐（系统侧读回）。 */
    dockIconVisible: boolean;
    /** LaunchAgent plist 实际存在与否。 */
    launchAtLogin: boolean;
    /** 自启可否操作（dev channel 无 .app bundle，禁用开关）。 */
    canLaunchAtLogin: boolean;
    version: string;
    channel: string;
    /** ~/.murmur 数据目录（设置页展示 + openDataDir）。 */
    dataDir: string;
    /** hook ingest 端点描述（如 127.0.0.1:54321）。 */
    ingestEndpoint: string;
    /** settings.json 尚未写过 = 首次启动（管理窗引导卡与自弹窗信号）。 */
    firstRun: boolean;
  };
}

/** 更新相位：bun 侧把 Updater 的细粒度状态流收敛成 UI 可消费的七相。 */
export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "applying" | "error";

/** 更新实况快照：相位推进走 updateStatus 推送，getUpdateState 供晚开的窗口补读。 */
export interface UpdateSnapshot {
  phase: UpdatePhase;
  /** 本地版本（裸 bun 直跑为 "dev"）。 */
  current: string;
  channel: string;
  /** 远端发现的可更新版本（available 相位才有）。 */
  latest?: string;
  /** 下载进度 0–100（downloading 相位）。 */
  progress?: number;
  error?: string;
}

export type MurmurRPC = {
  bun: RPCSchema<{
    requests: {
      getSnapshot: { params: {}; response: AppSnapshot };
      /** 全量装 hook：各 agent 改动标记 + 触碰的配置文件清单。 */
      installHooks: { params: {}; response: Record<AgentId, { changed: boolean; files: string[] }> };
      hidePanel: { params: {}; response: { ok: true } };
      /** 手动触发各 agent 额度拉取。 */
      refreshQuotas: { params: {}; response: { ok: true } };
      /** 用量明细：days 取近 N 天，since 取任意起点（ms epoch，区间筛选用）。 */
      usageDaily: { params: { days?: number; since?: number }; response: UsageDailyRow[] };
      /** 设置页：读设置 + 运行时实况。 */
      getSettings: { params: {}; response: SettingsSnapshot };
      /** 设置页：应用设置补丁（dock/自启即时生效）。 */
      updateSettings: { params: { patch: Partial<MurmurSettings> }; response: SettingsSnapshot };
      /** 设置页：单个 agent 的 hook 上报开关（关=卸载我方条目）。 */
      setAgentHook: { params: { agent: AgentId; enabled: boolean }; response: SettingsSnapshot };
      /** 设置页：单个 agent 的监听总开关（关=停 watch + 卸 hook + 面板隐藏）。 */
      setAgentObserved: { params: { agent: AgentId; enabled: boolean }; response: SettingsSnapshot };
      /** 设置页 BYOK：写/清某 agent 的自填 API Key（apiKey 空即清除）。key 只进 credentials.json，不回传明文。 */
      setAgentKey: {
        params: { agent: AgentId; apiKey: string | null; baseUrl?: string };
        response: SettingsSnapshot;
      };
      /** webview 输入框粘贴兜底：无 Edit 菜单时 ⌘/⌃V 到不了 WKWebView，JS 侧改走主进程读剪贴板。 */
      readClipboard: { params: {}; response: { text: string | null } };
      /** webview 复制通道：写系统剪贴板（cwd/路径复制）。与 readClipboard 成对。 */
      writeClipboard: { params: { text: string }; response: { ok: true } };
      /** 清空台账与游标，pull watcher 下轮全量重扫。 */
      rebuildLedger: { params: {}; response: { ok: true } };
      /** 打开管理台窗口并定位 tab（已开则聚焦并切 tab；缺省 doctor）。 */
      openManager: { params: { tab?: ManagerTab }; response: { ok: true } };
      /** 接入诊断快照：各 agent 数据源探针 + push/pull 活性 + 提示。 */
      getDiagnostics: { params: {}; response: DiagnosticsSnapshot };
      /** 单 agent hook 链路自检：marker 事件走全真链路逐步验。 */
      testAgentHook: { params: { agent: AgentId }; response: HookTestResult };
      /** 单 agent 重扫：重启其 pull watcher（不清游标拾漏）。 */
      rescanAgent: { params: { agent: AgentId }; response: { ok: true } };
      /** 单 agent 装 hook：改动标记 + 触碰的配置文件清单。 */
      installAgentHooks: { params: { agent: AgentId }; response: { changed: boolean; files: string[] } };
      /** Finder 定位任意诊断出的路径（限 home 内）。 */
      revealPath: { params: { path: string }; response: { ok: boolean } };
      /** 盘点单个 agent 的磁盘会话产物（清理页分页用：首屏不等全量）。 */
      scanAgentSessions: { params: { agent: AgentId }; response: { items: StoredSession[] } };
      /** 批量删除：fs 产物进废纸篓、库内行永久删；per-item 回报。 */
      deleteSessions: {
        params: { items: { agent: AgentId; id: string }[] };
        response: { results: SessionDeleteResult[] };
      };
      /** 在 Finder 中定位会话的首个磁盘产物。 */
      revealSession: { params: { agent: AgentId; id: string }; response: { ok: boolean } };
      /** 唤起会话宿主 app 到台前（进程祖先链 → 静态 bundle 兜底）；app 为被激活的 .app 名。 */
      focusSessionApp: { params: { agent: AgentId; id: string }; response: { ok: boolean; app?: string } };
      /** Finder 打开 ~/.murmur 数据目录。 */
      openDataDir: { params: {}; response: { ok: true } };
      /** 当前更新相位（设置页挂载补读——管理窗晚开会错过历史推送）。 */
      getUpdateState: { params: {}; response: UpdateSnapshot };
      /** 检查更新：拉远端 update.json 比对（Updater 内部 in-flight 去重；dev/裸跑不触网）。 */
      checkUpdate: { params: {}; response: UpdateSnapshot };
      /** 受理更新：下载+换包异步推进（相位走 updateStatus 推送），换包后进程由更新助手重启。 */
      applyUpdate: { params: {}; response: { ok: boolean; error?: string } };
      /** 技能/MCP 盘点矩阵（管理台「技能」页挂载补读）。 */
      getSyncStatus: { params: {}; response: SyncOverview };
      /** 全量同步（源 → 各 agent 目标）；overwrite 是用户对同名冲突的裁决清单。 */
      syncAll: { params: { overwrite?: SyncConflict[] }; response: SyncOverview };
      importSkills: { params: { path: string }; response: SkillImportResult & { overview: SyncOverview } };
      /** 删除源技能包：进废纸篓，目标侧我方拷贝随 syncAll 清理。 */
      deleteSkill: { params: { name: string }; response: SkillDeleteResult };
      /** 条目级启停：技能（关=同步剔除 + 清理在场拷贝）。 */
      setSkillEnabled: { params: { name: string; enabled: boolean }; response: SyncOverview };
      /** 条目级启停：MCP（关=不写 + 剔除曾写入的我方 key）。 */
      setMcpEnabled: { params: { name: string; enabled: boolean }; response: SyncOverview };
      /** 弹系统目录选择框（electrobun Utils.openFileDialog；取消回 null）。 */
      pickDirectory: { params: {}; response: { path: string | null } };
      /** 读单条源 MCP 定义（编辑回填；含 env/headers 凭据故按需逐条取，不进盘点快照）。 */
      getMcpDef: { params: { name: string }; response: { def: Record<string, unknown> | null } };
      /** 新建/更新源 MCP 条目：origName=编辑前键名（新建 null），def=含 mcpServers 的整段 JSON。 */
      saveMcp: { params: { origName: string | null; def: string }; response: McpSaveResult };
      /** MCP 探测：name 探已存条目 / def 探草稿（多键逐条出结果）。 */
      testMcp: { params: { name?: string; def?: string }; response: McpTestResult[] };
      quitApp: { params: {}; response: { ok: true } };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      /** 主进程 → UI 的全量快照推送。 */
      snapshot: AppSnapshot;
      /** 管理台窗口已开时的切 tab 指令（openManager 重开同窗用）。 */
      managerNav: { tab: ManagerTab };
      /** 设置变更广播：任一窗口的 mutation 落库后推给所有窗口（面板要即时换主题/字体）。 */
      settings: SettingsSnapshot;
      /** 更新相位推进（检查/下载进度/换包各节点；含启动后的静默检查）。 */
      updateStatus: UpdateSnapshot;
    };
  }>;
};
