/**
 * 用量视图：display hero（今日令牌数字当家）→ 01 热力图（foreground 单色阶，
 * GitHub 式）→ 02 近 7 天按 agent 堆积柱 + 明细图例 → 03 近 7 天按模型折线。
 * 彩色纪律：热力图走中性色阶；agent 色只出现在「谁」语义的柱段与图例点。
 * 卡片语法：三个图表区块是 flat 地面栏目（编号头 + 上 hairline），不占卡片壳——
 * 卡片只留给「可交互实体」（动态页会话组、工具页 agent 行）。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import AnimatedNumber from "@/components/animated-number";
import ChartTip from "@/components/chart-tip";
import ModelLineChart from "@/components/model-line-chart";
import Murmuration from "@/components/murmuration";
import { AGENT_META } from "@/lib/agent-meta";
import { anchorTop } from "@/lib/chart-tip";
import { fmtTokens } from "@/lib/format";
import { useMurmurStore } from "@/store/murmur";

import type { ChartTipState } from "@/lib/chart-tip";
import type { MouseEvent as ReactMouseEvent } from "react";
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

const AGENT_COLORS: Record<string, string> = {
  kimi: "var(--agent-kimi)",
  zcode: "var(--agent-zcode)",
  opencode: "var(--agent-opencode)",
  codex: "var(--agent-codex)",
  cursor: "var(--agent-cursor)",
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

  useEffect(() => {
    usageDaily(HEAT_DAYS)
      .then(setRows)
      .catch(() => {
        // RPC 未就绪/失败时保持空态。
      });
  }, [usageDaily]);

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
        const day = fmtDay(ms);
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

  function onHeatEnter(event: ReactMouseEvent<HTMLElement>, cell: HeatCell) {
    if (!heatBox.current) return;
    setHeatCell(cell);
    setHeatTip(anchorTop(event, heatBox.current));
  }

  /* ── 近 7 天按 agent ── */
  const last7 = useMemo(() => {
    const byAgent = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!byAgent.has(r.day)) byAgent.set(r.day, new Map());
      const m = byAgent.get(r.day)!;
      m.set(r.agent, (m.get(r.agent) ?? 0) + r.tokens);
    }
    const days: { day: string; label: string; segments: BarSegment[] }[] = [];
    let maxTotal = 1;
    const totals: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const ms = todayMs - i * dayMs;
      const day = fmtDay(ms);
      const m = byAgent.get(day);
      const total = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
      totals.push(total);
      maxTotal = Math.max(maxTotal, total);
      days.push({ day, label: i === 0 ? "今天" : day.slice(5), segments: [] });
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
  }, [rows]);

  const weekTokens = last7.reduce((s, d) => s + d.segments.reduce((a, b) => a + b.tokens, 0), 0);

  /* 图例明细：近 7 天各 agent 合计与占比。 */
  const agentLegend = useMemo(() => {
    const byAgent = new Map<string, number>();
    for (const d of last7) for (const seg of d.segments) byAgent.set(seg.agent, (byAgent.get(seg.agent) ?? 0) + seg.tokens);
    return [...byAgent.entries()]
      .map(([agent, tokens]) => ({ agent, tokens, pct: weekTokens ? Math.round((tokens / weekTokens) * 100) : 0 }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [last7, weekTokens]);

  /* ── 概览条：今日 / 近 7 日 / 近 10 周 / 活跃天数 ── */
  const overview = useMemo(() => {
    const todayTokens = dayTotals.get(fmtDay(todayMs)) ?? 0;
    const activeDays = [...dayTotals.values()].filter((v) => v > 0).length;
    return { todayTokens, weekTokens, totalTokens, activeDays };
  }, [dayTotals, weekTokens, totalTokens]);

  /* ── 堆积柱瞬时悬浮 ── */
  const barBox = useRef<HTMLDivElement | null>(null);
  const [barTip, setBarTip] = useState<ChartTipState | null>(null);
  const [barSeg, setBarSeg] = useState<BarSegment | null>(null);

  function onBarEnter(event: ReactMouseEvent<HTMLElement>, seg: BarSegment) {
    if (!barBox.current) return;
    setBarSeg(seg);
    setBarTip(anchorTop(event, barBox.current));
  }

  /* ── 近 7 天按模型（top6 + 其他），数据整形后交给 ModelLineChart ── */
  const lineDays = useMemo(() => last7.map((d) => ({ day: d.day, label: d.label })), [last7]);

  const lineSeries = useMemo(() => {
    const dayKeys = lineDays.map((d) => d.day);
    const byModel = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!dayKeys.includes(r.day)) continue;
      const name = (r.model ?? "unknown").split("/").pop()!;
      if (!byModel.has(name)) byModel.set(name, new Map());
      const m = byModel.get(name)!;
      m.set(r.day, (m.get(r.day) ?? 0) + r.tokens);
    }
    // top6 + 其他
    const ranked = [...byModel.entries()]
      .map(([name, m]) => ({ name, m, total: [...m.values()].reduce((a, b) => a + b, 0) }))
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
      values: dayKeys.map((d) => t.m.get(d) ?? 0),
    }));
  }, [rows, lineDays]);

  /* 入场序位：渲染顺序即 stagger 顺序 */
  let slot = 0;
  const enterDelay = () => `${slot++ * 40}ms`;

  return (
    <div className="flex flex-col gap-4">
      {hasData ? (
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
                        className="h-[11px] w-full rounded-[2.5px] transition-shadow duration-fast hover:ring-1 hover:ring-foreground/25"
                        style={{ background: cell.color }}
                        onMouseEnter={(e) => onHeatEnter(e, cell)}
                        onMouseLeave={() => setHeatTip(null)}
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

          {/* ── 近 7 天堆积柱（按 agent 分色）+ 明细图例 ── */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: enterDelay() }}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-micro text-faint">02</span>
                <span className="text-detail font-semibold">近 7 天 · 按工具</span>
              </span>
              <span className="font-mono text-micro tabular-nums text-faint">{fmtTokens(weekTokens)} 令牌</span>
            </div>
            <div ref={barBox} className="relative">
              <div className="flex h-[84px] items-end gap-2">
                {last7.map((d) => (
                  <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex w-full flex-col-reverse gap-px" style={{ height: "64px" }}>
                      {d.segments.map((seg) => (
                        <div
                          key={seg.agent}
                          className="w-full rounded-[2px] transition-opacity duration-fast hover:opacity-80"
                          style={{ height: `${seg.h}px`, background: agentColor(seg.agent) }}
                          onMouseEnter={(e) => onBarEnter(e, seg)}
                          onMouseLeave={() => setBarTip(null)}
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

          {/* ── 近 7 天模型折线（准星 + 悬浮明细 + 峰值标注）── */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: enterDelay() }}>
            <div className="mb-2 flex items-baseline gap-1.5">
              <span className="font-mono text-micro text-faint">03</span>
              <span className="text-detail font-semibold">近 7 天 · 按模型</span>
            </div>
            <ModelLineChart days={lineDays} series={lineSeries} />
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {lineSeries.map((m) => (
                <span key={m.name} className="flex items-center gap-1 text-micro text-muted-foreground">
                  <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: m.color }} />
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

function fmtDay(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
