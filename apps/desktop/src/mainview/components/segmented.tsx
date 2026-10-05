/** 分段选择器：bg-surface-3 轨道 + 选中 bg-surface-1 + hairline 描边，与底栏 tabs 同视觉语言。
 *  键盘契约（radiogroup 惯例）：roving tabindex（选中项可 Tab，其余 -1），
 *  左右/上下方向键循环切换并选中，Home/End 跳首尾。 */

import { useRef } from "react";

import { cn } from "@/lib/utils";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** radiogroup 的可访问名（读屏依赖）；无则匿名分组。 */
  label?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const idx = options.findIndex((opt) => opt.value === value);
    const last = options.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = idx < 0 ? 0 : (idx + 1) % options.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = idx < 0 ? last : (idx - 1 + options.length) % options.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      className="flex max-w-full items-center gap-0.5 rounded-full bg-surface-3 p-0.5"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((opt, i) => (
        <button
          key={opt.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          tabIndex={opt.value === value ? 0 : -1}
          className={cn(
            "whitespace-nowrap rounded-full border px-2.5 py-0.5 text-meta font-medium transition-colors duration-fast",
            opt.value === value
              ? "border-hairline bg-surface-1 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
