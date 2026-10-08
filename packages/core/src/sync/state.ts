/**
 * 同步状态账本：~/.murmur/sync-state.json（0600）。
 *
 * 记「我方往各 MCP 配置文件写过哪些 server key」——剔除只删曾是我方写的 key，
 * 同名他人 key 永不删（归属凭证，等价 hook 的脚本路径判归属）。
 * skill 侧的归属不靠本文件：目标目录里的 .murmur-managed marker 行尾烙着源 sig，
 * 读 marker 即知「是不是我方拷贝、拷的是哪一版」。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from '../paths';

/** 同步账本形状；缺失键按首次同步处理。 */
export interface SyncState {
  /** 目标配置文件路径 → 我方写入过的 server key 集。 */
  mcpKeys: Record<string, string[]>;
}

/** 读账本：文件缺失/损坏回空表（首次同步语义）。dir 供测试注入。 */
export function loadSyncState(dir = MURMUR_HOME): SyncState {
  const file = join(dir, 'sync-state.json');
  if (!existsSync(file)) return { mcpKeys: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SyncState>;
    return { mcpKeys: { ...raw.mcpKeys } };
  } catch {
    // 损坏文件不回写——写成功时自然重建；清空语义即「全部按新写处理」。
    return { mcpKeys: {} };
  }
}

/** 写账本：原子写（tmp + chmod 0600 + rename），与 settings.ts 同手法。dir 供测试注入。 */
export function saveSyncState(state: SyncState, dir = MURMUR_HOME): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'sync-state.json');
  const tmp = `${file}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
