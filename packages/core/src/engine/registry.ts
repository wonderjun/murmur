/**
 * AgentRegistry：应用引擎的组装根。
 *
 * 职责：持有全部 adapter，启动 ingest 服务与 spool 回收，把三平面
 * （push hook / pull watch / quota 轮询）汇入 StatusEngine + Ledger，
 * 对外输出 AppSnapshot 与变化通知。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadCredentials, maskKey, saveCredentials, type ByokStore } from '../credentials';
import { startIngestServer, type IngestServer } from '../ingest/server';
import { drainSpool } from '../ingest/spool';
import { BACKFILL_EPOCH, BACKFILL_WINDOW_MS, Ledger } from '../ledger/db';
import { estimateCostUsd } from '../ledger/pricing';
import { MURMUR_HOME } from '../paths';
import { fallbackQuota, unavailable } from '../quota/common';
import { flagEnabled, loadSettings, saveSettings, type MurmurSettings } from '../settings';
import type { AgentAdapter } from '../agents/base';
import { defaultAdapters } from '../agents/default';
import type {
  AgentEvent,
  AgentId,
  AgentSnapshot,
  AppSnapshot,
  DiagnosticsSnapshot,
  HookTestResult,
  InstallInfo,
  QuotaSnapshot,
  SessionDeleteResult,
  StoredSession,
} from '../types';
import { SELFTEST_PREFIX, assembleDiagnostics, runHookTest } from './diagnostics';
import { STALE_AFTER_MS, StatusEngine } from './status-engine';

/** quota 拉取间隔（额度变化慢，10 分钟足够）。 */
const QUOTA_INTERVAL_MS = 10 * 60_000;
/** watchdog 扫描周期。 */
const SWEEP_INTERVAL_MS = 15_000;
/** 快照携带的最近结束会话条数上限（「最近结束」折叠组）。 */
const RECENTLY_ENDED_LIMIT = 8;
/** 台账保留清扫周期（events/quota/cursors 只进不出，每日压实一次）。 */
const PRUNE_INTERVAL_MS = 24 * 3600_000;

/** AgentRegistry 组装选项：全部可省，缺省即生产形态（8 家真 adapter + MURMUR_HOME 数据面 + ingest 服务）。 */
export interface RegistryOptions {
  /** 测试注入：替换默认 adapter 集（fake 边界，不探测真机目录）。 */
  adapters?: AgentAdapter[];
  /** settings/credentials/台账的落盘根（缺省 MURMUR_HOME；测试钉沙箱目录）。 */
  dataDir?: string;
  /** 不起 ingest 服务、不做 spool 补投（测试不绑真实端口、不写 endpoint）。 */
  skipIngest?: boolean;
}

export class AgentRegistry {
  private engine = new StatusEngine();
  private ledger: Ledger;
  private adapters: AgentAdapter[];
  private readonly dataDir: string;
  private readonly skipIngest: boolean;
  private installs = new Map<AgentId, InstallInfo>();
  private quotas = new Map<AgentId, QuotaSnapshot>();
  /** push 平面活性：最近一次 hook 上报到达时刻（诊断页「最近上报」）。 */
  private lastHookAt = new Map<AgentId, number>();
  /** pull 平面故障：watch() 启动抛错的最近一次消息（诊断页展示）。 */
  private watchErrors = new Map<AgentId, string>();
  private ingest: IngestServer | null = null;
  private unwatchers = new Map<AgentId, () => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private unsubEngine: (() => void) | null = null;
  private settings: MurmurSettings;
  /** BYOK 凭据（~/.murmur/credentials.json）：用户自填 key，永不进 settings/RPC 明文。 */
  private byok: ByokStore;
  /**
   * 快照缓存：同一变更周期内只聚合一次（两次 SQL 用量聚合 × 每次广播被
   * 托盘/通知/RPC 推送共用）。失效契约——任何改变快照内容的写入路径必须
   * 同步走到 notify() 或 engine.onChange；snapshot() 返回的对象调用方只读。
   */
  private snapshotCache: AppSnapshot | null = null;

