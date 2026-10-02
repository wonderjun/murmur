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
import type { AgentId, AppSnapshot, SessionDeleteResult, StoredSession } from "@core/types";

interface MurmurStore {
  snapshot: AppSnapshot | null;
  loading: boolean;
  settingsSnap: SettingsSnapshot | null;
  refresh(): Promise<void>;
  installHooks(): Promise<void>;
  refreshQuotas(): Promise<void>;
  usageDaily(days?: number): Promise<UsageDailyRow[]>;
  /** 进入设置页时拉取；之后以各 mutation 的响应为准（响应即最新态）。 */
  loadSettings(): Promise<void>;
  updateSettings(patch: Partial<MurmurSettings>): Promise<void>;
  setAgentHook(agent: AgentId, enabled: boolean): Promise<void>;
  setAgentObserved(agent: AgentId, enabled: boolean): Promise<void>;
  /** BYOK：写/清 agent 的自填 API Key（apiKey 传空串/null 即清除）。 */
  setAgentKey(agent: AgentId, apiKey: string | null, baseUrl?: string): Promise<void>;
  /** 输入框粘贴兜底（菜单栏伴侣缺 Edit 菜单时 ⌘/⌃V 到不了 webview）。 */
  readClipboard(): Promise<string | null>;
  rebuildLedger(): Promise<void>;
  /** 打开会话文件管理窗（独立窗口，幂等聚焦）。 */
  openSessions(): Promise<void>;
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
  const rpc = useRpc((s) => set({ snapshot: s, loading: false }));

  async function refresh() {
    try {
      set({ snapshot: await rpc.rpc!.request.getSnapshot({}) });
    } catch {
      // 无桥预览/桥未就绪时保持空态，下次推送或手动刷新再补齐。
    }
    set({ loading: false });
  }

  async function installHooks() {
    await rpc.rpc!.request.installHooks({});
    await refresh();
  }

  async function refreshQuotas() {
    await rpc.rpc!.request.refreshQuotas({});
    await refresh();
  }

  async function usageDaily(days = 70) {
    return rpc.rpc!.request.usageDaily({ days });
  }

  async function loadSettings() {
    try {
      set({ settingsSnap: await rpc.rpc!.request.getSettings({}) });
    } catch {
      // 离线预览：保持 null，设置页显示不可用态。
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

  async function rebuildLedger() {
    await rpc.rpc!.request.rebuildLedger({});
    await refresh();
  }

  async function openSessions() {
    await rpc.rpc!.request.openSessions({});
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
    settingsSnap: null,
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
    rebuildLedger,
    openSessions,
    scanSessions,
    deleteSessions,
    revealSession,
    openDataDir,
    quit,
  };
});
