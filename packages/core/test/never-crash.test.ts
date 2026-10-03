/**
 * Never-Crash 边界：单 agent 失败不拖垮其余采集，额度失败回退上次有效快照，
 * spool 坏行隔离，台账写锁不打断启动与状态机，删除失败不得误报成功。
 *
 * 全部落在 tmpdir。额度竞态用挂起的 Promise 门闩，不用 sleep。
 * 不改 MURMUR_HOME——它可能已被别的测试文件固化。
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailer, serialScan, type AgentAdapter } from '../src/agents/base';
import { AgentRegistry } from '../src/engine/registry';
import { startIngestServer } from '../src/ingest/server';
import { drainSpool } from '../src/ingest/spool';
import { Ledger } from '../src/ledger/db';
import type { AgentEvent, AgentId, QuotaSnapshot } from '../src/types';

interface Boom {
  detect?: boolean;
  watch?: boolean;
  install?: boolean;
  uninstall?: boolean;
  delete?: boolean;
}

type QuotaMode = 'hold' | 'ok' | 'reject' | 'error';

function goodQuota(agent: AgentId, stamp: number): QuotaSnapshot {
  return {
    agent,
    windows: [{ label: '5h', used: stamp, limit: 100, usedPct: stamp, resetsAt: null }],
    fetchedAt: stamp,
  };
}

/** fake adapter：按 boom 开关抛错；quotaMode=hold 时停在门闩上，等测试放行。 */
function makeFake(id: AgentId, opts?: { credentials?: boolean; boom?: Boom }) {
  const boom = opts?.boom ?? {};
  const calls = { installs: 0, uninstalls: 0, watches: 0, deletes: 0 };
  let emit: ((e: AgentEvent) => void) | null = null;
  let quotaMode: QuotaMode = 'ok';
  let quotaStamp = 1;
  let enteredHold = false;
  let okHold: (q: QuotaSnapshot) => void = () => {};
  let failHold: (e: Error) => void = () => {};
  const hold = new Promise<QuotaSnapshot>((resolve, reject) => {
    okHold = resolve;
    failHold = reject;
  });

  const adapter: AgentAdapter = {
    id,
    async detect() {
      if (boom.detect) throw new Error('detect boom');
      return {
        installed: true,
        hasCredentials: Boolean(opts?.credentials),
        homeDir: `/fake/${id}`,
        hookInstalled: false,
      };
    },
    async installHooks() {
      calls.installs += 1;
      if (boom.install) throw new Error('install boom');
      return { changed: true };
    },
    async uninstallHooks() {
      calls.uninstalls += 1;
      if (boom.uninstall) throw new Error('uninstall boom');
      return { changed: true };
    },
    async watch(emitFn) {
      calls.watches += 1;
      if (boom.watch) throw new Error('watch boom');
      emit = emitFn;
      return () => {
        emit = null;
      };
    },
    async quota() {
      if (quotaMode === 'hold') {
        enteredHold = true;
        return hold;
      }
      if (quotaMode === 'reject') throw new Error('quota boom');
      if (quotaMode === 'error') {
        return { agent: id, windows: [], fetchedAt: Date.now(), error: 'endpoint down' };
      }
      return goodQuota(id, quotaStamp);
    },
    async deleteSessions(ids, trash) {
      calls.deletes += 1;
      if (boom.delete) throw new Error('delete boom');
      return ids.map((sid) => {
        const ok = trash(`/fake/${id}/${sid}`);
        return {
          agent: id,
          id: sid,
          ok,
          freedBytes: ok ? 4 : 0,
          error: ok ? undefined : '移入废纸篓失败',
        };
      });
    },
  };

  return {
    adapter,
    calls,
    send: (e: AgentEvent) => emit?.(e),
    setQuotaMode: (mode: QuotaMode, stamp?: number) => {
      quotaMode = mode;
      if (stamp !== undefined) quotaStamp = stamp;
    },
    enteredHold: () => enteredHold,
    releaseHold: (q: QuotaSnapshot) => okHold(q),
    rejectHold: (e: Error) => failHold(e),
  };
}

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function started(adapters: AgentAdapter[], dataDir = tempDir('murmur-nc-')) {
  const reg = new AgentRegistry({ adapters, dataDir, skipIngest: true });
  await reg.start();
  return { reg, dataDir };
}

/** 排空微任务，直到断言成立。额度刷新是门闩之后的微任务，不是定时器。 */
async function until(pred: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error('条件没有在微任务内成立');
}

