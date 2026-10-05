/**
 * minimax adapter（MiniMax Code IDE / mcode·mavis，OpenCode fork 的 Electron 桌面端）。
 *
 * push 平面：缺席——官方明示 hooks/plugins 非公开能力面，config.yaml 无 hooks 键；
 *   input_metadata_json 里的 pluginHookSession 是 runtime 内部机制，外部不可挂。
 * pull 平面：只读轮询 v2/sqlite/runtime-state.sqlite（WAL，被写占即跳过本轮）三张表：
 *   local_runtime_sessions      会话注册表——title/workspace_dir/status(…/started)/
 *                               session_kind/archived/visibility/created_at_ms/
 *                               updated_at_ms + extra_data_json.effectiveModel
 *                               （usage 行的 model 恒空，模型名从这里回退）。
 *   local_runtime_turn_ingress  turn 生命周期——status accepted→completed/failed/
 *                               aborted，accepted_at_ms/completed_at_ms 给精确
 *                               turn.start/turn.end，不依赖静默启发式兜底。
 *   local_runtime_token_usage   请求级计量——自增 id 当游标，input/output/
 *                               reasoning/cache_read/cache_write 互斥分量。
 *   状态面另叠 sessions.updated_at_ms 活性启发式（前进→working、连续静默→
 *   waiting turn-end，devin 同款）补 turn_ingress 够不着的执行中相位。
 * quota 平面：v1 缺席——auth/prod/<region>/mcode-public/auth.json 的 OAuth token
 *   受众是 agent-backend（mavis 网关），billing 端点（/backend/account/
 *   token_plan/remains_percent 等）要 web cookie 会话，实测 1004 not login。
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BACKFILL_WINDOW_MS, type Ledger } from '../../ledger/db';
import { LIVE_WINDOW_MS } from '../../engine/status-engine';
import { agentPaths } from '../../paths';
import type { InstallInfo, TokenUsage } from '../../types';
import { type AgentAdapter, type DataSourceRef } from '../base';
import { deleteMinimaxSessions, scanMinimaxSessions } from './files';

/** token_usage 游标源名（cursors 表键，诊断页展示用）。 */
const USAGE_CURSOR = 'minimax:tu_id';
/** usage 增量每轮上限（首轮赶进度多轮追平）。 */
const USAGE_BATCH = 5000;
/** sessions 表轮询行数上限（注册表近活跃窗口）。 */
const SESSION_ROWS = 300;

/** 有效指标数：null/非数字/负数按 0（负数倒减会污染 usage_daily）。 */
function metricCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** extra_data_json.effectiveModel → 裸模型名（剥 provider/ 前缀；null 直返）。 */
function effectiveModelOf(extraJson: string | null): string | undefined {
  if (!extraJson) return undefined;
  try {
    const raw = (JSON.parse(extraJson) as Record<string, unknown>).effectiveModel;
    if (typeof raw !== 'string' || !raw) return undefined;
    return raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  } catch {
    return undefined;
  }
}

/** OAuth 凭据存在性：auth/<env>/<region>/<clientId>/auth.json 两层目录下探。 */
function hasAuthFile(authDir: string): boolean {
  if (!existsSync(authDir)) return false;
  try {
    for (const env of readdirSync(authDir)) {
      const envDir = join(authDir, env);
      for (const region of readdirSync(envDir)) {
        const regionDir = join(envDir, region);
        try {
          for (const client of readdirSync(regionDir)) {
            if (existsSync(join(regionDir, client, 'auth.json'))) return true;
          }
        } catch {
          // 非目录项（auth.lock 等）跳过。
        }
      }
    }
  } catch {
    // 目录并发改写/权限问题按无凭据处理。
  }
  return false;
}

/** sessions 行 → 轮询记忆项。 */
interface SessionSeen {
  updatedAt: number;
  working: boolean;
  quiet: number;
  /** 已报过 ended（archived/hidden 行常驻，防每轮重复 emit）。 */
  ended: boolean;
}

