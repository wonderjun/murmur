<template>
  <div class="flex flex-col gap-4">
    <div v-if="store.loading" class="space-y-3" aria-live="polite">
      <div class="h-20 animate-pulse rounded-item bg-card shadow-raised" />
      <div class="h-14 animate-pulse rounded-item bg-card shadow-raised" />
      <div class="h-14 animate-pulse rounded-item bg-card shadow-raised" />
    </div>

    <template v-else>
      <!-- 尺规索引条：计数 + 新鲜度，上下 hairline 夹出版面节奏 -->
      <section class="flex items-center justify-between border-y border-hairline py-2">
        <div class="flex items-center gap-3.5 text-[10.5px] text-muted-foreground">
          <span>
            运行中
            <span class="ml-1 font-mono tabular-nums" :class="workingSessions.length ? 'font-medium text-working' : 'text-faint'">{{ workingSessions.length }}</span>
          </span>
          <span>
            需处理
            <span class="ml-1 font-mono tabular-nums" :class="waitingSessions.length ? 'font-medium text-waiting' : 'text-faint'">{{ waitingSessions.length }}</span>
          </span>
          <span>
            今日令牌
            <span class="ml-1 font-mono tabular-nums" :class="store.todayTokens ? 'font-medium text-foreground' : 'text-faint'">{{ store.todayTokens ? fmt(store.todayTokens) : '·' }}</span>
          </span>
        </div>
        <span class="font-mono text-[9.5px] tabular-nums text-faint">{{ freshness }}</span>
      </section>

      <!-- 头条：waiting 的第一条会话，琥珀左边条 + 衬线标题 -->
      <section
        v-if="waitingSessions.length"
        class="relative overflow-hidden rounded-item border border-hairline bg-card shadow-raised"
        aria-live="polite"
      >
        <span class="absolute inset-y-0 left-0 w-[2.5px] bg-waiting" />
        <div class="px-3.5 py-3">
          <p class="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-waiting">
            轮到你了 · {{ agentName(waitingSessions[0].agent) }}
          </p>
          <p class="mt-1.5 font-display text-[14.5px] font-medium leading-snug">
            {{ waitingSessions[0].title || '一个任务正在等你继续' }}
          </p>
          <p class="mt-1 text-[10.5px] text-muted-foreground">
            {{ waitingReason(waitingSessions[0].waitingReason) }} · {{ age(waitingSessions[0].lastEventAt) }}
          </p>
        </div>
        <div v-if="waitingSessions.length > 1" class="border-t border-hairline px-3.5 py-2 text-[10.5px] text-muted-foreground">
          还有 {{ waitingSessions.length - 1 }} 个任务等待处理
        </div>
      </section>

      <section v-if="activeAgents.length" class="space-y-2">
        <div class="flex items-center gap-2 px-0.5">
          <span class="text-[10px] font-semibold tracking-[0.12em] text-faint">正在发生</span>
          <span class="h-px flex-1 bg-hairline" />
          <span class="font-mono text-[10px] tabular-nums text-faint">{{ activeSessions.length }}</span>
        </div>
        <AgentRow v-for="agent in activeAgents" :key="agent.agent" :agent="agent" />
      </section>

      <section v-if="staleSessions.length" class="space-y-2">
        <div class="flex items-center gap-2 px-0.5">
          <span class="text-[10px] font-semibold uppercase tracking-[0.16em] text-stale">已停止更新</span>
          <span class="h-px flex-1 bg-stale/20" />
        </div>
        <div v-for="session in staleSessions" :key="session.sessionId" class="flex items-center gap-3 rounded-item border border-stale/25 bg-stale/8 px-3 py-2.5">
          <AgentIcon :agent="session.agent" :size="26" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-[12px] font-medium">{{ session.title || '未命名任务' }}</span>
              <StatusDot :status="session.status" :size="7" />
            </div>
            <p class="mt-0.5 truncate text-[10.5px] text-muted-foreground">{{ agentName(session.agent) }} · {{ age(session.lastEventAt) }}没有更新</p>
          </div>
        </div>
      </section>

      <div v-if="!activeSessions.length && !staleSessions.length" class="rounded-item border border-hairline bg-card px-4 py-10 text-center shadow-raised">
        <MurmurMark :size="30" class="mx-auto text-faint" />
        <p class="mt-3.5 font-display text-[16px] italic">现在很安静</p>
        <p class="mt-1.5 text-[11px] text-muted-foreground">启动一个工具后，Murmur 会在这里显示它的任务。</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import AgentIcon from "@/components/agent-icon.vue";
import AgentRow from "@/components/agent-row.vue";
import MurmurMark from "@/components/murmur-mark.vue";
import StatusDot from "@/components/status-dot.vue";
import { AGENT_META } from "@/lib/agent-meta";
import { useMurmurStore } from "@/store/murmur";

import type { AgentId, WaitingReason } from "@core/types";

const store = useMurmurStore();
const sessions = computed(() => store.allSessions);
const waitingSessions = computed(() => sessions.value.filter((s) => s.status === "waiting"));
const workingSessions = computed(() => sessions.value.filter((s) => s.status === "working"));
const staleSessions = computed(() => sessions.value.filter((s) => s.status === "stale"));
const activeSessions = computed(() => sessions.value.filter((s) => ["waiting", "working"].includes(s.status)));
const activeAgents = computed(() =>
  (store.snapshot?.agents ?? []).filter((a) => a.sessions.some((s) => ["waiting", "working"].includes(s.status))),
);
const freshness = computed(() => store.snapshot ? `更新于 ${age(store.snapshot.generatedAt)}` : "连接中");

function agentName(agent: AgentId) {
  return AGENT_META[agent].name;
}

function waitingReason(reason?: WaitingReason) {
  if (reason === "approval") return "等待批准";
  if (reason === "question") return "等待回答";
  return "本轮完成，等待继续";
}

function age(at: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}

function fmt(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
</script>
