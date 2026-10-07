/**
 * 用量页 · 自然年热力图（GitHub 式：周为列、日为行、周一开头；未来日与无数据日
 * 同为空格——台账回填窗口外没数据的天就是空格，不冒充有量）。
 * 密度色阶：空档中性，有量走 --heat 暖橙单色相递进（密度语义专属通道）。
 * 格子 tabIndex+role=img 可聚焦，focus 与 hover 同出 ChartTip。
 * heatYearStats 供 usage-view 的 PageHead/hero 复用同一口径。
 */

import { useMemo, useRef, useState } from "react";

import ChartTip from "@/components/chart-tip";
import { anchorTop } from "@/lib/chart-tip";
import { dayStr, fmtTokens } from "@/lib/format";

import type { ChartTipState } from "@/lib/chart-tip";
import type { SyntheticEvent as ReactSyntheticEvent } from "react";
import type { UsageDailyRow } from "../../shared/rpc";

const dayMs = 86400_000;

const today = new Date();
today.setHours(0, 0, 0, 0);
const todayMs = today.getTime();
const todayKey = dayStr(todayMs);

export const HEAT_YEAR = today.getFullYear();
const YEAR_START_MS = Date.parse(`${HEAT_YEAR}-01-01T00:00:00`);
const YEAR_END_MS = Date.parse(`${HEAT_YEAR}-12-31T00:00:00`);
const YEAR_START_DAY = dayStr(YEAR_START_MS);
/** 年首列对齐周一：Jan 1 的星期偏移（周一=0），首列前置的上年尾日渲染为空占位。 */
const GRID_START_MS = YEAR_START_MS - ((new Date(YEAR_START_MS).getDay() + 6) % 7) * dayMs;
/** 默认拉取窗：365 天恒覆盖整个自然年（年初至多在 364 天前）。 */
export const FETCH_DAYS = 365;

/* 热力图密度色阶：空档保持中性，有量后走 --heat 暖橙单色相递进——
   密度语义专属通道（既非状态也非「谁」），单色纪律不破。 */
export const HEAT_LEVELS = [
  "color-mix(in oklab, var(--foreground) 6%, transparent)",
  "color-mix(in oklab, var(--heat) 22%, transparent)",
  "color-mix(in oklab, var(--heat) 45%, transparent)",
  "color-mix(in oklab, var(--heat) 70%, transparent)",
  "var(--heat)",
];

const WEEKDAY_MARKS = ["一", "", "三", "", "五", "", "日"];

interface HeatCell {
  day: string;
  tokens: number;
  color: string;
}

/** 年内日合计表（hero/PageHead 与热力图共用口径）。 */
function yearDayTotals(rows: UsageDailyRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.day < YEAR_START_DAY) continue;
    m.set(r.day, (m.get(r.day) ?? 0) + r.tokens);
  }
  return m;
}

/** hero 与 PageHead 的年度合计：今日 / 今年 / 活跃天数（固定语义，不吃区间）。 */
export function heatYearStats(rows: UsageDailyRow[]): { todayTokens: number; totalTokens: number; activeDays: number } {
  const totals = yearDayTotals(rows);
  return {
    todayTokens: totals.get(dayStr(todayMs)) ?? 0,
    totalTokens: [...totals.values()].reduce((s, v) => s + v, 0),
    activeDays: [...totals.values()].filter((v) => v > 0).length,
  };
}

