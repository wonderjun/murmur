/**
 * SyncService 单测：技能/MCP 同步的写入、归属、剔除与降级语义。
 *
 * 隔离手段：MURMUR_<AGENT>_HOME / MURMUR_<AGENT>_SKILLS_DIR / MURMUR_<AGENT>_MCP_CONFIG /
 * MURMUR_AGENTS_SKILLS_DIR 全部钉进 mkdtempSync 沙箱（agentPaths/syncTargets 在函数体
 * 内读 env，可运行时覆盖）；SyncService 的 home 也钉沙箱——绝不写真机目录。
 * claude-code 的 MCP 目标是 ~/.claude.json（用户家目录，不随 CLAUDE_CONFIG_DIR 走），
 * 必须显式 MURMUR_CLAUDE_CODE_MCP_CONFIG 覆盖；同理共享目录 ~/.agents/skills。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncService } from '../src/sync/engine';
import { SKILL_MARKER } from '../src/sync/source';
import { syncTargets } from '../src/sync/targets';
import { DEFAULT_SETTINGS, type MurmurSettings } from '../src/settings';
import type { AgentId } from '../src/types';

/** 本轮测试涉及的 env 键（afterEach 还原，防串扰其他测试文件）。 */
const ENV_KEYS = [
  'MURMUR_KIMI_HOME',
  'MURMUR_ZCODE_HOME',
  'MURMUR_OPENCODE_CONFIG',
  'MURMUR_OPENCODE_DATA',
  'MURMUR_CODEX_HOME',
  'MURMUR_CURSOR_HOME',
  'MURMUR_DEVIN_DATA',
  'MURMUR_DEVIN_CONFIG',
  'MURMUR_QODER_HOME',
  'MURMUR_MINIMAX_HOME',
  'MURMUR_OMP_HOME',
  'MURMUR_OMP_AGENT_DIR',
  'MURMUR_CLAUDE_HOME',
  'MURMUR_CLAUDE_CODE_MCP_CONFIG',
  'MURMUR_AGENTS_SKILLS_DIR',
] as const;

/** 写一个技能包目录（frontmatter name/description + 一个附属文件）。 */
function writeSkill(dir: string, name: string, extra = ''): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 测试技能\n---\n# ${name}${extra}\n`);
  writeFileSync(join(d, 'notes.txt'), `${name} notes`);
  return d;
}

/** 当前沙箱里的标准目标路径。 */
function target(agent: 'kimi' | 'zcode' | 'cursor' | 'codex' | 'opencode', file: string): string {
  const roots = {
    kimi: join(sandbox, 'kimi'),
    zcode: join(sandbox, 'zcode'),
    cursor: join(sandbox, 'cursor'),
    codex: join(sandbox, 'codex'),
    opencode: join(sandbox, 'opencode'),
  };
  return join(roots[agent], file);
}

function makeService(over?: { installed?: (a: AgentId) => boolean; settings?: MurmurSettings }): {
  svc: SyncService;
  settings: () => MurmurSettings;
} {
  let settings = over?.settings ?? structuredClone(DEFAULT_SETTINGS);
  const svc = new SyncService({
    home: sandbox,
    settings: () => settings,
    installed: over?.installed ?? (() => true),
    save: (next) => {
      settings = next;
    },
  });
  return { svc, settings: () => settings };
}

