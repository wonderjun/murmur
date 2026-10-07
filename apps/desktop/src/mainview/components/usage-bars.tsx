/**
 * 用量页 · 区间堆积柱（按 agent 分色）+ 明细图例。
 * props 是已按区间过滤的 rows 与区间日列表（label 由调用方算好，含「今天」）。
 * 柱段 focus/hover 同出 ChartTip；agent 色只出现在「谁」语义的柱段与图例点。
 * 柱轴字抽稀与 03 折线同规：标签中心距不足 ~40px 隔列取点，末日必出、过近让位。
 */

import { useLayoutEffect, useMemo, useState } from "react";

import ChartTip from "@/components/chart-tip";
import { AGENT_META } from "@/lib/agent-meta";
import { anchorTop } from "@/lib/chart-tip";
import { fmtTokens } from "@/lib/format";

import type { ChartTipState } from "@/lib/chart-tip";
import type { SyntheticEvent as ReactSyntheticEvent } from "react";
import type { UsageDailyRow } from "../../shared/rpc";

const AGENT_COLORS: Record<string, string> = {
  kimi: "var(--agent-kimi)",
  zcode: "var(--agent-zcode)",
  opencode: "var(--agent-opencode)",
  codex: "var(--agent-codex)",
  cursor: "var(--agent-cursor)",
  devin: "var(--agent-devin)",
  qoder: "var(--agent-qoder)",
  minimax: "var(--agent-minimax)",
  omp: "var(--agent-omp)",
  "claude-code": "var(--agent-claude-code)",
};
const agentColor = (a: string) => AGENT_COLORS[a] ?? "var(--faint)";

function segName(agent: string) {
  return AGENT_META[agent as keyof typeof AGENT_META]?.name ?? agent;
}

interface BarSegment {
  agent: string;
  tokens: number;
  h: number;
}

export default function UsageBars({ rows, days }: { rows: UsageDailyRow[]; days: { day: string; label: string }[] }) {
  const chartDays = useMemo(() => {
    const byAgent = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!byAgent.has(r.day)) byAgent.set(r.day, new Map());
      const m = byAgent.get(r.day)!;
      m.set(r.agent, (m.get(r.agent) ?? 0) + r.tokens);
    }
    const list: { day: string; label: string; segments: BarSegment[] }[] = [];
    let maxTotal = 1;
    const totals: number[] = [];
    for (const d of days) {
      const m = byAgent.get(d.day);
      const total = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
      totals.push(total);
      maxTotal = Math.max(maxTotal, total);
      list.push({ day: d.day, label: d.label, segments: [] });
    }
    list.forEach((d, i) => {
      const m = byAgent.get(d.day);
      if (!m) return;
      const hScale = totals[i] > 0 ? Math.max(6, (totals[i] / maxTotal) * 60) : 0;
      d.segments = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([agent, tokens]) => ({ agent, tokens, h: Math.max(2, (tokens / totals[i]) * hScale) }));
    });
    return list;
  }, [rows, days]);

  const rangeTokens = chartDays.reduce((s, d) => s + d.segments.reduce((a, b) => a + b.tokens, 0), 0);

  /* 图例明细：区间内各 agent 合计与占比。 */
  const agentLegend = useMemo(() => {
    const byAgent = new Map<string, number>();
    for (const d of chartDays)
      for (const seg of d.segments) byAgent.set(seg.agent, (byAgent.get(seg.agent) ?? 0) + seg.tokens);
    return [...byAgent.entries()]
      .map(([agent, tokens]) => ({ agent, tokens, pct: rangeTokens ? Math.round((tokens / rangeTokens) * 100) : 0 }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [chartDays, rangeTokens]);

  /* callback ref 存节点：柱区随数据就绪才挂载（此前是骨架屏），空依赖 effect 会量空——
     节点挂上时再观察，顺路喂柱轴字抽稀的容器宽。 */
  const [barBox, setBarBox] = useState<HTMLDivElement | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => {
    if (!barBox) return;
    const measure = () => setBarWidth(barBox.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(barBox);
    return () => ro.disconnect();
  }, [barBox]);
  const [barTip, setBarTip] = useState<ChartTipState | null>(null);
  const [barSeg, setBarSeg] = useState<BarSegment | null>(null);

  function onBarEnter(event: ReactSyntheticEvent<HTMLElement>, seg: BarSegment) {
    if (!barBox) return;
    setBarSeg(seg);
    setBarTip(anchorTop(event, barBox));
  }

  const barLabelIs = useMemo(() => {
    const all = new Set(chartDays.map((_, i) => i));
    if (!chartDays.length || !barWidth) return all;
    const every = Math.max(1, Math.ceil((chartDays.length * 40) / barWidth));
    const idx: number[] = [];
    for (let i = 0; i < chartDays.length; i += every) idx.push(i);
    const last = chartDays.length - 1;
    if (idx[idx.length - 1] !== last) {
      const col = barWidth / chartDays.length;
      if (idx.length > 1 && (last - idx[idx.length - 1]) * col < 34) idx.pop();
      idx.push(last);
    }
    return new Set(idx);
  }, [chartDays, barWidth]);

  return (
    <>
      <div ref={setBarBox} className="relative">
        {/* gap-1：30 列时 8px 间隙在窄窗吃掉 232px，柱子变细条——4px 足够分列 */}
        <div className="flex h-21 items-end gap-1">
          {chartDays.map((d, i) => (
            <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-col-reverse gap-px" style={{ height: "64px" }}>
                {d.segments.map((seg) => (
                  <div
                    key={seg.agent}
                    role="img"
                    aria-label={`${segName(seg.agent)} ${fmtTokens(seg.tokens)} 令牌`}
                    tabIndex={0}
                    className="w-full rounded-xs transition-opacity duration-fast hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
                    style={{ height: `${seg.h}px`, background: agentColor(seg.agent) }}
                    onMouseEnter={(e) => onBarEnter(e, seg)}
                    onMouseLeave={() => setBarTip(null)}
                    onFocus={(e) => onBarEnter(e, seg)}
                    onBlur={() => setBarTip(null)}
                  />
                ))}
              </div>
              {/* 抽稀不卸载：invisible 占位保持列等高，items-end 下柱底基线不跳；
                  nowrap+center 让窄列里标签居中溢出而非折行（min-w-0 拆掉 min-content 约束） */}
              <span
                className={`w-full whitespace-nowrap text-center font-data text-micro tabular-nums text-faint${
                  barLabelIs.has(i) ? "" : "invisible"
                }`}
              >
                {d.label}
              </span>
            </div>
          ))}
        </div>
        <ChartTip tip={barTip}>
          {barSeg && (
            <p className="whitespace-nowrap text-meta">
              <span className="font-medium">{segName(barSeg.agent)}</span>
              <span className="mx-1.5 text-faint">·</span>
              <span className="font-data tabular-nums">{fmtTokens(barSeg.tokens)} 令牌</span>
            </p>
          )}
        </ChartTip>
      </div>
      <div className="mt-2 flex flex-col gap-1 border-t border-hairline/60 pt-2">
        {agentLegend.map((a) => (
          <span key={a.agent} className="flex items-center gap-1.5 text-meta">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: agentColor(a.agent) }} />
            <span className="text-muted-foreground">{segName(a.agent)}</span>
            <span className="ml-auto font-data tabular-nums text-faint">{a.pct}%</span>
            <span className="w-9 text-right font-data tabular-nums">{fmtTokens(a.tokens)}</span>
          </span>
        ))}
      </div>
    </>
  );
}
