/**
 * desktop tsconfig 同步：devkit paths 加前缀、追加项目别名，--check 能抓住 drift。
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDesktopTsconfig, prefixDevkitSpecifier, renderDesktopTsconfig } from './sync-desktop-tsconfig';

const repo = join(import.meta.dir, '..');
const script = join(import.meta.dir, 'sync-desktop-tsconfig.ts');

describe('prefixDevkitSpecifier', () => {
  test('去掉 devkit 相对前缀再挂到 .hutch/devkit 下', () => {
    expect(prefixDevkitSpecifier('./api/sdks/main/index.ts')).toBe('./.hutch/devkit/api/sdks/main/index.ts');
  });

  test('绝对路径或越出 devkit 根的路径拒绝', () => {
    expect(() => prefixDevkitSpecifier('/abs/index.ts')).toThrow();
    expect(() => prefixDevkitSpecifier('../outside.ts')).toThrow();
  });
});

describe('buildDesktopTsconfig', () => {
  test('条目数跟随 devkit，项目别名追加在末尾', () => {
    const doc = buildDesktopTsconfig({
      compilerOptions: {
        paths: {
          electrobun: ['./api/sdks/main/index.ts'],
          'electrobun/view': ['./api/browser/index.ts'],
        },
      },
    });
    const names = Object.keys(doc.compilerOptions.paths);
    expect(names).toEqual(['electrobun', 'electrobun/view', '@/*', '@core/*']);
    expect(doc.compilerOptions.paths.electrobun).toEqual(['./.hutch/devkit/api/sdks/main/index.ts']);
    expect(doc.compilerOptions.paths['@/*']).toEqual(['./src/mainview/*']);
    expect(doc.compilerOptions.paths['@core/*']).toEqual(['../../packages/core/src/*']);
    expect(doc.compilerOptions.jsx).toBe('react-jsx');
    expect(doc.include).toEqual(['src', 'env.d.ts']);
  });

  test('空 paths 或占用项目别名时失败，避免写坏 tsconfig', () => {
    expect(() => buildDesktopTsconfig({ compilerOptions: { paths: {} } })).toThrow();
    expect(() =>
      buildDesktopTsconfig({ compilerOptions: { paths: { '@/*': ['./keep/*'] } } }),
    ).toThrow();
  });

  test('序列化稳定且以换行结尾', () => {
    const doc = buildDesktopTsconfig({
      compilerOptions: { paths: { electrobun: ['./api/sdks/main/index.ts'] } },
    });
    const text = renderDesktopTsconfig(doc);
    expect(text.endsWith('\n')).toBe(true);
    expect(renderDesktopTsconfig(doc)).toBe(text);
  });
});

describe('CLI', () => {
  test('--check 对得上就退出 0，改一个 specifier 就退出 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-tsconfig-'));
    const devkit = join(dir, 'devkit.json');
    const out = join(dir, 'tsconfig.json');
    writeFileSync(
      devkit,
      JSON.stringify({ compilerOptions: { paths: { electrobun: ['./api/sdks/main/index.ts'] } } }),
    );
    const wrote = run(['--devkit', devkit, '--out', out]);
    expect(wrote.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('./.hutch/devkit/api/sdks/main/index.ts');
    const ok = run(['--check', '--devkit', devkit, '--out', out]);
    expect(ok.status).toBe(0);
    const drifted = JSON.parse(readFileSync(out, 'utf8'));
    drifted.compilerOptions.paths.electrobun = ['./stale.ts'];
    writeFileSync(out, `${JSON.stringify(drifted, null, 2)}\n`);
    const bad = run(['--check', '--devkit', devkit, '--out', out]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('sync:tsconfig');
  });

  test('当前仓库的 desktop tsconfig 与已同步 devkit 一致', () => {
    const result = run(['--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

function run(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync('bun', [script, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr ?? '' };
}
