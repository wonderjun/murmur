/**
 * omp 额度面：agent.db 的 usage_history 是 omp 自采的 provider 额度窗快照
 * （used_fraction/resets_at/window_label，recorded_at 毫秒）——本地只读即得
 * QuotaWindow，零网络零凭据，与其它家「官方端点 client」等价但更简单。
 *
 * 凭据纪律：auth_credentials.credentials 列存真 token——探测 hasCredentials
 * 只做 COUNT(*)，永不 SELECT 凭据列；整库 readonly 打开。
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { unavailable } from '../../quota/common';
import type { QuotaSnapshot, QuotaWindow } from '../../types';
import { ompAgentDirs } from './files';

/** 每条额度窗序列的最新一行（recorded_at 最大，按 provider/账户/限额项分组）。 */
const LATEST_PER_SERIES = `
SELECT h.provider, h.label, h.window_label, h.used_fraction, h.resets_at, h.recorded_at
FROM usage_history h
JOIN (
  SELECT provider, account_key, limit_id, MAX(recorded_at) AS mx
  FROM usage_history GROUP BY provider, account_key, limit_id
) t
  ON h.provider = t.provider AND h.account_key = t.account_key
 AND h.limit_id = t.limit_id AND h.recorded_at = t.mx
WHERE h.used_fraction IS NOT NULL`;

interface UsageRow {
  provider: string;
  label: string;
  window_label: string | null;
  used_fraction: number;
  resets_at: number | null;
  recorded_at: number;
}

/** 只读打开 agent.db 跑一段查询；库缺失/被占/损坏返回 null（本轮降级）。 */
function queryAgentDb<T>(path: string, sql: string): T[] | null {
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    return db.query(sql).all() as T[];
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** auth_credentials 有行即「已登录」——只看行数，凭据列绝不读。 */
export function ompHasCredentials(): boolean {
  for (const dir of ompAgentDirs()) {
    const path = join(dir, 'agent.db');
    if (!existsSync(path)) continue;
    const rows = queryAgentDb<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM auth_credentials');
    if ((rows?.[0]?.n ?? 0) > 0) return true;
  }
  return false;
}

/**
 * 拉取额度快照：枚举全部 agent 目录的 agent.db（默认 + 命名 profile），
 * usage_history 按序列取最新、跨库同序列合并留新。fetchedAt 用快照行自己的
 * recorded_at——omp 何时刷的何时算数，不冒充当下。
 */
export async function fetchOmpQuota(): Promise<QuotaSnapshot> {
  const series = new Map<string, UsageRow>();
  let sawDb = false;
  let sawError = false;
  for (const dir of ompAgentDirs()) {
    const path = join(dir, 'agent.db');
    if (!existsSync(path)) continue;
    sawDb = true;
    const rows = queryAgentDb<UsageRow>(path, LATEST_PER_SERIES);
    if (rows === null) {
      sawError = true;
      continue;
    }
    for (const r of rows) {
      const key = `${r.provider}:${r.window_label ?? r.label}:${r.resets_at ?? 0}`;
      const prev = series.get(key);
      if (!prev || r.recorded_at > prev.recorded_at) series.set(key, r);
    }
  }
  if (!sawDb) return unavailable('omp', '未发现 agent.db');
  if (!series.size) {
    return unavailable('omp', sawError ? 'agent.db 不可读' : 'omp 尚未记录额度数据');
  }
  const windows: QuotaWindow[] = [...series.values()]
    .map((r) => ({
      label: `${r.provider} · ${r.window_label ?? r.label}`,
      usedPct: Math.min(100, Math.max(0, Math.round(r.used_fraction * 100))),
      resetsAt: r.resets_at ?? null,
    }))
    .sort((a, b) => b.usedPct - a.usedPct || a.label.localeCompare(b.label));
  const fetchedAt = Math.max(...[...series.values()].map((r) => r.recorded_at), 0);
  return { agent: 'omp', windows, fetchedAt: fetchedAt || Date.now() };
}
