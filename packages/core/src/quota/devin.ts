/**
 * devin（Devin CLI/Desktop）额度 client——双通道。
 *
 * 通道一（本机凭据复用，cursor 同款思路，2026-10 实测可用）：
 *   credentials.toml 的 windsurf_api_key 是 CLI 登录态（devin-session-token$<jwt>），
 *   打 api_server_url（server.codeium.com）的 Connect RPC
 *   POST /exa.seat_management_pb.SeatManagementService/GetUserStatus——
 *   返回 planStatus{ planInfo{planName, devinInfo{orgId}}, planStart/planEnd,
 *   dailyQuotaRemainingPercent, weeklyQuotaRemainingPercent, acuConsumed, acuLimit,
 *   dailyQuotaResetAtUnix, weeklyQuotaResetAtUnix }——这是配额窗口主源（剩余%语义，
 *   需换算成 usedPct）。注意该凭据打 api.devin.ai/v3 实测 403（受众不同），
 *   两边各管各的端点。严格只读，不碰 refresh。
 * 通道二（BYOK，zcode 同款）：用户自填 cog_ 凭据（PAT：app.devin.ai →
 *   Settings → Devin API → PATs；或 service user key）打官方 v3
 *   GET /organizations/{org}/consumption/daily——org_id 解析序：config.json 的
 *   devin.org_id → user_status 的 devinInfo.orgId。返回 {total_acus,
 *   consumption_by_date:[{date(秒,PST 界),acus,acus_by_product}]}——
 *   历史日级消耗由此而来。Devin 按 ACU 计量计费、没有滚动配额上限概念
 *   （limit 仅管理员设 cap 时存在），所以这两个窗口 limit 恒缺省、usedPct 恒 0，
 *   只表达「已消耗」。org 缺失时回落 /v3/enterprise/consumption/daily（需企业套餐，
 *   失败即视为通道二不可用，不影响通道一结果）。
 */

import { existsSync, readFileSync } from 'node:fs';

import type { ByokCredential } from '../credentials';
import { agentPaths } from '../paths';
import type { QuotaSnapshot, QuotaWindow } from '../types';
import { quotaFetch, readJsonFile, unavailable } from './common';

const API_BASE = 'https://api.devin.ai';
const CONNECT_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
/** consumption/daily 拉取窗口：近 30 天（quota 面板展示粒度，账单周期 ~30d）。 */
const CONSUMPTION_DAYS = 30;

interface DevinLocalCred {
  apiKey: string;
  apiServerUrl: string;
  devinApiUrl: string;
}

/** credentials.toml 极简解析：只认 `key = "value"` 行（文件就四个键，不引 TOML 库）。 */
export function readDevinCredentials(path: string | null): DevinLocalCred | null {
  if (!path || !existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(text)?.[1] ?? '';
    const apiKey = get('windsurf_api_key');
    if (!apiKey) return null;
    return {
      apiKey,
      apiServerUrl: get('api_server_url').replace(/\/+$/, ''),
      devinApiUrl: get('devin_api_url').replace(/\/+$/, ''),
    };
  } catch {
    // 读不了的凭据当作没有。
    return null;
  }
}

/** devin config.json 的 devin.org_id（v3 org 端点路径参数）。 */
export function sniffDevinOrgId(): string | undefined {
  const cfg = readJsonFile(agentPaths('devin').hookConfig ?? '');
  const devin = cfg?.devin as Record<string, unknown> | undefined;
  return typeof devin?.org_id === 'string' && devin.org_id ? devin.org_id : undefined;
}

/** GetUserStatus → 配额窗口。remaining% → usedPct；ACU cap 仅管理员设置过才出现。 */
function userStatusWindows(res: Record<string, unknown>): { windows: QuotaWindow[]; plan?: string; orgId?: string } {
  const us = (res.userStatus ?? {}) as Record<string, unknown>;
  const ps = (us.planStatus ?? {}) as Record<string, unknown>;
  const info = (ps.planInfo ?? {}) as Record<string, unknown>;
  const devinInfo = (info.devinInfo ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const pct = (k: string) => {
    const v = ps[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(100 - v))) : null;
  };
  const reset = (k: string) => {
    const v = Number(ps[k]);
    return Number.isFinite(v) && v > 0 ? v * 1000 : null;
  };
  const daily = pct('dailyQuotaRemainingPercent');
  if (daily !== null) windows.push({ label: '每日', usedPct: daily, resetsAt: reset('dailyQuotaResetAtUnix') });
  const weekly = pct('weeklyQuotaRemainingPercent');
  if (weekly !== null) windows.push({ label: '每周', usedPct: weekly, resetsAt: reset('weeklyQuotaResetAtUnix') });
  const acuUsed = typeof ps.acuConsumed === 'number' ? ps.acuConsumed : Number(ps.acuConsumed) || undefined;
  const acuLimit = typeof ps.acuLimit === 'number' ? ps.acuLimit : Number(ps.acuLimit) || undefined;
  if (acuLimit && acuLimit > 0) {
    windows.push({
      label: 'ACU 周期',
      used: acuUsed,
      limit: acuLimit,
      usedPct: acuUsed !== undefined ? Math.min(100, Math.round((acuUsed / acuLimit) * 100)) : 0,
      resetsAt: typeof ps.planEnd === 'string' ? Date.parse(ps.planEnd) || null : null,
    });
  }
  const plan = typeof info.planName === 'string' ? info.planName : undefined;
  const orgId = typeof devinInfo.orgId === 'string' ? devinInfo.orgId : undefined;
  return { windows, plan, orgId };
}

