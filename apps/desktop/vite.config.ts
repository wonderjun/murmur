import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

const mainviewDir = fileURLToPath(new URL("./src/mainview", import.meta.url));
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // electrobunViteAliases 返回 {find, replacement} 数组，必须用数组形式合并。
    alias: [
      ...electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
      { find: /^@core(?<rest>\/.*)?$/, replacement: `${coreSrc}$<rest>` },
      { find: /^@(?<rest>\/.*)?$/, replacement: `${mainviewDir}$<rest>` },
    ],
  },
  root: "src/mainview",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
