/**
 * 用量视图：display hero（今日令牌数字当家）→ 01 热力图（foreground 单色阶，
 * GitHub 式）→ 02 近 7 天按 agent 堆积柱 + 明细图例 → 03 近 7 天按模型折线。
 * 彩色纪律：热力图走中性色阶；agent 色只出现在「谁」语义的柱段与图例点。
 * 键盘/读屏：热力图格子与柱段 tabIndex+role=img 可聚焦，focus 与 hover 同出 ChartTip；
 * 折线的文本明细由 model-line-chart 内置 sr-only 兜底。
 * 卡片语法：三个图表区块是 flat 地面栏目（编号头 + 上 hairline），不占卡片壳——
 * 卡片只留给「可交互实体」（动态页会话组、工具页 agent 行）。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import AnimatedNumber from "@/components/animated-number";
import ChartTip from "@/components/chart-tip";
import ModelLineChart from "@/components/model-line-chart";
import Murmuration from "@/components/murmuration";
import UsageRangePicker, { rangeBounds, rangeDayList, rangeLabel } from "@/components/usage-range";
import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { anchorTop } from "@/lib/chart-tip";
import { dayStr, fmtTokens } from "@/lib/format";
import { useMurmurStore } from "@/store/murmur";

import type { ChartTipState } from "@/lib/chart-tip";
import type { UsageRange } from "@/components/usage-range";
import type { SyntheticEvent as ReactSyntheticEvent } from "react";
import type { UsageDailyRow } from "../../shared/rpc";

const HEAT_DAYS = 70;
const dayMs = 86400_000;

const today = new Date();
today.setHours(0, 0, 0, 0);
const todayMs = today.getTime();
const mondayOffset = (today.getDay() + 6) % 7; // 周一=0
const heatStart = todayMs - mondayOffset * dayMs - (Math.ceil(HEAT_DAYS / 7) - 1) * 7 * dayMs;

/* 热力图密度色阶：空档保持中性，有量后走 --heat 暖橙单色相递进——
   密度语义专属通道（既非状态也非「谁」），单色纪律不破。 */
const HEAT_LEVELS = [
  "color-mix(in oklab, var(--foreground) 6%, transparent)",
  "color-mix(in oklab, var(--heat) 22%, transparent)",
  "color-mix(in oklab, var(--heat) 45%, transparent)",
  "color-mix(in oklab, var(--heat) 70%, transparent)",
  "var(--heat)",
];

const WEEKDAY_MARKS = ["一", "", "三", "", "五", "", "日"];

const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

/* 折线系列 dash 双编码：灰阶只拉明度，细线交叉处靠线型兜底区分；
   rank0 略粗做头部层级，「其他」通常落 rank6 最虚。 */
const MODEL_LINE_STYLES: { dash?: string; width: number }[] = [
  { width: 1.75 },
  { width: 1.5 },
  { dash: "6 3", width: 1.5 },
  { dash: "2.5 2.5", width: 1.5 },
  { dash: "8 3 2.5 3", width: 1.5 },
  { dash: "1 2", width: 1.5 },
  { dash: "10 4", width: 1.5 },
];

const AGENT_COLORS: Record<string, string> = {
  kimi: "var(--agent-kimi)",
  zcode: "var(--agent-zcode)",
  opencode: "var(--agent-opencode)",
  codex: "var(--agent-codex)",
  cursor: "var(--agent-cursor)",
  devin: "var(--agent-devin)",
  qoder: "var(--agent-qoder)",
};
const agentColor = (a: string) => AGENT_COLORS[a] ?? "var(--faint)";

interface HeatCell {
  day: string;
  tokens: number;
  color: string;
}

interface BarSegment {
  agent: string;
  tokens: number;
  h: number;
}

