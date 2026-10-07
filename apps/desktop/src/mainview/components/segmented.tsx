/** 分段选择器：bg-surface-3 轨道 + 选中 bg-surface-1 + hairline 描边，与底栏 tabs 同视觉语言。
 *  选项宽过轨道时轨内横滚（scrollbar-none），可滚方向的边缘 20px 渐隐作「还有内容」
 *  提示——无溢出时 mask 为空，与不可滚版视觉完全一致。
 *  键盘契约（radiogroup 惯例）：roving tabindex（选中项可 Tab，其余 -1），
 *  左右/上下方向键循环切换并选中，Home/End 跳首尾。 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** 可滚缘渐隐蒙版：bit0=左缘还有料，bit1=右缘还有料；0=不溢出不施 mask。 */
function edgeMask(fade: number): string | undefined {
  if (!fade) return undefined;
  return `linear-gradient(to right, ${fade & 1 ? "transparent, black 20px, " : ""}black ${
    fade & 2 ? "calc(100% - 20px), transparent" : "100%"
  })`;
}

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
  const trackRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(0);

  /* 1px 容差防小数 scrollLeft 抖动；同值 setState React 短路不重渲，滚动里连发安全。 */
  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setFade((el.scrollLeft > 1 ? 1 : 0) | (el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 2 : 0));
  }, []);

  /* scroll 管位置、ResizeObserver 管轨道尺寸（窗宽/父级收窄）。 */
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);

  /* 每渲染复核一次：选项增减未必改变轨道尺寸（已封顶 max-w-full 时 RO 不触发）。 */
  useLayoutEffect(measure);

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
    // focus() 自动 scrollIntoView——视野外选项随键盘导航滚入。
    refs.current[next]?.focus();
  }

  const mask = edgeMask(fade);

  return (
    <div
      ref={trackRef}
      className="scrollbar-none flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-surface-3 p-0.5"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
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
            "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-meta font-medium transition-colors duration-fast",
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
