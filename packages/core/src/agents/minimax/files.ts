/**
 * minimax 会话产物盘点与删除（清理页数据源）。
 *
 * 产物单元 = v2/sessions/<yyyy>/<mm>/<dd>/<ts>-session_<b64>/ 目录
 * （manifest.json 钉 sessionId/createdAtMs，messages.jsonl 是体积主体）。
 * runtime-state.sqlite 只读取 title/workspace_dir 补展示字段，库行不动——
 * 那是 runtime 本体在写的库（qoder main.sqlite 同款纪律）；删除=目录进废纸篓。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize } from '../base';

interface Unit {
  id: string;
  dir: string;
  createdAt: number;
  modifiedAt: number;
}

/** manifest.json → sessionId/创建时刻；坏文件返回 null（跳过该目录）。 */
function readManifest(dir: string): { sessionId: string; createdAtMs: number } | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    if (typeof m.sessionId !== 'string' || !m.sessionId) return null;
    return { sessionId: m.sessionId, createdAtMs: typeof m.createdAtMs === 'number' ? m.createdAtMs : 0 };
  } catch {
    return null;
  }
}

/** 收集 v2/sessions/<y>/<m>/<d>/<dir> 三级日期目录下的会话产物单元。 */
function collectUnits(root: string): Unit[] {
  const out: Unit[] = [];
  const readDirs = (p: string): string[] => {
    try {
      return readdirSync(p).filter((n) => statSync(join(p, n), { throwIfNoEntry: false })?.isDirectory());
    } catch {
      return [];
    }
  };
  for (const y of readDirs(root)) {
    for (const m of readDirs(join(root, y))) {
      for (const d of readDirs(join(root, y, m))) {
        for (const dir of readDirs(join(root, y, m, d))) {
          const path = join(root, y, m, d, dir);
          const manifest = readManifest(path);
          if (!manifest) continue;
          const st = statSync(path, { throwIfNoEntry: false });
          out.push({
            id: manifest.sessionId,
            dir: path,
            createdAt: manifest.createdAtMs || Math.round(st?.birthtimeMs ?? 0),
            modifiedAt: Math.round(st?.mtimeMs ?? 0),
          });
        }
      }
    }
  }
  return out;
}

/** sessions 注册表只读查询（title/workspace_dir 补展示）；库被占返回空表。 */
function sessionMeta(dbPath: string): Map<string, { title?: string; cwd?: string }> {
  const out = new Map<string, { title?: string; cwd?: string }>();
  if (!existsSync(dbPath)) return out;
  let db: Database | null = null;
  try {
    db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
    for (const r of db
      .query('SELECT session_id, title, workspace_dir FROM local_runtime_sessions')
      .all() as Array<{ session_id: string; title: string | null; workspace_dir: string | null }>) {
      out.set(r.session_id, { title: r.title ?? undefined, cwd: r.workspace_dir ?? undefined });
    }
  } catch {
    // 库不可读时标题/目录缺省，不挡盘点。
  } finally {
    db?.close();
  }
  return out;
}

/** 盘点 v2/sessions 全部会话产物目录。 */
export async function scanMinimaxSessions(): Promise<StoredSession[]> {
  const paths = agentPaths('minimax');
  const sessionsDir = join(paths.sessions ?? '', 'sessions');
  const dbPath = join(paths.sessions ?? '', 'sqlite', 'runtime-state.sqlite');
  if (!existsSync(sessionsDir)) return [];
  const meta = sessionMeta(dbPath);
  return collectUnits(sessionsDir).map((u) => ({
    agent: 'minimax',
    id: u.id,
    title: meta.get(u.id)?.title,
    project: meta.get(u.id)?.cwd,
    sizeBytes: dirSize(u.dir),
    createdAt: u.createdAt,
    modifiedAt: u.modifiedAt,
    kind: 'dir',
    active: false,
    paths: [u.dir],
  }));
}

/** 删除会话产物组（整目录进废纸篓；sqlite 台账行不动）。 */
export async function deleteMinimaxSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const paths = agentPaths('minimax');
  const sessionsDir = join(paths.sessions ?? '', 'sessions');
  const units = new Map(collectUnits(sessionsDir).map((u) => [u.id, u]));
  return ids.map((id) => {
    const u = units.get(id);
    if (!u) return { agent: 'minimax' as const, id, ok: false, freedBytes: 0, error: '会话产物不存在' };
    const size = dirSize(u.dir);
    const ok = !existsSync(u.dir) || trash(u.dir);
    return {
      agent: 'minimax' as const,
      id,
      ok,
      freedBytes: ok ? size : 0,
      error: ok ? undefined : '产物移入废纸篓失败',
    };
  });
}
