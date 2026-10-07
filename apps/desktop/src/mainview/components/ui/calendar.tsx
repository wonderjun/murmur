/**
 * shadcn Calendar 的 murmur 版（react-day-picker 底层）：单月网格 + range 选中态。
 * chrome 全单色纪律——选中端点=前景反相实心、range 中段=前景 10% 底、today=raised+加重，
 * 不读 --accent；日期数字 mono tabular。--cell-size/--cell-radius 自给（shadcn 靠样式表
 * 注入，本库无样式表依赖，直接钉在 Root 上）。
 * CUSTOMIZED: 全量 token 化改写 + 默认 zhCN locale + 网格尺寸收紧（size-7/detail 档），
 * 细节见 ../CUSTOMIZATIONS.md。
 */

import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";

import { cn } from "@/lib/utils";

import type { DayButton, Locale } from "react-day-picker";
import type { ComponentProps } from "react";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  locale = zhCN,
  formatters,
  components,
  ...props
}: ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      locale={locale}
      className={cn("p-2 [--cell-radius:0.375rem] [--cell-size:1.75rem]", className)}
      formatters={{
        formatMonthDropdown: (date) => date.toLocaleString(locale?.code, { month: "short" }),
        ...formatters,
      }}
      classNames={{
        /* CUSTOMIZED: hover 统一走 surface-2 叠层（raised 别名已退场） */
        root: cn("[--cell-size:1.75rem] [--cell-radius:0.375rem]", defaultClassNames.root),
        months: cn("relative flex flex-col", defaultClassNames.months),
        month: cn("flex w-full flex-col", defaultClassNames.month),
        nav: cn("absolute inset-x-0 top-0 flex w-full items-center justify-between", defaultClassNames.nav),
        button_previous: cn(
          "size-(--cell-size) select-none rounded-md p-0 text-faint outline-none hover:bg-surface-2 hover:text-foreground aria-disabled:opacity-50",
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          "size-(--cell-size) select-none rounded-md p-0 text-faint outline-none hover:bg-surface-2 hover:text-foreground aria-disabled:opacity-50",
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
          defaultClassNames.month_caption,
        ),
        dropdowns: cn("flex h-(--cell-size) w-full items-center justify-center gap-1.5", defaultClassNames.dropdowns),
        dropdown_root: cn("relative rounded-(--cell-radius)", defaultClassNames.dropdown_root),
        dropdown: cn("absolute inset-0 opacity-0", defaultClassNames.dropdown),
        caption_label: cn("select-none text-detail font-semibold text-foreground", defaultClassNames.caption_label),
        month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
        weekdays: cn("flex", defaultClassNames.weekdays),
        weekday: cn(
          "flex-1 select-none rounded-(--cell-radius) font-normal text-micro text-faint",
          defaultClassNames.weekday,
        ),
        week: cn("mt-px flex w-full", defaultClassNames.week),
        week_number_header: cn("w-(--cell-size) select-none", defaultClassNames.week_number_header),
        week_number: cn("select-none text-micro text-faint", defaultClassNames.week_number),
        day: cn(
          "group/day relative aspect-square size-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)",
          props.showWeekNumber
            ? "[&:nth-child(2)[data-selected=true]_button]:rounded-l-(--cell-radius)"
            : "[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)",
          defaultClassNames.day,
        ),
        /* range 轨道：端点格向邻格延伸 4px 补缝（after 伪元素），底色走前景 10%——单色 chrome */
        range_start: cn(
          "relative isolate z-0 rounded-l-(--cell-radius) bg-foreground/10 after:absolute after:inset-y-0 after:right-0 after:w-1 after:bg-foreground/10",
          defaultClassNames.range_start,
        ),
        range_middle: cn("rounded-none", defaultClassNames.range_middle),
        range_end: cn(
          "relative isolate z-0 rounded-r-(--cell-radius) bg-foreground/10 after:absolute after:inset-y-0 after:left-0 after:w-1 after:bg-foreground/10",
          defaultClassNames.range_end,
        ),
        today: cn("rounded-(--cell-radius) text-foreground", defaultClassNames.today),
        outside: cn("text-faint aria-selected:text-faint", defaultClassNames.outside),
        disabled: cn("text-faint opacity-40", defaultClassNames.disabled),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        /* 形参吃 DayPicker components 槽位的语境类型，不再手写注解 */
        Root: ({ className, rootRef, ...props }) => (
          <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />
        ),
        Chevron: ({ className, orientation, ...props }) => {
          const Icon = orientation === "left" ? ChevronLeft : orientation === "right" ? ChevronRight : ChevronDown;
          return <Icon size={12} className={cn("text-faint", className)} {...props} />;
        },
        DayButton: (dayProps) => <CalendarDayButton {...dayProps} />,
        ...components,
      }}
      {...props}
    />
  );
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  locale,
  ...props
}: ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <button
      data-day={day.date.toLocaleDateString(locale?.code)}
      data-selected-single={Boolean(
        modifiers.selected && !modifiers.range_start && !modifiers.range_end && !modifiers.range_middle,
      )}
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "relative isolate z-10 flex aspect-square w-full min-w-(--cell-size) select-none flex-col items-center justify-center gap-1 rounded-(--cell-radius) font-mono text-detail tabular-nums leading-none text-muted-foreground outline-none transition-colors duration-fast",
        "hover:bg-surface-2 hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-foreground/40",
        "data-[selected-single=true]:bg-foreground data-[selected-single=true]:text-background data-[selected-single=true]:hover:bg-foreground",
        "data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:bg-foreground data-[range-start=true]:text-background",
        "data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:bg-foreground data-[range-end=true]:text-background",
        "data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-foreground/10 data-[range-middle=true]:text-foreground",
        "data-[today=true]:font-semibold data-[today=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:text-faint data-[disabled=true]:opacity-40",
        defaultClassNames.day,
        className,
      )}
      {...props}
    />
  );
}

export { Calendar, CalendarDayButton };
