/**
 * 迁移单测：perch 家目录搬迁与 agent 制品清扫的幂等、隔离与不误伤。
 *
 * rebrandAgentArtifacts 经 agentPaths 在调用时读 env——本文件全程把三个 agent
 * 家目录钉在临时沙箱里，清扫逻辑绝不指向真机配置。
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacyHome } from '../src/migrate';

const ROOT = mkdtempSync(join(tmpdir(), 'murmur-migrate-test-'));
process.env.MURMUR_CURSOR_HOME = join(ROOT, 'cursor');
process.env.MURMUR_CODEX_HOME = join(ROOT, 'codex');
process.env.MURMUR_OPENCODE_CONFIG = join(ROOT, 'oc');

describe('migrateLegacyHome', () => {
  test('搬迁 legacy 家目录：库改名、脚本换词根、旧目录保留', () => {
    const home = join(ROOT, 'home1');
    const legacy = join(ROOT, 'perch1');
    mkdirSync(join(legacy, 'agent-hooks'), { recursive: true });
    mkdirSync(join(legacy, 'spool'), { recursive: true });
    writeFileSync(join(legacy, 'perch.db'), 'db');
    writeFileSync(join(legacy, 'perch.db-wal'), 'wal');
    writeFileSync(join(legacy, 'spool', 'kimi.jsonl'), '{}\n');
    writeFileSync(
      join(legacy, 'agent-hooks', 'codex.sh'),
      '# perch-hook v1\nsource "$HOME/.perch/endpoint"\n-H "X-Perch-Hook-Token: t"\n',
    );

    expect(migrateLegacyHome({ home, legacyHome: legacy })).toBe(true);
    expect(existsSync(join(home, 'murmur.db'))).toBe(true);
    expect(existsSync(join(home, 'murmur.db-wal'))).toBe(true);
    expect(existsSync(join(home, 'perch.db'))).toBe(false);
    expect(readFileSync(join(home, 'spool', 'kimi.jsonl'), 'utf8')).toBe('{}\n');
    const sh = readFileSync(join(home, 'agent-hooks', 'codex.sh'), 'utf8');
    expect(sh).toContain('murmur-hook v1');
    expect(sh).toContain('$HOME/.murmur/endpoint');
    expect(sh).toContain('X-Murmur-Hook-Token');
    expect(sh).not.toContain('perch');
    // 旧目录是后悔药，必须原样保留。
    expect(existsSync(join(legacy, 'perch.db'))).toBe(true);
  });

  test('目标已存在或 legacy 缺失时跳过搬迁（幂等）', () => {
    const home = join(ROOT, 'home2');
    const legacy = join(ROOT, 'perch2');
    expect(migrateLegacyHome({ home, legacyHome: legacy })).toBe(false);
    mkdirSync(join(legacy, 'agent-hooks'), { recursive: true });
    writeFileSync(join(legacy, 'perch.db'), 'db');
    expect(migrateLegacyHome({ home, legacyHome: legacy })).toBe(true);
    // 第二次：目标已存在 → 不再搬迁。
    expect(migrateLegacyHome({ home, legacyHome: legacy })).toBe(false);
  });

  test('清扫 agent 制品：cursor JSON / codex TOML / opencode 插件，不碰他人条目', () => {
    const home = join(ROOT, 'home3');
    const legacy = join(ROOT, 'perch3');
    mkdirSync(join(ROOT, 'cursor'), { recursive: true });
    writeFileSync(
      join(ROOT, 'cursor', 'hooks.json'),
      JSON.stringify({
        hooks: {
          afterAgentResponse: [
            { hooks: [{ type: 'command', command: "if [ -f '/Users/x/.perch/agent-hooks/cursor.sh' ]; then /bin/sh '/Users/x/.perch/agent-hooks/cursor.sh'; fi" }] },
            { hooks: [{ type: 'command', command: 'orca run' }] },
          ],
        },
      }),
    );
    mkdirSync(join(ROOT, 'codex'), { recursive: true });
    writeFileSync(
      join(ROOT, 'codex', 'config.toml'),
      'model = "gpt"\n# perch hook: agent-turn-complete 通知\nnotify = ["/Users/x/.perch/agent-hooks/codex.sh"]\n',
    );
    mkdirSync(join(ROOT, 'oc', 'plugins'), { recursive: true });
    writeFileSync(join(ROOT, 'oc', 'plugins', 'perch-status.js'), '// perch-hook v1\n".perch"');

    // 无 legacy 家目录 → 只清扫，不搬迁。
    expect(migrateLegacyHome({ home, legacyHome: legacy })).toBe(false);

    const cfg = JSON.parse(readFileSync(join(ROOT, 'cursor', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const ours = cfg.hooks.afterAgentResponse[0].hooks[0].command;
    expect(ours).toContain('.murmur/agent-hooks');
    expect(ours).not.toContain('perch');
    // 他人（orca）条目一字不动。
    expect(cfg.hooks.afterAgentResponse[1].hooks[0].command).toBe('orca run');

    const toml = readFileSync(join(ROOT, 'codex', 'config.toml'), 'utf8');
    expect(toml).toContain('notify = ["/Users/x/.murmur/agent-hooks/codex.sh"]');
    expect(toml).toContain('# murmur hook');
    expect(toml).toContain('model = "gpt"');

    expect(existsSync(join(ROOT, 'oc', 'plugins', 'murmur-status.js'))).toBe(true);
    expect(readFileSync(join(ROOT, 'oc', 'plugins', 'murmur-status.js'), 'utf8')).toContain('".murmur"');
    expect(existsSync(join(ROOT, 'oc', 'plugins', 'perch-status.js'))).toBe(false);

    // 重复执行是 no-op（不再有含 perch 的串）。
    expect(migrateLegacyHome({ home, legacyHome: legacy })).toBe(false);
  });

  test('死端点宿主配置（claude/devin）：我们的整条摘除，orca 等他人条目原样', () => {
    const home = join(ROOT, 'home4');
    const legacy = join(ROOT, 'perch4');
    const marker = join(legacy, 'agent-hooks');
    const claudeCfg = join(ROOT, 'claude', 'settings.json');
    mkdirSync(join(ROOT, 'claude'), { recursive: true });
    writeFileSync(
      claudeCfg,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: `sh '${marker}/claude-code.sh'` }] }],
          Stop: [
            { hooks: [{ type: 'command', command: `sh '${marker}/claude-code.sh'` }] },
            { hooks: [{ type: 'command', command: 'orca run' }] },
          ],
        },
      }),
    );
    const devinCfg = join(ROOT, 'devin', 'config.json');
    mkdirSync(join(ROOT, 'devin'), { recursive: true });
    writeFileSync(
      devinCfg,
      JSON.stringify({
        version: 1,
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `sh '${marker}/devin.sh'` }] }] },
      }),
    );

    migrateLegacyHome({ home, legacyHome: legacy, deadHookConfigs: [claudeCfg, devinCfg] });

    const claude = JSON.parse(readFileSync(claudeCfg, 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(claude.hooks.SessionStart).toBeUndefined(); // 清空的事件键连键摘除。
    expect(claude.hooks.Stop).toHaveLength(1); // orca 条目原样保留。
    expect((claude.hooks.Stop[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe('orca run');
    const devin = JSON.parse(readFileSync(devinCfg, 'utf8')) as { version: number; hooks: Record<string, unknown> };
    expect(devin.hooks.PreToolUse).toBeUndefined();
    expect(devin.version).toBe(1); // 配置其他键一字不动。

    // 幂等：再跑一遍不再改动。
    migrateLegacyHome({ home, legacyHome: legacy, deadHookConfigs: [claudeCfg, devinCfg] });
    expect(JSON.parse(readFileSync(claudeCfg, 'utf8')).hooks.Stop).toHaveLength(1);
  });
});
