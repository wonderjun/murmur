/**
 * 文件体量门禁（移植 flow-core file_size_ratchet_test.go 的棘轮模型）。
 *
 * repo 级门禁寄居 core 测试目录——`bun run test` 只跑 packages/core，
 * 但扫描范围覆盖 packages/core/src 与 apps/desktop/src 两侧源码。
 *
 * 口径（与 flow 两侧门禁一致）：有效行 = 去空行 + 去纯注释行；
 * 行内 // 注释与含代码行照常计入，/* 块注释整段不计。
 *   - 新文件硬上限 500 有效行、软上限 400（软上限只 log 不 fail）；
 *   - 存量超限文件进 RATCHET 逐文件锁死当前有效行数，只许降不许升，
 *     缩到 ≤500 后必须删除条目（毕业自清）；勿调大数值、勿给新文件加条目；
 *   - EXEMPTIONS 只收「聚合度高于行数」的例外且必须写清理由；
 *     components/ui/ 前缀豁免（shadcn 复制式组件库，不手工维护体量）；
 *   - 测试文件（*.test.* / *.spec.*）豁免（体量是被测对象的镜像）。
 *
 * 拆分触发器与手法速查见 .agent/skill/code-style 「文件体量」节。
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 硬上限（有效行）：越过即 fail。 */
const HARD_CAP = 500;
/** 软上限（有效行）：只 log 提醒，不 fail。 */
const SOFT_CAP = 400;

/** 棘轮表：key=仓库相对路径，value=登记时有效行数。只许降不许升，达标删条目。 */
const RATCHET: Record<string, number> = {};

/** 显式豁免：聚合度高于行数的例外，value 必须写清理由。勿当超限避风港。 */
const EXEMPTIONS: Record<string, string> = {};

/** 前缀豁免：复制式组件库不手工维护体量。 */
const EXEMPT_PREFIXES = ['apps/desktop/src/mainview/components/ui/'];

/** 统计有效行：非空且非纯注释行；/* 块注释整段跳过。 */
function effectiveLines(path: string): number {
  let count = 0;
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    let line = raw.trim();
    if (line === '') continue;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
      if (line === '') continue;
    }
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
      if (line === '') continue;
    }
    count++;
  }
  return count;
}

/** 递归收集目录下的 .ts/.tsx 源码文件（跳过测试文件）。 */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(p));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('文件体量门禁', () => {
  test('无超限、棘轮只降不升、条目不失效', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const files = ['packages/core/src', 'apps/desktop/src'].flatMap((d) => collectSources(join(root, d)));

    const problems: string[] = [];
    const approaching: string[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const rel = relative(root, file).split('\\').join('/');
      seen.add(rel);
      if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
      if (rel in EXEMPTIONS) continue;
      const eff = effectiveLines(file);
      const lock = RATCHET[rel];
      if (lock !== undefined) {
        if (eff > lock) {
          problems.push(`${rel} 有效行 ${eff} 超过棘轮锁定值 ${lock}（只许降不许升）`);
        } else if (eff <= HARD_CAP) {
          problems.push(`${rel} 有效行 ${eff} 已达标 ≤${HARD_CAP}，请删除棘轮条目`);
        }
        continue;
      }
      if (eff > HARD_CAP) {
        problems.push(`${rel} 有效行 ${eff} 超过硬上限 ${HARD_CAP}（新文件不得进棘轮，按职责拆分或申请豁免）`);
      } else if (eff > SOFT_CAP) {
        approaching.push(`${rel} ${eff}`);
      }
    }

    for (const rel of [...Object.keys(RATCHET), ...Object.keys(EXEMPTIONS)]) {
      if (!seen.has(rel)) problems.push(`棘轮/豁免条目失效（文件不存在）: ${rel}`);
    }
    for (const rel of Object.keys(EXEMPTIONS)) {
      if (rel in RATCHET) problems.push(`${rel} 同时出现在棘轮与豁免清单，二选一`);
    }

    if (approaching.length > 0) {
      console.log(`接近软上限 ${SOFT_CAP} 的文件（提示非阻断）:\n  ${approaching.sort().join('\n  ')}`);
    }
    expect(problems.sort()).toEqual([]);
  });
});
