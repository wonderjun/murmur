/**
 * 用量区间选择器：预设 [近 7 天|近 30 天] + 自定义（触发按钮 + Popover 日历 mode=range）。
 * 起止约束由日历保证——未来日恒禁选、起点选定后超 1 个月的日期禁选（excludeDisabled
 * 防跨禁选日成段），不再有「无效区间」态；rangeBounds/rangeDayList/rangeLabel 供 usage-view。
 * 区间上限 = 最长自然月 31 天：日粒度图表在月外失去可读性。
 */

import { CalendarRange } from "lucide-react";
import { addDays } from "date-fns";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Segmented from "@/components/segmented";
import { dayStr } from "@/lib/format";

import type { DateRange, Matcher } from "react-day-picker";

export type UsageRange = { kind: "preset"; days: number } | { kind: "custom"; start: string; end: string };

const dayMs = 86400_000;
/** 自定义区间上限：一个月取最长自然月 31 天，日粒度图表在月外失去可读性。 */
const MAX_CUSTOM_DAYS = 31;

/** 区间 → [起始日, 结束日]（YYYY-MM-DD，字典序即时间序）。 */
export function rangeBounds(r: UsageRange): { startDay: string; endDay: string } {
  if (r.kind === "custom") return { startDay: r.start, endDay: r.end };
  return { startDay: dayStr(Date.now() - (r.days - 1) * dayMs), endDay: dayStr(Date.now()) };
}

/** 区间覆盖的日序（图表横轴；老→新）。 */
export function rangeDayList(r: UsageRange): string[] {
  const { startDay, endDay } = rangeBounds(r);
  const out: string[] = [];
  const d = new Date(`${startDay}T00:00:00`);
  const endMs = Date.parse(`${endDay}T00:00:00`);
  // setDate 步进过 DST 安全（ms 加法会被 23/25h 日坑）。
  while (d.getTime() <= endMs && out.length < MAX_CUSTOM_DAYS) {
    out.push(dayStr(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 区间展示标签（栏目标题用）。 */
export function rangeLabel(r: UsageRange): string {
  if (r.kind === "preset") return `近 ${r.days} 天`;
  return `${r.start.slice(5).replace("-", "/")} – ${r.end.slice(5).replace("-", "/")}`;
}

/** Date → YYYY-MM-DD（本地时区；日历几何与 rangeBounds 同规）。 */
function dayStrOf(date: Date): string {
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export default function UsageRangePicker({
  value,
  onChange,
}: {
  value: UsageRange;
  onChange: (r: UsageRange) => void;
}) {
  const today = dayStr(Date.now());
  const [open, setOpen] = useState(false);
  /* 日历草稿：起点已选、终点未定的中间态；完成即 commit 并收起。 */
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const custom = value.kind === "custom" ? value : null;

  /* 打开时草稿同步当前区间：无历史自定义给近 7 天作初值（与切自定义的回落一致）。 */
  useEffect(() => {
    if (!open) return;
    setDraft(
      custom
        ? { from: new Date(`${custom.start}T00:00:00`), to: new Date(`${custom.end}T00:00:00`) }
        : { from: new Date(Date.now() - 6 * dayMs), to: new Date() },
    );
    // custom 在打开瞬间取值即可，不追变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* 禁选面：未来日恒禁；起点已定后，超出起点 +30 天的日子禁选（月上限）。 */
  const disabled = useMemo<Matcher[]>(() => {
    const matchers: Matcher[] = [{ after: new Date() }];
    if (draft?.from) matchers.push({ after: addDays(draft.from, MAX_CUSTOM_DAYS - 1) });
    return matchers;
  }, [draft]);

  /* 浏览起点限近 13 个月：再老的台账翻页无意义，防 nav 无界回溯。 */
  const startMonth = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 12, 1);
    return d;
  }, []);

  function handleSelect(range: DateRange | undefined, triggerDate: Date) {
    if (range?.from && range?.to) {
      const start = dayStrOf(range.from);
      const end = dayStrOf(range.to);
      const span = Math.round((Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / dayMs) + 1;
      // RDP 会把早于起点的点击并进既有区间（保旧终点），可产出 >1 个月的非法段——
      // 此时把本次点击改作新起点重新草拟，日历上不出现非法选区。
      if (span > MAX_CUSTOM_DAYS) {
        setDraft({ from: triggerDate, to: undefined });
        return;
      }
      // 日历禁选面已保证 start≤end≤today；此处同规兜底（程序化路径防越界）。
      if (start <= end && end <= today) {
        onChange({ kind: "custom", start, end });
        setOpen(false);
        return;
      }
    }
    setDraft(range);
  }

  function pick(seg: string) {
    if (seg === "custom") {
      // 切到自定义：无历史区间先 commit 近 7 天作初值，并直接展开日历。
      if (!custom) onChange({ kind: "custom", start: dayStr(Date.now() - 6 * dayMs), end: today });
      setOpen(true);
    } else {
      setOpen(false);
      onChange({ kind: "preset", days: Number(seg) });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        options={[
          { value: "7", label: "近 7 天" },
          { value: "30", label: "近 30 天" },
          { value: "custom", label: "自定义" },
        ]}
        value={value.kind === "preset" ? String(value.days) : "custom"}
        onChange={pick}
        label="用量区间"
      />
      {custom && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="default" aria-label="自定义日期区间" className="gap-1.5">
              <CalendarRange />
              <span className="font-mono tabular-nums">{rangeLabel(value)}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-1" align="start">
            <Calendar
              mode="range"
              selected={draft}
              onSelect={handleSelect}
              disabled={disabled}
              excludeDisabled
              startMonth={startMonth}
              numberOfMonths={1}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
