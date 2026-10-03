/**
 * 本地台账：bun:sqlite 存储事件流水、token 计量、额度快照与拉取游标。
 *
 * 数据库落在 MURMUR_HOME/murmur.db（WAL）。拉取游标（cursors 表）是
 * 增量解析的关键——每个 pull 源记录自己的偏移（文件字节 / sqlite rowid），
 * 重启后续跑不重算。
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from '../paths';
import type { AgentEvent, AgentId, QuotaSnapshot } from '../types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT,
  at INTEGER NOT NULL,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS events_agent_at ON events(agent, at);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  input INTEGER DEFAULT 0,
  output INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0,
  cache_write INTEGER DEFAULT 0,
  reasoning INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  PRIMARY KEY (day, agent, model)
);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/** 回填窗口：只把最近 ~70 天的历史用量扫进台账（与用量页热力图窗口对齐）。 */
export const BACKFILL_WINDOW_MS = 70 * 86400_000;
/** 回填语义版本：变更回填口径时 +1，启动检测到不一致自动清库重扫。 */
export const BACKFILL_EPOCH = '4';
/** 事件流水保留窗：events 是纯审计流（无查询读方），7d 够排查用。 */
const EVENTS_KEEP_MS = 7 * 86400_000;
/** 每个 agent 只留最近 N 条额度快照——lastQuota 只需要最新一条好快照兜底。 */
const QUOTA_KEEP_PER_AGENT = 50;

