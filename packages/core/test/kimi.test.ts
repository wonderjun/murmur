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

  test('loop_event tool.call → tool.call；其余 → status(working) 心跳', () => {
    expect(
      translateWireLine(P, { type: 'context.append_loop_event', event: { type: 'tool.call' }, time: 1 })[0].kind,
    ).toBe('tool.call');
    const s = translateWireLine(P, { type: 'context.append_loop_event', event: { type: 'step.begin' }, time: 1 })[0];
    expect(s.kind).toBe('status');
    expect(s.status).toBe('working');
  });

  test('interaction.request → permission.request；簿记噪音丢弃', () => {
    expect(translateWireLine(P, { type: 'interaction.request', kind: 'approval', time: 1 })[0].kind).toBe(
      'permission.request',
    );
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

  test('PreToolUse → tool.call；PostToolUse/PermissionResult → working 心跳', () => {
    const pre = translateKimiHook({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_call_id: 'tool_x',
    });
    expect(pre[0].kind).toBe('tool.call');
    for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PermissionResult', 'UserPromptQueued', 'TaskStarted']) {
      const s = translateKimiHook({ ...base, hook_event_name: ev })[0];
      expect(s.kind).toBe('status');
      expect(s.status).toBe('working');
    }
  });

  test('PermissionRequest → permission.request', () => {
    expect(translateKimiHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })[0].kind).toBe(
      'permission.request',
    );
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
