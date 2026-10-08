/** 模型用量折线：宽度自适应（ResizeObserver 实测宽 = viewBox 宽，SVG 坐标即 HTML 像素，准星明细卡定位随之精确）
 *  + 水平虚线格 + 竖直准星 + 悬浮明细卡（日期 + 当日各模型降序值）。
 *  轴字按容器宽度抽稀（末日必出、与前点过近则让位），30/92 天长区间不拥挤也不被 viewBox 信箱化居中。
 *  交互契约：mousemove 取最近日，hover 点放大为空心环，明细卡瞬时跟随，右半区自动左翻，
 *  图表贴窗底、卡放不下时锚到基线向上展开（tipBelowFits）。
 *  键盘/读屏：SVG 不做键盘交互，另出一组 sr-only 文本明细（每系列名称 + 区间合计）。 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import ChartTip from "@/components/chart-tip";
import { tipBelowFits } from "@/lib/chart-tip";

import type { ChartTipState } from "@/lib/chart-tip";
import type { MouseEvent as ReactMouseEvent } from "react";

interface ModelLineDay {
  day: string;
  label: string;
}

interface ModelLineSeries {
  name: string;
  color: string;
  /** SVG strokeDasharray——明度梯度之外的系列双编码（细线中灰相邻色阶交叉难辨）。 */
  dash?: string;
  /** 线宽，缺省 1.5；头部系列可略粗做编辑层级。 */
  width?: number;
  values: number[];
}

const W = 320;
const H = 128;
const PAD_X = 10;
const PAD_Y = 12;
/** 轴字最小中心距（px）：mono 10px 的「09-08」约 30px 宽，低于该距离必须抽稀。 */
const LABEL_MIN_GAP = 40;

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function ModelLineChart({ days, series }: { days: ModelLineDay[]; series: ModelLineSeries[] }) {
  const boxEl = useRef<HTMLDivElement | null>(null);
  const svgEl = useRef<SVGSVGElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /* hover 时刻图表顶边在视口的位置：明细卡竖向翻转的空间判定依据。 */
  const [chartTop, setChartTop] = useState<number | null>(null);

  /* 宽度自适应：viewBox 宽取实测宽，首帧前 useLayoutEffect 已量好不闪 320 兜底；
     clientWidth 取整避免小数尺寸与 ResizeObserver 来回抖动。 */
  useLayoutEffect(() => {
    const el = boxEl.current;
    if (!el) return;
    const measure = () => setMeasured(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = measured ?? W;

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const gridYs = [0.25, 0.5, 0.75].map((f) => PAD_Y + f * (H - PAD_Y * 2));

  const x = useCallback((i: number) => PAD_X + (i * (w - PAD_X * 2)) / Math.max(1, days.length - 1), [w, days.length]);
  const y = useCallback((v: number) => H - PAD_Y - (v / max) * (H - PAD_Y * 2), [max]);

  const drawn = useMemo(
    () =>
      series.map((s) => {
        const coords = s.values.map((v, i) => ({ x: x(i), y: y(v) }));
        return { ...s, coords, points: coords.map((c) => `${c.x},${c.y}`).join(" ") };
      }),
    [series, x, y],
  );

  /* 轴字抽稀：按可绘图宽均匀取点，末日必出；与前点中心距不足时末日让前点退位。
     首点 start / 末点 end 锚点贴边，长标签不再被视口左右各裁 5px。 */
  const labelIs = useMemo(() => {
    if (!days.length) return [];
    const every = Math.max(1, Math.ceil((days.length * LABEL_MIN_GAP) / Math.max(1, w - PAD_X * 2)));
    const idx: number[] = [];
    for (let i = 0; i < days.length; i += every) idx.push(i);
    const last = days.length - 1;
    if (idx[idx.length - 1] !== last) {
      if (idx.length > 1 && x(last) - x(idx[idx.length - 1]) < LABEL_MIN_GAP - 6) idx.pop();
      idx.push(last);
    }
    return idx;
  }, [days, w, x]);

  function onMove(event: ReactMouseEvent<SVGSVGElement>) {
    const el = svgEl.current;
    if (!el || days.length < 2) return;
    const rect = el.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * w;
    const step = (w - PAD_X * 2) / (days.length - 1);
    setHoverIndex(Math.min(days.length - 1, Math.max(0, Math.round((relX - PAD_X) / step))));
    const host = boxEl.current;
    if (host) setChartTop(host.getBoundingClientRect().top);
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

  const hoverRows =
    hoverIndex === null
      ? []
      : series
          .map((s) => ({ name: s.name, color: s.color, value: s.values[hoverIndex] ?? 0 }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value);

  /** 明细卡落位：左右随准星翻边；下方视口空间放不下（图表贴窗底）时锚到基线向上展开。 */
  const tipState: ChartTipState | null = (() => {
    if (hoverIndex === null) return null;
    const side = hoverIndex >= days.length / 2 ? "left" : "right";
    if (chartTop !== null && !tipBelowFits(chartTop, hoverRows.length)) {
      return { x: x(hoverIndex), y: H - PAD_Y, place: `${side}-up` as ChartTipState["place"] };
    }
    return { x: x(hoverIndex), y: PAD_Y / 2, place: side };
  })();

  const hoverTitle = (() => {
    if (hoverIndex === null) return "";
    const d = new Date(days[hoverIndex].day + "T00:00:00");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  })();

  return (
    <div ref={boxEl} className="relative">
      <svg
        ref={svgEl}
        viewBox={`0 0 ${w} ${H}`}
        className="block h-32 w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {gridYs.map((gy) => (
          <line
            key={gy}
            x1={PAD_X}
            x2={w - PAD_X}
            y1={gy}
            y2={gy}
            stroke="var(--hairline)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ))}
        <line x1={PAD_X} x2={w - PAD_X} y1={H - PAD_Y} y2={H - PAD_Y} stroke="var(--hairline)" strokeWidth="1" />

        {labelIs.map((i) => (
          <text
            key={days[i].day}
            x={x(i)}
            y={H - 3}
            textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
            fontSize="10"
            fill="var(--faint)"
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
          >
            {days[i].label}
          </text>
        ))}

        {/* 峰值图注：全局最高点上方落「峰 xM」，hover 时让位给准星明细；
            钳位留足文字半宽（~28px），窄图上不被左右缘裁字 */}
        {peak && hoverIndex === null && (
          <text
            x={Math.min(Math.max(peak.x, PAD_X + 28), w - PAD_X - 28)}
            y={Math.max(peak.y - 7, 9)}
            textAnchor="middle"
            fontSize="10"
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
            strokeWidth={s.width ?? 1.5}
            strokeDasharray={s.dash}
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
              fill={i === hoverIndex ? "var(--surface-2)" : s.color}
              stroke={i === hoverIndex ? s.color : "none"}
              strokeWidth={i === hoverIndex ? 1.8 : 0}
            />
          )),
        )}
      </svg>

      {/* 读屏兜底：每系列名称 + 区间合计（SVG 交互不便键盘遍历，文本通道补齐） */}
      <div className="sr-only">
        {series.map((s) => (
          <p key={s.name}>{`${s.name} 区间合计 ${fmt(s.values.reduce((a, b) => a + b, 0))} 令牌`}</p>
        ))}
      </div>

      <ChartTip tip={tipState}>
        {hoverIndex !== null && (
          <>
            <p className="text-meta font-semibold">{hoverTitle}</p>
            <div className="mt-1.5 flex min-w-37.5 flex-col gap-1">
              {hoverRows.map((row) => (
                <span key={row.name} className="flex items-center gap-1.5 text-meta">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: row.color }} />
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
