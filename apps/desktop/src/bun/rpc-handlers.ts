/**
 * RPC request handler 编排：契约实现与 Electrobun 注册解耦。
 *
 * BrowserView.defineRPC 仍只在 index.ts（那里才 import electrobun）。
 * 本模块收 registry 与系统副作用回调，返回受 MurmurRPC bun.requests
 * 约束的 handlers——缺方法或 params/response 不符，在本文件编译期失败。
 * BYOK apiKey 只进 registry.setAgentKey，响应恒为 settings 快照，不回传明文。
 */

import type { AgentId, ManagerTab } from "../../../../packages/core/src/index";
import type { MurmurSettings } from "../../../../packages/core/src/settings";
import type { MurmurRPC, SettingsSnapshot } from "../shared/rpc";
import type { FocusAppResult } from "./focus-app";

/** bun.requests 的单方法实现：入参与返回值钉死在契约上。 */
type RequestHandler<M extends keyof RpcRequests> = (
  params: RpcRequests[M]["params"],
) => RpcRequests[M]["response"] | Promise<RpcRequests[M]["response"]>;

type RpcRequests = MurmurRPC["bun"]["requests"];

/** 全部 request 必有实现；漏一个即类型错误。 */
export type MurmurRequestHandlers = { [M in keyof RpcRequests]: RequestHandler<M> };

/** handler 依赖的 registry 切片：只列 RPC 真正调用的方法，测试可替身。 */
export interface RpcRegistry {
  snapshot(): RpcRequests["getSnapshot"]["response"];
  installAllHooks(): Promise<RpcRequests["installHooks"]["response"]> | RpcRequests["installHooks"]["response"];
  refreshQuotas(): Promise<void>;
  usageDailySince(sinceMs: number): RpcRequests["usageDaily"]["response"];
  getSettings(): MurmurSettings;
  updateSettings(patch: Partial<MurmurSettings>): Promise<MurmurSettings>;
  setAgentHook(agent: AgentId, enabled: boolean): Promise<MurmurSettings>;
  setAgentObserved(agent: AgentId, enabled: boolean): Promise<MurmurSettings>;
  setAgentKey(agent: AgentId, apiKey: string | null, baseUrl?: string): Promise<void>;
  rebuildLedger(): void;
  diagnostics(): Promise<RpcRequests["getDiagnostics"]["response"]> | RpcRequests["getDiagnostics"]["response"];
  testAgentHook(
    agent: AgentId,
  ): Promise<RpcRequests["testAgentHook"]["response"]> | RpcRequests["testAgentHook"]["response"];
  rescanAgent(agent: AgentId): Promise<void>;
  installAgentHooks(
    agent: AgentId,
  ): Promise<RpcRequests["installAgentHooks"]["response"]> | RpcRequests["installAgentHooks"]["response"];
  scanSessions(): Promise<RpcRequests["scanSessions"]["response"]["items"]>;
  deleteSessions(
    items: RpcRequests["deleteSessions"]["params"]["items"],
    trash: (path: string) => boolean,
  ): Promise<RpcRequests["deleteSessions"]["response"]["results"]>;
  sessionPaths(agent: AgentId, id: string): Promise<string[]>;
}

/** 主进程注入的系统副作用；本模块不 import electrobun。 */
export interface RpcHandlerDeps {
  registry: RpcRegistry;
  /** 设置页快照（含 Updater 版本实况），由主进程组装。 */
  settingsSnapshot: () => Promise<SettingsSnapshot>;
  /** 设置变更广播：mutation 返回前把最新快照推给所有窗口（双窗主题/字体即时同步）。 */
  pushSettings: (snap: SettingsSnapshot) => void;
  /** 用户家目录；revealPath 只放行其下的路径。 */
  homeDir: string;
  now?: () => number;
  hidePanel: () => void;
  readClipboard: () => string | null;
  writeClipboard: (text: string) => void;
  /** Dock 图标显隐（updateSettings 的 showDockIcon 副作用）。 */
  applyDockIcon: (visible: boolean) => void;
  /** 写 LaunchAgent；返回系统实况（与意图不符时回写设置）。 */
  setLaunchAtLogin: (enabled: boolean) => boolean;
  /** 缺省 tab 已在 handler 内落成 doctor。 */
  openManager: (tab: ManagerTab) => void;
  /** Finder 定位；调用方已确认路径允许。 */
  revealInFinder: (path: string) => void;
  /** 唤起宿主 app 到台前；cwd 供祖先链候选精确匹配（缺省也能跑）。 */
  focusApp: (agent: AgentId, cwd: string | undefined) => Promise<FocusAppResult>;
  /** 文件类会话产物进废纸篓。 */
  moveToTrash: (path: string) => boolean;
  openDataDir: () => void;
  quit: () => void;
}

