/**
 * Hook 安装器：把生成的 sh 脚本落到 ~/.murmur/agent-hooks/，再把调用命令
 * 合并进各 agent 的 hook 配置文件。
 *
 * 铁律：合并而非覆盖——本机可能已有 orca/otty 等工具注入的同类 hook，
 * 追加自己的条目、保留别人的条目，卸载时只删带 HOOK_MARKER 的条目。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from '../paths';
import type { AgentId } from '../types';
import { HOOK_MARKER, renderHookScript } from './script';

/** hook 脚本落盘目录（~/.murmur/agent-hooks/<agent>.sh）；诊断面 hookTargets 引用。 */
export const HOOKS_DIR = join(MURMUR_HOME, 'agent-hooks');

/** 写出脚本并返回调用命令（含存在性自检 + stdin 兜底 cat，同 orca 风格）。 */
export function writeHookScript(agent: AgentId, opts?: { stdoutAck?: boolean }): string {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const path = join(HOOKS_DIR, `${agent}.sh`);
  writeFileSync(path, renderHookScript(agent, opts));
  chmodSync(path, 0o755);
  return `if [ -f '${path}' ] && [ -x '${path}' ]; then /bin/sh '${path}'; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`;
}

/** 该 agent 的 hook 是否已由我们安装。 */
export function isHookInstalled(agent: AgentId): boolean {
  return existsSync(join(HOOKS_DIR, `${agent}.sh`));
}

/** hook 命令对象：直挂 {command,timeout}——嵌套 {"hooks":[...]} 组形状只有 IDE 跑，cursor-agent CLI 不触发。 */
function hookEntry(command: string) {
  return { command, timeout: 10 };
}

/** 配置里是否已有我们的条目（按标记路径判断，直挂/嵌套两形状都识别）。 */
function hasOurHook(entries: unknown): boolean {
  return JSON.stringify(entries ?? []).includes(HOOKS_DIR);
}

/** 该事件下是否已有我们的直挂条目（CLI 只跑直挂形状，嵌套组不算装好）。 */
function hasOurDirectHook(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => {
    const cmd = (e as Record<string, unknown> | null)?.command;
    return typeof cmd === 'string' && cmd.includes(HOOKS_DIR);
  });
}

/** zcode 式 hook 条目：command + async 旁路——fire-and-forget，stdout 不可能干预决策链。 */
function zcodeHookEntry(command: string) {
  return { hooks: [{ type: 'command' as const, command, async: true, timeoutMs: 10_000 }] };
}

/**
 * 纯配置合并（zcode schema，无 fs 副作用，便于单测）。返回是否有改动。
 * schema：`hooks.events.<Event>[]` 装条目 + `hooks.enabled` 全局开关。
 * enabled 显式 false 是用户意愿不抢开关（条目照写但保持不生效，detect 会提示）。
 */
export function mergeZcodeConfig(cfg: Record<string, unknown>, command: string, events: string[]): boolean {
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const evs = (hooks.events ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const ev of events) {
    // 非数组存量值（对象/字符串）包进数组保留，不静默清掉用户配置。
    const cur = evs[ev];
    const list = Array.isArray(cur) ? [...cur] : cur != null ? [cur] : [];
    if (!hasOurHook(list)) {
      list.push(zcodeHookEntry(command));
      changed = true;
    }
    evs[ev] = list;
  }
  hooks.events = evs;
  if (typeof hooks.enabled !== 'boolean') {
    hooks.enabled = true;
    changed = true;
  }
  cfg.hooks = hooks;
  return changed;
}

/** zcode hook 生效态：active=配置齐且 enabled:true；disabled=用户显式关闭；none=未注入。 */
export function zcodeHookState(configPath: string | null): 'active' | 'disabled' | 'none' {
  if (!configPath || !existsSync(configPath)) return 'none';
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
    const evs = (hooks.events ?? {}) as Record<string, unknown>;
    if (!Object.values(evs).some((list) => hasOurHook(list))) return 'none';
    return hooks.enabled === true ? 'active' : 'disabled';
  } catch {
    return 'none';
  }
}

