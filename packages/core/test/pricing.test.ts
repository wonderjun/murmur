/**
 * 模型价表单测：已知模型、包含匹配与未知模型降级。
 * 纯函数，不碰文件系统，因此不需要 tmpdir。
 */

import { describe, expect, test } from 'bun:test';

import { estimateCostUsd, priceFor } from '../src/ledger/pricing';
import type { TokenUsage } from '../src/types';

const M = 1_000_000;

describe('priceFor 模糊命中', () => {
  test('已知模型精确命中', () => {
    expect(priceFor('claude-opus-4')).toMatchObject({ input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
    expect(priceFor('claude-sonnet-4')?.input).toBe(3);
    expect(priceFor('kimi-k2')).toMatchObject({ input: 0.6, output: 2.5 });
    expect(priceFor('o3')).toMatchObject({ input: 2, output: 8, cacheRead: 0.5 });
    expect(priceFor('gemini-2.5-flash')?.input).toBe(0.3);
    expect(priceFor('codex-mini')?.output).toBe(6);
  });

  test('小写包含匹配，日期/厂牌前后缀仍命中，最长键优先', () => {
    expect(priceFor('Claude-Opus-4-20250514')).toBe(priceFor('claude-opus-4'));
    expect(priceFor('anthropic/claude-sonnet-4-5')).toBe(priceFor('claude-sonnet-4'));
    expect(priceFor('KIMI-K2-0905')).toBe(priceFor('kimi-k2'));
    expect(priceFor('o3-mini')).toBe(priceFor('o3'));
    // gpt-5 是 gpt-5-codex 的子串，两者标价相同，用对象身份确认取的是更长的键。
    expect(priceFor('openai/gpt-5-codex-latest')).toBe(priceFor('gpt-5-codex'));
    expect(priceFor('openai/gpt-5-codex-latest')).not.toBe(priceFor('gpt-5'));
    expect(priceFor('kimi-for-coding')).not.toBe(priceFor('kimi-k2'));
  });

  test('未知模型、空名降级为未定价', () => {
    expect(priceFor('llama-3')).toBeNull();
    expect(priceFor('claude-3-haiku')).toBeNull();
    expect(priceFor('')).toBeNull();
    expect(priceFor(undefined)).toBeNull();
    expect(priceFor(null)).toBeNull();
    expect(estimateCostUsd('no-such-model', { input: M, output: M })).toBe(0);
    expect(estimateCostUsd(undefined, { input: M, output: M })).toBe(0);
    expect(estimateCostUsd('', { input: M, output: M })).toBe(0);
  });
});

describe('estimateCostUsd 成本组成', () => {
  test('input/output/cache 分项，缺省 cache 价回落到 input', () => {
    expect(estimateCostUsd('claude-opus-4', { input: M, output: M, cacheRead: M, cacheWrite: M })).toBeCloseTo(
      15 + 75 + 1.5 + 18.75,
      8,
    );
    expect(estimateCostUsd('claude-opus-4', { input: 500_000, output: 200_000 })).toBeCloseTo(7.5 + 15, 8);
    // kimi 没有 cache 价：读写都按 input 0.6。
    expect(estimateCostUsd('kimi-k2', { input: 0, output: 0, cacheRead: M, cacheWrite: M })).toBeCloseTo(1.2, 8);
    // gpt-5 只标了 cacheRead，cacheWrite 回落 input 1.25。
    expect(estimateCostUsd('gpt-5', { input: 0, output: 0, cacheRead: M, cacheWrite: M })).toBeCloseTo(0.125 + 1.25, 8);
  });

  test('reasoning 是信息字段，不另计成本；空 token 与缺省 cache 为 0', () => {
    const withReasoning: TokenUsage = { input: M, output: M, cacheRead: M, cacheWrite: M, reasoning: 9 * M };
    const bare = { input: M, output: M, cacheRead: M, cacheWrite: M };
    expect(estimateCostUsd('claude-opus-4', withReasoning)).toBeCloseTo(estimateCostUsd('claude-opus-4', bare), 8);
    expect(estimateCostUsd('claude-opus-4', { input: 0, output: 0 })).toBe(0);
    expect(estimateCostUsd('claude-sonnet-4', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(estimateCostUsd('kimi-for-coding', { input: 0, output: M })).toBeCloseTo(2.5, 8);
  });
});
