/**
 * codex 额度 client（降级链：app-server 官方 RPC → wham 私有端点）。
 *
 * 首选 codex app-server（见 codex-app-server.ts）：官方契约、codex 本体管 token 刷新，
 * 我们不碰凭据。不可用时回落 wham：
 *   凭据：~/.codex/auth.json → tokens.access_token + tokens.account_id（严格只读）。
 *   用量：GET https://chatgpt.com/backend-api/wham/usage（ChatGPT 后端私有端点，
 *         codex-bar 等社区工具同款路径），返回
 *         {plan_type, rate_limit:{primary_window:{used_percent,reset_at},secondary_window:{...}}}。
 *         primary≈5h 窗口，secondary≈周窗口。
 */

import { join } from 'node:path';

import { agentPaths } from '../paths';
import type { QuotaSnapshot, QuotaWindow } from '../types';
import { fetchCodexQuotaViaAppServer } from './codex-app-server';
import { quotaFetch, readJsonFile, unavailable } from './common';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** wham 兜底路径：直读 auth.json 打私有用量端点（严格只读，绝不代刷）。 */
async function fetchCodexQuotaWham(): Promise<QuotaSnapshot> {
  const auth = readJsonFile(agentPaths('codex').credentials ?? join(agentPaths('codex').home, 'auth.json'));
  const tokens = (auth?.tokens ?? {}) as Record<string, unknown>;
  const access = tokens.access_token as string | undefined;
  const accountId = (tokens.account_id ?? auth?.chatgpt_account_id) as string | undefined;
  if (!access) return unavailable('codex', '未登录（codex login）');

  try {
    const data = (await quotaFetch(USAGE_URL, {
      Authorization: `Bearer ${access}`,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    })) as Record<string, unknown>;

    const rl = (data.rate_limit ?? {}) as Record<string, unknown>;
    const windows: QuotaWindow[] = [];
    const push = (label: string, row: unknown) => {
      const w = row as Record<string, unknown> | undefined;
      if (!w || typeof w.used_percent !== 'number') return;
      windows.push({
        label,
        usedPct: Math.round(w.used_percent),
        resetsAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : null,
      });
    };
    push('5h', rl.primary_window);
    push('每周', rl.secondary_window);
    return {
      agent: 'codex',
      plan: typeof data.plan_type === 'string' ? data.plan_type : undefined,
      windows,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    return unavailable('codex', e instanceof Error ? e.message : '拉取失败');
  }
}

export async function fetchCodexQuota(): Promise<QuotaSnapshot> {
  try {
    const q = await fetchCodexQuotaViaAppServer();
    if (q.windows.length) return q;
  } catch {
    // app-server 不可用（无 codex 二进制/老版本无此子命令/超时）→ 回落 wham。
  }
  return fetchCodexQuotaWham();
}
