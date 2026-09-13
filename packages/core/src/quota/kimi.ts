/**
 * kimi-code 额度 client。
 *
 * 凭据：$KIMI_CODE_HOME/credentials/kimi-code.json（OAuth access/refresh token，
 *       expires_in≈900s，CLI 自行轮换）。本模块对凭据严格只读：token 过期就降级
 *       unavailable，绝不代刷——kimi 的 refresh token 是旋转式（一次性），代刷拿到
 *       的新 token 不回写文件，CLI 手上的 RT 即被作废，下次刷新必然掉登录
 *       （2026-09 实测事故）。凭据刷新永远只属于 kimi-code CLI 本体。
 * 用量：GET {base_url}/usages（base_url 默认 https://api.kimi.com/coding/v1），
 *       实测返回 {usage{limit,used,remaining,resetTime}, limits[{window{duration,timeUnit},detail}],
 *       user.membership.level, boosterWallet, parallel}。summary 无 window 时按周窗口处理。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentPaths } from '../paths';
import type { QuotaSnapshot } from '../types';
import { quotaFetch, readJsonFile, toWindow, unavailable, windowLabel } from './common';

const DEFAULT_BASE = 'https://api.kimi.com/coding/v1';

interface KimiCreds {
  access_token: string;
  /** 只为识别文件结构，绝不使用（见文件头）。 */
  refresh_token?: string;
  expires_at?: number; // 秒
}

/** 未过期的 access_token；过期返回 null（等 CLI 自行轮换），绝不代刷。 */
function accessTokenOf(creds: KimiCreds): string | null {
  const expMs = (creds.expires_at ?? 0) * 1000;
  return expMs > Date.now() + 60_000 ? creds.access_token : null;
}

/** 从 config.toml 抠 managed:kimi-code 段的 base_url（其他 provider 的 base_url 不能混）。 */
function readBaseUrl(configPath: string): string {
  try {
    const text = readFileSync(configPath, 'utf8');
    const sec = text.match(/\[providers\."managed:kimi-code"\]([\s\S]*?)(?=\n\[|\s*$)/);
    return sec?.[1].match(/base_url\s*=\s*"([^"]+)"/)?.[1] ?? DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

export async function fetchKimiQuota(): Promise<QuotaSnapshot> {
  const credPath = join(agentPaths('kimi').credentials ?? '', 'kimi-code.json');
  const creds = readJsonFile(credPath) as unknown as KimiCreds | null;
  if (!creds?.access_token) return unavailable('kimi', '未登录（kimi login）');
  const token = accessTokenOf(creds);
  if (!token) return unavailable('kimi', 'token 已过期，等 kimi-code CLI 自行刷新');

  try {
    const base = readBaseUrl(join(agentPaths('kimi').home, 'config.toml')).replace(/\/+$/, '');
    const data = (await quotaFetch(`${base}/usages`, { Authorization: `Bearer ${token}` })) as Record<string, unknown>;

    const windows = [];
    const summary = data.usage as Record<string, unknown> | undefined;
    if (summary && typeof summary === 'object') {
      const w = (summary.window ?? {}) as Record<string, unknown>;
      windows.push(
        toWindow(
          // 实测 summary 不带 window 字段——kimi CLI 侧默认按 1 周窗口展示。
          windowLabel((w.duration as number) ?? 1, unitOf(w.timeUnit) ?? 'week'),
          Number(summary.used ?? 0),
          Number(summary.limit ?? 0),
          summary.resetTime as string,
        ),
      );
    }
    for (const l of (data.limits as unknown[]) ?? []) {
      const item = l as Record<string, unknown>;
      const detail = (item.detail ?? {}) as Record<string, unknown>;
      const w = (item.window ?? {}) as Record<string, unknown>;
      windows.push(
        toWindow(
          windowLabel(w.duration as number, unitOf(w.timeUnit)),
          Number(detail.used ?? 0),
          Number(detail.limit ?? 0),
          detail.resetTime as string,
        ),
      );
    }
    // 会员档位（LEVEL_INTERMEDIATE → Intermediate）。
    const level = ((data.user as Record<string, unknown> | undefined)?.membership as Record<string, unknown> | undefined)
      ?.level;
    const plan = typeof level === 'string' ? level.replace(/^LEVEL_/, '').toLowerCase() : undefined;
    return { agent: 'kimi', plan, windows, fetchedAt: Date.now() };
  } catch (e) {
    return unavailable('kimi', e instanceof Error ? e.message : '拉取失败');
  }
}

/** TIME_UNIT_HOUR → "hour" 归一化（kimi 用枚举字符串）。 */
function unitOf(raw: unknown): string | undefined {
  const m = /^TIME_UNIT_(\w+)$/i.exec(String(raw ?? ''));
  return m ? m[1].toLowerCase() : typeof raw === 'string' ? raw.toLowerCase() : undefined;
}
