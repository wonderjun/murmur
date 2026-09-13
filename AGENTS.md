# Murmur

对标 Agent Island 的菜单栏 AI Agent 状态伴侣。**纯观察者**：只读本地数据、无遥测、退出即全停。质感来自克制——只做状态呈现，不碰用户数据，不增功能噪音。

## 技术栈

- 桌面壳：Electrobun（`apps/desktop`），**Bun 主进程** + 系统 webview（无 Node 运行时、无 CEF）
- UI：Vue 3 `<script setup>` + reka-ui + Tailwind CSS v4（`src/mainview`）
- 引擎：`packages/core`（`@murmur/core`，纯 TS、零运行时依赖，禁止 import electrobun/vue/DOM；`bun test` 可独立跑）
- 存储：`bun:sqlite`（`~/.murmur/murmur.db`，WAL）
- 构建：`hutch`（`~/.hutch/bin` 需在 PATH）

Monorepo 无 workspaces：core 以 **TS 源码**直接被 desktop 消费（`exports` 指向 `./src/index.ts`，无编译产物）。desktop 的脚本真源在 `apps/desktop/hutch.config.ts`（其 package.json 没有 scripts），根目录 scripts 只是对 hutch/bun 的转发。

## 常用命令

```bash
# 桌面应用（在 apps/desktop 下执行 hutch 命令，或根目录 scripts）
bun run dev            # 构建并启动（watch 模式）
bun run dev:hmr        # 带 vite HMR 的开发模式（vite@5173 + app 本体）
bun run build          # 出稳定包
bun run test           # core 引擎测试（bun test packages/core）
bun run typecheck      # core 类型检查（tsc --noEmit）
bun run typecheck:desktop  # 桌面端类型检查（vue-tsc，覆盖 webview + bun 主进程）
```

首次：`cd apps/desktop && hutch install && hutch electrobun sync && hutch run dev`。

## 目录地图

```
packages/core/src/
  types.ts          全链路类型契约：AgentId / AgentStatus / AgentEvent / AppSnapshot（改动需双端同步）
  paths.ts          各 agent 本机目录解析器（env 可覆盖，见「坑」）
  agents/           5 个 adapter（kimi / zcode / opencode / codex / cursor），把各家私有格式翻译成 AgentEvent
    base.ts         AgentAdapter 接口（detect/installHooks/watch/quota 能力面全可选）+ JsonlTailer + pick()
  engine/           registry.ts 组装根（定时器/快照/广播）+ status-engine.ts 会话状态机
  ingest/           server.ts（Bun.serve，token 鉴权）+ endpoint.ts（~/.murmur/endpoint）+ spool.ts（离线补投）
  ledger/           db.ts（bun:sqlite 台账、游标、聚合）+ pricing.ts（内置价表估成本）
  hooks/            script.ts（POSIX sh 上报脚本模板）+ install.ts（merge* 合并安装 / unmerge* 卸载，只认脚本路径判归属）
  settings.ts       用户设置（~/.murmur/settings.json）：自启/Dock/通知 + agents[]/hooks[] 两级开关，缺省皆 true
  migrate.ts        perch→murmur 一次性迁移（家目录搬迁 + 旧制品清扫，幂等，主进程启动时调用）
  quota/            kimi.ts / codex.ts（官方用量端点 client）+ common.ts（超时 fetch / 降级件）
apps/desktop/
  src/bun/index.ts  主进程：tray + 透明面板 + registry 组装 + RPC 推送（唯一桌面 API 入口）
  src/bun/system.ts Dock 显隐（Utils.setDockIconVisible）+ 自启（~/Library/LaunchAgents plist）
  src/shared/rpc.ts 双端 RPC 契约 MurmurRPC
  src/mainview/     Vue webview：store/murmur.ts（Pinia）+ components/ + app.css（design token 唯一真源）
.agent/skill/       code-style（代码风格）、ui-design（视觉契约）两份规范，写码前必读
```

## 架构

数据流一条链：

```
三平面采集（push hook POST / pull watch 轮询 / quota 官方端点）
  → adapter 翻译成归一化 AgentEvent（types.ts）
  → Ledger 落库 + StatusEngine 状态机
  → AgentRegistry 组装 AppSnapshot（80ms 去抖广播）
  → RPC messages.snapshot → Pinia store → 组件渲染
```

### 三平面采集

