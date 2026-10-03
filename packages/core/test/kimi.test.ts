/**
 * kimi wire.jsonl 翻译单测（v0.41 真实行格式：顶层 type + time ms）。
 */

import { describe, expect, test } from 'bun:test';

import { translateKimiHook, translateWireLine } from '../src/agents/kimi';

const P = '/home/u/.kimi-code/sessions/wd_flow_abc/session_SID/agents/main/wire.jsonl';
const P_SUB = '/home/u/.kimi-code/sessions/wd_flow_abc/session_SID/agents/agent-3/wire.jsonl';

describe('kimi translateWireLine', () => {
  test('turn.prompt → session.start + turn.start；sessionId 从路径推', () => {
    const out = translateWireLine(P, { type: 'turn.prompt', agentId: 'main', time: 1789197800000 });
    expect(out.map((e) => e.kind)).toEqual(['session.start', 'turn.start']);
    expect(out[0].sessionId).toBe('session_SID');
    expect(out[0].at).toBe(1789197800000);
  });

  test('subagent wire 同样归到所属 session', () => {
    const out = translateWireLine(P_SUB, { type: 'turn.ended', agentId: 'agent-3', time: 1789197900000 });
    expect(out[0].sessionId).toBe('session_SID');
    expect(out[0].kind).toBe('turn.end');
    expect(out[0].waitingReason).toBe('turn-end');
  });

  test('usage.record → usage（token 归一化 + model）', () => {
    const out = translateWireLine(P, {
      type: 'usage.record',
      agentId: 'main',
      model: 'kkone-gpt/gpt-5.6-terra',
      usage: { inputOther: 47308, output: 1241, inputCacheRead: 14848, inputCacheCreation: 0 },
      time: 1789197903272,
    });
    expect(out[0].kind).toBe('usage');
    expect(out[0].tokens?.input).toBe(47308);
    expect(out[0].tokens?.output).toBe(1241);
    expect(out[0].tokens?.cacheRead).toBe(14848);
    expect(out[0].model).toBe('kkone-gpt/gpt-5.6-terra');
  });

  test('inputCacheCreation 只归 cacheWrite——input 已是非缓存分量，再并入会双计', () => {
    const out = translateWireLine(P, {
      type: 'usage.record',
      agentId: 'main',
      usage: { inputOther: 100, output: 10, inputCacheRead: 50, inputCacheCreation: 20 },
      time: 1789197903272,
    });
    expect(out[0].tokens).toEqual({ input: 100, output: 10, cacheRead: 50, cacheWrite: 20 });
  });

  test('loop_event tool.call → tool.call(带工具名)；其余 → status(working,thinking)', () => {
    const call = translateWireLine(P, {
      type: 'context.append_loop_event',
      event: { type: 'tool.call', name: 'Bash' },
      time: 1,
    })[0];
    expect(call).toMatchObject({ kind: 'tool.call', detail: 'Bash' });
    const s = translateWireLine(P, { type: 'context.append_loop_event', event: { type: 'step.begin' }, time: 1 })[0];
    expect(s).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    // tool.result = 工具收尾回模型，同 thinking。
    const done = translateWireLine(P, { type: 'context.append_loop_event', event: { type: 'tool.result' }, time: 1 })[0];
    expect(done).toMatchObject({ kind: 'status', phase: 'thinking' });
  });

  // interaction.request 形状取自 ~/.kimi-code 真机 wire.jsonl 实测。
  test('interaction.request 按 kind 细分：approval→permission.request(工具名+动作)，question→waiting(question,问题原文)', () => {
    const approval = translateWireLine(P, {
      type: 'interaction.request',
      id: 'approval_x',
      kind: 'approval',
      toolCallId: 'call_1',
      agentId: 'main',
      request: { toolName: 'Bash', action: 'Running: git status --short', display: { kind: 'command' } },
      time: 1,
    })[0];
    expect(approval).toMatchObject({ kind: 'permission.request', detail: 'Bash · Running: git status --short' });

    const question = translateWireLine(P, {
      type: 'interaction.request',
      id: 'question_x',
      kind: 'question',
      toolCallId: 'tool_1',
      agentId: 'main',
      request: { questions: [{ question: '这次想往哪个方向深入？', header: '方向', options: [] }] },
      time: 1,
    })[0];
    expect(question).toMatchObject({
      kind: 'status',
      status: 'waiting',
      waitingReason: 'question',
      detail: '这次想往哪个方向深入？',
    });

    // kind 缺省（老版本/未知细分）仍归 permission.request。
    expect(translateWireLine(P, { type: 'interaction.request', time: 1 })[0].kind).toBe('permission.request');
    expect(translateWireLine(P, { type: 'config.update', time: 1 })).toHaveLength(0);
    expect(translateWireLine(P, { type: 'file_history.tracked', time: 1 })).toHaveLength(0);
  });
});