/** 组装全部 bun request handler。 */
export function createRpcHandlers(deps: RpcHandlerDeps): MurmurRequestHandlers {
  const { registry } = deps;
  const now = deps.now ?? Date.now;

  /** 设置 mutation 统一出口：取最新快照 → 广播 → 返回给发起窗（自己也是收方，幂等）。 */
  async function pushSettings(): Promise<SettingsSnapshot> {
    const snap = await deps.settingsSnapshot();
    deps.pushSettings(snap);
    return snap;
  }

  return {
    getSnapshot: () => registry.snapshot(),
    installHooks: () => registry.installAllHooks(),
    hidePanel: () => {
      deps.hidePanel();
      return { ok: true };
    },
    refreshQuotas: async () => {
      await registry.refreshQuotas();
      return { ok: true };
    },
    usageDaily: ({ days, since }) => registry.usageDailySince(since ?? now() - (days ?? 70) * 86400_000),
    getSettings: () => deps.settingsSnapshot(),
    updateSettings: async ({ patch }) => {
      await registry.updateSettings(patch);
      if (patch.showDockIcon !== undefined) deps.applyDockIcon(patch.showDockIcon);
      if (patch.launchAtLogin !== undefined) {
        const actual = deps.setLaunchAtLogin(patch.launchAtLogin);
        // 实际态与意图不符（如 dev 无 bundle）时回写，设置存储与系统实况保持自洽。
        if (actual !== patch.launchAtLogin) await registry.updateSettings({ launchAtLogin: actual });
      }
      return pushSettings();
    },
    setAgentHook: async ({ agent, enabled }) => {
      await registry.setAgentHook(agent, enabled);
      return pushSettings();
    },
    setAgentObserved: async ({ agent, enabled }) => {
      await registry.setAgentObserved(agent, enabled);
      return pushSettings();
    },
    setAgentKey: async ({ agent, apiKey, baseUrl }) => {
      await registry.setAgentKey(agent, apiKey, baseUrl);
      return pushSettings();
    },
    readClipboard: () => ({ text: deps.readClipboard() }),
    writeClipboard: ({ text }) => {
      deps.writeClipboard(text);
      return { ok: true };
    },
    rebuildLedger: () => {
      registry.rebuildLedger();
      return { ok: true };
    },
    openManager: ({ tab }) => {
      deps.openManager(tab ?? "doctor");
      return { ok: true };
    },
    getDiagnostics: () => registry.diagnostics(),
    testAgentHook: ({ agent }) => registry.testAgentHook(agent),
    rescanAgent: async ({ agent }) => {
      await registry.rescanAgent(agent);
      return { ok: true };
    },
    installAgentHooks: ({ agent }) => registry.installAgentHooks(agent),
    revealPath: ({ path }) => {
      // 只放行用户家目录内的路径——诊断清单以外的任意路径不该被定位。
      const ok = Boolean(deps.homeDir) && path.startsWith(`${deps.homeDir}/`);
      if (ok) deps.revealInFinder(path);
      return { ok };
    },
    scanSessions: async () => ({ items: await registry.scanSessions(), scannedAt: now() }),
    deleteSessions: async ({ items }) => ({
      // 文件类产物一律进废纸篓（可恢复）；库内行由 adapter 自行事务删。
      results: await registry.deleteSessions(items, deps.moveToTrash),
    }),
    revealSession: async ({ agent, id }) => {
      const [path] = await registry.sessionPaths(agent, id);
      if (path) deps.revealInFinder(path);
      return { ok: Boolean(path) };
    },
    focusSessionApp: async ({ agent, id }) => {
      // 活跃会话与 recentlyEnded 都算数：ended 会话宿主 app 多半仍在，cwd 照旧兜得上。
      const snap = registry.snapshot();
      const session =
        snap.agents.flatMap((a) => a.sessions).find((s) => s.agent === agent && s.sessionId === id) ??
        (snap.recentlyEnded ?? []).find((s) => s.agent === agent && s.sessionId === id);
      return deps.focusApp(agent, session?.cwd);
    },
    openDataDir: () => {
      deps.openDataDir();
      return { ok: true };
    },
    quitApp: () => {
      deps.quit();
      return { ok: true };
    },
  };
}
