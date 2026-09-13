<template>
  <DesignBoard v-if="isDesign" />
  <div v-else class="flex h-full flex-col bg-background">
    <MurmurHeader />

    <ScrollAreaRoot class="min-h-0 flex-1 overflow-hidden">
      <ScrollAreaViewport class="h-full w-full">
        <main class="px-4 pb-4 pt-1">
          <MonitorView v-if="view === 'live'" />
          <UsageView v-else-if="view === 'usage'" />
          <SetupView v-else-if="view === 'setup'" />
          <SettingsView v-else />
        </main>
      </ScrollAreaViewport>
      <ScrollBar orientation="vertical" class="w-1.5 p-px">
        <ScrollAreaThumb class="rounded-full bg-foreground/15" />
      </ScrollBar>
    </ScrollAreaRoot>

    <footer class="flex items-center border-t border-hairline bg-card px-3 py-2">
      <nav class="flex items-center gap-0.5 rounded-full bg-muted p-0.5" aria-label="主视图">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          class="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium transition-colors duration-fast"
          :class="view === item.id ? 'bg-card text-foreground shadow-raised' : 'text-muted-foreground hover:text-foreground'"
          @click="view = item.id"
        >
          <component :is="item.icon" :size="12" :stroke-width="1.8" />
          {{ item.label }}
          <span v-if="item.id === 'live' && store.waitingCount" class="font-mono text-[9.5px] tabular-nums text-waiting">{{ store.waitingCount }}</span>
        </button>
      </nav>
      <div class="ml-auto flex items-center gap-1">
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-stale/10 hover:text-stale"
          title="退出 Murmur"
          @click="store.quit()"
        >
          <Power :size="13" />
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Activity, BarChart3, Power, Settings, Settings2 } from "lucide-vue-next";
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar as ScrollBar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "reka-ui";

import DesignBoard from "@/design/design-board.vue";
import MonitorView from "@/components/monitor-view.vue";
import MurmurHeader from "@/components/murmur-header.vue";
import SettingsView from "@/components/settings-view.vue";
import SetupView from "@/components/setup-view.vue";
import UsageView from "@/components/usage-view.vue";
import { useMurmurStore } from "@/store/murmur";

const store = useMurmurStore();
const isDesign = ref(location.hash.startsWith("#/design"));
const view = ref<"live" | "usage" | "setup" | "settings">("live");
const navItems = [
  { id: "live" as const, label: "动态", icon: Activity },
  { id: "usage" as const, label: "用量", icon: BarChart3 },
  { id: "setup" as const, label: "工具", icon: Settings2 },
  { id: "settings" as const, label: "设置", icon: Settings },
];

onMounted(() => store.refresh());
</script>
