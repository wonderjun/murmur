/**
 * MCP 配置合并器：把源 ~/.murmur/mcp.json 的 mcpServers 条目按各 agent 目标
 * schema（mcpServers / zcode 的 mcp.servers / opencode 的 mcp / codex TOML）
 * 合并进目标配置。
 *
 * 铁律同 hook merge*：只写我方条目（sync-state.json 的 mcpKeys 记归属）、他人
 * 条目原样保留、同 key 异值（只可能手改）跳过记 conflict；剔除只删曾是我方写的
 * key。canonical def = 源条目的形状：stdio {command,args?,env?,cwd?} /
 * remote {url,headers?}，可带 type/transport。
 */

import type { McpSchema } from './targets';
import type { AgentId } from '../types';

/** 单目标合并回执：changed=文件内容需要落盘；written=实际落笔的我方 key。 */
export interface McpMergeResult {
  changed: boolean;
  /** 本轮实际写入的目标 key（成为新的 mcpKeys 归属集）。 */
  written: string[];
  /** 同 key 异值的他人条目（跳过，不覆盖）。 */
  conflicts: string[];
  /** 从 mcpKeys 归属集剔除的 key（源已删）。 */
  removed: string[];
}

/** 深比较（JSON 值域；键序无关）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  return (
    ak.length === bk.length &&
    ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** def 归一：非对象条目丢弃；remote 的 "http" 别名归一成 streamable-http。 */
function canonicalDef(def: unknown): Record<string, unknown> | null {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return null;
  const d = { ...(def as Record<string, unknown>) };
  if (d.type === 'http' && typeof d.url === 'string') d.type = 'streamable-http';
  return d;
}

/** per-agent 字段补丁：cursor/minimax 官方 schema 里 stdio/remote 的 type 必填。 */
function patchDefForAgent(agent: AgentId, def: Record<string, unknown>): Record<string, unknown> {
  const d = { ...def };
  if ((agent === 'cursor' || agent === 'minimax') && d.type === undefined && d.transport === undefined) {
    d.type = typeof d.command === 'string' ? 'stdio' : 'streamable-http';
  }
  return d;
}

/** canonical def → opencode 条目（官方 schema：local/remote 两形，command 是数组）。 */
function opencodeEntry(def: Record<string, unknown>): Record<string, unknown> {
  if (typeof def.command === 'string') {
    const out: Record<string, unknown> = {
      type: 'local',
      command: [
        def.command,
        ...(Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : []),
      ],
      enabled: true,
    };
    // opencode 本地 server 的环境变量字段名是 environment（非 mcpServers 的 env）。
    const env = def.environment ?? def.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) out.environment = env;
    return out;
  }
  const out: Record<string, unknown> = { type: 'remote', url: def.url, enabled: true };
  if (def.headers && typeof def.headers === 'object' && !Array.isArray(def.headers)) out.headers = def.headers;
  return out;
}

/** TOML 基本串：JSON.stringify 产出即合法 TOML basic string（mergeTomlHooksText 同款手法）。 */
function tomlStr(v: string): string {
  return JSON.stringify(v);
}

/** canonical def → [mcp_servers.<name>] 表段文本（env/headers 落同名子表；其他字段丢弃）。 */
function tomlServerBlock(name: string, def: Record<string, unknown>): string {
  const qname = tomlStr(name);
  const lines: string[] = [`[mcp_servers.${qname}]`];
  const isStdio = typeof def.command === 'string';
  if (isStdio) {
    lines.push(`command = ${tomlStr(def.command as string)}`);
    const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
    if (args.length) lines.push(`args = [${args.map(tomlStr).join(', ')}]`);
    if (typeof def.cwd === 'string') lines.push(`cwd = ${tomlStr(def.cwd)}`);
  } else if (typeof def.url === 'string') {
    // codex 官方 remote 形：type="streamable_http" + url。
    lines.push('type = "streamable_http"', `url = ${tomlStr(def.url)}`);
  }
  const sub = isStdio ? def.env : def.headers;
  const subName = isStdio ? 'env' : 'headers';
  if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
    const entries = Object.entries(sub as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    );
    if (entries.length) {
      lines.push(`[mcp_servers.${qname}.${subName}]`);
      for (const [k, v] of entries) lines.push(`${tomlStr(k)} = ${tomlStr(v)}`);
    }
  }
  return lines.join('\n');
}

