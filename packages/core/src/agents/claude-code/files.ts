/**
 * claude-code 会话产物盘点与删除（清理页数据源）。
 *
 * 产物全集（同一 sessionId 归并成一行，sessionId 是 uuid）：
 *   projects/<slug>/<uuid>.jsonl              主 transcript
 *   projects/<slug>/<uuid>.orphaned-*.jsonl   分叉出的孤儿转录（同会话前缀归并）
 *   projects/<slug>/<uuid>.jsonl.superseded-* 被 supersede 的旧转录
 *   projects/<slug>/<uuid>/                   subagents/、tool-results/ 会话目录
 *   file-history/<uuid>*                      会话级文件历史快照
 *   tasks/<uuid>/                             会话任务目录
 *   session-env/<uuid>*                       会话环境
 *   todos/<uuid>*                             旧版会话待办
 *   debug/<uuid>*                             会话调试日志
 * projects/<slug>/memory/ 是项目级 auto memory——不是会话产物，不盘点不删；
 * ~/.claude.json（全局配置/历史）同理不碰。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize, readHead, slugToPath } from '../base';

/** 会话 id 都是 uuid；文件名/目录名允许带 .orphaned-*、.superseded-* 等后缀。 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 文件名 → sessionId：取首个 uuid 段（orphaned/superseded 变体归并同会话）；取不到返回 null。 */
function sessionIdOf(name: string): string | null {
  const m = UUID_RE.exec(name);
  return m ? m[0].toLowerCase() : null;
}

/** transcript 头部取标题：summary 行优先，退化为首条真实 user 文本（读头 256KB）。 */
function transcriptTitle(path: string): string | undefined {
  const head = readHead(path, 256 * 1024);
  let userText: string | undefined;
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === 'summary' || obj.type === 'ai-title' || obj.type === 'custom-title') {
        const title = obj.summary ?? obj.aiTitle ?? obj.title;
        if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 80);
      } else if (obj.type === 'user' && userText === undefined && obj.isSidechain !== true && obj.isMeta !== true) {
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

/** 会话产物单元收集：projects 主转录/变体/会话目录 + file-history/tasks/session-env/todos/debug 旁路目录。 */
function collectUnits(): Map<string, Unit> {
  const paths = agentPaths('claude-code');
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
          if (st.isDirectory()) {
            // <uuid>/ 会话目录归并进同名会话；memory/ 是项目级产物不碰。
            if (name === 'memory') continue;
            const id = sessionIdOf(name);
            if (id) addPath(id, p, slug);
            continue;
          }
          if (!name.endsWith('.jsonl') && !name.includes('.jsonl.')) continue;
          const id = sessionIdOf(name);
          if (!id) continue;
          addPath(id, p, slug);
          const u = units.get(id)!;
          // 标题只取主转录（<uuid>.jsonl）；orphaned/superseded 变体不覆盖。
          if (!u.title && name === `${id}.jsonl`) u.title = transcriptTitle(p);
        }
      }
    } catch {
      // projects 目录被并发改写时按已扫到的部分算。
    }
  }

  // 旁路产物目录：条目名含会话 uuid 即归并（目录或散文件同规）。
  for (const sub of ['file-history', 'tasks', 'session-env', 'todos', 'debug'] as const) {
    const root = join(paths.home, sub);
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root)) {
        const id = sessionIdOf(name);
        if (!id) continue;
        const p = join(root, name);
        if (statSync(p, { throwIfNoEntry: false })) addPath(id, p);
      }
    } catch {
      // 同上：并发改写按部分算。
    }
  }
  return units;
}

/** 盘点全部会话产物（转录 + 变体 + 会话目录 + 旁路目录归并到同一 sessionId）。 */
export async function scanClaudeSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const [id, u] of collectUnits()) {
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    out.push({
      agent: 'claude-code',
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

/** 删除会话产物组（整组路径进废纸篓；settings.json/~/.claude.json 不动）。 */
export async function deleteClaudeSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u || !u.paths.length) return { agent: 'claude-code' as const, id, ok: false, freedBytes: 0, error: '会话产物不存在' };
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    return { agent: 'claude-code' as const, id, ok, freedBytes: ok ? size : 0, error: ok ? undefined : '部分产物移入废纸篓失败' };
  });
}
