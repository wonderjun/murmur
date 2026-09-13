<template>
  <!-- 设计板：#/design 进入，token/组件状态矩阵先行验证视觉语言。 -->
  <div class="flex h-full flex-col gap-6 overflow-auto bg-background p-5">
    <div>
      <h1 class="font-display text-[18px] font-semibold italic">Murmur 设计板</h1>
      <p class="mt-1 text-[12px] text-muted-foreground">token / 字标 / 栖枝 / 状态点 / 品牌标 / 额度胶囊 / 图表悬浮 / 卡片样例。</p>
    </div>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">展示字体（Lora，CJK 回退苹方）</h2>
      <div class="rounded-item border border-hairline bg-card p-3.5 shadow-raised">
        <p class="font-display text-[22px] font-semibold italic leading-tight">Murmur</p>
        <p class="mt-1 font-display text-[14px] leading-snug">重构 datasource 三层架构 · quiet morning</p>
        <p class="mt-1 font-display text-[14px] italic text-muted-foreground">现在很安静 · everything perched</p>
        <p class="mt-2 font-mono text-[12px] tabular-nums">4.2G · 715.5M · 09-13 12:00</p>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">栖枝（当前快照）</h2>
      <div class="rounded-item border border-hairline bg-card px-3.5 py-3 shadow-raised">
        <PerchStrip />
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">状态点</h2>
      <div class="flex flex-wrap gap-5">
        <span v-for="s in STATUSES" :key="s" class="flex flex-col items-center gap-1.5">
          <StatusDot :status="s" :size="10" />
          <span class="font-mono text-[10px] text-muted-foreground">{{ s }}</span>
        </span>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">品牌徽标</h2>
      <div class="flex flex-wrap gap-4">
        <span v-for="a in AGENTS" :key="a" class="flex flex-col items-center gap-1.5">
          <AgentIcon :agent="a" :size="32" />
          <span class="text-[10px] text-muted-foreground">{{ AGENT_META[a].name }}</span>
        </span>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">额度胶囊</h2>
      <div class="flex flex-wrap gap-2">
        <QuotaPill :window="{ label: '5h', usedPct: 34, resetsAt: Date.now() + 2.2 * 3600e3 }" />
        <QuotaPill :window="{ label: '每周', usedPct: 71, resetsAt: Date.now() + 52 * 3600e3 }" />
        <QuotaPill :window="{ label: '每月', usedPct: 93, resetsAt: Date.now() + 300 * 3600e3 }" />
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">图表悬浮（悬停试试，瞬时无延迟）</h2>
      <div class="relative h-[120px] rounded-item border border-hairline bg-card shadow-raised">
        <ChartTip :tip="{ x: 80, y: 60, place: 'top' }">
          <p class="whitespace-nowrap text-[10.5px]"><span class="font-mono tabular-nums text-faint">09-11</span><span class="mx-1.5 text-faint">·</span><span class="font-mono tabular-nums font-medium">426.5M 令牌</span></p>
        </ChartTip>
        <ChartTip :tip="{ x: 300, y: 20, place: 'left' }">
          <p class="text-[11px] font-semibold">9月11日 周五</p>
          <div class="mt-1.5 flex min-w-[150px] flex-col gap-1">
            <span v-for="row in DEMO_TIP_ROWS" :key="row.name" class="flex items-center gap-1.5 text-[10.5px]">
              <span class="h-[6px] w-[6px] shrink-0 rounded-full" :style="{ background: row.color }" />
              <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ row.name }}</span>
              <span class="font-mono tabular-nums">{{ row.value }}</span>
            </span>
          </div>
        </ChartTip>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">模型折线（准星 + 明细卡）</h2>
      <div class="rounded-item border border-hairline bg-card px-3 py-2.5 shadow-raised">
        <ModelLineChart :days="DEMO_DAYS" :series="DEMO_SERIES" />
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">设置开关</h2>
      <div class="flex max-w-[360px] flex-col gap-3 rounded-item border border-hairline bg-card p-3.5 shadow-raised">
        <SwitchRow label="登录时启动" desc="登录 macOS 后自动打开 Murmur" :checked="true" @update:checked="() => {}" />
        <SwitchRow label="「轮到你了」通知" desc="有待处理会话新增时发系统通知" :checked="false" @update:checked="() => {}" />
        <SwitchRow label="禁用态" desc="未安装的工具不可开关" :checked="false" :disabled="true" @update:checked="() => {}" />
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">色板</h2>
      <div class="flex flex-wrap gap-2">
        <span
          v-for="t in SURFACES"
          :key="t"
          class="flex h-12 w-[92px] items-end rounded-lg border border-hairline p-1.5"
          :style="{ background: `var(${t})` }"
        >
          <span class="font-mono text-[9px] text-foreground/70">{{ t }}</span>
        </span>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">卡片样例</h2>
      <div class="flex max-w-[360px] flex-col gap-2">
        <AgentRow :agent="demoAgent('kimi', 'working')" />
        <AgentRow :agent="demoAgent('zcode', 'waiting')" />
        <AgentRow :agent="demoAgent('opencode', 'idle')" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import AgentIcon from "@/components/agent-icon.vue";
