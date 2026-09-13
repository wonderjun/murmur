<template>
  <div class="flex flex-col gap-4">
    <section class="setup-intro">
      <div class="flex items-end justify-between gap-3">
        <div>
          <p class="eyebrow text-accent">设置</p>
          <h1 class="mt-1 font-display text-[20px] font-semibold tracking-[-0.02em]">偏好</h1>
        </div>
      </div>
      <p class="mt-2 max-w-[310px] text-[11px] leading-relaxed text-muted-foreground">Murmur 只做状态呈现。这里控制它怎么启动、怎么出现、观察哪些工具。</p>
    </section>

    <div v-if="!snap" class="text-[11px] text-faint">设置读取中…</div>

    <template v-else>
      <!-- 通用 -->
      <section class="setup-row flex flex-col gap-3">
        <h2 class="eyebrow text-faint">通用</h2>
        <SwitchRow
          label="登录时启动"
          :desc="snap.runtime.canLaunchAtLogin ? '登录 macOS 后自动打开 Murmur' : '仅打包版本可用'"
          :checked="snap.runtime.launchAtLogin"
          :disabled="!snap.runtime.canLaunchAtLogin"
          @update:checked="(v) => save({ launchAtLogin: v })"
        />
        <SwitchRow
          label="在 Dock 中显示"
          desc="关闭后只保留菜单栏图标，应用不出现在 Dock 与 Cmd-Tab"
          :checked="snap.runtime.dockIconVisible"
          @update:checked="(v) => save({ showDockIcon: v })"
        />
        <SwitchRow
          label="「轮到你了」通知"
          desc="有待处理会话新增时发系统通知；面板打开时不发"
          :checked="snap.settings.notifyOnWaiting"
          @update:checked="(v) => save({ notifyOnWaiting: v })"
        />
      </section>

      <!-- 工具监听 -->
      <section class="setup-row flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <h2 class="eyebrow text-faint">监听</h2>
          <button
            type="button"
            class="text-[10.5px] font-medium text-accent transition-colors duration-fast hover:text-foreground"
            @click="reinstallAll"
          >
            全部重新接入
          </button>
        </div>
        <SwitchRow
          label="启动时自动接入 hook"
          desc="给已安装且被监听的工具补齐上报配置；关闭后仍可在下方逐个开"
          :checked="snap.settings.autoInstallHooks"
          @update:checked="(v) => save({ autoInstallHooks: v })"
        />
      </section>

      <article v-for="agent in agents" :key="agent.agent" class="setup-row" :data-agent="agent.agent">
        <div class="flex items-center gap-3">
          <AgentIcon :agent="agent.agent" :size="28" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[12.5px] font-semibold">{{ AGENT_META[agent.agent].name }}</span>
              <span v-if="agent.install.version" class="font-mono text-[9px] text-faint">{{ agent.install.version }}</span>
            </div>
            <p class="mt-0.5 text-[10px] text-muted-foreground">{{ observeStatus(agent) }}</p>
          </div>
          <SwitchRoot
            :model-value="observed(agent)"
            :disabled="!agent.install.installed"
            class="relative h-[18px] w-[30px] shrink-0 rounded-full bg-foreground/15 transition-colors duration-fast data-[state=checked]:bg-accent data-[disabled]:opacity-40"
            @update:model-value="(v: boolean) => setObserved(agent.agent, v)"
          >
            <SwitchThumb
              class="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-card shadow-raised transition-transform duration-fast data-[state=checked]:translate-x-[14px]"
            />
          </SwitchRoot>
        </div>

        <template v-if="observed(agent)">
          <div class="mt-2.5 flex items-center justify-between gap-3 border-t border-hairline/70 pl-9 pt-2.5">
            <div class="min-w-0 flex-1">
              <p class="text-[11px] text-muted-foreground">实时上报 hook</p>
              <p class="mt-0.5 text-[10px] text-faint">{{ hookStatus(agent) }}</p>
            </div>
            <SwitchRoot
              :model-value="hookOn(agent)"
              class="relative h-[18px] w-[30px] shrink-0 rounded-full bg-foreground/15 transition-colors duration-fast data-[state=checked]:bg-accent data-[disabled]:opacity-40"
              @update:model-value="(v: boolean) => setHook(agent.agent, v)"
            >
              <SwitchThumb
                class="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-card shadow-raised transition-transform duration-fast data-[state=checked]:translate-x-[14px]"
              />
            </SwitchRoot>
          </div>
          <p v-if="!hookOn(agent)" class="mt-1.5 pl-9 text-[10px] leading-relaxed text-muted-foreground">{{ HOOK_IMPACT[agent.agent] }}</p>
        </template>
        <p v-else class="mt-2.5 border-t border-hairline/70 pt-2.5 text-[10px] leading-relaxed text-muted-foreground">{{ OBSERVE_IMPACT }}</p>
      </article>

      <!-- 数据 -->
      <section class="setup-row flex flex-col gap-3">
        <h2 class="eyebrow text-faint">数据</h2>
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-[12px] font-medium">本地台账</p>
            <p class="mt-0.5 text-[10px] text-muted-foreground">清空事件与用量后由各工具本地数据全量重扫</p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors duration-fast"
            :class="rebuildArmed ? 'border-accent bg-accent-soft text-foreground' : 'border-hairline bg-raised text-muted-foreground hover:text-foreground'"
            @click="rebuild"
          >
            {{ rebuildArmed ? "再点一次确认" : "重建" }}
          </button>
        </div>
        <button type="button" class="flex items-center justify-between gap-3 text-left" @click="store.openDataDir()">
          <div class="min-w-0 flex-1">
            <p class="text-[12px] font-medium">数据目录</p>
            <p class="mt-0.5 truncate font-mono text-[9.5px] text-faint">{{ snap.runtime.dataDir }}</p>
          </div>
          <FolderOpen :size="13" class="shrink-0 text-faint" />
        </button>
      </section>

      <!-- 关于 -->
      <section class="setup-row flex flex-col gap-1.5">
        <h2 class="eyebrow text-faint">关于</h2>
        <div class="flex items-center justify-between text-[11px]">
          <span class="text-muted-foreground">版本</span>
          <span class="font-mono tabular-nums text-faint">{{ snap.runtime.version }} · {{ snap.runtime.channel }}</span>
        </div>
        <div class="flex items-center justify-between text-[11px]">
          <span class="text-muted-foreground">上报端点</span>
          <span class="font-mono tabular-nums text-faint">{{ snap.runtime.ingestEndpoint }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FolderOpen } from "lucide-vue-next";
