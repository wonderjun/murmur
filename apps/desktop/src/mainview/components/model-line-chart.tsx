/** 模型用量折线：水平虚线格 + 竖直准星 + 悬浮明细卡（日期 + 当日各模型降序值）。
 *  交互契约：mousemove 取最近日，hover 点放大为空心环，明细卡瞬时跟随，右半区自动左翻。 */

import { useMemo, useRef, useState } from "react";

import ChartTip from "@/components/chart-tip";

import type { ChartTipState } from "@/lib/chart-tip";
import type { MouseEvent as ReactMouseEvent } from "react";

interface ModelLineDay {
  day: string;
  label: string;
}

interface ModelLineSeries {
  name: string;
  color: string;
  values: number[];
}

const W = 320;
const H = 128;
const PAD_X = 10;
const PAD_Y = 12;

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function ModelLineChart({ days, series }: { days: ModelLineDay[]; series: ModelLineSeries[] }) {
  const svgEl = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const gridYs = [0.25, 0.5, 0.75].map((f) => PAD_Y + f * (H - PAD_Y * 2));

  const x = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / Math.max(1, days.length - 1);
  const y = (v: number) => H - PAD_Y - (v / max) * (H - PAD_Y * 2);

  // x/y 是纯函数（闭包 days/max），依赖表已覆盖。
  const drawn = useMemo(
    () =>
      series.map((s) => {
        const coords = s.values.map((v, i) => ({ x: x(i), y: y(v) }));
        return { ...s, coords, points: coords.map((c) => `${c.x},${c.y}`).join(" ") };
      }),
    [series, days, max],
  );

  function onMove(event: ReactMouseEvent<SVGSVGElement>) {
    const el = svgEl.current;
    if (!el || days.length < 2) return;
    const rect = el.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * W;
    const step = (W - PAD_X * 2) / (days.length - 1);
    setHoverIndex(Math.min(days.length - 1, Math.max(0, Math.round((relX - PAD_X) / step))));
  }

  /* 峰值标注：全系列最高点旁边落一枚小注，编辑版的「图注」 */
  const peak = useMemo(() => {
    let best: { x: number; y: number; v: number } | null = null;
    for (const s of drawn) {
      for (let i = 0; i < s.coords.length; i++) {
        const v = s.values[i];
        if (v > 0 && (best === null || v > best.v)) best = { x: s.coords[i].x, y: s.coords[i].y, v };
      }
    }
    return best;
  }, [drawn]);

  /** 准星过半区后明细卡翻到左侧，避免顶出面板。 */
  const tipState: ChartTipState | null =
    hoverIndex === null
      ? null
      : { x: x(hoverIndex), y: PAD_Y / 2, place: hoverIndex >= days.length / 2 ? "left" : "right" };

  const hoverTitle = (() => {
    if (hoverIndex === null) return "";
    const d = new Date(days[hoverIndex].day + "T00:00:00");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  })();

  const hoverRows =
    hoverIndex === null
      ? []
      : series
          .map((s) => ({ name: s.name, color: s.color, value: s.values[hoverIndex] ?? 0 }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value);

  return (
    <div className="relative">
      <svg
        ref={svgEl}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[128px] w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {gridYs.map((gy) => (
          <line
            key={gy}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={gy}
            y2={gy}
            stroke="var(--hairline)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ))}
        <line x1={PAD_X} x2={W - PAD_X} y1={H - PAD_Y} y2={H - PAD_Y} stroke="var(--hairline)" strokeWidth="1" />

        {days.map((d, i) => (
          <text
            key={d.day}
            x={x(i)}
            y={H - 3}
            textAnchor="middle"
            fontSize="9"
            fill="var(--faint)"
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
          >
            {d.label}
          </text>
        ))}

        {/* 峰值图注：全局最高点上方落「峰 xM」，hover 时让位给准星明细 */}
        {peak && hoverIndex === null && (
          <text
            x={Math.min(Math.max(peak.x, PAD_X + 14), W - PAD_X - 14)}
            y={Math.max(peak.y - 7, 9)}
            textAnchor="middle"
            fontSize="9"
            fill="var(--muted-foreground)"
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
          >
            峰 {fmt(peak.v)}
          </text>
        )}

        {hoverIndex !== null && (
          <line
            x1={x(hoverIndex)}
            x2={x(hoverIndex)}
            y1={PAD_Y / 2}
            y2={H - PAD_Y}
            stroke="var(--foreground)"
            strokeOpacity="0.3"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}

        {drawn.map((s) => (
          <polyline
            key={s.name}
            points={s.points}
            fill="none"
            stroke={s.color}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {drawn.map((s) =>
          s.coords.map((p, i) => (
            <circle
              key={`${s.name}-pts-${i}`}
              cx={p.x}
              cy={p.y}
              r={i === hoverIndex ? 4 : 1.8}
              fill={i === hoverIndex ? "var(--card)" : s.color}
              stroke={i === hoverIndex ? s.color : "none"}
              strokeWidth={i === hoverIndex ? 1.8 : 0}
            />
          )),
        )}
      </svg>

      <ChartTip tip={tipState}>
        {hoverIndex !== null && (
          <>
            <p className="text-meta font-semibold">{hoverTitle}</p>
            <div className="mt-1.5 flex min-w-[150px] flex-col gap-1">
              {hoverRows.map((row) => (
                <span key={row.name} className="flex items-center gap-1.5 text-meta">
                  <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: row.color }} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
                  <span className="font-mono tabular-nums">{fmt(row.value)}</span>
                </span>
              ))}
              {!hoverRows.length && <p className="text-micro text-faint">当日无记录</p>}
            </div>
          </>
        )}
      </ChartTip>
    </div>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
