/**
 * AgentRegistry：应用引擎的组装根。
 *
 * 职责：持有全部 adapter，启动 ingest 服务与 spool 回收，把三平面
 * （push hook / pull watch / quota 轮询）汇入 StatusEngine + Ledger，
 * 对外输出 AppSnapshot 与变化通知。
 */

import { startIngestServer, type IngestServer } from '../ingest/server';
import { drainSpool } from '../ingest/spool';
import { BACKFILL_EPOCH, BACKFILL_WINDOW_MS, Ledger } from '../ledger/db';
import { estimateCostUsd } from '../ledger/pricing';
import { flagEnabled, loadSettings, saveSettings, type MurmurSettings } from '../settings';
import type { AgentAdapter } from '../agents/base';
import { createCodexAdapter } from '../agents/codex';
import { createCursorAdapter } from '../agents/cursor';
import { createKimiAdapter } from '../agents/kimi';
import { createOpencodeAdapter } from '../agents/opencode';
import { createZcodeAdapter } from '../agents/zcode';
import type { AgentEvent, AgentId, AgentSnapshot, AppSnapshot, InstallInfo, QuotaSnapshot } from '../types';
import { StatusEngine } from './status-engine';

/** quota 拉取间隔（额度变化慢，10 分钟足够）。 */
const QUOTA_INTERVAL_MS = 10 * 60_000;
/** watchdog 扫描周期。 */
const SWEEP_INTERVAL_MS = 15_000;
/** 台账保留清扫周期（events/quota/cursors 只进不出，每日压实一次）。 */
const PRUNE_INTERVAL_MS = 24 * 3600_000;

export class AgentRegistry {
  private engine = new StatusEngine();
  private ledger = new Ledger();
  private adapters: AgentAdapter[] = [];
  private installs = new Map<AgentId, InstallInfo>();
  private quotas = new Map<AgentId, QuotaSnapshot>();
  private ingest: IngestServer | null = null;
  private unwatchers = new Map<AgentId, () => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private unsubEngine: (() => void) | null = null;
  private settings: MurmurSettings = loadSettings();

  constructor() {
    this.adapters = [
      createKimiAdapter(),
      createZcodeAdapter(),
      createOpencodeAdapter(),
      createCodexAdapter(),
      createCursorAdapter(),
    ];
  }