/**
 * 切出 TOML 文本里的 mcp_servers 段：以「首段名」为键（[mcp_servers.<name>] 与其
 * 子表 [mcp_servers.<name>.env] 归并同一块——子表是主表的从属内容，删改同进退）。
 * 非 mcp_servers 的表头结束当前块；游离的子表头（父表不在场）自立孤儿块。
 */
function tomlMcpBlocks(text: string): { name: string; body: string }[] {
  const blocks: { name: string; body: string }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const mcp = /^\s*\[mcp_servers\.("(?:[^"\\]|\\.)*"|[\w-]+)(?:\.[\w-]+)?\]\s*$/.exec(line);
    if (mcp) {
      const raw = mcp[1];
      const name = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
      if (cur && cur.name === name) {
        cur.lines.push(line);
      } else {
        if (cur) blocks.push({ name: cur.name, body: cur.lines.join('\n') });
        cur = { name, lines: [line] };
      }
      continue;
    }
    if (/^\s*\[/.test(line)) {
      // 非 mcp 表头行结束当前块；它本身由重建层的原文行透传，不进块体。
      if (cur) blocks.push({ name: cur.name, body: cur.lines.join('\n') });
      cur = null;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push({ name: cur.name, body: cur.lines.join('\n') });
  return blocks;
}

/** 比对既有 TOML 段体与 canonical def：command/url 一致即认（宽松，不逐字段）。 */
function tomlBlockMatches(body: string, def: Record<string, unknown>): boolean {
  const cmd = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(body);
  const url = /^\s*url\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(body);
  if (typeof def.command === 'string') return cmd?.[1] === def.command;
  if (typeof def.url === 'string') return url?.[1] === def.url;
  return false;
}

/**
 * 纯文本 TOML 合并（无 fs 副作用，便于单测）：我方 key 重写段体、缺失段追加、
 * mcpKeys 差集删整段（含 env/headers 子表）；他人段与其他内容原样保留。
 * 重建手法：mcp_servers 区域整体由「保留段 + 重写段 + 追加段」替换，其余行透传。
 */
export function mergeMcpTomlText(
  text: string,
  desired: Record<string, unknown>,
  ours: ReadonlySet<string>,
): { text: string; result: McpMergeResult } {
  const result: McpMergeResult = { changed: false, written: [], conflicts: [], removed: [] };
  const blocks = tomlMcpBlocks(text);
  const desiredNames = new Set(Object.keys(desired));

  // 剔除：归属集里有但源已删的 key——连主表带子表整段删。
  const drop = new Set([...ours].filter((k) => !desiredNames.has(k)));
  result.removed = [...drop].sort();

  const bodies: { name: string; body: string }[] = [];
  for (const b of blocks) {
    if (drop.has(b.name)) {
      result.changed = true;
      continue;
    }
    if (desiredNames.has(b.name)) {
      const def = canonicalDef(desired[b.name]);
      if (def) {
        if (!ours.has(b.name) && !tomlBlockMatches(b.body, def)) {
          // 同名他人段且内容不合我方期望——不碰，记 conflict。
          result.conflicts.push(b.name);
          bodies.push(b);
          continue;
        }
        const next = tomlServerBlock(b.name, def);
        if (b.body.trim() !== next.trim()) result.changed = true;
        bodies.push({ name: b.name, body: next });
        result.written.push(b.name);
        continue;
      }
    }
    bodies.push(b); // 他人段/游离子表原样保留。
  }

  for (const [name, raw] of Object.entries(desired)) {
    if (result.written.includes(name) || result.conflicts.includes(name)) continue;
    if (blocks.some((b) => b.name === name)) continue; // 非 canonical 的他人段已被上面分支保留。
    const canon = canonicalDef(raw);
    if (!canon) continue;
    bodies.push({ name, body: tomlServerBlock(name, canon) });
    result.written.push(name);
    result.changed = true;
  }

  if (!result.changed) return { text, result };

  // 重建：首个 mcp_servers 表头处一次性落全部新段；原 mcp 区行（表头+段体）整段跳过，
  // 非 mcp 表头/正文行透传。原文件没有 mcp 区时新段追加到 EOF。
  const isMcpHeader = /^\s*\[mcp_servers\./;
  const isAnyHeader = /^\s*\[/;
  const out: string[] = [];
  let skipping = false;
  let emitted = false;
  for (const line of text.split('\n')) {
    if (isMcpHeader.test(line)) {
      skipping = true;
      if (!emitted) {
        emitted = true;
        for (const b of bodies) out.push(b.body, '');
      }
      continue;
    }
    if (isAnyHeader.test(line)) skipping = false;
    if (skipping) continue;
    out.push(line);
  }
  if (!emitted) for (const b of bodies) out.push('', b.body);
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), result };
}

/** JSON 目标的容器定位：返回 {容器对象, 容器键}——opencode 需读文件判 v1/v2。 */
function mcpContainer(
  cfg: Record<string, unknown>,
  schema: 'mcpServers' | 'zcode' | 'opencode',
): { parent: Record<string, unknown>; key: string } {
  if (schema === 'zcode') {
    const mcp = (cfg.mcp && typeof cfg.mcp === 'object' && !Array.isArray(cfg.mcp) ? cfg.mcp : {}) as Record<
      string,
      unknown
    >;
    cfg.mcp = mcp;
    return { parent: mcp, key: 'servers' };
  }
  if (schema === 'opencode') {
    const mcp = cfg.mcp;
    const mcpObj = (mcp && typeof mcp === 'object' && !Array.isArray(mcp) ? mcp : {}) as Record<string, unknown>;
    // v1 直挂 server map / v2 嵌套 servers 键——servers 键是对象即 v2。
    if (mcpObj.servers && typeof mcpObj.servers === 'object' && !Array.isArray(mcpObj.servers)) {
      cfg.mcp = mcpObj;
      return { parent: mcpObj, key: 'servers' };
    }
    cfg.mcp = mcpObj;
    return { parent: cfg, key: 'mcp' };
  }
  return { parent: cfg, key: 'mcpServers' };
}

/**
 * 纯 JSON 合并（无 fs 副作用）：我方 key 覆盖更新、源删则剔除（ours 差集）、
 * 他人 key 不碰。返回改动后的 cfg（对入参浅变异地嵌套容器）与回执。
 */
export function mergeMcpJson(
  cfg: Record<string, unknown>,
  schema: 'mcpServers' | 'zcode' | 'opencode',
  agent: AgentId,
  desired: Record<string, unknown>,
  ours: ReadonlySet<string>,
): { cfg: Record<string, unknown>; result: McpMergeResult } {
  const result: McpMergeResult = { changed: false, written: [], conflicts: [], removed: [] };
  const { parent, key } = mcpContainer(cfg, schema);
  const servers = { ...((parent[key] ?? {}) as Record<string, unknown>) };
  parent[key] = servers;

  for (const k of ours) {
    if (!(k in desired) && k in servers) {
      delete servers[k];
      result.removed.push(k);
      result.changed = true;
    }
  }
  for (const [name, raw] of Object.entries(desired)) {
    const def = canonicalDef(raw);
    if (!def) continue;
    const entry = schema === 'opencode' ? opencodeEntry(def) : patchDefForAgent(agent, def);
    const existing = servers[name];
    if (existing === undefined) {
      servers[name] = entry;
      result.written.push(name);
      result.changed = true;
    } else if (ours.has(name)) {
      if (!deepEqual(existing, entry)) {
        servers[name] = entry;
        result.changed = true;
      }
      result.written.push(name);
    } else if (deepEqual(existing, entry)) {
      // 他人写的同名同值条目：内容恰合我方期望，接管进归属集（重写也无损）。
      result.written.push(name);
    } else {
      result.conflicts.push(name);
    }
  }
  return { cfg, result };
}

/** 目标配置里我方 key 的当前状态（盘点用，不写）：absent/synced/conflict。 */
export function mcpEntryState(
  cfgText: string | null,
  target: { path: string; schema: McpSchema },
  agent: AgentId,
  name: string,
  rawDef: unknown,
  ours: ReadonlySet<string>,
): 'absent' | 'synced' | 'conflict' {
  const def = canonicalDef(rawDef);
  if (!def) return 'absent';
  if (target.schema === 'toml') {
    const block = tomlMcpBlocks(cfgText ?? '').find((b) => b.name === name);
    if (!block) return 'absent';
    return ours.has(name) || tomlBlockMatches(block.body, def) ? 'synced' : 'conflict';
  }
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(cfgText ?? '') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch {
    // 损坏文件盘点按「没有该条目」；写面记 error。
    return 'absent';
  }
  const { parent, key } = mcpContainer(cfg, target.schema as 'mcpServers' | 'zcode' | 'opencode');
  const map = (parent[key] ?? {}) as Record<string, unknown>;
  const existing = map[name];
  if (existing === undefined) return 'absent';
  const expected = target.schema === 'opencode' ? opencodeEntry(def) : patchDefForAgent(agent, def);
  return deepEqual(existing, expected) ? 'synced' : 'conflict';
}
