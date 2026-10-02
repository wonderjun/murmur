/**
 * zcode quota（BYOK）单测。
 *
 * 端点：GET {base}/api/monitor/usage/quota/limit，Bearer API Key。
 * base 解析序：byok.baseUrl → coding-plan-cache.json entitlement 嗅探 → api.z.ai。
 * MURMUR_ZCODE_HOME 钉 tmpdir（agentPaths 在函数体内读 env，运行时覆盖生效）。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchZcodeQuota } from '../src/quota/zcode';

const SAVED_ENV = process.env.MURMUR_ZCODE_HOME;
const SAVED_FETCH = globalThis.fetch;

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.MURMUR_ZCODE_HOME;
  else process.env.MURMUR_ZCODE_HOME = SAVED_ENV;
  globalThis.fetch = SAVED_FETCH;
});

/** 建沙箱 zcode 主目录；items 非空时写 v2/coding-plan-cache.json entitlement。 */
function withZcodeHome(items?: Record<string, { status: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-zcode-test-'));
  process.env.MURMUR_ZCODE_HOME = dir;
  if (items) {
    mkdirSync(join(dir, 'v2'), { recursive: true });
    writeFileSync(
      join(dir, 'v2', 'coding-plan-cache.json'),
      JSON.stringify({ version: 1, entryStatus: { updatedAt: 0, items } }),
    );
  }
  return dir;
}

/** stub fetch：记录 url/Authorization，回指定响应体与状态。 */
function stubFetch(body: unknown, status = 200) {
  const seen = { calls: 0, url: '', auth: '' };
  globalThis.fetch = (async (u: unknown, init?: { headers?: Record<string, string> }) => {
    seen.calls += 1;
    seen.url = String(u);
    seen.auth = init?.headers?.Authorization ?? '';
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return seen;
}

// open.bigmodel.cn 实测形状：CREDIT_LIMIT + usage(上限)/currentValue(已用)/remaining。
const SAMPLE = {
  code: 200,
  msg: '操作成功',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 183, remaining: 1816, percentage: 9, nextResetTime: 1790059480017 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 2010, remaining: 7989, percentage: 20, nextResetTime: 1790485141992 },
      { type: 'TIME_LIMIT', unit: 5, percentage: 0, nextResetTime: 1780336384978 },
    ],
    level: 'pro',
  },
  success: true,
};

describe('zcode quota（BYOK）', () => {
  test('未配置 key → unavailable，一次请求都不发', async () => {
    withZcodeHome();
    const seen = stubFetch(SAMPLE);
    const snap = await fetchZcodeQuota();
    expect(seen.calls).toBe(0);
    expect(snap.agent).toBe('zcode');
    expect(snap.windows).toHaveLength(0);
    expect(snap.error).toContain('API Key');
  });

  test('有 key → 打 quota/limit，Bearer 头与三窗口映射正确', async () => {
    withZcodeHome();
    const seen = stubFetch(SAMPLE);
    const snap = await fetchZcodeQuota({ apiKey: 'sk-live-999', updatedAt: 0 });
    expect(seen.url).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(seen.auth).toBe('Bearer sk-live-999');
    expect(snap.error).toBeUndefined();
    expect(snap.plan).toBe('pro');
    expect(snap.windows.map((w) => w.label)).toEqual(['5h', '每周', 'MCP 月度']);
    // CREDIT_LIMIT：used=currentValue、limit=usage（已用+剩余≈上限）。
    expect(snap.windows[0]).toMatchObject({ usedPct: 9, used: 183, limit: 2000, resetsAt: 1790059480017 });
    expect(snap.windows[1]).toMatchObject({ usedPct: 20, used: 2010, limit: 10000 });
  });

  test('国际站样例 TOKENS_LIMIT 同 unit 映射（type 双形兼容）', async () => {
    withZcodeHome();
    stubFetch({
      code: 200,
      data: {
        limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 16, nextResetTime: 1777819631597 }],
        level: 'lite',
      },
    });
    const snap = await fetchZcodeQuota({ apiKey: 'sk-global', updatedAt: 0 });
    expect(snap.windows[0]).toMatchObject({ label: '5h', usedPct: 16 });
  });

  test('bigmodel entitlement → 自动打中国站 open.bigmodel.cn', async () => {
    withZcodeHome({ 'builtin:bigmodel-coding-plan': { status: 'available' }, 'builtin:zai-coding-plan': { status: 'unavailable' } });
    const seen = stubFetch(SAMPLE);
    await fetchZcodeQuota({ apiKey: 'sk-cn', updatedAt: 0 });
    expect(seen.url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  });

  test('byok.baseUrl 手动覆盖优先于嗅探', async () => {
    withZcodeHome({ 'builtin:bigmodel-coding-plan': { status: 'available' } });
    const seen = stubFetch(SAMPLE);
    await fetchZcodeQuota({ apiKey: 'sk-x', baseUrl: 'https://api.z.ai', updatedAt: 0 });
    expect(seen.url).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
  });

  test('响应体 code!==200 → unavailable', async () => {
    withZcodeHome();
    stubFetch({ code: 401, msg: 'unauthorized' });
    const snap = await fetchZcodeQuota({ apiKey: 'sk-bad', updatedAt: 0 });
    expect(snap.windows).toHaveLength(0);
    expect(snap.error).toContain('无效');
  });

  test('HTTP 非 2xx → unavailable 降级', async () => {
    withZcodeHome();
    stubFetch('Forbidden', 403);
    const snap = await fetchZcodeQuota({ apiKey: 'sk-bad', updatedAt: 0 });
    expect(snap.windows).toHaveLength(0);
    expect(snap.error).toBeDefined();
  });
});
