/**
 * opencode adapter 单测。
 *
 * 覆盖：事件翻译（session.status 新旧两形载荷、permission 三事件、model 对象取值）、
 * push 平面 usage 剥离、watch() 的 message 表 join 补 model（真 sqlite fixture）、
 * legacy storage/message JSON 回退的 delta 入账与重启不重复。
 * 坑：MURMUR_OPENCODE_DATA 在 agentPaths() 函数体内读 env——先钉沙箱 env 再建 adapter。
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpencodeAdapter, translateOpencodeEvent } from '../src/agents/opencode';
import { Ledger } from '../src/ledger/db';
import type { AgentEvent } from '../src/types';

const NOW = Date.now();

describe('translateOpencodeEvent', () => {
  test('session.status 旧版裸字符串：busy→turn.start / idle→turn.end', () => {
    const busy = translateOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: 'busy' },
    });
    expect(busy[0].kind).toBe('turn.start');
    const idle = translateOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: 'idle' },
    });
    expect(idle[0].kind).toBe('turn.end');
    expect(idle[0].waitingReason).toBe('turn-end');
  });

  test('session.status 新版对象载荷 {type}：busy/idle 同上，retry→status', () => {
    const busy = translateOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'busy' } },
    });
    expect(busy[0].kind).toBe('turn.start');
    const idle = translateOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    });
    expect(idle[0].kind).toBe('turn.end');
    const retry = translateOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'retry', attempt: 2 } },
    });
    expect(retry[0].kind).toBe('status');
  });

  test('permission.asked/updated→permission.request(带权限名)，replied→tool.call，已决不迁移', () => {
    const asked = translateOpencodeEvent({
      type: 'permission.asked',
      properties: { sessionID: 'ses_1', id: 'per_1', permission: 'bash', patterns: ['git push *'] },
    });
    expect(asked[0]).toMatchObject({ kind: 'permission.request', detail: 'bash · git push *' });
    const updated = translateOpencodeEvent({
      type: 'permission.updated',
      properties: { sessionID: 'ses_1', id: 'per_1' },
    });
    expect(updated[0].kind).toBe('permission.request');
    const resolved = translateOpencodeEvent({
      type: 'permission.updated',
      properties: { sessionID: 'ses_1', id: 'per_1', response: 'allow' },
    });
    expect(resolved[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
    const replied = translateOpencodeEvent({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', requestID: 'per_1', action: 'allow' },
    });
    expect(replied[0].kind).toBe('tool.call');
  });

  test('question.asked → waiting(question,问题原文)；replied/rejected → working(thinking)', () => {
    const asked = translateOpencodeEvent({
      type: 'question.asked',
      properties: { sessionID: 'ses_1', questions: [{ question: '走哪条迁移路径？', header: '方向' }] },
    });
    expect(asked[0]).toMatchObject({
      kind: 'status',
      status: 'waiting',
      waitingReason: 'question',
      detail: '走哪条迁移路径？',
    });
    for (const t of ['question.replied', 'question.rejected', 'question.cancelled']) {
      const out = translateOpencodeEvent({ type: t, properties: { sessionID: 'ses_1' } });
      expect(out[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    }
  });

  test('session.updated 的 info.model 对象取 id 作 model；累计 tokens 不落账', () => {
    const out = translateOpencodeEvent({
      type: 'session.updated',
      properties: {
        sessionID: 'ses_1',
        info: {
          id: 'ses_1',
          title: 'T',
          model: { id: 'gpt-6-astra', providerID: 'kkai', variant: 'default' },
          tokens: { input: 999, output: 9 },
        },
      },
    });
    expect(out[0].kind).toBe('status');
    expect(out[0].model).toBe('gpt-6-astra');
    expect(out[0].title).toBe('T');
    expect(out.every((e) => e.kind !== 'usage')).toBe(true);
  });

  test('message.part.updated step-finish + tokens → [usage, turn.end]', () => {
    const out = translateOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_1',
          messageID: 'msg_1',
          type: 'step-finish',
          tokens: { total: 100, input: 60, output: 40, reasoning: 0, cache: { read: 10, write: 0 } },
        },
        time: NOW,
      },
    });
    expect(out.map((e) => e.kind)).toEqual(['usage', 'turn.end']);
    expect(out[0].tokens).toEqual({ input: 60, output: 40, cacheRead: 10, cacheWrite: 0, reasoning: 0 });
  });

  test('part tool：running → tool.call(带工具名)；completed → working(thinking)', () => {
    const running = translateOpencodeEvent({
      type: 'message.part.updated',
      properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', state: { status: 'running' } } },
    });
    expect(running[0]).toMatchObject({ kind: 'tool.call', detail: 'bash' });
    const done = translateOpencodeEvent({
      type: 'message.part.updated',
      properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', state: { status: 'completed' } } },
    });
    expect(done[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
  });

  test('session.error → status（不迁移状态）', () => {
    const out = translateOpencodeEvent({
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { message: 'boom' } },
    });
    expect(out[0].kind).toBe('status');
  });
});

describe('translateHook（push 平面）', () => {
  test('usage 事件被剥离，turn.end 保留——pull 独掌台账', () => {
    const adapter = createOpencodeAdapter();
    const out = adapter.translateHook?.({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: { id: 'prt_1', messageID: 'msg_1', type: 'step-finish', tokens: { total: 1, input: 1, output: 1 } },
        time: NOW,
      },
    });
    expect(out?.map((e) => e.kind)).toEqual(['turn.end']);
  });
});

describe('watch（pull 平面，真 sqlite fixture）', () => {
  /** 造一个最小 opencode.db：event + message 两张表（watch 只查这两张）。 */
  function makeDb(home: string) {
    const db = new Database(join(home, 'opencode.db'));
    db.exec(`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text, seq integer, type text, data text);
             CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)`);
    return db;
  }
  const ev = (id: string, type: string, data: unknown) => ({ id, type, data: JSON.stringify(data) });

  test('usage 经 message 表 join 补 model；message.updated 行顺路喂 cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-oc-'));
    const db = makeDb(home);
    db.run('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)', [
      'msg_1',
      'ses_1',
      NOW,
      NOW,
      JSON.stringify({ id: 'msg_1', sessionID: 'ses_1', role: 'assistant', modelID: 'gpt-6-astra' }),
    ]);
    // msg_2 不在 message 表：靠同批 message.updated 事件喂 cache。
    const rows = [
      ev('e1', 'session.created.1', {
        sessionID: 'ses_1',
        info: { id: 'ses_1', title: 'T', directory: '/w', time: { created: NOW } },
      }),
      ev('e2', 'message.updated.1', {
        sessionID: 'ses_1',
        info: { id: 'msg_2', sessionID: 'ses_1', role: 'assistant', modelID: 'kimi-k2', time: { created: NOW } },
      }),
      ev('e3', 'message.part.updated.1', {
        sessionID: 'ses_1',
        part: { id: 'prt_1', messageID: 'msg_1', type: 'step-finish', tokens: { total: 10, input: 6, output: 4 } },
        time: NOW,
      }),
      ev('e4', 'message.part.updated.1', {
        sessionID: 'ses_1',
        part: { id: 'prt_2', messageID: 'msg_2', type: 'step-finish', tokens: { total: 8, input: 5, output: 3 } },
        time: NOW,
      }),
    ];
    for (const r of rows) db.run('INSERT INTO event (id, type, data) VALUES (?,?,?)', [r.id, r.type, r.data]);
    db.close();

    process.env.MURMUR_OPENCODE_DATA = home;
    const adapter = createOpencodeAdapter();
    const ledger = new Ledger(mkdtempSync(join(tmpdir(), 'murmur-ledger-')));
    const emitted: AgentEvent[] = [];
    const off = await adapter.watch?.((e) => emitted.push(e), ledger);
    try {
      const usage = emitted.filter((e) => e.kind === 'usage');
      expect(usage).toHaveLength(2);
      expect(usage[0].model).toBe('gpt-6-astra'); // message 表 join
      expect(usage[1].model).toBe('kimi-k2'); // 同批 message.updated 喂的 cache
      expect(emitted.some((e) => e.kind === 'session.start')).toBe(true);
      expect(Number(ledger.getCursor('opencode:event'))).toBeGreaterThan(0);
    } finally {
      off?.();
      ledger.close();
      delete process.env.MURMUR_OPENCODE_DATA;
    }
  });
});

