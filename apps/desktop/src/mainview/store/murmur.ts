/**
 * Murmur 面板状态（Zustand）：RPC 快照 + 设置快照。
 *
 * 数据流：主进程推送/主动拉取 → snapshot → 各组件渲染。
 * 「轮到你了」计数驱动 header 高亮与栖枝栖息态。
 * 派生态不进 store：组件 selector 只取原始字段，派生走 lib/selectors.ts
 * 纯函数 + useMemo/useShallow（快照 80ms 去抖推送，selector 返回新引用会
 * 每次都触发重渲）。
 */

import { create } from "zustand";

import { useRpc } from "@/lib/rpc";

import type { SettingsSnapshot, UsageDailyRow } from "../../shared/rpc";
import type { MurmurSettings } from "@core/settings";
import type {
  AgentId,
  AppSnapshot,
  DiagnosticsSnapshot,
  HookTestResult,
  ManagerTab,
  SessionDeleteResult,
  StoredSession,
} from "@core/types";

interface MurmurStore {
  snapshot: AppSnapshot | null;
  /** 首次快照尚未返回（骨架屏语义；之后推送/刷新不再置回 true）。 */
  loading: boolean;
  /** 最近一次 refresh 失败（桥未就绪/主进程失联）；拿到快照即复位。 */
  snapshotError: boolean;
  settingsSnap: SettingsSnapshot | null;
  /** 最近一次 loadSettings 失败；读到设置即复位。 */
  settingsError: boolean;
  /** 管理窗切 tab 指令（managerNav 推送；at 是 nonce——同 tab 重发也要生效）。 */
  managerNav: { tab: ManagerTab; at: number } | null;
  refresh(): Promise<void>;
  installHooks(): Promise<Record<AgentId, { changed: boolean; files: string[] }>>;
  refreshQuotas(): Promise<void>;
  usageDaily(opts?: { days?: number; since?: number }): Promise<UsageDailyRow[]>;
  /** 进入设置页时拉取；之后以各 mutation 的响应为准（响应即最新态）。 */
  loadSettings(): Promise<void>;
  updateSettings(patch: Partial<MurmurSettings>): Promise<void>;
  setAgentHook(agent: AgentId, enabled: boolean): Promise<void>;
  setAgentObserved(agent: AgentId, enabled: boolean): Promise<void>;
  /** BYOK：写/清 agent 的自填 API Key（apiKey 传空串/null 即清除）。 */
  setAgentKey(agent: AgentId, apiKey: string | null, baseUrl?: string): Promise<void>;
  /** 输入框粘贴兜底（菜单栏伴侣缺 Edit 菜单时 ⌘/⌃V 到不了 webview）。 */
  readClipboard(): Promise<string | null>;
  /** 复制通道：写系统剪贴板（cwd/路径复制）。 */
  writeClipboard(text: string): Promise<void>;
  rebuildLedger(): Promise<void>;
  /** 打开管理台窗口并定位 tab（已开则聚焦切 tab）。 */
  openManager(tab?: ManagerTab): Promise<void>;
  /** 接入诊断快照（doctor 页数据源）。 */
  getDiagnostics(): Promise<DiagnosticsSnapshot>;
  /** 单 agent hook 链路自检。 */
  testAgentHook(agent: AgentId): Promise<HookTestResult>;
  /** 单 agent 重扫（重启 pull watcher 拾漏）。 */
  rescanAgent(agent: AgentId): Promise<void>;
  /** 单 agent 装 hook：改动标记 + 触碰文件清单。 */
  installAgentHooks(agent: AgentId): Promise<{ changed: boolean; files: string[] }>;
  /** Finder 定位诊断路径。 */
  revealPath(path: string): Promise<boolean>;
  /** 盘点全部 agent 的磁盘会话产物（清理页数据源）。 */
  scanSessions(): Promise<{ items: StoredSession[]; scannedAt: number }>;
  /** 批量删除：fs 产物进废纸篓、库内行永久删，per-item 回报。 */
  deleteSessions(items: { agent: AgentId; id: string }[]): Promise<SessionDeleteResult[]>;
  /** Finder 定位会话首个磁盘产物。 */
  revealSession(agent: AgentId, id: string): Promise<boolean>;
  openDataDir(): Promise<void>;
  quit(): void;
}

