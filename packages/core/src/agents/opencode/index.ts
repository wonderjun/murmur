/**
 * opencode adapter。
 *
 * push 平面：往 ~/.config/opencode/plugins/ 落一个 ESM 插件，订阅事件总线
 *   （白名单事件）POST 到 ingest——专职实时状态面，usage 事件在此剥离
 *   （否则同一 part.updated 双通道重复记账；kimi 同款分工）。
 * pull 平面：只读 WAL 打开 ~/.local/share/opencode/opencode.db，按 event.rowid
 *   增量轮询——独掌 usage 台账，经 message 表 join 补 modelID（part 无 model
 *   字段，不补则 usage_daily.model 恒空、成本估算失效）。db 缺失的旧版安装
 *   回退 legacy.ts 的 storage/message JSON 扫描。
 * token 口径：只认 message.part.updated 的 part.tokens（逐步增量）；
 *   session.updated/message.updated 的 tokens 是会话累计值，不落账。
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOOK_MARKER } from '../../hooks/script';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { pick, type AgentAdapter } from '../base';
import { deleteOpencodeSessions, scanOpencodeSessions } from './files';
import { watchLegacyJson } from './legacy';

/** opencode 插件源码：事件总线 → POST ingest，失败静默。 */
function renderPlugin(): string {
  return `// ${HOOK_MARKER} — opencode plugin forwarding events to the Murmur ingest server.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadEndpoint() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".murmur", "endpoint"), "utf8");
    const port = /MURMUR_AGENT_HOOK_PORT=(\\d+)/.exec(text)?.[1];
    const token = /MURMUR_AGENT_HOOK_TOKEN=([0-9a-f]+)/.exec(text)?.[1];
    return port && token ? { port, token } : null;
  } catch {
    return null;
  }
}

const WATCHED = /^(session\.|permission\.|message\.updated$|message\.part\.updated$)/;

function shouldForward(event) {
  if (!event || !WATCHED.test(event.type || "")) return false;
  if (event.type === "message.part.updated") {
    const part = (event.properties || {}).part || {};
    // 流式 text/reasoning chunk 量最大且无状态价值——只转 step-finish/tool/带 tokens 的 part。
    return part.type === "step-finish" || part.type === "tool" || part.type === "tool-invocation" || !!part.tokens;
  }
  return true;
}

export default async function murmurPlugin() {
  return {
    event: async ({ event }) => {
      if (!shouldForward(event)) return;
      const ep = loadEndpoint();
      if (!ep) return;
      try {
        await fetch("http://127.0.0.1:" + ep.port + "/hook/opencode", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Murmur-Hook-Token": ep.token },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(1500),
        });
      } catch {}
    },
  };
}
`;
}

const PLUGIN_NAME = 'murmur-status.js';

/** 从 opencode 事件数据里提取真实时间戳（ms）：实体 time.{completed,updated,created} → part.time → properties 根的 event time。全无则返回 0——无法定日期的行按历史处理，绝不伪造成"现在"（否则回放冒出幽灵会话）。 */
function eventAt(props: Record<string, unknown>, info: Record<string, unknown>): number {
  const time = (info.time ?? {}) as Record<string, number>;
  const part = (props.part ?? {}) as Record<string, unknown>;
  const partTime = (part.time ?? {}) as Record<string, number>;
  const cand = [time.completed, time.updated, time.created, partTime.end, partTime.start, props.time];
  for (const c of cand) {
    if (typeof c === 'number' && c > 0) return c;
  }
  return 0;
}

/** 从 session/message 实体取模型名：v1.x 是 {id,providerID,variant} 对象，旧版是 modelID/model 字符串。 */
function modelOf(info: Record<string, unknown>): string | undefined {
  const direct = pick(info, 'modelID') ?? pick(info, 'model');
  if (direct) return direct;
  const m = info.model as Record<string, unknown> | undefined;
  return typeof m?.id === 'string' ? m.id : undefined;
}

