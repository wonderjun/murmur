/**
 * ingest 服务单测：端口、鉴权、路由。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离 MURMUR_HOME 再加载模块（endpoint 写在临时目录）。
process.env.MURMUR_HOME = mkdtempSync(join(tmpdir(), 'murmur-test-'));

const { startIngestServer } = await import('../src/ingest/server');

describe('ingest server', () => {
  const received: Array<{ agent: string; payload: unknown }> = [];
  const server = startIngestServer({ translate: (agent, p) => received.push({ agent, payload: p }) });
  const { port, token, file } = server.endpoint;
  afterAll(() => server.close());

  test('endpoint 文件写出且含端口与 token', () => {
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`MURMUR_AGENT_HOOK_PORT=${port}`);
    expect(text).toContain(`MURMUR_AGENT_HOOK_TOKEN=${token}`);
  });

  test('health 无需鉴权', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
  });

  test('正确 token 的 hook POST → 202 + translate 被调', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/hook/devin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Hook-Token': token },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }),
    });
    expect(r.status).toBe(202);
    await new Promise((r2) => setTimeout(r2, 20));
    expect(received[0].agent).toBe('devin');
  });

  test('错 token → 401；未知 agent → 404', async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/hook/devin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Hook-Token': 'nope' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    const unknown = await fetch(`http://127.0.0.1:${port}/hook/nobody`, {
      method: 'POST',
      headers: { 'X-Murmur-Hook-Token': token },
      body: '{}',
    });
    expect(unknown.status).toBe(404);
  });
});

