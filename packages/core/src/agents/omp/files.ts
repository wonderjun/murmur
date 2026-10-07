/**
 * omp 会话产物盘点与删除（清理页数据源）+ 会话文件路径助手。
 *
 * 产物全集（同一 sessionId 归并成一行）：
 *   sessions/<slug>/<ts>_<uuid>.jsonl   主会话 journal
 *   sessions/<slug>/<ts>_<uuid>/        subagent 转录目录（整目录随父进废纸篓）
 * 命名 profile（<root>/profiles/<name>/agent/sessions/）一并枚举。
 * 孤儿 subagent 目录（父 jsonl 已删）以目录名 uuid 自立单元，仍可清走。
 * agent.db/history.db 等库行不动——omp 本体在写。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { clip, dirSize, readHead } from '../base';

/** omp agent 目录全集：默认 <root>/agent 在前，命名 profile <root>/profiles/<name>/agent 随后（去重）。 */
export function ompAgentDirs(): string[] {
  const paths = agentPaths('omp');
  const dirs = [join(paths.sessions ?? join(paths.home, 'agent', 'sessions'), '..')];
  try {
    const profiles = join(paths.home, 'profiles');
    if (existsSync(profiles)) {
      for (const name of readdirSync(profiles)) {
        const d = join(profiles, name, 'agent');
        if (statSync(d, { throwIfNoEntry: false })?.isDirectory()) dirs.push(d);
      }
    }
  } catch {
    // profiles 目录并发改写按已知部分算。
  }
  return [...new Set(dirs)];
}

/** 全部 agent 目录下的 sessions 根（存在的才返回）。 */
export function ompSessionRoots(): string[] {
  return ompAgentDirs()
    .map((d) => join(d, 'sessions'))
    .filter((d) => existsSync(d));
}

/**
 * 会话文件 → sessionId：文件名/父目录名是 <ts>_<uuid> 形，取 '_' 尾段 uuid；
 * <slug>/<parentStem>/<name>.jsonl 的 subagent 转录归并父会话 id。
 * id 以文件系统位置为准——subagent 文件内 session 头带的是它自己的 id。
 */
export function sessionFileId(sessionsRoot: string, path: string): string {
  const rel = path.slice(sessionsRoot.length + 1);
  const parts = rel.split('/');
  const stem = (parts.length >= 3 ? parts[1] : parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '');
  const i = stem.lastIndexOf('_');
  return (i >= 0 ? stem.slice(i + 1) : stem) || 'unknown';
}

/** 该文件是否 subagent 转录（位于 <slug>/<parentStem>/ 子目录下）。 */
export function isSubagentFile(sessionsRoot: string, path: string): boolean {
  return path.slice(sessionsRoot.length + 1).split('/').length >= 3;
}

/** 文件名/目录名里的时间戳前缀 <ts>_<uuid> → ms epoch；解析不出返回 0（回填语义兜底）。 */
export function fileTimestamp(path: string): number {
  const base = (path.split('/').pop() ?? '').replace(/\.jsonl$/, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(base);
  if (!m) return 0;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`) || 0;
}

/** sessions 目录递归收集 *.jsonl（slug 一层 + subagent 目录层，深度封顶防跑偏）。 */
export function listSessionFiles(sessionsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(sessionsRoot, 0);
  return out;
}

interface Unit {
  paths: string[];
  title?: string;
  project?: string;
  createdAt: number;
  modifiedAt: number;
}

/** journal 头部取标题/工作区/创建时间：title 记录 → session 头 → 首条 user 文本。 */
function sessionMeta(path: string): { title?: string; project?: string; createdAt?: number } {
  const head = readHead(path, 96 * 1024);
  let title: string | undefined;
  let project: string | undefined;
  let createdAt: number | undefined;
  let userText: string | undefined;
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === 'title' || obj.type === 'title_change') {
        const v = obj.title;
        if (typeof v === 'string' && v.trim()) title ??= v.trim().slice(0, 80);
      } else if (obj.type === 'session') {
        if (typeof obj.cwd === 'string' && obj.cwd) project ??= obj.cwd;
        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : 0;
        if (ts) createdAt ??= ts;
        const v = obj.title;
        if (typeof v === 'string' && v.trim()) title ??= v.trim().slice(0, 80);
      } else if (obj.type === 'message' && userText === undefined) {
        const m = (obj.message ?? {}) as Record<string, unknown>;
        if (m.role === 'user') {
          const c = m.content;
          userText =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? (c as Array<Record<string, unknown>>)
                    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
                    .map((b) => b.text as string)
                    .join('\n')
                : '';
        }
      }
    } catch {
      // 头部半行/坏行：继续看下一条。
    }
    if (title && project) break;
  }
  return { title: title ?? clip(userText?.replace(/\s+/g, ' '), 80), project, createdAt };
}

/** 会话产物单元收集：主 journal + subagent 目录归并同一 sessionId（跨 profile 同 id 也并）。 */
function collectUnits(): Map<string, Unit> {
  const units = new Map<string, Unit>();
  const addPath = (id: string, p: string, isFile: boolean) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    const u = units.get(id) ?? { paths: [], createdAt: 0, modifiedAt: 0 };
    u.paths.push(p);
    u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
    const born = Math.round(st.birthtimeMs);
    if (!u.createdAt || born < u.createdAt) u.createdAt = born;
    if (isFile && !u.title) {
      const meta = sessionMeta(p);
      u.title = meta.title;
      u.project ??= meta.project;
      if (meta.createdAt) u.createdAt = meta.createdAt;
    }
    units.set(id, u);
  };

  for (const root of ompSessionRoots()) {
    let slugs: string[];
    try {
      slugs = readdirSync(root);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const sdir = join(root, slug);
      if (!statSync(sdir, { throwIfNoEntry: false })?.isDirectory()) continue;
      let names: string[];
      try {
        names = readdirSync(sdir);
      } catch {
        continue;
      }
      for (const name of names) {
        const p = join(sdir, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (!st) continue;
        if (name.endsWith('.jsonl') && st.isFile()) {
          // 主会话 journal：id = 文件名 uuid 尾段。
          addPath(sessionFileId(root, p), p, true);
        } else if (st.isDirectory()) {
          // <ts>_<uuid>/ subagent 目录：归并进父会话（目录名即父 stem）。
          const stem = name;
          const i = stem.lastIndexOf('_');
          const id = (i >= 0 ? stem.slice(i + 1) : stem) || 'unknown';
          addPath(id, p, false);
        }
      }
    }
  }
  return units;
}

/** 盘点全部会话产物（journal + subagent 目录归并到同一 sessionId）。 */
export async function scanOmpSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const [id, u] of collectUnits()) {
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    out.push({
      agent: 'omp',
      id,
      title: u.title,
      project: u.project,
      sizeBytes: size,
      createdAt: u.createdAt,
      modifiedAt: u.modifiedAt,
      kind: u.paths.length > 1 || u.paths.some((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory()) ? 'dir' : 'file',
      active: false,
      paths: u.paths,
    });
  }
  return out;
}

/** 删除会话产物组（整组路径进废纸篓；agent.db 行不动——omp 本体在写）。 */
export async function deleteOmpSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u || !u.paths.length) return { agent: 'omp' as const, id, ok: false, freedBytes: 0, error: '会话产物不存在' };
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    return { agent: 'omp' as const, id, ok, freedBytes: ok ? size : 0, error: ok ? undefined : '部分产物移入废纸篓失败' };
  });
}