/** codex 式 hook 条目：matcher-group 包 command handler（hooks.json 官方 schema 形状）。
 * 无 matcher 即全量匹配；async 后台执行不阻塞 agent 决策链，timeout 5s 足够脚本自限的 1.5s curl。 */
function codexHookEntry(command: string) {
  return { hooks: [{ type: 'command' as const, command, async: true, timeout: 5 }] };
}

/**
 * 纯配置合并（codex hooks.json schema，无 fs 副作用，便于单测）。返回是否有改动。
 * schema：`hooks.<Event>[]` 装 matcher-group；与 zcode 同样只加不减，已有我们的条目即跳过。
 */
export function mergeCodexHooksConfig(cfg: Record<string, unknown>, command: string, events: string[]): boolean {
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const ev of events) {
    const cur = hooks[ev];
    const list = Array.isArray(cur) ? [...cur] : cur != null ? [cur] : [];
    if (!hasOurHook(list)) {
      list.push(codexHookEntry(command));
      changed = true;
    }
    hooks[ev] = list;
  }
  cfg.hooks = hooks;
  return changed;
}

/**
 * 合并写入 codex `~/.codex/hooks.json`。同铁律：追加不覆盖、原子写、脚本丢失自愈。
 * 注意：codex 的非 managed hook 需用户在 `/hooks` 里 trust 后才执行（按定义 hash 记录），
 * 装好≠生效——生效引导在 adapter detect 的 note 里。
 */
export function mergeCodexHooks(configPath: string, agent: AgentId, events: string[]): { changed: boolean } {
  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // 配置损坏时不碰它，避免误伤用户配置。
      return { changed: false };
    }
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  // 脚本无条件重写：让旧版脚本随启动自愈升级到最新模板（command 串不变，
  // 不影响 codex 的 trust hash——它按命令字符串而非文件内容记）。
  const command = writeHookScript(agent);
  if (events.every((ev) => hasOurHook(hooks[ev]))) return { changed: false };
  mergeCodexHooksConfig(cfg, command, events);
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/** devin 式 hook 条目：matcher-group 包 command handler——与 orca 实测条目同构；
 * 不带 async（devin hook schema 未文档化该字段，保守按文档形状写）。 */
function devinHookEntry(command: string) {
  return { hooks: [{ type: 'command' as const, command, timeout: 10 }] };
}

/**
 * 纯配置合并（devin ~/.config/devin/config.json 的 hooks 键 schema，无 fs 副作用）。
 * 与 codex 同铁律：只加不减、已有我们的条目即跳过、他人条目（orca 等）原样保留。
 */
export function mergeDevinHooksConfig(cfg: Record<string, unknown>, command: string, events: string[]): boolean {
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const ev of events) {
    const cur = hooks[ev];
    const list = Array.isArray(cur) ? [...cur] : cur != null ? [cur] : [];
    if (!hasOurHook(list)) {
      list.push(devinHookEntry(command));
      changed = true;
    }
    hooks[ev] = list;
  }
  cfg.hooks = hooks;
  return changed;
}

/**
 * 合并写入 devin `~/.config/devin/config.json`（用户级配置的 hooks 键）。
 * 铁律同上：追加不覆盖、原子写、脚本丢失自愈；config.json 是 devin 本体在管的
 * 用户配置（permissions/mcp/devin.org_id 等同住），只动 hooks 子树。
 */
