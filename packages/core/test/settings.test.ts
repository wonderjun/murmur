/**
 * settings.json 读写单测。
 *
 * MURMUR_HOME 在 paths.ts 模块加载时固化且 bun test 共享注册表——不可靠，
 * loadSettings/saveSettings 收 dir 参数，测试全程钉进自己的 tmpdir。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, flagEnabled, loadSettings, saveSettings } from '../src/settings';

const dir = mkdtempSync(join(tmpdir(), 'murmur-settings-'));

describe('settings 读写', () => {
  test('文件缺失时回默认：自启关、Dock 藏、通知关、自动装开', () => {
    const s = loadSettings(dir);
    expect(s.launchAtLogin).toBe(false);
    expect(s.showDockIcon).toBe(false);
    expect(s.notifyOnWaiting).toBe(false);
    expect(s.autoInstallHooks).toBe(true);
    expect(s.agents).toEqual({});
    expect(s.hooks).toEqual({});
  });

  test('save → load 回读一致', () => {
    const s = { ...structuredClone(DEFAULT_SETTINGS), notifyOnWaiting: true, hooks: { kimi: false } };
    saveSettings(s, dir);
    const back = loadSettings(dir);
    expect(back.notifyOnWaiting).toBe(true);
    expect(back.hooks.kimi).toBe(false);
    expect(back.agents).toEqual({});
  });

  test('部分字段的旧文件：缺省键补默认', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ showDockIcon: true }));
    const s = loadSettings(dir);
    expect(s.showDockIcon).toBe(true);
    expect(s.autoInstallHooks).toBe(true);
  });

  test('损坏 JSON 回默认且不覆写文件', () => {
    writeFileSync(join(dir, 'settings.json'), '{oops');
    const s = loadSettings(dir);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });
});

describe('flagEnabled（缺省 true 约定）', () => {
  test('缺省与显式 true 都算开，仅显式 false 算关', () => {
    expect(flagEnabled(undefined, 'kimi')).toBe(true);
    expect(flagEnabled({}, 'kimi')).toBe(true);
    expect(flagEnabled({ kimi: true }, 'kimi')).toBe(true);
    expect(flagEnabled({ kimi: false }, 'kimi')).toBe(false);
  });
});
