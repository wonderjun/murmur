/**
 * cursor 回归：hook payload 映射、transcript 行翻译（无时间戳→at 由调用方给）、
 * quota client 对凭据严格只读（过期 token 降级 unavailable，绝不碰刷新端点、
 * 一次网络请求都不发——与 kimi 同款铁律）。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { translateHookPayload, translateTranscriptLine } from '../src/agents/cursor';
import { fetchCursorQuota } from '../src/quota/cursor';

const SAVED_STATE_DB = process.env.MURMUR_CURSOR_STATE_DB;
const SAVED_CLI_AUTH = process.env.MURMUR_CURSOR_CLI_AUTH;
const SAVED_FETCH = globalThis.fetch;

afterEach(() => {
  if (SAVED_STATE_DB === undefined) delete process.env.MURMUR_CURSOR_STATE_DB;
  else process.env.MURMUR_CURSOR_STATE_DB = SAVED_STATE_DB;
  if (SAVED_CLI_AUTH === undefined) delete process.env.MURMUR_CURSOR_CLI_AUTH;
  else process.env.MURMUR_CURSOR_CLI_AUTH = SAVED_CLI_AUTH;
  globalThis.fetch = SAVED_FETCH;
});

/** 临时 state.vscdb fixture：ItemTable 写入 cursorAuth 行，并让 agentPaths 指过去。 */
function withStateDb(rows: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-cursor-test-'));
  const dbPath = join(dir, 'state.vscdb');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  for (const [k, v] of Object.entries(rows)) {
    db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [k, v]);
  }
  db.close();
  process.env.MURMUR_CURSOR_STATE_DB = dbPath;
  // 防真机 CLI auth.json 兜底命中——指向一个不存在的路径。
  process.env.MURMUR_CURSOR_CLI_AUTH = join(dir, 'nonexistent-auth.json');
  return dbPath;
}

