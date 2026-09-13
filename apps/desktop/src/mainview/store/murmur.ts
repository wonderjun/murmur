/**
 * Murmur 面板状态：RPC 快照 + 视图状态。
 *
 * 数据流：主进程推送/主动拉取 → snapshot → 各组件渲染。
 * 「轮到你了」计数驱动 header 高亮与栖枝栖息态。
 */

import { computed, ref } from "vue";

import { defineStore } from "pinia";

import { useRpc } from "@/lib/rpc";

import type { SettingsSnapshot } from "../../shared/rpc";
import type { MurmurSettings } from "@core/settings";
import type { AgentId, AppSnapshot } from "@core/types";

export const useMurmurStore = defineStore("murmur", () => {
  const snapshot = ref<AppSnapshot | null>(null);
  const loading = ref(true);
  const settingsSnap = ref<SettingsSnapshot | null>(null);

  const rpc = useRpc((s) => {
    snapshot.value = s;
    loading.value = false;
  });

  async function refresh() {
    try {
      snapshot.value = await rpc.rpc!.request.getSnapshot({});
    } catch {
      // 无桥预览/桥未就绪时保持空态，下次推送或手动刷新再补齐。
    }
    loading.value = false;
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

  /** 进入设置页时拉取；之后以各 mutation 的响应为准（响应即最新态）。 */
  async function loadSettings() {
    try {
      settingsSnap.value = await rpc.rpc!.request.getSettings({});
    } catch {
      // 离线预览：保持 null，设置页显示不可用态。
    }
  }

  async function updateSettings(patch: Partial<MurmurSettings>) {
    settingsSnap.value = await rpc.rpc!.request.updateSettings({ patch });
  }

  async function setAgentHook(agent: AgentId, enabled: boolean) {
    settingsSnap.value = await rpc.rpc!.request.setAgentHook({ agent, enabled });
    await refresh();
  }

  async function setAgentObserved(agent: AgentId, enabled: boolean) {
    settingsSnap.value = await rpc.rpc!.request.setAgentObserved({ agent, enabled });
    await refresh();
  }

  async function rebuildLedger() {
    await rpc.rpc!.request.rebuildLedger({});
    await refresh();
  }

  async function openDataDir() {
    await rpc.rpc!.request.openDataDir({});
  }

  function quit() {
    void rpc.rpc!.request.quitApp({});
  }

  /** 活跃会话：被停用监听的 agent 会话快照里本来就不挂，双保险再滤一层。 */
  const observedAgents = computed(() => snapshot.value?.agents.filter((a) => !a.disabled) ?? []);

  const allSessions = computed(() => observedAgents.value.flatMap((a) => a.sessions));

  const waitingCount = computed(() => allSessions.value.filter((s) => s.status === "waiting").length);

  const workingCount = computed(() => allSessions.value.filter((s) => s.status === "working").length);

  const installedAgents = computed(() => observedAgents.value.filter((a) => a.install.installed));

  /** 今日全量 token 合计。 */
  const todayTokens = computed(() =>
    observedAgents.value.reduce((sum, a) => sum + (a.today?.tokens ?? 0), 0),
  );

  return {
    snapshot,
    loading,
    settingsSnap,
    waitingCount,
    workingCount,
    installedAgents,
    allSessions,
    todayTokens,
    refresh,
    installHooks,
    refreshQuotas,
    usageDaily,
    loadSettings,
    updateSettings,
    setAgentHook,
    setAgentObserved,
    rebuildLedger,
    openDataDir,
    quit,
  };
});
