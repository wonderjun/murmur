/**
 * 测试全局 preload（bunfig.toml [test].preload 先于一切测试文件执行）：
 * 把所有 env 敏感路径钉进临时沙箱——MURMUR_HOME 在 paths.ts 模块加载时固化，
 * 而 bun test 多文件共享模块缓存，任一测试文件的静态 import 都可能先把它冻成真机
 * 家目录；这里统一钉死，ingest/endpoint/spool/migrate 的写入永远落不进 ~/.murmur。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'murmur-test-root-'));

process.env.MURMUR_HOME = join(root, 'murmur');
process.env.MURMUR_KIMI_HOME = join(root, 'kimi');
process.env.MURMUR_ZCODE_HOME = join(root, 'zcode');
process.env.MURMUR_CODEX_HOME = join(root, 'codex');
process.env.MURMUR_CURSOR_HOME = join(root, 'cursor');
process.env.MURMUR_OPENCODE_DATA = join(root, 'oc-data');
process.env.MURMUR_OPENCODE_CONFIG = join(root, 'oc-config');
// devin/qoder 的路径同样 env 可覆盖（agentPaths 函数体内读取）：不钉的话，
// 未自查的测试构造 devin/qoder adapter 会读到真机 ~/.local/share/devin 与 ~/.qoder。
process.env.MURMUR_DEVIN_DATA = join(root, 'devin');
process.env.MURMUR_DEVIN_CONFIG = join(root, 'devin-config');
process.env.MURMUR_QODER_HOME = join(root, 'qoder');
process.env.MURMUR_MINIMAX_HOME = join(root, 'minimax');
