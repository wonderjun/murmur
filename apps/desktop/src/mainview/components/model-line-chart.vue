<template>
  <!-- 模型用量折线：水平虚线格 + 竖直准星 + 悬浮明细卡（日期 + 当日各模型降序值）。
       交互契约：mousemove 取最近日，hover 点放大为空心环，明细卡瞬时跟随，右半区自动左翻。 -->
  <div class="relative">
    <svg
      ref="svgEl"
      :viewBox="`0 0 ${W} ${H}`"
      class="block h-[128px] w-full"
      @mousemove="onMove"
      @mouseleave="hoverIndex = null"
    >
      <line
        v-for="gy in gridYs"
        :key="gy"
        :x1="PAD_X"
        :x2="W - PAD_X"
        :y1="gy"
        :y2="gy"
        stroke="var(--hairline)"
        stroke-width="1"
        stroke-dasharray="3 3"
      />
      <line :x1="PAD_X" :x2="W - PAD_X" :y1="H - PAD_Y" :y2="H - PAD_Y" stroke="var(--hairline)" stroke-width="1" />

      <text
        v-for="(d, i) in days"
        :key="d.day"
        :x="x(i)"
        :y="H - 3"
        text-anchor="middle"
        font-size="8"
        fill="var(--faint)"
        style="font-family: var(--font-mono); font-variant-numeric: tabular-nums"
      >{{ d.label }}</text>

      <line
        v-if="hoverIndex !== null"
        :x1="x(hoverIndex)"
        :x2="x(hoverIndex)"
        :y1="PAD_Y / 2"
        :y2="H - PAD_Y"
        stroke="var(--foreground)"
        stroke-opacity="0.3"
        stroke-width="1"
        stroke-dasharray="3 3"
      />

      <polyline
        v-for="s in drawn"
        :key="s.name"
        :points="s.points"
        fill="none"
        :stroke="s.color"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <template v-for="s in drawn" :key="s.name + '-pts'">
        <circle
          v-for="(p, i) in s.coords"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          :r="i === hoverIndex ? 4 : 1.8"
          :fill="i === hoverIndex ? 'var(--card)' : s.color"
          :stroke="i === hoverIndex ? s.color : 'none'"
          :stroke-width="i === hoverIndex ? 1.8 : 0"
        />
      </template>
    </svg>

    <ChartTip :tip="tipState">
      <template v-if="hoverIndex !== null">
        <p class="text-[11px] font-semibold">{{ hoverTitle }}</p>
        <div class="mt-1.5 flex min-w-[150px] flex-col gap-1">
          <span v-for="row in hoverRows" :key="row.name" class="flex items-center gap-1.5 text-[10.5px]">
            <span class="h-[6px] w-[6px] shrink-0 rounded-full" :style="{ background: row.color }" />
            <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ row.name }}</span>
            <span class="font-mono tabular-nums">{{ fmt(row.value) }}</span>
          </span>
          <p v-if="!hoverRows.length" class="text-[10px] text-faint">当日无记录</p>
        </div>
      </template>
    </ChartTip>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import ChartTip from "@/components/chart-tip.vue";

import type { ChartTipState } from "@/lib/chart-tip";

interface ModelLineDay {
  day: string;
  label: string;
}

interface ModelLineSeries {
  name: string;
  color: string;
  values: number[];
}

const props = defineProps<{ days: ModelLineDay[]; series: ModelLineSeries[] }>();

const W = 320;
const H = 128;
const PAD_X = 10;
const PAD_Y = 12;

const svgEl = ref<SVGSVGElement | null>(null);
const hoverIndex = ref<number | null>(null);

const max = computed(() => Math.max(1, ...props.series.flatMap((s) => s.values)));
const gridYs = computed(() => [0.25, 0.5, 0.75].map((f) => PAD_Y + f * (H - PAD_Y * 2)));

function x(i: number) {
  return PAD_X + (i * (W - PAD_X * 2)) / Math.max(1, props.days.length - 1);
}

function y(v: number) {
  return H - PAD_Y - (v / max.value) * (H - PAD_Y * 2);
}

const drawn = computed(() =>
  props.series.map((s) => {
    const coords = s.values.map((v, i) => ({ x: x(i), y: y(v) }));
    return { ...s, coords, points: coords.map((c) => `${c.x},${c.y}`).join(" ") };
  }),
);

function onMove(event: MouseEvent) {
  const el = svgEl.value;
  if (!el || props.days.length < 2) return;
  const rect = el.getBoundingClientRect();
  const relX = ((event.clientX - rect.left) / rect.width) * W;
  const step = (W - PAD_X * 2) / (props.days.length - 1);
  hoverIndex.value = Math.min(props.days.length - 1, Math.max(0, Math.round((relX - PAD_X) / step)));
}

/** 准星过半区后明细卡翻到左侧，避免顶出面板。 */
const tipState = computed<ChartTipState | null>(() => {
  const i = hoverIndex.value;
  if (i === null) return null;
  return { x: x(i), y: PAD_Y / 2, place: i >= props.days.length / 2 ? "left" : "right" };
});

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const hoverTitle = computed(() => {
  const i = hoverIndex.value;
  if (i === null) return "";
  const d = new Date(props.days[i].day + "T00:00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
});

const hoverRows = computed(() => {
  const i = hoverIndex.value;
  if (i === null) return [];
  return props.series
    .map((s) => ({ name: s.name, color: s.color, value: s.values[i] ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
});

function fmt(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
</script>
