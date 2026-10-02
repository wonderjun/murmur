/**
 * zcode（ZCode / z.ai·智谱 GLM Coding Plan）额度 client——BYOK 通道。
 *
 * 本机凭据（v2/credentials.json）是 enc:v1 加密存储的 OAuth token，读不了也
 * 不该逆向；用户在设置页粘贴自己的 API Key，存 ~/.murmur/credentials.json。
 *
 * 端点：GET {base}/api/monitor/usage/quota/limit，Authorization: Bearer <key>。
 *   base 解析序：byok.baseUrl 手动覆盖 → coding-plan-cache.json  entitlement
 *   嗅探（builtin:bigmodel-* available → open.bigmodel.cn 中国站，
 *   builtin:zai-* available → api.z.ai 国际站）→ api.z.ai 兜底。
 *   返回 {code:200, data:{limits[], level}}：unit=3 → 5h 滚动窗、unit=6 → 每周；
 *   TIME_LIMIT unit=5 → MCP 月度工具额度；level=套餐档。type 双形：国际站样例
 *   是 TOKENS_LIMIT，open.bigmodel.cn 实测返回 CREDIT_LIMIT。limits 条目里
 *   usage=上限、currentValue=已用、remaining=剩余（已用+剩余≈上限，2026-09 实测）。
 *   注意该端点只对 Coding Plan key 有意义，按量付费 key 会失败——BYOK 显式
 *   填写正是为此（不自动征用 provider_config.json 里的第三方 key）。
 */

import { join } from 'node:path';

import type { ByokCredential } from '../credentials';
import { agentPaths } from '../paths';
import type { QuotaSnapshot, QuotaWindow } from '../types';
import { quotaFetch, readJsonFile, unavailable } from './common';

const GLOBAL_BASE = 'https://api.z.ai';
const CN_BASE = 'https://open.bigmodel.cn';

/** coding-plan-cache.json  entitlement 嗅探平台：bigmodel 系可用 → 中国站。 */
function sniffBaseUrl(): string {
  const cache = readJsonFile(join(agentPaths('zcode').sessions ?? agentPaths('zcode').home, 'coding-plan-cache.json'));
  const items = (cache?.entryStatus as Record<string, unknown> | undefined)?.items as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (items) {
    const available = (pred: (key: string) => boolean) =>
      Object.entries(items).some(([k, v]) => pred(k) && v?.status === 'available');
    if (available((k) => k.startsWith('builtin:bigmodel'))) return CN_BASE;
    if (available((k) => k.startsWith('builtin:zai'))) return GLOBAL_BASE;
  }
  return GLOBAL_BASE;
}

/** limit 条目 → 窗口标签；未知形状返回 null 跳过（不伪造窗口）。 */
function limitLabel(type: string, unit: number): string | null {
  // type 双形：国际站样例 TOKENS_LIMIT、中国站实测 CREDIT_LIMIT，同按 unit 分窗。
  const tokenish = type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT';
  if (tokenish && unit === 3) return '5h';
  if (tokenish && unit === 6) return '每周';
  if (type === 'TIME_LIMIT' && unit === 5) return 'MCP 月度';
  return null;
}

export async function fetchZcodeQuota(byok?: ByokCredential): Promise<QuotaSnapshot> {
  const key = byok?.apiKey?.trim();
  if (!key) return unavailable('zcode', '未配置 API Key（设置页可填）');
  const base = (byok?.baseUrl || sniffBaseUrl()).replace(/\/+$/, '');

  try {
    const res = (await quotaFetch(`${base}/api/monitor/usage/quota/limit`, {
      Authorization: `Bearer ${key}`,
    })) as Record<string, unknown>;
    // code 缺省宽容：字段存在且非 200 才算失败（schema 漂移不直接判死）。
    if (typeof res.code === 'number' && res.code !== 200) {
      return unavailable(
        'zcode',
        res.code === 401 || res.code === 403 ? 'API Key 无效或已过期' : `端点返回 code=${res.code}`,
      );
    }
    const data = (res.data ?? res) as Record<string, unknown>;
    const windows: QuotaWindow[] = [];
    for (const l of (data.limits as unknown[]) ?? []) {
      const item = l as Record<string, unknown>;
      const label = limitLabel(String(item.type ?? ''), Number(item.unit));
      if (!label) continue;
      const used = typeof item.currentValue === 'number' ? item.currentValue : undefined;
      const limit = typeof item.usage === 'number' ? item.usage : undefined;
      const pct =
        typeof item.percentage === 'number'
          ? Math.round(item.percentage)
          : used !== undefined && limit !== undefined && limit > 0
            ? Math.round((used / limit) * 100)
            : null;
      if (pct === null) continue;
      windows.push({
        label,
        used,
        limit,
        usedPct: pct,
        resetsAt: typeof item.nextResetTime === 'number' ? item.nextResetTime : null,
      });
    }
    const plan = typeof data.level === 'string' ? data.level : undefined;
    return { agent: 'zcode', plan, windows, fetchedAt: Date.now() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '拉取失败';
    return unavailable('zcode', /401|403/.test(msg) ? 'API Key 无效或已过期' : msg);
  }
}
