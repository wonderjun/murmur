/**
 * quota client 公共件：安全 fetch（超时+不抛异常）、凭据文件读取。
 * 全部容忍失败——额度是增强面，任何异常都降级为「不可用」。
 */

import { existsSync, readFileSync } from 'node:fs';

import type { QuotaSnapshot, QuotaWindow, AgentId } from '../types';

/** 8s 超时 fetch，非 2xx 抛错。 */
export async function quotaFetch(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 读 JSON 凭据文件；不存在/坏 JSON 返回 null。 */
export function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 构造「不可用」快照（凭据缺失/未登录/端点失败且无历史时）。 */
export function unavailable(agent: AgentId, reason: string): QuotaSnapshot {
  return { agent, windows: [], fetchedAt: Date.now(), error: reason };
}

/**
 * 失败的额度轮次怎么留：内存里仍有窗口的快照优先（比台账新，落库失败时也还在），
 * 其次读台账里上次有效的；都没有才留下这次的 unavailable。读台账失败按没有历史。
 */
export function fallbackQuota(
  current: QuotaSnapshot | undefined,
  readLast: () => QuotaSnapshot | null,
  failed: QuotaSnapshot,
): QuotaSnapshot {
  if (current && current.windows.length > 0) return current;
  try {
    const last = readLast();
    if (last && last.windows.length > 0) return last;
  } catch {
    // 台账被占用时读不到历史，不能把这一轮标成成功额度。
  }
  return failed;
}

/** kimi `{duration,timeUnit}` → 展示标签（"5h" / "每周" / "每日"…）。 */
export function windowLabel(duration?: number, unit?: string): string {
  if (!duration || !unit) return '周期';
  if (unit === 'hour') return `${duration}h`;
  if (unit === 'day') return duration === 1 ? '每日' : `${duration}d`;
  if (unit === 'week') return '每周';
  if (unit === 'minute') return duration >= 60 ? `${duration / 60}h` : `${duration}m`;
  return `${duration}${unit}`;
}

/** 通用归一化：{used, limit, resetTime?} → QuotaWindow。 */
export function toWindow(label: string, used: number, limit: number, resetAt?: string | number | null): QuotaWindow {
  const resetsAt =
    typeof resetAt === 'number' ? (resetAt > 1e12 ? resetAt : resetAt * 1000)
    : typeof resetAt === 'string' && resetAt ? Date.parse(resetAt) || null
    : null;
  return {
    label,
    used,
    limit,
    usedPct: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    resetsAt,
  };
}
