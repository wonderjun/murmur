/**
 * Hook 端点文件：把 ingest 服务的端口与令牌写到 ~/.murmur/endpoint（0600），
 * 供各 agent 的 hook 脚本 source（同 orca 的 ORCA_AGENT_HOOK_ENDPOINT 模式）。
 *
 * 文件是 shell env 格式，hook 脚本 `.` 它后得到 MURMUR_AGENT_HOOK_PORT/TOKEN。
 */

import { chmodSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { MURMUR_HOME } from '../paths';

const ENDPOINT_FILE = join(MURMUR_HOME, 'endpoint');

export interface HookEndpoint {
  port: number;
  token: string;
  file: string;
}

/** 生成或复用令牌，写出 endpoint 文件并返回端点描述。 */
export function writeEndpointFile(port: number): HookEndpoint {
  mkdirSync(MURMUR_HOME, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const content = `# murmur ingest endpoint — sourced by agent hook scripts.
MURMUR_AGENT_HOOK_PORT=${port}
MURMUR_AGENT_HOOK_TOKEN=${token}
export MURMUR_AGENT_HOOK_PORT MURMUR_AGENT_HOOK_TOKEN
`;
  writeFileSync(ENDPOINT_FILE, content, { mode: 0o600 });
  chmodSync(ENDPOINT_FILE, 0o600);
  return { port, token, file: ENDPOINT_FILE };
}

/**
 * 撤下端点文件：murmur 停止后 hook 脚本不应再往旧端口投递——
 * 端口会被系统回收，期间被其他进程绑定就会收下含 prompt/cwd 的 payload。
 */
export function removeEndpointFile() {
  try {
    rmSync(ENDPOINT_FILE);
  } catch {
    // 文件可能已不在或目录不可写——尽力而为。
  }
}

/** 读取当前端点（若存在）。 */
export function readEndpointFile(): { port: number; token: string } | null {
  if (!existsSync(ENDPOINT_FILE)) return null;
  const text = readFileSync(ENDPOINT_FILE, 'utf8');
  const port = /MURMUR_AGENT_HOOK_PORT=(\d+)/.exec(text)?.[1];
  const token = /MURMUR_AGENT_HOOK_TOKEN=([0-9a-f]+)/.exec(text)?.[1];
  return port && token ? { port: Number(port), token } : null;
}
