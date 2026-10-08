/**
 * 页头（PageHead）：管理台各页的统一开场。外壳提供顶条 portal 目标时
 * title+actions 渲染进窗口工具栏（meta 留内容原位）；无目标时退化
 * legacy 内联 header（非管理台语境）。
 */

import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

import type { CSSProperties, ReactNode } from "react";

/** 外壳顶条的 portal 宿主：ManagerApp 提供，为 null 时 PageHead 走 legacy 内联形态。 */
export const PageHeadTargetContext = createContext<HTMLElement | null>(null);

/** 顶条 actions 不参与窗口拖拽（drag 区会吞掉点击）。 */
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** 页面标题区；actions 放右上（按钮组/筛选件）。 */
export default function PageHead({ title, meta, actions }: { title: string; meta?: string; actions?: ReactNode }) {
  const target = useContext(PageHeadTargetContext);

  if (target) {
    return (
      <>
        {createPortal(
          <div className="flex w-full min-w-0 items-center gap-3">
            <h1 className="min-w-0 truncate text-title font-semibold tracking-tight">{title}</h1>
            {actions && (
              <div className="ml-auto flex shrink-0 items-center gap-2" style={NO_DRAG_STYLE}>
                {actions}
              </div>
            )}
          </div>,
          target,
        )}
        {meta && <p className="pt-3 pb-5 text-meta text-muted-foreground">{meta}</p>}
      </>
    );
  }

  return (
    <header className="flex items-end justify-between gap-4 pb-6 tight:flex-col tight:items-start tight:gap-3 tight:pb-4">
      <div className="min-w-0">
        <h1 className="text-headline font-semibold tracking-tight">{title}</h1>
        {meta && <p className="mt-1.5 text-meta text-muted-foreground">{meta}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2 tight:self-stretch tight:justify-end">{actions}</div>
      )}
    </header>
  );
}
