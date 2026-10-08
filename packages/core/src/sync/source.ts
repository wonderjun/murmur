/**
 * 同步源盘点：~/.murmur/skills/<name>/ 技能包与 ~/.murmur/mcp.json 的 mcpServers 条目。
 *
 * 这里是「同步模块的唯一源」：目标侧永远以本目录为准做同步（技能挂软链、MCP
 * merge），不做从 agent 目录回收入源（决策已定，外部工具管辖目录也只读不写）。
 * sig 是轻量签名（SKILL.md 字节 + 相对文件清单的 FNV-1a）——不做全文件树 hash，
 * 够表达「源改没改」；软链模式下 sig 只作导入去重与盘点参考，归属看链目标。
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { MURMUR_HOME } from '../paths';
import type { SkillImportResult } from '../types';

/** 旧版 v1 实体拷贝的归属标记文件名（检出即待迁移软链，不再写入）。 */
export const SKILL_MARKER = '.murmur-managed';
/** skillshare 管辖目录的标记文件名（目录根存在即整目录只读）。 */
export const SKILLSHARE_MANIFEST = '.skillshare-manifest.json';
/** 导入扫描的最大层深（srcDir 本身=0，最多下探 srcDir/a/b/c/SKILL.md）。 */
const IMPORT_MAX_DEPTH = 3;

/** 同步源里的一个技能包。 */
export interface SourceSkill {
  /** frontmatter 的 name 缺省回落目录名（写目标与去重的键）。 */
  name: string;
  /** 源目录绝对路径（删除/复制用）。 */
  path: string;
  description?: string;
  /** SKILL.md 内容 + 文件清单的 FNV-1a hex。 */
  sig: string;
  hasSkillMd: boolean;
}

/** FNV-1a 32bit（小串、无依赖；sig 只做一致性比对不做安全用途）。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * frontmatter 单字段提取：只解析首个 --- 块内的 `key: value` 行（不做 YAML 解析——
 * kimi/omp 的 SKILL.md frontmatter 实测就是这形状）。引号包裹的值去壳。
 */
export function frontmatterField(text: string, key: string): string | undefined {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return undefined;
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^\s*([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (m?.[1] !== key) continue;
    const v = m[2]
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim();
    return v || undefined;
  }
  return undefined;
}

/** 目录下相对文件清单（稳定序）：sig 的成分，`/` 分隔、按字典序排。 */
function fileList(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

/** 单个源目录 → SourceSkill（读失败按无 SKILL.md 的空包处理——盘点要可见，同步再跳过）。 */
function readSkillDir(dir: string): SourceSkill {
  const dirName = dir.slice(dir.lastIndexOf('/') + 1);
  const skillMd = join(dir, 'SKILL.md');
  const hasSkillMd = existsSync(skillMd);
  let text = '';
  let files: string[] = [];
  try {
    if (hasSkillMd) text = readFileSync(skillMd, 'utf8');
    files = fileList(dir);
  } catch {
    // 目录并发删除/权限问题：按残缺包盘点（sig 空），不抛断整轮。
  }
  return {
    name: frontmatterField(text, 'name') ?? dirName,
    path: dir,
    description: frontmatterField(text, 'description'),
    sig: fnv1a(`${text}\n${files.join('\n')}`),
    hasSkillMd,
  };
}

/** 盘点源技能目录（~/.murmur/skills 的一级子目录）。目录缺席/不可读回空表。 */
export function listSourceSkills(dir = join(MURMUR_HOME, 'skills')): SourceSkill[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSkillDir(join(dir, e.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // 源目录还没建（首次使用）——盘点空表，不算错。
    return [];
  }
}

/** object → string 键 Record（Object.entries 逐键收敛，值类型 unknown 不编造形状）。 */
function asStringRecord(v: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v));
}

/** 读源 MCP 配置（~/.murmur/mcp.json 的 mcpServers 键）；文件缺失/损坏/无该键回 {}。 */
export function readSourceMcp(path = join(MURMUR_HOME, 'mcp.json')): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const servers = 'mcpServers' in parsed ? parsed.mcpServers : undefined;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    return asStringRecord(servers);
  } catch {
    // 源缺席=没有要同步的 MCP；损坏不覆写（用户手改中，下轮自愈）。
    return {};
  }
}

/** 读单条源 MCP 定义（编辑回填/探测用）；缺席/非对象回 null。 */
export function sourceMcpEntry(name: string, path = join(MURMUR_HOME, 'mcp.json')): Record<string, unknown> | null {
  const v = readSourceMcp(path)[name];
  return v && typeof v === 'object' && !Array.isArray(v) ? asStringRecord(v) : null;
}

