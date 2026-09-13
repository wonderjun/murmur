/**
 * 主进程 ↔ webview 的 RPC 契约，双端共享。
 */

import type { RPCSchema } from "electrobun/main";

import type { AppSnapshot } from "@core/types";
import type { AgentId } from "@core/types";
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
  };
}

export type MurmurRPC = {
  bun: RPCSchema<{
    requests: {
      getSnapshot: { params: {}; response: AppSnapshot };
      installHooks: { params: {}; response: Record<string, boolean> };
      hidePanel: { params: {}; response: { ok: true } };
      /** 手动触发各 agent 额度拉取。 */
      refreshQuotas: { params: {}; response: { ok: true } };
      /** 近 N 天 × agent × model 的 token 明细（用量页三图）。 */
      usageDaily: { params: { days?: number }; response: UsageDailyRow[] };
      /** 设置页：读设置 + 运行时实况。 */
      getSettings: { params: {}; response: SettingsSnapshot };
      /** 设置页：应用设置补丁（dock/自启即时生效）。 */
      updateSettings: { params: { patch: Partial<MurmurSettings> }; response: SettingsSnapshot };
      /** 设置页：单个 agent 的 hook 上报开关（关=卸载我方条目）。 */
      setAgentHook: { params: { agent: AgentId; enabled: boolean }; response: SettingsSnapshot };
      /** 设置页：单个 agent 的监听总开关（关=停 watch + 卸 hook + 面板隐藏）。 */
      setAgentObserved: { params: { agent: AgentId; enabled: boolean }; response: SettingsSnapshot };
      /** 清空台账与游标，pull watcher 下轮全量重扫。 */
      rebuildLedger: { params: {}; response: { ok: true } };
      /** Finder 打开 ~/.murmur 数据目录。 */
      openDataDir: { params: {}; response: { ok: true } };
      quitApp: { params: {}; response: { ok: true } };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      /** 主进程 → UI 的全量快照推送。 */
      snapshot: AppSnapshot;
    };
  }>;
};
