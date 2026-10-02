/**
 * devin adapter（Devin CLI/Desktop，Cognition）。
 *
 * push 平面：merge 进 ~/.config/devin/config.json 的 hooks 键——Claude Code
 *   兼容 matcher-group 形状（{hooks:[{type:command,...}]}），8 个生命周期事件
 *   SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/
 *   Stop/PostCompaction/SessionEnd；stdin payload 带 hook_event_name +
 *   session_id + prompt_id（+cwd）。只覆盖本地 CLI/Desktop 会话——云端会话
 *   的 command hook 跑在云机上，本机收不到。
 * pull 平面：只读轮询 cli/sessions.db（WAL，别人正在写：失败跳过本轮）。
 *   sessions 表出 title/cwd/model/created_at/last_activity_at（秒级 unix）
 *   ——建档 + 「activity 前进→working、连续静默→waiting」启发式（cursor 同款）。
 *   message_nodes 表每条 assistant 消息带请求级
 *   metadata.metrics.{input,output,cache_read,cache_creation}_tokens（实测
 *   6.9w 行有量，input 与 cache_read 互斥口径）——按 rowid 游标增量扫、
 *   逐请求记 token 台账，比 transcripts 的 final_metrics 会话合计粒度细
 *   且覆盖全（transcripts 仅部分会话落盘，不再当源避免双计）。
 *   session_locks/*.lock 是 PID 锁但陈旧极多（本机 897 锁仅 30 活），不作
 *   活性判据。session_id 与 sessions.id(slug) 是否同一口径未实测确认——
 *   不一致时同会话会出两条目（保守并存，以 push 为准）。
 * cloud 平面：BYOK cog_ 凭据存在时每 60s 轮询 v3 sessions（org 端点优先、
 *   enterprise 兜底）补云端会话状态——本地手段够不到云机。凭据从
 *   credentials.json 每轮现读（设置页填了 key 即刻生效，不用重启 watcher）。
 *   组织级列表可能含他人会话——能力所限如实呈现。
 * quota 平面：quota/devin.ts（本机 Connect RPC 配额窗口 + BYOK ACU 消耗）。
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadCredentials } from '../../credentials';
import { devinHooksRegistered, mergeDevinHooks, removeHookScript, unmergeJsonHooks } from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { quotaFetch } from '../../quota/common';
import { fetchDevinQuota, sniffDevinOrgId } from '../../quota/devin';
import type { AgentEvent, InstallInfo, TokenUsage } from '../../types';
import { pick, type AgentAdapter } from '../base';
import { deleteDevinSessions, scanDevinSessions, toMs } from './files';

/** devin hook 全事件（文档生命周期全集，一次挂齐）。 */
const DEVIN_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'PostCompaction',
  'SessionEnd',
];

/** hook stdin payload（Claude 兼容）→ 归一化事件。 */
export function translateDevinHook(payload: unknown): AgentEvent[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const base = {
    agent: 'devin' as const,
    sessionId: pick(p, 'session_id', 'sessionId') ?? 'unknown',
    cwd: pick(p, 'cwd', 'project_dir'),
    at: Date.now(),
    raw: payload,
  };
  switch (String(p.hook_event_name ?? p.event ?? '')) {
    case 'SessionStart':
      return [{ ...base, kind: 'session.start' }];
    case 'UserPromptSubmit': {
      // 用户回车即触发——最早 working 信号；prompt 顺带当会话标题。
      const prompt = pick(p, 'prompt');
      return [{ ...base, kind: 'turn.start', ...(prompt ? { title: prompt.slice(0, 120) } : {}) }];
    }
    case 'PreToolUse':
      return [{ ...base, kind: 'tool.call' }];
    case 'PermissionRequest':
      return [{ ...base, kind: 'permission.request' }];
    case 'Stop':
      // 回合停——「轮到你了」。
      return [{ ...base, kind: 'turn.end', waitingReason: 'turn-end' }];
    case 'SessionEnd':
      return [{ ...base, kind: 'session.end' }];
    default:
      // PostToolUse/PostCompaction/未知事件：心跳防 stale。
      return [{ ...base, kind: 'status' }];
  }
}

