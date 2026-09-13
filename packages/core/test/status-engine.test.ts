/**
 * StatusEngine 状态机单测。
 */

import { describe, expect, test } from 'bun:test';

import { StatusEngine } from '../src/engine/status-engine';
import type { AgentEvent } from '../src/types';

function ev(kind: AgentEvent['kind'], at = Date.now(), sessionId = 's1'): AgentEvent {
  return { agent: 'kimi', sessionId, kind, at };
}

describe('StatusEngine', () => {
  test('完整生命周期：start → working → waiting → ended', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    expect(e.snapshot()[0].status).toBe('idle');

    e.apply(ev('turn.start'));
    expect(e.snapshot()[0].status).toBe('working');
    expect(e.overall()).toBe('working');

    e.apply(ev('tool.call'));
    expect(e.snapshot()[0].status).toBe('working');

    e.apply(ev('turn.end'));
    expect(e.snapshot()[0].status).toBe('waiting');
    expect(e.snapshot()[0].waitingReason).toBe('turn-end');
    expect(e.overall()).toBe('waiting');

    e.apply(ev('session.end'));
    // ended 不进面板（grace 期只留 Map 供同 id 复活），聚合态仍计 ended。
    expect(e.snapshot().find((s) => s.sessionId === 's1')).toBeUndefined();
    expect(e.overall()).toBe('ended');
  });

  test('快照只出活跃会话：idle 90s 后隐藏，stale 30min 兜底落 ended', () => {
    const e = new StatusEngine();
    const now = Date.now();
    // 新建 idle 在 90s 窗口内可见（session.start → turn.start 过渡）。
    e.apply(ev('session.start', now - 30_000, 'fresh'));
    expect(e.snapshot().find((s) => s.sessionId === 'fresh')?.status).toBe('idle');
    // 90s 前的 idle（建了会话没下文）隐藏。
    e.apply(ev('session.start', now - 120_000, 'stale-idle'));
    expect(e.snapshot().find((s) => s.sessionId === 'stale-idle')).toBeUndefined();
    // stale 30min 无动静 → ended（进程多半已死），不进面板。
    e.apply(ev('turn.start', now, 'dead')); // live → working
    e.sweep(now + 4 * 60_000); // working → stale（>3min）
    expect(e.snapshot().find((s) => s.sessionId === 'dead')?.status).toBe('stale');
    e.sweep(now + 31 * 60_000); // stale >30min → ended
    expect(e.snapshot().find((s) => s.sessionId === 'dead')).toBeUndefined();
  });

  test('permission.request → waiting(approval)', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    e.apply(ev('permission.request'));
    expect(e.snapshot()[0].waitingReason).toBe('approval');
  });

  test('usage 事件累计 token', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    e.apply({ ...ev('usage'), tokens: { input: 100, output: 50 } });
    e.apply({ ...ev('usage'), tokens: { input: 200, output: 100, cacheRead: 10 } });
    const s = e.snapshot()[0];
    expect(s.tokens.input).toBe(300);
    expect(s.tokens.output).toBe(150);
    expect(s.tokens.cacheRead).toBe(10);
  });

  test('sweep：working 超时 → stale；ended 过期 → 清除', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    e.apply(ev('turn.start'));
    e.sweep(Date.now() + 10 * 60_000); // 模拟 10 分钟后看门狗
    expect(e.snapshot()[0].status).toBe('stale');

    e.apply({ ...ev('session.end'), sessionId: 's2' });
    e.sweep(Date.now() + 120_000);
    expect(e.snapshot().find((s) => s.sessionId === 's2')).toBeUndefined();
  });

  test('多会话聚合态取最高优先级', () => {
    const e = new StatusEngine();
    e.apply({ ...ev('session.start'), sessionId: 'a' });
    e.apply({ ...ev('session.start'), sessionId: 'b' });
    e.apply({ ...ev('turn.start'), sessionId: 'b' });
    expect(e.overall()).toBe('working');
    e.apply({ ...ev('turn.end'), sessionId: 'b' });
    expect(e.overall()).toBe('waiting');
  });

  test('回填语义：旧事件建档落真实残态，半成品 turn 不算 working', () => {
    const e = new StatusEngine();
    const old = Date.now() - 3 * 86400_000; // 3 天前
    // 旧 turn.end → 会话真实状态就是 waiting（在等用户）。
    e.apply({ ...ev('turn.start', old), sessionId: 'old1' });
    e.apply({ ...ev('turn.end', old), sessionId: 'old1' });
    // 半路废弃的 turn（只有 start 没 end）→ stale 而非 working。
    e.apply({ ...ev('turn.start', old), sessionId: 'old2' });
    // 超龄（>24h）会话不出现在面板，但 overall 仍计入 waiting。
    expect(e.snapshot().find((s) => s.sessionId === 'old1')).toBeUndefined();
    expect(e.overall()).toBe('waiting');

    // 近期旧事件（30 分钟前）正常建档显示。
    const recent = Date.now() - 30 * 60_000;
    e.apply({ ...ev('turn.start', recent), sessionId: 'r1' });
    e.apply({ ...ev('turn.end', recent), sessionId: 'r1' });
    expect(e.snapshot().find((s) => s.sessionId === 'r1')?.status).toBe('waiting');

    // 新会话照常 live。
    e.apply({ ...ev('turn.start'), sessionId: 'live1' });
    expect(e.snapshot().find((s) => s.sessionId === 'live1')?.status).toBe('working');
  });

  test('sweep 剔除超龄会话（>24h 无动静，非仅 ended）', () => {
    const e = new StatusEngine();
    const old = Date.now() - 25 * 3600_000;
    e.apply({ ...ev('turn.end', old), sessionId: 'ancient' });
    e.apply({ ...ev('turn.end'), sessionId: 'fresh' });
    // 超龄会话 snapshot 已不可见，sweep 后彻底从 Map 清除。
    e.sweep();
    expect(e.snapshot().find((s) => s.sessionId === 'ancient')).toBeUndefined();
    expect(e.snapshot().find((s) => s.sessionId === 'fresh')?.status).toBe('waiting');
    // 清除后不再计入聚合态。
    e.sweep();
    expect(e.overall()).toBe('waiting'); // fresh 仍是 waiting
  });
});
