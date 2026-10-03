/**
 * codex adapter 单测：rollout 翻译、hooks.json/notify 双通道翻译、
 * installHooks 双通道写入幂等、app-server 额度 RPC（fixture sh 假 codex）与 wham 回落。
 *
 * 坑：MURMUR_HOME 在 paths.ts 模块加载时固化——先钉沙箱 env 再动态 import。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'murmur-codex-test-'));
const CODEX_HOME = join(HOME, '.codex');
process.env.MURMUR_HOME = HOME;
process.env.MURMUR_CODEX_HOME = CODEX_HOME;

const { translateRolloutLine, translateCodexHook, translateCodexHookEvent, createCodexAdapter } = await import(
  '../src/agents/codex'
);
const { fetchCodexQuota } = await import('../src/quota/codex');
const { fetchCodexQuotaViaAppServer } = await import('../src/quota/codex-app-server');
const { mergeCodexHooksConfig, writeHookScript } = await import('../src/hooks/install');

const UUID = '12345678-1234-1234-1234-123456789abc';
const ROLLOUT = `/home/u/.codex/sessions/2026/09/13/rollout-2026-09-13T01-00-00-${UUID}.jsonl`;

describe('codex translateRolloutLine', () => {
  const ts = { timestamp: '2026-09-13T01:00:00.000Z' };

  test('session_meta → session.start；无时间戳行 at=0 走回填语义', () => {
    const out = translateRolloutLine(ROLLOUT, { ...ts, type: 'session_meta', payload: { id: UUID, cwd: '/w' } });
    expect(out[0]).toMatchObject({ kind: 'session.start', sessionId: UUID, cwd: '/w' });
    expect(translateRolloutLine(ROLLOUT, { type: 'event_msg', payload: { type: 'task_started' } })[0].at).toBe(0);
  });

  test('event_msg：task_complete→turn.end；approval→permission.request；token_count 取 last 增量', () => {
    expect(
      translateRolloutLine(ROLLOUT, { ...ts, type: 'event_msg', payload: { type: 'task_complete' } })[0],
    ).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    // exec_approval_request 的 command 数组拼成等待对象摘要。
    expect(
      translateRolloutLine(ROLLOUT, {
        ...ts,
        type: 'event_msg',
        payload: { type: 'exec_approval_request', command: ['git', 'push', '--force'] },
      })[0],
    ).toMatchObject({ kind: 'permission.request', detail: 'git push --force' });
    const usage = translateRolloutLine(ROLLOUT, {
      ...ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
          total_token_usage: { input_tokens: 999 },
        },
      },
    })[0];
    expect(usage.kind).toBe('usage');
    // input_tokens 是非缓存输入；cached_input_tokens 单列 cacheRead（互斥口径）。
    expect(usage.tokens).toMatchObject({ input: 10, output: 3, cacheRead: 2, reasoning: 1 });
  });

  test('response_item：function_call→tool.call(带工具名)，其余 status', () => {
    expect(
      translateRolloutLine(ROLLOUT, { ...ts, type: 'response_item', payload: { type: 'function_call', name: 'shell' } })[0],
    ).toMatchObject({ kind: 'tool.call', detail: 'shell' });
    expect(
      translateRolloutLine(ROLLOUT, { ...ts, type: 'response_item', payload: { type: 'reasoning' } })[0].kind,
    ).toBe('status');
  });

  test('sessionId 统一为文件名尾段 uuid：event_msg 无 id 落文件名，response_item 的条目 id 不吃', () => {
    expect(
      translateRolloutLine(ROLLOUT, { ...ts, type: 'event_msg', payload: { type: 'task_complete' } })[0].sessionId,
    ).toBe(UUID);
    expect(
      translateRolloutLine(ROLLOUT, {
        ...ts,
        type: 'response_item',
        payload: { type: 'function_call', id: 'fc_999', call_id: 'call_1' },
      })[0].sessionId,
    ).toBe(UUID);
  });
});

describe('codex hooks.json 事件翻译', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    translateCodexHookEvent({
      hook_event_name: name,
      session_id: 'sess-x',
      transcript_path: ROLLOUT,
      cwd: '/w',
      model: 'gpt-x',
      ...extra,
    });

  test('全事件映射（含 detail/phase）', () => {
    expect(ev('SessionStart')[0].kind).toBe('session.start');
    expect(ev('PreToolUse', { tool_name: 'Bash' })[0]).toMatchObject({ kind: 'tool.call', detail: 'Bash' });
    expect(ev('PermissionRequest', { tool_name: 'Edit' })[0]).toMatchObject({
      kind: 'permission.request',
      detail: 'Edit',
    });
    expect(ev('Stop')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('Interrupt')[0].kind).toBe('turn.end');
    expect(ev('SessionEnd')[0].kind).toBe('session.end');
    expect(ev('PostToolUse')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
    expect(ev('SubagentStart')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
    expect(ev('SomethingNew')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
  });

  test('UserPromptSubmit → turn.start 且 prompt 作 title', () => {
    expect(ev('UserPromptSubmit', { prompt: '修一下构建' })[0]).toMatchObject({
      kind: 'turn.start',
      title: '修一下构建',
    });
  });

  test('sessionId：transcript_path 尾段 uuid 优先（与 pull 平面对齐），否则回退字段', () => {
    expect(ev('SessionStart')[0].sessionId).toBe(UUID);
    expect(translateCodexHookEvent({ hook_event_name: 'Stop', session_id: 's9' })[0].sessionId).toBe('s9');
    expect(translateCodexHookEvent({ hook_event_name: 'Stop' })[0].sessionId).toBe('unknown');
  });
});

describe('codex translateCodexHook 分发', () => {
  test('hook_event_name → hooks.json 翻译；否则 legacy notify', () => {
    expect(translateCodexHook({ hook_event_name: 'PermissionRequest', session_id: 's1' })[0].kind).toBe(
      'permission.request',
    );
    const legacy = translateCodexHook({ type: 'agent-turn-complete', 'thread-id': 't7', cwd: '/w' });
    expect(legacy[0]).toMatchObject({ kind: 'turn.end', sessionId: 't7' });
  });
});

describe('codex hooks 安装', () => {
  test('mergeCodexHooksConfig：幂等且保留他人条目', () => {
    const cfg: Record<string, unknown> = {
      hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: '/other/tool.sh' }] }] },
    };
    // HOOKS_DIR 随模块加载时固化的 MURMUR_HOME 走（测试间共享进程，不能拿本文件 HOME 推）。
    const command = writeHookScript('codex');
    expect(mergeCodexHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(true);
    const hooks = cfg.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(2); // 他人条目原样保留
    expect(mergeCodexHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(false);
  });

  test('installHooks：hooks.json 全事件 + notify 双通道，二次调用幂等', async () => {
    mkdirSync(CODEX_HOME, { recursive: true });
    const adapter = createCodexAdapter();
    expect((await adapter.installHooks()).changed).toBe(true);
    const hooksJson = JSON.parse(readFileSync(join(CODEX_HOME, 'hooks.json'), 'utf8')) as Record<string, unknown>;
    const hooks = hooksJson.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(hooks.PermissionRequest[0].hooks[0].command).toContain('agent-hooks/codex.sh');
    expect(hooks.PermissionRequest[0].hooks[0].async).toBe(true);
    expect(Object.keys(hooks)).toHaveLength(12);
    expect(readFileSync(join(CODEX_HOME, 'config.toml'), 'utf8')).toContain('notify = [');
    expect((await adapter.installHooks()).changed).toBe(false);
  });

  test('installHooks：他人 notify 不覆盖，hooks.json 仍写入', async () => {
    const home2 = join(HOME, 'codex2');
    mkdirSync(home2, { recursive: true });
    writeFileSync(join(home2, 'config.toml'), 'notify = ["other-tool"]\n');
    process.env.MURMUR_CODEX_HOME = home2;
    try {
      await createCodexAdapter().installHooks();
      expect(readFileSync(join(home2, 'config.toml'), 'utf8')).toBe('notify = ["other-tool"]\n');
      const hooksJson = JSON.parse(readFileSync(join(home2, 'hooks.json'), 'utf8')) as Record<string, unknown>;
      expect(hooksJson.hooks).toBeTruthy();
    } finally {
      process.env.MURMUR_CODEX_HOME = CODEX_HOME;
    }
  });

  test('detect：hooks.json 已注入时提示 /hooks trust', async () => {
    process.env.MURMUR_CODEX_HOME = CODEX_HOME;
    const info = await createCodexAdapter().detect();
    expect(info.installed).toBe(true);
    expect(info.note).toContain('/hooks');
  });
});

describe('codex quota', () => {
  // 假 codex：按行答 JSON-RPC（initialize → rateLimits/read）。
  const FAKE = join(HOME, 'fake-codex.sh');
  writeFileSync(
    FAKE,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"id":0'*) printf '%s\\n' '{"id":0,"result":{"userAgent":"murmur-test","codexHome":"/tmp"}}' ;;
    *'"id":1'*) printf '%s\\n' '{"id":1,"result":{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":null,"limitName":null,"normalModelSlug":null,"primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1893456000},"secondary":{"usedPercent":7,"windowDurationMins":10080,"resetsAt":null},"credits":null,"individualLimit":null,"spendControlReached":null,"planType":"pro","rateLimitReachedType":null},"rateLimitsByLimitId":null,"rateLimitResetCredits":null,"accountId":"acc-1","rateLimitUpsell":null}}' ;;
  esac
done
`,
  );
  chmodSync(FAKE, 0o755);
  const NO_BIN = join(HOME, 'no-such-codex');

  test('app-server RPC 取回窗口与 plan', async () => {
    process.env.MURMUR_CODEX_BIN = FAKE;
    try {
      const q = await fetchCodexQuotaViaAppServer();
      expect(q.windows).toHaveLength(2);
      expect(q.windows[0]).toMatchObject({ label: '5h', usedPct: 42, resetsAt: 1893456000 * 1000 });
      expect(q.windows[1]).toMatchObject({ label: '每周', usedPct: 7 });
      expect(q.plan).toBe('pro');
    } finally {
      delete process.env.MURMUR_CODEX_BIN;
    }
  });

  test('app-server 不可达 → 回落 wham（auth.json + fetch）', async () => {
    process.env.MURMUR_CODEX_BIN = NO_BIN;
    mkdirSync(CODEX_HOME, { recursive: true });
    writeFileSync(
      join(CODEX_HOME, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'tok', account_id: 'acc' } }),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 55, reset_at: 1893456000 },
            secondary_window: { used_percent: 12, reset_at: 1894060800 },
          },
        }),
      )) as unknown as typeof fetch;
    try {
      const q = await fetchCodexQuota();
      expect(q.windows.map((w) => w.label)).toEqual(['5h', '每周']);
      expect(q.windows[0].usedPct).toBe(55);
      expect(q.plan).toBe('pro');
    } finally {
      globalThis.fetch = orig;
      delete process.env.MURMUR_CODEX_BIN;
    }
  });

  test('app-server 失败且无凭据 → unavailable', async () => {
    const home3 = join(HOME, 'codex3');
    mkdirSync(home3, { recursive: true });
    process.env.MURMUR_CODEX_BIN = NO_BIN;
    process.env.MURMUR_CODEX_HOME = home3;
    try {
      const q = await fetchCodexQuota();
      expect(q.windows).toHaveLength(0);
      expect(q.error).toBeTruthy();
    } finally {
      delete process.env.MURMUR_CODEX_BIN;
      process.env.MURMUR_CODEX_HOME = CODEX_HOME;
    }
  });
});
