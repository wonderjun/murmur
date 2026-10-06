/**
 * opencode 会话产物盘点与删除。
 *
 * 会话本体在 opencode.db 里：session / session_v2 两表并存（v1.x 起 session_v2
 * 较新，session 是旧表，同 id 可能双表都有行——删除两表都打）。体量集中在
 * session_id 作用域表：part / session_message / message（FK 只级联
 * session→message→part，其余显式清）。旧版（pre-sqlite）另有
 * storage/session|message|session_diff 文件，进废纸篓。
 *
 * 库内删行不缩 .db 文件——freelist 增长，VACUUM 需独占锁（opencode 运行中
 * 多半拿不到），结果里标 needsVacuum 让 UI 如实提示。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize } from '../base';

/** 会话行两表：v2 是现行表，session 旧表（同 id 双表可能并存，删时两表都清）。 */
const SESSION_TABLES = ['session', 'session_v2'] as const;
/** 按 session_id 清理的会话作用域表（FK 级联之外的显式清单）。 */
const SESSION_SCOPED = [
  'message',
  'part',
  'todo',
  'session_share',
  'session_pending',
  'session_inbox',
  'session_message',
  'instruction_entry',
  'instruction_state',
];

/** 内部会话单元。 */
interface OcUnit {
  id: string;
  title?: string;
  project?: string;
  sizeBytes: number;
  createdAt: number;
  modifiedAt: number;
  hasDb: boolean;
  paths: string[];
}

function touch(map: Map<string, OcUnit>, id: string): OcUnit {
  const u = map.get(id) ?? { id, sizeBytes: 0, createdAt: 0, modifiedAt: 0, hasDb: false, paths: [] };
  map.set(id, u);
  return u;
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
}

/** db 会话行 + 内容字节估算（message/part/session_message 的 LENGTH 聚合）。 */
function collectDb(units: Map<string, OcUnit>, dbPath: string) {
  if (!existsSync(dbPath)) return;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return; // DB 被占用/不可读：fs 产物仍可列出。
  }
  try {
    const seen = new Set<string>();
    for (const table of SESSION_TABLES) {
      let rows: SessionRow[] = [];
      try {
        rows = db
          .query(`SELECT id, title, directory, time_created, time_updated FROM ${table}`)
          .all() as SessionRow[];
      } catch {
        continue; // 表不存在（schema 版本差异）跳下一张。
      }
      for (const r of rows) {
        const u = touch(units, r.id);
        u.hasDb = true;
        // 双表同 id 合并：标题/目录取先见（session 表优先），时间取极值。
        u.title ||= r.title || undefined;
        u.project ||= r.directory || undefined;
        if (r.time_created && (!u.createdAt || r.time_created < u.createdAt)) u.createdAt = r.time_created;
        u.modifiedAt = Math.max(u.modifiedAt, r.time_updated ?? 0);
        seen.add(r.id);
      }
    }
    for (const table of ['message', 'part', 'session_message']) {
      try {
        for (const r of db
          .query(`SELECT session_id sid, SUM(LENGTH(data)) s FROM ${table} GROUP BY session_id`)
          .all() as Array<{ sid: string; s: number | null }>) {
          if (seen.has(r.sid)) touch(units, r.sid).sizeBytes += r.s ?? 0;
        }
      } catch {
        // 表缺失按 0 计。
      }
    }
  } finally {
    db.close();
  }
}

