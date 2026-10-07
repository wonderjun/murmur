/**
 * claude 额度平面：订阅 OAuth 凭据 → api.anthropic.com/api/oauth/usage。
 *
 * 凭据位置（官方约定 + 社区工具一致实测）：
 *   - macOS：登录 Keychain，service "Claude Code-credentials"；CLAUDE_CONFIG_DIR
 *     指向非默认目录时 service 带后缀 -<sha256(dir)[:8]>。经 /usr/bin/security 读——
 *     取密码（-w）可能触发系统 ACL 授权弹窗一次（用户可选 Always Allow），
 *     弹窗挂起时走超时杀进程降级，不阻塞刷新链路。
 *   - Linux/旧版/兜底：<configDir>/.credentials.json（0600），同构
 *     {claudeAiOauth:{accessToken,refreshToken,expiresAt,subscriptionType,rateLimitTier}}。
 *
 * 禁区（凭据严格只读、绝不代刷）：refresh_token 是旋转式——代刷不回写即作废登录态；
 * accessToken 过期直接降级 unavailable，刷新永远属于 CLI 本体（`claude /login`）。
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentPaths } from '../paths';
import type { QuotaSnapshot, QuotaWindow } from '../types';
import { quotaFetch, readJsonFile, unavailable } from './common';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 5000;

/** Claude OAuth 凭据——claudeAiOauth 子对象的最小读取面（凭据文件与 Keychain 同构）。 */
export interface ClaudeOAuth {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** 解析凭据 JSON 的 claudeAiOauth 段；非对象/无 token 返回 null。accessToken 脱敏走调用方。 */
export function parseClaudeCredentials(raw: unknown): ClaudeOAuth | null {
  const oauth = (raw as Record<string, unknown> | null)?.claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) return null;
  const o = oauth as Record<string, unknown>;
  if (typeof o.accessToken !== 'string' || o.accessToken.length === 0) return null;
  return {
    accessToken: o.accessToken,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
    rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : undefined,
  };
}

/** 非默认配置目录时 Keychain service 带目录哈希后缀（sha256 前 8 位）。 */
function keychainServices(dir: string): string[] {
  const list = [KEYCHAIN_SERVICE];
  if (dir !== join(homedir(), '.claude')) {
    list.push(`${KEYCHAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`);
  }
  return list;
}

/**
 * Keychain 条目存在性探测（读元数据不取密码，不触发 ACL 弹窗）。
 * 仅给 detect/hasCredentials 用；取 secret 走 readKeychainSecret。
 */
function keychainHasItem(dir: string): boolean {
  for (const service of keychainServices(dir)) {
    try {
      const r = Bun.spawnSync(['/usr/bin/security', 'find-generic-password', '-s', service], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      if (r.exitCode === 0) return true;
    } catch {
      // security 缺席（非 macOS 或裁剪系统）→ 下一候选。
    }
  }
  return false;
}

/** 读 Keychain secret（-w 只吐密码到 stdout）；ACL 弹窗挂起走超时杀进程，读不到/过期返回 null。 */
async function readKeychainSecret(dir: string): Promise<string | null> {
  for (const service of keychainServices(dir)) {
    try {
      const proc = Bun.spawn(['/usr/bin/security', 'find-generic-password', '-s', service, '-w'], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // 已退出。
        }
      }, KEYCHAIN_TIMEOUT_MS);
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      clearTimeout(timer);
      if (code === 0 && out.trim()) return out.trim();
    } catch {
      // 下一候选。
    }
  }
  return null;
}

/** 本地凭据总探测：Keychain 条目存在 或 .credentials.json 存在。 */
export function hasClaudeOAuth(): boolean {
  const { home, credentials } = agentPaths('claude-code');
  if (credentials && existsSync(credentials)) return true;
  return platform() === 'darwin' && keychainHasItem(home);
}

/** 凭据读取：macOS 先试 Keychain，文件兜底；过期直接 null（绝不代刷，见文件头禁区）。 */
async function readClaudeOAuth(): Promise<ClaudeOAuth | null> {
  const { home, credentials } = agentPaths('claude-code');
  if (platform() === 'darwin') {
    const raw = await readKeychainSecret(home);
    if (raw) {
      try {
        const creds = parseClaudeCredentials(JSON.parse(raw));
        if (creds) return creds.expiresAt != null && creds.expiresAt <= Date.now() ? null : creds;
      } catch {
        // Keychain 值不是预期 JSON → 试文件兜底。
      }
    }
  }
  if (credentials) {
    const creds = parseClaudeCredentials(readJsonFile(credentials));
    if (creds) return creds.expiresAt != null && creds.expiresAt <= Date.now() ? null : creds;
  }
  return null;
}

/** 官方 usage 响应的单窗口段 {utilization:0-100, resets_at:ISO|null} → 归一化 QuotaWindow。 */
function usageWindow(label: string, seg: unknown): QuotaWindow | null {
  if (typeof seg !== 'object' || seg === null) return null;
  const s = seg as Record<string, unknown>;
  if (typeof s.utilization !== 'number') return null;
  const resetsAt = typeof s.resets_at === 'string' ? Date.parse(s.resets_at) : null;
  return {
    label,
    usedPct: Math.max(0, Math.min(100, Math.round(s.utilization))),
    resetsAt: resetsAt != null && Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/**
 * /api/oauth/usage 响应 → QuotaSnapshot。
 * 窗口：five_hour（5h）/ seven_day（每周）/ seven_day_opus / seven_day_sonnet /
 * seven_day_oauth_apps（历史 tier 才有，缺失跳过）；extra_usage 是超额计费档
 * （is_enabled 才展示，used_credits/monthly_limit 单位美分）。
 */
export function claudeUsageToSnapshot(body: unknown, plan?: string): QuotaSnapshot {
  const b = (body ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const push = (label: string, key: string) => {
    const w = usageWindow(label, b[key]);
    if (w) windows.push(w);
  };
  push('5h', 'five_hour');
  push('每周', 'seven_day');
  push('Opus 每周', 'seven_day_opus');
  push('Sonnet 每周', 'seven_day_sonnet');
  const extra = b.extra_usage as Record<string, unknown> | undefined;
  if (extra?.is_enabled === true && typeof extra.utilization === 'number') {
    const w: QuotaWindow = {
      label: '额外用量',
      usedPct: Math.max(0, Math.min(100, Math.round(extra.utilization))),
      resetsAt: null,
    };
    // 账单窗口额度字段是美分，换算成美元展示。
    if (typeof extra.used_credits === 'number') w.used = extra.used_credits / 100;
    if (typeof extra.monthly_limit === 'number') w.limit = extra.monthly_limit / 100;
    windows.push(w);
  }
  return {
    agent: 'claude-code',
    fetchedAt: Date.now(),
    plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined,
    windows,
  };
}

/**
 * 拉 Claude Code 订阅额度。静默降级全集：无凭据/token 过期（不代刷，交回 CLI）/
 * 非 200 / 网络异常 → unavailable 快照（registry 负责回退上次有效值）。
 */
export async function fetchClaudeQuota(): Promise<QuotaSnapshot> {
  const creds = await readClaudeOAuth();
  if (!creds) return unavailable('claude-code', '无本地 OAuth 凭据或 accessToken 已过期');
  try {
    const json = await quotaFetch(USAGE_URL, {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA,
    });
    return claudeUsageToSnapshot(json, creds.subscriptionType ?? creds.rateLimitTier);
  } catch {
    return unavailable('claude-code', 'usage 端点拉取失败');
  }
}
