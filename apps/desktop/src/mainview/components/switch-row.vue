<template>
  <!-- 设置行：标题 + 说明 + 右侧开关。开关 on 态用 accent 品牌色（非 status 语义）。 -->
  <div class="flex items-center justify-between gap-3">
    <div class="min-w-0 flex-1">
      <p class="text-[12px] font-medium text-foreground">{{ label }}</p>
      <p v-if="desc" class="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{{ desc }}</p>
      <slot />
    </div>
    <SwitchRoot
      :model-value="checked"
      :disabled="disabled"
      class="relative h-[18px] w-[30px] shrink-0 rounded-full bg-foreground/15 transition-colors duration-fast data-[state=checked]:bg-accent data-[disabled]:opacity-40"
      @update:model-value="emit('update:checked', $event)"
    >
      <SwitchThumb
        class="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-card shadow-raised transition-transform duration-fast data-[state=checked]:translate-x-[14px]"
      />
    </SwitchRoot>
  </div>
</template>

<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui";

withDefaults(defineProps<{ label: string; desc?: string; checked: boolean; disabled?: boolean }>(), {
  desc: undefined,
  disabled: false,
});

const emit = defineEmits<{ "update:checked": [value: boolean] }>();
</script>
