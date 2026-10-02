/**
 * codex 会话产物盘点与删除：sessions/YYYY/MM/DD/rollout-*.jsonl 单文件即一个会话。
 *
 * 会话 id = 文件名尾段 uuid（与 session_meta.id 一致，push/pull 同口径）；
 * 项目取自文件首行 session_meta 的 cwd；创建时间优先文件名里的
 * rollout-YYYY-MM-DDTHH-mm-ss 前缀，回落 stat birthtime。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../../paths';
import type { SessionDeleteResult, StoredSession } from '../../types';
import { dirSize, pick, readHead } from '../base';

/** sessions 目录下全部 rollout-*.jsonl（日期分桶目录，递归限深 4）。 */
export function listRollouts(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 4 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) out.push(...listRollouts(p, depth + 1));
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** rollout 文件名尾段 uuid == session_meta.id，push/pull 两平面会话身份靠它对齐。 */
export const ROLLOUT_UUID_RE = /rollout-[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** 文件名时间戳前缀 rollout-2025-09-14T15-00-44-* → ms epoch。 */
const ROLLOUT_DATE_RE = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;

function rolloutCreatedAt(path: string, birthtimeMs: number): number {
  const m = ROLLOUT_DATE_RE.exec(path);
  if (!m) return Math.round(birthtimeMs);
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) || Math.round(birthtimeMs);
}

/** 文件首行 session_meta → cwd（只读头 16KB，不物化全文件）。 */
function rolloutCwd(path: string): string | undefined {
  const head = readHead(path);
  const line = head.split('\n', 1)[0] ?? '';
  try {
    const obj = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
    if (obj.type !== 'session_meta') return undefined;
    return pick(obj.payload ?? {}, 'cwd');
  } catch {
    return undefined;
  }
}

/** 盘点全部 rollout 文件。 */
export async function scanCodexSessions(): Promise<StoredSession[]> {
  const dir = agentPaths('codex').sessions;
  const out: StoredSession[] = [];
  if (!dir || !existsSync(dir)) return out;
  for (const f of listRollouts(dir)) {
    const st = statSync(f, { throwIfNoEntry: false });
    if (!st) continue;
    out.push({
      agent: 'codex',
      id: ROLLOUT_UUID_RE.exec(f)?.[1] ?? f.split('/').pop()!.replace('.jsonl', ''),
      project: rolloutCwd(f),
      sizeBytes: st.size,
      createdAt: rolloutCreatedAt(f, st.birthtimeMs),
      modifiedAt: Math.round(st.mtimeMs),
      kind: 'file',
      active: false,
      paths: [f],
    });
  }
  return out;
}

/** 删除 rollout 文件（进废纸篓）；id→路径删除时重扫解析。 */
export async function deleteCodexSessions(
  ids: string[],
  trash: (path: string) => boolean,
): Promise<SessionDeleteResult[]> {
  const dir = agentPaths('codex').sessions;
  const byId = new Map<string, string>();
  if (dir && existsSync(dir)) {
    for (const f of listRollouts(dir)) {
      byId.set(ROLLOUT_UUID_RE.exec(f)?.[1] ?? f.split('/').pop()!.replace('.jsonl', ''), f);
    }
  }
  return ids.map((id) => {
    const f = byId.get(id);
    if (!f || !existsSync(f)) return { agent: 'codex' as const, id, ok: false, freedBytes: 0, error: '会话文件不存在' };
    const size = dirSize(f);
    const ok = trash(f);
    return { agent: 'codex' as const, id, ok, freedBytes: ok ? size : 0, error: ok ? undefined : '移入废纸篓失败' };
  });
}
