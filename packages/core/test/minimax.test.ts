/**
 * minimax adapter 单测：runtime-state.sqlite 三轮询（sessions 建档 + turn_ingress
 * 边界 + token_usage 台账）、子会话归并、游标续跑与坏库降级。
 *
 * 坑同 devin.test.ts：路径 env 必须在 import adapter 之前钉死——agentPaths
 * 函数体内才读 env，但 MURMUR_HOME 在 paths.ts 模块加载时固化。
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'murmur-minimax-test-'));
const MINIMAX_HOME = join(HOME, 'minimax');
process.env.MURMUR_HOME = join(HOME, 'murmur');
process.env.MURMUR_MINIMAX_HOME = MINIMAX_HOME;

const { createMinimaxAdapter } = await import('../src/agents/minimax');
const { agentPaths } = await import('../src/paths');
const { Ledger } = await import('../src/ledger/db');
const { Database } = await import('bun:sqlite');

type Db = InstanceType<typeof Database>;

/** 建三张真源表的 fixture 库（列只留 adapter 消费的子集）。 */
function fakeDb(dir: string): Db {
  mkdirSync(join(dir, 'v2', 'sqlite'), { recursive: true });
  const db = new Database(join(dir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`CREATE TABLE local_runtime_sessions(
             session_id TEXT PRIMARY KEY, title TEXT, workspace_dir TEXT, status TEXT,
             session_kind TEXT NOT NULL DEFAULT 'unknown', parent_session_id TEXT,
             archived INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'visible',
             created_at_ms INTEGER, updated_at_ms INTEGER, extra_data_json TEXT NOT NULL DEFAULT '{}');
           CREATE TABLE local_runtime_turn_ingress(
             turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
             accepted_at_ms INTEGER NOT NULL, completed_at_ms INTEGER);
           CREATE TABLE local_runtime_token_usage(
             id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, model TEXT,
             ts INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
             output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
             cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0);`);
  return db;
}

const insSession = (db: Db, id: string, over: Record<string, unknown> = {}) => {
  const now = Date.now();
  db.run(
    `INSERT INTO local_runtime_sessions(session_id,title,workspace_dir,status,session_kind,
       parent_session_id,archived,visibility,created_at_ms,updated_at_ms,extra_data_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      (over.title as string) ?? null,
      (over.workspace_dir as string) ?? null,
      (over.status as string) ?? 'idle',
      (over.session_kind as string) ?? 'conversation',
      (over.parent_session_id as string) ?? null,
      (over.archived as number) ?? 0,
      (over.visibility as string) ?? 'visible',
      (over.created_at_ms as number) ?? now,
      (over.updated_at_ms as number) ?? now,
      (over.extra_data_json as string) ?? '{}',
    ],
  );
};

const insUsage = (db: Db, sid: string, over: Record<string, unknown> = {}) => {
  db.run(
    `INSERT INTO local_runtime_token_usage(session_id,model,ts,input_tokens,output_tokens,
       reasoning_tokens,cache_read_tokens,cache_write_tokens) VALUES(?,?,?,?,?,?,?,?)`,
    [
      sid,
      (over.model as string) ?? null,
      (over.ts as number) ?? Date.now(),
      (over.input as number) ?? 0,
      (over.output as number) ?? 0,
      (over.reasoning as number) ?? 0,
      (over.cacheRead as number) ?? 0,
      (over.cacheWrite as number) ?? 0,
    ],
  );
};

const insTurn = (db: Db, turnId: string, sid: string, status: string, acceptedAt: number, completedAt: number | null) => {
  db.run('INSERT INTO local_runtime_turn_ingress VALUES(?,?,?,?,?)', [turnId, sid, status, acceptedAt, completedAt]);
};

const collect = async (dir: string) => {
  // adapter 在调用时读 env——每个用例把数据根指到本 case 的 fixture 目录。
  process.env.MURMUR_MINIMAX_HOME = dir;
  const events: Array<Record<string, unknown>> = [];
  const ledger = new Ledger(join(dir, 'ledger'));
  const unwatch = await createMinimaxAdapter().watch!((e) => events.push(e as unknown as Record<string, unknown>), ledger);
  return { events, ledger, unwatch };
};

describe('minimax 路径与探测', () => {
  test('agentPaths：home=数据根、sessions=v2、hookConfig=null（无 push 面）', () => {
    const p = agentPaths('minimax');
    expect(p.home).toBe(MINIMAX_HOME);
    expect(p.sessions).toBe(join(MINIMAX_HOME, 'v2'));
    expect(p.hookConfig).toBeNull();
  });

  test('detect：缺目录未安装；OAuth auth.json 存在即 hasCredentials', async () => {
    const a = createMinimaxAdapter();
    expect((await a.detect()).installed).toBe(false);
    mkdirSync(join(MINIMAX_HOME, 'auth', 'prod', 'cn', 'mcode-public'), { recursive: true });
    expect((await a.detect()).hasCredentials).toBe(false);
    writeFileSync(join(MINIMAX_HOME, 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'), '{}');
    const info = await a.detect();
    expect(info).toMatchObject({ installed: true, hasCredentials: true, hookInstalled: false });
  });
});

describe('minimax watch：会话建档 + token 台账', () => {
  test('会话行→session.start（title/cwd/model 剥 provider 前缀）；usage 行计量入账', async () => {
    const dir = join(HOME, 'case-basic');
    const db = fakeDb(dir);
    const now = Date.now();
    insSession(db, 'mvs_1', {
      title: '写测试',
      workspace_dir: '/tmp/mp',
      created_at_ms: now - 60000,
      updated_at_ms: now - 30000, // 旧会话：只建档不报 working
      extra_data_json: JSON.stringify({ effectiveModel: 'minimax/MiniMax-M3.1-Flash' }),
    });
    insUsage(db, 'mvs_1', { input: 100, output: 50, cacheRead: 1000, cacheWrite: 20, reasoning: 7, ts: now - 10000 });
    insUsage(db, 'mvs_1', { ts: now - 9000 }); // 全零行跳过但游标照过
    insUsage(db, 'mvs_1', { input: 5, ts: now - 80 * 86400_000 }); // 70d 外不回填

    const { events, ledger, unwatch } = await collect(dir);
    const start = events.find((e) => e.kind === 'session.start');
    expect(start).toMatchObject({
      agent: 'minimax',
      sessionId: 'mvs_1',
      title: '写测试',
      cwd: '/tmp/mp',
      model: 'MiniMax-M3.1-Flash',
    });
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(1); // 零行与超窗行都不入账
    expect(usage[0]).toMatchObject({
      sessionId: 'mvs_1',
      model: 'MiniMax-M3.1-Flash', // usage 行 model 空 → 会话注册表回退
      tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 20, reasoning: 7 },
    });
    // 游标过掉零行停在 2；超窗行进不了 ts>=cutoff 结果集，永远留在游标前不被回扫。
    expect(ledger.getCursor('minimax:tu_id')).toBe('2');

    unwatch();
    ledger.close();
    db.close();
  });

  test('活跃会话初见→working；归档行不建档', async () => {
    const dir = join(HOME, 'case-live');
    const db = fakeDb(dir);
    insSession(db, 'mvs_live', { status: 'started' });
    insSession(db, 'mvs_dead', { archived: 1 }); // 死档：不该有 session.start

    const { events, ledger, unwatch } = await collect(dir);
    expect(events.some((e) => e.kind === 'session.start' && e.sessionId === 'mvs_live')).toBe(true);
    expect(events.some((e) => e.kind === 'status' && e.status === 'working' && e.sessionId === 'mvs_live')).toBe(true);
    expect(events.some((e) => e.sessionId === 'mvs_dead')).toBe(false);

    unwatch();
    ledger.close();
    db.close();
  });

  test('usage 游标跨 watcher 续跑：重开不重复，新行只增量入账', async () => {
    const dir = join(HOME, 'case-resume');
    const db = fakeDb(dir);
    insSession(db, 'mvs_1');
    insUsage(db, 'mvs_1', { input: 10 });

    const first = await collect(dir);
    expect(first.events.filter((e) => e.kind === 'usage')).toHaveLength(1);
    first.unwatch();
    first.ledger.close();

    insUsage(db, 'mvs_1', { input: 20 });
    insUsage(db, 'mvs_1', { output: 5 });
    const second = await collect(dir);
    const usage = second.events.filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(2); // 第 1 行不重放
    expect(usage.map((e) => (e.tokens as Record<string, number>).input)).toEqual([20, 0]);
    expect(second.ledger.getCursor('minimax:tu_id')).toBe('3');

    second.unwatch();
    second.ledger.close();
    db.close();
  });
});

describe('minimax watch：turn 生命周期与子会话归并', () => {
  test('accepted→turn.start；窗口内 completed→turn.end(turn-end)', async () => {
    const dir = join(HOME, 'case-turn');
    const db = fakeDb(dir);
    const now = Date.now();
    insSession(db, 'mvs_1');
    insTurn(db, 't-open', 'mvs_1', 'accepted', now - 5000, null);
    insTurn(db, 't-done', 'mvs_1', 'completed', now - 40000, now - 30000); // 窗口内完成的未跟踪 turn 补 end

    const { events, ledger, unwatch } = await collect(dir);
    const tstart = events.filter((e) => e.kind === 'turn.start');
    expect(tstart).toHaveLength(1); // t-done 的 accepted 是旧事件，不冒充开始
    expect(tstart[0]).toMatchObject({ sessionId: 'mvs_1' });
    const tend = events.filter((e) => e.kind === 'turn.end');
    expect(tend).toHaveLength(1);
    expect(tend[0]).toMatchObject({ sessionId: 'mvs_1', waitingReason: 'turn-end', at: now - 30000 });

    unwatch();
    ledger.close();
    db.close();
  });

  test('task 子会话不独立建档：usage/turn 归并父会话', async () => {
    const dir = join(HOME, 'case-sub');
    const db = fakeDb(dir);
    const now = Date.now();
    insSession(db, 'mvs_parent');
    insSession(db, 'mvs_task', { session_kind: 'task', parent_session_id: 'mvs_parent' });
    insUsage(db, 'mvs_task', { input: 42, ts: now });
    insTurn(db, 't-sub', 'mvs_task', 'accepted', now - 1000, null);

    const { events, ledger, unwatch } = await collect(dir);
    expect(events.filter((e) => e.kind === 'session.start').map((e) => e.sessionId)).toEqual(['mvs_parent']);
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({ sessionId: 'mvs_parent' });
    expect(events.find((e) => e.kind === 'turn.start')).toMatchObject({ sessionId: 'mvs_parent' });

    unwatch();
    ledger.close();
    db.close();
  });
});

describe('minimax watch：降级路径', () => {
  test('库缺失/损坏 → watch 空挂不抛错', async () => {
    const missing = await collect(join(HOME, 'case-no-db'));
    expect(missing.events).toHaveLength(0);
    missing.unwatch();
    missing.ledger.close();

    const dir = join(HOME, 'case-corrupt');
    mkdirSync(join(dir, 'v2', 'sqlite'), { recursive: true });
    writeFileSync(join(dir, 'v2', 'sqlite', 'runtime-state.sqlite'), 'definitely not sqlite');
    const bad = await collect(dir);
    expect(bad.events).toHaveLength(0);
    bad.unwatch();
    bad.ledger.close();
  });
});
