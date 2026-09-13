<template>
  <div class="flex flex-col gap-3">
    <template v-if="hasData">
      <!-- ── 近 10 周热力图（周为列，日为行，GitHub 式；色阶 ink→琥珀）── -->
      <section class="rounded-item border border-hairline bg-card px-3 py-2.5 shadow-raised">
        <div class="mb-2 flex items-baseline justify-between">
          <span class="flex items-baseline gap-1.5">
            <span class="font-mono text-[9.5px] text-faint">01</span>
            <span class="text-[11px] font-semibold">近 10 周</span>
          </span>
          <span class="font-mono text-[10px] tabular-nums text-faint">{{ fmt(totalTokens) }} 令牌</span>
        </div>
        <div ref="heatBox" class="relative">
          <div class="flex gap-[3px]">
            <div v-for="(week, wi) in heatWeeks" :key="wi" class="flex flex-1 flex-col gap-[3px]">
              <span
                v-for="cell in week"
                :key="cell.day"
                class="h-[11px] w-full rounded-[2.5px] transition-shadow duration-fast hover:ring-1 hover:ring-foreground/25"
                :style="{ background: cell.color }"
                @mouseenter="onHeatEnter($event, cell)"
                @mouseleave="heatTip = null"
              />
            </div>
          </div>
          <ChartTip :tip="heatTip">
            <p v-if="heatCell" class="whitespace-nowrap text-[10.5px]">
              <span class="font-mono tabular-nums text-faint">{{ heatCell.day }}</span>
              <span class="mx-1.5 text-faint">·</span>
              <span class="font-mono tabular-nums font-medium">{{ fmt(heatCell.tokens) }} 令牌</span>
            </p>
          </ChartTip>
        </div>
      </section>

      <!-- ── 近 7 天堆积柱（按 agent 分色）── -->
      <section class="rounded-item border border-hairline bg-card px-3 py-2.5 shadow-raised">
        <div class="mb-2 flex items-baseline justify-between">
          <span class="flex items-baseline gap-1.5">
            <span class="font-mono text-[9.5px] text-faint">02</span>
            <span class="text-[11px] font-semibold">近 7 天 · 按工具</span>
          </span>
          <span class="font-mono text-[10px] tabular-nums text-faint">{{ fmt(weekTokens) }} 令牌</span>
        </div>
        <div ref="barBox" class="relative">
          <div class="flex h-[84px] items-end gap-2">
            <div v-for="d in last7" :key="d.day" class="flex flex-1 flex-col items-center gap-1">
              <div class="flex w-full flex-col-reverse gap-px" :style="{ height: '64px' }">
                <div
                  v-for="seg in d.segments"
                  :key="seg.agent"
                  class="w-full rounded-[2px] transition-opacity duration-fast hover:opacity-80"
                  :style="{ height: seg.h + 'px', background: agentColor(seg.agent) }"
                  @mouseenter="onBarEnter($event, seg)"
                  @mouseleave="barTip = null"
                />
              </div>
              <span class="font-mono text-[9px] tabular-nums text-faint">{{ d.label }}</span>
            </div>
          </div>
          <ChartTip :tip="barTip">
            <p v-if="barSeg" class="whitespace-nowrap text-[10.5px]">
              <span class="font-medium">{{ segName(barSeg.agent) }}</span>
              <span class="mx-1.5 text-faint">·</span>
              <span class="font-mono tabular-nums">{{ fmt(barSeg.tokens) }} 令牌</span>
            </p>
          </ChartTip>
        </div>
      </section>

      <!-- ── 近 7 天模型折线（准星 + 悬浮明细）── -->
      <section class="rounded-item border border-hairline bg-card px-3 py-2.5 shadow-raised">
        <div class="mb-2 flex items-baseline gap-1.5">
          <span class="font-mono text-[9.5px] text-faint">03</span>
          <span class="text-[11px] font-semibold">近 7 天 · 按模型</span>
        </div>
        <ModelLineChart :days="lineDays" :series="lineSeries" />
        <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          <span v-for="m in lineSeries" :key="m.name" class="flex items-center gap-1 text-[9.5px] text-muted-foreground">
            <span class="inline-block h-[6px] w-[6px] rounded-full" :style="{ background: m.color }" />
            {{ m.name }}
            <span class="font-mono tabular-nums text-faint">{{ fmt(m.total) }}</span>
          </span>
        </div>
      </section>
    </template>

    <div v-else class="rounded-item border border-hairline bg-card px-3 py-10 text-center shadow-raised">
      <MurmurMark :size="26" class="mx-auto text-faint" />
      <p class="mt-3 font-display text-[15px] italic">还没有用量记录</p>
      <p class="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        agent 跑起来后，这里会出现热力图与模型用量曲线
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import ChartTip from "@/components/chart-tip.vue";
import ModelLineChart from "@/components/model-line-chart.vue";
import MurmurMark from "@/components/murmur-mark.vue";
import { AGENT_META } from "@/lib/agent-meta";
import { anchorTop } from "@/lib/chart-tip";
import { useMurmurStore } from "@/store/murmur";

