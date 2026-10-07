/**
 * 缺省 adapter 清单：生产形态的九家真 adapter 一次组装。
 * 从 registry 拆出——注册表的职责是编排不是名单；opts.adapters 注入时本表不生效。
 */

import type { AgentAdapter } from './base';
import { createCodexAdapter } from './codex';
import { createCursorAdapter } from './cursor';
import { createDevinAdapter } from './devin';
import { createKimiAdapter } from './kimi';
import { createMinimaxAdapter } from './minimax';
import { createOmpAdapter } from './omp';
import { createOpencodeAdapter } from './opencode';
import { createQoderAdapter } from './qoder';
import { createZcodeAdapter } from './zcode';

/** 生产形态 adapter 全量（顺序即诊断/设置页遍历序）。 */
export function defaultAdapters(): AgentAdapter[] {
  return [
    createKimiAdapter(),
    createZcodeAdapter(),
    createOpencodeAdapter(),
    createCodexAdapter(),
    createCursorAdapter(),
    createDevinAdapter(),
    createQoderAdapter(),
    createMinimaxAdapter(),
    createOmpAdapter(),
  ];
}
