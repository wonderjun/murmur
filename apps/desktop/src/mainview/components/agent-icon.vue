<template>
  <!-- agent 徽标：默认可着色 glyph 走实色 accent 底；ZCode 官方 PNG 是灰白锁章，铺 ink 底并铺满，避免缩进后糊成一团。 -->
  <span
    class="agent-tile inline-flex shrink-0 items-center justify-center overflow-hidden"
    :class="isLockup ? 'bg-foreground' : 'accent-solid'"
    :data-agent="agent"
    :style="{ width: size + 'px', height: size + 'px', borderRadius: Math.round(size * 0.24) + 'px' }"
  >
    <BrandIcon :agent="agent" :size="isLockup ? size : size * 0.62" />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

import BrandIcon from "@/components/brand-icon.vue";

import type { AgentId } from "@core/types";

const props = withDefaults(defineProps<{ agent: AgentId; size?: number }>(), { size: 30 });
const isLockup = computed(() => props.agent === "zcode");
</script>
