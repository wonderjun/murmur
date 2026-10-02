# Contributing

感谢想为 Murmur 出力。这份文档覆盖开发环境、约定与提交流程。

## 环境

- macOS（面板定位与托盘行为是 macOS 语义）
- [Bun](https://bun.sh)（主进程运行时 + 测试 + 包管理）
- `hutch` 工具链（`~/.hutch/bin` 需在 PATH，脚本真源见 `apps/desktop/hutch.config.ts`）

首次：

```bash
cd apps/desktop && hutch install && hutch electrobun sync
```

## 常用命令

```bash
bun run dev            # 构建并启动（watch 模式）
bun run dev:hmr        # vite HMR 开发模式（vite@5173 + app 本体）
bun run build          # 出稳定 .app 包
bun run test           # core 引擎测试（cd packages/core && bun test，bunfig preload 沙箱生效）
bun run typecheck      # core 类型检查
bun run typecheck:desktop  # 桌面端类型检查
```

提交前请确保 `bun run test` 与两个 typecheck 全绿。

## 仓库结构

- `packages/core` —— 纯 TS 引擎（`@murmur/core`）：adapter、状态机、台账、hooks 安装器、quota client。**零运行时依赖，禁止 import electrobun/react/DOM**，`bun test` 可独立跑
- `apps/desktop` —— Electrobun 壳：`src/bun` 是 Bun 主进程（tray/窗口/RPC），`src/mainview` 是 React webview，`src/shared/rpc.ts` 是双端契约
- `.agent/skill/` —— `code-style` 与 `ui-design` 两份规范，写码前必读

架构细节（三平面采集、回填语义、状态机、各 agent 实测坑）见 [AGENTS.md](AGENTS.md)。

## 代码约定（速查）

- 文件头 `/**` 块注释写「一句话职责 + 设计决策/实测事实」；导出符号单行中文 JSDoc；注释只写为什么与契约
- 命名：文件 kebab-case；类型 PascalCase；模块常量 UPPER_SNAKE_CASE；布尔 is/has/can/should；adapter 工厂 `createXxxAdapter()`
- import 五段排序：node/bun 内建 → 三方 → registry/ui 组件 → 本项目别名 → 相对路径；`import type` 独立成段
- `packages/core` 不碰桌面 API；webview 不裸摸 `window.electrobun`（走 `@/lib/rpc.ts` 的 `useRpc` 单例）
- 各 agent 凭据严格只读；BYOK key 只进 `credentials.json`，永不出现在 settings/RPC/日志
- UI 只用语义 token（`app.css` 是唯一真源），不裸写 hex/px 字号

完整禁区表见 AGENTS.md「坑与禁区」。

## 提交与 PR

- commit 信息用 conventional 格式（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`），中文描述即可
- 一个 commit 做一件事；跨模块共享文件的改动可并入同一批
- PR 请写清动机与测试计划；涉及 UI 的改动附截图
- 改动 `types.ts` 契约时记得双端同步（core ↔ desktop）

## 新增 agent adapter 的路线

1. `paths.ts` 加本机目录解析（留 env 覆盖口便于测试）
2. `agents/<id>/index.ts` 实现 `AgentAdapter`（detect/installHooks/watch/quota 全可选）
3. 需要磁盘清理支持就加 `agents/<id>/files.ts`（scanSessions/deleteSessions）
4. `types.ts` 的 `AgentId` 与 `ingest/server.ts` 白名单收编
5. `engine/registry.ts` 注册；`agent-meta.ts` 补 UI 元数据
6. `test/<id>.test.ts`：外部脏数据用 `as unknown as X` 收敛在边界，测试务必用 env 钉沙箱，绝不指向真机目录