/** opencode 事件（plugin 总线或 DB 行）→ 归一化事件。 */
export function translateOpencodeEvent(ev: Record<string, unknown>): AgentEvent[] {
  const type = String(ev.type ?? '');
  const props = (ev.properties ?? ev.data ?? {}) as Record<string, unknown>;
  const info = (props.info ?? props.session ?? {}) as Record<string, unknown>;
  const sessionId =
    pick(props, 'sessionID', 'sessionId') ?? pick(info, 'sessionID', 'id') ?? 'unknown';
  const at = eventAt(props, info);
  const cwd = pick(info, 'directory', 'cwd');
  const base = { agent: 'opencode' as const, sessionId, cwd, at, raw: ev };

  if (type.startsWith('session.status')) {
    // 载荷两形：旧版 status 是裸字符串，v1.x 是 {type:'busy'|'idle'|'retry'} 对象。
    const raw = props.status ?? info.status;
    const status = typeof raw === 'string' ? raw : ((raw ?? {}) as Record<string, unknown>).type;
    if (status === 'busy') return [{ ...base, kind: 'turn.start' }];
    if (status === 'idle') return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    return [{ ...base, kind: 'status' }];
  }
  if (type.startsWith('session.idle')) {
    return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
  }
  if (type.startsWith('permission.')) {
    if (type.endsWith('replied')) return [{ ...base, kind: 'tool.call' }];
    // asked/updated（新权限系统的更新事件）都算「等你批准」；带已决标记的是回复后收尾，降级 status。
    const done =
      (props.response !== undefined && props.response !== null) ||
      ['replied', 'resolved', 'approved', 'denied'].includes(pick(props, 'status', 'state') ?? '');
    return done ? [{ ...base, kind: 'status' }] : [{ ...base, kind: 'permission.request' }];
  }
  if (type.startsWith('session.created')) {
    return [{ ...base, kind: 'session.start', title: pick(info, 'title', 'slug') }];
  }
  if (type.startsWith('session.updated')) {
    // info.tokens 是会话累计值（每行重复上报），不可当增量落账——只借它更新 title/model。
    return [{ ...base, kind: 'status', model: modelOf(info), title: pick(info, 'title', 'slug') }];
  }
  if (type.startsWith('message.updated')) {
    const role = pick(info, 'role');
    const time = (info.time ?? {}) as Record<string, number>;
    if (role === 'user') return [{ ...base, kind: 'turn.start' }];
    if (role === 'assistant' && time.completed) {
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end', model: modelOf(info) }];
    }
    return [{ ...base, kind: 'status' }];
  }
  if (type.startsWith('message.part.updated')) {
    const part = (props.part ?? {}) as Record<string, unknown>;
    // part.tokens 是逐步增量的真实用量（data.time 为事件时间）——台账只认这一路。
    const t = (part.tokens ?? {}) as Record<string, unknown>;
    if (typeof t.total === 'number' && t.total > 0) {
      const cache = (t.cache ?? {}) as Record<string, number>;
      const tokens: TokenUsage = {
        input: (t.input as number) ?? 0,
        output: (t.output as number) ?? 0,
        cacheRead: cache.read ?? 0,
        cacheWrite: cache.write ?? 0,
        reasoning: (t.reasoning as number) ?? 0,
      };
      const usage: AgentEvent = { ...base, kind: 'usage', tokens };
      if (part.type === 'step-finish') {
        return [usage, { ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
      }
      return [usage];
    }
    if (part.type === 'step-finish') return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    if (part.type === 'tool' || part.type === 'tool-invocation') return [{ ...base, kind: 'tool.call' }];
    return [{ ...base, kind: 'status' }];
  }
  return [{ ...base, kind: 'status' }];
}

export function createOpencodeAdapter(): AgentAdapter {
  const paths = agentPaths('opencode');
  const pluginPath = join(paths.hookConfig ?? '', PLUGIN_NAME);
  const dbPath = join(paths.home, 'opencode.db');

  return {
    id: 'opencode',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home);
      return {
        installed,
        hasCredentials: existsSync(paths.credentials ?? ''),
        homeDir: paths.home,
        hookInstalled: existsSync(pluginPath),
        note: installed ? undefined : '未发现 ~/.local/share/opencode',
      };
    },

    async installHooks() {
      const dir = paths.hookConfig;
      if (!dir) return { changed: false };
      if (existsSync(pluginPath)) {
        const cur = require('node:fs').readFileSync(pluginPath, 'utf8') as string;
        // 幂等 + 升级：标记在且含白名单过滤（旧版无 shouldForward，重写升级）。
        if (cur.includes(HOOK_MARKER) && cur.includes('shouldForward')) return { changed: false };
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(pluginPath, renderPlugin());
      return { changed: true };
    },

    async uninstallHooks() {
      // 插件是我们独占的整文件（非合并配置），卸载=删文件。
      if (!existsSync(pluginPath)) return { changed: false };
      try {
        unlinkSync(pluginPath);
      } catch {
        return { changed: false };
      }
      return { changed: true };
    },

    translateHook(payload) {
      if (!payload || typeof payload !== 'object') return [];
      // push 专职实时状态面：usage 剥离给 pull（同一 part.updated 双通道会重复记账）。
      return translateOpencodeEvent(payload as Record<string, unknown>).filter((e) => e.kind !== 'usage');
    },

    async watch(emit, ledger: Ledger) {
      if (!existsSync(dbPath)) {
        // pre-sqlite 旧版回退：扫 storage/message JSON 补用量面（状态面仍靠插件）。
        return watchLegacyJson(paths.home, emit, ledger);
      }
      const db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
      let lastRowid = Number(ledger.getCursor('opencode:event') ?? '0');
      if (!lastRowid) {
        // 首次：从回填窗口起算，不扫全库。种子取 MIN(rowid)-1——poll 用 > 游标，
        // 不 -1 会漏掉窗口内第一行；窗口内无行时取 MAX(rowid)，否则全表扫穿。
        const since = Date.now() - BACKFILL_WINDOW_MS;
        const row = db
          .query("SELECT MIN(rowid) r FROM event WHERE json_extract(data,'$.info.time.updated') >= ? OR rowid > (SELECT MAX(rowid)-50000 FROM event)")
          .get(since) as { r: number | null };
        lastRowid =
          row?.r != null
            ? row.r - 1
            : ((db.query('SELECT MAX(rowid) m FROM event').get() as { m: number | null })?.m ?? 0);
      }

      // messageID → modelID：message.updated 行顺路喂，miss 时回 message 表单条 PK 查。
      const modelCache = new Map<string, string>();
      const modelFor = (messageId: string | undefined): string | undefined => {
        if (!messageId) return undefined;
        const hit = modelCache.get(messageId);
        if (hit) return hit;
        try {
          const row = db
            .query("SELECT json_extract(data,'$.modelID') m FROM message WHERE id = ?")
            .get(messageId) as { m: string | null } | null;
          if (row?.m) {
            modelCache.set(messageId, row.m);
            return row.m;
          }
        } catch {
          // 单行解析失败不阻塞本轮，下条事件再来。
        }
        return undefined;
      };

      const poll = () => {
        try {
          const rows = db
            .query('SELECT rowid, aggregate_id, seq, type, data FROM event WHERE rowid > ? ORDER BY rowid LIMIT 2000')
            .all(lastRowid) as Array<{ rowid: number; type: string; data: string }>;
          for (const row of rows) {
            lastRowid = Math.max(lastRowid, row.rowid);
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse(row.data);
            } catch {}
            const ev = { type: row.type.replace(/\.\d+$/, ''), properties: data };
            const info = (data.info ?? {}) as Record<string, unknown>;
            const infoModel = modelOf(info);
            if (ev.type === 'message.updated' && infoModel) {
              const mid = pick(info, 'id');
              if (mid) modelCache.set(mid, infoModel);
            }
            const events = translateOpencodeEvent(ev);
            for (const e of events) {
              if (e.kind === 'usage' && !e.model) {
                const part = (data.part ?? {}) as Record<string, unknown>;
                e.model = modelFor(pick(part, 'messageID', 'messageId'));
              }
              emit(e);
            }
          }
          if (rows.length) ledger.setCursor('opencode:event', String(lastRowid));
        } catch {
          // DB 被占用/锁定时跳过本轮。
        }
      };

      poll();
      const timer = setInterval(poll, 2000);
      return () => {
        clearInterval(timer);
        db.close();
      };
    },

    scanSessions: scanOpencodeSessions,
    deleteSessions: deleteOpencodeSessions,
  };
}
