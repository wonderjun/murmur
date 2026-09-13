<template>
  <article class="overflow-hidden rounded-item border border-hairline bg-card shadow-raised" :data-agent="agent.agent">
    <button type="button" class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-foreground/[0.03]" :aria-expanded="expanded" @click="expanded = !expanded">
      <AgentIcon :agent="agent.agent" :size="28" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-[12.5px] font-semibold">{{ name }}</span>
          <span v-if="sessions.length > 1" class="font-mono text-[9.5px] tabular-nums text-faint">{{ sessions.length }} 个任务</span>
        </div>
        <p class="mt-0.5 truncate text-[10.5px] text-muted-foreground">{{ summary }}</p>
      </div>
      <span class="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[9.5px] font-semibold" :class="statusTone">
        <StatusDot :status="primaryStatus" :size="6" />
        {{ statusLabel }}
      </span>
      <ChevronDown :size="13" class="shrink-0 text-faint transition-transform duration-normal" :class="expanded ? 'rotate-180' : ''" />
    </button>

    <div v-if="expanded" class="border-t border-hairline/80">
      <div v-for="session in sessions" :key="session.sessionId" class="border-b border-hairline/60 px-3.5 py-2.5 last:border-b-0">
        <div class="flex items-start gap-2.5">
          <StatusDot :status="session.status" :size="7" class="mt-[5px]" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-2">
              <span class="text-[11.5px] font-medium leading-snug">{{ session.title || '未命名任务' }}</span>
              <span class="shrink-0 font-mono text-[9.5px] tabular-nums text-faint">{{ elapsed(session.startedAt) }}</span>
            </div>
            <p class="mt-1 truncate font-mono text-[9.5px] text-faint">{{ compactPath(session.cwd) }}</p>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              <span>{{ modelName(session.model) }}</span>
              <span>{{ statusDetail(session) }}</span>
              <span class="ml-auto font-mono tabular-nums">{{ fmt(tokens(session)) }} 令牌</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="quotaWindows.length" class="flex flex-wrap gap-1.5 border-t border-hairline/60 bg-raised/60 px-3.5 py-2.5">
        <span v-for="window in quotaWindows" :key="window.label" class="rounded-full border border-hairline bg-card px-2 py-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground">
          <span class="font-sans">{{ window.label }}</span> {{ window.usedPct }}%
        </span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown } from "lucide-vue-next";

import AgentIcon from "@/components/agent-icon.vue";
import StatusDot from "@/components/status-dot.vue";
import { AGENT_META } from "@/lib/agent-meta";

import type { AgentSnapshot, AgentStatus, SessionSnapshot } from "@core/types";

const props = defineProps<{ agent: AgentSnapshot }>();
const expanded = ref(true);
const name = computed(() => AGENT_META[props.agent.agent].name);
const sessions = computed(() => [...props.agent.sessions].sort((a, b) => b.lastEventAt - a.lastEventAt));
const quotaWindows = computed(() => props.agent.quota?.windows ?? []);
const primaryStatus = computed<AgentStatus>(() => {
  const order: AgentStatus[] = ["waiting", "working", "stale", "idle", "ended"];
  return order.find((status) => sessions.value.some((s) => s.status === status)) ?? "idle";
});
const statusLabel = computed(() => {
  const labels: Record<AgentStatus, string> = { waiting: "待处理", working: "工作中", stale: "已停止更新", idle: "空闲", ended: "已结束" };
  return labels[primaryStatus.value];
});
const statusTone = computed(() => {
  const tones: Record<AgentStatus, string> = { waiting: "bg-waiting/12 text-waiting", working: "bg-working/10 text-working", stale: "bg-stale/10 text-stale", idle: "bg-muted text-muted-foreground", ended: "bg-muted text-faint" };
  return tones[primaryStatus.value];
});
const summary = computed(() => {
  const s = sessions.value[0];
  if (!s) return props.agent.install.installed ? "已连接，等待任务" : "未检测到本地安装";
  return `${s.title || compactPath(s.cwd)} · ${statusText(s.status)}`;
});

function statusText(status: AgentStatus) {
  return { waiting: "等待你的处理", working: "正在更新", stale: "长时间没有更新", idle: "空闲", ended: "已结束" }[status];
}

function statusDetail(session: SessionSnapshot) {
  if (session.status === "waiting") return session.waitingReason === "approval" ? "等待批准" : session.waitingReason === "question" ? "等待回答" : "等待继续";
  if (session.status === "stale") return `最后更新 ${age(session.lastEventAt)}`;
  return `更新于 ${age(session.lastEventAt)}`;
}

function modelName(model?: string) {
  return model ? model.split("/").pop() : "未标注模型";
}

function compactPath(path?: string) {
  if (!path) return "未提供工作目录";
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function elapsed(start: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  if (minutes < 1) return "刚开始";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function age(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}

function tokens(session: SessionSnapshot) {
  return session.tokens.input + session.tokens.output + (session.tokens.cacheRead ?? 0) + (session.tokens.cacheWrite ?? 0);
}

function fmt(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
</script>
