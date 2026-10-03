/**
 * StatusEngine 状态机单测。
 */

import { describe, expect, test } from 'bun:test';

import { LIVE_WINDOW_MS, StatusEngine } from '../src/engine/status-engine';
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

  test('working 相位：turn.start→thinking，tool.call→tool(记工具名)，status 相位信号切换回 thinking', () => {
    const e = new StatusEngine();
    const t0 = Date.now() - 1000;
    e.apply(ev('turn.start', t0));
    let s = e.snapshot()[0];
    expect(s.phase).toBe('thinking');
    expect(s.turnStartAt).toBe(t0);
    expect(s.statusAt).toBe(t0);

    e.apply({ ...ev('tool.call'), detail: 'Bash' });
    s = e.snapshot()[0];
    expect(s.phase).toBe('tool');
    expect(s.toolName).toBe('Bash');
    expect(s.toolCallAt).toBeGreaterThan(0);

    // PostToolUse 系 status 相位信号回 thinking；时间线字段保留。
    e.apply({ ...ev('status'), phase: 'thinking' });
    s = e.snapshot()[0];
    expect(s.phase).toBe('thinking');
    expect(s.toolName).toBe('Bash');
    expect(s.turnStartAt).toBe(t0);
  });

  test('waitingDetail：permission.request 记等待对象，回 working 清相位与 detail', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    e.apply(ev('turn.start'));
    e.apply({ ...ev('permission.request'), detail: 'Bash · Running: git push' });
    let s = e.snapshot()[0];
    expect(s).toMatchObject({ status: 'waiting', waitingReason: 'approval', waitingDetail: 'Bash · Running: git push' });
    expect(s.phase).toBeUndefined();
    // 等了多久 = statusAt（进入 waiting 的时刻）。
    expect(s.statusAt).toBeGreaterThan(0);

    e.apply(ev('turn.start'));
    s = e.snapshot()[0];
    expect(s.status).toBe('working');
    expect(s.phase).toBe('thinking');
    expect(s.waitingDetail).toBeUndefined();
  });

  test('question 细分：status waiting(question) 记问题文本；衰减回 idle 后清空', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    e.apply(ev('turn.start'));
    e.apply({ ...ev('status'), status: 'waiting', waitingReason: 'question', detail: '往哪条迁移路径走？' });
    let s = e.snapshot()[0];
    expect(s).toMatchObject({ status: 'waiting', waitingReason: 'question', waitingDetail: '往哪条迁移路径走？' });

    // waiting 30min 无动静衰减回 idle——detail/reason 一并清。
    e.sweep(Date.now() + 31 * 60_000);
    // 再起来时 detail 不带残留。
    e.apply(ev('turn.start'));
    s = e.snapshot()[0];
    expect(s.status).toBe('working');
    expect(s.waitingReason).toBeUndefined();
    expect(s.waitingDetail).toBeUndefined();
  });

  test('回填事件不写相位：旧 status 的 phase 不生效，旧 turn.start 仍落 ended', () => {
    const e = new StatusEngine();
    const old = Date.now() - 3600_000;
    e.apply({ ...ev('session.start', old), sessionId: 'old-s' });
    e.apply({ ...ev('status', old, 'old-s'), status: 'working', phase: 'tool', detail: 'Bash' });
    // 回填 status 不迁移不置相位——快照里它甚至不可见（idle 超窗）。
    expect(e.snapshot().find((s) => s.sessionId === 'old-s')).toBeUndefined();
    e.apply({ ...ev('turn.start', old), sessionId: 'old-s' });
    expect(e.overall()).toBe('ended');
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

  test('recentlyEnded：grace 期 ended 按结束时间倒序，带 endedAt；活跃面仍不含 ended', () => {
    const e = new StatusEngine();
    const now = Date.now();
    e.apply({ ...ev('turn.start', now - 2000, 'done1') });
    e.apply({ ...ev('session.end', now - 1000, 'done1') });
    e.apply({ ...ev('turn.start', now - 400, 'done2') });
    e.apply({ ...ev('session.end', now - 100, 'done2') });

    const ended = e.recentlyEnded(10);
    expect(ended.map((s) => s.sessionId)).toEqual(['done2', 'done1']); // 后结束的在前
    expect(ended[0].status).toBe('ended');
    expect(ended[0].endedAt).toBe(now - 100); // endedAt = 状态迁移时刻
    // limit 截断：只留最新一条。
    expect(e.recentlyEnded(1).map((s) => s.sessionId)).toEqual(['done2']);
    // 活跃快照仍不出 ended（两清单分工）。
    expect(e.snapshot().find((s) => s.status === 'ended')).toBeUndefined();

    // grace 期过后 sweep 清走，清单随之消失。
    e.sweep(now + 61_000);
    expect(e.recentlyEnded(10)).toEqual([]);
  });

  test('recentlyEnded：非 ended 会话与 waiting 不入清单', () => {
    const e = new StatusEngine();
    e.apply(ev('session.start'));
    e.apply(ev('turn.end'));
    expect(e.recentlyEnded(10)).toEqual([]);
  });

  test('旧 permission.request 落 ended：不进活跃面板、不进最近结束、不发通知', () => {
    const e = new StatusEngine();
    let changes = 0;
    e.onChange(() => changes++);
    const old = Date.now() - LIVE_WINDOW_MS - 5_000;
    e.apply({ ...ev('permission.request', old, 'old-perm'), detail: 'Bash · git push', title: '旧审批' });
    expect(changes).toBe(0);
    expect(e.snapshot().find((s) => s.sessionId === 'old-perm')).toBeUndefined();
    expect(e.recentlyEnded(10).find((s) => s.sessionId === 'old-perm')).toBeUndefined();
    expect(e.overall()).toBe('ended');
    // 窗口内的审批仍是 waiting(approval)，并通知订阅者。
    e.apply({ ...ev('permission.request', Date.now() - 1_000, 'live-perm'), detail: 'Bash' });
    expect(changes).toBe(1);
    expect(e.snapshot().find((s) => s.sessionId === 'live-perm')).toMatchObject({
      status: 'waiting',
      waitingReason: 'approval',
      waitingDetail: 'Bash',
    });
    expect(e.overall()).toBe('waiting');
  });

  test('更旧的历史事件不覆盖已到达状态；旧 turn.end 仍落 waiting', () => {
    const e = new StatusEngine();
    let changes = 0;
    e.onChange(() => changes++);
    const now = Date.now();
    const liveAt = now - 2_000;
    e.apply({ ...ev('turn.start', liveAt, 'live'), title: '当前回合', cwd: '/now' });
    const before = e.snapshot().find((s) => s.sessionId === 'live');
    expect(before).toMatchObject({ status: 'working', phase: 'thinking', title: '当前回合', cwd: '/now' });
    expect(changes).toBe(1);

    const old = now - 3_600_000;
    e.apply({ ...ev('permission.request', old, 'live'), detail: 'Bash', title: '回放标题', cwd: '/old' });
    e.apply({ ...ev('turn.end', old + 1, 'live'), title: '更旧结束' });
    e.apply({ ...ev('status', old + 2, 'live'), status: 'waiting', waitingReason: 'question', detail: '旧问题' });
    const after = e.snapshot().find((s) => s.sessionId === 'live');
    expect(after).toMatchObject({
      status: 'working',
      phase: 'thinking',
      title: '当前回合',
      cwd: '/now',
      statusAt: before?.statusAt,
      turnStartAt: liveAt,
    });
    expect(after?.waitingReason).toBeUndefined();
    expect(after?.waitingDetail).toBeUndefined();
    expect(changes).toBe(1);

    // 旧 turn.end 自己仍是「在等你」，且不被更旧的审批盖成 ended。
    e.apply({ ...ev('turn.end', old + 10_000, 'hist'), title: '历史回合' });
    e.apply({ ...ev('permission.request', old, 'hist'), detail: 'Bash', title: '更旧审批' });
    expect(e.snapshot().find((s) => s.sessionId === 'hist')).toMatchObject({
      status: 'waiting',
      waitingReason: 'turn-end',
      title: '历史回合',
    });
    expect(changes).toBe(1);
  });

  test('乱序：更旧的 live 事件仍按到达顺序迁移；usage 不论乱序都累加且不改状态', () => {
    const e = new StatusEngine();
    const now = Date.now();
    e.apply(ev('turn.end', now - 1_000, 'ooo'));
    e.apply(ev('turn.start', now - 2_000, 'ooo'));
    expect(e.snapshot().find((s) => s.sessionId === 'ooo')?.status).toBe('working');

    e.apply({ ...ev('usage', now - 500, 'ooo'), tokens: { input: 40, output: 10 } });
    e.apply({ ...ev('usage', now - 3_600_000, 'ooo'), tokens: { input: 5, output: 1, cacheRead: 2 } });
    const s = e.snapshot().find((s) => s.sessionId === 'ooo');
    expect(s?.status).toBe('working');
    expect(s?.tokens).toMatchObject({ input: 45, output: 11, cacheRead: 2 });
    expect(s?.lastEventAt).toBe(now - 500);
  });
});
