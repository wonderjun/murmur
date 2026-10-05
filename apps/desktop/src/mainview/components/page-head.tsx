/** 页头（PageHead）：管理台各页的统一开场——headline 档标题 + meta 副句 + 右侧动作槽。 */

import type { ReactNode } from "react";

/** 页面标题区；actions 放右上（按钮组/筛选件）。 */
export default function PageHead({ title, meta, actions }: { title: string; meta?: string; actions?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-4 pb-6 tight:flex-col tight:items-start tight:gap-3 tight:pb-4">
      <div className="min-w-0">
        <h1 className="text-headline font-semibold tracking-tight">{title}</h1>
        {meta && <p className="mt-1.5 text-meta text-muted-foreground">{meta}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 tight:self-stretch tight:justify-end">{actions}</div>}
    </header>
  );
}
