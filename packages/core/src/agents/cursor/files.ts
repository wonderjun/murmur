/**
 * cursor 会话产物盘点与删除。
 *
 * 两类产物：
 *   projects/<slug>/agent-transcripts/ 下 <uuid>.jsonl（+<uuid>/ 子代理目录）——
 *     IDE/CLI 对话转录，行内无时间戳，标题取首条 user 行；
 *   chats/<md5>/<uuid>/ 目录——cursor-agent CLI 会话（meta.json + blobs），
 *     md5 不可逆推工作区，项目栏空。
 * 删除整组路径进废纸篓（子代理文件归并父会话一起删）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import { readJsonFile } from '../../quota/common';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize, readHead } from '../base';

/** transcript 路径 → 会话归属：subagents/ 下的文件归并到父会话 uuid。 */
export function transcriptMeta(path: string): { sessionId: string; slug?: string; isSubagent: boolean } {
  const parts = path.split('/');
  const uuid = (parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '');
  const i = parts.lastIndexOf('agent-transcripts');
  const slug = i > 0 ? parts[i - 1] : undefined;
  const s = parts.lastIndexOf('subagents');
  if (s > 0 && i > 0 && s > i) return { sessionId: parts[s - 1] ?? uuid, slug, isSubagent: true };
  return { sessionId: uuid, slug, isSubagent: false };
}

const slugCache = new Map<string, string | undefined>();

/**
 * projects 目录名是工作区绝对路径把 '/' 换成 '-'（如 Users-chen-Documents-flow）。
 * 逐段贪心最长匹配真实目录还原（目录名本身含 '-' 的歧义靠 existsSync 裁决），
 * 还原不出宁可不填 cwd。
 */
export function slugToPath(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  if (slugCache.has(slug)) return slugCache.get(slug);
  const segs = slug.split('-');
  let path = '';
  let i = 0;
  while (i < segs.length) {
    let hit = '';
    for (let j = segs.length; j > i; j--) {
      const cand = segs.slice(i, j).join('-');
      if (existsSync(join(path || '/', cand))) {
        hit = cand;
        break;
      }
    }
    if (!hit) break;
    path = join(path || '/', hit);
    i += hit.split('-').length;
  }
  const resolved = i === segs.length && path ? path : undefined;
  slugCache.set(slug, resolved);
  return resolved;
}

/** 首个 user 行 → 会话标题：优先 <user_query> 包裹文本，退化为首个 text 块。 */
export function titleFromUserLine(obj: Record<string, unknown>): string | undefined {
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
  const text = content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
  const inner = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)?.[1] ?? text;
  const t = inner.trim().replace(/\s+/g, ' ').slice(0, 80);
  return t || undefined;
}

/** 收集 projects 下全部 agent-transcripts jsonl（<uuid>.jsonl 与 <uuid>/<uuid>.jsonl、subagents/ 都收）。 */
export function listTranscripts(projectsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const proj of readdirSync(projectsDir)) {
    walk(join(projectsDir, proj, 'agent-transcripts'), 0);
  }
  return out;
}

/** 主文件头部找首条 user 行取标题（读头 256KB 足够盖过开场行）。 */
function transcriptTitle(path: string): string | undefined {
  const head = readHead(path, 256 * 1024);
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.role === 'user') return titleFromUserLine(obj);
    } catch {
      // 头部半行/坏行：继续看下一条。
    }
  }
  return undefined;
}