import { SwitchRoot, SwitchThumb } from "reka-ui";

import AgentIcon from "@/components/agent-icon.vue";
import SwitchRow from "@/components/switch-row.vue";
import { AGENT_META, AGENT_ORDER, HOOK_IMPACT, OBSERVE_IMPACT } from "@/lib/agent-meta";
import { useMurmurStore } from "@/store/murmur";

import type { MurmurSettings } from "@core/settings";
import type { AgentId, AgentSnapshot } from "@core/types";

const store = useMurmurStore();
const snap = computed(() => store.settingsSnap);
const agents = computed(() =>
  AGENT_ORDER.map((id) => store.snapshot?.agents.find((a) => a.agent === id)).filter((a): a is AgentSnapshot => Boolean(a)),
);

const rebuildArmed = ref(false);
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => store.loadSettings());

function observed(agent: AgentSnapshot) {
  return snap.value ? snap.value.settings.agents[agent.agent] !== false : !agent.disabled;
}

function hookOn(agent: AgentSnapshot) {
  return snap.value ? snap.value.settings.hooks[agent.agent] !== false : agent.install.hookInstalled;
}

function observeStatus(agent: AgentSnapshot) {
  if (!agent.install.installed) return "未安装";
  if (agent.disabled) return "已停用监听";
  return agent.sessions.length ? `${agent.sessions.length} 个活跃会话` : "已连接";
}

function hookStatus(agent: AgentSnapshot) {
  if (!hookOn(agent)) return "已关闭";
  if (agent.install.hookInstalled) return "已注入";
  return agent.install.note ?? "待安装";
}

async function save(patch: Partial<MurmurSettings>) {
  await store.updateSettings(patch);
}

async function setObserved(agent: AgentId, enabled: boolean) {
  await store.setAgentObserved(agent, enabled);
}

async function setHook(agent: AgentId, enabled: boolean) {
  await store.setAgentHook(agent, enabled);
}

async function reinstallAll() {
  await store.installHooks();
  await store.loadSettings();
}

async function rebuild() {
  if (!rebuildArmed.value) {
    rebuildArmed.value = true;
    rebuildTimer = setTimeout(() => (rebuildArmed.value = false), 3000);
    return;
  }
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildArmed.value = false;
  await store.rebuildLedger();
}
</script>
