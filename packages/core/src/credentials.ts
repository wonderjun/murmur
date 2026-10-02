/**
 * BYOK 凭据存储：~/.murmur/credentials.json。
 *
 * 用户主动提供给 Murmur 的 API Key（如 z.ai/智谱开放平台），用于 quota 平面
 * 拉取那些本地凭据加密不可读的 agent（首发 zcode——enc:v1 是私有格式）。
 *
 * 安全契约：
 *   - 与「agent 凭据严格只读」禁区不冲突——这是 Murmur 自有存储，写自己。
 *   - 绝不进 MurmurSettings：settings.json 会经 getSettings RPC 整包发给
 *     webview，key 一旦混进去就出了进程边界。对外只给 maskKey 掩码。
 *   - 与 settings.json 同口径：原子写（tmp+rename）、0600、损坏回空表不覆写。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from './paths';
import type { AgentId } from './types';

/** 单个 agent 的 BYOK 凭据。baseUrl 用于区域端点手动覆盖（缺省走自动判定）。 */
export interface ByokCredential {
  apiKey: string;
  baseUrl?: string;
  updatedAt: number;
}

/** per-agent BYOK 表；缺省即未配置。 */
export type ByokStore = Partial<Record<AgentId, ByokCredential>>;

/** 读凭据：文件缺失/损坏/形状不符回空表。dir 供测试注入。 */
export function loadCredentials(dir = MURMUR_HOME): ByokStore {
  const file = join(dir, 'credentials.json');
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: ByokStore = {};
    for (const [k, v] of Object.entries(raw)) {
      const c = v as Record<string, unknown> | null;
      if (c && typeof c.apiKey === 'string' && c.apiKey) {
        out[k as AgentId] = {
          apiKey: c.apiKey,
          ...(typeof c.baseUrl === 'string' && c.baseUrl ? { baseUrl: c.baseUrl } : {}),
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
        };
      }
    }
    return out;
  } catch {
    // 损坏文件不当真源，也不覆写——同 settings.json 口径。
    return {};
  }
}

/** 写凭据：原子写（tmp + rename），0600。dir 供测试注入。 */
export function saveCredentials(store: ByokStore, dir = MURMUR_HOME): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'credentials.json');
  const tmp = `${file}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** 掩码预览（RPC/快照对外唯一形态）：`sk-…ab12`，过短则纯掩码。 */
export function maskKey(apiKey: string): string {
  return apiKey.length > 8 ? `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}` : '•••';
}
