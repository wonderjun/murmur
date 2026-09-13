/**
 * opencode legacy JSON 回退（pre-sqlite 旧版，对齐 ccusage 的回退定位）。
 *
 * 迁移到 opencode.db 之前的版本：会话存 storage/session/{proj}/{sid}.json、
 * 消息存 storage/message/{sid}/msg_*.json（assistant 行内含 modelID/tokens）。
 * 仅在 db 缺失时启用：5s 轮询目录，mtime 变了才解析；每条 message 的已入账
 * token 快照存 cursors（opencode:jsonmsg:<id>），发 delta usage——文件增长
 * 只补差、重启不重复。状态面不归这里：旧版同样有插件机制（index.ts）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Ledger } from '../../ledger/db';
import type { AgentEvent, TokenUsage } from '../../types';

/** 扫描周期：回退面只做台账，不需要 event 表的 2s 节奏。 */
const SCAN_INTERVAL_MS = 5000;

interface LegacyMessage {
  id?: string;
  sessionID?: string;
  role?: string;
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; completed?: number };
}

interface LegacySession {
  id?: string;
  title?: string;
  directory?: string;
  time?: { created?: number; updated?: number };
}

function tokensOf(m: LegacyMessage): TokenUsage {
  const t = m.tokens ?? {};
  return {
    input: t.input ?? 0,
    output: t.output ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0,
    reasoning: t.reasoning ?? 0,
  };
}

/** 两次快照的逐字段差（负值归零——token 只增不减，变小说明文件被重建过）。 */
function diffTokens(cur: TokenUsage, prev: TokenUsage | null): TokenUsage {
  const d = (a?: number, b?: number) => Math.max(0, (a ?? 0) - (b ?? 0));
  return {
    input: d(cur.input, prev?.input),
    output: d(cur.output, prev?.output),
    cacheRead: d(cur.cacheRead, prev?.cacheRead),
    cacheWrite: d(cur.cacheWrite, prev?.cacheWrite),
    reasoning: d(cur.reasoning, prev?.reasoning),
  };
}

function hasAny(t: TokenUsage): boolean {
  return t.input + t.output + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.reasoning ?? 0) > 0;
}

/** legacy 目录轮询：opencode.db 不存在时的用量兜底。返回取消函数（与 watch 同约定）。 */
export function watchLegacyJson(
  homeDir: string,
  emit: (e: AgentEvent) => void,
  ledger: Ledger,
): () => void {
  const msgRoot = join(homeDir, 'storage', 'message');
  const sessRoot = join(homeDir, 'storage', 'session');
  // 回退面不启用（无 message 目录）时直接空转，不留定时器。
  if (!existsSync(msgRoot)) return () => {};
  const mtimes = new Map<string, number>();

  /** 两层目录（{sid}/{file}.json），mtime 未变的文件不重读。 */
  const scanDir = async (root: string, onFile: (obj: unknown, parent: string) => void) => {
    let subs;
    try {
      subs = readdirSync(root, { withFileTypes: true });
    } catch {
      return; // 目录不存在即回退面不启用。
    }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name);
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const p = join(dir, f);
        let mtime;
        try {
          mtime = statSync(p).mtimeMs;
        } catch {
          continue;
        }
        if (mtimes.get(p) === mtime) continue;
        mtimes.set(p, mtime);
        let obj: unknown;
        try {
          obj = JSON.parse(await readFile(p, 'utf8'));
        } catch {
          continue; // 半写/坏文件跳过，下轮 mtime 不变前不再重试（已在 mtimes 记录）。
        }
        onFile(obj, d.name);
      }
    }
  };

  const scan = async () => {
    // message 文件：assistant 消息按 msgID 记已入账快照，发 delta usage。
    await scanDir(msgRoot, (obj, sid) => {
      const m = obj as LegacyMessage;
      if (!m.id || !m.tokens || (m.role && m.role !== 'assistant')) return;
      const key = `opencode:jsonmsg:${m.id}`;
      let prev: TokenUsage | null = null;
      try {
        prev = JSON.parse(ledger.getCursor(key) ?? 'null') as TokenUsage | null;
      } catch {
        // 坏游标当从未入账处理，全量补发。
      }
      const cur = tokensOf(m);
      const delta = diffTokens(cur, prev);
      if (!hasAny(delta)) return;
      ledger.setCursor(key, JSON.stringify(cur));
      emit({
        agent: 'opencode',
        sessionId: m.sessionID ?? sid,
        kind: 'usage',
        tokens: delta,
        model: m.modelID,
        at: m.time?.completed ?? m.time?.created ?? 0,
      });
    });
    // session 文件：只发 status 带 title/cwd 元信息（不落库、不迁移状态）。
    await scanDir(sessRoot, (obj) => {
      const s = obj as LegacySession;
      if (!s.id) return;
      emit({
        agent: 'opencode',
        sessionId: s.id,
        kind: 'status',
        title: s.title,
        cwd: s.directory,
        at: s.time?.updated ?? s.time?.created ?? 0,
      });
    });
  };

  let inflight = false;
  const tick = async () => {
    if (inflight) return;
    inflight = true;
    try {
      await scan();
    } finally {
      inflight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), SCAN_INTERVAL_MS);
  return () => clearInterval(timer);
}
