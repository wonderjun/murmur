/**
 * 一次性迁移：perch 时代的数据与安装制品搬家。
 *
 * 老版本把数据放在 ~/.perch，并把 hook 脚本 / opencode 插件落进各 agent 目录。
 * 启动时做两件事：
 *   1. legacy ~/.perch 整体复制到 ~/.murmur（旧目录保留不删，作后悔药），库文件
 *      改名 perch.db → murmur.db（WAL/SHM 一起），hook 脚本内容换词根——改写后
 *      脚本即指向新 endpoint/spool，旧安装数据无缝续用；
 *   2. 改写散落在 agent 目录里的旧制品（cursor hooks.json、codex config.toml、
 *      opencode 插件），只动引用 legacy 家目录（~/.perch 或 PERCH_HOME）或
 *      带旧 hook 标记的串。改写后的条目含新 HOOKS_DIR 路径，
 *      能被新安装器识别为自己的条目，不会产生重复安装。
 *   3. 摘除 perch 注入过但 murmur 未收编的宿主配置（claude settings.json）
 *      ——这些条目指向死端点，留着只会空转 spool；devin config.json 自
 *      devin adapter 收编后走换词根改写（同 cursor 块），不再摘除。
 *
 * 幂等：目标目录已存在则跳过搬迁；制品清扫每次启动都跑，重复执行是 no-op，
 * 绝不碰 orca/otty 等他人条目（只认 legacy 家目录路径归属，裸 "perch" 子串不算）。
 */

import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { agentPaths, MURMUR_HOME } from './paths';

/** perch 时代的家目录（尊重旧版本的 PERCH_HOME 覆盖语义）。 */
export const LEGACY_PERCH_HOME = process.env.PERCH_HOME ?? join(homedir(), '.perch');

/** 品牌词根替换：PERCH/Perch/perch → MURMUR/Murmur/murmur。 */
function rebrand(text: string): string {
  return text.replace(/PERCH/g, 'MURMUR').replace(/Perch/g, 'Murmur').replace(/perch/g, 'murmur');
}

/**
 * 判断字符串是否引用 perch 时代的制品（旧家目录路径或 PERCH_HOME 覆盖路径）。
 * 只按路径归属判，不按裸 "perch" 子串——percheron、~/code/perch-sim 这类
 * 用户自己的串绝不能被改写。
 */
function referencesLegacyHome(text: string, legacyHome: string): boolean {
  return text.includes(legacyHome) || text.includes('.perch/');
}

/** 深度改写 JSON 结构里的字符串值（仅引用 legacy 家目录的才算我们的条目）。返回是否有改动。 */
function rebrandJsonStrings(node: unknown, legacyHome: string): boolean {
  let changed = false;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (typeof v[i] === 'string' && referencesLegacyHome(v[i] as string, legacyHome)) {
          v[i] = rebrand(v[i] as string);
          changed = true;
        } else if (v[i] && typeof v[i] === 'object') {
          visit(v[i]);
        }
      }
      return;
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        const val = (v as Record<string, unknown>)[k];
        if (typeof val === 'string' && referencesLegacyHome(val, legacyHome)) {
          (v as Record<string, unknown>)[k] = rebrand(val);
          changed = true;
        } else if (val && typeof val === 'object') {
          visit(val);
        }
      }
    }
  };
  visit(node);
  return changed;
}

/** 搬迁 legacy 家目录：整体复制 + 库文件改名 + hook 脚本内容换词根。 */
function migrateHomeDir(home: string, legacy: string): boolean {
  if (legacy === home || !existsSync(legacy) || existsSync(home)) return false;
  try {
    cpSync(legacy, home, { recursive: true });
  } catch {
    // 复制失败（权限/磁盘满）时放弃本轮，下次启动重试；绝不 crash。
    return false;
  }
  // 库文件跟新名字走（Ledger 只认 murmur.db）；在打开前改名，WAL 会自动恢复。
  for (const suffix of ['', '-wal', '-shm']) {
    const old = join(home, `perch.db${suffix}`);
    if (existsSync(old)) renameSync(old, join(home, `murmur.db${suffix}`));
  }
  // agent-hooks 脚本是我们独占生成的，内容整体换词根（endpoint/spool 路径 + 头 + 标记）。
  const hooksDir = join(home, 'agent-hooks');
  if (existsSync(hooksDir)) {
    for (const f of readdirSync(hooksDir)) {
      if (!f.endsWith('.sh')) continue;
      const p = join(hooksDir, f);
      try {
        writeFileSync(p, rebrand(readFileSync(p, 'utf8')));
        chmodSync(p, 0o755);
      } catch {
        // 单文件失败跳过，不影响其余文件。
      }
    }
  }
  return true;
}

