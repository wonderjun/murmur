/**
 * qoder 会话产物盘点与删除（清理页数据源）。
 *
 * 产物全集（同一 sessionId 归并成一行）：
 *   projects/<slug>/<uuid>.jsonl          主 transcript
 *   projects/<slug>/<uuid>/               state.json 等会话态目录
 *   projects/<slug>/transcript/<id>.jsonl 委派任务转录（sessionId 即文件名）
 *   tasks/<uuid>/                         任务清单目录
 *   logs/sessions/<slug>/<uuid>/          会话日志分段
 * main.sqlite（app 台账）的会话行不动——那是 app 本体在写的库，只读不写。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize, readHead } from '../base';

const slugCache = new Map<string, string | undefined>();

/**
 * projects 目录名是工作区绝对路径把 '/' 换成 '-'（如 -Users-chen-Documents-flow）。
 * 逐段贪心最长匹配真实目录还原（目录名本身含 '-' 的歧义靠 existsSync 裁决），
 * 还原不出宁可不填 cwd。
 */
export function slugToPath(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  if (slugCache.has(slug)) return slugCache.get(slug);
  // qoder slug 带前导 '-' 代表根 '/'（如 -Users-chen-x）；剥掉后首段就是根目录。
  const normalized = slug.startsWith('-') ? slug.slice(1) : slug;
  const segs = normalized.split('-');
  let path = '/';
  let i = 0;
  while (i < segs.length) {
    let hit = '';
    for (let j = segs.length; j > i; j--) {
      const cand = segs.slice(i, j).join('-');
      if (existsSync(join(path, cand))) {
        hit = cand;
        break;
      }
    }
    if (!hit) break;
    path = join(path, hit);
    i += hit.split('-').length;
  }
  const resolved = i === segs.length && path ? path : undefined;
  slugCache.set(slug, resolved);
  return resolved;
}

/** 文件名去 .jsonl → sessionId。 */
function sessionIdOf(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.jsonl$/, '');
}

/** transcript 头部取标题：ai-title 行优先，退化为首条真实 user 文本（读头 256KB）。 */
function transcriptTitle(path: string): string | undefined {
  const head = readHead(path, 256 * 1024);
  let userText: string | undefined;
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === 'ai-title') {
        const title = obj.aiTitle ?? obj.title;
        if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 80);
      } else if (obj.type === 'user' && userText === undefined && obj.isSidechain !== true) {
        const msg = obj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (typeof content === 'string') {
          userText = content;
        } else if (Array.isArray(content)) {
          const parts = (content as Array<Record<string, unknown>>)
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string);
          userText = parts.join('\n');
        }
      }
    } catch {
      // 头部半行/坏行：继续看下一条。
    }
  }
  const t = userText?.trim().replace(/\s+/g, ' ').slice(0, 80);
  return t || undefined;
}

interface Unit {
  paths: string[];
  slug?: string;
  title?: string;
  createdAt: number;
  modifiedAt: number;
}

/** 会话产物单元收集：projects 三类 + tasks/ + logs/sessions/ 归并到 sessionId。 */
function collectUnits(): Map<string, Unit> {
  const paths = agentPaths('qoder');
  const units = new Map<string, Unit>();
  const touch = (id: string) => units.get(id) ?? { paths: [], createdAt: 0, modifiedAt: 0 };
  const addPath = (id: string, p: string, slug?: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    const u = touch(id);
    u.paths.push(p);
    u.slug ??= slug;
    u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
    const born = Math.round(st.birthtimeMs);
    if (!u.createdAt || born < u.createdAt) u.createdAt = born;
    units.set(id, u);
  };

  const projects = paths.sessions;
  if (projects && existsSync(projects)) {
    try {
      for (const slug of readdirSync(projects)) {
        const sdir = join(projects, slug);
        if (!statSync(sdir, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const name of readdirSync(sdir)) {
          const p = join(sdir, name);
          const st = statSync(p, { throwIfNoEntry: false });
          if (!st) continue;
          if (name.endsWith('.jsonl')) {
            const id = sessionIdOf(p);
            addPath(id, p, slug);
            const u = units.get(id)!;
            if (!u.title) u.title = transcriptTitle(p);
          } else if (st.isDirectory() && name !== 'transcript' && name !== 'memory') {
            // <uuid>/ 目录（state.json 等）：归并进同名会话。
            addPath(name, p, slug);
          } else if (name === 'transcript' && st.isDirectory()) {
            for (const sub of readdirSync(p)) {
              if (!sub.endsWith('.jsonl')) continue;
              const fp = join(p, sub);
              const id = sessionIdOf(fp);
              addPath(id, fp, slug);
              const u = units.get(id)!;
              if (!u.title) u.title = transcriptTitle(fp);
            }
          }
        }
      }
    } catch {
      // projects 目录被并发改写时按已扫到的部分算。
    }
  }

  // tasks/<uuid>/ 与 logs/sessions/<slug>/<uuid>/ 按目录名归并。
  for (const [root, hasSlug] of [
    [join(paths.home, 'tasks'), false],
    [join(paths.home, 'logs', 'sessions'), true],
  ] as const) {
    if (!existsSync(root)) continue;
    try {
      for (const a of readdirSync(root)) {
        const pa = join(root, a);
        if (!statSync(pa, { throwIfNoEntry: false })?.isDirectory()) continue;
        if (hasSlug) {
          for (const sid of readdirSync(pa)) {
            const ps = join(pa, sid);
            if (statSync(ps, { throwIfNoEntry: false })?.isDirectory()) addPath(sid, ps, a);
          }
        } else {
          addPath(a, pa);
        }
      }
    } catch {
      // 同上：并发改写按部分算。
    }
  }
  return units;
}

/** 盘点全部会话产物（transcript/state/tasks/logs 归并到同一 sessionId）。 */
export async function scanQoderSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const [id, u] of collectUnits()) {
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    out.push({
      agent: 'qoder',
      id,
      title: u.title,
      project: slugToPath(u.slug),
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

/** 删除会话产物组（整组路径进废纸篓；main.sqlite 行不动）。 */
export async function deleteQoderSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u || !u.paths.length) return { agent: 'qoder' as const, id, ok: false, freedBytes: 0, error: '会话产物不存在' };
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    return { agent: 'qoder' as const, id, ok, freedBytes: ok ? size : 0, error: ok ? undefined : '部分产物移入废纸篓失败' };
  });
}
