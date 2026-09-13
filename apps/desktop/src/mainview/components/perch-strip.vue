<template>
  <!-- 栖枝：一根横枝承起 5 只「鸟」（agent 状态点），签名元素。
       working 呼吸 / waiting 琥珀脉冲 / 无会话灰寂；点用 background 色晕环把枝条「压」在身后。 -->
  <div class="relative flex h-3 items-center justify-between" role="img" :aria-label="label">
    <span class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hairline" />
    <span
      v-for="bird in birds"
      :key="bird.agent"
      :data-agent="bird.agent"
      class="relative flex items-center justify-center rounded-full bg-background p-[3px]"
    >
      <StatusDot :status="bird.status" :size="6" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import StatusDot from "@/components/status-dot.vue";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { useMurmurStore } from "@/store/murmur";

import type { AgentStatus } from "@core/types";

const store = useMurmurStore();

/** 每个 agent 取会话最高优先级状态，无会话/未安装一律灰寂。 */
const birds = computed(() =>
  AGENT_ORDER.map((agent) => {
    const sessions = store.snapshot?.agents.find((a) => a.agent === agent)?.sessions ?? [];
    const status: AgentStatus =
      (["waiting", "working", "stale"] as AgentStatus[]).find((t) => sessions.some((s) => s.status === t)) ?? "idle";
    return { agent, status };
  }),
);

const label = computed(() => birds.value.map((b) => `${AGENT_META[b.agent].name} ${b.status}`).join("，"));
</script>
