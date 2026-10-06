/**
 * 应用内更新：electrobun Updater 的相位归一化与广播。
 *
 * Updater 状态流有 25+ 细粒度 status（补丁链/本地包探测/解压换包），
 * UI 只消费七相——mapUpdatePhase 收敛语义：检查/已最新/可更新/下载中/
 * 应用中/错误/待命。downloadUpdate 内部自动补 checkForUpdate，applyUpdate
 * 换包后进程退出、由更新助手重启（apply 的受理响应先于退出返回）。
 * 本模块不 import electrobun（同 rpc-handlers 的边界约定），Updater 按
 * 结构注入，测试可注替身。
 */

import type { UpdateStatusType } from "electrobun/main";

import type { UpdatePhase, UpdateSnapshot } from "../shared/rpc";

/** Updater 的最小依赖面：index.ts 注真身，测试注替身。 */
export interface UpdaterLike {
  getLocalInfo(): Promise<{ version: string; channel: string }>;
  checkForUpdate(): Promise<{ version: string; updateAvailable: boolean; updateReady: boolean; error: string }>;
  downloadUpdate(): Promise<void>;
  applyUpdate(): Promise<void>;
  updateInfo(): { version: string; updateAvailable: boolean; updateReady: boolean; error: string };
  onStatusChange(
    cb: ((entry: { status: UpdateStatusType; details?: { progress?: number; errorMessage?: string } }) => void) | null,
  ): void;
}

/** Updater 细粒度状态 → UI 相位。下载链路（patch/解压/本地包探测）全归 downloading，换包重启链路归 applying。 */
export function mapUpdatePhase(status: UpdateStatusType): UpdatePhase {
  switch (status) {
    case "checking":
      return "checking";
    case "update-available":
      return "available";
    case "no-update":
      return "up-to-date";
    case "applying":
    case "extracting":
    case "replacing-app":
    case "launching-new-version":
    case "complete":
      return "applying";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return "downloading";
  }
}

export interface UpdateServiceDeps {
  updater: UpdaterLike;
  /** 相位推进广播到全部窗口。 */
  broadcast: (snap: UpdateSnapshot) => void;
}

export interface UpdateService {
  state(): Promise<UpdateSnapshot>;
  check(): Promise<UpdateSnapshot>;
  apply(): Promise<{ ok: boolean; error?: string }>;
}

/** 组装更新服务：相位快照内存态（不落库），onStatusChange 每次推进都广播。 */
export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  let snap: UpdateSnapshot = { phase: "idle", current: "dev", channel: "dev" };
  let init: Promise<void> | null = null;

  /** version.json 首读是异步的；裸 bun 直跑读不到 → 保持 dev 占位。 */
  function ensureInfo(): Promise<void> {
    init ??= deps.updater
      .getLocalInfo()
      .then((info) => {
        snap = { ...snap, current: info.version || "dev", channel: info.channel || "dev" };
      })
      .catch(() => {});
    return init;
  }

  deps.updater.onStatusChange((entry) => {
    const phase = mapUpdatePhase(entry.status);
    const info = deps.updater.updateInfo();
    snap = {
      phase,
      current: snap.current,
      channel: snap.channel,
      latest: info.updateAvailable && info.version ? info.version : snap.latest,
      progress: phase === "downloading" ? entry.details?.progress : undefined,
      error: phase === "error" ? (entry.details?.errorMessage ?? info.error ?? undefined) : undefined,
    };
    deps.broadcast(snap);
  });

  /** 非打包 channel（dev/裸跑）不触网，相位保持原地。 */
  function updatable() {
    return snap.channel === "stable" || snap.channel === "canary";
  }

  return {
    state: async () => {
      await ensureInfo();
      return snap;
    },
    check: async () => {
      await ensureInfo();
      if (updatable()) await deps.updater.checkForUpdate();
      return snap;
    },
    apply: async () => {
      await ensureInfo();
      if (!updatable()) return { ok: false, error: "开发构建没有更新通道" };
      // 受理即返回：下载可能超过 RPC 超时，相位全部由状态流推送；
      // 失败走 Updater 的 error 状态落地，链上 catch 只为兜未处理拒绝。
      void deps.updater
        .downloadUpdate()
        .then(() => deps.updater.applyUpdate())
        .catch(() => {});
      return { ok: true };
    },
  };
}