- **Push**：hook 脚本（`hooks/script.ts` 生成，落 `~/.murmur/agent-hooks/<agent>.sh`）POST `http://127.0.0.1:<随机端口>/hook/<agent>`，`X-Murmur-Hook-Token` 鉴权。脚本铁约：stdout 只吐 `{}`（不干预 agent 决策链；**kimi 例外用 `stdoutAck:false` 完全不吐**——UserPromptSubmit 的 stdout 会被注进用户上下文）、stdin/argv 双兼容、失败追加 spool（`~/.murmur/spool/<agent>.jsonl`，单文件 5MiB 上限）、**任何分支都 exit 0**。spool 启动时 + 每 60s 补投。cursor 的 `hooks.json` 条目必须用**直挂** `{command,timeout}` 形状 + 顶层 `version:1`——嵌套 `{"hooks":[...]}` 组形状只有 IDE 跑，cursor-agent CLI 不触发（CLI 也只发 sessionStart/stop/postToolUse 等子集）。kimi 的 `[[hooks]]` 是 TOML 数组表（0.41 实测）：走 `mergeTomlHooks` 行扫合并、EOF 追加、只认脚本路径判归属；payload 恒带 `session_id`/`cwd` 但**无 usage**。codex 双通道：`hooks.json` 官方 12 生命周期事件（matcher-group 包 command handler，`mergeCodexHooks` 合并、handler 带 `async:true`；**非 managed hook 需用户 /hooks trust**，装好≠生效）+ `config.toml` legacy `notify`（免 trust、仅 agent-turn-complete）兜底；hook payload 的 sessionId 优先取 `transcript_path` 文件名尾段 uuid 与 pull 平面对齐。
- **Pull**：kimi watch `wire.jsonl`（fs.watch + 5s 兜底重扫）——push 已接管状态面后，pull 专职 `usage.record` token 台账（hook payload 无 token，实测）、`state.json` title、回填与未装 hook 会话的兜底；zcode 轮询 `v2/tasks-index.sqlite` + tail `model-io-*.jsonl`（行 ~300KB 走 `tailRaw` + `json-span` 定向提取，不物化 request 全文）；opencode 按 rowid 游标轮询 `opencode.db` 的 `event` 表并独掌 usage 台账（push 插件在 translateHook 剥离 usage 防双通道重记）——`part` 无 model 字段，usage 经 `message` 表 join 补 modelID（message.updated 行顺路喂 cache）；`session.status` 载荷 v1.x 是 `{type}` 对象、旧版裸字符串，两形兼容；db 缺失的 pre-sqlite 旧版回退 `agents/opencode/legacy.ts` 扫 `storage/message` JSON 按 msgID 记 delta；插件只转白名单事件（流式 part chunk 不 POST）；codex tail `rollout-*.jsonl`；cursor tail `projects/*/agent-transcripts/**.jsonl`（行内无时间戳/token，at 取文件 mtime，subagents 归并父会话）+ 轮询 `chats/*/meta.json` 探 CLI 会话活性（updatedAtMs 启发式）。增量游标存台账 `cursors` 表（`jsonl:<path>` → 字节偏移）。JSONL 增量统一走 `JsonlTailer`（半行缓存、截断归零）。zcode 另有可选 push：合并 `cli/config.json` 的 `hooks.events` 七事件（command+async 旁路，`hooks.enabled` 显式 false 不抢），补 approval 与实时 turn.end——usage/session.end 仍只能 pull。
- **Quota**：本地凭据调官方用量端点（kimi `/usages`、codex 优先 `codex app-server` 官方 JSON-RPC——`account/rateLimits/read` oneshot 即走、登录态由 codex 本体管，失败回落 wham/usage 直读 `auth.json`、cursor `cursor.com/api/usage-summary`——凭据是 IDE `state.vscdb` 里的 `cursorAuth/accessToken` JWT，拼 `WorkosCursorSessionToken` cookie 鉴权，CLI `auth.json` 兜底），8s 超时，10 分钟一轮 + UI 手动触发；失败静默降级 unavailable 并回退上次快照。**凭据严格只读、绝不代刷**（见禁区）。

### 回填语义（pull 平面的灵魂）

历史事件不冒充当下：无时间戳或超出 `LIVE_WINDOW_MS`（90s）的旧事件按「建档落真实残态」处理——旧 `turn.end` 落 waiting（真实状态就是等你），旧 `turn.start/tool.call` 落 ended（废弃 turn），不置 working、不发通知。回填语义版本号 `BACKFILL_EPOCH`（ledger/db.ts）变更时自动清库全量重扫。70 天（`BACKFILL_WINDOW_MS`）外的旧事件不落库。

### 状态机（engine/status-engine.ts）

```
session.start → idle    turn.start/tool.call → working    permission.request → waiting(approval)
turn.end → waiting(turn-end)「轮到你了」    session.end → ended（grace 60s 后清除）
```