const of = (reg: AgentRegistry, id: AgentId) => reg.snapshot().agents.find((a) => a.agent === id)!;

describe('单 agent 失败不阻断其余采集', () => {
  test('detect 抛错：该 agent 记为未安装，另一个仍能采集快照', async () => {
    const bad = makeFake('kimi', { boom: { detect: true } });
    const good = makeFake('codex');
    const { reg } = await started([bad.adapter, good.adapter]);
    expect(of(reg, 'kimi').install).toMatchObject({ installed: false, note: 'detect 失败' });
    expect(bad.calls.watches).toBe(0);
    expect(good.calls.watches).toBeGreaterThan(0);

    good.send({ agent: 'codex', sessionId: 's-good', kind: 'session.start', at: Date.now() });
    expect(of(reg, 'codex').sessions.map((s) => s.sessionId)).toEqual(['s-good']);
    expect(of(reg, 'kimi').sessions).toEqual([]);
    await reg.stop();
  });

  test('watch 抛错：失败 agent 不影响另一个的 watcher 与快照', async () => {
    const bad = makeFake('kimi', { boom: { watch: true } });
    const good = makeFake('codex');
    const { reg } = await started([bad.adapter, good.adapter]);
    expect(bad.calls.watches).toBeGreaterThan(0);
    expect(good.calls.watches).toBeGreaterThan(0);
    good.send({ agent: 'codex', sessionId: 's-good', kind: 'turn.start', at: Date.now() });
    expect(of(reg, 'codex').sessions.map((s) => s.sessionId)).toEqual(['s-good']);
    expect(of(reg, 'kimi').sessions).toEqual([]);
    await reg.stop();
  });

  test('install 抛错：启动继续，另一个 agent 仍装 hook 并采集', async () => {
    const bad = makeFake('kimi', { boom: { install: true } });
    const good = makeFake('codex');
    const { reg } = await started([bad.adapter, good.adapter]);
    expect(bad.calls.installs).toBe(1);
    expect(good.calls.installs).toBe(1);
    good.send({ agent: 'codex', sessionId: 's-good', kind: 'session.start', at: Date.now() });
    expect(of(reg, 'codex').sessions).toHaveLength(1);
    await reg.stop();
  });

  test('uninstall 抛错：设置已落盘，另一个 agent 的快照不受影响', async () => {
    const bad = makeFake('kimi', { boom: { uninstall: true } });
    const good = makeFake('codex');
    const { reg } = await started([bad.adapter, good.adapter]);
    const saved = await reg.setAgentHook('kimi', false);
    expect(saved.hooks.kimi).toBe(false);
    expect(bad.calls.uninstalls).toBe(1);
    good.send({ agent: 'codex', sessionId: 's-good', kind: 'session.start', at: Date.now() });
    expect(of(reg, 'codex').sessions.map((s) => s.sessionId)).toEqual(['s-good']);
    await reg.stop();
  });
});