export default function UsageView() {
  const usageDaily = useMurmurStore((s) => s.usageDaily);
  const [rows, setRows] = useState<UsageDailyRow[]>([]);
  // 三态：loading（首次拉取，骨架与图表区同高）/ error（读取失败 + 重试）/ ready（含空态）。
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    usageDaily({ days: HEAT_DAYS })
      .then((data) => {
        if (!alive) return;
        setRows(data);
        setStatus("ready");
      })
      .catch(() => {
        // RPC 未就绪/失败：显式错误态，不再让空态冒充「无数据」。
        if (alive) setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [usageDaily, attempt]);

  const hasData = rows.some((r) => r.tokens > 0);
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);

  /* ── 热力图：weeks × 7 rows，右端对齐今天 ── */
  const dayTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.day, (m.get(r.day) ?? 0) + r.tokens);
    return m;
  }, [rows]);

  const heatWeeks = useMemo(() => {
    const max = Math.max(...dayTotals.values(), 1);
    const weeks: { cells: HeatCell[]; monthLabel: string }[] = [];
    let prevMonth = -1;
    for (let w = 0; w * 7 * dayMs + heatStart <= todayMs; w++) {
      const week: HeatCell[] = [];
      for (let d = 0; d < 7; d++) {
        const ms = heatStart + (w * 7 + d) * dayMs;
        const day = dayStr(ms);
        const tokens = ms > todayMs ? 0 : (dayTotals.get(day) ?? 0);
        const lvl = tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4)));
        week.push({ day, tokens, color: HEAT_LEVELS[lvl] });
      }
      /* 月份行：该周首日落进新月份才标，同一月内不重复 */
      const month = new Date(heatStart + w * 7 * dayMs).getMonth();
      const monthLabel = month !== prevMonth ? `${month + 1}月` : "";
      prevMonth = month;
      weeks.push({ cells: week, monthLabel });
    }
    return weeks;
  }, [dayTotals]);

  /* ── 热力图瞬时悬浮（替代原生 title）── */
  const heatBox = useRef<HTMLDivElement | null>(null);
  const [heatTip, setHeatTip] = useState<ChartTipState | null>(null);
  const [heatCell, setHeatCell] = useState<HeatCell | null>(null);

  /* 焦点事件无坐标，anchorTop 只读 currentTarget 几何——focus 与 hover 共用同一锚点逻辑。 */
  function onHeatEnter(event: ReactSyntheticEvent<HTMLElement>, cell: HeatCell) {
    if (!heatBox.current) return;
    setHeatCell(cell);
    setHeatTip(anchorTop(event, heatBox.current));
  }

  /* ── 区间状态：默认近 7 天（初始化呈现与现状一致），02/03 图表随区间 ── */
  const [range, setRange] = useState<UsageRange>({ kind: "preset", days: 7 });
  const [extRows, setExtRows] = useState<UsageDailyRow[] | null>(null);
  const { startDay, endDay } = rangeBounds(range);

  // 自定义起点落在 70d 默认拉取窗之前才补拉；其余区间 client-side 过滤 rows。
  useEffect(() => {
    if (startDay >= dayStr(todayMs - (HEAT_DAYS - 1) * dayMs)) {
      setExtRows(null);
      return;
    }
    let alive = true;
    usageDaily({ since: Date.parse(`${startDay}T00:00:00`) })
      .then((rs) => {
        if (alive) setExtRows(rs);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [startDay, usageDaily]);

  const rangeRows = useMemo(
    () => (extRows ?? rows).filter((r) => r.day >= startDay && r.day <= endDay),
    [extRows, rows, startDay, endDay],
  );

  /* ── 区间按 agent 堆积柱（默认近 7 天）── */
  const chartDays = useMemo(() => {
    const byAgent = new Map<string, Map<string, number>>();
    for (const r of rangeRows) {
      if (!byAgent.has(r.day)) byAgent.set(r.day, new Map());
      const m = byAgent.get(r.day)!;
      m.set(r.agent, (m.get(r.agent) ?? 0) + r.tokens);
    }
    const days: { day: string; label: string; segments: BarSegment[] }[] = [];
    let maxTotal = 1;
    const totals: number[] = [];
    for (const day of rangeDayList(range)) {
      const m = byAgent.get(day);
      const total = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
      totals.push(total);
      maxTotal = Math.max(maxTotal, total);
      days.push({ day, label: day === dayStr(todayMs) ? "今天" : day.slice(5), segments: [] });
    }
    days.forEach((d, i) => {
      const m = byAgent.get(d.day);
      if (!m) return;
      const hScale = totals[i] > 0 ? Math.max(6, (totals[i] / maxTotal) * 60) : 0;
      d.segments = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([agent, tokens]) => ({ agent, tokens, h: Math.max(2, (tokens / totals[i]) * hScale) }));
    });
    return days;
  }, [rangeRows, range]);

  const rangeTokens = chartDays.reduce((s, d) => s + d.segments.reduce((a, b) => a + b.tokens, 0), 0);

  /* hero「近 7 日」是固定语义，不吃区间筛选——独立从全窗 rows 算。 */
  const week7Tokens = useMemo(
    () => rows.filter((r) => r.day >= dayStr(todayMs - 6 * dayMs)).reduce((s, r) => s + r.tokens, 0),
    [rows],
  );

  /* 图例明细：区间内各 agent 合计与占比。 */
  const agentLegend = useMemo(() => {
    const byAgent = new Map<string, number>();
    for (const d of chartDays) for (const seg of d.segments) byAgent.set(seg.agent, (byAgent.get(seg.agent) ?? 0) + seg.tokens);
    return [...byAgent.entries()]
      .map(([agent, tokens]) => ({ agent, tokens, pct: rangeTokens ? Math.round((tokens / rangeTokens) * 100) : 0 }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [chartDays, rangeTokens]);

  /* ── 概览条：今日 / 近 7 日 / 近 10 周 / 活跃天数（固定语义，不吃区间）── */
  const overview = useMemo(() => {
    const todayTokens = dayTotals.get(dayStr(todayMs)) ?? 0;
    const activeDays = [...dayTotals.values()].filter((v) => v > 0).length;
    return { todayTokens, weekTokens: week7Tokens, totalTokens, activeDays };
  }, [dayTotals, week7Tokens, totalTokens]);

  /* ── 堆积柱瞬时悬浮 ── */
  const barBox = useRef<HTMLDivElement | null>(null);
  const [barTip, setBarTip] = useState<ChartTipState | null>(null);
  const [barSeg, setBarSeg] = useState<BarSegment | null>(null);

  function onBarEnter(event: ReactSyntheticEvent<HTMLElement>, seg: BarSegment) {
    if (!barBox.current) return;
    setBarSeg(seg);
    setBarTip(anchorTop(event, barBox.current));
  }

  /* ── 区间按模型折线（top6 + 其他），数据整形后交给 ModelLineChart ── */
  const lineDays = useMemo(() => chartDays.map((d) => ({ day: d.day, label: d.label })), [chartDays]);

  const lineSeries = useMemo(() => {
    const dayKeys = lineDays.map((d) => d.day);
    /* 模型名大小写不敏感归并（glm-5.3-flash / GLM-5.3-Flash 是同一模型）：
       key 取小写，展示名取组内累计量最大的原始变体。 */
    const byModel = new Map<string, { variants: Map<string, number>; days: Map<string, number> }>();
    for (const r of rangeRows) {
      if (!dayKeys.includes(r.day)) continue;
      const raw = (r.model ?? "unknown").split("/").pop()!;
      const key = raw.toLowerCase();
      let g = byModel.get(key);
      if (!g) {
        g = { variants: new Map(), days: new Map() };
        byModel.set(key, g);
      }
      g.variants.set(raw, (g.variants.get(raw) ?? 0) + r.tokens);
      g.days.set(r.day, (g.days.get(r.day) ?? 0) + r.tokens);
    }
    // top6 + 其他
    const ranked = [...byModel.values()]
      .map((g) => ({
        name: [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0],
        m: g.days,
        total: [...g.days.values()].reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, 6);
    const rest = ranked.slice(6);
    if (rest.length) {
      const merged = new Map<string, number>();
      for (const r of rest) for (const [d, v] of r.m) merged.set(d, (merged.get(d) ?? 0) + v);
      top.push({ name: "其他", m: merged, total: rest.reduce((s, r) => s + r.total, 0) });
    }
    return top.map((t, i) => ({
      name: t.name,
      total: t.total,
      color: MODEL_COLORS[i % MODEL_COLORS.length],
      ...MODEL_LINE_STYLES[i % MODEL_LINE_STYLES.length],
      values: dayKeys.map((d) => t.m.get(d) ?? 0),
    }));
  }, [rangeRows, lineDays]);

  /* 入场序位：渲染顺序即 stagger 顺序 */
  let slot = 0;
  const enterDelay = () => `${slot++ * 40}ms`;

  return (
    <div className="flex flex-col gap-4">
      {status === "error" ? (
        <div className="px-4 py-14 text-center" role="alert">
          <p className="text-body font-medium">用量读取失败</p>
          <p className="mt-1.5 text-meta text-muted-foreground">本地台账暂时读不出来，稍候可重试。</p>
          <Button size="sm" className="mt-4" onClick={() => setAttempt((a) => a + 1)}>
            重试
          </Button>
        </div>
      ) : status === "loading" ? (
        <div className="space-y-3" aria-live="polite" aria-busy="true">
          {/* 骨架与图表区同高：概览 hero + 热力图 + 柱/线两段 */}
          <div className="h-16 animate-pulse rounded-item bg-raised" />
          <div className="h-40 animate-pulse rounded-item bg-raised" />
          <div className="h-28 animate-pulse rounded-item bg-raised" />
        </div>
      ) : hasData ? (
        <>
          {/* ── 概览 hero：今日令牌数字当家（display 档），右列次级尺度陪跑。
              上边线由玻璃刊头的底边线兼任，只保留下规线 ── */}
          <section
            className="animate-enter flex items-end justify-between border-b border-hairline py-3"
            style={{ animationDelay: enterDelay() }}
          >
            <div>
              <p className="eyebrow text-faint">今日令牌</p>
              <p className="mt-1 font-mono text-display font-semibold tabular-nums leading-none">
                <AnimatedNumber value={fmtTokens(overview.todayTokens)} />
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 text-meta text-muted-foreground">
              <span>
                近 7 日
                <span className="ml-1.5 font-mono tabular-nums font-medium text-foreground">
                  {fmtTokens(overview.weekTokens)}
                </span>
              </span>
              <span>
                近 10 周
                <span className="ml-1.5 font-mono tabular-nums font-medium text-foreground">
                  {fmtTokens(overview.totalTokens)}
                </span>
              </span>
              <span className="font-mono text-micro tabular-nums text-faint">{overview.activeDays} 天活跃</span>
            </div>
          </section>

          {/* ── 近 10 周热力图（周为列，日为行，GitHub 式；foreground 单色阶）── */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: enterDelay() }}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-micro text-faint">01</span>
                <span className="text-detail font-semibold">近 10 周</span>
              </span>
              <span className="flex items-center gap-1 font-mono text-micro text-faint">
                少
                {HEAT_LEVELS.map((c) => (
                  <span key={c} className="h-[7px] w-[7px] rounded-[2px]" style={{ background: c }} />
                ))}
                多
              </span>
            </div>
            <div ref={heatBox} className="relative">
              {/* 月份行：与周列对齐（左缩进 = 星期列宽 + 列距） */}
              <div className="mb-1 flex gap-[3px] pl-[15px]">
                {heatWeeks.map((week, wi) => (
                  <span key={wi} className="flex-1 truncate font-mono text-micro leading-none text-faint">
                    {week.monthLabel}
                  </span>
                ))}
              </div>
              <div className="flex gap-[3px]">
                {/* 星期列：一三五日标在隔行，GitHub 惯例 */}
                <div className="flex w-3 shrink-0 flex-col gap-[3px]">
                  {WEEKDAY_MARKS.map((mark, i) => (
                    <span
                      key={i}
                      className="flex h-[11px] items-center justify-center font-mono text-micro leading-none text-faint"
                    >
                      {mark}
                    </span>
                  ))}
                </div>
                {heatWeeks.map((week, wi) => (
                  <div key={wi} className="flex flex-1 flex-col gap-[3px]">
                    {week.cells.map((cell) => (
                      <span
                        key={cell.day}
                        role="img"
                        aria-label={`${cell.day} ${fmtTokens(cell.tokens)} 令牌`}
                        tabIndex={0}
                        className="h-[11px] w-full rounded-[2.5px] transition-shadow duration-fast hover:ring-1 hover:ring-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
                        style={{ background: cell.color }}
                        onMouseEnter={(e) => onHeatEnter(e, cell)}
                        onMouseLeave={() => setHeatTip(null)}
                        onFocus={(e) => onHeatEnter(e, cell)}
                        onBlur={() => setHeatTip(null)}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <ChartTip tip={heatTip}>
                {heatCell && (
                  <p className="whitespace-nowrap text-meta">
                    <span className="font-mono tabular-nums text-faint">{heatCell.day}</span>
                    <span className="mx-1.5 text-faint">·</span>
                    <span className="font-mono tabular-nums font-medium">{fmtTokens(heatCell.tokens)} 令牌</span>
                  </p>
                )}
              </ChartTip>
            </div>
          </section>

          {/* ── 区间选择器：只影响 02/03 图表；hero 与热力图是固定语义 ── */}
          <div className="animate-enter" style={{ animationDelay: enterDelay() }}>
            <UsageRangePicker value={range} onChange={setRange} />
          </div>

          {/* ── 区间堆积柱（按 agent 分色）+ 明细图例 ── */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: enterDelay() }}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-micro text-faint">02</span>
                <span className="text-detail font-semibold">{rangeLabel(range)} · 按工具</span>
              </span>
              <span className="font-mono text-micro tabular-nums text-faint">{fmtTokens(rangeTokens)} 令牌</span>
            </div>
            <div ref={barBox} className="relative">
              <div className="flex h-[84px] items-end gap-2">
                {chartDays.map((d) => (
                  <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex w-full flex-col-reverse gap-px" style={{ height: "64px" }}>
                      {d.segments.map((seg) => (
                        <div
                          key={seg.agent}
                          role="img"
                          aria-label={`${segName(seg.agent)} ${fmtTokens(seg.tokens)} 令牌`}
                          tabIndex={0}
                          className="w-full rounded-[2px] transition-opacity duration-fast hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
                          style={{ height: `${seg.h}px`, background: agentColor(seg.agent) }}
                          onMouseEnter={(e) => onBarEnter(e, seg)}
                          onMouseLeave={() => setBarTip(null)}
                          onFocus={(e) => onBarEnter(e, seg)}
                          onBlur={() => setBarTip(null)}
                        />
                      ))}
                    </div>
                    <span className="font-mono text-micro tabular-nums text-faint">{d.label}</span>
                  </div>
                ))}
              </div>
              <ChartTip tip={barTip}>
                {barSeg && (
                  <p className="whitespace-nowrap text-meta">
                    <span className="font-medium">{segName(barSeg.agent)}</span>
                    <span className="mx-1.5 text-faint">·</span>
                    <span className="font-mono tabular-nums">{fmtTokens(barSeg.tokens)} 令牌</span>
                  </p>
                )}
              </ChartTip>
            </div>
            <div className="mt-2 flex flex-col gap-1 border-t border-hairline/60 pt-2">
              {agentLegend.map((a) => (
                <span key={a.agent} className="flex items-center gap-1.5 text-meta">
                  <span
                    className="h-[6px] w-[6px] shrink-0 rounded-full"
                    style={{ background: agentColor(a.agent) }}
                  />
                  <span className="text-muted-foreground">{segName(a.agent)}</span>
                  <span className="ml-auto font-mono tabular-nums text-faint">{a.pct}%</span>
                  <span className="w-9 text-right font-mono tabular-nums">{fmtTokens(a.tokens)}</span>
                </span>
              ))}
            </div>
          </section>

          {/* ── 区间模型折线（准星 + 悬浮明细 + 峰值标注）── */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: enterDelay() }}>
            <div className="mb-2 flex items-baseline gap-1.5">
              <span className="font-mono text-micro text-faint">03</span>
              <span className="text-detail font-semibold">{rangeLabel(range)} · 按模型</span>
            </div>
            <ModelLineChart days={lineDays} series={lineSeries} />
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {lineSeries.map((m) => (
                <span key={m.name} className="flex items-center gap-1 text-micro text-muted-foreground">
                  {/* 线样图例：dash 双编码在图例里同样可读，圆点表达不了线型 */}
                  <svg width="14" height="4" className="shrink-0" aria-hidden="true">
                    <line
                      x1="1"
                      y1="2"
                      x2="13"
                      y2="2"
                      stroke={m.color}
                      strokeWidth={m.width}
                      strokeDasharray={m.dash}
                      strokeLinecap="round"
                    />
                  </svg>
                  {m.name}
                  <span className="font-mono tabular-nums text-faint">{fmtTokens(m.total)}</span>
                </span>
              ))}
            </div>
          </section>
        </>
      ) : (
        <div className="animate-enter px-3 py-14 text-center" style={{ animationDelay: enterDelay() }}>
          <Murmuration size={120} className="mx-auto" />
          <p className="mt-4 text-body font-medium">还没有用量记录</p>
          <p className="mt-1.5 text-meta leading-relaxed text-muted-foreground">
            agent 跑起来后，这里会出现热力图与模型用量曲线
          </p>
        </div>
      )}
    </div>
  );
}

function segName(agent: string) {
  return AGENT_META[agent as keyof typeof AGENT_META]?.name ?? agent;
}

