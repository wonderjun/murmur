/** 管理台左侧边栏：五 tab 导航（诊断/用量/会话文件/技能/设置）+ 底部接入计数与版本行。
 *  顶部 52px 是 hiddenInset 红绿灯落位的拖拽区（WebkitAppRegion drag，整条可拖）——
 *  不画描边，侧栏分面只靠 bg-surface-1 半透明叠层，红绿灯区与内容列顶条融成一整条工具栏。
 *  尾巴信号：诊断项有 stale 会话时点红点；用量项挂今日令牌 font-data 计数。 */

import { ChartColumn, FolderOpen, Puzzle, Settings2, Stethoscope } from "lucide-react";
import { useMemo } from "react";

import { AGENT_ORDER } from "@/lib/agent-meta";
import { allSessions, todayTokens } from "@/lib/selectors";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { ComponentType, CSSProperties } from "react";
import type { ManagerTab } from "@core/types";

const ITEMS: { id: ManagerTab; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { id: "doctor", label: "接入诊断", icon: Stethoscope },
  { id: "usage", label: "用量", icon: ChartColumn },
  { id: "files", label: "会话文件", icon: FolderOpen },
  { id: "skills", label: "技能", icon: Puzzle },
  { id: "settings", label: "设置", icon: Settings2 },
];

/** 红绿灯让位条：整条可拖拽。必须用 --electrobun-app-region——React 的
    WebkitAppRegion 内联写法在 WKWebView 被静默丢弃，拖拽此前从未生效。 */
const DRAG_STYLE = { "--electrobun-app-region": "drag" } as CSSProperties;

export default function ManagerSidebar({ tab, onChange }: { tab: ManagerTab; onChange: (tab: ManagerTab) => void }) {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const snap = useMurmurStore((s) => s.settingsSnap);
  const update = useMurmurStore((s) => s.update);

  const agents = snapshot?.agents ?? [];
  const connected = agents.filter((a) => a.install.installed && !a.disabled).length;
  const hasStale = useMemo(() => allSessions(snapshot).some((s) => s.status === "stale"), [snapshot]);
  const tokens = todayTokens(snapshot);

  return (
    <aside className="relative z-10 flex w-50 shrink-0 flex-col bg-surface-1 mid:w-14">
      <div className="h-13 shrink-0" style={DRAG_STYLE} />
      <nav className="flex flex-col gap-0.5 px-2" aria-label="管理台视图">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              className={cn(
                "relative flex h-8 w-full items-center gap-2.5 rounded-row px-2.5 text-detail font-medium transition-colors duration-fast mid:justify-center mid:px-0",
                active
                  ? "bg-surface-3 text-foreground"
                  : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
              )}
              onClick={() => onChange(item.id)}
            >
              <Icon size={14} strokeWidth={1.8} />
              <span className="mid:hidden">{item.label}</span>
              {item.id === "doctor" && hasStale && (
                <span className="ml-auto size-1.5 rounded-full bg-stale mid:hidden" />
              )}
              {item.id === "usage" && tokens > 0 && (
                <span className="ml-auto font-data text-micro tabular-nums text-faint mid:hidden">
                  {fmtTokens(tokens)}
                </span>
              )}
              {/* 有可更新版本：设置项挂前景角标（中性色，非 status 语义）；mid 折叠态贴图标右上角。 */}
              {item.id === "settings" && update?.phase === "available" && (
                <span className="ml-auto size-1.5 rounded-full bg-foreground mid:absolute mid:top-1.5 mid:right-1.5 mid:ml-0" />
              )}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 px-4 pb-4 text-micro text-faint mid:hidden">
        <span>
          已接入 {connected}/{agents.length || AGENT_ORDER.length}
        </span>
        {snap &&
          (update?.phase === "available" ? (
            <button
              type="button"
              className="text-left font-data tabular-nums text-muted-foreground transition-colors duration-fast hover:text-foreground"
              onClick={() => onChange("settings")}
            >
              v{snap.runtime.version} → v{update.latest ?? ""} · 更新
            </button>
          ) : (
            <span className="font-data tabular-nums">
              v{snap.runtime.version} · {snap.runtime.channel}
            </span>
          ))}
      </div>
    </aside>
  );
}
