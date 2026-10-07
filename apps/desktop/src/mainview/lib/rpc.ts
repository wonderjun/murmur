/**
 * webview 侧 RPC 客户端：Electroview 单例 + MurmurRPC 契约。
 *
 * 主进程推送经 messages.snapshot 进来；UI 主动拉取用 rpc.request.*。
 * 纯浏览器（无 window.__electrobun 桥，如设计板独立预览）下降级为惰性替身：
 * 请求一律 reject，由调用方 catch 后落入空态，绝不让面板白屏。
 *
 * 类型注意：electrobun 的泛型槽位要的是「defineRPC 返回的 RPC 对象」，
 * 不是 MurmurRPC schema——故视图类型取 ReturnType<typeof createView>。
 */

import Electrobun, { Electroview } from "electrobun/view";

import type { AppSnapshot, ManagerTab } from "@core/types";

import type { MurmurRPC, SettingsSnapshot, UpdateSnapshot } from "../../shared/rpc";

/** 创建真实桥接视图（仅在 electrobun webview 内调用，桥缺失时构造会抛错）。 */
function createView(
  onSnapshot: (s: AppSnapshot) => void,
  onManagerNav: (tab: ManagerTab) => void,
  onSettings: (s: SettingsSnapshot) => void,
  onUpdateStatus: (u: UpdateSnapshot) => void,
) {
  const rpc = Electroview.defineRPC<MurmurRPC>({
    maxRequestTime: 15000,
    handlers: {
      requests: {},
      messages: {
        snapshot: (s) => onSnapshot(s),
        managerNav: (m) => onManagerNav(m.tab),
        settings: (s) => onSettings(s),
        updateStatus: (u) => onUpdateStatus(u),
      },
    },
  });
  return new Electrobun.Electroview({ rpc });
}

type MurmurView = ReturnType<typeof createView>;

let instance: MurmurView | null = null;

/** 离线替身：request 下任何方法都 reject，messages 空表，仅服务于无桥预览环境。 */
function createOfflineView(): MurmurView {
  const request = new Proxy({}, { get: () => () => Promise.reject(new Error("murmur: 无 electrobun 桥，离线预览")) });
  return { rpc: { request, messages: {} } } as unknown as MurmurView;
}

/** 获取（首次创建）Electroview 单例；onSnapshot/onManagerNav/onSettings/onUpdateStatus 订阅主进程推送。 */
export function useRpc(
  onSnapshot: (s: AppSnapshot) => void,
  onManagerNav: (tab: ManagerTab) => void = () => {},
  onSettings: (s: SettingsSnapshot) => void = () => {},
  onUpdateStatus: (u: UpdateSnapshot) => void = () => {},
): MurmurView {
  if (!instance) {
    const bridged = typeof window !== "undefined" && Boolean((window as { __electrobun?: unknown }).__electrobun);
    instance = bridged ? createView(onSnapshot, onManagerNav, onSettings, onUpdateStatus) : createOfflineView();
  }
  return instance;
}
