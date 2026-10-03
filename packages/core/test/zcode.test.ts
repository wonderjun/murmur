/**
 * zcode model-io rollout 定向提取 + json-span scanner 单测。
 *
 * 行格式按 2026-09 本机实测：单行 ~300KB，request 内嵌完整 prompt/消息与
 * authorization 头；providerMetadata.anthropic.usage 是 usage 的同名诱饵。
 */

import { describe, expect, test } from 'bun:test';

import { join } from 'node:path';

import { topLevelString, topLevelValueSpan, topLevelValueSpans } from '../src/agents/json-span';
import { translateRolloutLine, translateZcodeHook } from '../src/agents/zcode';
import { mergeZcodeConfig } from '../src/hooks/install';
import { MURMUR_HOME } from '../src/paths';

const FILE = '/u/.zcode/cli/rollout/model-io-sess_4b340169-480f-40d5-8de1-e16b811aee4b.jsonl';
const FILE_SUB = '/u/.zcode/cli/rollout/model-io-sess_subagent_agent_7cb2871a-3a48-4139-83d5-78f3aad661f6.jsonl';

function spanText(json: string, key: string, from?: number, to?: number): string | undefined {
  const s = topLevelValueSpan(json, key, from, to);
  return s ? json.slice(s[0], s[1]) : undefined;
}

/** 拼一条贴近真实的 model_io 行：request 里埋字符串诱饵，response 里埋嵌套同名 usage。 */
function makeLine(
  opts: {
    usage?: string | null;
    sessionId?: string | null;
    modelId?: string | null;
    completedAt?: string | null;
    startedAt?: string | null;
  } = {},
): string {
  const usage =
    'usage' in opts
      ? opts.usage
      : '{"inputTokens":411,"outputTokens":190,"totalTokens":601,"cacheReadTokens":192,"cacheWriteTokens":0}';
  const sessionId = 'sessionId' in opts ? opts.sessionId : 'sess_4b340169-480f-40d5-8de1-e16b811aee4b';
  const modelId = 'modelId' in opts ? opts.modelId : 'GLM-5.3-Flash';
  const completedAt = 'completedAt' in opts ? opts.completedAt : '2026-09-12T17:03:14.280Z';
  const startedAt = 'startedAt' in opts ? opts.startedAt : '2026-09-12T17:03:10.951Z';
  return (
    '{' +
    (completedAt == null ? '' : `"completedAt":${JSON.stringify(completedAt)},`) +
    '"model":{' +
    (modelId == null ? '' : `"modelId":${JSON.stringify(modelId)},`) +
    '"role":"main"},' +
    '"request":{"body":{"system":[{"type":"text","text":"prompt \\"usage\\":{\\"inputTokens\\":9999} decoy"}]},' +
    '"headers":{"authorization":"[redacted]"}},' +
    '"response":{"finishReason":"stop","providerMetadata":{"anthropic":{"usage":{"inputTokens":9999}}},' +
    (usage == null ? '' : `"usage":${usage},`) +
    '"text":"ok"},' +
    (sessionId == null ? '' : `"sessionId":${JSON.stringify(sessionId)},`) +
    (startedAt == null ? '' : `"startedAt":${JSON.stringify(startedAt)},`) +
    '"type":"model_io"}'
  );
}

