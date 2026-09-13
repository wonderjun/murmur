/**
 * JSON 对象顶层值区间定位器：只扫结构不物化值，用于大行 JSONL 的定向字段提取。
 *
 * 动机（zcode model-io 实测）：单行 ~300KB，request 内嵌完整 prompt/消息与
 * authorization 头——全量 JSON.parse 会把敏感负载搬进堆只为读 6 个字段。
 * 这里用状态机单趟扫顶层键名：字符串内容里的 `"usage":{` 诱饵文本与
 * providerMetadata 等嵌套同名键天然免疫（键只在深度 1 的 expect-key 态读取），
 * 重复键后者覆盖前者（与 JSON.parse 同语义）。命中后由调用方对值片段局部 parse。
 */

type Span = [number, number];

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_LBRACKET = 0x5b;
const CH_RBRACKET = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_BACKSLASH = 0x5c;

function skipWs(json: string, i: number, to: number): number {
  while (i < to) {
    const c = json.charCodeAt(i);
    if (c !== CH_SPACE && c !== CH_TAB && c !== CH_LF && c !== CH_CR) break;
    i++;
  }
  return i;
}

/** i 指向开引号，返回字符串结束后的位置（\" 转义感知，截断时返回 to）。 */
function skipString(json: string, i: number, to: number): number {
  i++;
  while (i < to) {
    const c = json.charCodeAt(i);
    if (c === CH_BACKSLASH) {
      i += 2;
      continue;
    }
    if (c === CH_QUOTE) return i + 1;
    i++;
  }
  return to;
}

/** i 指向 { 或 [，返回配对闭括号后的位置（内部字符串整体跳过，截断时返回 to）。 */
function skipComposite(json: string, i: number, to: number): number {
  let depth = 0;
  while (i < to) {
    const c = json.charCodeAt(i);
    if (c === CH_QUOTE) {
      i = skipString(json, i, to);
      continue;
    }
    if (c === CH_LBRACE || c === CH_LBRACKET) depth++;
    else if (c === CH_RBRACE || c === CH_RBRACKET) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return to;
}

/** 单趟扫描 json[from,to) 的顶层对象，返回 keys 中每个键的值区间 Map。 */
export function topLevelValueSpans(
  json: string,
  keys: readonly string[],
  from = 0,
  to = json.length,
): Map<string, Span> {
  const want = new Set(keys);
  const out = new Map<string, Span>();
  let i = skipWs(json, from, to);
  if (json.charCodeAt(i) !== CH_LBRACE) return out; // 只认对象。
  i++;
  while (i < to) {
    i = skipWs(json, i, to);
    const c = json.charCodeAt(i);
    if (c === CH_RBRACE) return out; // 对象结束。
    if (c !== CH_QUOTE) return out; // 键必须是字符串，否则整行非法不猜。
    const kEnd = skipString(json, i, to);
    let k: string;
    try {
      k = JSON.parse(json.slice(i, kEnd)) as string;
    } catch {
      return out; // 键损坏：返回已收集的，不猜。
    }
    i = skipWs(json, kEnd, to);
    if (json.charCodeAt(i) !== CH_COLON) return out; // 键后无冒号，非法。
    i = skipWs(json, i + 1, to);
    const vStart = i;
    const vc = json.charCodeAt(i);
    let vEnd: number;
    if (vc === CH_QUOTE) vEnd = skipString(json, i, to);
    else if (vc === CH_LBRACE || vc === CH_LBRACKET) vEnd = skipComposite(json, i, to);
    else {
      while (i < to) {
        const lc = json.charCodeAt(i);
        if (lc === CH_COMMA || lc === CH_RBRACE || lc === CH_RBRACKET) break;
        i++;
      }
      vEnd = i;
    }
    if (want.has(k)) out.set(k, [vStart, vEnd]);
    i = skipWs(json, vEnd, to);
    if (json.charCodeAt(i) !== CH_COMMA) return out; // } 或截断：停止。
    i++;
  }
  return out;
}

/** topLevelValueSpans 的单键便捷版。 */
export function topLevelValueSpan(json: string, key: string, from = 0, to = json.length): Span | undefined {
  return topLevelValueSpans(json, [key], from, to).get(key);
}

/** 对值区间做局部 parse 并窄化成非空字符串；缺失/非字符串/损坏返回 undefined。 */
export function stringAtSpan(json: string, span: Span | undefined): string | undefined {
  if (!span) return undefined;
  try {
    const v: unknown = JSON.parse(json.slice(span[0], span[1]));
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined; // 片段损坏。
  }
}

/** 取顶层字符串字段的值。 */
export function topLevelString(json: string, key: string, from = 0, to = json.length): string | undefined {
  return stringAtSpan(json, topLevelValueSpan(json, key, from, to));
}
