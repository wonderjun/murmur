/**
 * 从 Electrobun devkit 的 tsconfig paths 生成 `apps/desktop/tsconfig.json`。
 *
 * desktop 的 `paths` 是整字段覆盖、不走 extends：devkit 表里的值相对 devkit 根
 * （`./api/...`），这里改写成 `./.hutch/devkit/` 前缀，再追加项目别名 `@/*` 与 `@core/*`。
 * Electrobun 条目数量随 devkit 变化，不在本文件写死。
 *
 *   bun scripts/sync-desktop-tsconfig.ts
 *   bun scripts/sync-desktop-tsconfig.ts --check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** devkit 路径在 desktop tsconfig 里的统一前缀（相对 apps/desktop）。 */
const DEVKIT_PREFIX = './.hutch/devkit/';

/** 项目自有别名，必须排在 devkit 映射之后，避免被同名条目盖掉。 */
const PROJECT_ALIASES: Record<string, string[]> = {
  '@/*': ['./src/mainview/*'],
  '@core/*': ['../../packages/core/src/*'],
};

const INCLUDE = ['src', 'env.d.ts'];
const EXCLUDE = ['node_modules', 'dist', 'build', '../../package/dist'];

export interface DesktopTsconfig {
  compilerOptions: {
    target: 'ESNext';
    useDefineForClassFields: true;
    module: 'ESNext';
    resolveJsonModule: true;
    allowJs: true;
    isolatedModules: true;
    moduleDetection: 'force';
    noEmit: true;
    strict: true;
    noUnusedLocals: true;
    noUnusedParameters: true;
    noFallthroughCasesInSwitch: true;
    moduleResolution: 'bundler';
    jsx: 'react-jsx';
    paths: Record<string, string[]>;
    skipLibCheck: true;
  };
  include: string[];
  exclude: string[];
}

/** 把 devkit tsconfig 里的相对路径改成 desktop 工程根下的 `.hutch/devkit` 路径。 */
export function prefixDevkitSpecifier(specifier: string): string {
  if (specifier.startsWith('./')) return `${DEVKIT_PREFIX}${specifier.slice(2)}`;
  throw new Error(`devkit path 必须是相对 devkit 根的 ./ 路径，收到 ${specifier}`);
}

/** 用 devkit paths 组装 desktop tsconfig；compilerOptions 其余字段保持工程约定。 */
export function buildDesktopTsconfig(devkit: unknown): DesktopTsconfig {
  const paths = devkitPaths(devkit);
  const names = Object.keys(paths);
  if (names.length === 0) throw new Error('devkit tsconfig 的 compilerOptions.paths 是空的');
  for (const alias of Object.keys(PROJECT_ALIASES)) {
    if (alias in paths) throw new Error(`devkit paths 占用了项目别名 ${alias}`);
  }
  const mapped: Record<string, string[]> = {};
  for (const name of names) mapped[name] = paths[name].map(prefixDevkitSpecifier);
  return {
    compilerOptions: {
      target: 'ESNext',
      useDefineForClassFields: true,
      module: 'ESNext',
      resolveJsonModule: true,
      allowJs: true,
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      paths: { ...mapped, ...PROJECT_ALIASES },
      skipLibCheck: true,
    },
    include: [...INCLUDE],
    exclude: [...EXCLUDE],
  };
}

/** 稳定序列化，供 --check 做字节级对比。 */
export function renderDesktopTsconfig(doc: DesktopTsconfig): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 读 devkit、写或核对 desktop tsconfig。返回进程退出码。 */
export function syncDesktopTsconfig(argv: string[]): number {
  const args = parseArgs(argv);
  const devkitPath = resolve(args.devkit);
  let raw: string;
  try {
    raw = readFileSync(devkitPath, 'utf8');
  } catch {
    throw new Error(
      `找不到 Electrobun devkit tsconfig：${devkitPath}\n` +
        '先在 apps/desktop 执行 hutch electrobun sync（.hutch 被 gitignore；CI 用官方 install.sh 安装 hutch，不依赖开发机 ~/.hutch）。',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`devkit tsconfig 不是合法 JSON：${devkitPath}`);
  }
  const next = renderDesktopTsconfig(buildDesktopTsconfig(parsed));
  const outPath = resolve(args.out);
  if (args.check) {
    let current: string;
    try {
      current = readFileSync(outPath, 'utf8');
    } catch {
      throw new Error(`找不到 desktop tsconfig：${outPath}`);
    }
    if (current !== next) {
      console.error(
        `${display(outPath)} 与 devkit paths 不一致。运行 bun run sync:tsconfig 后提交。\n${driftText(next, current)}`,
      );
      return 1;
    }
    const count = Object.keys(JSON.parse(next).compilerOptions.paths).length - Object.keys(PROJECT_ALIASES).length;
    console.log(`${display(outPath)} 与 devkit 一致（${count} 条 electrobun paths）`);
    return 0;
  }
  writeFileSync(outPath, next);
  const count = Object.keys(JSON.parse(next).compilerOptions.paths).length - Object.keys(PROJECT_ALIASES).length;
  console.log(`写入 ${display(outPath)}（${count} 条 electrobun paths）`);
  return 0;
}

function devkitPaths(devkit: unknown): Record<string, string[]> {
  if (devkit === null || typeof devkit !== 'object' || Array.isArray(devkit)) {
    throw new Error('devkit tsconfig 不是对象');
  }
  const compilerOptions = (devkit as { compilerOptions?: unknown }).compilerOptions;
  if (compilerOptions === null || typeof compilerOptions !== 'object' || Array.isArray(compilerOptions)) {
    throw new Error('devkit tsconfig 缺少 compilerOptions');
  }
  const paths = (compilerOptions as { paths?: unknown }).paths;
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new Error('devkit tsconfig 缺少 compilerOptions.paths');
  }
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(paths)) {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
      throw new Error(`devkit path ${name} 不是非空字符串数组`);
    }
    out[name] = value;
  }
  return out;
}

function parseArgs(argv: string[]): { check: boolean; devkit: string; out: string } {
  const repo = join(import.meta.dir, '..');
  let check = false;
  let devkit = join(repo, 'apps/desktop/.hutch/devkit/tsconfig.json');
  let out = join(repo, 'apps/desktop/tsconfig.json');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--devkit' || arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} 缺少路径`);
      if (arg === '--devkit') devkit = value;
      else out = value;
      continue;
    }
    throw new Error(`未知参数 ${arg}（支持 --check、--devkit、--out）`);
  }
  return { check, devkit, out };
}

function display(path: string): string {
  if (isAbsolute(path)) {
    const rel = relative(join(import.meta.dir, '..'), path);
    if (rel && !rel.startsWith('..')) return rel;
  }
  return path;
}

function driftText(generated: string, current: string): string {
  const next = generated.split('\n');
  const prev = current.split('\n');
  const lines: string[] = [];
  const n = Math.max(next.length, prev.length);
  for (let i = 0; i < n; i++) {
    if (next[i] === prev[i]) continue;
    lines.push(`@@ ${i + 1}`);
    lines.push(`- ${prev[i] ?? ''}`);
    lines.push(`+ ${next[i] ?? ''}`);
    if (lines.length >= 60) {
      lines.push('...');
      break;
    }
  }
  return lines.join('\n');
}

if (import.meta.main) {
  try {
    process.exit(syncDesktopTsconfig(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
