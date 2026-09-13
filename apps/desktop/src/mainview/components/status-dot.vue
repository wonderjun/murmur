<template>
  <!-- 签名元素：状态点。working=呼吸绿 waiting=脉冲琥珀 idle=灰 stale=红 ended=空心环。 -->
  <span
    class="inline-block shrink-0 rounded-full"
    :class="{
      'bg-working animate-breathe': status === 'working',
      'bg-waiting animate-attention': status === 'waiting',
      'bg-idle': status === 'idle',
      'bg-stale': status === 'stale',
      'border-[1.5px] border-ended bg-transparent': status === 'ended',
    }"
    :style="{ width: size + 'px', height: size + 'px' }"
  />
</template>

<script setup lang="ts">
import type { AgentStatus } from "@core/types";

withDefaults(defineProps<{ status: AgentStatus; size?: number }>(), { size: 8 });
</script>