/** 本地时区 YYYY-MM-DD（与 SQL date(...,'localtime') 同口径）。 */
function dayKey(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Ledger {
  private db: Database;

  constructor(dir = MURMUR_HOME) {
    try {
      mkdirSync(dir, { recursive: true });
      this.db = new Database(join(dir, 'murmur.db'));
      this.db.exec('PRAGMA journal_mode=WAL');
    } catch {
      // 家目录不可写或 db 损坏 → 内存台账降级：进程照起，代价是本次运行不落盘。
      this.db = new Database(':memory:');
    }
    this.db.exec(SCHEMA);
    this.migrateTokenLedger();
  }

  /** 一次性迁移：旧 token_ledger 事件级明细按 (day,agent,model) 折叠进 usage_daily 后删表。 */
  private migrateTokenLedger() {
    const has = this.db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='token_ledger'")
      .get();
    if (!has) return;
    // ON CONFLICT 加性合并：降级再升级会让 usage_daily 已存在同 (day,agent,model) 行，
    // 裸 INSERT 撞 PK → 构造抛错 → 进程每次启动都死。
    this.db.exec(`
      INSERT INTO usage_daily (day, agent, model, input, output, cache_read, cache_write, reasoning, cost_usd)
      SELECT date(at/1000,'unixepoch','localtime'), agent, IFNULL(model,''),
             SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(reasoning), SUM(cost_usd)
      FROM token_ledger GROUP BY 1, 2, 3
      ON CONFLICT(day, agent, model) DO UPDATE SET
        input = input + excluded.input,
        output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write,
        reasoning = reasoning + excluded.reasoning,
        cost_usd = cost_usd + excluded.cost_usd;
      DROP TABLE token_ledger;
    `);
  }

  /** 记录一条事件流水（usage 事件按日聚合同步累加进 usage_daily）。 */
  record(e: AgentEvent, costUsd = 0) {
    this.db.run('INSERT INTO events (agent, session_id, kind, status, at, raw) VALUES (?, ?, ?, ?, ?, ?)', [
      e.agent,
      e.sessionId,
      e.kind,
      e.status ?? null,
      e.at,
      e.raw ? JSON.stringify(e.raw).slice(0, 4000) : null,
    ]);
    if (e.kind === 'usage' && e.tokens) {
      const t = e.tokens;
      this.db.run(
        `INSERT INTO usage_daily (day, agent, model, input, output, cache_read, cache_write, reasoning, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, agent, model) DO UPDATE SET
           input = input + excluded.input, output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
           reasoning = reasoning + excluded.reasoning, cost_usd = cost_usd + excluded.cost_usd`,
        [
          dayKey(e.at),
          e.agent,
          e.model ?? '',
          t.input,
          t.output,
          t.cacheRead ?? 0,
          t.cacheWrite ?? 0,
          t.reasoning ?? 0,
          costUsd,
        ],
      );
    }
  }

  /** 取/存某个 pull 源的游标（source 自定，如 "kimi:wire:<path>"）。 */
  getCursor(source: string): string | null {
    const row = this.db.query('SELECT cursor FROM cursors WHERE source = ?').get(source) as { cursor: string } | null;
    return row?.cursor ?? null;
  }

  setCursor(source: string, cursor: string) {
    this.db.run(
      'INSERT INTO cursors (source, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at',
      [source, cursor, Date.now()],
    );
  }

  /** 全部游标行（诊断页「最近扫描时间」数据源）。 */
  allCursors(): { source: string; cursor: string; updatedAt: number }[] {
    return this.db.query('SELECT source, cursor, updated_at AS updatedAt FROM cursors ORDER BY updated_at DESC').all() as {
      source: string;
      cursor: string;
      updatedAt: number;
    }[];
  }

  /** 某 sessionId 的台账事件条数（hook 链路自检的落库验证）。 */
  sessionEventCount(sessionId: string): number {
    const row = this.db.query('SELECT COUNT(*) n FROM events WHERE session_id = ?').get(sessionId) as { n: number };
    return row.n;
  }

  /** 按 sessionId 前缀清事件（自检 marker 清场用）。 */
  deleteSessionEvents(sessionIdLike: string): void {
    this.db.run('DELETE FROM events WHERE session_id LIKE ?', [sessionIdLike]);
  }

  /** 读/写 meta 键值（backfill epoch 等引擎内部标记）。 */
  getMeta(k: string): string | null {
    const row = this.db.query('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | null;
    return row?.v ?? null;
  }

  setMeta(k: string, v: string) {
    this.db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);
  }

  /** 台账重建：清事件/用量/游标 → 各 pull watcher 下一轮自动全量重读历史。 */
  resetForRebuild() {
    this.db.run('DELETE FROM events');
    this.db.run('DELETE FROM usage_daily');
    this.db.run('DELETE FROM cursors');
  }

  /**
   * 保留清扫：台账只进不出会无限膨胀（实测月级 38MB+）。
   *   events          7d 之外的删掉——纯审计流，没有读方；
   *   usage_daily     日聚合表，无 TTL（体量恒定小）；
   *   quota_snapshots 每 agent 留最新 50 条（~8h 轮询史，lastQuota 兜底不丢）；
   *   cursors         70d 未推进的死游标 + `jsonl:` 源文件已删的游标清掉。
   *   收尾 wal_checkpoint + VACUUM 压实文件；DB 被占时跳过，下轮再来。
   */
  prune(now = Date.now()) {
    this.db.run('DELETE FROM events WHERE at < ?', [now - EVENTS_KEEP_MS]);
    // usage_daily 是日聚合（每年每 agent 数百行），不设 TTL——它就是长期统计本体。
    const agents = this.db.query('SELECT DISTINCT agent FROM quota_snapshots').all() as Array<{ agent: string }>;
    for (const { agent } of agents) {
      // 第 50 新快照的 fetched_at 之前的全删；不足 50 条时子查询为 NULL → 一行不删。
      this.db.run(
        `DELETE FROM quota_snapshots WHERE agent = ? AND fetched_at < COALESCE(
           (SELECT fetched_at FROM quota_snapshots WHERE agent = ? ORDER BY fetched_at DESC LIMIT 1 OFFSET ?), 0)`,
        [agent, agent, QUOTA_KEEP_PER_AGENT - 1],
      );
    }
    for (const row of this.db.query('SELECT source, updated_at FROM cursors').all() as Array<{
      source: string;
      updated_at: number;
    }>) {
      const gone = row.source.startsWith('jsonl:') && !existsSync(row.source.slice('jsonl:'.length));
      if (gone || row.updated_at < now - BACKFILL_WINDOW_MS) {
        this.db.run('DELETE FROM cursors WHERE source = ?', [row.source]);
      }
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
    } catch {
      // 其他连接占用 DB 时压实失败，跳过下轮再来。
    }
  }

  /** 台账是否为空（启动时据此决定是否自动重建）。 */
  isUsageEmpty(): boolean {
    const row = this.db.query('SELECT COUNT(*) n FROM usage_daily').get() as { n: number };
    return row.n === 0;
  }

  /** 保存最近一次额度快照。 */
  saveQuota(q: QuotaSnapshot) {
    this.db.run('INSERT INTO quota_snapshots (agent, payload, fetched_at) VALUES (?, ?, ?)', [
      q.agent,
      JSON.stringify(q),
      q.fetchedAt,
    ]);
  }

  lastQuota(agent: AgentId): QuotaSnapshot | null {
    const rows = this.db
      .query('SELECT payload FROM quota_snapshots WHERE agent = ? ORDER BY fetched_at DESC')
      .all(agent) as Array<{ payload: string }>;
    for (const row of rows) {
      const snapshot = JSON.parse(row.payload) as QuotaSnapshot;
      if (snapshot.windows.length > 0) return snapshot;
    }
    return null;
  }

  /** 某 agent 在某时间窗内的 token 合计与成本（报表用）。日聚合粒度：sinceMs 所在日整天计入。 */
  usageSince(agent: AgentId | null, sinceMs: number) {
    const rows = this.db
      .query(
        `SELECT agent, NULLIF(model, '') model, SUM(input) input, SUM(output) output,
                SUM(cache_read) cacheRead, SUM(cache_write) cacheWrite,
                SUM(reasoning) reasoning, SUM(cost_usd) costUsd
         FROM usage_daily WHERE day >= date(?/1000, 'unixepoch', 'localtime') ${agent ? 'AND agent = ?' : ''}
         GROUP BY agent, model`,
      )
      .all(...(agent ? [sinceMs, agent] : [sinceMs])) as Array<{
      agent: string;
      model: string | null;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      costUsd: number;
    }>;
    return rows;
  }

  /** 按天 × agent × model 的日聚合明细（热力图/堆积柱/折线共用一条明细源）。 */
  usageDaily(sinceMs: number) {
    return this.db
      .query(
        `SELECT day, agent, NULLIF(model, '') model,
                (input + output + cache_read + cache_write) tokens, cost_usd costUsd
         FROM usage_daily WHERE day >= date(?/1000, 'unixepoch', 'localtime')
         ORDER BY day`,
      )
      .all(sinceMs) as Array<{ day: string; agent: string; model: string | null; tokens: number; costUsd: number }>;
  }

  close() {
    this.db.close();
  }
}
