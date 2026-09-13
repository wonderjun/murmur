<template>
  <div class="flex flex-col gap-4">
    <section class="setup-intro">
      <div class="flex items-end justify-between gap-3">
        <div>
          <p class="eyebrow text-accent">接入</p>
          <h1 class="mt-1 font-display text-[20px] font-semibold tracking-[-0.02em]">工具状态</h1>
        </div>
        <span class="font-mono text-[10px] tabular-nums text-faint">{{ connectedCount }}/{{ agents.length }} 已连接</span>
      </div>
      <p class="mt-2 max-w-[310px] text-[11px] leading-relaxed text-muted-foreground">Murmur 只读取本机工具。不同工具的观察方式不同，这里会把数据来源和额度状态分开说明。</p>
    </section>

    <div class="space-y-2">
      <article v-for="agent in agents" :key="agent.agent" class="setup-row" :data-agent="agent.agent">
        <div class="flex items-center gap-3">
          <AgentIcon :agent="agent.agent" :size="30" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[12.5px] font-semibold">{{ AGENT_META[agent.agent].name }}</span>
              <span v-if="agent.install.version" class="font-mono text-[9px] text-faint">{{ agent.install.version }}</span>
            </div>
            <p class="mt-1 truncate text-[10.5px] text-muted-foreground">{{ agent.install.note || homeLabel(agent) }}</p>
          </div>
          <span class="flex shrink-0 items-center gap-1.5 text-[10px] font-medium" :class="health(agent).tone">
            <span class="h-1.5 w-1.5 rounded-full" :class="health(agent).dot" />
            {{ health(agent).label }}
          </span>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline/70 pt-2.5 text-[10px] text-muted-foreground">
          <span><b class="font-normal text-faint">安装</b> {{ agent.install.installed ? '已发现' : '未发现' }}</span>
          <span><b class="font-normal text-faint">来源</b> {{ sourceLabel(agent) }}</span>
          <span><b class="font-normal text-faint">额度</b> {{ quotaLabel(agent) }}</span>
        </div>

        <div v-if="agent.quota?.windows.length" class="quota-strip mt-3">
          <div v-for="window in agent.quota.windows" :key="window.label" class="quota-window">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] font-medium text-foreground">{{ window.label }}</span>
              <span class="font-mono text-[10px] tabular-nums" :class="quotaTone(window.usedPct)">{{ window.usedPct }}%</span>
            </div>
            <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
              <span class="block h-full rounded-full transition-[width]" :class="quotaBar(window.usedPct)" :style="{ width: `${Math.min(window.usedPct, 100)}%` }" />
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 font-mono text-[9px] text-faint">
              <span>{{ quotaAmount(window) }}</span>
              <span>{{ resetText(window) }}</span>
            </div>
          </div>
        </div>
        <p v-else-if="agent.agent === 'zcode'" class="mt-3 border-t border-hairline/70 pt-2.5 text-[10px] text-faint">ZCode 使用本地任务索引和用量流水，官方凭据为加密格式，暂不提供额度。</p>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import AgentIcon from "@/components/agent-icon.vue";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { useMurmurStore } from "@/store/murmur";

import type { AgentSnapshot, QuotaWindow } from "@core/types";

const store = useMurmurStore();
const agents = computed(() => AGENT_ORDER.map((id) => store.snapshot?.agents.find((agent) => agent.agent === id)).filter((agent): agent is AgentSnapshot => Boolean(agent)));
const connectedCount = computed(() => agents.value.filter((agent) => agent.install.installed && !agent.disabled).length);

function homeLabel(agent: AgentSnapshot) {
  return agent.install.installed ? agent.install.homeDir : "未检测到本地数据";
}

function sourceLabel(agent: AgentSnapshot) {
  if (!agent.install.installed) return "等待安装";
  if (agent.disabled) return "已停用（设置页可开回）";
  if (agent.install.hookInstalled) return "上报 + 本地读取";
  return "本地读取";
}

function quotaLabel(agent: AgentSnapshot) {
  if (agent.quota?.windows.length) return `${agent.quota.windows.length} 个窗口`;
  if (agent.agent === "zcode") return "暂不提供";
  if (agent.install.hasCredentials) return "获取中";
  return "未配置";
}

function health(agent: AgentSnapshot) {
  if (!agent.install.installed) return { label: "未安装", tone: "text-faint", dot: "bg-faint" };
  if (agent.disabled) return { label: "已停用", tone: "text-faint", dot: "bg-ended" };
  if (agent.sessions.some((session) => session.status === "stale")) return { label: "需检查", tone: "text-stale", dot: "bg-stale" };
  if (agent.sessions.length || agent.install.hookInstalled) return { label: "已连接", tone: "text-working", dot: "bg-working" };
  return { label: "等待数据", tone: "text-waiting", dot: "bg-waiting" };
}

function quotaTone(usedPct: number) {
  return usedPct >= 90 ? "text-stale" : usedPct >= 70 ? "text-waiting" : "text-foreground";
}

function quotaBar(usedPct: number) {
  return usedPct >= 90 ? "bg-stale" : usedPct >= 70 ? "bg-waiting" : "bg-accent";
}

function quotaAmount(window: QuotaWindow) {
  if (window.used === undefined || window.limit === undefined) return "用量未提供";
  return `${fmt(window.used)} / ${fmt(window.limit)}`;
}

function resetText(window: QuotaWindow) {
  if (!window.resetsAt) return "无重置时间";
  const ms = window.resetsAt - Date.now();
  if (ms <= 0) return "正在重置";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}天后重置`;
  if (hours) return `${hours}小时后重置`;
  return `${minutes}分钟后重置`;
}

function fmt(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
</script>