export function mergeDevinHooks(configPath: string, agent: AgentId, events: string[]): { changed: boolean } {
  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // 配置损坏时不碰它，避免误伤用户配置。
      return { changed: false };
    }
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const command = writeHookScript(agent);
  if (events.every((ev) => hasOurHook(hooks[ev]))) return { changed: false };
  mergeDevinHooksConfig(cfg, command, events);
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/** devin config.json 的 hooks 键里是否已有我们的条目（脚本路径片段判归属）。 */
export function devinHooksRegistered(configPath: string | null): boolean {
  if (!configPath || !existsSync(configPath)) return false;
  try {
    return readFileSync(configPath, 'utf8').includes('agent-hooks/devin.sh');
  } catch {
    // 读不了算未注册。
    return false;
  }
}

/** qoder 式 hook 条目：与 codex 同构的 matcher-group（官方 settings.json schema），
 * async 后台跑不阻塞 agent 决策链；timeout 单位是秒（默认 600），脚本自限 1.5s 给 10s 余量。 */
function qoderHookEntry(command: string) {
  return { hooks: [{ type: 'command' as const, command, async: true, timeout: 10 }] };
}

/**
 * 纯配置合并（qoder ~/.qoder/settings.json 的 hooks 键 schema，无 fs 副作用）。
 * 与 codex/devin 同铁律：只加不减、已有我们的条目即跳过、他人条目原样保留。
 */
export function mergeQoderHooksConfig(cfg: Record<string, unknown>, command: string, events: string[]): boolean {
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const ev of events) {
    const cur = hooks[ev];
    const list = Array.isArray(cur) ? [...cur] : cur != null ? [cur] : [];
    if (!hasOurHook(list)) {
      list.push(qoderHookEntry(command));
      changed = true;
    }
    hooks[ev] = list;
  }
  cfg.hooks = hooks;
  return changed;
}

/**
 * 合并写入 qoder `~/.qoder/settings.json`。该文件是 agent 本体在管的共享配置
 * （providers/enabledPlugins 等同住，含用户 API key）——只动 hooks 子树，其余键
 * 原样保留；原子写同其他 merge*。官方文档明示配置改完即生效，无 trust 门槛。
 */
export function mergeQoderHooks(configPath: string, agent: AgentId, events: string[]): { changed: boolean } {
  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // 配置损坏时不碰它，避免误伤用户配置。
      return { changed: false };
    }
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const command = writeHookScript(agent);
  if (events.every((ev) => hasOurHook(hooks[ev]))) return { changed: false };
  mergeQoderHooksConfig(cfg, command, events);
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/** qoder settings.json 的 hooks 键里是否已有我们的条目（脚本路径片段判归属）。 */
export function qoderHooksRegistered(configPath: string | null): boolean {
  if (!configPath || !existsSync(configPath)) return false;
  try {
    return readFileSync(configPath, 'utf8').includes('agent-hooks/qoder.sh');
  } catch {
    // 读不了算未注册。
    return false;
  }
}

/** claude-code 式 hook 条目：官方 settings.json matcher-group（{matcher?,hooks:[{type:command,...}]}）。
 * async 后台执行不阻塞 agent 会话（command hook 官方支持 async；async 条目官方明示
 * 不 enforce timeout——timeout 是给不认 async 的旧版本兜底的 10s 保险丝，脚本本身
 * 已自限 ~1.5s curl）。 */
function claudeHookEntry(command: string) {
  return { hooks: [{ type: 'command' as const, command, async: true, timeout: 10 }] };
}

/**
 * 纯配置合并（claude ~/.claude/settings.json 的 hooks 键 schema，无 fs 副作用）。
 * 与 codex/devin/qoder 同铁律：只加不减、已有我们的条目即跳过、他人条目原样保留。
 * settings.json 是共享用户配置（permissions/env/model 等同住），只碰 hooks 子树。
 */
export function mergeClaudeHooksConfig(cfg: Record<string, unknown>, command: string, events: string[]): boolean {
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const ev of events) {
    const cur = hooks[ev];
    const list = Array.isArray(cur) ? [...cur] : cur != null ? [cur] : [];
    if (!hasOurHook(list)) {
      list.push(claudeHookEntry(command));
      changed = true;
    }
    hooks[ev] = list;
  }
  cfg.hooks = hooks;
  return changed;
}

