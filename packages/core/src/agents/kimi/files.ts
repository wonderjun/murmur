/**
 * kimi 会话产物盘点与删除：sessions/wd_<项目>_<hash>/session_<uuid>/ 整目录即一个会话。
 *
 * 元数据优先取目录内 state.json（id/cwd/title/createdAt/updatedAt），
 * cwd 兜底 session_index.jsonl（官方索引）；删除整目录进废纸篓——
 * 目录内含 wire.jsonl 事件流与 file-history 回滚历史，属会话私有产物。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize } from '../base';

/** state.json 里盘点用得着的字段。 */
interface KimiSessionState {
  id?: string;
  cwd?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** session_index.jsonl → {sessionId: workDir} 映射（官方索引，cwd 兜底来源）。 */
export function loadSessionIndex(homeDir: string): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const text = readFileSync(join(homeDir, 'session_index.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { sessionId?: string; workDir?: string };
      if (r.sessionId && r.workDir) m.set(r.sessionId, r.workDir);
    }
  } catch {}
  return m;
}

/** 会话单元收集：id → 目录路径 + 元数据（扫描与删除共用，删除时重新收集防陈旧路径）。 */
function collectSessions(): Map<string, { dir: string; meta: KimiSessionState }> {
  const paths = agentPaths('kimi');
  const out = new Map<string, { dir: string; meta: KimiSessionState }>();
  const root = paths.sessions;
  if (!root || !existsSync(root)) return out;
  const index = loadSessionIndex(paths.home);
  for (const wd of readdirSync(root)) {
    const wdPath = join(root, wd);
    if (!statSync(wdPath, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const name of readdirSync(wdPath)) {
      if (!name.startsWith('session_')) continue;
      const dir = join(wdPath, name);
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      let meta: KimiSessionState = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as KimiSessionState;
      } catch {
        // state.json 缺失/损坏：目录本身就是会话身份。
      }
      const id = meta.id || name;
      if (!meta.cwd) meta.cwd = index.get(id);
      out.set(id, { dir, meta });
    }
  }
  return out;
}

/** 盘点全部会话目录（title/项目/大小/时间齐，active 由 registry 标）。 */
export async function scanKimiSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const [id, s] of collectSessions()) {
    const st = statSync(s.dir, { throwIfNoEntry: false });
    out.push({
      agent: 'kimi',
      id,
      title: s.meta.title || undefined,
      project: s.meta.cwd || undefined,
      sizeBytes: dirSize(s.dir),
      createdAt: s.meta.createdAt ?? Math.round(st?.birthtimeMs ?? 0),
      modifiedAt: s.meta.updatedAt ?? Math.round(st?.mtimeMs ?? 0),
      kind: 'dir',
      active: false,
      paths: [s.dir],
    });
  }
  return out;
}

/** 删除会话目录（进废纸篓）；id 重解析为目录，防扫描后目录被挪动。 */
export async function deleteKimiSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const sessions = collectSessions();
  return ids.map((id) => {
    const s = sessions.get(id);
    if (!s) return { agent: 'kimi' as const, id, ok: false, freedBytes: 0, error: '会话目录不存在' };
    const size = dirSize(s.dir);
    const ok = trash(s.dir);
    return { agent: 'kimi' as const, id, ok, freedBytes: ok ? size : 0, error: ok ? undefined : '移入废纸篓失败' };
  });
}
