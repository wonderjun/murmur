<template>
  <!-- 与 dock 同构的抽象 murmuration：点群波浪悬于栖枝，峰点琥珀 =「轮到你了」。 -->
  <svg :width="size" :height="size" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <circle cx="6.5" cy="17.5" r="1.5" fill="currentColor" />
    <circle cx="12" cy="13.5" r="2.2" fill="currentColor" />
    <circle cx="19" cy="11" r="3.3" fill="#F0A63C" />
    <circle cx="25.5" cy="15" r="2.1" fill="currentColor" />
    <path d="M4 25h24" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 22 });
</script>
