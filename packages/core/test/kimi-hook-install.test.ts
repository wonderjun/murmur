/**
 * kimi TOML hook 合并安装单测。
 *
 * TOML 文本合并在纯函数 mergeTomlHooksText 上测（无 fs 副作用，同
 * mergeZcodeConfig 的套路）；fs 包装 mergeTomlHooks 只测端到端信号。
 * MURMUR_HOME 在 paths.ts 模块加载时固化且 bun test 共享注册表——脚本落盘
 * 位置以模块内冻结值为准，这里只断言「装完即装好」的一致性。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeTomlHooks, mergeTomlHooksText, tomlHookInstalled } from '../src/hooks/install';
import { renderHookScript } from '../src/hooks/script';

const EVENTS = ['SessionStart', 'Stop'];
const CMD = "/bin/sh '/Users/x/.murmur/agent-hooks/kimi.sh'";

/** otty 式外来条目：合并后必须原样保留。 */
const FOREIGN = `default_model = "kimi-code/kimi-for-coding"

[[hooks]]
event = "SessionStart"
command = "/Applications/Otty.app/Contents/Resources/agent-integration/kimi/otty-hook.sh idle"
timeout = 10
`;

function tmpToml(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'kimi-cfg-')), 'config.toml');
  if (content) writeFileSync(p, content);
  return p;
}

describe('mergeTomlHooksText（纯文本合并）', () => {
  test('缺的事件块 EOF 追加，他人条目与原内容不动', () => {
    const { text, changed } = mergeTomlHooksText(FOREIGN, 'kimi', CMD, EVENTS);
    expect(changed).toBe(true);
    expect(text).toContain('default_model');
    expect(text).toContain('otty-hook.sh');
    expect(text).toContain('# murmur-hook v2 kimi');
    expect(text.match(/event = "SessionStart"/g)).toHaveLength(2); // otty + murmur 各一
    expect(text.match(/event = "Stop"/g)).toHaveLength(1);
    expect(text.indexOf('otty-hook.sh')).toBeLessThan(text.indexOf('murmur-hook'));
  });

  test('我们已挂的事件不重复追加（按脚本路径认归属）', () => {
    const once = mergeTomlHooksText('', 'kimi', CMD, EVENTS).text;
    expect(mergeTomlHooksText(once, 'kimi', CMD, EVENTS).changed).toBe(false);
    // 部分已挂 → 只补缺的。
    const partial = mergeTomlHooksText(once, 'kimi', CMD, ['SessionStart', 'Stop', 'Interrupt']);
    expect(partial.text.match(/event = "Interrupt"/g)).toHaveLength(1);
    expect(partial.text.match(/event = "Stop"/g)).toHaveLength(1);
  });

  test('command 产出合法 TOML 基本串（含单引号与 $PPID 不炸）', () => {
    const cmd = `if [ -f '/x/kimi.sh' ]; then /bin/sh '/x/kimi.sh'; else cat >/dev/null || :; fi`;
    const { text } = mergeTomlHooksText('', 'kimi', cmd, ['Stop']);
    expect(text).toContain(`command = ${JSON.stringify(cmd)}`);
  });
});

describe('renderHookScript stdoutAck', () => {
  test('kimi 变体不吐 {}；默认仍吐（cursor 契约）', () => {
    // 脚本里 ack 行是 printf '{}\n'（\n 为字面两字符）。
    expect(renderHookScript('kimi', { stdoutAck: false })).not.toContain("printf '{}\\n'");
    expect(renderHookScript('kimi')).toContain("printf '{}\\n'");
  });
});

describe('mergeTomlHooks（fs 端到端）', () => {
  test('新文件创建 + 写脚本 + 幂等', () => {
    const cfg = tmpToml(FOREIGN);
    expect(tomlHookInstalled(cfg, 'kimi')).toBe(false);
    expect(mergeTomlHooks(cfg, 'kimi', EVENTS, { stdoutAck: false }).changed).toBe(true);
    expect(tomlHookInstalled(cfg, 'kimi')).toBe(true);
    expect(readFileSync(cfg, 'utf8')).toContain('otty-hook.sh');
    expect(mergeTomlHooks(cfg, 'kimi', EVENTS, { stdoutAck: false }).changed).toBe(false);
  });
});
