/**
 * zcode 会话产物盘点与删除。会话 id = sess_*，散布在四处：
 *   cli/db/db.sqlite   session/message/part 等表（转录本体，体量最大）
 *   v2/tasks-index.sqlite  tasks 行（任务列表，deleted 软删语义）
 *   cli/agents/<sess>/ + cli/artifacts/<sess>/   会话工作目录
 *   cli/rollout/model-io-<sess>.jsonl            模型调用流水
 *
 * 删除语义混合：fs 产物进废纸篓，库内行永久删（message/part 有 FK 级联，
 * 其余 session_id 表 best-effort 清；tasks 行用应用同款 deleted=1 软删）。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize } from '../base';

/** db.sqlite 里按 session_id 清理的会话作用域表（dwf_/workflow_ 引擎簿记不动）。 */
const SESSION_TABLES = [
  'message',
  'part',
  'todo',
  'session_entry',
  'session_input',
  'session_target',
  'session_task_link',
  'model_usage',
  'turn_usage',
  'tool_usage',
  'input_history',
];

/** rollout 文件名 → sess id（主会话与子代理 sess_subagent_agent_* 同形）。 */
const ROLLOUT_SESS_RE = /model-io-(sess_[\w-]+)\.jsonl$/;

/** 内部会话单元：id → 元数据 + 待删路径 + 库内行标记。 */
interface ZcodeUnit {
  id: string;
  title?: string;
  project?: string;
  sizeBytes: number;
  createdAt: number;
  modifiedAt: number;
  hasDb: boolean;
  paths: string[];
}

function touch(map: Map<string, ZcodeUnit>, id: string): ZcodeUnit {
  const u = map.get(id) ?? { id, sizeBytes: 0, createdAt: 0, modifiedAt: 0, hasDb: false, paths: [] };
  map.set(id, u);
  return u;
}

/** 汇总三处数据源：db.sqlite 会话行（本体）+ tasks-index（项目/软删态）+ fs 产物。 */
function collectUnits(): Map<string, ZcodeUnit> {
  const paths = agentPaths('zcode');
  const units = new Map<string, ZcodeUnit>();
  const dbPath = join(paths.home, 'cli', 'db', 'db.sqlite');
  const tasksDb = join(paths.sessions ?? paths.home, 'tasks-index.sqlite');

  // cli/db/db.sqlite：session 表是会话本体（opencode 系同构 schema）。
  if (existsSync(dbPath)) {
    try {
      const db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
      try {
        const rows = db
          .query('SELECT id, title, directory, time_created, time_updated FROM session')
          .all() as Array<{ id: string; title: string | null; directory: string | null; time_created: number; time_updated: number }>;
        const sizeOf = (table: string) => {
          const m = new Map<string, number>();
          try {
            for (const r of db.query(`SELECT session_id sid, SUM(LENGTH(data)) s FROM ${table} GROUP BY session_id`).all() as Array<{
              sid: string;
              s: number | null;
            }>) {
              m.set(r.sid, r.s ?? 0);
            }
          } catch {
            // 表结构漂移时该项大小按 0。
          }
          return m;
        };
        const partSize = sizeOf('part');
        const msgSize = sizeOf('message');
        for (const r of rows) {
          const u = touch(units, r.id);
          u.hasDb = true;
          u.title = r.title || u.title;
          u.project = r.directory || u.project;
          u.sizeBytes += (partSize.get(r.id) ?? 0) + (msgSize.get(r.id) ?? 0);
          u.createdAt = r.time_created || u.createdAt;
          u.modifiedAt = Math.max(u.modifiedAt, r.time_updated || 0);
        }
      } finally {
        db.close();
      }
    } catch {
      // DB 被占用时本会话本体缺席——fs 产物仍会列出。
    }
  }

  // tasks-index：任务列表行（项目归属兜底 + 软删标记录入点）。
  if (existsSync(tasksDb)) {
    try {
      const db = new Database(`file:${tasksDb}?mode=ro`, { readonly: true });
      try {
        const rows = db
          .query('SELECT task_id, title, workspace_path, created_at, updated_at FROM tasks WHERE deleted=0')
          .all() as Array<{ task_id: string; title: string | null; workspace_path: string | null; created_at: number; updated_at: number }>;
        for (const r of rows) {
          const u = touch(units, r.task_id);
          u.hasDb = true; // tasks 行同样要删（软删），删除语义按 db 计。
          u.title ||= r.title || undefined;
          u.project ||= r.workspace_path || undefined;
          if (!u.createdAt) u.createdAt = r.created_at || 0;
          if (!u.modifiedAt) u.modifiedAt = r.updated_at || 0;
        }
      } finally {
        db.close();
      }
    } catch {
      // 同上：被占用则跳过该源。
    }
  }

  // fs 产物：cli/agents + cli/artifacts 的 sess_* 目录 + rollout jsonl。
  const attachPath = (id: string, p: string, st: { mtimeMs: number; birthtimeMs: number }) => {
    const u = touch(units, id);
    u.paths.push(p);
    u.sizeBytes += dirSize(p);
    u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
    const born = Math.round(st.birthtimeMs);
    if (!u.createdAt || born < u.createdAt) u.createdAt = born;
  };
  for (const sub of ['agents', 'artifacts']) {
    const dir = join(paths.home, 'cli', sub);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('sess_')) continue;
        const p = join(dir, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory()) attachPath(name, p, st);
      }
    } catch {
      // 目录并发改写跳过该子树。
    }
  }
  const rolloutDir = join(paths.home, 'cli', 'rollout');
  if (existsSync(rolloutDir)) {
    try {
      for (const name of readdirSync(rolloutDir)) {
        const m = ROLLOUT_SESS_RE.exec(name);
        if (!m) continue;
        const p = join(rolloutDir, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isFile()) attachPath(m[1], p, st);
      }
    } catch {
      // 同上。
    }
  }
  return units;
}

