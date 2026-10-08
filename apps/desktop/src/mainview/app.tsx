/**
 * React 面板外壳：玻璃 overlay 布局——刊头/底栏 absolute 浮于滚动区之上
 * （glass-chrome 毛玻璃，内容从其下穿过）。面板第一子元素是 Dawn 天光
 * （z-0 垫在玻璃之下，chrome 60% 底色会透出光晕）；底栏为文字 tab + 今日令牌。
 * `#/design` hash 进设计板预览组件。
 */

import { AppWindow, Power } from "lucide-react";
import { useEffect, useState } from "react";

import AnimatedNumber from "@/components/animated-number";
import Dawn from "@/components/dawn";
import ManagerApp from "@/components/manager-app";
import MonitorView from "@/components/monitor-view";
import MurmurHeader from "@/components/murmur-header";
import SetupView from "@/components/setup-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import DesignBoard from "@/design/design-board";
import { installAutoFocusGuard } from "@/lib/auto-focus-guard";
import { applyAppearance } from "@/lib/appearance";
import { fmtTokens } from "@/lib/format";
import { todayTokens, waitingCount } from "@/lib/selectors";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

type ViewId = "live" | "setup";

const NAV_ITEMS: { id: ViewId; label: string }[] = [
  { id: "live", label: "动态" },
  { id: "setup", label: "工具" },
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
  const [refreshing, setRefreshing] = useState(false);

  const snapshot = useMurmurStore((s) => s.snapshot);
  const refresh = useMurmurStore((s) => s.refresh);
  const refreshQuotas = useMurmurStore((s) => s.refreshQuotas);
  const quit = useMurmurStore((s) => s.quit);
  const openManager = useMurmurStore((s) => s.openManager);
  const loadSettings = useMurmurStore((s) => s.loadSettings);
  const loadUpdateState = useMurmurStore((s) => s.loadUpdateState);
  const update = useMurmurStore((s) => s.update);
  const theme = useMurmurStore((s) => s.settingsSnap?.settings.theme ?? "system");
  const font = useMurmurStore((s) => s.settingsSnap?.settings.font ?? "");
  const waiting = waitingCount(snapshot);
  const tokens = todayTokens(snapshot);

  useEffect(() => {
    void refresh();
    void loadSettings();
    // 面板晚开可能错过启动检查的 updateStatus 推送，挂载补读相位。
    void loadUpdateState();
    // 面板/管理台/设计板同吃首启初焦点问题（WKWebView 变 key 自动聚焦首个可聚焦元素）
    installAutoFocusGuard();
  }, [refresh, loadSettings, loadUpdateState]);

  /* 外观在首帧应用：settings 未到时按 system 渲染，到达后纠正——面板隐藏加载，
     全程不可见。effect 必须早于 #/design 早退，设计板同样吃主题。 */
  useEffect(() => applyAppearance(theme, font), [theme, font]);

  async function onRefreshQuotas() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshQuotas();
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }

  if (isDesign) return <DesignBoard />;
  if (isManager) return <ManagerApp />;

  return (
    <div className="relative h-full overflow-hidden bg-background">
      {/* 暮色天光：垫底装饰层，有 waiting 时转 live 呼吸（玻璃 chrome 会透出光晕） */}
      <Dawn live={waiting > 0} className="z-0" />

      {/* 滚动区铺满，上下留白让位于玻璃 chrome（--chrome-top/--chrome-bottom） */}
      <ScrollArea className="relative z-10 h-full overflow-hidden">
        <main
          key={view}
          aria-live="polite"
          aria-label={`当前视图：${VIEW_LABEL[view]}`}
          className="min-w-0 px-4 pb-4"
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

      {/* 底栏：文字 tab（选中下划线，live+waiting 时下划线转琥珀）+ 今日令牌 + 窗口动作 */}
      <footer className="glass-chrome absolute inset-x-0 bottom-0 z-20 border-t border-hairline px-4">
        <div className="flex h-11 items-center">
          <nav className="flex min-w-0 items-center gap-4" aria-label="主视图">
            {NAV_ITEMS.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "relative flex items-baseline gap-1 text-detail font-medium transition-colors duration-fast",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                  {item.id === "live" && waiting > 0 && (
                    <span role="status" aria-label={`${waiting} 个会话待处理`}>
                      <AnimatedNumber value={waiting} className="font-data text-micro tabular-nums text-waiting" />
                    </span>
                  )}
                  {active && (
                    <span
                      className={cn(
                        "absolute inset-x-0 -bottom-1.75 h-0.5 rounded-full",
                        item.id === "live" && waiting > 0 ? "bg-waiting" : "bg-foreground",
                      )}
                    />
                  )}
                </button>
              );
            })}
          </nav>
          <button
            type="button"
            className="ml-auto flex shrink-0 items-baseline gap-1 font-data text-meta tabular-nums text-muted-foreground transition-all duration-fast hover:text-foreground"
            title="刷新额度"
            disabled={refreshing}
            onClick={() => void onRefreshQuotas()}
          >
            <span className="font-sans text-faint">今日</span>
            <span className={cn("transition-opacity duration-fast", refreshing && "opacity-50")}>
              {tokens ? fmtTokens(tokens) : "·"}
            </span>
          </button>
          {/* 有可更新版本时管理台钮挂前景角标（非 status 语义走中性色），点击直达设置页更新行。 */}
          <button
            type="button"
            className="relative ml-2 flex size-7 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-surface-2 hover:text-muted-foreground"
            title={update?.phase === "available" ? `有新版本 v${update.latest ?? ""} · 打开设置` : "管理台"}
            onClick={() => void openManager(update?.phase === "available" ? "settings" : "doctor")}
          >
            <AppWindow size={13} />
            {update?.phase === "available" && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" />
            )}
          </button>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-surface-2 hover:text-stale"
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
