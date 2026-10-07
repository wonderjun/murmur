/**
 * webview React 入口：挂载 React + 全局样式。
 * 字体全走系统栈（SF + 苹方），无内嵌字体资产；?seed 可注入仿真快照做离线版面预览。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app";
import "./app.css";
import { SEED_DIAG_AGENTS, seedStoredSessions } from "./design/demo-data";
import { useMurmurStore } from "./store/murmur";

import type { AgentStatus } from "@core/types";

// 离线预览种子：?seed 注入仿真快照，浏览器/截图复现真实数据版面（dev 专用）。
if (location.search.includes("seed")) {
  const now = Date.now();
  /* seed 用量桩：确定性 sin-hash 92 天 × 7 模型行，峰值量级 ~400M 与真机台账同档。
     只服务 02/03 图表与热力图的版面预览，字段取 UsageDailyRow 真形。 */
  const SEED_MODELS: [agent: string, model: string, weight: number][] = [
    ["kimi", "swe-2-max", 1.0],
    ["kimi", "k3-256k", 0.5],
    ["zcode", "glm-5.3-flash", 0.8],
    ["codex", "gpt-5.6-terra", 0.7],
    ["cursor", "kimi-for-coding", 0.6],
    ["zcode", "grok-4.7", 0.15],
    ["codex", "qwen3-max", 0.1],
    ["omp", "swe-2", 0.4],
  ];
  const seedHash = (n: number) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const pad2 = (n: number) => `${n}`.padStart(2, "0");
  const seedDay = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const seedUsageRows = Array.from({ length: 92 * SEED_MODELS.length }, (_, k) => {
    const d = Math.floor(k / SEED_MODELS.length);
    const [agent, model, weight] = SEED_MODELS[k % SEED_MODELS.length];
    const h1 = seedHash(d * 7 + model.length * 131 + 5);
    const spike = seedHash(d * 13 + model.length * 57 + 11) > 0.88 ? 6 : 1;
    const tokens = h1 < 0.22 ? 0 : Math.round(weight * 60e6 * (0.15 + h1) * spike);
    return { day: seedDay(now - (91 - d) * 86400_000), agent, model, tokens, costUsd: tokens * 3e-6 };
  }).filter((r) => r.tokens > 0);

  useMurmurStore.setState({
    loading: false,
    snapshot: {
      generatedAt: now,
      overall: "working",
      agents: [
        {
          agent: "kimi",
          disabled: false,
          install: { installed: true, version: "1.9.0", hasCredentials: true, homeDir: "~/.kimi", hookInstalled: true },
          sessions: Array.from({ length: 8 }, (_, i) => ({
            agent: "kimi" as const,
            sessionId: `s${i}`,
            status: (i === 0 ? "working" : i < 4 ? "waiting" : "idle") as AgentStatus,
            waitingReason: (i === 1 ? "approval" : i === 2 ? "question" : i === 3 ? "turn-end" : undefined) as
              | "approval"
              | "question"
              | "turn-end"
              | undefined,
            waitingDetail:
              i === 1 ? "Bash · Running: git push --force-with-lease" : i === 2 ? "剩余范围怎么定？" : undefined,
            phase: (i === 0 ? (i % 2 === 0 ? "tool" : "thinking") : undefined) as "thinking" | "tool" | undefined,
            toolName: i === 0 ? "Bash" : undefined,
            statusAt: now - (i === 0 ? 45_000 : 180_000),
            turnStartAt: now - 600_000,
            toolCallAt: i === 0 ? now - 45_000 : now - 120_000,
            title: `会话 ${i} — review一下git未提交的改动，看有没有bug或者可优化的地方`,
            cwd: "~/Documents/flow",
            model: "k3-256k",
            lastEventAt: now,
            startedAt: now - 600_000,
            tokens: { input: 12000, output: 3400 },
            costUsd: 0.12,
          })),
          quota: {
            agent: "kimi",
            fetchedAt: now,
            windows: [
              { label: "每周", usedPct: 78, used: 780, limit: 1000, resetsAt: now + 86400_000 },
              { label: "5h", usedPct: 5, used: 5, limit: 100, resetsAt: now + 3600_000 },
            ],
          },
        },
        {
          agent: "codex",
          disabled: false,
          install: { installed: true, version: "0.55", hasCredentials: true, homeDir: "~/.codex", hookInstalled: true },
          sessions: Array.from({ length: 3 }, (_, i) => ({
            agent: "codex" as const,
            sessionId: `c${i}`,
            status: "working" as const,
            phase: "thinking" as const,
            statusAt: now - 30_000,
            turnStartAt: now - 600_000,
            title: `codex 会话 ${i} — 长标题挤压版面高度测试`,
            cwd: "~/Documents/murmur",
            model: "gpt-5.3",
            lastEventAt: now,
            startedAt: now - 600_000,
            tokens: { input: 8000, output: 2000 },
            costUsd: 0.08,
          })),
          quota: { agent: "codex", fetchedAt: now, windows: [{ label: "5h", usedPct: 12, resetsAt: null }] },
        },
        {
          agent: "cursor",
          disabled: false,
          install: { installed: true, version: "2.0", hasCredentials: false, homeDir: "~/.cursor", hookInstalled: false },
          sessions: Array.from({ length: 3 }, (_, i) => ({
            agent: "cursor" as const,
            sessionId: `cu${i}`,
            status: "stale" as const,
            statusAt: now - 400_000,
            title: `cursor 会话 ${i} — 停止更新`,
            cwd: "~/Documents/flow",
            lastEventAt: now - 400_000,
            startedAt: now - 3_600_000,
            tokens: { input: 3000, output: 900 },
            costUsd: 0.03,
          })),
        },
        {
          agent: "devin",
          disabled: false,
          install: { installed: false, hasCredentials: false, homeDir: "~/.devin", hookInstalled: false },
          sessions: [],
        },
      ],
    },
    // 设置页离线桩：devin 未安装（监听开关应显关），codex hook 关（展示降级说明）；runtime 给 dev 典型值。
    // settings 字面量不引 @core/settings 值——该模块拉 node:fs，进不了浏览器包。
    settingsSnap: {
      settings: {
        launchAtLogin: false,
        showDockIcon: false,
        notifyOnWaiting: false,
        autoInstallHooks: true,
        theme: "system",
        font: "",
        agents: { kimi: true },
        hooks: { codex: false },
      },
      runtime: {
        dockIconVisible: false,
        launchAtLogin: false,
        canLaunchAtLogin: false,
        version: "0.4.0",
        channel: "dev",
        dataDir: "~/.murmur",
        ingestEndpoint: "127.0.0.1:54321",
        firstRun: false,
      },
    },
    // 离线桥的 usageDaily 一律 reject，会落错误态——seed 直接顶替数据源（忽略入参，92 天全量给足）。
    usageDaily: async () => seedUsageRows,
    // 管理台离线桩：诊断七家全景（zcode 需检查）+ 会话文件 14 条混合盘点。
    getDiagnostics: async () => ({
      firstRun: false,
      generatedAt: now,
      ingest: { endpoint: "127.0.0.1:54321", ok: true },
      agents: SEED_DIAG_AGENTS,
    }),
    scanSessions: async () => ({ items: seedStoredSessions(now), scannedAt: now }),
  });
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