/** legacy storage 文件（pre-sqlite 旧版 + session_diff 残件）挂到会话单元上。 */
function collectStorage(units: Map<string, OcUnit>, home: string) {
  const storage = join(home, 'storage');
  const attach = (id: string, p: string, st: { mtimeMs: number; birthtimeMs: number }) => {
    const u = touch(units, id);
    u.paths.push(p);
    u.sizeBytes += dirSize(p);
    u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
    const born = Math.round(st.birthtimeMs);
    if (!u.createdAt || born < u.createdAt) u.createdAt = born;
  };
  // storage/session/<proj>/<sid>.json：旧版会话文件，JSON 内有 title/directory/time。
  const sessDir = join(storage, 'session');
  if (existsSync(sessDir)) {
    try {
      for (const proj of readdirSync(sessDir)) {
        const projDir = join(sessDir, proj);
        if (!statSync(projDir, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const name of readdirSync(projDir)) {
          if (!name.endsWith('.json')) continue;
          const p = join(projDir, name);
          const st = statSync(p, { throwIfNoEntry: false });
          if (!st?.isFile()) continue;
          let meta: { id?: string; title?: string; directory?: string; time?: { created?: number; updated?: number } } = {};
          try {
            meta = JSON.parse(readFileSync(p, 'utf8'));
          } catch {
            // 坏 json 也按文件名当会话 id 收。
          }
          const id = meta.id || name.replace(/\.json$/, '');
          const u = touch(units, id);
          u.paths.push(p);
          u.sizeBytes += st.size;
          u.title ||= meta.title || undefined;
          u.project ||= meta.directory || (proj === 'global' ? undefined : proj);
          u.createdAt = meta.time?.created ?? Math.round(st.birthtimeMs);
          u.modifiedAt = Math.max(u.modifiedAt, meta.time?.updated ?? Math.round(st.mtimeMs));
        }
      }
    } catch {
      // 目录并发改写跳过。
    }
  }
  // storage/message/<sid>/：旧版消息目录（按会话归并删）。
  const msgDir = join(storage, 'message');
  if (existsSync(msgDir)) {
    try {
      for (const sid of readdirSync(msgDir)) {
        const p = join(msgDir, sid);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory()) attach(sid, p, st);
      }
    } catch {
      // 同上。
    }
  }
  // storage/session_diff/<sid>.json：会话 diff 快照（db 版也还在写这个目录）。
  const diffDir = join(storage, 'session_diff');
  if (existsSync(diffDir)) {
    try {
      for (const name of readdirSync(diffDir)) {
        if (!name.endsWith('.json')) continue;
        const p = join(diffDir, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isFile()) attach(name.replace(/\.json$/, ''), p, st);
      }
    } catch {
      // 同上。
    }
  }
}

/** 汇总 db 行 + storage 文件两侧。 */
function collectUnits(): Map<string, OcUnit> {
  const paths = agentPaths('opencode');
  const units = new Map<string, OcUnit>();
  collectDb(units, join(paths.home, 'opencode.db'));
  collectStorage(units, paths.home);
  return units;
}

/** 盘点全部会话（db 行为主，legacy 文件归并同 id 或独立成行）。 */
export async function scanOpencodeSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const u of collectUnits().values()) {
    out.push({
      agent: 'opencode',
      id: u.id,
      title: u.title,
      project: u.project,
      sizeBytes: u.sizeBytes,
      createdAt: u.createdAt,
      modifiedAt: u.modifiedAt,
      kind: u.hasDb ? 'db' : 'dir',
      active: false,
      paths: u.paths,
    });
  }
  return out;
}

/** 库内删行：PRAGMA foreign_keys 打开 FK 级联，session 双表 + session_id 表事务清。 */
function deleteDbRows(dbPath: string, id: string): { deleted: boolean; error?: string } {
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.transaction(() => {
      for (const t of SESSION_TABLES) {
        try {
          db.run(`DELETE FROM ${t} WHERE id = ?`, [id]);
        } catch {
          // 表不存在的版本差异：跳过这张。
        }
      }
      for (const t of new Set(SESSION_SCOPED)) {
        try {
          db.run(`DELETE FROM ${t} WHERE session_id = ?`, [id]);
        } catch {
          // 表/列缺失：best-effort 跳过，残行无害。
        }
      }
    })();
    return { deleted: true };
  } catch (e) {
    return { deleted: false, error: `opencode.db 删除失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db.close();
  }
}

/** 删除会话：storage 文件进废纸篓 + db 行事务删（标 needsVacuum）。 */
export async function deleteOpencodeSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const paths = agentPaths('opencode');
  const dbPath = join(paths.home, 'opencode.db');
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u) return { agent: 'opencode' as const, id, ok: false, freedBytes: 0, error: '会话不存在' };
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    let needsVacuum = false;
    if (u.hasDb && existsSync(dbPath)) {
      const r = deleteDbRows(dbPath, id);
      needsVacuum = r.deleted;
      if (!r.deleted) {
        ok = false;
        return { agent: 'opencode' as const, id, ok, freedBytes: 0, needsVacuum, error: r.error };
      }
    }
    return {
      agent: 'opencode' as const,
      id,
      ok,
      freedBytes: ok ? u.sizeBytes : 0,
      needsVacuum,
      error: ok ? undefined : '部分产物删除失败',
    };
  });
}
