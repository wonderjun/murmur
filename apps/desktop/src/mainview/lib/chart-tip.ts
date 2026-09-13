/**
 * 图表悬浮明细的共享类型：锚点坐标（相对图表容器 px）+ 落位。
 * place 由父级按元素距容器边缘的距离计算，chart-tip 只负责位移与外观。
 */

export type ChartTipPlace = "top" | "top-left" | "top-right" | "left" | "right";

export interface ChartTipState {
  x: number;
  y: number;
  place: ChartTipPlace;
}

/** 由 hover 事件与容器 ref 计算顶部锚点：距左右缘不足 64px 时改用贴边落位防溢出。 */
export function anchorTop(event: MouseEvent, host: HTMLElement): ChartTipState {
  const box = host.getBoundingClientRect();
  const el = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const cx = el.left - box.left + el.width / 2;
  const place: ChartTipPlace = cx < 64 ? "top-left" : cx > box.width - 64 ? "top-right" : "top";
  return { x: cx, y: el.top - box.top, place };
}
