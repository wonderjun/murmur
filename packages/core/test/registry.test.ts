/**
 * AgentRegistry 单测：fake adapter 边界 + dataDir 注入 + skipIngest，
 * 不探测真机目录、不绑真实端口、不写 ~/.murmur/endpoint。
 *
 * 坑：registry 依赖链会加载 paths.ts（MURMUR_HOME 模块加载时固化）——
 * 先钉沙箱 env 再动态 import；settings/credentials/台账再经 dataDir
 * 二次钉进本用例 tmpdir，双层隔离。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter } from '../src/agents/base';
import type { AgentEvent, AgentId, AppSnapshot } from '../src/types';

process.env.MURMUR_HOME = mkdtempSync(join(tmpdir(), 'murmur-registry-home-'));

const { AgentRegistry } = await import('../src/engine/registry');

/** fake adapter：记录 install/uninstall/watch 调用，捕获 emit 供 pull 平面驱动。 */
function makeFakeAdapter(id: AgentId, installed = true) {
  const calls = { installs: 0, uninstalls: 0, watches: 0, unwatched: 0 };
  let emit: ((e: AgentEvent) => void) | null = null;
  let failUninstall = false;
  const adapter: AgentAdapter = {
    id,
    async detect() {
      return { installed, hasCredentials: false, homeDir: `/fake/${id}`, hookInstalled: calls.installs > calls.uninstalls };
    },
    async installHooks() {
      calls.installs += 1;
      return { changed: true };
    },
    async uninstallHooks() {
      if (failUninstall) throw new Error('uninstall boom');
      calls.uninstalls += 1;
      return { changed: true };
    },
    translateHook: () => [{ agent: id, sessionId: 'from-push', kind: 'session.start', at: Date.now() }],
    async watch(emitFn) {
      calls.watches += 1;
      emit = emitFn;
      return () => {
        calls.unwatched += 1;
        emit = null;
      };
    },
  };
  return {
    adapter,
    calls,
    /** pull 平面驱动：经 registry 注入的 ingest_ 走全链路（台账+状态机+广播）。 */
    send: (e: AgentEvent) => emit?.(e),
    setFailUninstall: (v: boolean) => {
      failUninstall = v;
    },
  };
}

/** 每用例独立 registry：独立 dataDir（settings/credentials/台账落这里），不起 ingest。 */
async function makeRegistry(adapters: AgentAdapter[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'murmur-registry-data-'));
  const reg = new AgentRegistry({ adapters, dataDir, skipIngest: true });
  await reg.start();
  return { reg, dataDir };
}

const agentOf = (snap: AppSnapshot, id: AgentId) => snap.agents.find((a) => a.agent === id)!;

