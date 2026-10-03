/**
 * 管理台外壳（标准窗口 #/manage/<tab>）：接入诊断/用量/会话文件/设置四 tab。
 *
 * 初始 tab 由 URL hash 决定（bun 侧 managerViewUrl 生成）；openManager 对已开
 * 窗口不重建，主进程推 managerNav 消息 → store.managerTab 覆盖当前 tab。
 * files 页自带整页布局（内部滚动），其余视图共用 ScrollArea。
 * 与面板各自独立 JS context：此处自负 loadSettings/applyAppearance/refresh。
 */

import { useEffect, useState } from "react";

import DoctorView from "@/components/doctor-view";
import Segmented from "@/components/segmented";
import SessionsView from "@/components/sessions-view";
import SettingsView from "@/components/settings-view";
import UsageView from "@/components/usage-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import { applyAppearance } from "@/lib/appearance";
import { useMurmurStore } from "@/store/murmur";

import type { ManagerTab } from "@core/types";

const TABS: { value: ManagerTab; label: string }[] = [
  { value: "doctor", label: "接入诊断" },
  { value: "usage", label: "用量" },
  { value: "files", label: "会话文件" },
  { value: "settings", label: "设置" },
];

/** URL hash 初始 tab（#/manage/<tab>，非法值回落 doctor）。 */
function hashTab(): ManagerTab {
  const t = typeof location !== "undefined" ? location.hash.split("/")[2] : "";
  return TABS.some((x) => x.value === t) ? (t as ManagerTab) : "doctor";
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
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* 顶部拖拽条：hiddenInset 红绿灯落在这条里 */}
      <div className="h-8 shrink-0" />
      {/* tab 条：eyebrow 标识 + segmented，hairline 封底 */}
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 pb-2.5">
        <span className="eyebrow text-faint">管理台</span>
        <Segmented options={TABS} value={tab} onChange={setTab} label="管理台视图" />
      </div>
      {tab === "files" ? (
        // SessionsView 自带 h-full 布局——外层给 flex-1 定界，否则溢出 tab 条高度。
        <div className="min-h-0 flex-1">
          <SessionsView embedded />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <main className="px-4 py-4">
            {tab === "doctor" && <DoctorView />}
            {tab === "usage" && <UsageView />}
            {tab === "settings" && <SettingsView />}
          </main>
        </ScrollArea>
      )}
    </div>
  );
}
