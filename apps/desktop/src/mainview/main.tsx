/**
 * webview React 入口：挂载 React + 全局样式。
 * 字体全走系统栈（SF + 苹方），无内嵌字体资产；?seed 可注入仿真快照做离线版面预览。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app";
import "./app.css";
import { useMurmurStore } from "./store/murmur";

import type { AgentStatus } from "@core/types";

// 离线预览种子：?seed 注入仿真快照，浏览器/截图复现真实数据版面（dev 专用）。
if (location.search.includes("seed")) {
  const now = Date.now();
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
            title: `cursor 会话 ${i} — 停止更新`,
            cwd: "~/Documents/flow",
            lastEventAt: now - 400_000,
            startedAt: now - 3_600_000,
            tokens: { input: 3000, output: 900 },
            costUsd: 0.03,
          })),
        },
      ],
    },
  });
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
