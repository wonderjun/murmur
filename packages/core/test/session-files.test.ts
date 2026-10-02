/**
 * 会话产物盘点/删除单测：各 agent 的 fs 产物 + 库内行双形态。
 *
 * agentPaths 在调用时读 env——本文件把全部 agent 家目录钉进临时沙箱，
 * 扫描与删除逻辑绝不指向真机数据；trash 用假实现记录调用路径。
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanCodexSessions, deleteCodexSessions } from '../src/agents/codex/files';
import { scanCursorSessions, deleteCursorSessions } from '../src/agents/cursor/files';
import { scanDevinSessions, deleteDevinSessions } from '../src/agents/devin/files';
import { scanKimiSessions, deleteKimiSessions } from '../src/agents/kimi/files';
import { scanOpencodeSessions, deleteOpencodeSessions } from '../src/agents/opencode/files';
import { scanQoderSessions, deleteQoderSessions } from '../src/agents/qoder/files';
import { scanZcodeSessions, deleteZcodeSessions } from '../src/agents/zcode/files';

let ROOT: string;
const trashed: string[] = [];
const trash = (p: string) => {
  trashed.push(p);
  return true;
};

const ENV_KEYS = [
  'MURMUR_KIMI_HOME',
  'MURMUR_CODEX_HOME',
  'MURMUR_CURSOR_HOME',
  'MURMUR_ZCODE_HOME',
  'MURMUR_OPENCODE_DATA',
  'MURMUR_DEVIN_DATA',
  'MURMUR_QODER_HOME',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'murmur-files-test-'));
  trashed.length = 0;
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  process.env.MURMUR_KIMI_HOME = join(ROOT, 'kimi');
  process.env.MURMUR_CODEX_HOME = join(ROOT, 'codex');
  process.env.MURMUR_CURSOR_HOME = join(ROOT, 'cursor');
  process.env.MURMUR_ZCODE_HOME = join(ROOT, 'zcode');
  process.env.MURMUR_OPENCODE_DATA = join(ROOT, 'opencode');
  process.env.MURMUR_DEVIN_DATA = join(ROOT, 'devin');
  process.env.MURMUR_QODER_HOME = join(ROOT, 'qoder');
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/** kimi fixture：sessions/wd_proj_<hash>/session_<uuid>/ + state.json。 */
function fakeKimi(id: string, cwd: string, title: string) {
  const dir = join(ROOT, 'kimi', 'sessions', 'wd_proj_ab12', id);
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ id, cwd, title, createdAt: 1000, updatedAt: 2000 }));
  writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), '{"type":"turn.prompt"}\n');
}

