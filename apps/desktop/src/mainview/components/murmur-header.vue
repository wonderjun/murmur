<template>
  <!-- 刊头：衬线字标 + folio 微信息行（日期 · 运行中计数）+ 待处理徽标，下方横贯栖枝签名。 -->
  <header class="px-4 pb-3 pt-4">
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-2.5">
        <span class="mark-shell flex h-8 w-8 items-center justify-center rounded-lg text-card">
          <MurmurMark :size="20" />
        </span>
        <div>
          <p class="font-display text-[19px] font-semibold italic leading-none tracking-[-0.01em]">Murmur</p>
          <p class="mt-1.5 text-[10px] text-muted-foreground">{{ folio }}</p>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5 pt-0.5">
        <span
          v-if="store.waitingCount"
          class="flex items-center gap-1.5 rounded-full border border-waiting/30 bg-waiting/10 px-2 py-0.5 text-[10px] font-semibold text-waiting"
        >
          <span class="h-1.5 w-1.5 animate-attention rounded-full bg-waiting" />
          {{ store.waitingCount }} 待处理
        </span>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-muted hover:text-foreground"
          title="刷新额度"
          :disabled="refreshing"
          @click="refreshQuotas"
        >
          <RefreshCw :size="12" :class="{ 'animate-spin': refreshing }" />
        </button>
      </div>
    </div>
    <PerchStrip class="mt-3" />
  </header>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { RefreshCw } from "lucide-vue-next";

import MurmurMark from "@/components/murmur-mark.vue";
import PerchStrip from "@/components/perch-strip.vue";
import { useMurmurStore } from "@/store/murmur";

const store = useMurmurStore();
const refreshing = ref(false);

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/* 面板失焦即关，folio 取挂载时刻即可，不做时钟轮询。 */
const folio = computed(() => {
  const d = new Date();
  const parts = [`${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}月${d.getDate()}日`];
  parts.push(store.workingCount ? `${store.workingCount} 运行中` : "安静");
  return parts.join(" · ");
});

async function refreshQuotas() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await store.refreshQuotas();
  } finally {
    setTimeout(() => (refreshing.value = false), 400);
  }
}
</script>
