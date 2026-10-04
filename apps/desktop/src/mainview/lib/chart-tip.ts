/**
 * 图表悬浮明细的共享类型：锚点坐标（相对图表容器 px）+ 落位。
 * place 由父级按元素距容器边缘的距离计算，chart-tip 只负责位移与外观。
 */

export type ChartTipPlace = "top" | "top-left" | "top-right" | "left" | "right" | "left-up" | "right-up";

export interface ChartTipState {
  x: number;
  y: number;
  place: ChartTipPlace;
}

/** 由 hover 事件与容器 ref 计算顶部锚点：距左右缘不足 64px 时改用贴边落位防溢出。
    形参收敛为 {currentTarget} 结构——DOM MouseEvent 与 React 合成事件都满足。 */
export function anchorTop(event: { currentTarget: EventTarget | null }, host: HTMLElement): ChartTipState {
  const box = host.getBoundingClientRect();
  const el = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const cx = el.left - box.left + el.width / 2;
  const place: ChartTipPlace = cx < 64 ? "top-left" : cx > box.width - 64 ? "top-right" : "top";
  return { x: cx, y: el.top - box.top, place };
}

/** 折线准星锚点的竖向翻转判定：明细卡在锚点下方视口空间放不下时改向上展开（真机实测 7 行卡
    高 ~200px，185px 空间即裁底）。行高按 meta 字 11px + gap ~20px/行，加题行与内边距余量 60。 */
export function tipBelowFits(anchorTopY: number, rows: number): boolean {
  return window.innerHeight - anchorTopY > rows * 20 + 60;
}
