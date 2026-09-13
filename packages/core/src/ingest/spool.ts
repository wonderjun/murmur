/**
 * Spool 回收：hook 脚本在 ingest 不可达时把 payload 落盘到
 * ~/.murmur/spool/<agent>.jsonl；这里负责启动时 + 周期性补投。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from '../paths';
import type { AgentId } from '../types';

const SPOOL_DIR = join(MURMUR_HOME, 'spool');

/** 把 spool 里暂存的 payload 逐条补投给 translate。返回补投条数。 */
export function drainSpool(translate: (agent: AgentId, payload: unknown) => void): number {
  if (!existsSync(SPOOL_DIR)) return 0;
  let count = 0;
  for (const file of readdirSync(SPOOL_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    const agent = file.replace(/\.jsonl$/, '') as AgentId;
    const path = join(SPOOL_DIR, file);
    const archive = `${path}.${Date.now()}.done`;
    try {
      renameSync(path, archive);
      for (const line of readFileSync(archive, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          translate(agent, JSON.parse(line));
          count += 1;
        } catch {
          // 坏行跳过。
        }
      }
    } catch {
      // 文件被占用等场景跳过本轮。
    }
  }
  // .done 存档已补投完成，24h 后清掉防堆积。
  for (const file of readdirSync(SPOOL_DIR)) {
    if (!file.endsWith('.done')) continue;
    try {
      const p = join(SPOOL_DIR, file);
      if ((statSync(p).mtimeMs ?? 0) < Date.now() - 86400_000) rmSync(p);
    } catch {
      // 文件被占用等场景跳过本轮。
    }
  }
  mkdirSync(SPOOL_DIR, { recursive: true });
  return count;
}
