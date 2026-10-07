/**
 * claude-code adapter 单测：hook 事件翻译、settings.json matcher-group 合并幂等
 * 与卸载、transcript 行翻译（usage/tool_result/isSidechain/isMeta/stop_reason/
 * summary 分派）、quota 响应归一化与凭据解析。
 *
 * 坑：MURMUR_HOME/agentPaths 相关 env 在模块加载时固化——先钉沙箱 env 再动态 import。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'murmur-claude-test-'));
const CLAUDE_HOME = join(HOME, '.claude');
const SETTINGS = join(CLAUDE_HOME, 'settings.json');
process.env.MURMUR_HOME = HOME;
process.env.MURMUR_CLAUDE_HOME = CLAUDE_HOME;

const { translateClaudeHook, translateClaudeTranscriptLine, createClaudeCodeAdapter } = await import(
  '../src/agents/claude-code'
);
const { mergeClaudeHooksConfig, claudeHooksRegistered, writeHookScript, removeHookScript } = await import(
  '../src/hooks/install'
);
const { parseClaudeCredentials, claudeUsageToSnapshot } = await import('../src/quota/claude');

describe('claude hook 事件翻译', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    translateClaudeHook({ hook_event_name: name, session_id: 's1', cwd: '/w', ...extra });

  test('生命周期事件映射（含 detail/phase）', () => {
    expect(ev('SessionStart')[0].kind).toBe('session.start');
    expect(ev('UserPromptSubmit')[0].kind).toBe('turn.start');
    expect(ev('PreToolUse', { tool_name: 'Bash' })[0]).toMatchObject({ kind: 'tool.call', detail: 'Bash' });
    expect(ev('Stop')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('StopFailure')[0].kind).toBe('turn.end');
    expect(ev('SessionEnd')[0].kind).toBe('session.end');
    expect(ev('PostToolUse')[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    expect(ev('PostToolUseFailure')[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    expect(ev('SubagentStop')[0]).toMatchObject({ kind: 'status', phase: 'thinking' });
    expect(ev('PermissionDenied')[0]).toMatchObject({ kind: 'status', status: 'working' });
    expect(ev('ElicitationResult')[0]).toMatchObject({ kind: 'status', status: 'working' });
    expect(ev('SomethingNew')[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
  });

  test('PermissionRequest detail=工具名/命令；Elicitation → waiting(question)', () => {
    expect(
      ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf ./x' } })[0],
    ).toMatchObject({ kind: 'permission.request', detail: 'Bash · rm -rf ./x' });
    expect(ev('PermissionRequest', { tool_name: 'Write' })[0]).toMatchObject({
      kind: 'permission.request',
      detail: 'Write',
    });
    expect(ev('Elicitation', { mcp_server_name: 'github-mcp', message: '要跑哪组测试？' })[0]).toMatchObject({
      kind: 'status',
      status: 'waiting',
      waitingReason: 'question',
      detail: 'github-mcp · 要跑哪组测试？',
    });
    expect(ev('Elicitation', { message: '选个分支' })[0]).toMatchObject({ status: 'waiting', detail: '选个分支' });
    expect(ev('Elicitation', { mode: 'url', url: 'https://auth.example.com/login' })[0]).toMatchObject({
      status: 'waiting',
      detail: 'https://auth.example.com/login',
    });
  });

  test('Notification 按 notification_type 分诊等待信号', () => {
    expect(ev('Notification', { notification_type: 'permission_prompt', message: '需要批准' })[0]).toMatchObject({
      kind: 'permission.request',
      detail: '需要批准',
    });
    expect(ev('Notification', { notification_type: 'idle_prompt' })[0]).toMatchObject({
      kind: 'status',
      status: 'waiting',
      waitingReason: 'turn-end',
    });
    expect(ev('Notification', { notification_type: 'elicitation_dialog', message: '回答问题' })[0]).toMatchObject({
      kind: 'status',
      status: 'waiting',
      waitingReason: 'question',
      detail: '回答问题',
    });
    expect(ev('Notification', { notification_type: 'agent_completed' })[0]).toMatchObject({
      kind: 'turn.end',
      waitingReason: 'turn-end',
    });
    expect(ev('Notification', { notification_type: 'auth_success' })[0]).toMatchObject({ kind: 'status' });
    expect(ev('Notification', { notification_type: 'auth_success' })[0].status).toBeUndefined();
  });

  test('子代理/任务事件 → tool.call；PostModelSwitch 带 model；prompt 当标题；缺 session_id 落 unknown', () => {
    expect(ev('SubagentStart', { agent_type: 'Explore' })[0]).toMatchObject({ kind: 'tool.call', detail: 'Explore' });
    expect(ev('TaskCreated', { task_subject: '跑测试' })[0]).toMatchObject({ kind: 'tool.call', detail: '跑测试' });
    expect(ev('PostModelSwitch', { to_model: 'claude-opus-4-6' })[0]).toMatchObject({
      kind: 'status',
      model: 'claude-opus-4-6',
    });
    expect(ev('UserPromptSubmit', { prompt: '修一下构建' })[0]).toMatchObject({
      kind: 'turn.start',
      title: '修一下构建',
    });
    expect(ev('SessionStart', { session_title: '旧会话', model: 'm1' })[0]).toMatchObject({
      kind: 'session.start',
      title: '旧会话',
      model: 'm1',
    });
    expect(translateClaudeHook({ hook_event_name: 'Stop' })[0].sessionId).toBe('unknown');
    expect(translateClaudeHook(null)[0]).toMatchObject({ agent: 'claude-code', sessionId: 'unknown' });
  });
});

describe('claude hooks 安装（settings.json 的 hooks 键）', () => {
  test('mergeClaudeHooksConfig：matcher-group 形状、幂等、保留他人条目与同住键', () => {
    const cfg: Record<string, unknown> = {
      permissions: { allow: ['Bash(ls)'] },
      env: { FOO: 'bar' }, // 用户配置同住——合并绝不能碰
      hooks: { Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool.sh' }] }] },
    };
    const command = writeHookScript('claude-code');
    expect(mergeClaudeHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(true);
    const hooks = cfg.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(hooks.Stop).toHaveLength(2); // 他人 matcher-group 保留 + 我方追加
    expect(hooks.Stop[1]?.hooks[0]?.command).toContain('agent-hooks/claude-code.sh');
    expect(hooks.Stop[1]?.hooks[0]?.async).toBe(true);
    expect(mergeClaudeHooksConfig(cfg, command, ['Stop', 'PreToolUse'])).toBe(false);
    expect(cfg.env).toEqual({ FOO: 'bar' });
    removeHookScript('claude-code');
  });

  test('installHooks 写盘 + registered 判定 + 卸载只删我方', async () => {
    mkdirSync(CLAUDE_HOME, { recursive: true });
    writeFileSync(
      SETTINGS,
      JSON.stringify({
        permissions: { allow: ['Bash(git status)'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/orca/hook.sh' }] }] },
      }),
    );
    const adapter = createClaudeCodeAdapter();
    expect((await adapter.installHooks()).changed).toBe(true);
    const cfg = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>;
    const hooks = cfg.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toHaveLength(22);
    expect(claudeHooksRegistered(SETTINGS)).toBe(true);
    expect(cfg.permissions).toEqual({ allow: ['Bash(git status)'] });
    expect((await adapter.installHooks()).changed).toBe(false);
    expect((await adapter.detect()).hookInstalled).toBe(true);

    expect((await adapter.uninstallHooks?.())?.changed).toBe(true);
    const after = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(after.hooks)).not.toContain('agent-hooks/claude-code.sh');
    expect((after.hooks as Record<string, unknown[]>).SessionStart).toHaveLength(1); // 只剩 orca
    removeHookScript('claude-code');
  });
});

describe('claude transcript 行翻译', () => {
  const P = '/Users/x/.claude/projects/-Users-x-foo/cccccccc-1111-2222-3333-444444444444.jsonl';
  const TS = '2026-10-02T09:00:00.000Z';

  test('summary/custom-title → status 带 title；system init → session.start', () => {
    const t = translateClaudeTranscriptLine(P, { type: 'summary', sessionId: 's1', summary: '重构规划' });
    expect(t[0]).toMatchObject({ kind: 'status', title: '重构规划' });
    const init = translateClaudeTranscriptLine(P, {
      type: 'system',
      subtype: 'init',
      sessionId: 's1',
      timestamp: TS,
      cwd: '/Users/x/foo',
      model: 'claude-opus-4-6',
    });
    expect(init[0]).toMatchObject({ kind: 'session.start', cwd: '/Users/x/foo', model: 'claude-opus-4-6' });
    const compact = translateClaudeTranscriptLine(P, {
      type: 'system',
      subtype: 'compact_boundary',
      sessionId: 's1',
      timestamp: TS,
    });
    expect(compact[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
  });

  test('user 文本行 → session.start + turn.start；tool_result/isMeta/isSidechain 分派', () => {
    const real = translateClaudeTranscriptLine(P, {
      type: 'user',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: '改一下按钮' }] },
    });
    expect(real.map((e) => e.kind)).toEqual(['session.start', 'turn.start']);
    expect(real[0].at).toBe(Date.parse(TS));

    // tool_result 回填行是工具收尾回模型，标 thinking 而非新一轮 tool.call。
    const toolBack = translateClaudeTranscriptLine(P, {
      type: 'user',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    });
    expect(toolBack.map((e) => e.kind)).toEqual(['status']);
    expect(toolBack[0]).toMatchObject({ status: 'working', phase: 'thinking' });

    // isMeta 簿记行（/clear、本地命令回执）：只刷活性，不迁移状态。
    const meta = translateClaudeTranscriptLine(P, {
      type: 'user',
      sessionId: 's1',
      isMeta: true,
      timestamp: TS,
      message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' },
    });
    expect(meta[0]).toMatchObject({ kind: 'status' });
    expect(meta[0].status).toBeUndefined();

    // isSidechain 行只作父会话心跳，不搬 turn 边界。
    const side = translateClaudeTranscriptLine(P, {
      type: 'user',
      sessionId: 's1',
      isSidechain: true,
      timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: '子任务输入' }] },
    });
    expect(side.map((e) => e.kind)).toEqual(['status']);
    expect(side[0].status).toBe('working');
  });

  test('assistant usage → usage 事件互斥口径 + model；tool_use/stop_reason 分派', () => {
    const evs = translateClaudeTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      timestamp: TS,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: '看一下' }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
      },
    });
    expect(evs[0]).toMatchObject({
      kind: 'usage',
      model: 'claude-opus-4-6',
      tokens: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5 },
    });
    expect(evs[1]).toMatchObject({ kind: 'status', status: 'working' });

    const end = translateClaudeTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] },
    });
    expect(end.map((e) => e.kind)).toEqual(['turn.end']);

    const tool = translateClaudeTranscriptLine(P, {
      type: 'assistant',
      sessionId: 's1',
      timestamp: TS,
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] },
    });
    expect(tool.map((e) => e.kind)).toEqual(['tool.call']);
    expect(tool[0].detail).toBe('Bash');
  });

  test('sessionId 缺字段时取文件名 uuid（orphaned 变体归并同会话）；坏行心跳兜底', () => {
    const evs = translateClaudeTranscriptLine(
      '/p/-x/cccccccc-1111-2222-3333-444444444444.orphaned-20261002.jsonl',
      { type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
    );
    expect(evs[0].sessionId).toBe('cccccccc-1111-2222-3333-444444444444');
    // 未知簿记行（file-history-snapshot/queue-operation…）只刷活性。
    const misc = translateClaudeTranscriptLine(P, { type: 'file-history-snapshot', sessionId: 's1', timestamp: TS });
    expect(misc[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
  });
});

describe('claude quota 归一化', () => {
  test('parseClaudeCredentials：claudeAiOauth 结构 + 缺 token 拒绝', () => {
    const c = parseClaudeCredentials({
      claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1738300000000, subscriptionType: 'pro' },
    });
    expect(c).toMatchObject({ accessToken: 'at', expiresAt: 1738300000000, subscriptionType: 'pro' });
    expect(parseClaudeCredentials({})).toBeNull();
    expect(parseClaudeCredentials({ claudeAiOauth: {} })).toBeNull();
    expect(parseClaudeCredentials(null)).toBeNull();
  });

  test('claudeUsageToSnapshot：窗口映射 + extra_usage 美分换算 + plan 标题化', () => {
    const snap = claudeUsageToSnapshot(
      {
        five_hour: { utilization: 42.4, resets_at: '2026-10-02T14:00:00.000Z' },
        seven_day: { utilization: 10, resets_at: '2026-10-09T00:00:00.000Z' },
        seven_day_opus: { utilization: 0, resets_at: null },
        extra_usage: { is_enabled: true, utilization: 50, used_credits: 1234, monthly_limit: 2468 },
      },
      'max',
    );
    expect(snap.agent).toBe('claude-code');
    expect(snap.plan).toBe('Max');
    expect(snap.windows.map((w) => w.label)).toEqual(['5h', '每周', 'Opus 每周', '额外用量']);
    expect(snap.windows[0]).toMatchObject({ usedPct: 42, resetsAt: Date.parse('2026-10-02T14:00:00.000Z') });
    expect(snap.windows[3]).toMatchObject({ usedPct: 50, used: 12.34, limit: 24.68 });
  });

  test('claudeUsageToSnapshot：缺段跳过、extra_usage 未启用不出窗', () => {
    const snap = claudeUsageToSnapshot({ five_hour: { utilization: 5, resets_at: null }, extra_usage: { is_enabled: false } });
    expect(snap.windows.map((w) => w.label)).toEqual(['5h']);
  });
});

afterAll(() => {
  removeHookScript('claude-code');
});