describe('额度失败回退', () => {
  test('rejected 与错误快照都回退内存里上次有效窗口', async () => {
    const kimi = makeFake('kimi', { credentials: true });
    const codex = makeFake('codex');
    kimi.setQuotaMode('hold');
    const { reg } = await started([kimi.adapter, codex.adapter]);
    expect(kimi.enteredHold()).toBe(true);

    // start() 里那轮 fire-and-forget 还停在门闩上，放行后才算「上次有效」。
    kimi.releaseHold(goodQuota('kimi', 11));
    await until(() => of(reg, 'kimi').quota?.fetchedAt === 11);

    kimi.setQuotaMode('reject');
    await reg.refreshQuotas();
    expect(of(reg, 'kimi').quota).toMatchObject({ fetchedAt: 11, windows: [{ usedPct: 11 }] });
    expect(of(reg, 'kimi').quota?.error).toBeUndefined();

    kimi.setQuotaMode('error');
    await reg.refreshQuotas();
    expect(of(reg, 'kimi').quota).toMatchObject({ fetchedAt: 11, windows: [{ usedPct: 11 }] });

    codex.send({ agent: 'codex', sessionId: 's-good', kind: 'session.start', at: Date.now() });
    expect(of(reg, 'codex').sessions).toHaveLength(1);
    await reg.stop();
  });

  test('内存里没有快照时，rejected 读台账里上次有效的', async () => {
    const dataDir = tempDir('murmur-nc-quota-');
    const seed = new Ledger(dataDir);
    seed.saveQuota(goodQuota('kimi', 42));
    seed.close();

    const kimi = makeFake('kimi', { credentials: true });
    kimi.setQuotaMode('hold');
    const reg = new AgentRegistry({ adapters: [kimi.adapter], dataDir, skipIngest: true });
    await reg.start();
    expect(kimi.enteredHold()).toBe(true);
    kimi.rejectHold(new Error('quota boom'));
    await until(() => of(reg, 'kimi').quota?.fetchedAt === 42);
    expect(of(reg, 'kimi').quota?.windows).toHaveLength(1);
    await reg.stop();
  });

  test('无历史的 rejected / 错误快照保持 unavailable，不伪装成有效额度', async () => {
    const rejected = makeFake('kimi', { credentials: true });
    rejected.setQuotaMode('hold');
    const first = await started([rejected.adapter]);
    rejected.rejectHold(new Error('quota boom'));
    await until(() => Boolean(of(first.reg, 'kimi').quota?.error));
    expect(of(first.reg, 'kimi').quota).toMatchObject({ windows: [], error: 'quota boom' });
    await first.reg.stop();

    const errored = makeFake('codex', { credentials: true });
    errored.setQuotaMode('hold');
    const second = await started([errored.adapter]);
    errored.releaseHold({ agent: 'codex', windows: [], fetchedAt: 1, error: 'endpoint down' });
    await until(() => of(second.reg, 'codex').quota?.error === 'endpoint down');
    expect(of(second.reg, 'codex').quota?.windows).toEqual([]);
    await second.reg.stop();
  });

  test('有效快照落库失败时保留刚拉到的内存值，不用更旧历史覆盖', async () => {
    const kimi = makeFake('kimi', { credentials: true });
    kimi.setQuotaMode('hold');
    const { reg, dataDir } = await started([kimi.adapter]);
    kimi.releaseHold(goodQuota('kimi', 11));
    await until(() => of(reg, 'kimi').quota?.fetchedAt === 11);

    const lock = new Database(join(dataDir, 'murmur.db'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      kimi.setQuotaMode('ok', 77);
      await reg.refreshQuotas();
      expect(of(reg, 'kimi').quota).toMatchObject({ fetchedAt: 77, windows: [{ usedPct: 77 }] });
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
      await reg.stop();
    }
  });
});

describe('spool 坏行隔离', () => {
  test('坏 JSON、单条翻译失败、不可读文件都不阻断其余行和其余文件', () => {
    const dir = tempDir('murmur-nc-spool-');
    writeFileSync(
      join(dir, 'kimi.jsonl'),
      ['{not json', '', '{"boom":true}', '{"ok":1}'].join('\n'),
    );
    writeFileSync(join(dir, 'codex.jsonl'), '{"ok":2}\n');
    // 目录伪装成 jsonl：rename 成功但读文件失败，应跳过这个「文件」。
    mkdirSync(join(dir, 'cursor.jsonl'));

    const got: { agent: string; ok: number }[] = [];
    const n = drainSpool((agent, payload) => {
      const row = payload as { boom?: boolean; ok?: number };
      if (row.boom) throw new Error('translate boom');
      got.push({ agent, ok: row.ok ?? 0 });
    }, dir);

    expect(n).toBe(2);
    expect(got.sort((a, b) => a.agent.localeCompare(b.agent))).toEqual([
      { agent: 'codex', ok: 2 },
      { agent: 'kimi', ok: 1 },
    ]);
  });

  test('翻译抛错的 hook POST 仍返回 202，下一条照常接收', async () => {
    let n = 0;
    const got: string[] = [];
    const server = startIngestServer({
      translate: (agent) => {
        n += 1;
        if (n === 1) throw new Error('translate boom');
        got.push(agent);
      },
    });
    try {
      const headers = { 'Content-Type': 'application/json', 'X-Murmur-Hook-Token': server.endpoint.token };
      const first = await fetch(`http://127.0.0.1:${server.endpoint.port}/hook/kimi`, {
        method: 'POST',
        headers,
        body: '{"a":1}',
      });
      const second = await fetch(`http://127.0.0.1:${server.endpoint.port}/hook/codex`, {
        method: 'POST',
        headers,
        body: '{"a":2}',
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(got).toEqual(['codex']);
    } finally {
      server.close();
    }
  });
});

describe('台账写锁不打断启动与状态机', () => {
  test('BEGIN IMMEDIATE 占住写锁时 start / 事件落库 / prune 都不抛，会话仍在内存', async () => {
    const dataDir = tempDir('murmur-nc-lock-');
    const good = makeFake('codex');
    const reg = new AgentRegistry({ adapters: [good.adapter], dataDir, skipIngest: true });
    const dbPath = join(dataDir, 'murmur.db');
    const lock = new Database(dbPath);
    lock.exec('BEGIN IMMEDIATE');
    const probe = new Database(dbPath);
    let writeError = '';
    try {
      probe.run("INSERT INTO meta (k, v) VALUES ('probe', '1')");
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e);
    }
    probe.close();
    // 锁没生效就不要假装测过了。
    expect(writeError).toMatch(/locked/i);

    try {
      await reg.start();
      expect(good.calls.watches).toBeGreaterThan(0);
      good.send({ agent: 'codex', sessionId: 's-lock', kind: 'session.start', at: Date.now() });
      good.send({
        agent: 'codex',
        sessionId: 's-lock',
        kind: 'usage',
        tokens: { input: 5, output: 1 },
        at: Date.now(),
      });
      const snap = of(reg, 'codex');
      expect(snap.sessions.map((s) => s.sessionId)).toEqual(['s-lock']);
      expect(snap.today).toBeUndefined();
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
      await reg.stop();
    }

    const after = new Database(dbPath, { readonly: true });
    const events = after.query("SELECT COUNT(*) n FROM events WHERE session_id = 's-lock'").get() as { n: number };
    const usage = after.query('SELECT COUNT(*) n FROM usage_daily').get() as { n: number };
    after.close();
    expect(events.n).toBe(0);
    expect(usage.n).toBe(0);
  });
});

describe('会话删除失败不得误报成功', () => {
  test('trash 返回 false、adapter 抛错、批量里成功项仍逐项返回', async () => {
    const kimi = makeFake('kimi');
    const codex = makeFake('codex', { boom: { delete: true } });
    const { reg } = await started([kimi.adapter, codex.adapter]);
    const results = await reg.deleteSessions(
      [
        { agent: 'kimi', id: 'keep' },
        { agent: 'kimi', id: 'gone' },
        { agent: 'codex', id: 'x' },
      ],
      (path) => !path.endsWith('/gone'),
    );
    expect(results).toEqual([
      { agent: 'kimi', id: 'keep', ok: true, freedBytes: 4, error: undefined },
      { agent: 'kimi', id: 'gone', ok: false, freedBytes: 0, error: '移入废纸篓失败' },
      { agent: 'codex', id: 'x', ok: false, freedBytes: 0, error: 'delete boom' },
    ]);
    expect(results.filter((r) => r.ok).map((r) => r.id)).toEqual(['keep']);
    await reg.stop();
  });
});

describe('扫描与游标失败不中断', () => {
  test('单轮扫描抛错后，已经排队的下一轮仍会跑', async () => {
    let stage = 0;
    const scan = serialScan(async () => {
      stage += 1;
      if (stage === 1) {
        scan();
        throw new Error('scan boom');
      }
    });
    scan();
    await until(() => stage === 2);
    expect(stage).toBe(2);
  });

  test('游标读失败时本轮跳过文件，不把偏移当成 0 重放', async () => {
    const dir = tempDir('murmur-nc-tail-');
    const file = join(dir, 'wire.jsonl');
    writeFileSync(file, '{"n":1}\n');
    const ledger = {
      getCursor() {
        throw new Error('cursor locked');
      },
      setCursor() {
        throw new Error('cursor locked');
      },
    } as unknown as Ledger;
    const lines: string[] = [];
    const n = await new JsonlTailer(ledger).tail(file, true, () => {
      lines.push('hit');
    });
    expect(n).toBe(0);
    expect(lines).toEqual([]);
  });

  test('游标写失败时行仍交给回调，且本进程不会把同一段再读一遍', async () => {
    const dir = tempDir('murmur-nc-tail-');
    const ledger = new Ledger(dir);
    const file = join(dir, 'wire.jsonl');
    writeFileSync(file, '{"n":1}\n{"n":2}\n');
    const lock = new Database(join(dir, 'murmur.db'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      const tailer = new JsonlTailer(ledger);
      const lines: number[] = [];
      const n = await tailer.tail(file, true, (obj) => {
        lines.push(obj.n as number);
      });
      expect(n).toBe(2);
      expect(lines).toEqual([1, 2]);
      const again = await tailer.tail(file, true, () => {
        lines.push(-1);
      });
      expect(again).toBe(0);
      expect(lines).toEqual([1, 2]);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
      ledger.close();
    }
  });
});
