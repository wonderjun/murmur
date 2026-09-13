/**
 * hook 卸载单测：设置页「关闭上报」的各 agent 卸载路径。
 *
 * 铁律与安装侧一致：只删我方条目（脚本路径判归属），他人条目原样保留；
 * 卸载幂等、坏文件 no-op。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mergeTomlHooksText,
  unmergeCodexNotify,
  unmergeJsonHooks,
  unmergeTomlHooks,
  unmergeZcodeHooks,
  writeHookScript,
} from '../src/hooks/install';

// 归属判定按冻结的绝对 HOOKS_DIR（MURMUR_HOME 模块加载即固化）——命令串
// 必须走 writeHookScript 产出才含真路径；它会顺手把脚本写进 HOOKS_DIR，
// 与既有安装测试同约定。
const KIMI_CMD = writeHookScript('kimi');
const CURSOR_CMD = writeHookScript('cursor');
const CODEX_CMD = writeHookScript('codex');
const ZCODE_CMD = writeHookScript('zcode');

function tmpFile(name: string, content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'murmur-uninstall-')), name);
  writeFileSync(p, content);
  return p;
}

describe('unmergeTomlHooks（kimi）', () => {
  test('删我方 [[hooks]] 块与 marker 注释，他人块与其余配置原样保留', () => {
    const base = `default_model = "kimi-code/kimi-for-coding"

[[hooks]]
event = "SessionStart"
command = "/Applications/Otty.app/otty-hook.sh idle"
timeout = 10
`;
    const merged = mergeTomlHooksText(base, 'kimi', KIMI_CMD, ['SessionStart', 'Stop']).text;
    const p = tmpFile('config.toml', merged);
    expect(unmergeTomlHooks(p, 'kimi').changed).toBe(true);
    const out = readFileSync(p, 'utf8');
    expect(out).toContain('default_model');
    expect(out).toContain('otty-hook.sh');
    expect(out).not.toContain('agent-hooks/kimi.sh');
    expect(out).not.toContain('murmur-hook');
  });

  test('幂等：再卸一遍 no-op；无我方块时不动文件', () => {
    const merged = mergeTomlHooksText('', 'kimi', KIMI_CMD, ['Stop']).text;
    const p = tmpFile('config.toml', merged);
    unmergeTomlHooks(p, 'kimi');
    expect(unmergeTomlHooks(p, 'kimi').changed).toBe(false);

    const clean = tmpFile('config.toml', 'default_model = "x"\n');
    expect(unmergeTomlHooks(clean, 'kimi').changed).toBe(false);
    expect(readFileSync(clean, 'utf8')).toBe('default_model = "x"\n');
  });
});

describe('unmergeJsonHooks（cursor / codex hooks.json）', () => {
  test('直挂与嵌套条目都删，他人保留', () => {
    const cfg = {
      version: 1,
      hooks: {
        sessionStart: [{ command: CURSOR_CMD, timeout: 10 }, { command: '/usr/bin/true' }],
        stop: [{ hooks: [{ type: 'command', command: CURSOR_CMD }] }],
      },
    };
    const p = tmpFile('hooks.json', JSON.stringify(cfg));
    expect(unmergeJsonHooks(p).changed).toBe(true);
    const out = JSON.parse(readFileSync(p, 'utf8')) as typeof cfg;
    expect(out.hooks.sessionStart).toHaveLength(1);
    expect(out.hooks.sessionStart[0]).toEqual({ command: '/usr/bin/true' });
    expect(out.hooks.stop).toHaveLength(0);
    expect(out.version).toBe(1);
  });

  test('codex matcher-group 条目（hooks.<Event>[] 包 {hooks:[{command}]}）按归属剔除', () => {
    const cfg = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: CODEX_CMD, async: true, timeout: 5 }] },
          { hooks: [{ type: 'command', command: '/opt/other/hook.sh' }] },
        ],
      },
    };
    const p = tmpFile('hooks.json', JSON.stringify(cfg));
    expect(unmergeJsonHooks(p).changed).toBe(true);
    const out = JSON.parse(readFileSync(p, 'utf8')) as { hooks: { SessionStart: unknown[] } };
    expect(out.hooks.SessionStart).toHaveLength(1);
    expect(unmergeJsonHooks(p).changed).toBe(false);
  });
});

describe('unmergeZcodeHooks', () => {
  test('events 各列表剔我方项，hooks.enabled 与他人条目不动', () => {
    const cfg = {
      hooks: {
        enabled: false,
        events: {
          SessionStart: [
            { hooks: [{ type: 'command', command: ZCODE_CMD, async: true }] },
            { hooks: [{ type: 'command', command: '/opt/orca/z.sh' }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: ZCODE_CMD }] }],
        },
      },
    };
    const p = tmpFile('config.json', JSON.stringify(cfg));
    expect(unmergeZcodeHooks(p).changed).toBe(true);
    const out = JSON.parse(readFileSync(p, 'utf8')) as typeof cfg;
    expect(out.hooks.events.SessionStart).toHaveLength(1);
    expect(out.hooks.events.Stop).toHaveLength(0);
    expect(out.hooks.enabled).toBe(false); // 用户在 zcode 里的开关不碰
    expect(unmergeZcodeHooks(p).changed).toBe(false);
  });
});

describe('unmergeCodexNotify', () => {
  test('notify 只含我方脚本 → 删整行；混入他人 → 只剔我方', () => {
    const solo = tmpFile('config.toml', 'model = "gpt-5"\n\nnotify = ["/Users/x/.murmur/agent-hooks/codex.sh"]\n');
    expect(unmergeCodexNotify(solo, 'codex').changed).toBe(true);
    const out = readFileSync(solo, 'utf8');
    expect(out).toContain('model = "gpt-5"');
    expect(out).not.toContain('notify');
    expect(out).not.toContain('agent-hooks');

    const mixed = tmpFile(
      'config.toml',
      'notify = ["/Users/x/.murmur/agent-hooks/codex.sh", "/opt/other/notify.sh"]\n',
    );
    expect(unmergeCodexNotify(mixed, 'codex').changed).toBe(true);
    const out2 = readFileSync(mixed, 'utf8');
    expect(out2).not.toContain('agent-hooks');
    expect(out2).toContain('/opt/other/notify.sh');
  });

  test('他人 notify（无我方路径）不动', () => {
    const p = tmpFile('config.toml', 'notify = ["/opt/other/notify.sh"]\n');
    expect(unmergeCodexNotify(p, 'codex').changed).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('notify = ["/opt/other/notify.sh"]\n');
  });
});
