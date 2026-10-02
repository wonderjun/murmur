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
 *   transcripts/<slug>.json 的 final_metrics{prompt/completion/cached/steps}
 *   是全量累计——按 ledger 游标记上次值、发 delta 记 token 台账（覆盖不全，
 *   仅辅助源）。session_locks/*.lock 是 PID 锁但陈旧极多（本机 897 锁仅 30
 *   活），不作活性判据。session_id 与 sessions.id(slug) 是否同一口径未实测
 *   确认——不一致时同会话会出两条目（保守并存，以 push 为准）。
 * cloud 平面：BYOK cog_ 凭据存在时每 60s 轮询 v3 sessions（org 端点优先、
 *   enterprise 兜底）补云端会话状态——本地手段够不到云机。凭据从
 *   credentials.json 每轮现读（设置页填了 key 即刻生效，不用重启 watcher）。
 *   组织级列表可能含他人会话——能力所限如实呈现。
 * quota 平面：quota/devin.ts（本机 Connect RPC 配额窗口 + BYOK ACU 消耗）。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadCredentials } from '../../credentials';
import { devinHooksRegistered, mergeDevinHooks, removeHookScript, unmergeJsonHooks } from '../../hooks/install';
import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { agentPaths } from '../../paths';
import { quotaFetch, readJsonFile } from '../../quota/common';
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

/** transcripts final_metrics 的存量值（delta 记账基准），随 ledger 游标持久化。 */
interface Metrics {
  p: number;
  c: number;
  o: number;
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
      /** slug → 上次处理的 {mtime, 累计值}：mtime 不动跳过解析（文件 ~500KB 级，不白读）。 */
      const metricsSeen = new Map<string, { mtime: number; cur: Metrics }>();

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

      // transcripts/*.json：final_metrics 增量 delta → usage（游标持久化防重启双计）。
      const pollTranscripts = () => {
        try {
          for (const name of readdirSync(transcriptsDir)) {
            if (!name.endsWith('.json')) continue;
            const path = join(transcriptsDir, name);
            const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
            if (!mtime || mtime < Date.now() - BACKFILL_WINDOW_MS) continue;
            const slug = name.slice(0, -5);
            const hit = metricsSeen.get(slug);
            if (hit && hit.mtime === mtime) continue;
            const prev: Metrics =
              hit?.cur ?? (JSON.parse(ledger.getCursor(`devin:metrics:${slug}`) ?? 'null') as Metrics | null) ?? {
                p: 0,
                c: 0,
                o: 0,
              };
            const obj = readJsonFile(path);
            const fm = (obj?.final_metrics ?? {}) as Record<string, unknown>;
            const cur: Metrics = {
              p: Number(fm.total_prompt_tokens) || 0,
              c: Number(fm.total_cached_tokens) || 0,
              o: Number(fm.total_completion_tokens) || 0,
            };
            if (!cur.p && !cur.o) {
              metricsSeen.set(slug, { mtime, cur });
              continue;
            }
            // 增量口径：prompt 含 cached（OpenAI 惯例）→ input 扣缓存分量。
            const delta: TokenUsage = {
              input: Math.max(0, cur.p - cur.c - (prev.p - prev.c)),
              cacheRead: Math.max(0, cur.c - prev.c),
              output: Math.max(0, cur.o - prev.o),
            };
            if (delta.input + delta.output + (delta.cacheRead ?? 0) > 0) {
              emit({ agent: 'devin', sessionId: slug, kind: 'usage', tokens: delta, at: mtime, raw: { final_metrics: fm } });
              ledger.setCursor(`devin:metrics:${slug}`, JSON.stringify(cur));
            }
            metricsSeen.set(slug, { mtime, cur });
          }
        } catch {
          // 目录被并发改写时跳过本轮。
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
      pollTranscripts();
      void pollCloud();
      const localTimer = setInterval(() => {
        pollSessions();
        pollTranscripts();
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