/**
 * 合并写入 claude `~/.claude/settings.json`（用户级配置的 hooks 键）。
 * 铁律同上：追加不覆盖、原子写、脚本丢失自愈；官方 hook 改配置即生效、无 trust 门槛。
 * stdout {} 是合法 JSON 不注入上下文（仅 SessionStart/UserPromptSubmit 注入纯文本 stdout）。
 */
export function mergeClaudeHooks(configPath: string, agent: AgentId, events: string[]): { changed: boolean } {
  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // 配置损坏时不碰它，避免误伤用户配置。
      return { changed: false };
    }
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const command = writeHookScript(agent);
  if (events.every((ev) => hasOurHook(hooks[ev]))) return { changed: false };
  mergeClaudeHooksConfig(cfg, command, events);
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/** claude settings.json 的 hooks 键里是否已有我们的条目（脚本路径片段判归属）。 */
export function claudeHooksRegistered(configPath: string | null): boolean {
  if (!configPath || !existsSync(configPath)) return false;
  try {
    return readFileSync(configPath, 'utf8').includes('agent-hooks/claude-code.sh');
  } catch {
    // 读不了算未注册。
    return false;
  }
}

/**
 * 合并写入 zcode 用户级 hook 配置（`~/.zcode/cli/config.json`）。
 * 与 mergeJsonHooks 同铁律：追加不覆盖；原子写；脚本丢失时自愈重建。
 */
export function mergeZcodeHooks(configPath: string, agent: AgentId, events: string[]): { changed: boolean } {
  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // 配置损坏时不碰它，避免误伤用户配置。
      return { changed: false };
    }
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const evs = (hooks.events ?? {}) as Record<string, unknown>;
  const command = writeHookScript(agent); // 脚本无条件重写，随启动升级模板。
  const settled = typeof hooks.enabled === 'boolean' && events.every((ev) => hasOurHook(evs[ev]));
  if (settled) return { changed: false };
  mergeZcodeConfig(cfg, command, events);
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/**
 * 合并写入 JSON 型 hook 配置（如 cursor `~/.cursor/hooks.json` 的 "hooks" key）。
 * events 为该 agent 要挂的事件名列表。原子写：先临时文件再 rename。
 */
export function mergeJsonHooks(configPath: string, agent: AgentId, events: string[]): { changed: boolean } {
  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // 配置损坏时不碰它，避免误伤用户配置。
      return { changed: false };
    }
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown[]>;
  // 脚本无条件重写：丢失自愈 + 随启动升级到最新模板。
  const command = writeHookScript(agent);
  if (events.every((ev) => hasOurDirectHook(hooks[ev]))) return { changed: false };

  for (const ev of events) {
    const cur = hooks[ev];
    const list = Array.isArray(cur) ? cur : cur != null ? [cur] : [];
    // 滤掉我们旧条目（嵌套组/直挂都算）再重挂成直挂，老安装自动迁移、不双发；
    // 他人条目（orca 等）原样保留。
    const kept = list.filter((entry) => !hasOurHook([entry]));
    kept.push(hookEntry(command));
    hooks[ev] = kept;
  }
  cfg.hooks = hooks;
  // CLI 要求顶层 version:1；用户已写其他版本号时不覆盖。
  if (cfg.version === undefined) cfg.version = 1;
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/** 切出 TOML 文本里的所有 [[hooks]] 块（header 行起到下一个 [ 头或 EOF）。 */
function tomlHookBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) {
      if (cur) blocks.push(cur.join('\n'));
      cur = line.trim() === '[[hooks]]' ? [line] : null;
      continue;
    }
    cur?.push(line);
  }
  if (cur) blocks.push(cur.join('\n'));
  return blocks;
}

/**
 * 我们的块：命令里出现 agent-hooks/<agent>.sh 路径尾。
 * 不用 `# murmur-hook` marker 判归属——kimi 重写 config.toml 会把注释丢掉
 * （0.41 实测），marker 只写给人类看；路径尾才是耐久信号。
 */
