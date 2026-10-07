export default {
  packageManager: "bun",
  // 不钉版本时 sync 会漂到 stable 最新版，desktop 类型面和 tsconfig paths 会对不上已提交的 devkit。
  // 升级：改这里的精确 semver → `cd apps/desktop && hutch electrobun sync` → 仓库根 `bun run sync:tsconfig`。
  electrobun: { version: "2.0.1" },
  scripts: {
    install: ["bun", "install", "--frozen-lockfile"],
    dev: "hutch electrobun prepare && bunx vite build && hutch electrobun dev --watch",
    "dev:hmr": ["bunx", "concurrently", "hutch run hmr", "hutch run start"],
    start: "hutch electrobun prepare && bunx vite build && hutch electrobun dev",
    hmr: "hutch electrobun prepare && bunx vite --port 5173",
    build: "hutch electrobun prepare && bunx vite build && hutch electrobun build --env=stable",
    "build:canary": "hutch electrobun prepare && bunx vite build && hutch electrobun build --env=canary",
    lint: ["bunx", "eslint", "."],
    "lint:fix": ["bunx", "eslint", ".", "--fix"],
    format: ["bunx", "prettier", "--write", "."],
  },
};
