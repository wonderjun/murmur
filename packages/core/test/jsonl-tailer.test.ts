/**
 * JsonlTailer 边界：半行、截断、持久游标、坏行与游标读写失败。
 * 全部落在 mkdtemp 沙箱，Ledger 显式传 dir，不碰家目录。
 */

import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailer } from '../src/agents/base';
import { Ledger } from '../src/ledger/db';
import type { Ledger as LedgerType } from '../src/ledger/db';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-tail-'));
  const file = join(dir, 'wire.jsonl');
  const ledger = new Ledger(dir);
  return { dir, file, ledger, key: `jsonl:${file}` };
}

/** 只拦截游标读写，其余仍走真 Ledger。 */
function flaky(
  ledger: Ledger,
  hooks: { get?: () => void; set?: () => void },
): LedgerType {
  return {
    getCursor(source: string) {
      hooks.get?.();
      return ledger.getCursor(source);
    },
    setCursor(source: string, cursor: string) {
      hooks.set?.();
      ledger.setCursor(source, cursor);
    },
  } as unknown as LedgerType;
}

describe('JsonlTailer', () => {
  test('半行跨两次 tail 拼成一行', async () => {
    const { file, ledger } = sandbox();
    writeFileSync(file, '{"n":1}\n{"n":2');
    const tailer = new JsonlTailer(ledger);
    const lines: unknown[] = [];
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(1);
    expect(lines).toEqual([{ n: 1 }]);
    appendFileSync(file, '}\n');
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(1);
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);
    ledger.close();
  });

  test('半行不进持久游标，新 tailer 续上前缀', async () => {
    const { file, ledger, key } = sandbox();
    const prefix = '{"n":1}\n';
    writeFileSync(file, `${prefix}{"n":`);
    const first = new JsonlTailer(ledger);
    const seen: unknown[] = [];
    await first.tail(file, true, (obj) => seen.push(obj));
    expect(seen).toEqual([{ n: 1 }]);
    expect(ledger.getCursor(key)).toBe(String(Buffer.byteLength(prefix)));

    appendFileSync(file, '2}\n');
    const again: unknown[] = [];
    await new JsonlTailer(ledger).tail(file, false, (obj) => again.push(obj));
    expect(again).toEqual([{ n: 2 }]);
    ledger.close();
  });

  test('文件截断后游标归零，旧半行不拼进新文件', async () => {
    const { file, ledger, key } = sandbox();
    writeFileSync(file, '{"n":1}\n{"stale":');
    const tailer = new JsonlTailer(ledger);
    const lines: unknown[] = [];
    await tailer.tail(file, true, (obj) => lines.push(obj));
    writeFileSync(file, '');
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(0);
    expect(ledger.getCursor(key)).toBe('0');
    // 新文件比旧偏移更长，且 JSON 在前缀里：不归零会跳过 {"n":9}；
    // 旧半行没丢掉则会拼成 {"stale":{"n":9} 这种坏行。
    writeFileSync(file, `{"n":9}\n${'y'.repeat(80)}\n`);
    await tailer.tail(file, true, (obj) => lines.push(obj));
    expect(lines).toEqual([{ n: 1 }, { n: 9 }]);
    ledger.close();
  });

  test('坏 JSON 跳过且游标前进，不再重读', async () => {
    const { file, ledger } = sandbox();
    writeFileSync(file, '{"n":1}\nnot-json\n{"n":2}\n');
    const tailer = new JsonlTailer(ledger);
    const lines: unknown[] = [];
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(3);
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);
    appendFileSync(file, '{"n":3}\n');
    await tailer.tail(file, true, (obj) => lines.push(obj));
    expect(lines).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    ledger.close();
  });

  test('超长单行走 tailRaw，回调拿到原文而不是对象', async () => {
    const { file, ledger } = sandbox();
    const payload = 'z'.repeat(200_000);
    writeFileSync(file, `${payload}\n`);
    const raw: string[] = [];
    const n = await new JsonlTailer(ledger).tailRaw(file, true, (line) => raw.push(line));
    expect(n).toBe(1);
    expect(raw).toEqual([payload]);
    expect(typeof raw[0]).toBe('string');
    ledger.close();
  });

  test('UTF-8 在多字节中间截断，补上后续字节后拼回原字符', async () => {
    const { file, ledger } = sandbox();
    const head = Buffer.from('{"t":"');
    const char = Buffer.from('中');
    writeFileSync(file, Buffer.concat([head, char.subarray(0, 2)]));
    const tailer = new JsonlTailer(ledger);
    const lines: unknown[] = [];
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(0);
    appendFileSync(file, Buffer.concat([char.subarray(2), Buffer.from('"}\n')]));
    await tailer.tail(file, true, (obj) => lines.push(obj));
    expect(lines).toEqual([{ t: '中' }]);
    ledger.close();
  });

  test('无游标且非首次时从文件末尾起，不回放历史', async () => {
    const { file, ledger } = sandbox();
    writeFileSync(file, '{"n":1}\n');
    const lines: unknown[] = [];
    expect(await new JsonlTailer(ledger).tail(file, false, (obj) => lines.push(obj))).toBe(0);
    expect(lines).toEqual([]);
    ledger.close();
  });

  test('坏游标不当成 0 重读', async () => {
    const { file, ledger, key } = sandbox();
    writeFileSync(file, '{"n":1}\n');
    ledger.setCursor(key, 'nope');
    const lines: unknown[] = [];
    expect(await new JsonlTailer(ledger).tail(file, true, (obj) => lines.push(obj))).toBe(0);
    expect(lines).toEqual([]);
    ledger.close();
  });

  test('游标读失败跳过本轮，恢复后只读一次', async () => {
    const { file, ledger } = sandbox();
    writeFileSync(file, '{"n":1}\n');
    let fail = true;
    const tailer = new JsonlTailer(flaky(ledger, { get: () => { if (fail) throw new Error('locked'); } }));
    const lines: unknown[] = [];
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(0);
    fail = false;
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(1);
    expect(lines).toEqual([{ n: 1 }]);
    ledger.close();
  });

  test('游标写失败同进程不重复，库里也没有游标', async () => {
    const { file, ledger, key } = sandbox();
    writeFileSync(file, '{"n":1}\n');
    const tailer = new JsonlTailer(flaky(ledger, { set: () => { throw new Error('locked'); } }));
    const lines: unknown[] = [];
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(1);
    expect(await tailer.tail(file, true, (obj) => lines.push(obj))).toBe(0);
    expect(lines).toEqual([{ n: 1 }]);
    expect(ledger.getCursor(key)).toBeNull();
    ledger.close();
  });
});
