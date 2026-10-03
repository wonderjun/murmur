/**
 * 架构边界：core 保持纯 TS；webview 除 lib/rpc.ts 外不碰 electrobun 桥；
 * shared/rpc.ts 只做类型 import；生产源码不得出现显式 any。
 * 源码扫描，不加载 electrobun。
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repo = join(import.meta.dir, "..", "..", "..");

describe("架构边界", () => {
  test("core 不引用 electrobun、react 或 DOM", () => {
    const hits = scan(join(repo, "packages/core/src"), (source) => {
      const code = stripComments(source);
      const forbiddenImport = importSpecifiers(code).filter(
        (spec) => spec === "react" || spec === "react-dom" || spec.startsWith("react/") || spec.startsWith("electrobun"),
      );
      const dom = [...stripStrings(code).matchAll(/\b(?:window|document|HTMLElement|DOMParser)\b/g)].map((m) => m[0]);
      return [...forbiddenImport, ...dom];
    });
    expect(hits).toEqual([]);
  });

  test("mainview 除 lib/rpc.ts 外不 import electrobun、不访问桥", () => {
    const rpc = join(repo, "apps/desktop/src/mainview/lib/rpc.ts");
    const hits = scan(join(repo, "apps/desktop/src/mainview"), (source, file) => {
      if (file === rpc) return [];
      const code = stripComments(source);
      const specifiers = importSpecifiers(code).filter((spec) => spec === "electrobun" || spec.startsWith("electrobun/"));
      const bridge = [...stripStrings(code).matchAll(/\b(?:__electrobun|Electroview|Electrobun)\b|window\.electrobun/g)].map(
        (m) => m[0],
      );
      return [...specifiers, ...bridge];
    });
    expect(hits).toEqual([]);
  });

  test("shared/rpc.ts 的 import 全是类型 import", () => {
    const file = join(repo, "apps/desktop/src/shared/rpc.ts");
    const code = stripComments(readFileSync(file, "utf8"));
    const imports = [...code.matchAll(/\bimport\b[\s\S]*?\bfrom\b\s*["'][^"']+["']/g)].map((m) => m[0]);
    expect(imports.length).toBeGreaterThan(0);
    const valueImports = imports.filter((stmt) => !/^import\s+type\b/.test(stmt));
    expect(valueImports).toEqual([]);
    expect(stripStrings(code)).not.toMatch(/\brequire\s*\(/);
    expect(stripStrings(code)).not.toMatch(/\bimport\s*\(/);
  });

  test("rpc-handlers 不 import electrobun", () => {
    const file = join(repo, "apps/desktop/src/bun/rpc-handlers.ts");
    const code = stripComments(readFileSync(file, "utf8"));
    expect(importSpecifiers(code).some((spec) => spec.startsWith("electrobun"))).toBe(false);
  });

  test("生产源码没有显式 any", () => {
    const hits: string[] = [];
    for (const root of ["packages/core/src", "apps/desktop/src"]) {
      for (const file of collect(join(repo, root))) {
        if (/\.(test|spec)\.tsx?$/.test(file)) continue;
        const rel = relative(repo, file).split(sep).join("/");
        for (const line of findExplicitAny(readFileSync(file, "utf8"))) hits.push(`${rel}:${line}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("注释和字符串里的 any 不报，类型与表达式里的 any 报", () => {
    const source = [
      "// any",
      "/* any",
      "   still any */ const after: any = 1;",
      'const label = "any";',
      "const q = 'any';",
      "const t = `any ${any} ${`no any ${any as unknown}`} \\${any}`;",
      'const s = "any\\" still";',
      "type T = Promise<any>;",
      "const v = value as any;",
      "const w = value as unknown;",
      "const name = anyone;",
      "const n = any_;",
      "const dollar = $any;",
      "fn(any, any);",
      "const obj = `${ { any: 1 } }`;",
      "const commented = 1; // any",
      "const z = a / any;",
    ].join("\n");
    // 3 块注释结束后的类型；6 两处插值（模板文本与转义 ${} 不算）；8、9 类型；14 两次实参；15 插值里的键；17 除法后的标识符。
    expect(findExplicitAny(source)).toEqual([3, 6, 6, 8, 9, 14, 14, 15, 17]);
  });
});