import AgentRow from "@/components/agent-row.vue";
import ChartTip from "@/components/chart-tip.vue";
import ModelLineChart from "@/components/model-line-chart.vue";
import PerchStrip from "@/components/perch-strip.vue";
import QuotaPill from "@/components/quota-pill.vue";
import StatusDot from "@/components/status-dot.vue";
import SwitchRow from "@/components/switch-row.vue";
import { AGENT_META } from "@/lib/agent-meta";

import type { AgentId, AgentSnapshot, AgentStatus } from "@core/types";

const STATUSES: AgentStatus[] = ["working", "waiting", "idle", "stale", "ended"];
const AGENTS = Object.keys(AGENT_META) as AgentId[];
const SURFACES = ["--background", "--raised", "--card", "--muted", "--hairline", "--foreground", "--muted-foreground"];

const DEMO_TIP_ROWS = [
  { name: "grok-4.6", value: "7.9M", color: "var(--chart-2)" },
  { name: "MiniMax-M3", value: "77k", color: "var(--chart-6)" },
  { name: "LongCat-2.0", value: "65k", color: "var(--chart-1)" },
];

const DEMO_DAYS = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.now() - (6 - i) * 86400_000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { day, label: i === 6 ? "今天" : day.slice(5) };
});

const DEMO_SERIES = [
  { name: "kimi-for-coding", color: "var(--chart-1)", values: [12, 30, 8, 42, 20, 95, 40].map((v) => v * 1.4e6) },
  { name: "gpt-5.6-terra", color: "var(--chart-2)", values: [60, 52, 40, 6, 4, 70, 18].map((v) => v * 1e6) },
  { name: "k3-256k", color: "var(--chart-3)", values: [30, 36, 20, 4, 2, 60, 10].map((v) => v * 1e6) },
];

function demoAgent(agent: AgentId, status: AgentStatus): AgentSnapshot {
  return {
    agent,
    install: { installed: true, hasCredentials: true, homeDir: "", hookInstalled: true },
    disabled: false,
    quota:
      agent === "kimi"
        ? {
            agent,
            plan: "Pro",
            fetchedAt: Date.now(),
            windows: [
              { label: "5h", usedPct: 42, resetsAt: Date.now() + 2.2 * 3600e3 },
              { label: "每周", usedPct: 67, resetsAt: Date.now() + 52 * 3600e3 },
            ],
          }
        : undefined,
    sessions: [
      {
        agent,
        sessionId: "demo-session-1",
        status,
        waitingReason: status === "waiting" ? "turn-end" : undefined,
        cwd: "~/Documents/flow",
        title: "重构 datasource 三层架构",
        model: "kimi-k2.7-code",
        lastEventAt: Date.now() - 60_000,
        startedAt: Date.now() - 600_000,
        tokens: { input: 42000, output: 8100, cacheRead: 9000 },
        costUsd: 0.12,
      },
    ],
  };
}
</script>
