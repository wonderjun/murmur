/**
 * 台账保留清扫单测：events 7d / token_ledger 70d / quota 每 agent 最新 50 /
 * 死游标清理；以及 spool .done 存档的 24h GC。
 *
 * Ledger 构造吃 dir 参数，无需钉 MURMUR_HOME；spool 路径以模块冻结值为准
 * （bun test 共享注册表，本文件的 env 不一定赢）。
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKFILL_WINDOW_MS, Ledger } from '../src/ledger/db';
import { drainSpool } from '../src/ingest/spool';
import { MURMUR_HOME } from '../src/paths';
import type { AgentEvent } from '../src/types';

const DAY = 86400_000;

function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-ledger-'));
  return { ledger: new Ledger(dir), dir };
}

const ev = (kind: AgentEvent['kind'], at: number, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'kimi',
  sessionId: 's1',
  kind,
  at,
  ...extra,
});

const count = (dir: string, table: string) =>
  (new Database(join(dir, 'murmur.db'), { readonly: true })
    .query(`SELECT COUNT(*) n FROM ${table}`)
    .get() as { n: number }).n;

describe('ledger.prune', () => {
  test('events 留 7d；usage_daily 日聚合无 TTL', () => {
    const { ledger, dir } = freshLedger();
    const now = Date.now();
    ledger.record(ev('turn.end', now - 8 * DAY)); // 旧事件 → 删
    ledger.record(ev('turn.end', now)); // 新事件 → 留
    ledger.record(ev('usage', now - 80 * DAY, { tokens: { input: 1, output: 1 } })); // 80d 前那天的聚合行
    ledger.record(ev('usage', now, { tokens: { input: 2, output: 2 } }));
    ledger.prune(now);
    expect(count(dir, 'events')).toBe(2); // fresh turn.end + fresh usage
    expect(count(dir, 'usage_daily')).toBe(2); // 两个不同 day 各一行，无 TTL 全留
    ledger.close();
  });

  test('usage 写入即按 (day,agent,model) 累加；token_ledger 迁移折叠后删表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-ledger-'));
    const now = Date.now();
    // 先裸造一份带旧明细表的库。
    const raw = new Database(join(dir, 'murmur.db'));
    raw.exec(`CREATE TABLE token_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      model TEXT, input INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
      reasoning INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, at INTEGER NOT NULL)`);
    raw.run('INSERT INTO token_ledger (agent,session_id,model,input,output,cache_read,at) VALUES (?,?,?,?,?,?,?)', [
      'kimi', 's1', 'k3', 100, 50, 10, now,
    ]);
    raw.run('INSERT INTO token_ledger (agent,session_id,model,input,output,at) VALUES (?,?,?,?,?,?)', [
      'kimi', 's2', 'k3', 200, 80, now - 1000,
    ]); // 同日同模型 → 折叠
    raw.run('INSERT INTO token_ledger (agent,session_id,model,input,output,at) VALUES (?,?,?,?,?,?)', [
      'kimi', 's2', 'k4', 5, 5, now,
    ]); // 不同模型 → 独立行
    raw.close();

    const ledger = new Ledger(dir); // 构造即迁移
    const rows = ledger.usageDaily(0);
    expect(rows).toHaveLength(2);
    const k3 = rows.find((r) => r.model === 'k3');
    expect(k3?.tokens).toBe(100 + 50 + 10 + 200 + 80);
    const gone = new Database(join(dir, 'murmur.db'), { readonly: true })
      .query("SELECT 1 FROM sqlite_master WHERE name='token_ledger'")
      .get();
    expect(gone).toBeNull();

    // 新 usage 继续往聚合行累加。
    ledger.record(ev('usage', now, { model: 'k3', tokens: { input: 7, output: 3 } }));
    expect(ledger.usageSince('kimi', 0).find((r) => r.model === 'k3')?.input).toBe(307);
    ledger.close();
  });

  test('quota_snapshots 每 agent 只留最新 50 条', () => {
    const { ledger, dir } = freshLedger();
    for (let i = 0; i < 60; i++) {
      ledger.saveQuota({ agent: 'kimi', windows: [], fetchedAt: i });
    }
    for (let i = 0; i < 5; i++) {
      ledger.saveQuota({ agent: 'codex', windows: [], fetchedAt: i });
    }
    ledger.prune();
    const raw = new Database(join(dir, 'murmur.db'), { readonly: true });
    expect((raw.query("SELECT COUNT(*) n FROM quota_snapshots WHERE agent='kimi'").get() as { n: number }).n).toBe(50);
    expect((raw.query("SELECT COUNT(*) n FROM quota_snapshots WHERE agent='codex'").get() as { n: number }).n).toBe(5);
    // 留下的必须是最新的 50 条。
    expect(
      (raw.query("SELECT MIN(fetched_at) lo FROM quota_snapshots WHERE agent='kimi'").get() as { lo: number }).lo,
    ).toBe(10);
    raw.close();
    ledger.close();
  });

  test('cursors：源文件消失或 70d 未推进 → 清；活文件保留', () => {
    const { ledger, dir } = freshLedger();
    const now = Date.now();
    const aliveFile = join(dir, 'alive.jsonl');
    writeFileSync(aliveFile, '{}\n');
    ledger.setCursor(`jsonl:${aliveFile}`, '100');
    ledger.setCursor('jsonl:/definitely/gone.jsonl', '50'); // 文件不存在 → 删
    ledger.setCursor('meta:rowid', '7'); // 非 jsonl 源不做文件存在性检查
    ledger.prune(now);
    const raw = new Database(join(dir, 'murmur.db'));
    // 把 meta:rowid 的 updated_at 拨回 71d → 下轮 prune 应删。
    raw.run('UPDATE cursors SET updated_at = ? WHERE source = ?', [now - 71 * DAY, 'meta:rowid']);
    const rows = raw.query('SELECT source FROM cursors ORDER BY source').all() as Array<{ source: string }>;
    expect(rows.map((r) => r.source)).toEqual([`jsonl:${aliveFile}`, 'meta:rowid']);
    ledger.prune(now + 1000);
    const after = raw.query('SELECT source FROM cursors').all() as Array<{ source: string }>;
    expect(after.map((r) => r.source)).toEqual([`jsonl:${aliveFile}`]);
    raw.close();
    ledger.close();
  });
});

describe('drainSpool .done GC', () => {
  test('24h 以上 .done 删除，新的保留', () => {
    const dir = join(MURMUR_HOME, 'spool');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, `old-${Date.now()}.done`);
    const fresh = join(dir, `fresh-${Date.now()}.done`);
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const past = new Date(Date.now() - 25 * 3600_000);
    utimesSync(old, past, past);
    drainSpool(() => {});
    expect(() => utimesSync(old, past, past)).toThrow(); // 已删
    expect(() => utimesSync(fresh, past, past)).not.toThrow(); // 仍在
  });
});