describe('json-span topLevelValueSpan', () => {
  test('命中顶层键返回精确值区间（对象/字符串/字面量）', () => {
    const j = '{"a":1,"b":{"c":2},"d":"x y","e":[1,{"z":3}],"f":null}';
    expect(spanText(j, 'a')).toBe('1');
    expect(spanText(j, 'b')).toBe('{"c":2}');
    expect(spanText(j, 'd')).toBe('"x y"');
    expect(spanText(j, 'e')).toBe('[1,{"z":3}]');
    expect(spanText(j, 'f')).toBe('null');
  });

  test('嵌套同名键与字符串内诱饵不误命中', () => {
    const j =
      '{"note":"\\"usage\\":{\\"inputTokens\\":9}","outer":{"usage":{"inputTokens":8}},"usage":{"inputTokens":7}}';
    expect(spanText(j, 'usage')).toBe('{"inputTokens":7}');
    // 子对象区间内再定位：outer.usage 取自己的 8。
    const outer = topLevelValueSpan(j, 'outer');
    const inner = outer && topLevelValueSpan(j, 'usage', outer[0], outer[1]);
    expect(inner ? j.slice(inner[0], inner[1]) : undefined).toBe('{"inputTokens":8}');
  });

  test('字符串里的转义引号不提前终止', () => {
    const j = '{"a":"x\\"y","b":2}';
    expect(spanText(j, 'a')).toBe('"x\\"y"');
    expect(spanText(j, 'b')).toBe('2');
  });

  test('非对象/截断/未命中 → undefined', () => {
    expect(topLevelValueSpan('[1,2]', 'a')).toBeUndefined();
    expect(topLevelValueSpan('"x"', 'a')).toBeUndefined();
    expect(topLevelValueSpan('{"a":1', 'b')).toBeUndefined();
    expect(topLevelValueSpan('{"a":1}', 'b')).toBeUndefined();
  });

  test('topLevelValueSpans 单趟收集多键；重复键后者覆盖（JSON.parse 语义）', () => {
    const j = '{"a":1,"b":{"x":2},"a":3,"c":"s"}';
    const m = topLevelValueSpans(j, ['a', 'b', 'c', 'missing']);
    const a = m.get('a');
    const b = m.get('b');
    const c = m.get('c');
    expect(a && j.slice(a[0], a[1])).toBe('3');
    expect(b && j.slice(b[0], b[1])).toBe('{"x":2}');
    expect(c && j.slice(c[0], c[1])).toBe('"s"');
    expect(m.has('missing')).toBe(false);
  });
});

describe('json-span topLevelString', () => {
  test('提取字符串字段；缺失/非字符串/坏片段 → undefined', () => {
    const j = '{"s":"v\\"x","n":1,"o":{}}';
    expect(topLevelString(j, 's')).toBe('v"x');
    expect(topLevelString(j, 'n')).toBeUndefined();
    expect(topLevelString(j, 'o')).toBeUndefined();
    expect(topLevelString(j, 'missing')).toBeUndefined();
  });
});

describe('zcode translateRolloutLine', () => {
  test('真实结构行 → usage 事件；嵌套 usage 与字符串诱饵不污染取值', () => {
    const out = translateRolloutLine(FILE, makeLine());
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.agent).toBe('zcode');
    expect(e.kind).toBe('usage');
    expect(e.sessionId).toBe('sess_4b340169-480f-40d5-8de1-e16b811aee4b');
    expect(e.model).toBe('GLM-5.3-Flash');
    expect(e.at).toBe(Date.parse('2026-09-12T17:03:14.280Z'));
    // inputTokens 含 cache 分量（实测 totalTokens == in+out）→ input 须扣成互斥口径。
    expect(e.tokens).toEqual({ input: 411 - 192, output: 190, cacheRead: 192, cacheWrite: 0 });
    expect(e.raw).toBeUndefined();
  });

  test('缺 totalTokens → input+output 兜底；无 usage/坏行 → []', () => {
    const e = translateRolloutLine(FILE, makeLine({ usage: '{"inputTokens":5,"outputTokens":7}' }))[0];
    expect(e.tokens?.input).toBe(5);
    expect(e.tokens?.output).toBe(7);
    expect(translateRolloutLine(FILE, makeLine({ usage: null }))).toHaveLength(0);
    expect(translateRolloutLine(FILE, '{"type":"model_io"}')).toHaveLength(0);
    expect(translateRolloutLine(FILE, 'not json')).toHaveLength(0);
    expect(translateRolloutLine(FILE, makeLine({ usage: '{"inputTokens":0,"outputTokens":0}' }))).toHaveLength(0);
  });

  test('sessionId：行内优先，文件名兜底，subagent 文件名走行内', () => {
    const own = 'sess_deadbeef-1111-2222-3333-444444444444';
    expect(translateRolloutLine(FILE, makeLine({ sessionId: own }))[0].sessionId).toBe(own);
    expect(translateRolloutLine(FILE, makeLine({ sessionId: null }))[0].sessionId).toBe(
      'sess_4b340169-480f-40d5-8de1-e16b811aee4b',
    );
    const sub = 'sess_subagent_agent_7cb2871a-3a48-4139-83d5-78f3aad661f6';
    expect(translateRolloutLine(FILE_SUB, makeLine({ sessionId: sub }))[0].sessionId).toBe(sub);
  });

  test('completedAt 优先、startedAt 兜底、全无 → at=0（回填语义）', () => {
    expect(translateRolloutLine(FILE, makeLine({ completedAt: null }))[0].at).toBe(
      Date.parse('2026-09-12T17:03:10.951Z'),
    );
    expect(translateRolloutLine(FILE, makeLine({ completedAt: null, startedAt: null }))[0].at).toBe(0);
  });
});

