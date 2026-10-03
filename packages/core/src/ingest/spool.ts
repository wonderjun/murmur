/**
 * Spool 回收：hook 脚本在 ingest 不可达时把 payload 落盘到
 * ~/.murmur/spool/<agent>.jsonl；这里负责启动时 + 周期性补投。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from '../paths';
import type { AgentId } from '../types';

const SPOOL_DIR = join(MURMUR_HOME, 'spool');

/** 把 spool 里暂存的 payload 逐条补投给 translate。返回补投条数。dir 仅测试注入。 */
export function drainSpool(translate: (agent: AgentId, payload: unknown) => void, dir = SPOOL_DIR): number {
  let count = 0;
  try {
    if (!existsSync(dir)) return 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const agent = file.replace(/\.jsonl$/, '') as AgentId;
      const path = join(dir, file);
      const archive = `${path}.${Date.now()}.done`;
      try {
        renameSync(path, archive);
        for (const line of readFileSync(archive, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            translate(agent, JSON.parse(line));
            count += 1;
          } catch {
            // 坏行或单条翻译失败：跳过，继续同一文件的其余行。
          }
        }
      } catch {
        // 单个文件被占用或不是可读文件：跳过，继续其余文件。
      }
    }
    // .done 存档已补投完成，24h 后清掉防堆积。
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.done')) continue;
      try {
        const p = join(dir, file);
        if ((statSync(p).mtimeMs ?? 0) < Date.now() - 86400_000) rmSync(p);
      } catch {
        // 文件被占用等场景跳过本轮。
      }
    }
    mkdirSync(dir, { recursive: true });
  } catch {
    // spool 目录本身不可读时跳过本轮，不打断启动与定时补投。
  }
  return count;
}
