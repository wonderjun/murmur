/** 分组列表（GroupList/GroupRow）：管理台内容的基本单元——surface-1 叠层壳
 *  + hairline 分隔行。行可带 leading 图标槽 / control 控件槽 / desc 副句；
 *  onClick 行整行可点（hover surface-2），末尾 chevron 随 expanded 旋转，
 *  expanded 时同组下方渲染展开块（Fragment 并列入 divide-y，不另包 div）。
 *  可点行体用 div role="button" 而非 <button>：control 槽允许内嵌 Switch 等
 *  真实控件，HTML 禁交互元素套交互元素；控件点击/按键不外泄到整行 onClick。
 */

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import type { KeyboardEvent, ReactNode } from "react";

/** 分组容器：可选标题（+desc）下挂叠层列表。 */
export function GroupList({
  title,
  desc,
  children,
  className,
}: {
  title?: string;
  desc?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {title && <h2 className="mb-2 px-1 text-meta font-semibold text-muted-foreground">{title}</h2>}
      {desc && <p className="mb-2 mt-[-6px] px-1 text-micro text-faint">{desc}</p>}
      <div className="divide-y divide-hairline/60 overflow-hidden rounded-item bg-surface-1">{children}</div>
    </section>
  );
}

/** 分组行：label/desc 文字块（min-w-0 flex-1）+ leading/control 槽；onClick+children 即手风琴。 */
export function GroupRow({
  label,
  desc,
  leading,
  control,
  onClick,
  expanded,
  children,
}: {
  label: ReactNode;
  desc?: ReactNode;
  leading?: ReactNode;
  control?: ReactNode;
  onClick?: () => void;
  expanded?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-body">{label}</span>
        {desc && <span className="mt-0.5 block text-meta text-muted-foreground">{desc}</span>}
      </span>
      {control && (
        // 控件槽内是真实控件（Switch/Button 等），点击不外泄到整行 onClick
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          {control}
        </span>
      )}
      {onClick && children != null && (
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-faint transition-transform duration-normal", expanded && "rotate-180")}
        />
      )}
    </>
  );
  const rowCls = "flex min-h-12 w-full items-center gap-3 px-4 py-2.5";

  // 行体键盘激活：只认落在行自身的 Space/Enter——内嵌控件（Switch 等）的按键不抢。
  function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onClick?.();
    }
  }

  return (
    <>
      {onClick ? (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={children != null ? expanded : undefined}
          className={cn(
            rowCls,
            "cursor-pointer text-left transition-colors duration-fast hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/45",
          )}
          onClick={onClick}
          onKeyDown={onRowKeyDown}
        >
          {body}
        </div>
      ) : (
        <div className={rowCls}>{body}</div>
      )}
      {/* 展开块：与行同级入 divide 组，有 leading 时 pl 对齐文字列 */}
      {expanded && children != null && (
        <div className={cn("bg-surface-2/40 px-4 py-3", leading ? "pl-[52px]" : undefined)}>{children}</div>
      )}
    </>
  );
}
