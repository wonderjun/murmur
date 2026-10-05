/**
 * 管理台外壳（标准窗口 #/manage/<tab>）：左侧 200px 边栏导航 + 右侧内容区
 * 流体铺满（不限宽居中，宽窗全用）。首子元素 Dawn quiet 垫底（管理台天光不呼吸）。
 *
 * 初始 tab 由 URL hash 决定（bun 侧 managerViewUrl 生成）；openManager 对已开
 * 窗口不重建，主进程推 managerNav 消息 → store.managerTab 覆盖当前 tab。
 * files 页自带整页布局（内部滚动），其余视图共用 ScrollArea。
 * 与面板各自独立 JS context：此处自负 loadSettings/applyAppearance/refresh。
 */

import { useEffect, useState } from "react";

import Dawn from "@/components/dawn";
import DoctorView from "@/components/doctor-view";
import ManagerSidebar from "@/components/manager-sidebar";
import SessionsView from "@/components/sessions-view";
import SettingsView from "@/components/settings-view";
import UsageView from "@/components/usage-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import { applyAppearance } from "@/lib/appearance";
import { useMurmurStore } from "@/store/murmur";

import type { CSSProperties } from "react";
import type { ManagerTab } from "@core/types";

const VALID_TABS: ManagerTab[] = ["doctor", "usage", "files", "settings"];

/** 内容列顶部拖拽条：hiddenInset 红绿灯与边栏顶条同高对齐。 */
const DRAG_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;

/** URL hash 初始 tab（#/manage/<tab>，非法值回落 doctor）。 */
function hashTab(): ManagerTab {
  const t = typeof location !== "undefined" ? location.hash.split("/")[2] : "";
  return VALID_TABS.includes(t as ManagerTab) ? (t as ManagerTab) : "doctor";
}

export default function ManagerApp() {
  const nav = useMurmurStore((s) => s.managerNav);
  const [tab, setTab] = useState<ManagerTab>(hashTab);
  const loadSettings = useMurmurStore((s) => s.loadSettings);
  const refresh = useMurmurStore((s) => s.refresh);
  const theme = useMurmurStore((s) => s.settingsSnap?.settings.theme ?? "system");
  const font = useMurmurStore((s) => s.settingsSnap?.settings.font ?? "");

  useEffect(() => {
    void refresh();
    void loadSettings();
  }, [refresh, loadSettings]);

  useEffect(() => applyAppearance(theme, font), [theme, font]);

  // managerNav 推送优先于 hash 初始值（at nonce 保证同 tab 重发也生效）。
  useEffect(() => {
    if (nav) setTab(nav.tab);
  }, [nav]);

  return (
    <div className="relative flex h-full overflow-hidden bg-background text-foreground">
      <Dawn className="z-0" />
      <ManagerSidebar tab={tab} onChange={setTab} />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <div className="h-[52px] shrink-0" style={DRAG_STYLE} />
        {tab === "files" ? (
          // SessionsView 自带 h-full 布局——外层给 min-h-0 定界。内容列流体铺满：
          // 宽窗不再居中限宽（全屏双留白实测很难看），padding 走断点收紧。
          <div className="min-h-0 w-full min-w-0 flex-1 px-8 pb-6 mid:px-5 tight:px-4">
            <SessionsView embedded />
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <main className="w-full min-w-0 px-8 pb-10 mid:px-5 tight:px-4">
              {tab === "doctor" && <DoctorView />}
              {tab === "usage" && <UsageView />}
              {tab === "settings" && <SettingsView />}
            </main>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