/** 会话产物单元：transcripts 按 sessionId 归并（主文件 + subagents 目录），chats 每目录一单元。 */
function collectUnits(): Map<string, { paths: string[]; slug?: string; title?: string; createdAt: number; modifiedAt: number }> {
  const paths = agentPaths('cursor');
  const units = new Map<string, { paths: string[]; slug?: string; title?: string; createdAt: number; modifiedAt: number }>();
  const touch = (id: string) => units.get(id) ?? { paths: [], createdAt: 0, modifiedAt: 0 };

  // agent-transcripts：jsonl 归并到 sessionId；<uuid>/ 目录（含 subagents/）整体带上。
  if (paths.sessions && existsSync(paths.sessions)) {
    for (const proj of readdirSync(paths.sessions)) {
      const troot = join(paths.sessions, proj, 'agent-transcripts');
      if (!existsSync(troot)) continue;
      for (const name of readdirSync(troot)) {
        const p = join(troot, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (!st) continue;
        const uuid = name.replace(/\.jsonl$/, '');
        if (st.isDirectory()) {
          const u = touch(uuid);
          u.paths.push(p);
          u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
          const born = Math.round(st.birthtimeMs);
          if (!u.createdAt || born < u.createdAt) u.createdAt = born;
          units.set(uuid, u);
        } else if (name.endsWith('.jsonl')) {
          const meta = transcriptMeta(p);
          const u = touch(meta.sessionId);
          u.paths.push(p);
          u.slug ??= meta.slug;
          // 标题只取主会话文件的首 user 行，子代理委派 prompt 不配当标题。
          if (!u.title && !meta.isSubagent) u.title = transcriptTitle(p);
          u.modifiedAt = Math.max(u.modifiedAt, Math.round(st.mtimeMs));
          const born = Math.round(st.birthtimeMs);
          if (!u.createdAt || born < u.createdAt) u.createdAt = born;
          units.set(meta.sessionId, u);
        }
      }
      // subagents 目录里的文件已在上面按父 uuid 归并——这层 walk 兜底非标准嵌套。
      for (const f of listTranscripts(join(paths.sessions, proj))) {
        const meta = transcriptMeta(f);
        const u = units.get(meta.sessionId);
        if (u && !u.paths.includes(f)) {
          const st = statSync(f, { throwIfNoEntry: false });
          u.paths.push(f);
          u.modifiedAt = Math.max(u.modifiedAt, Math.round(st?.mtimeMs ?? 0));
        }
      }
    }
  }

  // chats/<md5>/<uuid>/：CLI 会话目录，meta.json 给标题与时间。
  const chatsDir = join(paths.home, 'chats');
  if (existsSync(chatsDir)) {
    try {
      for (const ws of readdirSync(chatsDir)) {
        const wsPath = join(chatsDir, ws);
        if (!statSync(wsPath, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const sess of readdirSync(wsPath)) {
          const dir = join(wsPath, sess);
          const st = statSync(dir, { throwIfNoEntry: false });
          if (!st?.isDirectory()) continue;
          const meta = readJsonFile(join(dir, 'meta.json')) ?? {};
          const u = touch(`chat:${sess}`);
          u.paths.push(dir);
          u.title = typeof meta.title === 'string' && meta.title ? meta.title : u.title;
          u.createdAt = Number(meta.createdAtMs ?? 0) || Math.round(st.birthtimeMs);
          u.modifiedAt = Number(meta.updatedAtMs ?? 0) || Math.round(st.mtimeMs);
          units.set(`chat:${sess}`, u);
        }
      }
    } catch {
      // chats 目录被并发改写时跳过这部分。
    }
  }
  return units;
}

/** 盘点全部会话产物（transcript 组 + CLI 会话目录）。 */
export async function scanCursorSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const [id, u] of collectUnits()) {
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    out.push({
      agent: 'cursor',
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

/** 删除会话产物组（整组路径进废纸篓）。 */
export async function deleteCursorSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const units = collectUnits();
  return ids.map((id) => {
    const u = units.get(id);
    if (!u || !u.paths.length) return { agent: 'cursor' as const, id, ok: false, freedBytes: 0, error: '会话产物不存在' };
    const size = u.paths.reduce((s, p) => s + dirSize(p), 0);
    let ok = true;
    for (const p of u.paths) {
      if (existsSync(p) && !trash(p)) ok = false;
    }
    return { agent: 'cursor' as const, id, ok, freedBytes: ok ? size : 0, error: ok ? undefined : '部分产物移入废纸篓失败' };
  });
}
