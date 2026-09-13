/**
 * cursor 额度 client。
 *
 * 凭据（严格只读，绝不代刷——refresh token 属于 IDE/CLI 本体）：
 *   首选 IDE 全局状态库 state.vscdb → ItemTable 'cursorAuth/accessToken'（JWT）；
 *   它是活 WAL 库，readonly 打不开时连 -wal/-shm 拷到 ~/.murmur/tmp 再读。
 *   兜底 cursor-agent CLI 的 auth.json（headless 机器没有 IDE）。
 *
 * 用量：GET https://cursor.com/api/usage-summary —— dashboard 前端自己调的
 *   未公开端点（ai-usagebar 等社区工具同款）。鉴权不是 Bearer，而是把 JWT
 *   拼进会话 cookie：WorkosCursorSessionToken=<userId>%3A%3A<token>，
 *   userId 取 JWT sub 的第二段（'google-oauth2|user_xxx' → 'user_xxx'）；
 *   端点有 CORS 门，必须带浏览器 UA + Origin/Referer。
 *   响应无 individualUsage.plan（team/enterprise/请求制账号）时回退
 *   api2.cursor.sh/auth/usage（Bearer JWT）拿 premium 请求数。
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MURMUR_HOME, agentPaths } from '../paths';
import type { QuotaSnapshot, QuotaWindow } from '../types';
import { quotaFetch, readJsonFile, toWindow, unavailable } from './common';

const SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const LEGACY_USAGE_URL = 'https://api2.cursor.sh/auth/usage';
// dashboard 端点按浏览器请求放行，裸 fetch 会被 CORS 预检拒。
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface CursorAuth {
  token: string;
  /** state.vscdb 里顺读的套餐档（usage-summary 缺 membershipType 时兜底）。 */
  plan?: string;
}

/** 解 JWT payload（不验签——只是读本机自己的 token 拿 sub/exp）。 */
function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const d = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 打开 state.vscdb 查凭据行；库被占/损坏返回 null 静默降级。
 * readonly=true 用于原始库；拷贝副本必须可写打开——它是 WAL 库，readonly 且
 * 无 -shm 可建时直接打不开（本机实测），副本是我们自己的文件，恢复无妨。
 */