function isOurTomlBlock(block: string, agent: AgentId): boolean {
  return block.includes(`agent-hooks/${agent}.sh`);
}

/** config.toml 里我们已挂的事件集合（marker 注释/脚本路径认归属）。 */
function tomlHookEvents(text: string, agent: AgentId): Set<string> {
  const ours = new Set<string>();
  for (const b of tomlHookBlocks(text)) {
    if (!isOurTomlBlock(b, agent)) continue;
    const ev = /^\s*event\s*=\s*"([^"]+)"/m.exec(b)?.[1];
    if (ev) ours.add(ev);
  }
  return ours;
}

/** config.toml 中是否已有我们的 hook 块（detect 用；不要求全集，部分挂上也算已接入）。 */
export function tomlHookInstalled(configPath: string | null, agent: AgentId): boolean {
  if (!configPath || !existsSync(configPath)) return false;
  try {
    return tomlHookEvents(readFileSync(configPath, 'utf8'), agent).size > 0;
  } catch {
    return false;
  }
}

/**
 * 纯文本合并（无 fs 副作用，便于单测）：把我们缺的事件 [[hooks]] 块 EOF 追加进
 * 配置文本，他人条目原样保留。command 只含单引号与 $——JSON.stringify 产出即合法
 * TOML 基本串。
 */
export function mergeTomlHooksText(
  text: string,
  agent: AgentId,
  command: string,
  events: string[],
): { text: string; changed: boolean } {
  const have = tomlHookEvents(text, agent);
  const missing = events.filter((ev) => !have.has(ev));
  if (missing.length === 0) return { text, changed: false };
  let out = text && !text.endsWith('\n') ? `${text}\n` : text;
  for (const ev of missing) {
    out += `\n# ${HOOK_MARKER} ${agent}\n[[hooks]]\nevent = "${ev}"\ncommand = ${JSON.stringify(command)}\ntimeout = 10\n`;
  }
  return { text: out, changed: true };
}

/**
 * 合并写入 TOML 型 hook 配置（kimi `~/.kimi-code/config.toml` 的 [[hooks]] 数组表）。
 * 铁律同 mergeJsonHooks：只 EOF 追加缺的事件块，他人条目（otty/orca 等）原样保留；
 * 脚本丢失时自愈重建。原子写：先临时文件再 rename。
 */
export function mergeTomlHooks(
  configPath: string,
  agent: AgentId,
  events: string[],
  opts?: { stdoutAck?: boolean },
): { changed: boolean } {
  const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const have = tomlHookEvents(text, agent);
  const hadScript = isHookInstalled(agent);
  // 脚本无条件重写：丢失自愈 + 随启动升级到最新模板。
  const command = writeHookScript(agent, opts);
  if (events.every((ev) => have.has(ev)) && hadScript) return { changed: false };
  const merged = mergeTomlHooksText(text, agent, command, events);
  if (merged.changed) {
    mkdirSync(join(configPath, '..'), { recursive: true });
    const tmp = `${configPath}.murmur-tmp`;
    writeFileSync(tmp, merged.text);
    chmodSync(tmp, 0o600);
    renameSync(tmp, configPath);
  }
  return { changed: merged.changed || !hadScript };
}

