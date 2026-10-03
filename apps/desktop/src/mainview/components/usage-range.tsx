/**
 * 用量区间选择器：预设 [近 7 天|近 30 天] + 自定义双日期（start≤end、≤92 天保护图表密度）。
 * 只出控件与区间几何——行过滤与超窗补拉由 usage-view 负责。
 * 日期输入走原生 type=date（真实窗口里的系统选择器），color-scheme 跟随主题。
 */

import { useState } from "react";

import Segmented from "@/components/segmented";
import { dayStr } from "@/lib/format";

export type UsageRange = { kind: "preset"; days: number } | { kind: "custom"; start: string; end: string };

const dayMs = 86400_000;
/** 自定义区间上限：日粒度图表在季度外失去可读性。 */
const MAX_CUSTOM_DAYS = 92;

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

export default function UsageRangePicker({
  value,
  onChange,
}: {
  value: UsageRange;
  onChange: (r: UsageRange) => void;
}) {
  const today = dayStr(Date.now());
  const [start, setStart] = useState(value.kind === "custom" ? value.start : "");
  const [end, setEnd] = useState(value.kind === "custom" ? value.end : today);

  const spanDays = start && end ? Math.round((Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / dayMs) + 1 : 0;
  const valid = Boolean(start && end && start <= end && end <= today && spanDays <= MAX_CUSTOM_DAYS);

  function pick(seg: string) {
    if (seg === "custom") {
      // 切到自定义：输入不合法就回落近 7 天作初值，不把无效区间 commit 出去。
      const s = valid ? start : dayStr(Date.now() - 6 * dayMs);
      const e = valid ? end : today;
      setStart(s);
      setEnd(e);
      onChange({ kind: "custom", start: s, end: e });
    } else {
      onChange({ kind: "preset", days: Number(seg) });
    }
  }

  function commit(s: string, e: string) {
    setStart(s);
    setEnd(e);
    // 与 valid 同规：start≤end≤today 且 ≤92d 才放行（手动键入也能越界，不止靠 max 属性）。
    if (s && e && s <= e && e <= today && Math.round((Date.parse(`${e}T00:00:00`) - Date.parse(`${s}T00:00:00`)) / dayMs) + 1 <= MAX_CUSTOM_DAYS) {
      onChange({ kind: "custom", start: s, end: e });
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
      {value.kind === "custom" && (
        <span className="flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
          <input
            type="date"
            value={start}
            max={end || today}
            onChange={(e) => commit(e.target.value, end)}
            aria-label="起始日"
            className="h-6 rounded border border-hairline bg-raised px-1.5 text-micro text-foreground"
          />
          <span className="text-faint">–</span>
          <input
            type="date"
            value={end}
            min={start || undefined}
            max={today}
            onChange={(e) => commit(start, e.target.value)}
            aria-label="结束日"
            className="h-6 rounded border border-hairline bg-raised px-1.5 text-micro text-foreground"
          />
          {!valid && <span className="text-stale">区间无效（≤92 天）</span>}
        </span>
      )}
    </div>
  );
}
