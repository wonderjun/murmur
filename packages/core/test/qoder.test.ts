/**
 * qoder adapter 单测：hook 事件翻译、settings.json matcher-group 合并幂等与卸载、
 * transcript 行翻译（usage/tool_result/isSidechain/stop_reason/ai-title 分派）。
 *
 * 坑：MURMUR_HOME 在 paths.ts 模块加载时固化——先钉沙箱 env 再动态 import。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'murmur-qoder-test-'));
const QODER_HOME = join(HOME, '.qoder');
const SETTINGS = join(QODER_HOME, 'settings.json');
process.env.MURMUR_HOME = HOME;
process.env.MURMUR_QODER_HOME = QODER_HOME;

const { translateQoderHook, translateTranscriptLine, createQoderAdapter } = await import('../src/agents/qoder');
const { mergeQoderHooksConfig, qoderHooksRegistered, writeHookScript, removeHookScript } = await import(
  '../src/hooks/install'
);

describe('qoder hook 事件翻译', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    translateQoderHook({ hook_event_name: name, session_id: 's1', cwd: '/w', ...extra });

  test('生命周期事件映射', () => {
    expect(ev('SessionStart')[0].kind).toBe('session.start');
    expect(ev('UserPromptSubmit')[0].kind).toBe('turn.start');
    expect(ev('PreToolUse')[0].kind).toBe('tool.call');
    expect(ev('PermissionRequest')[0].kind).toBe('permission.request');
    expect(ev('Stop')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('StopFailure')[0].kind).toBe('turn.end');
    expect(ev('SessionEnd')[0].kind).toBe('session.end');
    expect(ev('PostToolUse')[0]).toMatchObject({ kind: 'status', status: 'working' });
    expect(ev('SubagentStop')[0].kind).toBe('status');
    expect(ev('Notification')[0].kind).toBe('status');
    expect(ev('SomethingNew')[0]).toMatchObject({ kind: 'status', status: 'working' });
  });

  test('Elicitation → waiting(question)；prompt 当标题；缺 session_id 落 unknown', () => {
    expect(ev('Elicitation')[0]).toMatchObject({ kind: 'status', status: 'waiting', waitingReason: 'question' });
    expect(ev('UserPromptSubmit', { prompt: '修一下构建' })[0]).toMatchObject({
      kind: 'turn.start',
      title: '修一下构建',
    });
    expect(translateQoderHook({ hook_event_name: 'Stop' })[0].sessionId).toBe('unknown');
    expect(translateQoderHook(null)[0]).toMatchObject({ agent: 'qoder', sessionId: 'unknown' });
  });
});

describe('qoder hooks 安装（settings.json 的 hooks 键）', () => {
  test('mergeQoderHooksConfig：matcher-group 形状、幂等、保留他人条目与同住键', () => {
    const cfg: Record<string, unknown> = {
      enabledPlugins: { 'x@y': true },
      providers: { p: { apiKey: 'sk-xxx' } }, // 用户 key 同住——合并绝不能碰
      hooks: { Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool.sh' }] }] },
    };
    const command = writeHookScript('qoder');
    expect(mergeQoderHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(true);
    const hooks = cfg.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(hooks.Stop).toHaveLength(2); // 他人 matcher-group 保留 + 我方追加
    expect(hooks.Stop[1]?.hooks[0]?.command).toContain('agent-hooks/qoder.sh');
    expect(hooks.Stop[1]?.hooks[0]?.async).toBe(true);
    expect(mergeQoderHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(false);
    expect(cfg.providers).toEqual({ p: { apiKey: 'sk-xxx' } });
    removeHookScript('qoder');
  });

  test('installHooks 写盘 + registered 判定 + 卸载只删我方', async () => {
    mkdirSync(QODER_HOME, { recursive: true });
    writeFileSync(
      SETTINGS,
      JSON.stringify({
        permissions: { trustDirectories: ['/w'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/orca/hook.sh' }] }] },
      }),
    );
    const adapter = createQoderAdapter();
    expect((await adapter.installHooks()).changed).toBe(true);
    const cfg = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>;
    const hooks = cfg.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toHaveLength(19);
    expect(qoderHooksRegistered(SETTINGS)).toBe(true);
    expect(cfg.permissions).toEqual({ trustDirectories: ['/w'] });
    expect((await adapter.installHooks()).changed).toBe(false);
    expect((await adapter.detect()).hookInstalled).toBe(true);

    expect((await adapter.uninstallHooks?.())?.changed).toBe(true);
    const after = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(after.hooks)).not.toContain('agent-hooks/qoder.sh');
    expect((after.hooks as Record<string, unknown[]>).SessionStart).toHaveLength(1); // 只剩 orca
    removeHookScript('qoder');
  });
});

describe('qoder transcript 行翻译', () => {
  const P = '/Users/x/.qoder/projects/-Users-x-foo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl';
  const TS = '2026-10-02T09:00:00.000Z';

  test('workspace-directories → session.start + cwd；无 timestamp → at 0', () => {
    const evs = translateTranscriptLine(P, {
      type: 'workspace-directories',
      sessionId: 's-9',
      directories: ['/Users/x/foo'],
    });
    expect(evs[0]).toMatchObject({ kind: 'session.start', sessionId: 's-9', cwd: '/Users/x/foo', at: 0 });
  });

  test('user 文本行 → session.start + turn.start；tool_result 回填行 → tool.call', () => {
    const real = translateTranscriptLine(P, {
      type: 'user',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: '改一下按钮' }] },
    });
    expect(real.map((e) => e.kind)).toEqual(['session.start', 'turn.start']);
    expect(real[0].at).toBe(Date.parse(TS));

    const toolBack = translateTranscriptLine(P, {
      type: 'user',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    });
    expect(toolBack.map((e) => e.kind)).toEqual(['tool.call']);
  });

  test('assistant usage → usage 事件互斥口径 + model；tool_use → tool.call', () => {
    const evs = translateTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      timestamp: TS,
      message: {
        role: 'assistant',
        model: 'kmodel_latest',
        content: [{ type: 'text', text: '看一下' }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
      },
    });
    expect(evs[0]).toMatchObject({
      kind: 'usage',
      model: 'kmodel_latest',
      tokens: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5 },
    });
    // 无 stop_reason 的 assistant 行按心跳处理，不冒充回合收尾。
    expect(evs[1]).toMatchObject({ kind: 'status', status: 'working' });
  });

  test('assistant stop_reason=end_turn → turn.end；tool_use → tool.call', () => {
    const end = translateTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] },
    });
    expect(end.map((e) => e.kind)).toEqual(['turn.end']);

    const tool = translateTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      timestamp: TS,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    });
    expect(tool.map((e) => e.kind)).toEqual(['tool.call']);
  });

  test('isSidechain 行只作心跳不搬 turn 边界；ai-title 落 title', () => {
    const side = translateTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      isSidechain: true,
      timestamp: TS,
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
    });
    expect(side.map((e) => e.kind)).toEqual(['status']);
    expect(side[0].status).toBe('working');

    const titled = translateTranscriptLine(P, {
      type: 'ai-title',
      sessionId: 's1',
      timestamp: TS,
      aiTitle: '重构规划',
    });
    expect(titled[0]).toMatchObject({ kind: 'status', title: '重构规划' });
  });

  test('sessionId 缺字段时取文件名（含 transcript/ 下 task-* 形状）', () => {
    const evs = translateTranscriptLine('/p/-x-y/transcript/task-abc.session.execution.jsonl', {
      type: 'session_meta',
      timestamp: TS,
    });
    expect(evs[0].sessionId).toBe('task-abc.session.execution');
    expect(evs[0].kind).toBe('status');
  });
});

afterAll(() => {
  removeHookScript('qoder');
});