/** 从 JSON 配置中卸载我们的 hook 条目（保留他人条目）。 */
export function unmergeJsonHooks(configPath: string): { changed: boolean } {
  if (!existsSync(configPath)) return { changed: false };
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { changed: false };
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown[]>;
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    const list = hooks[ev];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !hasOurHook([entry]));
    if (kept.length !== list.length) {
      hooks[ev] = kept;
      changed = true;
    }
  }
  if (changed) {
    cfg.hooks = hooks;
    // 原子写同 mergeJsonHooks——直写在中途崩溃会截断整个文件（含他人条目）。
    const tmp = `${configPath}.murmur-tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, configPath);
  }
  return { changed };
}

/** 删除 hook 脚本文件（~/.murmur/agent-hooks/<agent>.sh）。配置条目已移除后脚本成孤儿，删失败也无副作用。 */
export function removeHookScript(agent: AgentId): void {
  try {
    const path = join(HOOKS_DIR, `${agent}.sh`);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 配置侧已卸载，脚本文件残留不影响行为（无引用即死代码）。
  }
}

/**
 * 卸载 TOML 型 hook 配置（kimi config.toml）：删掉命中 `agent-hooks/<agent>.sh`
 * 的整个 [[hooks]] 块及其前置 marker 注释行，他人块与非 hooks 内容原样保留。
 */
export function unmergeTomlHooks(configPath: string, agent: AgentId): { changed: boolean } {
  if (!existsSync(configPath)) return { changed: false };
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    // 读不了的配置不碰。
    return { changed: false };
  }
  const marker = new RegExp(`^#\\s*${HOOK_MARKER.replace(' ', '\\s+')}\\s*${agent}\\s*$`);
  const kept: string[] = [];
  let block: string[] | null = null;
  let changed = false;
  const flush = () => {
    if (!block) return;
    if (isOurTomlBlock(block.join('\n'), agent)) {
      changed = true;
      // mergeTomlHooksText 在我方块前写一行 marker 注释，顺手清掉。
      if (kept.length && marker.test(kept[kept.length - 1]!)) kept.pop();
    } else {
      kept.push(...block);
    }
    block = null;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) {
      flush();
      if (line.trim() === '[[hooks]]') block = [line];
      else kept.push(line);
      continue;
    }
    (block ?? kept).push(line);
  }
  flush();
  if (!changed) return { changed: false };
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, kept.join('\n'));
  renameSync(tmp, configPath);
  return { changed: true };
}

/** 卸载 zcode hook 条目：`hooks.events.*` 滤掉我方项；`hooks.enabled` 是用户自己的开关，不碰。 */
export function unmergeZcodeHooks(configPath: string): { changed: boolean } {
  if (!existsSync(configPath)) return { changed: false };
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { changed: false };
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const evs = (hooks.events ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const ev of Object.keys(evs)) {
    const list = evs[ev];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !hasOurHook([entry]));
    if (kept.length !== list.length) {
      evs[ev] = kept;
      changed = true;
    }
  }
  if (!changed) return { changed: false };
  hooks.events = evs;
  cfg.hooks = hooks;
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true };
}

/**
 * 卸载 codex legacy notify：config.toml 的 `notify = [...]` 行剔除我方脚本路径；
 * 数组因此清空则删整行。只处理单行数组形状（mergeCodexNotify 写出的就是这种）。
 */
export function unmergeCodexNotify(configPath: string, agent: AgentId): { changed: boolean } {
  if (!existsSync(configPath)) return { changed: false };
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return { changed: false };
  }
  const scriptRef = `agent-hooks/${agent}.sh`;
  const kept: string[] = [];
  let changed = false;
  for (const line of text.split('\n')) {
    const m = /^(\s*notify\s*=\s*)\[(.*)\]\s*$/.exec(line);
    if (!m || !line.includes(scriptRef)) {
      kept.push(line);
      continue;
    }
    const items = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.includes(scriptRef));
    changed = true;
    // mergeCodexNotify 在我方 notify 前写过一行注释，顺手摘掉不留孤儿。
    if (kept.length && /^\s*#\s*murmur hook/.test(kept[kept.length - 1]!)) kept.pop();
    if (items.length) kept.push(`${m[1]}[${items.join(', ')}]`);
  }
  if (!changed) return { changed: false };
  const tmp = `${configPath}.murmur-tmp`;
  writeFileSync(tmp, kept.join('\n'));
  renameSync(tmp, configPath);
  return { changed: true };
}

