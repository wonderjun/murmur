/**
 * credentials.json（BYOK）读写单测。
 * 与 settings.test.ts 同约定：函数收 dir 参数钉进 tmpdir，不依赖 MURMUR_HOME。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCredentials, maskKey, saveCredentials } from '../src/credentials';

const dir = mkdtempSync(join(tmpdir(), 'murmur-credentials-'));

describe('credentials 读写', () => {
  test('文件缺失回空表', () => {
    expect(loadCredentials(dir)).toEqual({});
  });

  test('save → load 回读一致（含可选 baseUrl）', () => {
    saveCredentials(
      { zcode: { apiKey: 'sk-test-1234567890', baseUrl: 'https://open.bigmodel.cn', updatedAt: 1 } },
      dir,
    );
    const back = loadCredentials(dir);
    expect(back.zcode?.apiKey).toBe('sk-test-1234567890');
    expect(back.zcode?.baseUrl).toBe('https://open.bigmodel.cn');
    expect(back.zcode?.updatedAt).toBe(1);
  });

  test('形状不符的条目被过滤（apiKey 缺失/非字符串丢弃）', () => {
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ zcode: { apiKey: 'ok-key', updatedAt: 2 }, kimi: { nope: 1 }, codex: 'x' }),
    );
    const back = loadCredentials(dir);
    expect(back.zcode?.apiKey).toBe('ok-key');
    expect(back.kimi).toBeUndefined();
    expect(back.codex).toBeUndefined();
  });

  test('损坏 JSON 回空表且不覆写文件', () => {
    writeFileSync(join(dir, 'credentials.json'), '{oops');
    expect(loadCredentials(dir)).toEqual({});
  });
});

describe('maskKey 掩码', () => {
  test('长 key 露首尾、中段掩码', () => {
    expect(maskKey('sk-abc1234567xyz')).toBe('sk-…7xyz');
  });
  test('短 key 纯掩码不露字符', () => {
    expect(maskKey('short')).toBe('•••');
  });
});
