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

const { translateDevinHook, createDevinAdapter } = await import('../src/agents/devin');
const { fetchDevinQuota, readDevinCredentials, sniffDevinOrgId } = await import('../src/quota/devin');
const { mergeDevinHooksConfig, writeHookScript, removeHookScript } = await import('../src/hooks/install');

describe('devin hook 事件翻译', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    translateDevinHook({ hook_event_name: name, session_id: 's1', cwd: '/w', ...extra });

  test('全事件映射', () => {
    expect(ev('SessionStart')[0].kind).toBe('session.start');
    expect(ev('UserPromptSubmit')[0].kind).toBe('turn.start');
    expect(ev('PreToolUse')[0].kind).toBe('tool.call');
    expect(ev('PermissionRequest')[0].kind).toBe('permission.request');
    expect(ev('Stop')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('PostToolUse')[0].kind).toBe('status');
    expect(ev('PostCompaction')[0].kind).toBe('status');
    expect(ev('SessionEnd')[0].kind).toBe('session.end');
    expect(ev('SomethingNew')[0].kind).toBe('status');
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

afterAll(() => {
  removeHookScript('devin');
});