describe('AgentRegistry 快照与监听开关', () => {
  test('关闭监听：snapshot 标 disabled 且不暴露 sessions/quota/用量；push 残留事件被丢弃', async () => {
    const fake = makeFakeAdapter('kimi');
    const { reg, dataDir } = await makeRegistry([fake.adapter]);
    fake.send({ agent: 'kimi', sessionId: 's1', kind: 'session.start', at: Date.now() });
    fake.send({ agent: 'kimi', sessionId: 's1', kind: 'usage', tokens: { input: 100, output: 10 }, at: Date.now() });

    const before = agentOf(reg.snapshot(), 'kimi');
    expect(before.disabled).toBe(false);
    expect(before.sessions).toHaveLength(1);
    expect(before.today).toMatchObject({ tokens: 110 });

    await reg.setAgentObserved('kimi', false);
    const after = agentOf(reg.snapshot(), 'kimi');
    expect(after.disabled).toBe(true);
    expect(after.sessions).toEqual([]);
    expect(after.quota).toBeUndefined();
    expect(after.today).toBeUndefined();
    expect(after.week).toBeUndefined();

    // 关闭后 push 残留（spool 补投/in-flight POST）走 translateHook 也必须被丢。
    reg.translateHook('kimi', { session_id: 's2' });
    expect(agentOf(reg.snapshot(), 'kimi').sessions).toEqual([]);
    // 台账仍留有停用前记录（审计面），但快照不再暴露——设置持久化在 dataDir。
    expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).agents.kimi).toBe(false);

    await reg.stop();
  });

  test('setAgentHook：关→uninstallHooks、开→installHooks；卸载抛错不影响 settings 保存', async () => {
    const fake = makeFakeAdapter('kimi');
    const { reg, dataDir } = await makeRegistry([fake.adapter]);
    expect(fake.calls.installs).toBe(1); // autoInstallHooks 默认开：启动时装过一次

    await reg.setAgentHook('kimi', false);
    expect(fake.calls.uninstalls).toBe(1);
    expect(reg.getSettings().hooks.kimi).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).hooks.kimi).toBe(false);

    await reg.setAgentHook('kimi', true);
    expect(fake.calls.installs).toBe(2);

    // uninstallHooks 抛错：settings 已先行落盘，副作用留待下次重试。
    fake.setFailUninstall(true);
    const saved = await reg.setAgentHook('kimi', false);
    expect(saved.hooks.kimi).toBe(false);
    expect(fake.calls.uninstalls).toBe(1);
    expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).hooks.kimi).toBe(false);

    await reg.stop();
  });

  test('setAgentObserved：关=停 watcher+卸 hook，重开=恢复观察+装回 hook', async () => {
    const fake = makeFakeAdapter('kimi');
    const { reg } = await makeRegistry([fake.adapter]);
    // 首启空台账会走 rebuild：watcher 起两轮（第二轮前先停第一轮），故用增量断言。
    const w0 = fake.calls.watches;
    const u0 = fake.calls.unwatched;
    const i0 = fake.calls.installs;

    await reg.setAgentObserved('kimi', false);
    expect(fake.calls.unwatched).toBe(u0 + 1);
    expect(fake.calls.uninstalls).toBe(1);

    await reg.setAgentObserved('kimi', true);
    expect(fake.calls.watches).toBe(w0 + 1);
    expect(fake.calls.installs).toBe(i0 + 1); // 重开时装回 hook（autoInstallHooks 默认开）

    // 重开后 pull 事件照常进引擎。
    fake.send({ agent: 'kimi', sessionId: 's9', kind: 'session.start', at: Date.now() });
    expect(agentOf(reg.snapshot(), 'kimi').sessions.map((s) => s.sessionId)).toEqual(['s9']);

    await reg.stop();
  });

  test('snapshot 同一变更周期复用一次聚合；引擎/额度任一变更即失效', async () => {
    const fake = makeFakeAdapter('kimi');
    const { reg } = await makeRegistry([fake.adapter]);

    const first = reg.snapshot();
    expect(reg.snapshot()).toBe(first); // 未变不变：托盘/通知/推送共享同一实例

    fake.send({ agent: 'kimi', sessionId: 's1', kind: 'session.start', at: Date.now() });
    const second = reg.snapshot();
    expect(second).not.toBe(first); // 引擎变更（同步失效）
    expect(first.agents.find((a) => a.agent === 'kimi')!.sessions).toHaveLength(0);
    expect(second.agents.find((a) => a.agent === 'kimi')!.sessions).toHaveLength(1);

    await reg.refreshQuotas();
    expect(reg.snapshot()).not.toBe(second); // 额度变更（notify 失效）

    await reg.stop();
  });

  test('snapshot.recentlyEnded：grace 期 ended 进快照；停用 agent 的被过滤', async () => {
    const fake = makeFakeAdapter('kimi');
    const { reg } = await makeRegistry([fake.adapter]);
    fake.send({ agent: 'kimi', sessionId: 's1', kind: 'turn.start', at: Date.now() });
    fake.send({ agent: 'kimi', sessionId: 's1', kind: 'session.end', at: Date.now() });

    const snap = reg.snapshot();
    expect(snap.recentlyEnded?.map((s) => s.sessionId)).toEqual(['s1']);
    expect(snap.recentlyEnded?.[0].endedAt).toBeGreaterThan(0);
    // 活跃会话面不出现 ended，两清单分工。
    expect(agentOf(snap, 'kimi').sessions.find((s) => s.status === 'ended')).toBeUndefined();

    // 停监听后引擎 Map 里的 ended 残留也不得外泄。
    await reg.setAgentObserved('kimi', false);
    expect(reg.snapshot().recentlyEnded).toEqual([]);

    await reg.stop();
  });
});

afterAll(() => {
  // 无全局残留：ingest 未起（skipIngest）、hook 未写真机（fake adapter 不落盘）。
});
