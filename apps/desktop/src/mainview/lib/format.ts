/** 数字紧凑格式化：令牌/计数展示统一口径（1.2k / 3.4M / 5.6G），配 tabular-nums 使用。 */

import type { QuotaWindow } from "@core/types";

export function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 字节数人性化（会话文件页）：0.9 MB / 1.2 GB，配 tabular-nums。 */
export function fmtBytes(n: number): string {
  if (!n) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 额度数字：小数值（ACU 这类小数计量）保一位小数，大数走紧凑格式。 */
export function fmtAmount(n: number): string {
  return n < 100 && !Number.isInteger(n) ? n.toFixed(1) : fmtTokens(n);
}

/** 额度窗口主数字：无上限计量窗（devin ACU 这类只报已消耗的端点）报绝对量，其余报百分比。 */
export function fmtQuotaHeadline(w: QuotaWindow): string {
  return w.used !== undefined && w.limit === undefined ? fmtAmount(w.used) : `${w.usedPct}%`;
}

/** 额度窗口绝对量副行：u/l → "u / l"；纯计量 → "x 已用"；端点只回百分比 → 留空（主数字即额度语义）。 */
export function fmtQuotaAmount(w: QuotaWindow): string {
  if (w.used === undefined) return w.limit === undefined ? "" : `上限 ${fmtAmount(w.limit)}`;
  if (w.limit === undefined) return `${fmtAmount(w.used)} 已用`;
  return `${fmtAmount(w.used)} / ${fmtAmount(w.limit)}`;
}

/** 相对时间（诊断页「最近扫描/上报」）：<1m 刚刚 / <60m N分钟前 / <24h N小时前 / 更久 N天前。 */
export function relAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

/** 会话事件年龄（秒级颗粒：<10s 刚刚 / <60s N秒前 / <60m N分钟前 / 更久 N小时前）。
 *  与 relAgo 不同口径——动态页「等了 x」「没有更新」需要秒级读数。 */
export function fmtAge(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}

/** YYYY-MM-DD（本地时区）——台账 day 键与区间几何共用。 */
export function dayStr(ms: number): string {
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 会话文件时间戳：当年 MM-DD HH:mm，跨年 YYYY-MM-DD；0/无效 → —。 */
export function fmtFileTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  if (d.getFullYear() !== new Date().getFullYear()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