import type { ChartTipState } from "@/lib/chart-tip";
import type { UsageDailyRow } from "../../shared/rpc";

const store = useMurmurStore();
const rows = ref<UsageDailyRow[]>([]);

const HEAT_DAYS = 70;

onMounted(async () => {
  try {
    rows.value = await store.usageDaily(HEAT_DAYS);
  } catch {
    // RPC 未就绪/失败时保持空态。
  }
});

const hasData = computed(() => rows.value.some((r) => r.tokens > 0));
const totalTokens = computed(() => rows.value.reduce((s, r) => s + r.tokens, 0));

/* ── 热力图：weeks × 7 rows，右端对齐今天 ── */
const dayMs = 86400_000;
const today = new Date();
today.setHours(0, 0, 0, 0);
const todayMs = today.getTime();
const mondayOffset = (today.getDay() + 6) % 7; // 周一=0
const heatStart = todayMs - mondayOffset * dayMs - (Math.ceil(HEAT_DAYS / 7) - 1) * 7 * dayMs;

const dayTotals = computed(() => {
  const m = new Map<string, number>();
  for (const r of rows.value) m.set(r.day, (m.get(r.day) ?? 0) + r.tokens);
  return m;
});

/* 色阶 ink→琥珀：用量是「agent 在叫你」的前奏，与 waiting 琥珀同族。 */
const HEAT_LEVELS = [
  "color-mix(in oklab, var(--foreground) 6%, transparent)",
  "color-mix(in oklab, var(--status-waiting) 28%, transparent)",
  "color-mix(in oklab, var(--status-waiting) 52%, transparent)",
  "color-mix(in oklab, var(--status-waiting) 78%, transparent)",
  "var(--status-waiting)",
];

interface HeatCell {
  day: string;
  tokens: number;
  color: string;
}

const heatWeeks = computed(() => {
  const max = Math.max(...dayTotals.value.values(), 1);
  const weeks: HeatCell[][] = [];
  for (let w = 0; w * 7 * dayMs + heatStart <= todayMs; w++) {
    const week: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const ms = heatStart + (w * 7 + d) * dayMs;
      const day = fmtDay(ms);
      const tokens = ms > todayMs ? 0 : (dayTotals.value.get(day) ?? 0);
      const lvl = tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4)));
      week.push({ day, tokens, color: HEAT_LEVELS[lvl] });
    }
    weeks.push(week);
  }
  return weeks;
});

/* ── 热力图瞬时悬浮（替代原生 title）── */
const heatBox = ref<HTMLElement | null>(null);
const heatTip = ref<ChartTipState | null>(null);
const heatCell = ref<HeatCell | null>(null);

function onHeatEnter(event: MouseEvent, cell: HeatCell) {
  if (!heatBox.value) return;
  heatCell.value = cell;
  heatTip.value = anchorTop(event, heatBox.value);
}

/* ── 近 7 天按 agent ── */
interface BarSegment {
  agent: string;
  tokens: number;
  h: number;
}

const last7 = computed(() => {
  const byAgent = new Map<string, Map<string, number>>();
  for (const r of rows.value) {
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
});

const weekTokens = computed(() => last7.value.reduce((s, d) => s + d.segments.reduce((a, b) => a + b.tokens, 0), 0));

/* ── 堆积柱瞬时悬浮 ── */
const barBox = ref<HTMLElement | null>(null);
const barTip = ref<ChartTipState | null>(null);
const barSeg = ref<BarSegment | null>(null);

function onBarEnter(event: MouseEvent, seg: BarSegment) {
  if (!barBox.value) return;
  barSeg.value = seg;
  barTip.value = anchorTop(event, barBox.value);
}

function segName(agent: string) {
  return AGENT_META[agent as keyof typeof AGENT_META]?.name ?? agent;
}

/* ── 近 7 天按模型（top6 + 其他），数据整形后交给 ModelLineChart ── */
const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

const lineDays = computed(() => last7.value.map((d) => ({ day: d.day, label: d.label })));

const lineSeries = computed(() => {
  const dayKeys = lineDays.value.map((d) => d.day);
  const byModel = new Map<string, Map<string, number>>();
  for (const r of rows.value) {
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
});

const AGENT_COLORS: Record<string, string> = {
  kimi: "var(--agent-kimi)",
  zcode: "var(--agent-zcode)",
  opencode: "var(--agent-opencode)",
  codex: "var(--agent-codex)",
  cursor: "var(--agent-cursor)",
};
const agentColor = (a: string) => AGENT_COLORS[a] ?? "var(--faint)";

function fmtDay(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmt(n: number) {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
</script>