/** opencode fixture：session + message/part 级联行。 */
function fakeOpencodeDb(dir: string) {
  const db = new Database(join(dir, 'opencode.db'), { create: true });
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
           CREATE TABLE session_v2(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
           CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
           CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
           CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
           CREATE TABLE todo(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);`);
  db.run("INSERT INTO session VALUES('ses_a','标题A','/tmp/projA',1000,3000)");
  db.run("INSERT INTO session_v2 VALUES('ses_a','标题A','/tmp/projA',1000,3000)");
  db.run("INSERT INTO message VALUES('m1','ses_a','{}')");
  db.run("INSERT INTO part VALUES('p1','ses_a','m1','{" + 'x'.repeat(100) + "}')");
  db.run("INSERT INTO session_message VALUES('sm1','ses_a','{}')");
  db.run("INSERT INTO todo VALUES('t1','ses_a','{}')");
  db.close();
}

describe('会话产物盘点', () => {
  test('kimi：state.json 元数据 + 目录大小 + 删除走 trash', async () => {
    fakeKimi('session_aaa', '/tmp/proj', 'kimi 会话A');
    const items = await scanKimiSessions();
    expect(items).toHaveLength(1);
    const s = items[0];
    expect(s.id).toBe('session_aaa');
    expect(s.title).toBe('kimi 会话A');
    expect(s.project).toBe('/tmp/proj');
    expect(s.kind).toBe('dir');
    expect(s.createdAt).toBe(1000);
    expect(s.modifiedAt).toBe(2000);
    expect(s.sizeBytes).toBeGreaterThan(0);

    const res = await deleteKimiSessions(['session_aaa'], trash);
    expect(res[0].ok).toBe(true);
    expect(trashed[0]).toContain('session_aaa');
  });

  test('codex：rollout 文件名取 id/创建时间，首行 session_meta 取项目', async () => {
    const dir = join(ROOT, 'codex', 'sessions', '2025', '09', '14');
    mkdirSync(dir, { recursive: true });
    const uuid = '12345678-1234-1234-1234-123456789abc';
    writeFileSync(
      join(dir, `rollout-2025-09-14T15-00-44-${uuid}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: '/tmp/codex-proj' } }) + '\n',
    );
    const items = await scanCodexSessions();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(uuid);
    expect(items[0].project).toBe('/tmp/codex-proj');
    expect(items[0].kind).toBe('file');
    expect(items[0].createdAt).toBe(Date.parse('2025-09-14T15:00:44'));

    const res = await deleteCodexSessions([uuid], trash);
    expect(res[0].ok).toBe(true);
    expect(trashed[0]).toContain('rollout-');
  });

  test('cursor：subagents 归并父会话 + chats 目录独立成行', async () => {
    const proj = join(ROOT, 'cursor', 'projects', 'tmp-x', 'agent-transcripts');
    mkdirSync(join(proj, 'sess1', 'subagents'), { recursive: true });
    writeFileSync(join(proj, 'sess1.jsonl'), '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>修一下登录页</user_query>"}]}}\n');
    writeFileSync(join(proj, 'sess1', 'subagents', 'sub1.jsonl'), '{"role":"assistant"}\n');
    const chat = join(ROOT, 'cursor', 'chats', 'md5x', 'chatuuid1');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, 'meta.json'), JSON.stringify({ title: 'cli 会话', createdAtMs: 5000, updatedAtMs: 9000 }));

    const items = await scanCursorSessions();
    const t = items.find((i) => i.id === 'sess1');
    const c = items.find((i) => i.id === 'chat:chatuuid1');
    expect(t?.title).toBe('修一下登录页');
    expect(t?.kind).toBe('dir'); // 主文件 + 子代理目录归并
    expect(c?.title).toBe('cli 会话');
    expect(c?.createdAt).toBe(5000);

    const res = await deleteCursorSessions(['sess1'], trash);
    expect(res[0].ok).toBe(true);
    expect(trashed.join()).toContain('sess1');
  });

  test('opencode：db 行盘点 + 删除清会话作用域表', async () => {
    const home = join(ROOT, 'opencode');
    mkdirSync(home, { recursive: true });
    fakeOpencodeDb(home);
    const items = await scanOpencodeSessions();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('ses_a');
    expect(items[0].kind).toBe('db');
    expect(items[0].sizeBytes).toBeGreaterThan(0);

    const res = await deleteOpencodeSessions(['ses_a'], trash);
    expect(res[0].ok).toBe(true);
    expect(res[0].needsVacuum).toBe(true);
    const db = new Database(join(home, 'opencode.db'), { readonly: true });
    expect((db.query('SELECT COUNT(*) n FROM session').get() as { n: number }).n).toBe(0);
    expect((db.query('SELECT COUNT(*) n FROM session_v2').get() as { n: number }).n).toBe(0);
    expect((db.query('SELECT COUNT(*) n FROM part').get() as { n: number }).n).toBe(0);
    expect((db.query('SELECT COUNT(*) n FROM todo').get() as { n: number }).n).toBe(0);
    db.close();
  });

  test('zcode：session 行 + tasks 行 + fs 产物归并为一个条目', async () => {
    const home = join(ROOT, 'zcode');
    mkdirSync(join(home, 'cli', 'db'), { recursive: true });
    mkdirSync(join(home, 'v2'), { recursive: true });
    mkdirSync(join(home, 'cli', 'agents', 'sess_1'), { recursive: true });
    mkdirSync(join(home, 'cli', 'rollout'), { recursive: true });
    writeFileSync(join(home, 'cli', 'agents', 'sess_1', 'x.txt'), 'data');
    writeFileSync(join(home, 'cli', 'rollout', 'model-io-sess_1.jsonl'), '{}\n');

    const db = new Database(join(home, 'cli', 'db', 'db.sqlite'), { create: true });
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message(id TEXT, session_id TEXT, data TEXT);
             CREATE TABLE part(id TEXT, session_id TEXT, data TEXT);`);
    db.run("INSERT INTO session VALUES('sess_1','zcode 会话','/tmp/zp',1111,2222)");
    db.run("INSERT INTO part VALUES('p','sess_1','{" + 'y'.repeat(50) + "}')");
    db.close();

    const tdb = new Database(join(home, 'v2', 'tasks-index.sqlite'), { create: true });
    tdb.exec('CREATE TABLE tasks(task_id TEXT, title TEXT, workspace_path TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0)');
    tdb.run("INSERT INTO tasks VALUES('sess_1','zcode 会话','/tmp/zp',1111,2222,0)");
    tdb.close();

    const items = await scanZcodeSessions();
    expect(items).toHaveLength(1);
    const s = items[0];
    expect(s.id).toBe('sess_1');
    expect(s.project).toBe('/tmp/zp');
    expect(s.kind).toBe('db');
    expect(s.paths?.length).toBe(2); // agents 目录 + rollout 文件

    const res = await deleteZcodeSessions(['sess_1'], trash);
    expect(res[0].ok).toBe(true);
    expect(res[0].needsVacuum).toBe(true);
    expect(trashed).toHaveLength(2);
    const tdb2 = new Database(join(home, 'v2', 'tasks-index.sqlite'), { readonly: true });
    expect((tdb2.query('SELECT COUNT(*) n FROM tasks WHERE deleted=0').get() as { n: number }).n).toBe(0);
    tdb2.close();
    const db2 = new Database(join(home, 'cli', 'db', 'db.sqlite'), { readonly: true });
    expect((db2.query('SELECT COUNT(*) n FROM session').get() as { n: number }).n).toBe(0);
    db2.close();
  });

  test('devin：sessions 行 + 同名文件归并，行删 + 文件进篓', async () => {
    const home = join(ROOT, 'devin');
    const cli = join(home, 'cli');
    mkdirSync(join(cli, 'transcripts'), { recursive: true });
    mkdirSync(join(cli, 'session_locks'), { recursive: true });
    writeFileSync(join(cli, 'transcripts', 'word-pair.json'), '{"x":1}');
    writeFileSync(join(cli, 'session_locks', 'word-pair.lock'), '1234');

    const db = new Database(join(cli, 'sessions.db'), { create: true });
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, working_directory TEXT, created_at INTEGER, last_activity_at INTEGER, hidden INTEGER DEFAULT 0);
             CREATE TABLE message_nodes(session_id TEXT, chat_message TEXT, metadata TEXT);
             CREATE TABLE tool_call_state(session_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT);`);
    db.run("INSERT INTO sessions VALUES('word-pair','devin 会话','/tmp/dp',1700000000,1700003600,0)");
    db.run("INSERT INTO message_nodes VALUES('word-pair','{" + 'z'.repeat(60) + "}','{}')");
    db.close();

    const items = await scanDevinSessions();
    expect(items).toHaveLength(1);
    const s = items[0];
    expect(s.id).toBe('word-pair');
    expect(s.project).toBe('/tmp/dp');
    expect(s.kind).toBe('db');
    expect(s.createdAt).toBe(1700000000000); // 秒级 unix → ms
    expect(s.paths?.length).toBe(2);

    const res = await deleteDevinSessions(['word-pair'], trash);
    expect(res[0].ok).toBe(true);
    expect(res[0].needsVacuum).toBe(true);
    expect(trashed).toHaveLength(2);
    const db2 = new Database(join(cli, 'sessions.db'), { readonly: true });
    expect((db2.query('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n).toBe(0);
    db2.close();
  });

  test('qoder：transcript + state 目录 + tasks/logs 归并同一 sessionId，ai-title 优先', async () => {
    const home = join(ROOT, 'qoder');
    const proj = join(home, 'projects', '-tmp');
    const sid = 'qaaaaaaa-1111-2222-3333-444444444444';
    mkdirSync(join(proj, sid), { recursive: true });
    mkdirSync(join(proj, 'transcript'), { recursive: true });
    mkdirSync(join(home, 'tasks', sid), { recursive: true });
    mkdirSync(join(home, 'logs', 'sessions', '-tmp', sid), { recursive: true });
    writeFileSync(
      join(proj, `${sid}.jsonl`),
      '{"type":"user","message":{"content":[{"type":"text","text":"改一下登录页"}]}}\n{"type":"ai-title","aiTitle":"登录页修复"}\n',
    );
    writeFileSync(join(proj, sid, 'state.json'), '{}');
    writeFileSync(join(proj, 'transcript', 'task-t1.session.execution.jsonl'), '{"type":"user","message":{"content":"委派活"}}\n');
    writeFileSync(join(home, 'tasks', sid, 'x.json'), '{}');

    const items = await scanQoderSessions();
    const s = items.find((i) => i.id === sid);
    const t = items.find((i) => i.id === 'task-t1.session.execution');
    expect(s?.title).toBe('登录页修复'); // ai-title 覆盖 user 文本
    expect(s?.project).toBe('/tmp');
    expect(s?.paths?.length).toBe(4); // 主 jsonl + <sid>/ + tasks/ + logs/
    expect(t?.title).toBe('委派活'); // transcript/ 下无 ai-title → 首 user 文本

    const res = await deleteQoderSessions([sid], trash);
    expect(res[0].ok).toBe(true);
    expect(trashed).toHaveLength(4);
    expect(trashed.join()).toContain(sid);
  });

  test('目录不存在 → 空列表而非报错', async () => {
    expect(await scanKimiSessions()).toHaveLength(0);
    expect(await scanCodexSessions()).toHaveLength(0);
    expect(await scanCursorSessions()).toHaveLength(0);
    expect(await scanZcodeSessions()).toHaveLength(0);
    expect(await scanOpencodeSessions()).toHaveLength(0);
    expect(await scanDevinSessions()).toHaveLength(0);
    expect(await scanQoderSessions()).toHaveLength(0);
    expect(existsSync(ROOT)).toBe(true);
  });
});
