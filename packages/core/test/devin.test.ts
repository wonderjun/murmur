/**
 * devin adapter 单测：hook 翻译、config.json 合并幂等与卸载、
 * Connect RPC 配额通道（stub fetch）与 BYOK consumption 窗口。
 *
 * 坑：MURMUR_HOME 在 paths.ts 模块加载时固化——先钉沙箱 env 再动态 import。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'murmur-devin-test-'));
const DEVIN_DATA = join(HOME, '.local/share/devin');
const DEVIN_CONFIG = join(HOME, '.config/devin/config.json');
process.env.MURMUR_HOME = HOME;
process.env.MURMUR_DEVIN_DATA = DEVIN_DATA;
process.env.MURMUR_DEVIN_CONFIG = DEVIN_CONFIG;

const { translateDevinHook, createDevinAdapter, devinMetricKey } = await import('../src/agents/devin');
const { fetchDevinQuota, readDevinCredentials, sniffDevinOrgId } = await import('../src/quota/devin');
const { mergeDevinHooksConfig, writeHookScript, removeHookScript } = await import('../src/hooks/install');
const { Ledger } = await import('../src/ledger/db');

describe('devin hook 事件翻译', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    translateDevinHook({ hook_event_name: name, session_id: 's1', cwd: '/w', ...extra });

  test('全事件映射（含 detail/phase）', () => {
    expect(ev('SessionStart')[0].kind).toBe('session.start');
    expect(ev('UserPromptSubmit')[0].kind).toBe('turn.start');
    expect(ev('PreToolUse', { tool_name: 'Edit' })[0]).toMatchObject({ kind: 'tool.call', detail: 'Edit' });
    expect(ev('PermissionRequest', { tool_name: 'Bash' })[0]).toMatchObject({
      kind: 'permission.request',
      detail: 'Bash',
    });
    expect(ev('Stop')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('PostToolUse')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
    expect(ev('PostCompaction')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
    expect(ev('SessionEnd')[0].kind).toBe('session.end');
    expect(ev('SomethingNew')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
  });

  test('UserPromptSubmit 带 prompt 当标题；缺 session_id 落 unknown', () => {
    expect(ev('UserPromptSubmit', { prompt: '修一下构建' })[0]).toMatchObject({
      kind: 'turn.start',
      title: '修一下构建',
    });
    expect(translateDevinHook({ hook_event_name: 'Stop' })[0].sessionId).toBe('unknown');
    expect(translateDevinHook(null)[0]).toMatchObject({ agent: 'devin', sessionId: 'unknown', kind: 'status' });
  });
});

describe('devin hooks 安装（config.json 的 hooks 键）', () => {
  test('mergeDevinHooksConfig：幂等且保留他人条目', () => {
    const cfg: Record<string, unknown> = {
      devin: { org_id: 'org-x' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/other/tool.sh', timeout: 10 }] }] },
    };
    const command = writeHookScript('devin');
    expect(mergeDevinHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(true);
    const hooks = cfg.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(2); // 他人条目原样保留
    expect(mergeDevinHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(false);
    expect(cfg.devin).toEqual({ org_id: 'org-x' }); // 同住键不动
  });

  test('installHooks：写入全事件 + 保留 config 其余键 + 二次调用幂等 + 卸载只删我方', async () => {
    mkdirSync(join(DEVIN_CONFIG, '..'), { recursive: true });
    writeFileSync(
      DEVIN_CONFIG,
      JSON.stringify({
        devin: { org_id: 'org-test' },
        permissions: { allow: ['exec'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/orca/hook.sh', timeout: 10 }] }] },
      }),
    );
    const adapter = createDevinAdapter();
    expect((await adapter.installHooks()).changed).toBe(true);
    const cfg = JSON.parse(readFileSync(DEVIN_CONFIG, 'utf8')) as Record<string, unknown>;
    const hooks = cfg.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(Object.keys(hooks)).toHaveLength(8);
    expect(hooks.SessionStart).toHaveLength(2); // orca 保留 + 我方追加
    expect(hooks.PermissionRequest?.[0]?.hooks?.[0]?.command).toContain('agent-hooks/devin.sh');
    expect(hooks.PermissionRequest?.[0]?.hooks?.[0]?.async).toBeUndefined(); // devin schema 不带 async
    expect(cfg.permissions).toEqual({ allow: ['exec'] });
    expect((await adapter.installHooks()).changed).toBe(false);

    const info = await adapter.detect();
    expect(info.hookInstalled).toBe(true);
    expect(info.supportsByok).toBe(true);

    expect((await adapter.uninstallHooks?.())?.changed).toBe(true);
    const after = JSON.parse(readFileSync(DEVIN_CONFIG, 'utf8')) as Record<string, unknown>;
    const hooksAfter = after.hooks as Record<string, unknown[]>;
    expect(hooksAfter.SessionStart).toHaveLength(1); // 只剩 orca
    expect(JSON.stringify(after.hooks)).not.toContain('agent-hooks/devin.sh');
    removeHookScript('devin');
  });
});

describe('devin quota', () => {
  const ORIG_FETCH = globalThis.fetch;
  const stubFetch = (handler: (url: string) => Response | Promise<Response>) => {
    globalThis.fetch = (async (url: unknown) => handler(String(url))) as unknown as typeof fetch;
  };
  const writeCred = () => {
    mkdirSync(DEVIN_DATA, { recursive: true });
    writeFileSync(
      join(DEVIN_DATA, 'credentials.toml'),
      'windsurf_api_key = "tok-test"\napi_server_url = "https://server.codeium.com"\ndevin_api_url = "https://api.devin.ai"\n',
    );
  };

  test('readDevinCredentials 解析 toml', () => {
    writeCred();
    const c = readDevinCredentials(join(DEVIN_DATA, 'credentials.toml'));
    expect(c?.apiKey).toBe('tok-test');
    expect(c?.devinApiUrl).toBe('https://api.devin.ai');
  });

  test('本机凭据通道：GetUserStatus → 日/周配额窗口 + plan + org', async () => {
    writeCred();
    stubFetch((url) => {
      expect(url).toContain('SeatManagementService/GetUserStatus');
      return new Response(
        JSON.stringify({
          userStatus: {
            planStatus: {
              planInfo: { planName: 'Pro', devinInfo: { orgId: 'org-9' } },
              dailyQuotaRemainingPercent: 60,
              weeklyQuotaRemainingPercent: 8,
              dailyQuotaResetAtUnix: '1791014400',
              planEnd: '2026-10-11T11:00:59Z',
              acuConsumed: 3.5,
              acuLimit: 20,
            },
          },
        }),
      );
    });
    try {
      const q = await fetchDevinQuota();
      expect(q.plan).toBe('Pro');
      expect(q.windows.map((w) => w.label)).toEqual(['每日', '每周', 'ACU 周期']);
      expect(q.windows[0]).toMatchObject({ usedPct: 40, resetsAt: 1791014400 * 1000 });
      expect(q.windows[2]).toMatchObject({ used: 3.5, limit: 20, usedPct: 18 });
      expect(sniffDevinOrgId()).toBe('org-test'); // config.json 嗅探（上个用例已写）
    } finally {
      globalThis.fetch = ORIG_FETCH;
    }
  });

  test('BYOK 通道：consumption/daily 追加 ACU 窗口（无 limit）', async () => {
    writeCred();
    stubFetch((url) => {
      if (url.includes('GetUserStatus')) {
        return new Response(
          JSON.stringify({ userStatus: { planStatus: { planInfo: { planName: 'Pro' }, dailyQuotaRemainingPercent: 100 } } }),
        );
      }
      if (url.includes('consumption/daily')) {
        expect(url).toContain('/v3/organizations/org-test/');
        return new Response(
          JSON.stringify({
            total_acus: 12.5,
            consumption_by_date: [
              { date: 1790000000, acus: 4, acus_by_product: { devin: 4, cascade: 0, terminal: 0 } },
              { date: 1790086400, acus: 8.5, acus_by_product: { devin: 8, cascade: 0.5, terminal: 0 } },
            ],
          }),
        );
      }
      return new Response('not found', { status: 404 });
    });
    try {
      const q = await fetchDevinQuota({ apiKey: 'cog_test', updatedAt: 0 });
      expect(q.windows.map((w) => w.label)).toEqual(['每日', '最近一日 ACU', '近 30 日 ACU']);
      expect(q.windows[1]).toMatchObject({ used: 8.5, usedPct: 0 });
      expect(q.windows[2].used).toBe(12.5);
    } finally {
      globalThis.fetch = ORIG_FETCH;
    }
  });

  test('无凭据无 key → unavailable；有 key 无 org → enterprise 兜底', async () => {
    process.env.MURMUR_DEVIN_DATA = join(HOME, 'devin-empty');
    process.env.MURMUR_DEVIN_CONFIG = join(HOME, 'no-config.json'); // org_id 嗅探失败
    stubFetch((url) => {
      expect(url).toContain('/v3/enterprise/consumption/daily');
      return new Response(JSON.stringify({ total_acus: 1, consumption_by_date: [{ date: 1, acus: 1 }] }));
    });
    try {
      const q0 = await fetchDevinQuota();
      expect(q0.error).toBeTruthy();
      const q1 = await fetchDevinQuota({ apiKey: 'cog_x', updatedAt: 0 });
      expect(q1.windows.map((w) => w.label)).toEqual(['最近一日 ACU', '近 30 日 ACU']);
    } finally {
      globalThis.fetch = ORIG_FETCH;
      process.env.MURMUR_DEVIN_DATA = DEVIN_DATA;
      process.env.MURMUR_DEVIN_CONFIG = DEVIN_CONFIG;
    }
  });
});

describe('devin 计量去重签名', () => {
  test('旧裸拼接跨字段相撞（sid/mid 边界丢失），devinMetricKey 结构化编码不撞且同参稳定', () => {
    const legacyKey = (sid: string, mid: string, i: number, o: number, cr: number, cw: number) => `${sid}${mid}${i}|${o}|${cr}|${cw}`;
    // 旧写法：s1+2x 与 s12+x 不可区分——一行的真实推理会被判成另一行的 fork 复制。
    expect(legacyKey('s1', '2x', 10, 1, 0, 0)).toBe(legacyKey('s12', 'x', 10, 1, 0, 0));
    expect(devinMetricKey('s1', '2x', 10, 1, 0, 0)).not.toBe(devinMetricKey('s12', 'x', 10, 1, 0, 0));
    // 同参数稳定同键（去重的前提），字段含分隔符也不串位。
    expect(devinMetricKey('s1', 'm', 1, 2, 3, 4)).toBe(devinMetricKey('s1', 'm', 1, 2, 3, 4));
    expect(devinMetricKey('a|b', 'c', 0, 0, 0, 0)).not.toBe(devinMetricKey('a', 'b|c', 0, 0, 0, 0));
  });
});

describe('devin watch：message_nodes 台账', () => {
  test('请求级 metrics 增量记台账；fork 复制行去重、死档跳过、游标持久化', async () => {
    const { Database } = await import('bun:sqlite');
    const dir = join(HOME, 'devin-db');
    mkdirSync(join(dir, 'cli'), { recursive: true });
    process.env.MURMUR_DEVIN_DATA = dir;
    const db = new Database(join(dir, 'cli', 'sessions.db'));
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
               created_at INTEGER, last_activity_at INTEGER, title TEXT, hidden INTEGER DEFAULT 0);
             CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
               node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT)`);
    const now = Math.floor(Date.now() / 1000);
    const msg = (mid: string, i: number, o: number, cr = 0) =>
      JSON.stringify({ message_id: mid, role: 'assistant', metadata: { metrics: { input_tokens: i, output_tokens: o, cache_read_tokens: cr } } });
    db.run("INSERT INTO sessions VALUES('s1','/w','m-x',?,?,NULL,0)", [now - 100, now - 10]);
    // a) 正常推理行；b) 同 mid 同指标的 fork 复制（应去重）；c) 不同 mid 照计；d) 死档跳过。
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('s1',1,?,?)", [msg('m-a', 100, 10), now - 50]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('s1',2,?,?)", [msg('m-a', 100, 10), now - 49]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('s1',3,?,?)", [msg('m-b', 200, 20), now - 40]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('s1',4,?,?)", [msg('m-c', 999, 9), now - 80 * 86400]);

    // Ledger 钉本文件沙箱：MURMUR_HOME 冻结值取决于哪个测试文件先加载
    // paths.ts，裸 new Ledger() 可能开到真机库（游标污染全量测试）。
    const ledger = new Ledger(HOME);
    const events: Array<Record<string, unknown>> = [];
    const unwatch = await createDevinAdapter().watch!((e) => events.push(e as unknown as Record<string, unknown>), ledger);
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(2); // a + c；b 复制去重、d 死档跳过
    expect(usage.map((e) => (e.tokens as Record<string, number>).input)).toEqual([100, 200]);
    expect(ledger.getCursor('devin:mn_rowid')).toBe('3');

    unwatch();
    ledger.close();
    db.close();
    process.env.MURMUR_DEVIN_DATA = DEVIN_DATA;
  });

  test('跨会话同指标不因字段拼接相撞：旧编码会把 s1/2x 与 s12/x 判成同键（回归）', async () => {
    const { Database } = await import('bun:sqlite');
    const dir = join(HOME, 'devin-db-collision');
    mkdirSync(join(dir, 'cli'), { recursive: true });
    process.env.MURMUR_DEVIN_DATA = dir;
    const db = new Database(join(dir, 'cli', 'sessions.db'));
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
               created_at INTEGER, last_activity_at INTEGER, title TEXT, hidden INTEGER DEFAULT 0);
             CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
               node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT)`);
    const now = Math.floor(Date.now() / 1000);
    const msg = (mid: string, i: number, o: number) =>
      JSON.stringify({ message_id: mid, role: 'assistant', metadata: { metrics: { input_tokens: i, output_tokens: o } } });
    // s1/2x 与 s12/x 在旧裸拼接下同键：游标后那行会被误判成复制行丢台账。
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('s1',1,?,?)", [msg('2x', 10, 1), now - 50]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('s12',2,?,?)", [msg('x', 10, 1), now - 40]);

    const ledger = new Ledger(join(dir, 'ledger'));
    ledger.setCursor('devin:mn_rowid', '1'); // 第一行已入账（播种），第二行走增量。
    const events: Array<Record<string, unknown>> = [];
    const unwatch = await createDevinAdapter().watch!((e) => events.push(e as unknown as Record<string, unknown>), ledger);
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(1); // 旧编码此处为 0——键相撞被去重吞掉
    expect(usage[0]).toMatchObject({ agent: 'devin', sessionId: 's12' });
    expect(ledger.getCursor('devin:mn_rowid')).toBe('2');

    unwatch();
    ledger.close();
    db.close();
    process.env.MURMUR_DEVIN_DATA = DEVIN_DATA;
  });

  test('去重集 LRU 有界：超限淘汰最旧签名，被淘汰键的迟到复制行照计（宁可罕见双计）', async () => {
    const { Database } = await import('bun:sqlite');
    const dir = join(HOME, 'devin-db-lru');
    mkdirSync(join(dir, 'cli'), { recursive: true });
    process.env.MURMUR_DEVIN_DATA = dir;
    const db = new Database(join(dir, 'cli', 'sessions.db'));
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
               created_at INTEGER, last_activity_at INTEGER, title TEXT, hidden INTEGER DEFAULT 0);
             CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
               node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT)`);
    const now = Math.floor(Date.now() / 1000);
    const msg = (mid: string, i: number, o: number) =>
      JSON.stringify({ message_id: mid, role: 'assistant', metadata: { metrics: { input_tokens: i, output_tokens: o } } });
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('sa',1,?,?)", [msg('m1', 10, 1), now - 50]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('sa',2,?,?)", [msg('m2', 20, 2), now - 49]);
    // 增量段（容量 2，播种已占满）：m3 新签名入集→淘汰 m1；m1 复制行照计→再淘汰 m2；
    // m2 复制行也照计（级联淘汰）——LRU 只保最近窗口，被淘汰键的迟到复制宁双计不漏计。
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('sa',3,?,?)", [msg('m3', 30, 3), now - 40]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('sa',4,?,?)", [msg('m1', 10, 1), now - 39]);
    db.run("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES('sa',5,?,?)", [msg('m2', 20, 2), now - 38]);

    const ledger = new Ledger(join(dir, 'ledger'));
    ledger.setCursor('devin:mn_rowid', '2'); // 前两行播种，容量 2 全占满。
    const events: Array<Record<string, unknown>> = [];
    const unwatch = await createDevinAdapter({ metricSeenCap: 2 }).watch!((e) => events.push(e as unknown as Record<string, unknown>), ledger);
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage.map((e) => (e.tokens as Record<string, number>).input)).toEqual([30, 10, 20]);

    unwatch();
    ledger.close();
    db.close();
    process.env.MURMUR_DEVIN_DATA = DEVIN_DATA;
  });
});

afterAll(() => {
  removeHookScript('devin');
});