/** 本机凭据通道：Connect RPC（JSON 媒体类型）。凭据无效/未登录抛错由调用方降级。 */
async function fetchUserStatus(cred: DevinLocalCred): Promise<{ windows: QuotaWindow[]; plan?: string; orgId?: string }> {
  const base = cred.apiServerUrl || 'https://server.codeium.com';
  const res = await fetch(`${base}${CONNECT_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Authorization: `Bearer ${cred.apiKey}`,
    },
    // metadata 形状与 CLI 一致：apiKey 在 body 与 Authorization 双带（实测服务端两路都认）。
    body: JSON.stringify({
      metadata: {
        apiKey: cred.apiKey,
        ideName: 'devin-cli',
        ideVersion: '3000.11.3',
        extensionName: 'devin-cli',
        extensionVersion: '3000.11.3',
        requestId: '1',
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  // Connect 错误信封：{code,message}——HTTP 200 也可能回错。
  if (typeof json.code === 'string' && json.code) {
    throw new Error(json.code === 'unauthenticated' ? '凭据已失效' : `端点返回 ${json.code}`);
  }
  return userStatusWindows(json);
}

/** consumption/daily 响应 → 今日/近30日 ACU 窗口（只有已消耗，无上限）。 */
function consumptionWindows(res: Record<string, unknown>): QuotaWindow[] {
  const items = (res.consumption_by_date ?? res.consumptionByDate ?? []) as Array<Record<string, unknown>>;
  const windows: QuotaWindow[] = [];
  if (items.length) {
    const last = items[items.length - 1]!;
    const lastAcu = Number(last.acus);
    if (Number.isFinite(lastAcu)) {
      windows.push({ label: '最近一日 ACU', used: lastAcu, usedPct: 0, resetsAt: null });
    }
  }
  const total = typeof res.total_acus === 'number' ? res.total_acus : undefined;
  const sum = total ?? items.reduce((acc, it) => acc + (Number(it.acus) || 0), 0);
  if (sum > 0 || windows.length) {
    windows.push({ label: `近 ${CONSUMPTION_DAYS} 日 ACU`, used: Math.round(sum * 100) / 100, usedPct: 0, resetsAt: null });
  }
  return windows;
}

/** BYOK 通道：cog_ key → v3 consumption/daily。返回 null 表示通道不可用（无 key/org/403）。 */
async function fetchConsumption(
  byok: ByokCredential,
  apiBase: string,
  orgId: string | undefined,
): Promise<QuotaWindow[] | null> {
  const headers = { Authorization: `Bearer ${byok.apiKey}` };
  const now = Math.floor(Date.now() / 1000);
  const after = now - CONSUMPTION_DAYS * 86400;
  const url = orgId
    ? `${apiBase}/v3/organizations/${orgId}/consumption/daily?time_after=${after}&time_before=${now}`
    : `${apiBase}/v3/enterprise/consumption/daily?time_after=${after}&time_before=${now}`;
  try {
    const res = (await quotaFetch(url, headers)) as Record<string, unknown>;
    return consumptionWindows(res);
  } catch {
    // org 端点 403/404（个人账号无 ViewOrgConsumption 或非企业套餐）→ 通道静默降级。
    return null;
  }
}

export async function fetchDevinQuota(byok?: ByokCredential): Promise<QuotaSnapshot> {
  const cred = readDevinCredentials(agentPaths('devin').credentials);
  if (!cred && !byok?.apiKey) {
    return unavailable('devin', 'CLI 未登录且无 API Key（设置页可填 PAT/Service User Key）');
  }

  const windows: QuotaWindow[] = [];
  let plan: string | undefined;
  let orgId = sniffDevinOrgId();
  let localError: string | undefined;

  if (cred) {
    try {
      const r = await fetchUserStatus(cred);
      windows.push(...r.windows);
      plan = r.plan;
      orgId = orgId ?? r.orgId;
    } catch (e) {
      // 本机凭据通道失败不致命——BYOK 通道仍可能出量。
      localError = e instanceof Error ? e.message : '拉取失败';
    }
  }

  if (byok?.apiKey?.trim()) {
    const apiBase = (byok.baseUrl || cred?.devinApiUrl || API_BASE).replace(/\/+$/, '');
    const acu = await fetchConsumption({ ...byok, apiKey: byok.apiKey.trim() }, apiBase, orgId);
    if (acu) windows.push(...acu);
  }

  if (windows.length) return { agent: 'devin', plan, windows, fetchedAt: Date.now() };
  // 两通道全灭：有本地错误就报它，否则报 BYOK 侧缺件。
  const reason =
    localError ??
    (byok?.apiKey ? 'consumption 端点无权限（需 ViewOrgConsumption 或企业套餐）' : 'CLI 未登录');
  return unavailable('devin', reason);
}