/**
 * 新建/更新源 MCP 条目：defText 是含 mcpServers 键的整段 JSON（UI 编辑器原文）。
 * origName 是编辑前的键名（新建传 null）——提交键集不含 origName 即删旧键（改名/清空即删）。
 * 逐条校验（对象 + 有 command 或 url）；任一条不合法/解析失败/源文件损坏都不落盘。
 */
export function saveSourceMcp(
  origName: string | null,
  defText: string,
  path = join(MURMUR_HOME, 'mcp.json'),
): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(defText);
  } catch {
    return { ok: false, error: 'JSON 解析失败' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '要贴整段 {"mcpServers":{…}}' };
  }
  const servers = 'mcpServers' in parsed ? parsed.mcpServers : undefined;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ok: false, error: 'mcpServers 必须是对象' };
  }
  const entries = Object.entries(servers);
  for (const [k, v] of entries) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `"${k}" 的定义必须是 JSON 对象` };
    const hasCommand = 'command' in v && typeof v.command === 'string' && v.command.length > 0;
    const hasUrl = 'url' in v && typeof v.url === 'string' && v.url.length > 0;
    if (!hasCommand && !hasUrl) return { ok: false, error: `"${k}" 缺 command（stdio）或 url（remote）` };
  }
  let cfg: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) cfg = asStringRecord(raw);
      else return { ok: false, error: 'mcp.json 顶层不是对象——先手动修复' };
    }
  } catch {
    // 损坏文件不覆写（用户可能在手改）——报回 UI 去修。
    return { ok: false, error: 'mcp.json 损坏，无法写入' };
  }
  const existing = 'mcpServers' in cfg ? cfg.mcpServers : undefined;
  const next = existing && typeof existing === 'object' && !Array.isArray(existing) ? asStringRecord(existing) : {};
  const submitted = new Set(entries.map(([k]) => k));
  for (const [k, v] of entries) next[k] = v;
  // 编辑场景改名即删旧键：origName 不在提交的键集里就是「这条没了」（清空=删除）。
  if (origName && !submitted.has(origName)) delete next[origName];
  cfg.mcpServers = next;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.murmur-tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

/**
 * 把本地目录里的技能包拷进源根（手动管理的导入通道）。
 * srcDir/SKILL.md 存在则整目录当一个包（不深入）；否则下探最多 3 层找
 * `SKILL.md` 命中目录——遇到即收、不深入其子树（包内嵌 SKILL.md 属包内容）。
 * 目录判定走 statSync：Dirent.isDirectory() 不跟随软链，技能目录常软链。
 * 目标已有同名目录 → skipped（绝不覆盖——源根的包可能已被用户改）。失败静默不抛。
 */
export function importSkills(srcDir: string, destRoot: string): SkillImportResult {
  const imported: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
    return { imported, skipped: [{ name: srcDir, reason: '目录不可读' }] };
  }
  const candidates: string[] = [];
  try {
    if (existsSync(join(srcDir, 'SKILL.md'))) candidates.push(srcDir);
    else {
      // BFS 逐层枚举；命中目录即收包、不再下探其子树（包内嵌 SKILL.md 属包内容）。
      // isDirectory 判定走 statSync——Dirent.isDirectory() 不跟随软链，技能目录常软链。
      let frontier = [srcDir];
      for (let depth = 1; depth <= IMPORT_MAX_DEPTH; depth++) {
        const next: string[] = [];
        for (const base of frontier) {
          for (const ent of readdirSync(base)) {
            const p = join(base, ent);
            if (!statSync(p, { throwIfNoEntry: false })?.isDirectory()) continue;
            if (existsSync(join(p, 'SKILL.md'))) candidates.push(p);
            else next.push(p);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
    }
  } catch {
    return { imported, skipped: [{ name: srcDir, reason: '目录不可读' }] };
  }
  mkdirSync(destRoot, { recursive: true });
  for (const pkg of candidates) {
    const name = pkg.slice(pkg.lastIndexOf('/') + 1);
    try {
      if (existsSync(join(destRoot, name))) {
        skipped.push({ name, reason: '同名目录已存在' });
        continue;
      }
      cpSync(pkg, join(destRoot, name), { recursive: true });
      imported.push(name);
    } catch (e) {
      skipped.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { imported, skipped };
}
