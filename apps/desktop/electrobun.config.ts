import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Murmur",
    identifier: "dev.murmur.app",
    version: "0.1.3",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // Vite builds to dist/, we copy from there
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      assets: "views/assets",
    },
    // Ignore Vite output in watch mode — HMR handles view rebuilds separately
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
  release: {
    // GitHub Releases 托管更新件；/latest/download 只跟随正式 release（不含 prerelease）
    baseUrl: "https://github.com/chen-wang-jun/murmur/releases/latest/download",
    // 应用内 Updater 未接入前不产 delta patch（首版也无前序 release 可 diff）
    generatePatch: false,
  },
} satisfies ElectrobunConfig;