/** 盘点全部会话（sess_* 聚合三处来源；库内会话 kind=db 标记永久删语义）。 */
export async function scanZcodeSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const u of collectUnits().values()) {
    out.push({
      agent: 'zcode',
      id: u.id,
      title: u.title,
      project: u.project,
      sizeBytes: u.sizeBytes,
      createdAt: u.createdAt,
      modifiedAt: u.modifiedAt,
      kind: u.hasDb ? 'db' : u.paths.some((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory()) ? 'dir' : 'file',
      active: false,
      paths: u.paths,
    });
  }
  return out;
}

/** 删库内行：db.sqlite 事务删 session + session_id 表；tasks-index 走应用同款软删。 */
function deleteDbRows(id: string): { deleted: boolean; error?: string } {
  const paths = agentPaths('zcode');
  const dbPath = join(paths.home, 'cli', 'db', 'db.sqlite');
  const tasksDb = join(paths.sessions ?? paths.home, 'tasks-index.sqlite');
  let deleted = false;
  let error: string | undefined;
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      try {
        db.exec('PRAGMA foreign_keys=ON');
        db.transaction(() => {
          db.run('DELETE FROM session WHERE id = ?', [id]);
          // FK 级联只覆盖声明了约束的表（message/part），其余 session_id 表显式清；
          // 表不存在的 schema 漂移逐表容错，不拖垮整个事务。
          for (const t of SESSION_TABLES) {
            try {
              db.run(`DELETE FROM ${t} WHERE session_id = ?`, [id]);
            } catch {
              // 表/列缺失：残行无害，跳过。
            }
          }
        })();
        deleted = true;
      } finally {
        db.close();
      }
    } catch (e) {
      // db.sqlite 失败不拦 tasks-index 的软删——两处各自成败。
      error = `db.sqlite 删除失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (existsSync(tasksDb)) {
    try {
      const db = new Database(tasksDb);
      try {
        // 与应用自身的删除语义一致：deleted=1 软删，任务列表立即消失且留痕。
        db.run('UPDATE tasks SET deleted = 1 WHERE task_id = ?', [id]);
        deleted = true;
      } finally {
        db.close();
      }
    } catch {
      // tasks 软删失败不整体判负——本体行已删，任务行只是列表残影。
    }
  }
  return { deleted, error };
}

/** 删除会话：fs 产物进废纸篓 + 库内行永久删，两段各自计成败。 */
export async function deleteZcodeSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u) return { agent: 'zcode' as const, id, ok: false, freedBytes: 0, error: '会话不存在' };
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    let needsVacuum = false;
    let error: string | undefined;
    if (u.hasDb) {
      const r = deleteDbRows(id);
      needsVacuum = r.deleted;
      if (r.error) {
        ok = false;
        error = r.error;
      }
    }
    if (!ok && !error) error = '部分产物移入废纸篓失败';
    return { agent: 'zcode' as const, id, ok, freedBytes: ok ? u.sizeBytes : 0, needsVacuum, error };
  });
}