describe('zcode translateZcodeHook', () => {
  const base = { session_id: 'sess_abc', cwd: '/ws/demo' };

  test('SessionStart → session.start（带 cwd/model）', () => {
    const out = translateZcodeHook({ ...base, hook_event_name: 'SessionStart', model: 'GLM-5.3' });
    expect(out[0].kind).toBe('session.start');
    expect(out[0].sessionId).toBe('sess_abc');
    expect(out[0].cwd).toBe('/ws/demo');
    expect(out[0].model).toBe('GLM-5.3');
  });

  test('UserPromptSubmit → turn.start；PreToolUse → tool.call(带工具名)', () => {
    expect(translateZcodeHook({ ...base, hook_event_name: 'UserPromptSubmit' })[0].kind).toBe('turn.start');
    expect(translateZcodeHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Write' })[0]).toMatchObject({
      kind: 'tool.call',
      detail: 'Write',
    });
  });

  test('PermissionRequest → permission.request（pull 拿不到的 approval 信号，带工具名）', () => {
    const out = translateZcodeHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    expect(out[0]).toMatchObject({ kind: 'permission.request', detail: 'Bash' });
  });

  test('PostToolUse/Failure → working(thinking) 心跳；Stop → turn.end', () => {
    for (const ev of ['PostToolUse', 'PostToolUseFailure']) {
      const e = translateZcodeHook({ ...base, hook_event_name: ev })[0];
      expect(e).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    }
    const stop = translateZcodeHook({ ...base, hook_event_name: 'Stop' })[0];
    expect(stop.kind).toBe('turn.end');
    expect(stop.waitingReason).toBe('turn-end');
  });

  test('camelCase 兼容 + 未知事件 → []；raw 不落库', () => {
    const out = translateZcodeHook({ sessionId: 'sess_x', hookEventName: 'Stop' });
    expect(out[0].sessionId).toBe('sess_x');
    expect(out[0].kind).toBe('turn.end');
    // payload 可能带 prompt/tool_input 原文——隐私口径同 rollout，不持久化。
    const p = translateZcodeHook({ ...base, hook_event_name: 'PreToolUse', tool_input: { content: 'secret' } });
    expect(p[0].raw).toBeUndefined();
    expect(translateZcodeHook({ ...base, hook_event_name: 'Whatever' })).toHaveLength(0);
  });
});

describe('mergeZcodeConfig', () => {
  const EVENTS = ['SessionStart', 'Stop'];
  // hasOurHook 按 agent-hooks 路径子串识别我们的条目——命令里必须带真路径。
  const CMD = `/bin/sh '${join(MURMUR_HOME, 'agent-hooks', 'zcode.sh')}'`;

  test('空 cfg → events 齐 + enabled:true；条目是 command+async 旁路', () => {
    const cfg: Record<string, unknown> = {};
    expect(mergeZcodeConfig(cfg, CMD, EVENTS)).toBe(true);
    const hooks = cfg.hooks as { enabled: boolean; events: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
    expect(hooks.enabled).toBe(true);
    for (const ev of EVENTS) {
      const entry = hooks.events[ev][0].hooks[0];
      expect(entry.type).toBe('command');
      expect(entry.command).toBe(CMD);
      expect(entry.async).toBe(true);
    }
  });

  test('已有用户条目保留、我们追加；二次调用幂等', () => {
    const cfg: Record<string, unknown> = {
      hooks: {
        enabled: true,
        events: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'other-tool' }] }] },
      },
    };
    expect(mergeZcodeConfig(cfg, CMD, EVENTS)).toBe(true);
    const hooks = cfg.hooks as { events: Record<string, unknown[]> };
    expect(hooks.events.Stop).toHaveLength(2); // 用户条目还在。
    expect(mergeZcodeConfig(cfg, CMD, EVENTS)).toBe(false); // 幂等。
  });

  test('enabled:false 显式关闭不抢开关（条目照写但保持不生效）', () => {
    const cfg: Record<string, unknown> = { hooks: { enabled: false } };
    mergeZcodeConfig(cfg, CMD, EVENTS);
    expect((cfg.hooks as { enabled: boolean }).enabled).toBe(false);
  });
});
