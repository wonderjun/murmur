# Murmur

菜单栏 AI Agent 状态伴侣 · A menu-bar status companion for AI coding agents

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.1.1-green.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

<img src="docs/screenshot.png" width="392" />

**纯观察者**：只读本地数据、无遥测、退出即全停。质感来自克制——只做状态呈现，不碰你的数据，不增功能噪音。

## 这是什么

你同时开着几个 AI 编码 agent（Kimi、Codex、Cursor……），它们各自跑在终端或 IDE 里——谁在干活、谁卡住等你批准、谁的额度快见底，没有统一答案。Murmur 栖在 macOS 菜单栏，把它们聚成一眼可读的动态：托盘标题实时聚合 `◆n`（有会话等你）/ `●n`（有会话在跑），点开是四视图面板——动态、用量、接入、设置。

## 支持的 Agent

| 工具 | 状态采集 | 额度 | 备注 |
|---|---|---|---|
| Kimi CLI | hook 上报 + wire.jsonl | `/usages` 官方端点 | |
| Z Code | hooks.events + sqlite/jsonl 轮询 | BYOK（z.ai / bigmodel） | 本机凭据加密，需自填 Key |
| OpenCode | 插件上报 + opencode.db 轮询 | 本地台账 | |
| Codex | hooks.json + notify + rollout tail | app-server RPC | 非 managed hook 需 `/hooks` trust |
| Cursor | hooks.json + transcripts tail | usage-summary | CLI 只发部分生命周期事件 |
| Devin | config.json hooks + sessions.db | Connect RPC + BYOK `cog_` | 云端会话走 v3 API |
| Qoder | settings.json hooks + jsonl + main.sqlite | 暂缺（PAT 候选） | 桌面端与 CLI 共用 `~/.qoder` |

## 功能

- **实时状态**：working / waiting（轮到你了）/ stale / idle，三平面采集——push hook、pull watcher、官方额度端点互为冗余
- **用量台账**：本地 `bun:sqlite` 日聚合（token + 估算成本），额度快照 10 分钟一轮
- **BYOK**：本地凭据不可读的 agent（如 zcode）支持自填 API Key，存 `~/.murmur/credentials.json`（0600），对外只显示掩码
- **会话文件管理**：盘点各 CLI 的磁盘会话产物，按工具/项目过滤、批量清理——文件进废纸篓可恢复，库内行事务删除
- **外观**：跟随系统/暗/亮主题，自定义字体
- **两级开关**：监听总闸 + hook 上报独立开关，卸载 hook 只摘除自己的条目，不碰共存工具的注入

## 隐私与安全

- 所有数据只进 `~/.murmur/`（sqlite 台账 + 设置 + spool），无任何遥测与上报
- hook 脚本只向 `127.0.0.1` 随机端口的本机 ingest 服务 POST，token 鉴权，任何分支 `exit 0` 不干预 agent 决策链
- 各 agent 的凭据严格只读，绝不代刷；BYOK key 明文不出 `credentials.json`

## 技术栈

Electrobun 桌面壳（Bun 主进程 + 系统 webview，无 Node/CEF）· React 19 + shadcn/ui + Zustand + Tailwind CSS v4 · `packages/core` 纯 TS 引擎（零运行时依赖，`bun test` 可独立跑）

## 构建与开发

前置：macOS、[Bun](https://bun.sh)、`hutch` 工具链（`~/.hutch/bin` 在 PATH 中，见 `apps/desktop/hutch.config.ts`）。

```bash
cd apps/desktop && hutch install && hutch electrobun sync  # 首次

bun run dev            # 构建并启动（watch 模式）
bun run dev:hmr        # vite HMR 开发模式
bun run build          # 出稳定 .app 包
bun run test           # core 引擎测试
bun run typecheck      # core 类型检查
bun run typecheck:desktop  # 桌面端类型检查
```

## 贡献与反馈

欢迎 issue 与 PR。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，架构与禁区见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE) © wangjun ([@chen-wang-jun](https://github.com/chen-wang-jun))

---

# Murmur (English)

A menu-bar status companion for AI coding agents — **a pure observer**: reads only local data, zero telemetry, everything stops on quit.

<img src="docs/screenshot.png" width="392" />

## What it does

AI coding agents each live in their own terminal or IDE — which one is working, which is blocked waiting for your approval, which is about to hit a quota wall? Murmur sits in the macOS menu bar and answers at a glance: the tray title aggregates `◆n` (sessions waiting on you) / `●n` (sessions working), and a click opens a four-view panel — live, usage, setup, settings.

Supports **7 agents** — Kimi CLI, Z Code, OpenCode, Codex, Cursor, Devin, Qoder — via a three-plane collection model: push hooks, pull watchers, and official quota endpoints, normalized into one status machine.

## Features

- Real-time session states (working / waiting / stale / idle)
- Local usage ledger (`bun:sqlite` daily aggregates) + quota snapshots
- BYOK API keys for agents whose local credentials are encrypted (`~/.murmur/credentials.json`, mode 0600, masked in UI)
- Session file manager: inventory, filter, and batch-clean CLI session artifacts (files → Trash, DB rows → transactional delete)
- Dark/light/system theme and custom font
- Two-level switches: observe gate + hook reporting toggle; hook uninstall only removes Murmur's own entries

## Privacy

Everything stays in `~/.murmur/` — no telemetry, no outbound reporting. Hook scripts only POST to a localhost ingest server with token auth. Agent credentials are strictly read-only; BYOK keys never leave `credentials.json` in plaintext.

## Development

Requires macOS, [Bun](https://bun.sh), and the `hutch` toolchain on PATH (see `apps/desktop/hutch.config.ts`).

```bash
bun run dev        # build & run (watch)
bun run dev:hmr    # vite HMR mode
bun run build      # stable .app bundle
bun run test       # core engine tests
```

Stack: Electrobun (Bun main process + system webview) · React 19 + shadcn/ui + Zustand + Tailwind CSS v4 · `packages/core` pure-TS engine.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © wangjun ([@chen-wang-jun](https://github.com/chen-wang-jun))
