/**
 * 外观应用：settings.theme/font → <html data-theme> + 字体栈变量覆盖。
 *
 * theme='system' 经 matchMedia 解析为 dark/light 并挂 change 监听；
 * font 非空时把字体名 prepend 进 --font-sans/--font-mono 栈（内联覆盖
 * @theme 变量），系统里没有该字体时 CSS 字体栈自然回退——isFontAvailable
 * 只服务于设置页的「未检测到」提示，不影响实际渲染。
 * 回退栈常量与 app.css :root 的 --font-*-stack 保持一致（双写注意）。
 */

import type { ThemePreference } from "@core/settings";

const SYSTEM_DARK = window.matchMedia("(prefers-color-scheme: dark)");
const SANS_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif';
const MONO_FALLBACK = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** 字体名净化：剔引号/分号/花括号防 CSS 值注入，逗号也不收（只认单字体名）。 */
function sanitizeFontName(raw: string): string {
  return raw
    .replace(/["'\\,;{}]/g, "")
    .trim()
    .slice(0, 60);
}

/** 当前系统外观对应的主题值。 */
export function resolveSystemTheme(): "dark" | "light" {
  return SYSTEM_DARK.matches ? "dark" : "light";
}

/** 应用主题与字体到 <html>；system 时返回媒体监听的解绑函数。
    ?theme=dark|light 是预览强制覆盖（设计板/截图用），不进设置。 */
export function applyAppearance(theme: ThemePreference, font: string): () => void {
  const root = document.documentElement;
  const forced = new URLSearchParams(location.search).get("theme");
  const effective: ThemePreference = forced === "dark" || forced === "light" ? forced : theme;
  root.dataset.theme = effective === "system" ? resolveSystemTheme() : effective;

  const name = sanitizeFontName(font);
  if (name) {
    root.style.setProperty("--font-sans", `"${name}", ${SANS_FALLBACK}`);
    root.style.setProperty("--font-mono", `"${name}", ${MONO_FALLBACK}`);
  } else {
    root.style.removeProperty("--font-sans");
    root.style.removeProperty("--font-mono");
  }

  if (effective !== "system") return () => {};
  const onSystemChange = () => {
    root.dataset.theme = resolveSystemTheme();
  };
  SYSTEM_DARK.addEventListener("change", onSystemChange);
  return () => SYSTEM_DARK.removeEventListener("change", onSystemChange);
}

/** 字体是否真实存在于本机（设置页提示用，渲染层不依赖它）。 */
export function isFontAvailable(font: string): boolean {
  const name = sanitizeFontName(font);
  if (!name) return false;
  try {
    return document.fonts.check(`12px "${name}"`);
  } catch {
    // 极少数环境 FontFaceSet 缺失时按「已识别」提示，实际渲染由 CSS 栈兜底。
    return true;
  }
}