function scan(dir: string, visit: (source: string, file: string) => string[]): string[] {
  const hits: string[] = [];
  for (const file of collect(dir)) {
    const source = readFileSync(file, "utf8");
    for (const hit of visit(source, file)) hits.push(`${relative(repo, file).split(sep).join("/")}: ${hit}`);
  }
  return hits;
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** 去掉注释，保留字符串（import specifier 还要读）。 */
function stripComments(source: string): string {
  return transform(source, false);
}

/** 再去掉字符串，避免文案里的 window/document 误伤。 */
function stripStrings(source: string): string {
  return transform(source, true);
}

function transform(source: string, dropStrings: boolean): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      out += "\n";
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (dropStrings && (c === '"' || c === "'" || c === "`")) {
      i = skipString(source, i);
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
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

function importSpecifiers(stripped: string): string[] {
  return [...stripped.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

const IDENT_START = /^\p{ID_Start}$/u;
const IDENT_PART = /^\p{ID_Continue}$/u;

type ScanFrame = { kind: "code"; depth: number } | { kind: "tpl" };

/** 显式 any 的行号（1 起）。跳过注释、引号字符串和模板静态文本；插值里的代码仍扫。 */
export function findExplicitAny(source: string): number[] {
  const hits: number[] = [];
  const stack: ScanFrame[] = [{ kind: "code", depth: 0 }];
  let i = 0;
  let line = 1;

  const bump = (cp: number) => {
    if (cp === 10) line += 1;
  };

  while (i < source.length) {
    const cp = source.codePointAt(i) ?? 0;
    const frame = stack[stack.length - 1];
    if (!frame) break;

    if (frame.kind === "tpl") {
      if (cp === 92) {
        i += 1;
        const next = source.codePointAt(i);
        if (next !== undefined) {
          bump(next);
          i += next > 0xffff ? 2 : 1;
        }
        continue;
      }
      if (cp === 96) {
        stack.pop();
        i += 1;
        continue;
      }
      if (cp === 36 && source.codePointAt(i + 1) === 123) {
        stack.push({ kind: "code", depth: 0 });
        i += 2;
        continue;
      }
      bump(cp);
      i += cp > 0xffff ? 2 : 1;
      continue;
    }

    if (cp === 47 && source.codePointAt(i + 1) === 47) {
      i += 2;
      while (i < source.length) {
        const next = source.codePointAt(i) ?? 0;
        bump(next);
        i += next > 0xffff ? 2 : 1;
        if (next === 10) break;
      }
      continue;
    }
    if (cp === 47 && source.codePointAt(i + 1) === 42) {
      i += 2;
      while (i < source.length) {
        const next = source.codePointAt(i) ?? 0;
        if (next === 42 && source.codePointAt(i + 1) === 47) {
          i += 2;
          break;
        }
        bump(next);
        i += next > 0xffff ? 2 : 1;
      }
      continue;
    }
    if (cp === 34 || cp === 39) {
      i += 1;
      while (i < source.length) {
        const next = source.codePointAt(i) ?? 0;
        if (next === 92) {
          i += 1;
          const escaped = source.codePointAt(i);
          if (escaped !== undefined) {
            bump(escaped);
            i += escaped > 0xffff ? 2 : 1;
          }
          continue;
        }
        bump(next);
        i += next > 0xffff ? 2 : 1;
        if (next === cp) break;
      }
      continue;
    }
    if (cp === 96) {
      stack.push({ kind: "tpl" });
      i += 1;
      continue;
    }
    if (isIdentStart(cp)) {
      const startLine = line;
      let text = "";
      while (i < source.length) {
        const next = source.codePointAt(i) ?? 0;
        if (!isIdentPart(next) && text.length > 0) break;
        if (!isIdentStart(next) && text.length === 0) break;
        text += String.fromCodePoint(next);
        bump(next);
        i += next > 0xffff ? 2 : 1;
      }
      if (text === "any") hits.push(startLine);
      continue;
    }
    if (cp === 123) frame.depth += 1;
    else if (cp === 125) {
      if (frame.depth === 0 && stack.length > 1) stack.pop();
      else frame.depth = Math.max(0, frame.depth - 1);
    }
    bump(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return hits;
}

function isIdentStart(cp: number): boolean {
  if (cp === 36 || cp === 95) return true;
  if (cp < 128) return (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
  return IDENT_START.test(String.fromCodePoint(cp));
}

function isIdentPart(cp: number): boolean {
  if (isIdentStart(cp)) return true;
  if (cp >= 48 && cp <= 57) return true;
  if (cp < 128) return false;
  return IDENT_PART.test(String.fromCodePoint(cp));
}