/** sessions 行 → 轮询记忆项。 */
interface Seen {
  activity: number;
  working: boolean;
  quiet: number;
}

/** v3 SessionResponse.status/status_detail → 归一化事件 kind。null = 不值得发。 */
function cloudEvent(status: string, detail: string): Pick<AgentEvent, 'kind' | 'status' | 'waitingReason'> | null {
  if (status === 'running' || status === 'resuming') {
    if (detail === 'working' || status === 'resuming') return { kind: 'status', status: 'working' };
    if (detail === 'waiting_for_approval') return { kind: 'permission.request' };
    // running+waiting_for_user/finished：会话还活着、轮到用户 → 「轮到你了」。
    return { kind: 'turn.end', waitingReason: 'turn-end' };
  }
  if (status === 'suspended' || status === 'exit' || status === 'error') return { kind: 'status', status: 'ended' };
  // new/claimed：刚起还没跑起来。
  return { kind: 'status', status: 'idle' };
}

export function createDevinAdapter(): AgentAdapter {
  const paths = agentPaths('devin');
  const dbPath = join(paths.sessions ?? '', 'sessions.db');
  const transcriptsDir = join(paths.sessions ?? '', 'transcripts');

  return {
    id: 'devin',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home) || existsSync(join(paths.hookConfig ?? '', '..'));
      return {
        installed,
        // credentials.toml 的 windsurf_api_key 是 Connect RPC 可用凭据（quota 通道一）。
        hasCredentials: existsSync(paths.credentials ?? ''),
        homeDir: paths.home,
        hookInstalled: devinHooksRegistered(paths.hookConfig),
        supportsByok: true,
        note: installed ? undefined : '未发现 ~/.local/share/devin',
      };
    },

    async installHooks() {
      if (!paths.hookConfig) return { changed: false };
      return mergeDevinHooks(paths.hookConfig, 'devin', DEVIN_HOOK_EVENTS);
    },

    async uninstallHooks() {
      const r = paths.hookConfig ? unmergeJsonHooks(paths.hookConfig) : { changed: false };
      removeHookScript('devin');
      return r;
    },

    translateHook: translateDevinHook,

    async watch(emit, ledger: Ledger) {
      const hasDb = existsSync(dbPath);
      const hasTranscripts = existsSync(transcriptsDir);
      // 本地无数据目录且无 BYOK key（devin 未安装/未登录且未填 key）→ watcher 空挂，
      // 白养两个定时器；BYOK 在手的「无本地」用户仍要云端轮询。
      if (!hasDb && !hasTranscripts && !loadCredentials().devin?.apiKey?.trim()) return () => {};

      // ── 本地会话表轮询（5s）──
      let db: Database | null = null;
      if (hasDb) {
        try {
          db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
        } catch {
          // DB 损坏/被占 → 本地状态面降级，其余通道照常。
          db = null;
        }
      }
      const seen = new Map<string, Seen>();
      /** message_nodes 请求级 token 明细的增量游标（row_id 持久化，防重启双计）。 */
      let mnRowid = Number(ledger.getCursor('devin:mn_rowid') ?? 0) || 0;
      /**
       * fork/revert 会把同一逻辑消息复制成新 node（同 message_id 同指标，
       * 实测 ~69% 明细行是复制）——去重域 (session_id,message_id,指标签名)；
       * 签名不同说明同 id 发生了重推理（真实新消耗，照计）。
       */
      const metricSeen = new Map<string, string>();
      let metricSeeded = false;
      const metricKey = (sid: string, mid: string, i: number, o: number, cr: number, cw: number) =>
        `${sid}${mid}${i}|${o}|${cr}|${cw}`;

      const pollSessions = () => {
        if (!db) return;
        try {
          const rows = db
            .query(
              `SELECT id, working_directory, title, model, created_at, last_activity_at
               FROM sessions WHERE hidden = 0 ORDER BY last_activity_at DESC LIMIT 300`,
            )
            .all() as Array<{
            id: string;
            working_directory: string | null;
            title: string | null;
            model: string | null;
            created_at: number;
            last_activity_at: number;
          }>;
          const cutoff = Date.now() - BACKFILL_WINDOW_MS;
          for (const row of rows) {
            const created = toMs(row.created_at);
            const activity = toMs(row.last_activity_at);
            if (created && created < cutoff && activity < cutoff) continue; // 死档不建。
            const base = {
              agent: 'devin' as const,
              sessionId: row.id,
              cwd: row.working_directory ?? undefined,
              title: row.title ?? undefined,
              model: row.model ?? undefined,
            };
            const st = seen.get(row.id);
            if (!st) {
              emit({ ...base, kind: 'session.start', at: created || activity || Date.now() });
              seen.set(row.id, { activity, working: false, quiet: 0 });
              // 初见即活跃（重启时正在跑的会话）→ 如实报 working。
              if (activity && Date.now() - activity < 90_000) {
                emit({ ...base, kind: 'status', status: 'working', at: activity });
                seen.set(row.id, { activity, working: true, quiet: 0 });
              }
              continue;
            }
            if (activity > st.activity) {
              emit({ ...base, kind: 'status', status: 'working', at: activity });
              seen.set(row.id, { activity, working: true, quiet: 0 });
            } else if (st.working) {
              // 连续静默 ≈10s+ 且刚 working 过 → 大概率在等输入（cursor meta.json 同款启发式）。
              const quiet = st.quiet + 1;
              if (quiet >= 2) {
                emit({ ...base, kind: 'status', status: 'waiting', waitingReason: 'turn-end', at: activity || Date.now() });
                seen.set(row.id, { activity: st.activity, working: false, quiet });
              } else {
                seen.set(row.id, { ...st, quiet });
              }
            }
          }
        } catch {
          // DB 被占用/并发改写时跳过本轮。
        }
      };

      // message_nodes 请求级 token 明细（每行=一次推理）按 row_id 增量扫进台账。
      // 首轮从游标赶进度：每轮 2000 行直至追上，之后每 5s 只有零头新行。
      const pollMetrics = () => {
        if (!db) return;
        try {
          if (!metricSeeded) {
            metricSeeded = true;
            // 去重集只含已计入行（row_id ≤ 游标）的签名：游标后的还没发，
            // 全量播种会把待发行全判成复制——一行用量都出不去。
            for (const r of db
              .query(
                `SELECT session_id,
                        json_extract(chat_message, '$.message_id') AS mid,
                        json_extract(chat_message, '$.metadata.metrics.input_tokens') AS i,
                        json_extract(chat_message, '$.metadata.metrics.output_tokens') AS o,
                        json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cr,
                        json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cw
                 FROM message_nodes WHERE row_id <= ? AND chat_message LIKE '%input_tokens%'`,
              )
              .all(mnRowid) as Array<{ session_id: string; mid: string | null; i: number | null; o: number | null; cr: number | null; cw: number | null }>) {
              metricSeen.set(
                metricKey(r.session_id, r.mid ?? '', Number(r.i) || 0, Number(r.o) || 0, Number(r.cr) || 0, Number(r.cw) || 0),
                '1',
              );
            }
          }
          const cutoff = Math.floor((Date.now() - BACKFILL_WINDOW_MS) / 1000);
          const rows = db
            .query(
              `SELECT mn.row_id, mn.session_id, mn.created_at,
                      json_extract(mn.chat_message, '$.message_id') AS mid,
                      json_extract(mn.chat_message, '$.metadata.metrics.input_tokens') AS input,
                      json_extract(mn.chat_message, '$.metadata.metrics.output_tokens') AS output,
                      json_extract(mn.chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheRead,
                      json_extract(mn.chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheWrite,
                      s.model
               FROM message_nodes mn LEFT JOIN sessions s ON s.id = mn.session_id
               WHERE mn.row_id > ? AND mn.created_at > ? AND mn.chat_message LIKE '%input_tokens%'
               ORDER BY mn.row_id LIMIT 5000`,
            )
            .all(mnRowid, cutoff) as Array<{
            row_id: number;
            session_id: string;
            created_at: number;
            mid: string | null;
            input: number | null;
            output: number | null;
            cacheRead: number | null;
            cacheWrite: number | null;
            model: string | null;
          }>;
          let last = mnRowid;
          for (const row of rows) {
            last = row.row_id;
            const input = Number(row.input) || 0;
            const output = Number(row.output) || 0;
            const cacheRead = Number(row.cacheRead) || 0;
            const cacheWrite = Number(row.cacheWrite) || 0;
            if (input + output + cacheRead + cacheWrite <= 0) continue;
            const key = metricKey(row.session_id, row.mid ?? '', input, output, cacheRead, cacheWrite);
            if (metricSeen.has(key)) continue;
            metricSeen.set(key, '1');
            const tokens: TokenUsage = {
              input,
              output,
              ...(cacheRead > 0 ? { cacheRead } : {}),
              ...(cacheWrite > 0 ? { cacheWrite } : {}),
            };
            emit({
              agent: 'devin',
              sessionId: row.session_id,
              model: row.model ?? undefined,
              kind: 'usage',
              tokens,
              at: toMs(row.created_at),
            });
          }
          if (last > mnRowid) {
            mnRowid = last;
            ledger.setCursor('devin:mn_rowid', String(mnRowid));
          }
        } catch {
          // DB 被占用/并发改写时跳过本轮。
        }
      };

      // ── 云端会话轮询（60s，仅 BYOK key 在场时）──
      const cloudSeen = new Map<string, string>();
      const pollCloud = async () => {
        const byok = loadCredentials().devin;
        const key = byok?.apiKey?.trim();
        if (!key) return;
        const orgId = sniffDevinOrgId();
        const base = (byok?.baseUrl || 'https://api.devin.ai').replace(/\/+$/, '');
        const url = orgId
          ? `${base}/v3/organizations/${orgId}/sessions?limit=50`
          : `${base}/v3/enterprise/sessions?limit=50`;
        try {
          const res = (await quotaFetch(url, { Authorization: `Bearer ${key}` })) as Record<string, unknown>;
          const items = (res.items ?? []) as Array<Record<string, unknown>>;
          for (const item of items) {
            const id = pick(item, 'session_id');
            if (!id) continue;
            const status = String(item.status ?? '');
            const detail = String(item.status_detail ?? '');
            const ev = cloudEvent(status, detail);
            const stateKey = `${status}:${detail}`;
            const prev = cloudSeen.get(id);
            if (prev === stateKey) continue;
            cloudSeen.set(id, stateKey);
            // 初见即终态的历史会话不建档——否则一轮回填把远古 ended 全刷一遍。
            if (prev === undefined && ev?.status === 'ended') continue;
            const base = {
              agent: 'devin' as const,
              sessionId: id,
              title: pick(item, 'title'),
              at: Date.now(),
              raw: { cloud: true, status, status_detail: detail, acus_consumed: item.acus_consumed },
            };
            if (prev === undefined) {
              emit({ ...base, kind: 'session.start', at: toMs(item.created_at) || Date.now() });
            }
            if (ev) emit({ ...base, ...ev });
          }
        } catch {
          // API 不可达/权限不足 → 云端面静默降级，本地三平面不受影响。
        }
      };

      pollSessions();
      pollMetrics();
      void pollCloud();
      const localTimer = setInterval(() => {
        pollSessions();
        pollMetrics();
      }, 5000);
      const cloudTimer = setInterval(() => void pollCloud(), 60_000);
      return () => {
        clearInterval(localTimer);
        clearInterval(cloudTimer);
        db?.close();
      };
    },

    quota: fetchDevinQuota,
    scanSessions: scanDevinSessions,
    deleteSessions: deleteDevinSessions,
  };
}