export function createMinimaxAdapter(): AgentAdapter {
  const paths = agentPaths('minimax');
  const dbPath = join(paths.sessions ?? '', 'sqlite', 'runtime-state.sqlite');

  return {
    id: 'minimax',

    async detect(): Promise<InstallInfo> {
      const installed = existsSync(paths.home);
      return {
        installed,
        hasCredentials: hasAuthFile(paths.credentials ?? ''),
        homeDir: paths.home,
        hookInstalled: false,
        note: installed ? undefined : `未发现 ${paths.home}`,
      };
    },

    dataSources() {
      const out: DataSourceRef[] = [];
      if (paths.sessions) {
        out.push({ label: '状态库', path: dbPath, kind: 'sqlite' });
        out.push({ label: '会话存档', path: join(paths.sessions, 'sessions'), kind: 'dir' });
      }
      return out;
    },

    // 无公开 hook 面：targets 空表是「无 push 通道」信号（诊断 hint/设置页据此跳过分支）。
    hookTargets: () => [],

    async installHooks() {
      return { changed: false };
    },

    async uninstallHooks() {
      return { changed: false };
    },

    async watch(emit, ledger: Ledger) {
      if (!existsSync(dbPath)) return () => {};
      let db: Database | null = null;
      try {
        db = new Database(`file:${dbPath}?mode=ro`, { readonly: true });
      } catch {
        // 库损坏/被占 → watcher 空挂（诊断页 openable 探针如实上报）。
        db = null;
      }
      if (!db) return () => {};

      const seen = new Map<string, SessionSeen>();
      /** 会话 → 模型名（usage 行 model 恒空时的回退源，pollSessions 顺带喂）。 */
      const sessionModels = new Map<string, string>();
      /** 子会话 → 父会话（task 等挂靠行不独立建档，usage/turn 归并父会话，devin 同款）。 */
      const sessionParent = new Map<string, string>();
      /** 进行中的 turn：turn_id → 归并后的 sessionId；转终态时出 turn.end。 */
      const openTurns = new Map<string, string>();
      /** turn_ingress 增量水位（completed_at_ms 判终态迁移用）。 */
      let turnWatermark = Date.now() - LIVE_WINDOW_MS;
      let usageCursor = Number(ledger.getCursor(USAGE_CURSOR) ?? 0) || 0;

      /** 归并后的会话 id（子会话归父；未登记父映射的原样返回）。 */
      const rootSession = (sid: string): string => sessionParent.get(sid) ?? sid;
      /** 该会话是否有进行中 turn（静默启发式不得在开 turn 期间报 waiting）。 */
      const hasOpenTurn = (sid: string): boolean => {
        for (const t of openTurns.values()) if (t === sid) return true;
        return false;
      };

      const pollSessions = () => {
        if (!db) return;
        try {
          const rows = db
            .query(
              `SELECT session_id, title, workspace_dir, status, session_kind, parent_session_id,
                      archived, visibility, created_at_ms, updated_at_ms, extra_data_json
               FROM local_runtime_sessions
               ORDER BY updated_at_ms DESC LIMIT ?`,
            )
            .all(SESSION_ROWS) as Array<{
            session_id: string;
            title: string | null;
            workspace_dir: string | null;
            status: string | null;
            session_kind: string;
            parent_session_id: string | null;
            archived: number;
            visibility: string;
            created_at_ms: number | null;
            updated_at_ms: number;
            extra_data_json: string | null;
          }>;
          const cutoff = Date.now() - BACKFILL_WINDOW_MS;
          for (const row of rows) {
            const model = effectiveModelOf(row.extra_data_json);
            if (model) sessionModels.set(row.session_id, model);
            // 子会话（task/peek/channel/cron 或 parent 挂靠的行）不独立建档，
            // 只登记归并映射——usage/turn 事件落到父会话上。
            if (row.parent_session_id || (row.session_kind !== 'conversation' && row.session_kind !== 'unknown')) {
              if (row.parent_session_id) sessionParent.set(row.session_id, row.parent_session_id);
              continue;
            }
            const base = {
              agent: 'minimax' as const,
              sessionId: row.session_id,
              cwd: row.workspace_dir ?? undefined,
              title: row.title ?? undefined,
              model,
            };
            const st = seen.get(row.session_id);
            // 归档/隐藏翻转对已见会话报一次性收尾；死档不建。
            if (row.archived === 1 || row.visibility === 'hidden') {
              if (st && !st.ended) {
                emit({ ...base, kind: 'session.end', at: row.updated_at_ms || Date.now() });
                seen.set(row.session_id, { ...st, ended: true });
              }
              continue;
            }
            if (!st) {
              if (row.created_at_ms && row.created_at_ms < cutoff && row.updated_at_ms < cutoff) continue;
              emit({ ...base, kind: 'session.start', at: row.created_at_ms ?? row.updated_at_ms ?? Date.now() });
              // 初见即活跃（重启时正在跑的会话）→ 如实报 working。
              const live =
                row.status === 'started' ||
                (row.updated_at_ms != null && Date.now() - row.updated_at_ms < LIVE_WINDOW_MS);
              seen.set(row.session_id, { updatedAt: row.updated_at_ms, working: live, quiet: 0, ended: false });
              if (live) emit({ ...base, kind: 'status', status: 'working', at: row.updated_at_ms || Date.now() });
              continue;
            }
            if (st.ended) continue;
            // updated_at 前进或 idle→started 跃迁才算新活性；status 恒 'started' 时每轮
            // 重报 working 只会往 events 流水灌重复行。
            if (row.updated_at_ms > st.updatedAt || (row.status === 'started' && !st.working)) {
              emit({ ...base, kind: 'status', status: 'working', at: row.updated_at_ms || Date.now() });
              seen.set(row.session_id, { updatedAt: row.updated_at_ms, working: true, quiet: 0, ended: false });
            } else if (st.working) {
              // 连续静默 ≈10s+ 且刚 working 过、又无进行中 turn → 大概率在等输入
              // （devin 同款启发式；turn_ingress 覆盖不了会话活跃但无 ingress 行的相位）。
              const quiet = st.quiet + 1;
              if (quiet >= 2 && !hasOpenTurn(row.session_id)) {
                emit({
                  ...base,
                  kind: 'status',
                  status: 'waiting',
                  waitingReason: 'turn-end',
                  at: st.updatedAt || Date.now(),
                });
                seen.set(row.session_id, { updatedAt: st.updatedAt, working: false, quiet, ended: false });
              } else {
                seen.set(row.session_id, { ...st, quiet });
              }
            }
          }
        } catch {
          // DB 被占用/并发改写时跳过本轮。
        }
      };

      /**
       * turn_ingress 精确边界：accepted 行 = turn.start；已跟踪行转终态 = turn.end。
       * 上轮窗口内完成的未跟踪 turn（短回合漏采 accepted 态）也补发 turn.end。
       */
      const pollTurns = () => {
        if (!db) return;
        try {
          const rows = db
            .query(
              `SELECT turn_id, session_id, status, accepted_at_ms, completed_at_ms
               FROM local_runtime_turn_ingress
               WHERE status = 'accepted' OR accepted_at_ms >= ? OR completed_at_ms >= ?`,
            )
            .all(turnWatermark, turnWatermark) as Array<{
            turn_id: string;
            session_id: string;
            status: string;
            accepted_at_ms: number;
            completed_at_ms: number | null;
          }>;
          const now = Date.now();
          for (const row of rows) {
            const sid = rootSession(row.session_id);
            if (!seen.has(sid)) continue; // 未建档会话不搬 turn 边界（死档不回魂）。
            if (row.status === 'accepted') {
              if (openTurns.has(row.turn_id)) continue;
              openTurns.set(row.turn_id, sid);
              emit({
                agent: 'minimax',
                sessionId: sid,
                kind: 'turn.start',
                at: row.accepted_at_ms || now,
              });
            } else if (openTurns.delete(row.turn_id) || (row.completed_at_ms ?? 0) >= turnWatermark) {
              emit({
                agent: 'minimax',
                sessionId: sid,
                kind: 'turn.end',
                waitingReason: 'turn-end',
                at: row.completed_at_ms ?? row.accepted_at_ms ?? now,
              });
            }
          }
          turnWatermark = now;
        } catch {
          // 同上：本轮跳过。
        }
      };

      /** token_usage 请求级计量：自增 id 游标增量扫，模型回退会话映射。 */
      const pollUsage = () => {
        if (!db) return;
        try {
          const cutoff = Date.now() - BACKFILL_WINDOW_MS;
          const rows = db
            .query(
              `SELECT id, session_id, model, ts,
                      input_tokens, output_tokens, reasoning_tokens,
                      cache_read_tokens, cache_write_tokens
               FROM local_runtime_token_usage
               WHERE id > ? AND ts >= ? ORDER BY id LIMIT ?`,
            )
            .all(usageCursor, cutoff, USAGE_BATCH) as Array<{
            id: number;
            session_id: string;
            model: string | null;
            ts: number;
            input_tokens: number | null;
            output_tokens: number | null;
            reasoning_tokens: number | null;
            cache_read_tokens: number | null;
            cache_write_tokens: number | null;
          }>;
          let last = usageCursor;
          for (const row of rows) {
            last = row.id;
            const tokens: TokenUsage = {
              input: metricCount(row.input_tokens),
              output: metricCount(row.output_tokens),
              cacheRead: metricCount(row.cache_read_tokens),
              cacheWrite: metricCount(row.cache_write_tokens),
              reasoning: metricCount(row.reasoning_tokens),
            };
            if (tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) <= 0) continue;
            emit({
              agent: 'minimax',
              sessionId: rootSession(row.session_id),
              kind: 'usage',
              tokens,
              model: row.model || sessionModels.get(row.session_id),
              at: row.ts,
            });
          }
          if (last > usageCursor) {
            usageCursor = last;
            ledger.setCursor(USAGE_CURSOR, String(usageCursor));
          }
        } catch {
          // 同上：本轮跳过。
        }
      };

      const poll = () => {
        pollSessions();
        pollTurns();
        pollUsage();
      };
      poll();
      const timer = setInterval(poll, 5000);
      return () => {
        clearInterval(timer);
        db?.close();
      };
    },

    scanSessions: scanMinimaxSessions,
    deleteSessions: deleteMinimaxSessions,
  };
}
