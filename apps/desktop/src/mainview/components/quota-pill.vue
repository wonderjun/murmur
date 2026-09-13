<template>
  <!-- 额度窗口胶囊：标签 + 用量百分比 + 迷你进度槽 + 重置倒计时。 -->
  <span
    class="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-muted/60 px-2.5 py-1 font-mono text-[10px] leading-none"
    :class="danger ? 'text-stale' : warn ? 'text-waiting' : 'text-muted-foreground'"
    :title="title"
  >
    <span class="font-sans font-medium">{{ window.label }}</span>
    <span class="tabular-nums">{{ window.usedPct }}%</span>
    <span class="relative h-[3px] w-7 overflow-hidden rounded-full bg-foreground/10">
      <span
        class="absolute inset-y-0 left-0 rounded-full"
        :class="danger ? 'bg-stale' : warn ? 'bg-waiting' : 'bg-idle'"
        :style="{ width: window.usedPct + '%' }"
      />
    </span>
    <span v-if="countdown" class="text-faint tabular-nums">{{ countdown }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

import type { QuotaWindow } from "@core/types";

const props = defineProps<{ window: QuotaWindow }>();

const warn = computed(() => props.window.usedPct >= 70 && props.window.usedPct < 90);
const danger = computed(() => props.window.usedPct >= 90);

const countdown = computed(() => {
  if (!props.window.resetsAt) return "";
  const ms = props.window.resetsAt - Date.now();
  if (ms <= 0) return "重置中";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
});

const title = computed(() => {
  const w = props.window;
  const parts = [w.label];
  if (w.used !== undefined && w.limit !== undefined && w.limit > 0) {
    parts.push(`${fmt(w.used)} / ${fmt(w.limit)}`);
  }
  if (w.resetsAt) parts.push(`重置 ${new Date(w.resetsAt).toLocaleString()}`);
  return parts.join(" · ");
});

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}
</script>
