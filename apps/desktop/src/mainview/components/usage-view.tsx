/**
 * 用量视图（管理台 usage tab）：PageHead → display hero（今日令牌数字当家，
 * 右列近 7 日/今年/活跃天数陪跑）→ 年热力图 → 区间行 → 按工具堆积柱 →
 * 按模型折线。三个图表块统一 surface-1 容器（p-4 + 块头），叠层不占描边。
 * 图表实现拆在 usage-heatmap（年热力图 + heatYearStats 口径）与
 * usage-bars（区间堆积柱 + 图例）；本页留数据拉取、三态、hero、区间 state、
 * 模型折线组装（MODEL_LINE_STYLES 是 design-board 注释里指的线型真源）。
 */

import { useEffect, useMemo, useState } from "react";

import AnimatedNumber from "@/components/animated-number";
import ModelLineChart from "@/components/model-line-chart";
import Murmuration from "@/components/murmuration";
import PageHead from "@/components/page-head";
import UsageBars from "@/components/usage-bars";
import UsageHeatmap, { FETCH_DAYS, HEAT_LEVELS, HEAT_YEAR, heatYearStats } from "@/components/usage-heatmap";
import UsageRangePicker, { rangeBounds, rangeDayList, rangeLabel } from "@/components/usage-range";
import { Button } from "@/components/ui/button";
import { dayStr, fmtTokens } from "@/lib/format";
import { useMurmurStore } from "@/store/murmur";

import type { UsageRange } from "@/components/usage-range";
import type { UsageDailyRow } from "../../shared/rpc";

const dayMs = 86400_000;

const today = new Date();
today.setHours(0, 0, 0, 0);
const todayMs = today.getTime();

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