let sandbox: string;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'murmur-sync-'));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k]; // 置 undefined 会落成字符串 "undefined"（bun 语义），必须 delete。
  }
  // 各 agent 数据根钉进沙箱；env 在 paths/targets 函数体内读，运行时覆盖生效。
  process.env.MURMUR_KIMI_HOME = join(sandbox, 'kimi');
  process.env.MURMUR_ZCODE_HOME = join(sandbox, 'zcode');
  process.env.MURMUR_OPENCODE_CONFIG = join(sandbox, 'opencode');
  process.env.MURMUR_OPENCODE_DATA = join(sandbox, 'opencode-data');
  process.env.MURMUR_CODEX_HOME = join(sandbox, 'codex');
  process.env.MURMUR_CURSOR_HOME = join(sandbox, 'cursor');
  process.env.MURMUR_DEVIN_DATA = join(sandbox, 'devin-data');
  process.env.MURMUR_DEVIN_CONFIG = join(sandbox, 'devin', 'config.json');
  process.env.MURMUR_QODER_HOME = join(sandbox, 'qoder');
  process.env.MURMUR_MINIMAX_HOME = join(sandbox, 'minimax');
  process.env.MURMUR_OMP_HOME = join(sandbox, 'omp');
  process.env.MURMUR_OMP_AGENT_DIR = join(sandbox, 'omp', 'agent');
  process.env.MURMUR_CLAUDE_HOME = join(sandbox, 'claude');
  process.env.MURMUR_CLAUDE_CODE_MCP_CONFIG = join(sandbox, 'claude.json');
  process.env.MURMUR_AGENTS_SKILLS_DIR = join(sandbox, 'agents-skills');
  mkdirSync(join(sandbox, 'skills'), { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('SyncService 技能写面', () => {
  test('syncAll 把源技能拷进各 agent 目录并落 marker', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const { svc } = makeService();
    const ov = await svc.syncAll();
    expect(existsSync(join(sandbox, 'kimi', 'skills', 'demo', SKILL_MARKER))).toBe(true);
    expect(existsSync(join(sandbox, 'kimi', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    // 共享目录 ~/.agents/skills（kimi+cursor 同引用）只写一次即各自 synced。
    expect(existsSync(join(sandbox, 'agents-skills', 'demo', SKILL_MARKER))).toBe(true);
    const row = ov.skills.find((r) => r.name === 'demo');
    expect(row?.cells.find((c) => c.agent === 'kimi')?.state).toBe('synced');
    expect(row?.cells.find((c) => c.agent === 'cursor')?.state).toBe('synced');
    // minimax 无用户级 skills 目录——盘点恒 off，不写文件。
    expect(row?.cells.find((c) => c.agent === 'minimax')?.state).toBe('off');
  });

  test('源变更后重同步：marker 签名更新（stale → synced）', async () => {
    const dir = writeSkill(join(sandbox, 'skills'), 'demo');
    const { svc } = makeService();
    await svc.syncAll();
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\n---\n# changed\n');
    const stale = svc.overview().skills.find((r) => r.name === 'demo');
    expect(stale?.cells.find((c) => c.agent === 'kimi')?.state).toBe('stale');
    await svc.syncAll();
    const fresh = svc.overview().skills.find((r) => r.name === 'demo');
    expect(fresh?.cells.find((c) => c.agent === 'kimi')?.state).toBe('synced');
  });

  test('他人同名目录不覆盖：盘点记 conflict，目录内容原样', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const foreign = join(sandbox, 'cursor', 'skills', 'demo');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'theirs.txt'), 'not ours');
    const { svc } = makeService();
    const ov = await svc.syncAll();
    expect(existsSync(join(foreign, SKILL_MARKER))).toBe(false);
    expect(readFileSync(join(foreign, 'theirs.txt'), 'utf8')).toBe('not ours');
    const cell = ov.skills.find((r) => r.name === 'demo')?.cells.find((c) => c.agent === 'cursor');
    expect(cell?.state).toBe('conflict');
  });

  test('skillshare 管辖目录（.skillshare-manifest.json）整体跳过记 external', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    mkdirSync(join(sandbox, 'zcode', 'skills'), { recursive: true });
    writeFileSync(join(sandbox, 'zcode', 'skills', '.skillshare-manifest.json'), '{}');
    const { svc } = makeService();
    const ov = await svc.syncAll();
    expect(existsSync(join(sandbox, 'zcode', 'skills', 'demo'))).toBe(false);
    const cell = ov.skills.find((r) => r.name === 'demo')?.cells.find((c) => c.agent === 'zcode');
    expect(cell?.state).toBe('external');
  });

  test('源删除后重同步清理我方拷贝；他人目录不动', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const foreign = join(sandbox, 'zcode', 'skills', 'demo');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'theirs.txt'), 'not ours');
    const { svc } = makeService();
    await svc.syncAll();
    rmSync(join(sandbox, 'skills', 'demo'), { recursive: true });
    await svc.syncAll();
    expect(existsSync(join(sandbox, 'kimi', 'skills', 'demo'))).toBe(false);
    // 他人同名目录（无 marker）不受清理影响。
    expect(existsSync(join(foreign, 'theirs.txt'))).toBe(true);
  });

  test('禁用条目：清理在场我方拷贝，重开恢复', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const { svc, settings } = makeService();
    await svc.syncAll();
    await svc.setSkillEnabled('demo', false);
    expect(existsSync(join(sandbox, 'kimi', 'skills', 'demo'))).toBe(false);
    expect(settings().disabledSkills).toEqual(['demo']);
    await svc.setSkillEnabled('demo', true);
    expect(existsSync(join(sandbox, 'kimi', 'skills', 'demo', SKILL_MARKER))).toBe(true);
  });

  test('未安装 agent 跳过写面且盘点标 off', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const { svc } = makeService({ installed: (a) => a !== 'codex' });
    const ov = await svc.syncAll();
    expect(existsSync(join(sandbox, 'codex', 'skills', 'demo'))).toBe(false);
    expect(ov.skills[0]?.cells.find((c) => c.agent === 'codex')?.state).toBe('off');
  });
});

