/**
 * 图标渲染脚本：SVG 母版 → PNG（dock iconset 母图 + 托盘 template 图）。
 *
 * resvg 是原生依赖，不进仓库 devDependencies——在任意临时目录执行：
 *   mkdir /tmp/murmur-icons && cd /tmp/murmur-icons
 *   echo '{"name":"murmur-icons","private":true}' > package.json && bun add @resvg/resvg-js
 *   bun /path/to/murmur/apps/desktop/icons/render.ts
 * 产出 dock-1024.png / tray-44.png 于当前目录，再用 sips 缩到 icon.iconset 各尺寸
 * （tray 直接覆盖 assets/tray-icon.png，44 = 22pt @2x，纯黑+透明底铁约不可破）。
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)));

function render(svgPath: string, width: number): Buffer {
  const svg = new Resvg(readFileSync(svgPath, "utf8"), { fitTo: { mode: "width", value: width } });
  return Buffer.from(svg.render().asPng());
}

writeFileSync("dock-1024.png", render(join(SRC, "dock-icon.svg"), 1024));
writeFileSync("tray-44.png", render(join(SRC, "tray-icon.svg"), 44));
console.log("rendered dock-1024.png / tray-44.png");