export default function UsageHeatmap({ rows }: { rows: UsageDailyRow[] }) {
  const dayTotals = useMemo(() => yearDayTotals(rows), [rows]);

  const heatWeeks = useMemo(() => {
    const max = Math.max(...dayTotals.values(), 1);
    const weeks: { cells: (HeatCell | null)[]; monthLabel: string }[] = [];
    let prevMonth = -1;
    for (let w = 0; GRID_START_MS + w * 7 * dayMs <= YEAR_END_MS; w++) {
      const week: (HeatCell | null)[] = [];
      let month1st = -1;
      for (let d = 0; d < 7; d++) {
        const ms = GRID_START_MS + (w * 7 + d) * dayMs;
        if (ms < YEAR_START_MS || ms > YEAR_END_MS) {
          week.push(null);
          continue;
        }
        const day = dayStr(ms);
        const tokens = ms > todayMs ? 0 : (dayTotals.get(day) ?? 0);
        const lvl = tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4)));
        if (new Date(ms).getDate() === 1) month1st = new Date(ms).getMonth();
        week.push({ day, tokens, color: HEAT_LEVELS[lvl] });
      }
      /* 月份行：列含某月 1 日才标（GitHub 惯例，跨月列落在 1 日所在列），同年内不重复 */
      const monthLabel = month1st >= 0 && month1st !== prevMonth ? `${month1st + 1}月` : "";
      if (month1st >= 0) prevMonth = month1st;
      weeks.push({ cells: week, monthLabel });
    }
    return weeks;
  }, [dayTotals]);

  /* 热力图瞬时悬浮（替代原生 title）。 */
  const heatBox = useRef<HTMLDivElement | null>(null);
  const [heatTip, setHeatTip] = useState<ChartTipState | null>(null);
  const [heatCell, setHeatCell] = useState<HeatCell | null>(null);

  /* 焦点事件无坐标，anchorTop 只读 currentTarget 几何——focus 与 hover 共用同一锚点逻辑。 */
  function onHeatEnter(event: ReactSyntheticEvent<HTMLElement>, cell: HeatCell) {
    if (!heatBox.current) return;
    setHeatCell(cell);
    setHeatTip(anchorTop(event, heatBox.current));
  }

  return (
    <div ref={heatBox} className="relative">
      {/* 月份行：与周列对齐（左缩进 = 星期列宽 + 列距）；nowrap 溢出不裁——
          列宽 ~12px 装不下「10月」，右邻列的标签位恒为空 */}
      <div className="mb-1 flex gap-0.75 pl-3.75">
        {heatWeeks.map((week, wi) => (
          <span key={wi} className="min-w-0 flex-1 whitespace-nowrap font-data text-micro leading-none text-faint">
            {week.monthLabel}
          </span>
        ))}
      </div>
      <div className="flex gap-0.75">
        {/* 星期列：一三五日标在隔行，GitHub 惯例 */}
        <div className="flex w-3 shrink-0 flex-col gap-0.75">
          {WEEKDAY_MARKS.map((mark, i) => (
            <span
              key={i}
              className="flex h-2.75 items-center justify-center font-data text-micro leading-none text-faint"
            >
              {mark}
            </span>
          ))}
        </div>
        {heatWeeks.map((week, wi) => (
          <div key={wi} className="flex flex-1 flex-col gap-0.75">
            {week.cells.map((cell, di) => {
              if (!cell) return <span key={`pad-${di}`} aria-hidden className="h-2.75 w-full" />;
              const future = cell.day > todayKey;
              return (
                <span
                  key={cell.day}
                  role={future ? undefined : "img"}
                  aria-label={future ? undefined : `${cell.day} ${fmtTokens(cell.tokens)} 令牌`}
                  tabIndex={future ? -1 : 0}
                  className={`h-2.75 w-full rounded-xs transition-shadow duration-fast hover:ring-1 hover:ring-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40${
                    future ? "pointer-events-none" : ""
                  }`}
                  style={{ background: cell.color }}
                  onMouseEnter={(e) => onHeatEnter(e, cell)}
                  onMouseLeave={() => setHeatTip(null)}
                  onFocus={(e) => onHeatEnter(e, cell)}
                  onBlur={() => setHeatTip(null)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <ChartTip tip={heatTip}>
        {heatCell && (
          <p className="whitespace-nowrap text-meta">
            <span className="font-data tabular-nums text-faint">{heatCell.day}</span>
            <span className="mx-1.5 text-faint">·</span>
            <span className="font-data tabular-nums font-medium">{fmtTokens(heatCell.tokens)} 令牌</span>
          </p>
        )}
      </ChartTip>
    </div>
  );
}
