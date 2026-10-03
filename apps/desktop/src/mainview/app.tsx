/**
 * React 面板外壳：玻璃 overlay 布局——刊头/底栏 absolute 浮于滚动区之上
 * （glass-chrome 毛玻璃，内容从其下穿过），底栏为编号式导航。
 * `#/design` hash 进设计板预览组件。
 */

import { Activity, AppWindow, Power, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";

import ManagerApp from "@/components/manager-app";
import MonitorView from "@/components/monitor-view";
import MurmurHeader from "@/components/murmur-header";
import SetupView from "@/components/setup-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import DesignBoard from "@/design/design-board";
import { applyAppearance } from "@/lib/appearance";
import { waitingCount } from "@/lib/selectors";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { ComponentType } from "react";

type ViewId = "live" | "setup";

const NAV_ITEMS: { id: ViewId; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { id: "live", label: "动态", icon: Activity },
  { id: "setup", label: "工具", icon: Settings2 },
];

const VIEW_LABEL: Record<ViewId, string> = Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.label])) as Record<
  ViewId,
  string
>;

export default function App() {
  const isDesign = location.hash.startsWith("#/design");
  // 管理台窗口内容（views://…#/manage/<tab> 由第二 BrowserWindow 加载）。
  const isManager = location.hash.startsWith("#/manage");
  const [view, setView] = useState<ViewId>("live");

  const snapshot = useMurmurStore((s) => s.snapshot);
  const refresh = useMurmurStore((s) => s.refresh);
  const quit = useMurmurStore((s) => s.quit);
  const openManager = useMurmurStore((s) => s.openManager);
  const loadSettings = useMurmurStore((s) => s.loadSettings);
  const theme = useMurmurStore((s) => s.settingsSnap?.settings.theme ?? "system");
  const font = useMurmurStore((s) => s.settingsSnap?.settings.font ?? "");
  const waiting = waitingCount(snapshot);

  useEffect(() => {
    void refresh();
    void loadSettings();
  }, [refresh, loadSettings]);

  /* 外观在首帧应用：settings 未到时按 system 渲染，到达后纠正——面板隐藏加载，
     全程不可见。effect 必须早于 #/design 早退，设计板同样吃主题。 */
  useEffect(() => applyAppearance(theme, font), [theme, font]);

  if (isDesign) return <DesignBoard />;
  if (isManager) return <ManagerApp />;

  return (
    <div className="relative h-full bg-background">
      {/* 滚动区铺满，上下留白让位于玻璃 chrome（--chrome-top/--chrome-bottom） */}
      <ScrollArea className="h-full overflow-hidden">
        <main
          key={view}
          aria-live="polite"
          aria-label={`当前视图：${VIEW_LABEL[view]}`}
          className="px-4 pb-4"
          style={{
            paddingTop: "calc(var(--chrome-top) + 8px)",
            paddingBottom: "calc(var(--chrome-bottom) + 12px)",
          }}
        >
          {view === "live" && <MonitorView />}
          {view === "setup" && <SetupView />}
        </main>
      </ScrollArea>

      {/* 玻璃刊头：滚动内容从其下穿过；hairline 分隔在无滚动时读作普通分区线 */}
      <div className="glass-chrome absolute inset-x-0 top-0 z-20 border-b border-hairline/50">
        <MurmurHeader />
      </div>

      <footer className="glass-chrome absolute inset-x-0 bottom-0 z-20 border-t border-hairline/50 px-3 py-2">
        <div className="flex items-center">
          <nav className="flex items-center gap-0.5 rounded-full bg-muted p-0.5" aria-label="主视图">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1 text-meta font-medium transition-colors duration-fast",
                    active
                      ? "border-hairline bg-raised text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setView(item.id)}
                >
                  <Icon size={12} strokeWidth={1.8} />
                  {item.label}
                  {item.id === "live" && waiting > 0 && (
                    <span
                      role="status"
                      aria-label={`${waiting} 个会话待处理`}
                      className="font-mono text-micro tabular-nums text-waiting"
                    >
                      {waiting}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <button
            type="button"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-raised hover:text-muted-foreground"
            title="管理台"
            onClick={() => void openManager("doctor")}
          >
            <AppWindow size={13} />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-stale/10 hover:text-stale"
            title="退出 Murmur"
            onClick={quit}
          >
            <Power size={13} />
          </button>
        </div>
      </footer>
    </div>
  );
}
