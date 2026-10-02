/**
 * devin 会话产物盘点与删除：cli/sessions.db 的 sessions 行（词组 slug 为 id）是本体。
 *
 * 体量集中在 session_id 作用域表：message_nodes（消息树，大头）/
 * tool_call_state / prompt_history / rendered_commits / subagent_heads；
 * 同名文件产物 transcripts/<slug>.json、session_locks/<slug>.lock 进废纸篓。
 * sessions.created_at/last_activity_at 是秒级 unix——toMs 自适配。
 * 库内删行不缩 .db 文件，标 needsVacuum 供 UI 提示。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';

/** 秒/毫秒自适配（本地库是秒、API 文档也是秒，防上游翻单位）。 */
export function toMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

/** sessions.db 里按 session_id 清理的会话作用域表。 */
const SESSION_SCOPED = ['message_nodes', 'tool_call_state', 'prompt_history', 'rendered_commits', 'subagent_heads'];

/** 内部会话单元：id(slug) → 元数据 + 待删路径 + 库内行标记。 */
interface DevinUnit {
  id: string;
  title?: string;
  project?: string;
  sizeBytes: number;
  createdAt: number;
  modifiedAt: number;
  hasDb: boolean;
  paths: string[];
}

/** 汇总 sessions 行 + transcripts/session_locks 同名文件。 */
function collectUnits(): Map<string, DevinUnit> {
  const paths = agentPaths('devin');
  const cli = paths.sessions ?? join(paths.home, 'cli');
  const units = new Map<string, DevinUnit>();
  const touch = (id: string) => {
    const u = units.get(id) ?? { id, sizeBytes: 0, createdAt: 0, modifiedAt: 0, hasDb: false, paths: [] };
    units.set(id, u);
    return u;
  };

  const dbPath = join(cli, 'sessions.db');
  if (existsSync(dbPath)) {
    let db: Database | null = null;
    try {
      db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
    } catch {
      db = null; // DB 被占用：fs 产物仍可列出。
    }
    if (db) {
      try {
        const rows = db
          .query('SELECT id, title, working_directory, created_at, last_activity_at FROM sessions')
          .all() as Array<{
          id: string;
          title: string | null;
          working_directory: string | null;
          created_at: number;
          last_activity_at: number;
        }>;
        // 内容字节估算：message_nodes 的 chat_message+metadata 是会话体量大头。
        const nodeSize = new Map<string, number>();
        const toolSize = new Map<string, number>();
        try {
          for (const r of db
            .query('SELECT session_id sid, SUM(LENGTH(chat_message) + LENGTH(COALESCE(metadata, \'\'))) s FROM message_nodes GROUP BY session_id')
            .all() as Array<{ sid: string; s: number | null }>) {
            nodeSize.set(r.sid, r.s ?? 0);
          }
          for (const r of db
            .query('SELECT session_id sid, SUM(LENGTH(tool_call_json) + LENGTH(COALESCE(tool_call_update_json, \'\'))) s FROM tool_call_state GROUP BY session_id')
            .all() as Array<{ sid: string; s: number | null }>) {
            toolSize.set(r.sid, r.s ?? 0);
          }
        } catch {
          // 列名漂移时大小按 0 估。
        }
        for (const r of rows) {
          const u = touch(r.id);
          u.hasDb = true;
          u.title = r.title || u.title;
          u.project = r.working_directory || u.project;
          u.sizeBytes += (nodeSize.get(r.id) ?? 0) + (toolSize.get(r.id) ?? 0);
          u.createdAt = toMs(r.created_at) || u.createdAt;
          u.modifiedAt = Math.max(u.modifiedAt, toMs(r.last_activity_at));
        }
      } finally {
        db.close();
      }
    }
  }

  // 同名文件产物：transcripts/<slug>.json（回放流水，可独立成会话条目）+
  // session_locks/<slug>.lock（PID 锁，陈旧极多——只挂到已有会话单元，孤锁不成行）。
  for (const [sub, suffix, orphan] of [
    ['transcripts', '.json', true],
    ['session_locks', '.lock', false],
  ] as const) {
    const dir = join(cli, sub);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(suffix)) continue;
        const id = name.slice(0, -suffix.length);
        const p = join(dir, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (!st?.isFile()) continue;
        if (!orphan && !units.has(id)) continue;
        const u = touch(id);
        u.paths.push(p);
        u.sizeBytes += st.size;
        u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
        const born = Math.round(st.birthtimeMs);
        if (!u.createdAt || born < u.createdAt) u.createdAt = born;
      }
    } catch {
      // 目录并发改写跳过该子树。
    }
  }
  return units;
}

/** 盘点全部会话（db 行 + 同名文件归并；纯文件残留也单列）。 */
export async function scanDevinSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const u of collectUnits().values()) {
    out.push({
      agent: 'devin',
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

/** 删除会话：文件产物进废纸篓 + sessions/作用域表行事务删。 */
export async function deleteDevinSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const paths = agentPaths('devin');
  const dbPath = join(paths.sessions ?? join(paths.home, 'cli'), 'sessions.db');
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u) return { agent: 'devin' as const, id, ok: false, freedBytes: 0, error: '会话不存在' };
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    let needsVacuum = false;
    if (u.hasDb && existsSync(dbPath)) {
      try {
        const db = new Database(dbPath);
        try {
          db.exec('PRAGMA foreign_keys=ON');
          db.transaction(() => {
            db.run('DELETE FROM sessions WHERE id = ?', [id]);
            // 表缺失的 schema 版本差异逐表容错，不拖垮整个事务。
            for (const t of SESSION_SCOPED) {
              try {
                db.run(`DELETE FROM ${t} WHERE session_id = ?`, [id]);
              } catch {
                // 残行无害，跳过。
              }
            }
          })();
          needsVacuum = true;
        } finally {
          db.close();
        }
      } catch (e) {
        ok = false;
        return {
          agent: 'devin' as const,
          id,
          ok,
          freedBytes: 0,
          error: `sessions.db 删除失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    return {
      agent: 'devin' as const,
      id,
      ok,
      freedBytes: ok ? u.sizeBytes : 0,
      needsVacuum,
      error: ok ? undefined : '部分产物删除失败',
    };
  });
}