  /** 订阅快照变化。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 去抖广播：拉取/回放风暴时合并成 ~80ms 一批。 */
  private notify() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const fn of this.listeners) fn();
    }, 80);
  }

  /** 需要落库的事件类型（心跳类 status/tool.call/turn.start 不落，避免噪音淹没）。 */
  private static LEDGER_KINDS = new Set(['usage', 'session.start', 'session.end', 'turn.end', 'permission.request']);

  /** 该 agent 的监听是否开着（settings.agents 缺省 true）。 */
  private isObserved(id: AgentId): boolean {
    return flagEnabled(this.settings.agents, id);
  }

  /** 该 agent 的 hook 上报是否开着（settings.hooks 缺省 true）。 */
  private isHookEnabled(id: AgentId): boolean {
    return flagEnabled(this.settings.hooks, id);
  }

  /** 事件统一入口：写台账 + 喂状态机 + 广播。超出回填窗口的旧事件不落库，只喂 engine 保留会话残态。 */
  private ingest_(e: AgentEvent) {
    // 未监听 agent 的事件一律丢弃：push 残留 POST 与 spool 补投都走这一口。
    if (!this.isObserved(e.agent)) return;
    if (AgentRegistry.LEDGER_KINDS.has(e.kind) && e.at >= Date.now() - BACKFILL_WINDOW_MS) {
      const cost = e.kind === 'usage' ? estimateCostUsd(e.model, e.tokens ?? { input: 0, output: 0 }) : 0;
      try {
        this.ledger.record(e, cost);
      } catch {}
    }
    this.engine.apply(e);
  }

  /** hook payload → 对应 adapter 翻译 → 事件。 */
  private translateHook = (agent: AgentId, payload: unknown) => {
    const adapter = this.adapters.find((a) => a.id === agent);
    // spool 落盘格式 {_spooledAt:秒, p:原 payload}：补投时把 at 钳回落盘时刻——
    // 宕机积压的旧事件按真实时间回放（回填语义），不冒充当下。存量裸 payload 直通。
    let inner = payload;
    let spooledAt: number | undefined;
    if (payload && typeof payload === 'object') {
      const w = payload as Record<string, unknown>;
      if (typeof w._spooledAt === 'number' && 'p' in w) {
        spooledAt = w._spooledAt * 1000;
        inner = w.p;
      }
    }
    const events = adapter?.translateHook?.(inner) ?? [];
    for (const e of events) this.ingest_(spooledAt ? { ...e, at: Math.min(e.at, spooledAt) } : e);
  };

  /** 启动：探测 → 装 hook → ingest 服务 → pull watchers → 定时器。 */
  async start() {
    for (const a of this.adapters) {
      try {
        this.installs.set(a.id, await a.detect());
      } catch {
        this.installs.set(a.id, {
          installed: false,
          hasCredentials: false,
          homeDir: '',
          hookInstalled: false,
          note: 'detect 失败',
        });
      }
    }

    this.ingest = startIngestServer({ translate: this.translateHook });
    drainSpool(this.translateHook);

    // 回填语义版本不一致（含首次启动/台账被清空）→ 清库清游标，watcher 全量重扫。
    // epoch 机制同时治愈旧版本污染数据（如历史事件被打上错误时间戳）。
    if (this.ledger.getMeta('backfillEpoch') !== BACKFILL_EPOCH || this.ledger.isUsageEmpty()) {
      this.rebuildLedger();
      this.ledger.setMeta('backfillEpoch', BACKFILL_EPOCH);
    }

    // 启动时自动装 hook（默认开）：只碰「监听中 + 已安装 + hook 未关」的 agent，merge 幂等。
    if (this.settings.autoInstallHooks) {
      for (const a of this.adapters) {
        if (!this.isObserved(a.id) || !this.isHookEnabled(a.id) || !this.installs.get(a.id)?.installed) continue;
        try {
          await a.installHooks();
          this.installs.set(a.id, await a.detect());
        } catch {
          // 单 agent 安装失败不影响整体；设置页可见 hookInstalled 状态。
        }
      }
    }

    for (const a of this.adapters) {
      if (!this.isObserved(a.id) || !this.installs.get(a.id)?.installed) continue;
      await this.startWatch(a);
    }

    this.unsubEngine = this.engine.onChange(() => this.notify());
    this.timers.push(setInterval(() => this.engine.sweep(), SWEEP_INTERVAL_MS));
    this.timers.push(setInterval(() => drainSpool(this.translateHook), 60_000));
    this.timers.push(setInterval(() => void this.refreshQuotas(), QUOTA_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pruneLedger(), PRUNE_INTERVAL_MS));
    this.pruneLedger();
    void this.refreshQuotas();
    this.notify();
  }

  /** 起一个 agent 的 pull watcher（重复调用前先停旧 watcher）。 */
  private async startWatch(a: AgentAdapter) {
    this.unwatchers.get(a.id)?.();
    this.unwatchers.delete(a.id);
    try {
      const off = await a.watch?.((e) => this.ingest_(e), this.ledger);
      if (off) this.unwatchers.set(a.id, off);
    } catch {
      // 单 adapter 失败不影响整体。
    }
  }

  /** 拉取各 agent 额度（失败静默回退上次快照）。UI 刷新按钮也走这条。 */
  async refreshQuotas() {
    // 并发：串行 await 最坏 ≈3×8s（codex 降级链两段各 8s），会撞 RPC 15s 上限。
    await Promise.allSettled(
      this.adapters.map(async (a) => {
        if (!a.quota || !this.isObserved(a.id) || !this.installs.get(a.id)?.hasCredentials) return;
        try {
          const q = await a.quota();
          if (q.error && q.windows.length === 0) {
            const last = this.ledger.lastQuota(a.id);
            this.quotas.set(a.id, last?.windows.length ? last : q);
          } else {
            this.quotas.set(a.id, q);
            this.ledger.saveQuota(q);
          }
        } catch {
          const last = this.ledger.lastQuota(a.id);
          if (last) this.quotas.set(a.id, last);
        }
      }),
    );
    this.notify();
  }

  /** ingest 服务端点描述（日志/设置页展示用）。 */
  ingestEndpoint(): string {
    return this.ingest ? `127.0.0.1:${this.ingest.endpoint.port}` : '未启动';
  }

  /** 按天 × agent × model 的 token 明细（用量页三图共用）。 */
  usageDaily(days: number) {
    return this.ledger.usageDaily(Date.now() - days * 86400_000);
  }

  /**
   * 重建台账：清库清游标，并重启各 watcher 触发全量重扫。
   * 注意必须重启——tailer 字节偏移、opencode rowid、zcode updated_at 都持有
   * 内存/闭包副本，只清 DB 游标的话增量续跑照旧，清了等于白清。
   * 重扫耗时不可控 → 后台跑，结果经 notify 流式上屏。
   */
  rebuildLedger() {
    this.ledger.resetForRebuild();
    for (const a of this.adapters) {
      if (!this.isObserved(a.id) || !this.installs.get(a.id)?.installed) continue;
      void this.startWatch(a);
    }
  }

  /** 台账保留清扫——失败静默（DB 被占等场景下轮再来）。 */
  private pruneLedger() {
    try {
      this.ledger.prune();
    } catch {}
  }

  /** 当前设置（RPC/主进程读；写一律走 updateSettings/setAgentHook/setAgentObserved）。 */
  getSettings(): MurmurSettings {
    return this.settings;
  }

  /** 应用设置补丁：持久化 + 引擎侧生效（agent/hook 开关有实时副作用）。 */
  async updateSettings(patch: Partial<MurmurSettings>): Promise<MurmurSettings> {
    const prev = this.settings;
    this.settings = { ...prev, ...patch, agents: { ...prev.agents, ...patch.agents }, hooks: { ...prev.hooks, ...patch.hooks } };
    saveSettings(this.settings);
    // agents/hooks 两张表的增删通过专用入口（setAgentObserved/setAgentHook）走副作用；
    // 这里仅兜底：被改成 false 的 agent 立即停观察，改成 true 的恢复观察。
    for (const a of this.adapters) {
      const was = flagEnabled(prev.agents, a.id);
      const now = flagEnabled(this.settings.agents, a.id);
      if (was === now) continue;
      if (now) await this.enableAgent(a);
      else await this.disableAgent(a);
    }
    this.notify();
    return this.settings;
  }

  /** 关监听：停 watcher + 卸载其 hook（用户 hook 偏好保留在 settings.hooks）。 */
  private async disableAgent(a: AgentAdapter) {
    this.unwatchers.get(a.id)?.();
    this.unwatchers.delete(a.id);
    this.quotas.delete(a.id);
    try {
      await a.uninstallHooks?.();
      this.installs.set(a.id, await a.detect());
    } catch {
      // 卸载失败不阻塞停用：pull 已停，push 残留由 ingest_ 的 isObserved 守卫挡。
    }
  }

  /** 开监听：重 detect + 起 watcher +（autoInstallHooks 且 hook 开）装回 hook。 */
  private async enableAgent(a: AgentAdapter) {
    try {
      this.installs.set(a.id, await a.detect());
    } catch {
      // detect 失败仍尝试 watch——installed 判空只是跳过下述动作。
    }
    if (!this.installs.get(a.id)?.installed) return;
    await this.startWatch(a);
    if (this.settings.autoInstallHooks && this.isHookEnabled(a.id)) {
      try {
        await a.installHooks();
        this.installs.set(a.id, await a.detect());
      } catch {
        // 装失败设置页可见状态，不影响观察。
      }
    }
    void this.refreshQuotas();
  }

  /** 设置页 per-agent 监听开关。 */
  async setAgentObserved(agent: AgentId, enabled: boolean): Promise<MurmurSettings> {
    if (flagEnabled(this.settings.agents, agent) === enabled) return this.settings;
    return this.updateSettings({ agents: { ...this.settings.agents, [agent]: enabled } });
  }

  /** 设置页 per-agent hook 开关：开=立即装，关=立即卸（保留他人条目）。 */
  async setAgentHook(agent: AgentId, enabled: boolean): Promise<MurmurSettings> {
    const a = this.adapters.find((x) => x.id === agent);
    if (!a) return this.settings;
    this.settings = { ...this.settings, hooks: { ...this.settings.hooks, [agent]: enabled } };
    saveSettings(this.settings);
    try {
      if (enabled && this.isObserved(agent) && this.installs.get(agent)?.installed) await a.installHooks();
      else if (!enabled) await a.uninstallHooks?.();
      this.installs.set(agent, await a.detect());
    } catch {
      // 装/卸失败留下次重试，detect 状态会如实反映。
    }
    this.notify();
    return this.settings;
  }

  /** 给监听中且 hook 开启的已安装 agent 装 hook（幂等）。返回各 agent 是否改动。 */
  async installAllHooks(): Promise<Record<AgentId, boolean>> {
    const out = {} as Record<AgentId, boolean>;
    for (const a of this.adapters) {
      if (!this.isObserved(a.id) || !this.isHookEnabled(a.id) || !this.installs.get(a.id)?.installed) {
        out[a.id] = false;
        continue;
      }
      try {
        out[a.id] = (await a.installHooks()).changed;
        this.installs.set(a.id, await a.detect());
      } catch {
        out[a.id] = false;
      }
    }
    return out;
  }

  /** 全量快照。被停用监听的 agent 保留在 agents 列表（disabled:true）供设置页显示，但不带会话/额度/用量。 */
  snapshot(): AppSnapshot {
    const sessions = this.engine.snapshot();
    const observed = new Set(this.adapters.filter((a) => this.isObserved(a.id)).map((a) => a.id));
    // 今日 + 近 7 日台账：本地零点起算的 token 合计（quota 之外始终可用的用量面）。
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const todayByAgent = new Map<AgentId, { tokens: number; costUsd: number }>();
    const weekByAgent = new Map<AgentId, { tokens: number; costUsd: number }>();
    const bump = (m: Map<AgentId, { tokens: number; costUsd: number }>, r: Record<string, number | string>) => {
      const id = r.agent as AgentId;
      const cur = m.get(id) ?? { tokens: 0, costUsd: 0 };
      cur.tokens += (r.input as number) + (r.output as number) + (r.cacheRead as number) + (r.cacheWrite as number);
      cur.costUsd += r.costUsd as number;
      m.set(id, cur);
    };
    for (const r of this.ledger.usageSince(null, dayStart) as Array<Record<string, number | string>>) {
      bump(todayByAgent, r);
    }
    for (const r of this.ledger.usageSince(null, Date.now() - 7 * 86400_000) as Array<Record<string, number | string>>) {
      bump(weekByAgent, r);
    }
    const agents: AgentSnapshot[] = this.adapters.map((a) => {
      const disabled = !observed.has(a.id);
      return {
        agent: a.id,
        install: this.installs.get(a.id) ?? {
          installed: false,
          hasCredentials: false,
          homeDir: '',
          hookInstalled: false,
        },
        disabled,
        sessions: disabled ? [] : sessions.filter((s) => s.agent === a.id),
        quota: disabled ? undefined : this.quotas.get(a.id),
        // 停监听后今日/本周也该消失——隐藏会话却挂着用量数字对不上。
        today: disabled ? undefined : todayByAgent.get(a.id),
        week: disabled ? undefined : weekByAgent.get(a.id),
      };
    });
    return { agents, overall: this.engine.overall(observed), generatedAt: Date.now() };
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.unsubEngine?.();
    for (const off of this.unwatchers.values()) off();
    this.unwatchers.clear();
    this.ingest?.close();
    this.ledger.close();
  }
}