/** 拼一个假 JWT（只编码 payload，不验签——本地 token 本来就不需要验）。 */
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('cursor hook payload', () => {
  test('beforeSubmitPrompt → session.start + turn.start；stop → turn.end', () => {
    const start = translateHookPayload({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1' });
    expect(start.map((e) => e.kind)).toEqual(['session.start', 'turn.start']);
    expect(start[0].sessionId).toBe('c1');

    const stop = translateHookPayload({ hookEventName: 'stop', conversationId: 'c1' });
    expect(stop.map((e) => e.kind)).toEqual(['turn.end']);
    expect(stop[0].waitingReason).toBe('turn-end');
  });

  test('CLI 也发的事件：sessionStart/postToolUse/afterShellExecution 归位', () => {
    expect(translateHookPayload({ hook_event_name: 'sessionStart', session_id: 's1' })[0].kind).toBe('session.start');
    // 前置事件 → tool.call（带工具名 detail）；收尾事件 → thinking 心跳回模型往返。
    const pre = translateHookPayload({ hook_event_name: 'preToolUse', session_id: 's1', tool_name: 'Shell' });
    expect(pre[0]).toMatchObject({ kind: 'tool.call', detail: 'Shell' });
    expect(translateHookPayload({ hook_event_name: 'postToolUse', session_id: 's1' })[0]).toMatchObject({
      kind: 'status',
      status: 'working',
      phase: 'thinking',
    });
    expect(translateHookPayload({ hook_event_name: 'afterShellExecution', session_id: 's1' })[0]).toMatchObject({
      kind: 'status',
      phase: 'thinking',
    });
    expect(translateHookPayload({ hook_event_name: 'sessionEnd', session_id: 's1' })[0].kind).toBe('session.end');
  });

  test('未知事件 → status(thinking) 心跳', () => {
    const evs = translateHookPayload({ hook_event_name: 'afterAgentThought', session_id: 's1' });
    expect(evs[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
  });
});

describe('cursor transcript 行', () => {
  const P = '/Users/x/.cursor/projects/Users-x-foo/agent-transcripts/u-1/u-1.jsonl';
  const SUB = '/Users/x/.cursor/projects/Users-x-foo/agent-transcripts/u-1/subagents/u-2.jsonl';
  const NOW = Date.now();

  test('user 行 → session.start + turn.start，sessionId 取文件名 uuid', () => {
    const evs = translateTranscriptLine(P, { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }, NOW);
    expect(evs.map((e) => e.kind)).toEqual(['session.start', 'turn.start']);
    expect(evs[0].sessionId).toBe('u-1');
    expect(evs[0].at).toBe(NOW);
  });

  test('assistant tool_use → tool.call；纯文本 → status(working)', () => {
    const tool = translateTranscriptLine(
      P,
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
      NOW,
    );
    expect(tool[0].kind).toBe('tool.call');
    const text = translateTranscriptLine(P, { role: 'assistant', message: { content: [{ type: 'text', text: '…' }] } }, NOW);
    expect(text[0].kind).toBe('status');
    expect(text[0].status).toBe('working');
  });

  test('turn_ended/error → turn.end；title 只在调用方给定时挂上', () => {
    const end = translateTranscriptLine(P, { type: 'turn_ended', status: 'success' }, NOW);
    expect(end[0].kind).toBe('turn.end');
    const withTitle = translateTranscriptLine(P, { role: 'user', message: { content: [] } }, NOW, '修复登录');
    expect(withTitle[0].title).toBe('修复登录');
  });

  test('subagents/ 行归并父会话且不搬 turn 边界', () => {
    const evs = translateTranscriptLine(SUB, { type: 'turn_ended', status: 'success' }, NOW);
    expect(evs[0].sessionId).toBe('u-1');
    expect(evs[0].kind).toBe('status');
    const tool = translateTranscriptLine(SUB, { role: 'assistant', message: { content: [{ type: 'tool_use' }] } }, NOW);
    expect(tool[0].sessionId).toBe('u-1');
    expect(tool[0].kind).toBe('tool.call');
  });
});

describe('cursor quota', () => {
  test('凭据全缺 → unavailable 未登录，不发请求', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-cursor-test-'));
    process.env.MURMUR_CURSOR_STATE_DB = join(dir, 'missing.vscdb');
    process.env.MURMUR_CURSOR_CLI_AUTH = join(dir, 'missing.json');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const snap = await fetchCursorQuota();
    expect(calls).toBe(0);
    expect(snap.agent).toBe('cursor');
    expect(snap.error).toContain('未登录');
  });

  test('过期 JWT → unavailable，一次网络请求都不发', async () => {
    withStateDb({
      'cursorAuth/accessToken': fakeJwt({ sub: 'google-oauth2|user_x', exp: Math.floor(Date.now() / 1000) - 1 }),
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('quota client 不得发起任何网络请求');
    }) as unknown as typeof fetch;
    const snap = await fetchCursorQuota();
    expect(calls).toBe(0);
    expect(snap.error).toContain('过期');
  });

  test('新鲜 JWT → usage-summary，Cookie 拼 userId%3A%3Atoken，窗口映射正确', async () => {
    const token = fakeJwt({ sub: 'google-oauth2|user_abc', exp: Math.floor(Date.now() / 1000) + 3600 });
    withStateDb({ 'cursorAuth/accessToken': token, 'cursorAuth/stripeMembershipType': 'pro' });
    let cookie = '';
    let ua = '';
    globalThis.fetch = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      cookie = init?.headers?.Cookie ?? '';
      ua = init?.headers?.['User-Agent'] ?? '';
      return new Response(
        JSON.stringify({
          membershipType: 'pro',
          billingCycleEnd: '2026-10-04T00:00:00.000Z',
          individualUsage: {
            plan: { totalPercentUsed: 42.4, autoPercentUsed: 10, apiPercentUsed: 90.6 },
            onDemand: { enabled: true, used: 150, limit: 2000 },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const snap = await fetchCursorQuota();
    expect(cookie).toBe(`WorkosCursorSessionToken=user_abc%3A%3A${token}`);
    expect(ua).toContain('Mozilla');
    expect(snap.error).toBeUndefined();
    expect(snap.plan).toBe('pro');
    expect(snap.windows.map((w) => w.label)).toEqual(['本周期', 'Auto', 'API', '按需']);
    expect(snap.windows[0].usedPct).toBe(42);
    expect(snap.windows[0].resetsAt).toBe(Date.parse('2026-10-04T00:00:00.000Z'));
    expect(snap.windows[3].used).toBe(1.5);
    expect(snap.windows[3].limit).toBe(20);
  });

  test('无 plan 对象 → 回退 api2 legacy 请求数窗口（Bearer 鉴权）', async () => {
    const token = fakeJwt({ sub: 'auth0|user_ent', exp: Math.floor(Date.now() / 1000) + 3600 });
    withStateDb({ 'cursorAuth/accessToken': token });
    const urls: string[] = [];
    const auths: string[] = [];
    globalThis.fetch = (async (u: unknown, init?: { headers?: Record<string, string> }) => {
      urls.push(String(u));
      auths.push(init?.headers?.Authorization ?? '');
      if (String(u).includes('usage-summary')) {
        return new Response(JSON.stringify({ membershipType: 'enterprise' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ 'gpt-4': { numRequests: 150, maxRequestUsage: 500 }, startOfMonth: '2026-09-01T00:00:00.000Z' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const snap = await fetchCursorQuota();
    expect(urls[0]).toContain('usage-summary');
    expect(urls[1]).toContain('api2.cursor.sh/auth/usage');
    expect(auths[1]).toBe(`Bearer ${token}`);
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]).toMatchObject({ label: 'premium 请求', used: 150, limit: 500, usedPct: 30 });
    expect(snap.plan).toBe('enterprise');
  });
});