/** perch 注入过但 murmur 未收编的宿主 hook 配置（死端点条目摘除目标）。 */
function legacyDeadHookConfigs(userHome: string): string[] {
  // devin config.json 曾在此列——devin adapter 收编后老条目换词根即可续用，
  // 移到下方 rebrand 块处理。
  return [join(userHome, '.claude', 'settings.json')];
}

/** 摘除 JSON hook 配置中含 legacy agent-hooks 路径的整条 entry（他人条目原样保留）。 */
export function dropLegacyHookEntries(cfg: Record<string, unknown>, marker: string): boolean {
  const hooks = cfg.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  let changed = false;
  for (const [ev, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !JSON.stringify(entry).includes(marker));
    if (kept.length !== list.length) {
      changed = true;
      if (kept.length) (hooks as Record<string, unknown>)[ev] = kept;
      else delete (hooks as Record<string, unknown>)[ev]; // 事件条目清空后连键一起摘。
    }
  }
  return changed;
}

/** 清扫 agent 目录里的旧制品：每次启动幂等执行，只动含 perch 的串。 */
function rebrandAgentArtifacts(legacyHome: string, deadConfigs: string[]): void {
  // cursor：hooks.json 里我们的 command 串含旧路径——JSON 级改写，他人条目原样。
  const cursorCfg = agentPaths('cursor').hookConfig;
  if (cursorCfg && existsSync(cursorCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(cursorCfg, 'utf8')) as Record<string, unknown>;
      if (rebrandJsonStrings(cfg, legacyHome)) writeFileSync(cursorCfg, JSON.stringify(cfg, null, 2));
    } catch {
      // 配置损坏/被占用时不碰它，避免误伤用户配置。
    }
  }
  // codex：config.toml 里只有引用 legacy 家目录的行（notify 路径）或
  // 我们写过的注释标记（# perch hook / perch-hook）是我们的。
  const codexCfg = agentPaths('codex').hookConfig;
  if (codexCfg && existsSync(codexCfg)) {
    try {
      const text = readFileSync(codexCfg, 'utf8');
      const next = text
        .split('\n')
        .map((line) =>
          referencesLegacyHome(line, legacyHome) || line.includes('perch hook') || line.includes('perch-hook')
            ? rebrand(line)
            : line,
        )
        .join('\n');
      if (next !== text) writeFileSync(codexCfg, next);
    } catch {
      // 读取失败跳过本轮。
    }
  }
  // opencode：插件文件换名 + 内容换词根；旧文件改名退役而非删除，便于排查。
  const pluginsDir = agentPaths('opencode').hookConfig;
  if (pluginsDir && existsSync(pluginsDir)) {
    const legacyPlugin = join(pluginsDir, 'perch-status.js');
    const newPlugin = join(pluginsDir, 'murmur-status.js');
    try {
      if (existsSync(legacyPlugin) && !existsSync(newPlugin)) {
        writeFileSync(newPlugin, rebrand(readFileSync(legacyPlugin, 'utf8')));
        renameSync(legacyPlugin, `${legacyPlugin}.migrated`);
      }
    } catch {
      // 迁移失败时旧插件继续指向死路径静默失败，不影响其余采集平面。
    }
  }
  // devin：config.json 的 hooks 键与 cursor 同法换词根——perch 条目指向
  // ~/.murmur/agent-hooks/devin.sh（migrateHomeDir 已把脚本搬过去并换词根）。
  const devinCfg = agentPaths('devin').hookConfig;
  if (devinCfg && existsSync(devinCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(devinCfg, 'utf8')) as Record<string, unknown>;
      if (rebrandJsonStrings(cfg, legacyHome)) writeFileSync(devinCfg, JSON.stringify(cfg, null, 2));
    } catch {
      // 配置损坏/被占用时不碰它，避免误伤用户配置。
    }
  }
  // claude-code：perch 注过 hook 但 murmur 无对应 adapter——改写没有意义
  // （指过来只会收 404 变死信），整条摘除。marker 用本机 legacy 绝对路径，只认我们的脚本。
  const marker = join(legacyHome, 'agent-hooks');
  for (const cfgPath of deadConfigs) {
    if (!existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      if (dropLegacyHookEntries(cfg, marker)) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch {
      // 配置损坏/被占用时不碰它，避免误伤用户配置。
    }
  }
}

/**
 * 启动迁移入口：搬迁 legacy 家目录 + 清扫 agent 制品。
 * 返回本次是否发生了家目录搬迁（纯清扫不算）。
 */
export function migrateLegacyHome(opts?: {
  home?: string;
  legacyHome?: string;
  deadHookConfigs?: string[];
}): boolean {
  const legacy = opts?.legacyHome ?? LEGACY_PERCH_HOME;
  const migrated = migrateHomeDir(opts?.home ?? MURMUR_HOME, legacy);
  rebrandAgentArtifacts(legacy, opts?.deadHookConfigs ?? legacyDeadHookConfigs(homedir()));
  return migrated;
}