常量：working 无事件 3min（`STALE_AFTER_MS`）→ stale（watchdog 每 15s sweep）；stale 30min 无动静 → ended 兜底（进程多半已死）；waiting 30min 衰减回 idle；会话 24h 无动静剔除。**快照只出活跃会话**：working/waiting/stale 直出，idle 仅限 `LIVE_WINDOW_MS` 内新建（start→turn.start 过渡），ended 不进面板（grace 期只留 Map 供同 id 复活）。聚合态取最高优先级：working > waiting > stale > idle > ended。

### 存储（ledger/db.ts）

`~/.murmur/murmur.db`（WAL）5 张表：`events`（流水审计）、`usage_daily`（**日聚合**用量：PK(day,agent,model) upsert 累加，写入即聚合，无明细行）、`quota_snapshots`（额度快照）、`cursors`（pull 游标）、`meta`（epoch 等元数据）。`raw` 原始 payload 落库前截断 4000 字符。**保留清扫 `Ledger.prune()`**（启动 + 每 24h）：events 7d（纯审计无读方）、usage_daily 无 TTL（每年每 agent 数百行）、quota_snapshots 每 agent 最新 50 条、cursors 清 70d 未推进或源文件已删的游标，收尾 `wal_checkpoint(TRUNCATE)` + `VACUUM`（被占用跳过下轮）。spool `.done` 存档 24h 后由 drainSpool 顺带清。旧 `token_ledger` 明细表在构造时一次性 GROUP BY 折叠进 `usage_daily` 后 DROP。

### 主进程与通信

`apps/desktop/src/bun/index.ts`：tray（标题 `◆n`（waiting）/ `●n`（working）聚合态，只能用默认文本渲染的几何字形，emoji 会在菜单栏变彩色、破坏单色体系；不放原生菜单，挂 menu 会接管左键点击）+ 392×600 面板（`titleBarStyle:"hiddenInset"` + 空标题 + 无按钮，标准窗口几何 + 全尺寸内容，系统圆角+阴影由系统裁——`titleBarStyle:"hidden"` 的无边框窗口在 macOS 26 露方形底板、`"default"` 会画出标题栏、`transparent:true` 关不掉方形原生阴影（2.0.1 无 hasShadow API），都不可用；失焦即 hide）+ RPC。bun 侧 requests：`getSnapshot / installHooks / hidePanel / refreshQuotas / usageDaily / getSettings / updateSettings / setAgentHook / setAgentObserved / rebuildLedger / openDataDir / quitApp`（quitApp 经 quitMurmur 保证 stop 失败也必 exit）；webview 侧 messages：`snapshot` 全量推送。UI 禁止直接摸 `window.electrobun`，一律走 `@/lib/rpc.ts` 的 `useRpc` 单例。四视图：live（动态）/ usage（用量）/ setup（接入）/ settings（设置）。

### 设置与开关（settings.ts + 设置页）

`~/.murmur/settings.json` 是唯一真源（loadSettings/saveSettings 原子写、损坏回默认）。两级 per-agent 开关语义：**监听**（`agents[]`）是总闸——关闭即停 watcher、`ingest_` 丢事件、不拉额度、快照标 `disabled:true` 且不带会话/用量，并顺带卸载其 hook（用户 hooks 偏好保留，重开时回装）；**hook 上报**（`hooks[]`）只管 push 平面——关闭=unmerge* 真卸载我方条目（他人保留），观察退回 pull 轮询。两张表**缺省皆 true**（flagEnabled 约定），`autoInstallHooks`（默认开）让启动时自动装「监听中+已安装+hook 未关」的 agent。系统偏好：Dock 显隐经 `Utils.setDockIconVisible`（默认藏，accessory 策略）；自启写 `~/Library/LaunchAgents/<identifier>.plist`（`open -g <bundle>`），**只写不 bootstrap**——立即 load 会多起一个实例；dev channel 无 .app bundle，开关禁用。waiting 通知（默认关）按 sessionId 集合 diff，首快照作基线防回填轰炸，面板可见时静默。

## 代码风格

真源：`.agent/skill/code-style/SKILL.md`（写 TS/Vue 必读）、`.agent/skill/ui-design/SKILL.md`（动 UI 必读）。速查：

- 文件头：`/**` 块注释写「一句话职责 + 数据流/设计决策/实测事实」（如「v0.41 实测路径」）；导出符号一律单行中文 JSDoc；注释只写为什么与契约，不复述代码。
- 命名：文件 kebab-case；类型 PascalCase 无 I 前缀；模块常量 UPPER_SNAKE_CASE；布尔 is/has/can/should 前缀；adapter 工厂 `createXxxAdapter()`、翻译函数 `translateXxx()`。
- import 五段（段间空行）：bun 内建（`bun:sqlite`、`bun:test`）→ `node:` 内建 → 三方 → `@/`、`@core/`、shared → 相对路径；`import type` 与值 import 分行。
- 错误处理哲学：观察者 Never-Crash——watcher/quota/spool 全部失败静默降级；空 `catch {}` 必须带一句中文理由注释（如「DB 被占用时跳过本轮」）。
- 格式化：现状 core 单引号、desktop 双引号（Prettier 尚未落地统一），新文件跟随所在包现状。

