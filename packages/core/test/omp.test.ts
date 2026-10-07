/**
 * omp adapter 单测：扩展上报翻译（omp snake_case 事件名直传）、会话 journal
 * 行翻译（v3 message/custom/title/model_change 分派 + subagent 归并 + ask 等待）、
 * 扩展安装幂等/卸载归属、usage_history 额度窗、会话产物盘点删除。
 *
 * 坑：MURMUR_OMP_HOME 等 env 在调用时才被 agentPaths 读——测试内钉沙箱即可；
 * 生成的扩展文件含 marker，卸载只认 marker 不删同名用户文件。
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'murmur-omp-test-'));
const OMP_HOME = join(HOME, '.omp');
const AGENT_DIR = join(OMP_HOME, 'agent');
const SAVED = {
  MURMUR_OMP_HOME: process.env.MURMUR_OMP_HOME,
  MURMUR_OMP_AGENT_DIR: process.env.MURMUR_OMP_AGENT_DIR,
  PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
process.env.MURMUR_OMP_HOME = OMP_HOME;
delete process.env.MURMUR_OMP_AGENT_DIR;
delete process.env.PI_CONFIG_DIR;
delete process.env.PI_CODING_AGENT_DIR;

const { translateOmpHook, translateSessionLine, createOmpAdapter } = await import('../src/agents/omp');
const { sessionFileId, isSubagentFile, scanOmpSessions, deleteOmpSessions } = await import('../src/agents/omp/files');
const { fetchOmpQuota, ompHasCredentials } = await import('../src/agents/omp/quota');
const { ompExtensionInstalled, ompExtensionPath } = await import('../src/hooks/omp-install');

const EXT_DIR = join(AGENT_DIR, 'extensions');

describe('omp 会话文件路径解析', () => {
  const ROOT = '/r/sessions';
  test('主 journal 文件名 <ts>_<uuid>.jsonl → uuid；subagent 目录归并父 id', () => {
    expect(sessionFileId(ROOT, `${ROOT}/-proj/2026-10-07T06-25-41-003Z_01a1-uuid1.jsonl`)).toBe('01a1-uuid1');
    expect(sessionFileId(ROOT, `${ROOT}/-proj/2026-10-06T17-53-49-468Z_02b2-parent/SubTask.jsonl`)).toBe('02b2-parent');
    expect(isSubagentFile(ROOT, `${ROOT}/-proj/x_y.jsonl`)).toBe(false);
    expect(isSubagentFile(ROOT, `${ROOT}/-proj/x_y/Sub.jsonl`)).toBe(true);
  });
});

describe('omp journal 行翻译', () => {
  const SID = 'sess-1';
  const TS = '2026-10-07T06:50:06.686Z';
  const MS = Date.parse(TS);

  test('session 头 → session.start 带 cwd；title/title_change/model_change → 元数据 status', () => {
    const head = translateSessionLine(SID, false, {
      type: 'session', version: 3, id: SID, timestamp: TS, cwd: '/w/proj',
    });
    expect(head[0]).toMatchObject({ kind: 'session.start', sessionId: SID, cwd: '/w/proj', at: MS });

    const titled = translateSessionLine(SID, false, { type: 'title', v: 1, title: '重构面板', timestamp: TS });
    expect(titled[0]).toMatchObject({ kind: 'status', title: '重构面板' });
    expect(translateSessionLine(SID, false, { type: 'title', v: 1, title: ' ', timestamp: TS })).toHaveLength(0);
    const model = translateSessionLine(SID, false, { type: 'model_change', model: 'devin/swe-2', timestamp: TS });
    expect(model[0]).toMatchObject({ kind: 'status', model: 'devin/swe-2' });
  });

  test('user message → turn.start（不重复发 session.start）', () => {
    const evs = translateSessionLine(SID, false, {
      type: 'message', timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: '修一下按钮' }] },
    });
    expect(evs.map((e) => e.kind)).toEqual(['turn.start']);
  });

  test('assistant usage+model → usage 事件；toolCall → tool.call 带参数摘要', () => {
    const evs = translateSessionLine(SID, false, {
      type: 'message', timestamp: TS,
      message: {
        role: 'assistant', model: 'swe-2', stopReason: 'toolUse',
        content: [
          { type: 'text', text: '看一下' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls -la /w' } },
        ],
        usage: { input: 224, output: 119, cacheRead: 133661, cacheWrite: 0, totalTokens: 134004 },
      },
    });
    expect(evs[0]).toMatchObject({
      kind: 'usage', model: 'swe-2',
      tokens: { input: 224, output: 119, cacheRead: 133661, cacheWrite: 0 },
    });
    expect(evs[1]).toMatchObject({ kind: 'tool.call', detail: 'bash ls -la /w' });
  });

  test('stopReason 非 toolUse → turn.end；toolUse 收尾行不算回合结束', () => {
    const end = translateSessionLine(SID, false, {
      type: 'message', timestamp: TS,
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '完成' }] },
    });
    expect(end.map((e) => e.kind)).toEqual(['turn.end']);
    const aborted = translateSessionLine(SID, false, {
      type: 'message', timestamp: TS, message: { role: 'assistant', stopReason: 'aborted', content: [] },
    });
    expect(aborted[0].kind).toBe('turn.end');
  });

  test('custom/tool_execution_start → tool.call（toolName+intent）；ask → waiting(question)', () => {
    const tool = translateSessionLine(SID, false, {
      type: 'custom', customType: 'tool_execution_start', timestamp: TS,
      data: { toolName: 'bash', intent: '列出项目文件', toolCallId: 'c1', startedAt: TS },
    });
    expect(tool[0]).toMatchObject({ kind: 'tool.call', detail: 'bash · 列出项目文件' });

    const ask = translateSessionLine(SID, false, {
      type: 'custom', customType: 'tool_execution_start', timestamp: TS,
      data: { toolName: 'ask', intent: '要跑哪组测试？', toolCallId: 'c2', startedAt: TS },
    });
    expect(ask.map((e) => e.kind)).toEqual(['tool.call', 'status']);
    expect(ask[1]).toMatchObject({ status: 'waiting', waitingReason: 'question', detail: 'ask · 要跑哪组测试？' });
  });

  test('旧版文件兜底：assistant toolCall 名 ask 也出 waiting(question)', () => {
    const evs = translateSessionLine(SID, false, {
      type: 'message', timestamp: TS,
      message: {
        role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', name: 'ask', arguments: { question: '继续吗？' } }],
      },
    });
    expect(evs.map((e) => e.kind)).toEqual(['tool.call', 'status']);
    expect(evs[1]).toMatchObject({ status: 'waiting', waitingReason: 'question', detail: '继续吗？' });
  });

  test('toolResult/developer/fileMention → working 心跳', () => {
    for (const role of ['toolResult', 'developer', 'fileMention']) {
      const evs = translateSessionLine(SID, false, {
        type: 'message', timestamp: TS, message: { role, content: [{ type: 'text', text: 'x' }] },
      });
      expect(evs[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    }
  });

  test('subagent 行不搬 turn/session 边界：stop → 心跳，usage/tool.call 照计', () => {
    const head = translateSessionLine('parent-1', true, {
      type: 'session', version: 3, id: 'child-9', timestamp: TS, cwd: '/w/proj',
    });
    expect(head[0]).toMatchObject({ kind: 'status', status: 'working' });
    const end = translateSessionLine('parent-1', true, {
      type: 'message', timestamp: TS,
      message: {
        role: 'assistant', stopReason: 'stop', model: 'swe-2',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(end.some((e) => e.kind === 'turn.end')).toBe(false);
    expect(end[0]).toMatchObject({ kind: 'usage', tokens: { input: 10, output: 5 } });
    expect(end[1]).toMatchObject({ kind: 'status', status: 'working' });
  });

  test('timestamp 缺失 → 落文件名时间戳兜底；簿记行（compaction 等）→ 心跳', () => {
    const evs = translateSessionLine(SID, false, { type: 'compaction' }, 777);
    expect(evs[0]).toMatchObject({ kind: 'status', status: 'working', at: 777 });
  });

  test('custom/session_exit → session.end（isSub 不拖死父会话）；title 行吃 updatedAt', () => {
    const exit = translateSessionLine(SID, false, {
      type: 'custom', customType: 'session_exit', timestamp: TS,
      data: { reason: 'sighup', kind: 'signal' },
    });
    expect(exit[0]).toMatchObject({ kind: 'session.end', detail: 'sighup' });
    const subExit = translateSessionLine('parent-1', true, {
      type: 'custom', customType: 'session_exit', timestamp: TS, data: { reason: 'done' },
    });
    expect(subExit[0].kind).toBe('status');
    // title 行只有 updatedAt 没有 timestamp——at 吃 updatedAt 不是文件名兜底。
    const title = translateSessionLine(SID, false, {
      type: 'title', v: 1, title: 'Flow', updatedAt: '2026-10-07T07:00:00Z',
    }, 999);
    expect(title[0]).toMatchObject({ kind: 'status', title: 'Flow', at: Date.parse('2026-10-07T07:00:00Z') });
  });
});

describe('omp 扩展上报翻译', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    translateOmpHook({ hook_event_name: name, session_id: 's1', cwd: '/w', ...extra });

  test('生命周期/工具/审批事件映射', () => {
    expect(ev('session_start')[0].kind).toBe('session.start');
    expect(ev('session_shutdown')[0].kind).toBe('session.end');
    // prompt 不落 title——omp 自产标题会被每条新 prompt 顶掉，标题归 pull journal 管。
    expect(ev('before_agent_start', { prompt: '修一下构建' })[0]).toMatchObject({ kind: 'turn.start' });
    expect(ev('before_agent_start', { prompt: '修一下构建' })[0].title).toBeUndefined();
    expect(ev('agent_end')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('agent_settled')[0]).toMatchObject({ kind: 'turn.end', waitingReason: 'turn-end' });
    expect(ev('turn_start')[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
    expect(ev('tool_execution_start', { tool_name: 'bash' })[0]).toMatchObject({ kind: 'tool.call', detail: 'bash' });
    expect(ev('tool_approval_requested', { tool_name: 'write', reason: '需要写权限' })[0]).toMatchObject({
      kind: 'permission.request', detail: 'write · 需要写权限',
    });
    expect(ev('tool_approval_resolved', { approved: true })[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'tool' });
    expect(ev('SomethingNew')[0]).toMatchObject({ kind: 'status', status: 'working', phase: 'thinking' });
  });

  test('agent_end willContinue → 心跳不是收尾；ask → waiting(question)', () => {
    expect(ev('agent_end', { will_continue: true })[0]).toMatchObject({ kind: 'status', status: 'working' });
    const ask = ev('tool_execution_start', { tool_name: 'ask' });
    expect(ask[1]).toMatchObject({ kind: 'status', status: 'waiting', waitingReason: 'question' });
  });

  test('session_switch/branch：新会话 start + 旧会话（文件名反解）end', () => {
    const out = ev('session_switch', { previous_session_file: '/x/-p/2026-01-01T00-00-00-000Z_old-uuid.jsonl' });
    expect(out.map((e) => e.kind)).toEqual(['session.start', 'session.end']);
    expect(out[1].sessionId).toBe('old-uuid');
    // 无旧文件信息时只发 start。
    expect(ev('session_branch').map((e) => e.kind)).toEqual(['session.start']);
  });

  test('message_end 一律剥离成心跳——usage 归 pull journal 独掌防双计；session_id 缺失 → unknown', () => {
    const usage = ev('message_end', {
      model: 'swe-2',
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
    });
    expect(usage.map((e) => e.kind)).toEqual(['status']);
    expect(translateOmpHook({ hook_event_name: 'session_start' })[0].sessionId).toBe('unknown');
    expect(translateOmpHook(null)[0]).toMatchObject({ agent: 'omp', sessionId: 'unknown' });
  });
});

describe('omp 扩展安装', () => {
  test('落 murmur-agent.ts 含上报契约；幂等；profile 目录一并覆盖', async () => {
    mkdirSync(AGENT_DIR, { recursive: true });
    const profileAgent = join(OMP_HOME, 'profiles', 'work', 'agent');
    mkdirSync(profileAgent, { recursive: true });
    // 用户自己的扩展不能被碰。
    mkdirSync(EXT_DIR, { recursive: true });
    writeFileSync(join(EXT_DIR, 'user-ext.ts'), 'export default function(){}', 'utf8');

    const adapter = createOmpAdapter();
    expect((await adapter.installHooks()).changed).toBe(true);
    const ext = ompExtensionPath(EXT_DIR);
    const src = readFileSync(ext, 'utf8');
    expect(src).toContain('murmur-hook v2');
    expect(src).toContain('pi.on');
    expect(src).toContain('/hook/omp');
    expect(src).toContain('X-Murmur-Hook-Token');
    expect(src).toContain('/omp.jsonl');
    expect(src).toContain('.murmur/spool');
    expect(src).toContain('session_start');
    expect(src).toContain('tool_approval_requested');
    // 命名 profile 的 extensions 也落了一份。
    expect(readFileSync(join(profileAgent, 'extensions', 'murmur-agent.ts'), 'utf8')).toBe(src);
    expect(ompExtensionInstalled(EXT_DIR)).toBe(true);
    expect((await adapter.installHooks()).changed).toBe(false);
    expect((await adapter.detect()).hookInstalled).toBe(true);
  });

  test('卸载只删带 marker 的我方文件：用户扩展与同名无标记文件幸存', async () => {
    const adapter = createOmpAdapter();
    expect((await adapter.uninstallHooks!()).changed).toBe(true);
    expect(existsSync(ompExtensionPath(EXT_DIR))).toBe(false);
    expect(existsSync(join(EXT_DIR, 'user-ext.ts'))).toBe(true);
    expect(ompExtensionInstalled(EXT_DIR)).toBe(false);

    // 同名文件无 marker → 不当我方文件删（防误删用户手写的 murmur-agent.ts）。
    mkdirSync(EXT_DIR, { recursive: true });
    writeFileSync(ompExtensionPath(EXT_DIR), '// user file, no marker\n', 'utf8');
    expect((await adapter.uninstallHooks!()).changed).toBe(false);
    expect(existsSync(ompExtensionPath(EXT_DIR))).toBe(true);
  });

  test('detect：installed/version/hasCredentials', async () => {
    writeFileSync(join(AGENT_DIR, 'last-changelog-version'), '18.7.0\n', 'utf8');
    const info = await createOmpAdapter().detect();
    expect(info.installed).toBe(true);
    expect(info.version).toBe('18.7.0');
    expect(ompHasCredentials()).toBe(false); // agent.db 未建
  });
});

describe('omp 额度面（agent.db usage_history）', () => {
  function fakeAgentDb(rows: Array<[string, string, string, number, number | null, number]>) {
    const db = new Database(join(AGENT_DIR, 'agent.db'), { create: true });
    db.exec(`CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, kind TEXT, credentials TEXT);
             CREATE TABLE usage_history(
               id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL,
               provider TEXT NOT NULL, account_key TEXT NOT NULL, email TEXT, account_id TEXT,
               limit_id TEXT NOT NULL, label TEXT NOT NULL, window_label TEXT,
               used_fraction REAL, status TEXT, resets_at INTEGER)`);
    db.run("INSERT INTO auth_credentials(provider,kind,credentials) VALUES('devin','oauth','{}')");
    for (const [provider, label, win, frac, reset, at] of rows) {
      db.run(
        `INSERT INTO usage_history(recorded_at,provider,account_key,limit_id,label,window_label,used_fraction,resets_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [at, provider, 'acct', `${provider}:${label}`, label, win, frac, reset],
      );
    }
    db.close();
  }

  test('usage_history → QuotaWindow：序列取最新、used_fraction→usedPct、resets_at 保留', async () => {
    mkdirSync(AGENT_DIR, { recursive: true });
    fakeAgentDb([
      ['devin', 'Daily Quota', 'Daily Quota', 0.0, 1791360000000, 1791358857957],
      ['devin', 'Weekly Quota', 'Weekly Quota', 0.90, 1791705600000, 1791358857957],
      ['devin', 'Weekly Quota', 'Weekly Quota', 0.97, 1791705600000, 1791359158441], // 同序列更新行覆盖
    ]);
    const snap = await fetchOmpQuota();
    expect(snap.error).toBeUndefined();
    expect(snap.windows).toHaveLength(2);
    const weekly = snap.windows.find((w) => w.label.includes('Weekly'));
    expect(weekly).toMatchObject({ usedPct: 97, resetsAt: 1791705600000 });
    expect(snap.fetchedAt).toBe(1791359158441);
    expect(ompHasCredentials()).toBe(true);
  });

  test('表缺失/库损坏 → error 快照降级，不抛异常', async () => {
    writeFileSync(join(AGENT_DIR, 'agent.db'), 'not sqlite');
    const snap = await fetchOmpQuota();
    expect(snap.windows).toHaveLength(0);
    expect(snap.error).toBeTruthy();
  });
});

describe('omp 会话产物盘点与删除', () => {
  const SESSIONS = join(AGENT_DIR, 'sessions');
  function fakeSession(slug: string, stem: string, lines: string[]) {
    const dir = join(SESSIONS, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stem}.jsonl`), lines.join('\n') + '\n');
    return join(dir, `${stem}.jsonl`);
  }
  const trashed: string[] = [];
  const trash = (p: string) => {
    trashed.push(p);
    return true;
  };

  test('主 journal + subagent 目录归并同一 sessionId；孤儿目录自立单元', async () => {
    trashed.length = 0;
    const stem = '2026-10-07T06-25-41-003Z_aaaa-bbbb';
    fakeSession('-Documents-flow', stem, [
      '{"type":"title","v":1,"title":"渲染治理","updatedAt":"2026-10-07T07:00:00Z"}',
      `{"type":"session","version":3,"id":"aaaa-bbbb","timestamp":"2026-10-07T06:25:41.003Z","cwd":"/tmp/proj"}`,
      '{"type":"message","timestamp":"2026-10-07T06:50:06Z","message":{"role":"user","content":[{"type":"text","text":"修 bug"}]}}',
    ]);
    // subagent 目录（父 stem 同名）→ 归并 aaaa-bbbb。
    mkdirSync(join(SESSIONS, '-Documents-flow', stem), { recursive: true });
    writeFileSync(join(SESSIONS, '-Documents-flow', stem, 'SubTask.jsonl'), '{"type":"session"}\n');
    // 孤儿 subagent 目录（无父 jsonl）→ 以目录名 uuid 自立。
    mkdirSync(join(SESSIONS, '-Documents-flow', '2026-10-06T17-53-49-468Z_orph-anid'), { recursive: true });
    writeFileSync(join(SESSIONS, '-Documents-flow', '2026-10-06T17-53-49-468Z_orph-anid', 'a.jsonl'), '{}\n');

    const items = await scanOmpSessions();
    const main = items.find((i) => i.id === 'aaaa-bbbb');
    expect(main).toMatchObject({ agent: 'omp', title: '渲染治理', project: '/tmp/proj', kind: 'dir' });
    expect(main?.paths).toHaveLength(2);
    expect(items.some((i) => i.id === 'orph-anid')).toBe(true);

    const res = await deleteOmpSessions(['aaaa-bbbb', 'orph-anid'], trash);
    expect(res.every((r) => r.ok)).toBe(true);
    // 父文件 + subagent 目录 + 孤儿目录全进 trash。
    expect(trashed.filter((p) => p.includes('aaaa-bbbb'))).toHaveLength(2);
    expect(trashed.some((p) => p.includes('orph-anid'))).toBe(true);
  });

  test('无 title 记录时标题落首条 user 文本；删除缺失 id 报错不抛', async () => {
    trashed.length = 0;
    fakeSession('-x', '2026-10-08T00-00-00-000Z_cccc-dddd', [
      `{"type":"session","version":3,"id":"cccc-dddd","timestamp":"2026-10-08T00:00:00Z","cwd":"/tmp/p2"}`,
      '{"type":"message","timestamp":"2026-10-08T00:01:00Z","message":{"role":"user","content":[{"type":"text","text":"  整理   依赖 版本 "}]}}',
    ]);
    const items = await scanOmpSessions();
    const s = items.find((i) => i.id === 'cccc-dddd');
    expect(s?.title).toBe('整理 依赖 版本');
    const res = await deleteOmpSessions(['nope-id'], trash);
    expect(res[0]).toMatchObject({ ok: false, error: '会话产物不存在' });
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