describe('legacy JSON 回退（无 opencode.db）', () => {
  test('storage/message 扫描发 delta usage；重开 watch 不重复入账', async () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-oc-legacy-'));
    mkdirSync(join(home, 'storage', 'message', 'ses_9'), { recursive: true });
    mkdirSync(join(home, 'storage', 'session', 'proj'), { recursive: true });
    writeFileSync(
      join(home, 'storage', 'message', 'ses_9', 'msg_a.json'),
      JSON.stringify({
        id: 'msg_a',
        sessionID: 'ses_9',
        role: 'assistant',
        modelID: 'kimi-k2',
        tokens: { input: 100, output: 50, cache: { read: 10 } },
        time: { completed: NOW },
      }),
    );
    writeFileSync(
      join(home, 'storage', 'session', 'proj', 'ses_9.json'),
      JSON.stringify({ id: 'ses_9', title: 'T9', directory: '/w', time: { updated: NOW } }),
    );

    process.env.MURMUR_OPENCODE_DATA = home;
    const adapter = createOpencodeAdapter();
    const ledger = new Ledger(mkdtempSync(join(tmpdir(), 'murmur-ledger-')));
    try {
      const first: AgentEvent[] = [];
      const off1 = await adapter.watch?.((e) => first.push(e), ledger);
      await new Promise((r) => setTimeout(r, 100));
      off1?.();
      const usage = first.filter((e) => e.kind === 'usage');
      expect(usage).toHaveLength(1);
      expect(usage[0].tokens?.input).toBe(100);
      expect(usage[0].model).toBe('kimi-k2');
      expect(first.some((e) => e.kind === 'status' && e.title === 'T9')).toBe(true);
      expect(ledger.getCursor('opencode:jsonmsg:msg_a')).not.toBeNull();

      // 重开 watch（模拟重启）：mtime 重扫但 cursor 已记快照 → 不再发 usage。
      const second: AgentEvent[] = [];
      const off2 = await adapter.watch?.((e) => second.push(e), ledger);
      await new Promise((r) => setTimeout(r, 100));
      off2?.();
      expect(second.filter((e) => e.kind === 'usage')).toHaveLength(0);
    } finally {
      ledger.close();
      delete process.env.MURMUR_OPENCODE_DATA;
    }
  });
});