## 禁区（违者返工）

| 禁区 | 原因 / 正解 |
|---|---|
| 调用 agent 的凭据刷新端点、写 agent 凭据文件 | kimi 的 refresh token 是旋转式：代刷且不回写即作废 CLI 登录态（2026-09 实测事故）。token 过期就降级 unavailable，刷新永远属于 CLI 本体 |
| 覆盖/重写用户 hook 配置文件 | 必须 `mergeJsonHooks` 合并 + `HOOK_MARKER` 幂等；本机可能有 orca/otty 等同类工具共存 |
| `packages/core` import electrobun/vue/DOM API | core 纯 TS（bun test 可跑）；桌面能力只能在 `apps/desktop/src/bun` 用 |
| webview 摸 `window.electrobun` / 裸建 RPC | 经 `@/lib/rpc.ts` 的 `useRpc` 单例 |
| hook 脚本非零退出、stdout 非 JSON | 必须 `exit 0`、stdout 只吐 `{}` |
| 伪造成「现在」的时间戳 | 无时间戳的历史事件按 at=0 回填语义处理，绝不冒充当下 |
| UI 裸色板 / hex / 任意 px 字号 | 语义 token；app.css 是 token 唯一真源；彩色只有 accent（谁）与 status（什么状态）；组件内禁止写死品牌色，accent 走 `data-agent` 属性 |
| `any` | 具体类型；外部脏数据用 `as unknown as X` 收敛在 adapter 边界 |

规范文档与实现冲突时的仲裁：token/状态色以 `app.css` 为准，类型与 agent 集合以 `packages/core/src/types.ts` 为准，并顺手把 skill 改对。

## 改代码前必读的坑

- `MURMUR_HOME` 在 paths.ts **模块加载时固化**：测试涉及 ingest/endpoint/spool 必须先设 env 再动态 `import()`（见 `test/ingest.test.ts`）；`agentPaths()` 的各 agent 路径在函数体内读 env，可运行时覆盖（见 `test/kimi-quota.test.ts`）。
- 启动迁移（`migrate.ts`）幂等，但制品清扫经 agentPaths 改写各 agent 目录里的旧条目——迁移相关测试必须把 `MURMUR_CURSOR/CODEX/OPENCODE_*_HOME` env 钉进沙箱，绝不指向真机（教训见 `test/migrate.test.ts` 文件头）。
- ingest 端口随机、token 每次启动重新生成并覆写 `~/.murmur/endpoint`（0600）——设计上隐含**单实例假设**。
- 只读打开他人正在写入的 WAL 库（opencode/zcode）必须容错：失败跳过本轮，静默降级，不 crash。
- `tray.getBounds()` 返回 AppKit 左下原点坐标，面板锚定需经 `mainScreenFrame()` 换算（见 `bun/index.ts` 文件头，别直接 setPosition）。
- `screen.ts` 用 osascript 同步探测屏幕，主进程调用点要意识到阻塞成本。
- codex `hooks.json` 的非 managed hook 按定义 hash 记 trust——command 字符串改一个字节即失效需重新 trust；脚本文件内容重写不影响（hash 不含文件字节）。app-server 额度通道的二进制发现：`MURMUR_CODEX_BIN` env → `Bun.which('codex')`，找不到自动回落 wham。
- `apps/desktop/tsconfig.json` 的 `paths` 是整字段覆盖（不合并 extends）：46 条 electrobun 映射是从 `.hutch/devkit/tsconfig.json` 拷贝固化的（值改写为 `./.hutch/devkit/` 前缀），外加 `@/*`/`@core/*` 两条项目别名——**hutch 升级 devkit 后必须按同法重新生成**（读 devkit 表 → 值加前缀 → 追加两条别名），否则 vue-tsc 的 electrobun 解析会静默退回报错。
- settings/uninstall 测试别信 `MURMUR_HOME` env（全测试进程共享首个固化值）：`loadSettings/saveSettings` 收 `dir` 参数注入沙箱；`hasOurHook` 按**绝对 HOOKS_DIR** 判归属，测试命令串必须经 `writeHookScript()` 产出（见 `test/hooks-uninstall.test.ts`）。
- reka-ui `SwitchRoot` 的绑定是 **`modelValue` / `update:model-value`**，不是 `:checked`（`:checked` 静默无效、开关恒渲染为关；`data-state="checked"` 只用于样式选择器）。
- 新 UI 组件先上 `#/design` 设计板（`design/design-board.vue`）再进业务页。
