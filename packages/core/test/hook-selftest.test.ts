/**
 * hook 链路自检端到端：真 ingest server + 真台账，marker 事件走全真链路
 * （POST → translate → record；spool 行 → drainSpool → record），
 * 验逐步回报与验后清场。沙箱：MURMUR_HOME 动态 import 前钉 tmpdir。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MURMUR_HOME = mkdtempSync(join(tmpdir(), 'murmur-selftest-'));

const { Ledger } = await import('../src/ledger/db');
const { startIngestServer } = await import('../src/ingest/server');
const { MURMUR_HOME } = await import('../src/paths');
const { runHookTest, SELFTEST_PREFIX } = await import('../src/engine/diagnostics');
const { createKimiAdapter } = await import('../src/agents/kimi');

import type { AgentId } from '../src/types';

describe('hook 链路自检（全真链路）', () => {
  const ledger = new Ledger(MURMUR_HOME);
  const adapter = createKimiAdapter();
  let observed = true;

  /** 模拟 registry.translateHook：spool 解包 + translate + ingest_（含停用丢弃）。 */
  const seen = new Set<string>();
  const translate = (agent: AgentId, payload: unknown) => {
    const wrapped = payload as { p?: unknown; _spooledAt?: number } | undefined;
    const inner = wrapped && typeof wrapped === 'object' && 'p' in wrapped ? wrapped.p : payload;
    for (const e of adapter.translateHook?.(inner) ?? []) {
      seen.add(e.sessionId);
      if (observed) ledger.record({ ...e, at: e.at });
    }
  };
  const server = startIngestServer({ translate });
  afterAll(() => server.close());

  test('marker 全链路绿：endpoint/health/POST/翻译/台账/spool 逐步 ok', async () => {
    const r = await runHookTest({ agent: 'kimi', adapter, ledger, translate, observed: true, installed: true });
    expect(r.ok).toBe(true);
    for (const s of r.steps) expect(s.ok).toBe(true);
    // marker 确实进过链路，验后清场不留台账。
    expect([...seen].some((s) => s.startsWith(SELFTEST_PREFIX))).toBe(true);
    for (const sid of seen) expect(ledger.sessionEventCount(sid)).toBe(0);
  });

  test('停用监听时如实报失败：POST 仍 202 但台账无 marker 行', async () => {
    observed = false;
    try {
      const r = await runHookTest({ agent: 'kimi', adapter, ledger, translate, observed: false, installed: true });
      expect(r.ok).toBe(false);
      expect(r.steps.find((s) => s.name.includes('台账'))?.ok).toBe(false);
    } finally {
      observed = true;
    }
  });

  test('未安装前置即败', async () => {
    const r = await runHookTest({ agent: 'kimi', adapter, ledger, translate, observed: true, installed: false });
    expect(r.ok).toBe(false);
    expect(r.steps[0].ok).toBe(false);
  });
});