// 以下 fixture 是 0.41 真机探针抓到的原始 payload（字段即实测契约）。
describe('kimi translateKimiHook', () => {
  const base = { session_id: 'session_abc', cwd: '/work/proj', client_type: 'kimi_code_cli' };

  test('SessionStart → session.start（model/cwd 透传）', () => {
    const out = translateKimiHook({
      ...base,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'kimi-code/kimi-for-coding',
      profile: 'agent',
    });
    expect(out[0].kind).toBe('session.start');
    expect(out[0].model).toBe('kimi-code/kimi-for-coding');
    expect(out[0].cwd).toBe('/work/proj');
  });

  test('UserPromptSubmit/TurnStarted → turn.start（prompt 数组/字符串两种形状）', () => {
    const sub = translateKimiHook({
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: [{ type: 'text', text: 'hi' }],
      is_steer: false,
    });
    expect(sub[0].kind).toBe('turn.start');
    const turn = translateKimiHook({
      ...base,
      hook_event_name: 'TurnStarted',
      turn_id: 0,
      origin_kind: 'user',
      prompt: 'hi',
    });
    expect(turn[0].kind).toBe('turn.start');
  });

  test('PreToolUse → tool.call(带工具名)；PostToolUse/PermissionResult → working(thinking) 心跳', () => {
    const pre = translateKimiHook({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_call_id: 'tool_x',
    });
    expect(pre[0]).toMatchObject({ kind: 'tool.call', detail: 'Bash' });
    for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PermissionResult', 'UserPromptQueued', 'TaskStarted']) {
      const s = translateKimiHook({ ...base, hook_event_name: ev })[0];
      expect(s).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    }
  });

  test('PermissionRequest → permission.request(带工具名)', () => {
    const e = translateKimiHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })[0];
    expect(e).toMatchObject({ kind: 'permission.request', detail: 'Bash' });
  });

  test('Stop/StopFailure/Interrupt → turn.end(turn-end)；SessionEnd → session.end', () => {
    for (const ev of ['Stop', 'StopFailure', 'Interrupt']) {
      const e = translateKimiHook({ ...base, hook_event_name: ev })[0];
      expect(e.kind).toBe('turn.end');
      expect(e.waitingReason).toBe('turn-end');
    }
    expect(translateKimiHook({ ...base, hook_event_name: 'SessionEnd' })[0].kind).toBe('session.end');
  });

  test('Notification/未知事件 → bare status（只刷活性）；payload 无 ts → at=now', () => {
    const n = translateKimiHook({ ...base, hook_event_name: 'Notification' })[0];
    expect(n.kind).toBe('status');
    expect(n.status).toBeUndefined();
    const u = translateKimiHook({ hook_event_name: 'FutureEvent' })[0];
    expect(u.kind).toBe('status');
    expect(u.sessionId).toBe('unknown');
    expect(Math.abs(Date.now() - u.at)).toBeLessThan(5000);
  });
});