export default function UsageView() {
  const usageDaily = useMurmurStore((s) => s.usageDaily);
  const [rows, setRows] = useState<UsageDailyRow[]>([]);
  // 三态：loading（首次拉取，骨架与图表区同高）/ error（读取失败 + 重试）/ ready（含空态）。
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    usageDaily({ days: FETCH_DAYS })
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
  /* hero 与热力图固定认自然年；区间图表仍用全量 rows（自定义区间可越年）。 */
  const overview = useMemo(() => heatYearStats(rows), [rows]);

  /* hero「近 7 日」是固定语义，不吃区间筛选——独立从全窗 rows 算。 */
  const week7Tokens = useMemo(
    () => rows.filter((r) => r.day >= dayStr(todayMs - 6 * dayMs)).reduce((s, r) => s + r.tokens, 0),
    [rows],
  );

  /* ── 区间状态：默认近 7 天；自定义上限 1 个月 ⇒ startDay ≥ today-30，
     必落 365d 默认拉取窗内，client-side 过滤即可。 ── */
  const [range, setRange] = useState<UsageRange>({ kind: "preset", days: 7 });
  const { startDay, endDay } = rangeBounds(range);

  const rangeRows = useMemo(() => rows.filter((r) => r.day >= startDay && r.day <= endDay), [rows, startDay, endDay]);

  const lineDays = useMemo(
    () => rangeDayList(range).map((day) => ({ day, label: day === dayStr(todayMs) ? "今天" : day.slice(5) })),
    [range],
  );

  /* ── 区间按模型折线（top6 + 其他），数据整形后交给 ModelLineChart ── */
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
    <div className="flex flex-col gap-6">
      <PageHead
        title="用量"
        meta={`${HEAT_YEAR} 年 · 共 ${fmtTokens(overview.totalTokens)} 令牌 · 活跃 ${overview.activeDays} 天`}
      />

      {status === "error" ? (
        <div className="px-4 py-14 text-center" role="alert">
          <p className="text-body font-medium">用量读取失败</p>
          <p className="mt-1.5 text-meta text-muted-foreground">本地台账暂时读不出来，稍候可重试。</p>
          <Button size="sm" className="mt-4" onClick={() => setAttempt((a) => a + 1)}>
            重试
          </Button>
        </div>
      ) : status === "loading" ? (
        <div className="flex flex-col gap-3" aria-live="polite" aria-busy="true">
          {/* 骨架与图表区同高：概览 hero + 热力图 + 柱/线两段 */}
          <div className="h-16 animate-pulse rounded-item bg-surface-1" />
          <div className="h-40 animate-pulse rounded-item bg-surface-1" />
          <div className="h-28 animate-pulse rounded-item bg-surface-1" />
        </div>
      ) : (
        <>
          {/* ── 概览 hero：今日令牌数字当家（display 档），右列次级尺度陪跑；
              flex-wrap 兜底：窄窗陪跑列折行仍右对齐（ml-auto）── */}
          <section
            className="animate-enter flex flex-wrap items-end gap-x-6 gap-y-3"
            style={{ animationDelay: enterDelay() }}
          >
            <div className="min-w-0">
              <p className="text-micro font-semibold text-faint">今日令牌</p>
              <p className="mt-1 font-data text-display font-semibold tabular-nums leading-none">
                {overview.todayTokens > 0 ? <AnimatedNumber value={fmtTokens(overview.todayTokens)} /> : "·"}
              </p>
            </div>
            <div className="ml-auto flex flex-col items-end gap-1.5">
              {[
                { label: "近 7 日", value: week7Tokens },
                { label: "今年", value: overview.totalTokens },
              ].map((s) => (
                <span key={s.label} className="text-right">
                  <span className="font-data text-title font-medium tabular-nums">{fmtTokens(s.value)}</span>
                  <span className="ml-1.5 text-micro text-faint">{s.label}</span>
                </span>
              ))}
              <span className="text-right">
                <span className="font-data text-title font-medium tabular-nums">{overview.activeDays}</span>
                <span className="ml-1.5 text-micro text-faint">活跃天数</span>
              </span>
            </div>
          </section>

          {hasData ? (
            <>
              {/* ── 自然年热力图 ── */}
              <section className="animate-enter rounded-item bg-surface-1 p-4" style={{ animationDelay: enterDelay() }}>
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-detail font-semibold">{HEAT_YEAR} 年热力图</span>
                  <span className="flex items-center gap-1 text-micro text-faint">
                    少
                    {HEAT_LEVELS.map((c) => (
                      <span key={c} className="size-1.75 rounded-xs" style={{ background: c }} />
                    ))}
                    多
                  </span>
                </div>
                <UsageHeatmap rows={rows} />
              </section>

              {/* ── 区间行：只影响「按工具/按模型」两块；hero 与热力图是固定语义 ── */}
              <div
                className="animate-enter flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
                style={{ animationDelay: enterDelay() }}
              >
                <span className="text-meta text-muted-foreground">区间</span>
                <UsageRangePicker value={range} onChange={setRange} />
              </div>

              {/* ── 区间堆积柱（按 agent 分色）+ 明细图例 ── */}
              <section className="animate-enter rounded-item bg-surface-1 p-4" style={{ animationDelay: enterDelay() }}>
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-detail font-semibold">按工具</span>
                  <span className="font-data text-micro tabular-nums text-faint">{rangeLabel(range)}</span>
                </div>
                <UsageBars rows={rangeRows} days={lineDays} />
              </section>

              {/* ── 区间模型折线（准星 + 悬浮明细 + 峰值标注）── */}
              <section className="animate-enter rounded-item bg-surface-1 p-4" style={{ animationDelay: enterDelay() }}>
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-detail font-semibold">按模型</span>
                  <span className="font-data text-micro tabular-nums text-faint">{rangeLabel(range)}</span>
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
                      <span className="font-data tabular-nums text-faint">{fmtTokens(m.total)}</span>
                    </span>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="animate-enter py-10 text-center" style={{ animationDelay: enterDelay() }}>
              <Murmuration size={160} className="mx-auto" />
              <p className="mt-4 text-body font-medium">还没有用量记录</p>
              <p className="mt-1.5 text-meta/relaxed text-muted-foreground">
                agent 跑起来后，这里会出现热力图与模型用量曲线
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
