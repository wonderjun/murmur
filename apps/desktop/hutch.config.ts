export default {
  packageManager: "bun",
  scripts: {
    install: ["bun", "install", "--frozen-lockfile"],
    dev: "hutch electrobun prepare && bunx vite build && hutch electrobun dev --watch",
    "dev:hmr": ["bunx", "concurrently", "hutch run hmr", "hutch run start"],
    start: "hutch electrobun prepare && bunx vite build && hutch electrobun dev",
    hmr: "hutch electrobun prepare && bunx vite --port 5173",
    build: "hutch electrobun prepare && bunx vite build && hutch electrobun build --env=stable",
    "build:canary": "hutch electrobun prepare && bunx vite build && hutch electrobun build --env=canary",
  },
};
