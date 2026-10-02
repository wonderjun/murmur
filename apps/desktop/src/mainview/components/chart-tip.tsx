/** 图表瞬时悬浮明细：单例浮层（父容器需 relative），鼠标事件驱动、零延迟，取代原生 title。place 由父级按边缘距离决定。 */

import type { ReactNode } from "react";

import type { ChartTipState } from "@/lib/chart-tip";

/** 各锚位的位移表：top 系锚在元素上方居中/贴左/贴右，left/right 供折线准星左右翻转。 */
const TRANSFORMS: Record<ChartTipState["place"], string> = {
  top: "translate(-50%, calc(-100% - 8px))",
  "top-left": "translate(-12%, calc(-100% - 8px))",
  "top-right": "translate(-88%, calc(-100% - 8px))",
  right: "translate(12px, 4px)",
  left: "translate(calc(-100% - 12px), 4px)",
};

export default function ChartTip({ tip, children }: { tip: ChartTipState | null; children?: ReactNode }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-30 animate-tip-in"
      style={{ left: tip.x, top: tip.y, transform: TRANSFORMS[tip.place] }}
    >
      <div className="glass-overlay rounded-item border border-hairline px-2.5 py-2 shadow-overlay">{children}</div>
    </div>
  );
}