function queryAuth(dbPath: string | null, readonly = true): CursorAuth | null {
  if (!dbPath) return null;
  try {
    // bun:sqlite 的 {readonly:false} 会报 flags 错——可写打开必须不传 options。
    const db = readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
    try {
      const rows = db
        .query(
          "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/stripeMembershipType')",
        )
        .all() as Array<{ key: string; value: string }>;
      const map = new Map(rows.map((r) => [r.key, r.value]));
      const token = map.get('cursorAuth/accessToken');
      if (!token) return null;
      return { token, plan: map.get('cursorAuth/stripeMembershipType') || undefined };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * 活 WAL 库的只读副本：readonly 打开需要 -shm 已存在，缺时把 db+wal+shm 一起
 * 拷到 ~/.murmur/tmp 再查（社区工具同款手法）。上次残留的 -wal 会污染副本视图，先清。
 */
function copyForRead(dbPath: string): string | null {
  try {
    const dir = join(MURMUR_HOME, 'tmp');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, 'cursor-state.vscdb');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${dbPath}${suffix}`;
      const dst = `${dest}${suffix}`;
      if (existsSync(src)) copyFileSync(src, dst);
      else if (existsSync(dst)) rmSync(dst);
    }
    return dest;
  } catch {
    return null;
  }
}

/** cursor-agent CLI 的登录态（headless 机器唯一凭据源），json 里就是 accessToken。 */
function cliAuthCandidates(): string[] {
  // env 覆盖是排他的（测试钉沙箱用），不设才走平台默认候选。
  if (process.env.MURMUR_CURSOR_CLI_AUTH) return [process.env.MURMUR_CURSOR_CLI_AUTH];
  const home = homedir();
  return [
    join(home, '.config', 'cursor', 'auth.json'),
    join(home, 'Library', 'Application Support', 'cursor', 'auth.json'),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'cursor', 'auth.json')] : []),
  ];
}

/** 解析本机凭据：IDE state.vscdb 优先（常驻刷新最及时），CLI auth.json 兜底。 */
export function readCursorAuth(): CursorAuth | null {
  const dbPath = agentPaths('cursor').credentials;
  if (dbPath && existsSync(dbPath)) {
    const auth = queryAuth(dbPath) ?? queryAuth(copyForRead(dbPath), false);
    if (auth) return auth;
  }
  for (const p of cliAuthCandidates()) {
    const j = readJsonFile(p);
    const token = j?.accessToken;
    if (typeof token === 'string' && token) return { token };
  }
  return null;
}

/** detect() 用：本机是否有可试的凭据源（文件存在即可，token 有效性留给 quota）。 */
export function hasCursorCredentials(): boolean {
  const db = agentPaths('cursor').credentials;
  return (db ? existsSync(db) : false) || cliAuthCandidates().some((p) => existsSync(p));
}

/** 百分比字段归一化：非有限数当作 schema 漂移跳过，绝不伪造 0。 */
function pct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** 展示文案兜底（team/enterprise 无 plan 对象时唯一百分比源）："You've used 42% of …"。 */
function pctFromMessage(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(v);
  return m ? Math.round(Number(m[1])) : null;
}

/** usage-summary → 窗口映射；返回空数组表示该端点对本账号无可用数据。 */
function summaryWindows(data: Record<string, unknown>): { windows: QuotaWindow[]; plan?: string } {
  const windows: QuotaWindow[] = [];
  const resetsAt = typeof data.billingCycleEnd === 'string' ? Date.parse(data.billingCycleEnd) || null : null;
  const ind = (data.individualUsage ?? {}) as Record<string, unknown>;
  const planUsage = ind.plan as Record<string, unknown> | undefined;
  if (planUsage) {
    const total = pct(planUsage.totalPercentUsed);
    const auto = pct(planUsage.autoPercentUsed);
    const api = pct(planUsage.apiPercentUsed);
    if (total !== null) windows.push({ label: '本周期', usedPct: total, resetsAt });
    if (auto !== null) windows.push({ label: 'Auto', usedPct: auto, resetsAt });
    if (api !== null) windows.push({ label: 'API', usedPct: api, resetsAt });
  }
  if (windows.length === 0) {
    // team/enterprise（或 plan 空对象漂移）：百分比只挂在展示文案里，两者各对应 Auto/API 池。
    const auto = pctFromMessage(data.autoModelSelectedDisplayMessage);
    const api = pctFromMessage(data.namedModelSelectedDisplayMessage);
    if (auto !== null) windows.push({ label: 'Auto', usedPct: auto, resetsAt });
    if (api !== null) windows.push({ label: 'API', usedPct: api, resetsAt });
  }
  // 按需超量池：used/limit 单位是美分。
  for (const od of [ind.onDemand, (data.teamUsage as Record<string, unknown> | undefined)?.onDemand]) {
    const d = od as Record<string, unknown> | undefined;
    if (d?.enabled !== true) continue;
    if (typeof d.used === 'number' || typeof d.limit === 'number') {
      windows.push(toWindow('按需', ((d.used as number) ?? 0) / 100, ((d.limit as number) ?? 0) / 100, resetsAt));
      break;
    }
  }
  const plan = typeof data.membershipType === 'string' ? data.membershipType : undefined;
  return { windows, plan };
}

/** 请求制账号兜底：api2.cursor.sh/auth/usage 返回各模型 numRequests/maxRequestUsage。 */
async function legacyRequestWindow(token: string): Promise<QuotaWindow[]> {
  const data = (await quotaFetch(LEGACY_USAGE_URL, { Authorization: `Bearer ${token}` })) as Record<string, unknown>;
  let used = 0;
  let limit = 0;
  for (const v of Object.values(data)) {
    const w = v as Record<string, unknown>;
    if (typeof w?.maxRequestUsage === 'number' && w.maxRequestUsage > 0) {
      used += typeof w.numRequests === 'number' ? w.numRequests : 0;
      limit += w.maxRequestUsage;
    }
  }
  if (limit <= 0) return [];
  // startOfMonth 是本计费月初，重置点即次月同日（± 大小月差异，展示级精度足够）。
  const start = typeof data.startOfMonth === 'string' ? Date.parse(data.startOfMonth) : NaN;
  const resetsAt = Number.isFinite(start) ? new Date(start).setMonth(new Date(start).getMonth() + 1) : null;
  return [toWindow('premium 请求', used, limit, resetsAt)];
}

export async function fetchCursorQuota(): Promise<QuotaSnapshot> {
  const auth = readCursorAuth();
  if (!auth) return unavailable('cursor', '未登录（Cursor IDE 或 cursor-agent）');
  const claims = decodeJwt(auth.token);
  const sub = typeof claims?.sub === 'string' ? claims.sub : '';
  const userId = sub.split('|')[1] ?? '';
  if (!userId) return unavailable('cursor', 'access token 无法解析');
  if (typeof claims?.exp === 'number' && claims.exp * 1000 <= Date.now()) {
    return unavailable('cursor', 'access token 已过期，重新登录 Cursor 后自动恢复');
  }

  try {
    const data = (await quotaFetch(SUMMARY_URL, {
      Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${auth.token}`,
      Origin: 'https://cursor.com',
      Referer: 'https://cursor.com/dashboard',
      'User-Agent': BROWSER_UA,
    })) as Record<string, unknown>;
    const { windows, plan } = summaryWindows(data);
    if (windows.length === 0) {
      try {
        windows.push(...(await legacyRequestWindow(auth.token)));
      } catch {
        // 兜底端点失败不追加噪音——主端点既然回了，就按主端点口径展示。
      }
    }
    return { agent: 'cursor', plan: plan ?? auth.plan, windows, fetchedAt: Date.now() };
  } catch (e) {
    return unavailable('cursor', e instanceof Error ? e.message : '拉取失败');
  }
}