export const useMurmurStore = create<MurmurStore>()((set) => {
  const rpc = useRpc(
    (s) => set({ snapshot: s, loading: false }),
    (tab) => set({ managerNav: { tab, at: Date.now() } }),
    // 其他窗口改设置（主题/字体/开关）→ 本窗同步，applyAppearance 随 settingsSnap 重跑。
    (s) => set({ settingsSnap: s }),
  );

  async function refresh() {
    try {
      set({ snapshot: await rpc.rpc!.request.getSnapshot({}), snapshotError: false });
    } catch {
      // 无桥预览/桥未就绪：保留旧快照（若有），置错标记供动态页出重试态。
      set({ snapshotError: true });
    }
    set({ loading: false });
  }

  async function installHooks() {
    const result = await rpc.rpc!.request.installHooks({});
    await refresh();
    return result;
  }

  async function refreshQuotas() {
    await rpc.rpc!.request.refreshQuotas({});
    await refresh();
  }

  async function usageDaily(opts: { days?: number; since?: number } = { days: 70 }) {
    return rpc.rpc!.request.usageDaily(opts);
  }

  async function loadSettings() {
    try {
      set({ settingsSnap: await rpc.rpc!.request.getSettings({}), settingsError: false });
    } catch {
      // 离线预览/主进程失联：保持 null，设置页按 settingsError 区分「读取中」与「不可用」。
      set({ settingsError: true });
    }
  }

  async function updateSettings(patch: Partial<MurmurSettings>) {
    set({ settingsSnap: await rpc.rpc!.request.updateSettings({ patch }) });
  }

  async function setAgentHook(agent: AgentId, enabled: boolean) {
    set({ settingsSnap: await rpc.rpc!.request.setAgentHook({ agent, enabled }) });
    await refresh();
  }

  async function setAgentObserved(agent: AgentId, enabled: boolean) {
    set({ settingsSnap: await rpc.rpc!.request.setAgentObserved({ agent, enabled }) });
    await refresh();
  }

  async function setAgentKey(agent: AgentId, apiKey: string | null, baseUrl?: string) {
    set({ settingsSnap: await rpc.rpc!.request.setAgentKey({ agent, apiKey, baseUrl }) });
    await refresh();
  }

  async function readClipboard() {
    const r = await rpc.rpc!.request.readClipboard({});
    return r.text;
  }

  async function writeClipboard(text: string) {
    await rpc.rpc!.request.writeClipboard({ text });
  }

  async function rebuildLedger() {
    await rpc.rpc!.request.rebuildLedger({});
    await refresh();
  }

  async function openManager(tab: ManagerTab = "doctor") {
    await rpc.rpc!.request.openManager({ tab });
  }

  async function getDiagnostics() {
    return rpc.rpc!.request.getDiagnostics({});
  }

  async function testAgentHook(agent: AgentId) {
    return rpc.rpc!.request.testAgentHook({ agent });
  }

  async function rescanAgent(agent: AgentId) {
    await rpc.rpc!.request.rescanAgent({ agent });
  }

  async function installAgentHooks(agent: AgentId) {
    return rpc.rpc!.request.installAgentHooks({ agent });
  }

  async function revealPath(path: string) {
    const r = await rpc.rpc!.request.revealPath({ path });
    return r.ok;
  }

  async function scanSessions() {
    return rpc.rpc!.request.scanSessions({});
  }

  async function deleteSessions(items: { agent: AgentId; id: string }[]) {
    const r = await rpc.rpc!.request.deleteSessions({ items });
    return r.results;
  }

  async function revealSession(agent: AgentId, id: string) {
    const r = await rpc.rpc!.request.revealSession({ agent, id });
    return r.ok;
  }

  async function openDataDir() {
    await rpc.rpc!.request.openDataDir({});
  }

  function quit() {
    void rpc.rpc!.request.quitApp({});
  }

  return {
    snapshot: null,
    loading: true,
    snapshotError: false,
    settingsSnap: null,
    settingsError: false,
    managerNav: null,
    refresh,
    installHooks,
    refreshQuotas,
    usageDaily,
    loadSettings,
    updateSettings,
    setAgentHook,
    setAgentObserved,
    setAgentKey,
    readClipboard,
    writeClipboard,
    rebuildLedger,
    openManager,
    getDiagnostics,
    testAgentHook,
    rescanAgent,
    installAgentHooks,
    revealPath,
    scanSessions,
    deleteSessions,
    revealSession,
    openDataDir,
    quit,
  };
});
