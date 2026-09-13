/**
 * kimi quota 回归：quota client 对凭据严格只读，绝不触碰凭据刷新端点。
 * 历史 bug：过期 token 时拿文件里的 refresh_token 代刷且不回写，作废 CLI 手上的
 * 旋转式 refresh token，导致 kimi-code 掉登录。过期唯一正解是降级 unavailable。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchKimiQuota } from '../src/quota/kimi';

const SAVED_ENV = process.env.MURMUR_KIMI_HOME;
const SAVED_FETCH = globalThis.fetch;

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.MURMUR_KIMI_HOME;
  else process.env.MURMUR_KIMI_HOME = SAVED_ENV;
  globalThis.fetch = SAVED_FETCH;
});

/** 写临时 kimi 主目录（credentials/kimi-code.json），并让 agentPaths 指过去。 */
function withKimiHome(creds: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-kimi-test-'));
  mkdirSync(join(dir, 'credentials'), { recursive: true });
  writeFileSync(join(dir, 'credentials', 'kimi-code.json'), JSON.stringify(creds));
  process.env.MURMUR_KIMI_HOME = dir;
  return dir;
}

describe('kimi quota', () => {
  test('token 过期 → 直接降级 unavailable，一次网络请求都不发', async () => {
    withKimiHome({ access_token: 'expired-at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) - 1 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('quota client 不得发起任何网络请求');
    }) as unknown as typeof fetch;
    const snap = await fetchKimiQuota();
    expect(calls).toBe(0);
    expect(snap.agent).toBe('kimi');
    expect(snap.windows).toHaveLength(0);
    expect(snap.error).toContain('过期');
  });

  test('凭据缺失 → unavailable 未登录，且不发起请求', async () => {
    withKimiHome({});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const snap = await fetchKimiQuota();
    expect(calls).toBe(0);
    expect(snap.error).toContain('未登录');
  });

  test('新鲜 token → 只打 /usages，Bearer 头与窗口映射正确', async () => {
    withKimiHome({ access_token: 'fresh-at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 900 });
    let url = '';
    let auth = '';
    globalThis.fetch = (async (u: unknown, init?: { headers?: Record<string, string> }) => {
      url = String(u);
      auth = init?.headers?.Authorization ?? '';
      return new Response(
        JSON.stringify({
          usage: { used: 120, limit: 1000, resetTime: '2026-09-12T12:00:00Z' },
          limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { used: 30, limit: 100 } }],
          user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const snap = await fetchKimiQuota();
    expect(url).toBe('https://api.kimi.com/coding/v1/usages');
    expect(auth).toBe('Bearer fresh-at');
    expect(snap.error).toBeUndefined();
    expect(snap.plan).toBe('intermediate');
    expect(snap.windows).toHaveLength(2);
    // summary 不带 window 字段 → 按周窗口处理。
    expect(snap.windows[0]).toMatchObject({ label: '每周', used: 120, limit: 1000 });
    expect(snap.windows[1]).toMatchObject({ label: '5h', used: 30, limit: 100 });
  });
});
