/**
 * updates 单测：Updater 细粒度状态 → UI 七相的映射、相位快照的合并语义、
 * dev/裸跑 channel 不触网的 gate、apply 的受理即返回。全走注入假 Updater，
 * 不 import electrobun、不碰真机网络与文件系统。
 */

import { describe, expect, test } from "bun:test";

import { createUpdateService, mapUpdatePhase } from "../src/bun/updates";

import type { UpdaterLike } from "../src/bun/updates";
import type { UpdateSnapshot } from "../src/shared/rpc";

type StatusCb = Parameters<UpdaterLike["onStatusChange"]>[0];

interface FakeUpdater extends UpdaterLike {
  checks: number;
  downloads: number;
  applies: number;
  info: { version: string; updateAvailable: boolean; updateReady: boolean; error: string };
  emit(status: Parameters<typeof mapUpdatePhase>[0], details?: { progress?: number; errorMessage?: string }): void;
}

function fakeUpdater(over: { channel?: string; available?: boolean } = {}): FakeUpdater {
  let cb: StatusCb = null;
  const fake: FakeUpdater = {
    checks: 0,
    downloads: 0,
    applies: 0,
    info: { version: "", updateAvailable: false, updateReady: false, error: "" },
    getLocalInfo: async () => ({ version: "0.1.2", channel: over.channel ?? "stable" }),
    checkForUpdate: async () => {
      fake.checks += 1;
      fake.info = {
        version: over.available ? "0.1.3" : "0.1.2",
        updateAvailable: over.available ?? false,
        updateReady: false,
        error: "",
      };
      fake.emit("checking");
      fake.emit(over.available ? "update-available" : "no-update");
      return fake.info;
    },
    downloadUpdate: async () => {
      fake.downloads += 1;
      fake.emit("downloading-full-bundle");
      fake.emit("download-progress", { progress: 42 });
      fake.info.updateReady = true;
    },
    applyUpdate: async () => {
      fake.applies += 1;
      fake.emit("applying");
    },
    updateInfo: () => fake.info,
    onStatusChange: (next) => {
      cb = next;
    },
    emit: (status, details) => cb?.({ status, details }),
  };
  return fake;
}

function serviceWith(updater: FakeUpdater): { svc: ReturnType<typeof createUpdateService>; pushed: UpdateSnapshot[] } {
  const pushed: UpdateSnapshot[] = [];
  const svc = createUpdateService({ updater, broadcast: (s) => pushed.push(s) });
  return { svc, pushed };
}

describe("mapUpdatePhase", () => {
  test("锚点各归其位，下载链路杂项全落 downloading", () => {
    expect(mapUpdatePhase("checking")).toBe("checking");
    expect(mapUpdatePhase("update-available")).toBe("available");
    expect(mapUpdatePhase("no-update")).toBe("up-to-date");
    expect(mapUpdatePhase("error")).toBe("error");
    expect(mapUpdatePhase("applying")).toBe("applying");
    expect(mapUpdatePhase("launching-new-version")).toBe("applying");
    expect(mapUpdatePhase("idle")).toBe("idle");
    expect(mapUpdatePhase("downloading-full-bundle")).toBe("downloading");
    expect(mapUpdatePhase("download-progress")).toBe("downloading");
    expect(mapUpdatePhase("patch-applied")).toBe("downloading");
  });
});

describe("createUpdateService", () => {
  test("state 首次读时灌水本地版本/channel", async () => {
    const { svc } = serviceWith(fakeUpdater());
    expect(await svc.state()).toEqual({ phase: "idle", current: "0.1.2", channel: "stable" });
  });

  test("dev channel 不触网：check/apply 都被 gate", async () => {
    const updater = fakeUpdater({ channel: "dev" });
    const { svc, pushed } = serviceWith(updater);
    expect(await svc.check()).toMatchObject({ phase: "idle", channel: "dev" });
    expect(await svc.apply()).toEqual({ ok: false, error: "开发构建没有更新通道" });
    expect(updater.checks).toBe(0);
    expect(updater.downloads).toBe(0);
    expect(pushed).toEqual([]);
  });

  test("stable 检查：无更新落 up-to-date，有更新带远端版本", async () => {
    const { svc, pushed } = serviceWith(fakeUpdater({ available: true }));
    const snap = await svc.check();
    expect(snap.phase).toBe("available");
    expect(snap.latest).toBe("0.1.3");
    // checking → update-available 两帧都广播出去。
    expect(pushed.map((s) => s.phase)).toEqual(["checking", "available"]);
  });

  test("apply 受理即返回 ok；下载+换包在后台推进，相位照常广播", async () => {
    const updater = fakeUpdater({ available: true });
    const { svc, pushed } = serviceWith(updater);
    expect(await svc.apply()).toEqual({ ok: true });
    // 链是 void 的——让 microtask 跑完再断言调用序。
    await Promise.resolve();
    expect(updater.downloads).toBe(1);
    expect(updater.applies).toBe(1);
    expect(pushed.at(-1)?.phase).toBe("applying");
  });

  test("下载进度与错误细节进快照，离开相位即清", async () => {
    const updater = fakeUpdater({ available: true });
    const { svc, pushed } = serviceWith(updater);
    await svc.check();
    updater.emit("download-progress", { progress: 42 });
    expect(pushed.at(-1)).toMatchObject({ phase: "downloading", progress: 42 });
    updater.emit("applying");
    expect(pushed.at(-1)).toMatchObject({ phase: "applying", progress: undefined });
    updater.emit("error", { errorMessage: "boom" });
    expect(pushed.at(-1)).toMatchObject({ phase: "error", error: "boom" });
  });
});