describe('SyncService MCP 写面', () => {
  function writeMcpSource(servers: Record<string, unknown>) {
    writeFileSync(join(sandbox, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }

  test('mcpServers 目标：我方 key 写入、他人 key 原样保留', async () => {
    writeMcpSource({ mine: { command: 'run-it', args: ['--flag'] } });
    mkdirSync(join(sandbox, 'kimi'), { recursive: true });
    writeFileSync(
      join(sandbox, 'kimi', 'mcp.json'),
      JSON.stringify({ mcpServers: { theirs: { command: 'other' } }, theme: 'dark' }, null, 2),
    );
    const { svc } = makeService();
    const ov = await svc.syncAll();
    const cfg = JSON.parse(readFileSync(join(sandbox, 'kimi', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.theirs).toEqual({ command: 'other' });
    expect(cfg.mcpServers.mine).toEqual({ command: 'run-it', args: ['--flag'] });
    expect(cfg.theme).toBe('dark');
    expect(ov.mcps.find((r) => r.name === 'mine')?.cells.find((c) => c.agent === 'kimi')?.state).toBe('synced');
  });

  test('cursor/minimax 缺 type 时补 stdio/streamable-http', async () => {
    writeMcpSource({ mine: { command: 'run-it' }, remote: { url: 'https://x.example/mcp' } });
    const { svc } = makeService();
    await svc.syncAll();
    const cursor = JSON.parse(readFileSync(join(sandbox, 'cursor', 'mcp.json'), 'utf8'));
    expect(cursor.mcpServers.mine.type).toBe('stdio');
    expect(cursor.mcpServers.remote.type).toBe('streamable-http');
  });

  test('源删条目剔除我方 key、不动他人 key', async () => {
    writeMcpSource({ mine: { command: 'run-it' } });
    const { svc } = makeService();
    await svc.syncAll();
    writeMcpSource({});
    await svc.syncAll();
    const kimi = JSON.parse(readFileSync(join(sandbox, 'kimi', 'mcp.json'), 'utf8'));
    expect(kimi.mcpServers.mine).toBeUndefined();
    // 同步期间手写进目标的他人 key 不受剔除影响。
    writeFileSync(
      join(sandbox, 'cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'run-it', type: 'stdio' }, theirs: { url: 'https://y' } } }),
    );
    writeMcpSource({ mine: { command: 'run-it' } });
    await svc.syncAll();
    writeMcpSource({});
    await svc.syncAll();
    const cursor = JSON.parse(readFileSync(join(sandbox, 'cursor', 'mcp.json'), 'utf8'));
    expect(cursor.mcpServers.theirs).toEqual({ url: 'https://y' });
  });

  test('同名异值他人条目不覆盖、记 conflict', async () => {
    writeMcpSource({ mine: { command: 'run-it' } });
    mkdirSync(join(sandbox, 'qoder'), { recursive: true });
    writeFileSync(
      join(sandbox, 'qoder', 'mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'their-cmd' } } }),
    );
    const { svc } = makeService();
    const ov = await svc.syncAll();
    const cfg = JSON.parse(readFileSync(join(sandbox, 'qoder', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.mine).toEqual({ command: 'their-cmd' });
    expect(ov.mcps.find((r) => r.name === 'mine')?.cells.find((c) => c.agent === 'qoder')?.state).toBe('conflict');
  });

  test('codex TOML：表段写入与剔除，他人段原样', async () => {
    writeMcpSource({ mine: { command: 'run-it', args: ['a', 'b'], env: { API_KEY: 'k' } } });
    mkdirSync(join(sandbox, 'codex'), { recursive: true });
    writeFileSync(
      join(sandbox, 'codex', 'config.toml'),
      '# user conf\n[mcp_servers."theirs"]\ncommand = "x"\n\n[other]\nx = 1\n',
    );
    const { svc } = makeService();
    await svc.syncAll();
    let text = readFileSync(join(sandbox, 'codex', 'config.toml'), 'utf8');
    expect(text).toContain('[mcp_servers."mine"]');
    expect(text).toContain('command = "run-it"');
    expect(text).toContain('args = ["a", "b"]');
    expect(text).toContain('[mcp_servers."mine".env]');
    expect(text).toContain('"API_KEY" = "k"');
    expect(text).toContain('[mcp_servers."theirs"]');
    expect(text).toContain('[other]');
    // 源删条目 → 我方段（含子表）整段删，他人段仍在。
    writeMcpSource({});
    await svc.syncAll();
    text = readFileSync(join(sandbox, 'codex', 'config.toml'), 'utf8');
    expect(text).not.toContain('mine');
    expect(text).toContain('[mcp_servers."theirs"]');
    expect(text).toContain('[other]');
  });

  test('opencode v2（mcp.servers 嵌套）与 v1 直挂都按检测写', async () => {
    writeMcpSource({ mine: { command: 'run-it', args: ['x'] } });
    mkdirSync(join(sandbox, 'opencode'), { recursive: true });
    writeFileSync(
      join(sandbox, 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { servers: { theirs: { type: 'local', command: ['y'], enabled: false } } } }),
    );
    const { svc } = makeService();
    await svc.syncAll();
    const cfg = JSON.parse(readFileSync(join(sandbox, 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.mcp.servers.mine).toEqual({ type: 'local', command: ['run-it', 'x'], enabled: true });
    expect(cfg.mcp.servers.theirs.enabled).toBe(false);
  });

  test('zcode 写 cli/config.json 的 mcp.servers 键', async () => {
    writeMcpSource({ mine: { url: 'https://x.example/mcp' } });
    mkdirSync(join(sandbox, 'zcode', 'cli'), { recursive: true });
    writeFileSync(join(sandbox, 'zcode', 'cli', 'config.json'), JSON.stringify({ theme: 'dark' }));
    const { svc } = makeService();
    await svc.syncAll();
    const cfg = JSON.parse(readFileSync(join(sandbox, 'zcode', 'cli', 'config.json'), 'utf8'));
    expect(cfg.mcp.servers.mine).toEqual({ url: 'https://x.example/mcp' });
    expect(cfg.theme).toBe('dark');
  });

  test('损坏的目标 JSON 跳过不 crash、盘点记 error', async () => {
    writeMcpSource({ mine: { command: 'run-it' } });
    mkdirSync(join(sandbox, 'cursor'), { recursive: true });
    writeFileSync(join(sandbox, 'cursor', 'mcp.json'), '{broken json');
    const { svc } = makeService();
    const ov = await svc.syncAll();
    expect(readFileSync(join(sandbox, 'cursor', 'mcp.json'), 'utf8')).toBe('{broken json');
    expect(ov.mcps.find((r) => r.name === 'mine')?.cells.find((c) => c.agent === 'cursor')?.state).toBe('error');
  });

  test('禁用 MCP：从各目标剔除我方 key', async () => {
    writeMcpSource({ mine: { command: 'run-it' } });
    const { svc, settings } = makeService();
    await svc.syncAll();
    await svc.setMcpEnabled('mine', false);
    expect(settings().disabledMcp).toEqual(['mine']);
    const cfg = JSON.parse(readFileSync(join(sandbox, 'kimi', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers?.mine).toBeUndefined();
  });
});

describe('importSkills 导入', () => {
  test('单包目录与三层深扫都收进源根', async () => {
    const inbox = join(sandbox, 'inbox');
    writeSkill(inbox, 'top'); // srcDir 本身是包
    const { svc } = makeService();
    let r = await svc.importSkills(inbox);
    expect(r.imported).toEqual(['top']);
    // 三层：inbox2/a/b/pkg/SKILL.md（深度 1=a, 2=b, 3=pkg）。
    rmSync(join(sandbox, 'skills'), { recursive: true });
    const inbox2 = join(sandbox, 'inbox2');
    writeSkill(join(inbox2, 'a', 'b'), 'deep');
    writeSkill(join(inbox2, 'a'), 'mid');
    r = await svc.importSkills(inbox2);
    expect(r.imported.sort()).toEqual(['deep', 'mid']);
    expect(existsSync(join(sandbox, 'skills', 'deep', SKILL_MARKER))).toBe(false); // 源目录不写 marker
    expect(existsSync(join(sandbox, 'skills', 'deep', 'SKILL.md'))).toBe(true);
  });

  test('同名已存在跳过、目录不可读回报', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const inbox = join(sandbox, 'inbox');
    writeSkill(inbox, 'demo');
    writeSkill(inbox, 'fresh');
    const { svc } = makeService();
    const r = await svc.importSkills(inbox);
    expect(r.imported).toEqual(['fresh']);
    expect(r.skipped).toEqual([{ name: 'demo', reason: '同名目录已存在' }]);
    const bad = await svc.importSkills(join(sandbox, 'no-such-dir'));
    expect(bad.imported).toEqual([]);
    expect(bad.skipped[0]?.reason).toBe('目录不可读');
  });

  test('软链目录也当目录探（Dirent.isDirectory 不跟随软链的坑）', async () => {
    // 真机场景：技能目录是 ln -s 到别处的软链——symlink 入口必须照常下探。
    const real = join(sandbox, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'SKILL.md'), '---\nname: linked\ndescription: 软链技能\n---\n# linked\n');
    const inbox = join(sandbox, 'inbox');
    mkdirSync(inbox, { recursive: true });
    symlinkSync(real, join(inbox, 'via-symlink'));
    writeSkill(inbox, 'plain');
    const { svc } = makeService();
    const r = await svc.importSkills(inbox);
    expect(r.imported.sort()).toEqual(['plain', 'via-symlink']);
    expect(existsSync(join(sandbox, 'skills', 'via-symlink', 'SKILL.md'))).toBe(true);
  });
});

describe('deleteSkill', () => {
  test('源进废纸篓后同步清理目标拷贝；trash 失败报错', async () => {
    writeSkill(join(sandbox, 'skills'), 'demo');
    const { svc } = makeService();
    await svc.syncAll();
    const trashed: string[] = [];
    const r = await svc.deleteSkill('demo', (p) => {
      trashed.push(p);
      rmSync(p, { recursive: true, force: true });
      return true;
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(sandbox, 'skills', 'demo'))).toBe(false);
    expect(existsSync(join(sandbox, 'kimi', 'skills', 'demo'))).toBe(false);
    const bad = await svc.deleteSkill('ghost', () => false);
    expect(bad.ok).toBe(false);
  });
});

describe('saveMcp / mcpDef', () => {
  test('新建写入 mcp.json 并随 syncAll 落到目标；坏 JSON 不落盘', async () => {
    const { svc } = makeService();
    const ok = await svc.saveMcp(null, '{"mcpServers":{"mine":{"command":"run-x","args":["a","b"],"env":{"API_KEY":"k"}}}}');
    expect(ok.ok).toBe(true);
    expect(svc.mcpDef('mine')?.command).toBe('run-x');
    const text = readFileSync(join(sandbox, 'codex', 'config.toml'), 'utf8');
    expect(text).toContain('command = "run-x"');
    expect(text).toContain('API_KEY');
    const bad = await svc.saveMcp(null, '{not json');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('JSON 解析失败');
    const shapeless = await svc.saveMcp(null, '[1,2]');
    expect(shapeless.ok).toBe(false);
    const noWrap = await svc.saveMcp(null, '{"command":"x"}');
    expect(noWrap.ok).toBe(false);
    const noTrans = await svc.saveMcp(null, '{"mcpServers":{"x":{"foo":1}}}');
    expect(noTrans.ok).toBe(false);
    expect(svc.mcpDef('x')).toBeNull();
  });

  test('更新既有条目保留他人键；编辑改名删旧键；损坏 mcp.json 拒绝覆写', async () => {
    writeFileSync(
      join(sandbox, 'mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'old' }, theirs: { command: 'keep' } }, other: 1 }),
    );
    const { svc } = makeService();
    const r = await svc.saveMcp('mine', '{"mcpServers":{"mine":{"command":"new"}}}');
    expect(r.ok).toBe(true);
    let all = JSON.parse(readFileSync(join(sandbox, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
      other: number;
    };
    expect(all.mcpServers.mine?.command).toBe('new');
    expect(all.mcpServers.theirs?.command).toBe('keep');
    expect(all.other).toBe(1);

    // 编辑改名（mine → renamed）：旧键删，新键立。
    const ren = await svc.saveMcp('mine', '{"mcpServers":{"renamed":{"command":"r"}}}');
    expect(ren.ok).toBe(true);
    all = JSON.parse(readFileSync(join(sandbox, 'mcp.json'), 'utf8')) as typeof all;
    expect(all.mcpServers.mine).toBeUndefined();
    expect(all.mcpServers.renamed?.command).toBe('r');

    // 编辑清空键集：origName 消失 = 删除该条目（mcpServers 出清为空表）。
    const del = await svc.saveMcp('renamed', '{"mcpServers":{}}');
    expect(del.ok).toBe(true);
    all = JSON.parse(readFileSync(join(sandbox, 'mcp.json'), 'utf8')) as typeof all;
    expect(all.mcpServers.renamed).toBeUndefined();
    expect(all.mcpServers.theirs?.command).toBe('keep');

    writeFileSync(join(sandbox, 'mcp.json'), '{broken');
    const bad = await svc.saveMcp(null, '{"mcpServers":{"z":{"command":"x"}}}');
    expect(bad.ok).toBe(false);
    expect(readFileSync(join(sandbox, 'mcp.json'), 'utf8')).toBe('{broken');
  });
});

describe('testMcp 探测', () => {
  test('stdio：不存在的命令报错不 crash；无 command/url 报条目缺', async () => {
    const { svc } = makeService();
    const bad = await svc.testMcp(undefined, '{"command":"/bin/definitely-not-a-cmd-xyz"}');
    expect(bad[0]?.ok).toBe(false);
    expect(bad[0]?.error).toBeTruthy();
    const shapeless = await svc.testMcp(undefined, '{"foo":1}');
    expect(shapeless[0]?.ok).toBe(false);
    expect(shapeless[0]?.error).toBe('条目缺 command 或 url');
  });

  test('remote：Bun.serve 回 JSON 与 SSE 两形都判通；HTTP 错码报码', async () => {
    const { svc } = makeService();
    const initReply = { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fake-mcp', version: '1.0' } } };
    const sse = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`event: message\ndata: ${JSON.stringify(initReply)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    const plain = Bun.serve({ port: 0, fetch: () => Response.json(initReply) });
    const broken = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 404 }) });
    try {
      const r1 = await svc.testMcp(undefined, `{"url":"http://127.0.0.1:${sse.port}/mcp"}`);
      expect(r1[0]?.ok).toBe(true);
      expect(r1[0]?.server).toBe('fake-mcp@1.0');
      const r2 = await svc.testMcp(undefined, `{"url":"http://127.0.0.1:${plain.port}"}`);
      expect(r2[0]?.ok).toBe(true);
      const r3 = await svc.testMcp(undefined, `{"url":"http://127.0.0.1:${broken.port}"}`);
      expect(r3[0]?.ok).toBe(false);
      expect(r3[0]?.error).toBe('HTTP 404');
    } finally {
      sse.stop(true);
      plain.stop(true);
      broken.stop(true);
    }
  });

  test('stdio 应答形：能回 initialize 的 stub 判通并带回 serverInfo', async () => {
    const { svc } = makeService();
    // 读一行 stdin、回 initialize 结果、退出——最窄可通 MCP stub。
    const r = await svc.testMcp(undefined, JSON.stringify({
      command: process.execPath,
      args: [
        '-e',
        'const rl=(await new Response(Bun.stdin.stream()).text()).split("\\n")[0];' +
          'console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{name:"stub",version:"0.1"}}}));',
      ],
    }));
    expect(r[0]?.ok).toBe(true);
    expect(r[0]?.server).toBe('stub@0.1');
  });
});
