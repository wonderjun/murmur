/**
 * Desktop RPC 契约：`shared/rpc.ts` 的 bun requests / webview messages
 * 必须在主进程有对应 handler 或 `.send.*`。只扫源码，不加载 electrobun。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");
const rpcSource = readFileSync(join(desktop, "src/shared/rpc.ts"), "utf8");
const mainSource = readFileSync(join(desktop, "src/bun/index.ts"), "utf8");

describe("MurmurRPC 契约", () => {
  test("扫描器只取对象顶层键", () => {
    const src = `
      requests: {
        // comment: { no: true }
        getSnapshot: { params: {}; response: AppSnapshot };
        setAgentKey: {
          params: { apiKey: string };
          response: SettingsSnapshot;
        };
      };
    `;
    expect(objectKeys(src, nthObjectOpen(src, "requests", 1))).toEqual(["getSnapshot", "setAgentKey"]);
  });

  test("bun requests 与主进程 handlers 一一对应", () => {
    const contract = objectKeys(rpcSource, nthObjectOpen(rpcSource, "requests", 1));
    const handlersAt = mainSource.indexOf("handlers:");
    expect(handlersAt).toBeGreaterThanOrEqual(0);
    const handlerSrc = mainSource.slice(handlersAt);
    const handlers = objectKeys(handlerSrc, nthObjectOpen(handlerSrc, "requests", 1));
    expect(symmetricDiff(contract, handlers)).toEqual({ missing: [], extra: [] });
    expect(contract.length).toBeGreaterThan(0);
  });

  test("webview messages 都有主进程 send", () => {
    const messages = objectKeys(rpcSource, nthObjectOpen(rpcSource, "messages", 2));
    const sent = [...mainSource.matchAll(/\.send\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    expect(symmetricDiff(messages, sent)).toEqual({ missing: [], extra: [] });
    expect(messages).toContain("snapshot");
  });
});

/** 第 n 个 `label: {` 的花括号下标（1-based）。 */
function nthObjectOpen(source: string, label: string, n: number): number {
  const re = new RegExp(`\\b${label}\\s*:\\s*\\{`, "g");
  let seen = 0;
  for (const match of source.matchAll(re)) {
    seen += 1;
    if (seen === n) return match.index + match[0].length - 1;
  }
  throw new Error(`找不到第 ${n} 个 ${label} 对象`);
}

/** 取对象字面量深度为 1 的键，跳过注释、字符串和嵌套块。 */
function objectKeys(source: string, openBrace: number): string[] {
  const keys: string[] = [];
  let depth = 1;
  let pending = "";
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "{") {
      depth += 1;
      pending = "";
      i += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      pending = "";
      i += 1;
      continue;
    }
    if (depth === 1 && c === ":") {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(pending)) keys.push(pending);
      pending = "";
      i += 1;
      continue;
    }
    if (depth === 1 && /[A-Za-z0-9_]/.test(c)) pending += c;
    else if (depth === 1 && !/\s/.test(c)) pending = "";
    i += 1;
  }
  if (depth !== 0) throw new Error("对象花括号不配对");
  return keys;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function symmetricDiff(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((name) => !actualSet.has(name)),
    extra: actual.filter((name) => !expectedSet.has(name)),
  };
}
