/**
 * 模型价格表（USD / 1M tokens）：本地台账的成本折算依据。
 *
 * 与 ccusage 同思路——内置价表 + 模糊匹配（模型名常带日期/前缀后缀）。
 * 价格定期随版本更新；表里没有的按 0 计，宁缺毋滥。
 */

interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const PRICES: Record<string, Price> = {
  // Anthropic
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125 },
  'codex-mini': { input: 1.5, output: 6, cacheRead: 0.375 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
  // Moonshot
  'kimi-for-coding': { input: 0.6, output: 2.5 },
  'kimi-k2': { input: 0.6, output: 2.5 },
  // Google
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

/** 按模型名模糊命中价格（小写包含匹配，取最长键优先）。 */
export function priceFor(model: string | undefined | null): Price | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: Price | null = null;
  let bestLen = 0;
  for (const [key, p] of Object.entries(PRICES)) {
    if (m.includes(key.toLowerCase()) && key.length > bestLen) {
      best = p;
      bestLen = key.length;
    }
  }
  return best;
}

/** 一次 usage 计量折成 USD。 */
export function estimateCostUsd(
  model: string | undefined,
  t: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number {
  const p = priceFor(model);
  if (!p) return 0;
  const m = 1_000_000;
  return (
    (t.input * p.input +
      t.output * p.output +
      (t.cacheRead ?? 0) * (p.cacheRead ?? p.input) +
      (t.cacheWrite ?? 0) * (p.cacheWrite ?? p.input)) /
    m
  );
}