  constructor(opts: RegistryOptions = {}) {
    this.dataDir = opts.dataDir ?? MURMUR_HOME;
    this.skipIngest = opts.skipIngest ?? false;
    this.adapters = opts.adapters ?? defaultAdapters();
    this.settings = loadSettings(this.dataDir);
    this.byok = loadCredentials(this.dataDir);
    this.ledger = new Ledger(this.dataDir);
  }

  /** 订阅快照变化。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 去抖广播：拉取/回放风暴时合并成 ~80ms 一批。调用即失效快照缓存（变更已发生）。 */
  private notify() {
    this.snapshotCache = null;
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
      } catch {
        // 台账写失败（DB 锁/磁盘）不阻断状态机——台账是审计面，会话态在内存引擎。
      }
    }
    this.engine.apply(e);
  }

  /**
   * hook payload → 对应 adapter 翻译 → 事件。push 平面的唯一入口：
   * ingest 服务与 spool 补投共用，测试也经它驱动「监听关闭后的 push 残留」。
   */
  translateHook = (agent: AgentId, payload: unknown) => {
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
    // marker 会话不算真实上报——「最近上报」语义留给真 agent 事件。
    if (events.length && !events[0].sessionId.startsWith(SELFTEST_PREFIX)) this.lastHookAt.set(agent, Date.now());
    for (const e of events) this.ingest_(spooledAt ? { ...e, at: Math.min(e.at, spooledAt) } : e);
  };

  /** 启动：探测 → 装 hook → ingest 服务 → pull watchers → 定时器。 */
  async start() {
    for (const a of this.adapters) {
      try {
        this.installs.set(a.id, await a.detect());
      } catch {
        // 单 agent 探测失败不阻断启动，按未安装继续处理其余 agent。
        this.installs.set(a.id, {
          installed: false,
          hasCredentials: false,
          homeDir: '',
          hookInstalled: false,
          note: 'detect 失败',
        });
      }
    }

    if (!this.skipIngest) {
      this.ingest = startIngestServer({ translate: this.translateHook });
      drainSpool(this.translateHook);
    }

    // 回填语义版本不一致（含首次启动/台账被清空）→ 清库清游标，watcher 全量重扫。
    // epoch 机制同时治愈旧版本污染数据（如历史事件被打上错误时间戳）。
    try {
      if (this.ledger.getMeta('backfillEpoch') !== BACKFILL_EPOCH || this.ledger.isUsageEmpty()) {
        this.rebuildLedger();
        this.ledger.setMeta('backfillEpoch', BACKFILL_EPOCH);
      }
    } catch {
      // 台账被占用时跳过本轮清库：watcher 照常启动，下次启动再对账。
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

    this.unsubEngine = this.engine.onChange(() => {
      // 状态机变更同步失效缓存：去抖广播落地前的 snapshot() 也不能回旧账。
      this.snapshotCache = null;
      this.notify();
    });
    this.timers.push(setInterval(() => this.engine.sweep(), SWEEP_INTERVAL_MS));
    if (!this.skipIngest) this.timers.push(setInterval(() => drainSpool(this.translateHook), 60_000));
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
      this.watchErrors.delete(a.id);
    } catch (e) {
      // 单 adapter 失败不影响整体；留诊断可见的错误面。
      this.watchErrors.set(a.id, e instanceof Error ? e.message : String(e));
    }
  }

  /** 拉取各 agent 额度（失败静默回退上次快照）。UI 刷新按钮也走这条。 */
  async refreshQuotas() {
    // 并发：串行 await 最坏 ≈3×8s（codex 降级链两段各 8s），会撞 RPC 15s 上限。
    await Promise.allSettled(
      this.adapters.map(async (a) => {
        if (!a.quota || !this.isObserved(a.id)) return;
        // 拉取前提：本地凭据可读 或 用户配了 BYOK key（zcode 这种本地凭据加密的 agent）。
        if (!this.installs.get(a.id)?.hasCredentials && !this.byok[a.id]?.apiKey) return;
        try {
          const q = await a.quota(this.byok[a.id]);
          if (q.error && q.windows.length === 0) {
            this.quotas.set(
              a.id,
              fallbackQuota(this.quotas.get(a.id), () => this.ledger.lastQuota(a.id), q),
            );
          } else {
            this.quotas.set(a.id, q);
            try {
              this.ledger.saveQuota(q);
            } catch {
              // 落库失败留着刚拿到的内存快照，不能用更旧的历史把它盖掉。
            }
          }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          this.quotas.set(
            a.id,
            fallbackQuota(this.quotas.get(a.id), () => this.ledger.lastQuota(a.id), unavailable(a.id, reason)),
          );
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

  /** 任意起点（ms epoch）的 token 明细（用量页区间筛选）。 */
  usageDailySince(sinceMs: number) {
    return this.ledger.usageDaily(sinceMs);
  }

  /**
   * 重建台账：清库清游标，并重启各 watcher 触发全量重扫。
   * 注意必须重启——tailer 字节偏移、opencode rowid、zcode updated_at 都持有
   * 内存/闭包副本，只清 DB 游标的话增量续跑照旧，清了等于白清。
   * 重扫耗时不可控 → 后台跑，结果经 notify 流式上屏。
   */
  rebuildLedger() {
    this.snapshotCache = null; // 台账清空即用量聚合变脸，缓存立刻作废。
    this.ledger.resetForRebuild();
    for (const a of this.adapters) {
      if (!this.isObserved(a.id) || !this.installs.get(a.id)?.installed) continue;
      void this.startWatch(a);
    }
  }

  /** 按 agent 的最近盘点缓存（revealSession 查路径用，免重扫）。 */
  private lastSessionScan = new Map<AgentId, StoredSession[]>();

  /** 单 agent 会话产物盘点（清理页渐进加载）：扫一家标一家，快照命中或 mtime 新鲜的标 active 禁删。 */
  async scanAgentSessions(agent: AgentId): Promise<StoredSession[]> {
    const a = this.adapters.find((x) => x.id === agent);
    const items = a?.scanSessions ? await a.scanSessions() : [];
    const live = new Set(this.engine.snapshot().map((s) => `${s.agent}:${s.sessionId}`));
    const fresh = Date.now() - STALE_AFTER_MS;
    for (const s of items) {
      s.active =
        live.has(`${s.agent}:${s.id}`) || live.has(`${s.agent}:${s.id.replace(/^chat:/, '')}`) || s.modifiedAt > fresh;
    }
    this.lastSessionScan.set(agent, items);
    return items;
  }

  /**
   * 批量删除会话产物：active 会话拒删；trash 由主进程注入（Utils.moveToTrash），
   * core 不碰桌面 API。单 adapter 异常不影响其余，per-item 回报。
   */
  async deleteSessions(
    refs: { agent: AgentId; id: string }[],
    trash: (path: string) => boolean,
  ): Promise<SessionDeleteResult[]> {
    const live = new Set(this.engine.snapshot().map((s) => `${s.agent}:${s.sessionId}`));
    const results: SessionDeleteResult[] = [];
    const byAgent = new Map<AgentId, string[]>();
    for (const r of refs) {
      if (live.has(`${r.agent}:${r.id}`) || live.has(`${r.agent}:${r.id.replace(/^chat:/, '')}`)) {
        results.push({ agent: r.agent, id: r.id, ok: false, freedBytes: 0, error: '会话仍在活跃，未删除' });
        continue;
      }
      const list = byAgent.get(r.agent) ?? [];
      list.push(r.id);
      byAgent.set(r.agent, list);
    }
    for (const [agent, ids] of byAgent) {
      const a = this.adapters.find((x) => x.id === agent);
      if (!a?.deleteSessions) {
        results.push(...ids.map((id) => ({ agent, id, ok: false, freedBytes: 0, error: '该工具不支持删除' })));
        continue;
      }
      try {
        results.push(...(await a.deleteSessions(ids, trash)));
      } catch (e) {
        results.push(
          ...ids.map((id) => ({
            agent,
            id,
            ok: false,
            freedBytes: 0,
            error: e instanceof Error ? e.message : String(e),
          })),
        );
      }
    }
    return results;
  }

  /** 会话产物的磁盘路径（Finder 定位用）：优先该 agent 的盘点缓存，没扫过只扫这一家；
   *  兜底扫描失败按查无路径降级（revealSession 回 {ok:false}，不该让 adapter 异常穿透成 RPC reject）。 */
  async sessionPaths(agent: AgentId, id: string): Promise<string[]> {
    const scan = this.lastSessionScan.get(agent) ?? (await this.scanAgentSessions(agent).catch(() => []));
    return scan.find((s) => s.id === id)?.paths ?? [];
  }

  /** 台账保留清扫——失败静默（DB 被占等场景下轮再来）。 */
  private pruneLedger() {
    try {
      this.ledger.prune();
    } catch {
      // 清扫失败不致命：只影响磁盘占用，下轮 24h 再来。
    }
  }

  /** 当前设置（RPC/主进程读；写一律走 updateSettings/setAgentHook/setAgentObserved）。 */
  getSettings(): MurmurSettings {
    return this.settings;
  }

  /** agent 安装态读口（SyncService 注入用；detect 缓存直读）。 */
  isInstalled = (agent: AgentId): boolean => this.installs.get(agent)?.installed ?? false;
  /** 应用设置补丁：持久化 + 引擎侧生效（agent/hook 开关有实时副作用）。 */
  async updateSettings(patch: Partial<MurmurSettings>): Promise<MurmurSettings> {
    const prev = this.settings;
    this.settings = {
      ...prev,
      ...patch,
      agents: { ...prev.agents, ...patch.agents },
      hooks: { ...prev.hooks, ...patch.hooks },
      sync: { ...prev.sync, ...patch.sync },
    };
    saveSettings(this.settings, this.dataDir);
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
    saveSettings(this.settings, this.dataDir);
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

  /**
   * 设置页 BYOK：写/清某 agent 的用户自填 API Key。
   * apiKey 空白或 null → 删条目并清掉内存中的额度快照（UI 即时消失）；
   * 否则持久化到 credentials.json 并立即拉一轮额度。key 与 agent 的监听开关
   * 无关——停监听保留 key（同 hooks 偏好保留语义），重开即恢复。
   */
  async setAgentKey(agent: AgentId, apiKey: string | null, baseUrl?: string) {
    const key = apiKey?.trim();
    if (key) {
      this.byok[agent] = { apiKey: key, ...(baseUrl ? { baseUrl } : {}), updatedAt: Date.now() };
    } else {
      delete this.byok[agent];
      this.quotas.delete(agent);
    }
    try {
      saveCredentials(this.byok, this.dataDir);
    } catch {
      // 写盘失败不阻塞：内存态已生效，下轮 refreshQuotas 照常用。
    }
    await this.refreshQuotas();
  }

  /** 给监听中且 hook 开启的已安装 agent 装 hook（幂等）。返回各 agent 改动与触碰文件清单。 */
  async installAllHooks(): Promise<Record<AgentId, { changed: boolean; files: string[] }>> {
    const out = {} as Record<AgentId, { changed: boolean; files: string[] }>;
    for (const a of this.adapters) {
      const files = a.hookTargets?.() ?? [];
      if (!this.isObserved(a.id) || !this.isHookEnabled(a.id) || !this.installs.get(a.id)?.installed) {
        out[a.id] = { changed: false, files };
        continue;
      }
      try {
        out[a.id] = { changed: (await a.installHooks()).changed, files };
        this.installs.set(a.id, await a.detect());
      } catch {
        out[a.id] = { changed: false, files };
      }
    }
    this.notify();
    return out;
  }

  /** settings.json 尚未写过 = 首次启动（管理窗引导卡与自弹窗的信号）。 */
  isFirstRun(): boolean {
    return !existsSync(join(this.dataDir, 'settings.json'));
  }

  /** 接入诊断快照：重跑 detect 后组装三面实况（数据/push/pull）。 */
  async diagnostics(): Promise<DiagnosticsSnapshot> {
    await Promise.allSettled(
      this.adapters.map(async (a) => {
        try {
          this.installs.set(a.id, await a.detect());
        } catch {
          // detect 失败保留旧态，诊断如实展示。
        }
      }),
    );
    this.notify();
    return assembleDiagnostics({
      adapters: this.adapters,
      installs: this.installs,
      isObserved: (id) => this.isObserved(id),
      isHookEnabled: (id) => this.isHookEnabled(id),
      hookLastEventAt: (id) => this.lastHookAt.get(id) ?? null,
      watchActive: (id) => this.unwatchers.has(id),
      watchError: (id) => this.watchErrors.get(id),
      ledger: this.ledger,
      quotas: this.quotas,
      ingestEndpoint: this.ingestEndpoint(),
      firstRun: this.isFirstRun(),
    });
  }

  /** hook 链路自检（管理台「测试链路」按钮）：marker 走全真链路后清场。 */
  testAgentHook(agent: AgentId): Promise<HookTestResult> {
    return runHookTest({
      agent,
      adapter: this.adapters.find((a) => a.id === agent),
      ledger: this.ledger,
      translate: this.translateHook,
      observed: this.isObserved(agent),
      installed: Boolean(this.installs.get(agent)?.installed),
    });
  }

  /** 单 agent 重扫：重启其 watcher（旧 watcher 先停），不清游标拾漏。 */
  async rescanAgent(agent: AgentId): Promise<void> {
    const a = this.adapters.find((x) => x.id === agent);
    if (!a || !this.isObserved(agent) || !this.installs.get(agent)?.installed) return;
    await this.startWatch(a);
  }

  /** 单 agent 装 hook + 重 detect；返回改动与触碰文件清单（管理台逐条接入）。 */
  async installAgentHooks(agent: AgentId): Promise<{ changed: boolean; files: string[] }> {
    const a = this.adapters.find((x) => x.id === agent);
    const files = a?.hookTargets?.() ?? [];
    if (!a || !this.isObserved(agent) || !this.isHookEnabled(agent) || !this.installs.get(agent)?.installed) {
      return { changed: false, files };
    }
    try {
      const { changed } = await a.installHooks();
      this.installs.set(agent, await a.detect());
      this.notify();
      return { changed, files };
    } catch {
      return { changed: false, files };
    }
  }

  /**
   * 全量快照（同一变更周期复用同一实例，调用方只读、不得改写缓存对象）。
   * 被停用监听的 agent 保留在 agents 列表（disabled:true）供设置页显示，但不带会话/额度/用量。
   */
  snapshot(): AppSnapshot {
    if (this.snapshotCache) return this.snapshotCache;
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
    for (const r of this.ledger.usageSince(null, Date.now() - 7 * 86400_000) as Array<
      Record<string, number | string>
    >) {
      bump(weekByAgent, r);
    }
    const agents: AgentSnapshot[] = this.adapters.map((a) => {
      const disabled = !observed.has(a.id);
      const cred = this.byok[a.id];
      return {
        agent: a.id,
        install: this.installs.get(a.id) ?? {
          installed: false,
          hasCredentials: false,
          homeDir: '',
          hookInstalled: false,
        },
        disabled,
        // 自检 marker 会话不出快照——链路自检零污染约定。
        sessions: disabled ? [] : sessions.filter((s) => s.agent === a.id && !s.sessionId.startsWith(SELFTEST_PREFIX)),
        quota: disabled ? undefined : this.quotas.get(a.id),
        // BYOK 已配置状态（掩码预览）：停监听也保留——key 存在与否是事实陈述。
        byok:
          this.installs.get(a.id)?.supportsByok || cred?.apiKey
            ? { hasKey: Boolean(cred?.apiKey), preview: cred?.apiKey ? maskKey(cred.apiKey) : undefined }
            : undefined,
        // 停监听后今日/本周也该消失——隐藏会话却挂着用量数字对不上。
        today: disabled ? undefined : todayByAgent.get(a.id),
        week: disabled ? undefined : weekByAgent.get(a.id),
      };
    });
    const snap: AppSnapshot = {
      agents,
      overall: this.engine.overall(observed),
      generatedAt: Date.now(),
      // 停监听 agent 的 ended 残留照 sessions 同规过滤——隐藏会话却不藏它的尸体对不上。
      recentlyEnded: this.engine
        .recentlyEnded(RECENTLY_ENDED_LIMIT)
        .filter((s) => observed.has(s.agent) && !s.sessionId.startsWith(SELFTEST_PREFIX)),
    };
    this.snapshotCache = snap;
    return snap;
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
