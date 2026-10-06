# Murmur

对标 Agent Island 的菜单栏 AI Agent 状态伴侣。**纯观察者**：只读本地数据、无遥测、退出即全停。质感来自克制——只做状态呈现，不碰用户数据，不增功能噪音。

## 技术栈

- 桌面壳：Electrobun（`apps/desktop`），**Bun 主进程** + 系统 webview（无 Node 运行时、无 CEF）
- UI：React 19 + shadcn/ui（radix-ui 底层）+ Zustand + Tailwind CSS v4（`src/mainview`）
- 引擎：`packages/core`（`@murmur/core`，纯 TS、零运行时依赖，禁止 import electrobun/react/DOM；`bun test` 可独立跑）
- 存储：`bun:sqlite`（`~/.murmur/murmur.db`，WAL）
- 构建：`hutch`（`~/.hutch/bin` 需在 PATH）

Monorepo 无 workspaces：core 以 **TS 源码**直接被 desktop 消费（`exports` 指向 `./src/index.ts`，无编译产物）。desktop 的脚本真源在 `apps/desktop/hutch.config.ts`（其 package.json 没有 scripts），根目录 scripts 只是对 hutch/bun 的转发。

## 常用命令

```bash
# 桌面应用（在 apps/desktop 下执行 hutch 命令，或根目录 scripts）
bun run dev            # 构建并启动（watch 模式）
bun run dev:hmr        # 带 vite HMR 的开发模式（vite@5173 + app 本体）
bun run build          # 出稳定包
bun run test           # core 引擎测试（cd packages/core && bun test——必须在 core 目录跑，bunfig.toml 的 test preload 沙箱才生效）
bun run test:desktop   # desktop RPC 契约 + 架构边界（含显式 any 门禁）+ tsconfig 同步脚本测试（不进 core 沙箱）
bun run typecheck      # core 类型检查（tsc --noEmit）
bun run typecheck:desktop  # 桌面端类型检查（tsc --noEmit，覆盖 webview + bun 主进程；需要 .hutch/devkit）
bun run sync:tsconfig  # 从 .hutch/devkit/tsconfig.json 重写 desktop tsconfig 的 paths
bun run check:tsconfig # 同上，只检查 drift（非 0 即 paths 过期）
```

首次：`cd apps/desktop && hutch install && hutch electrobun sync && hutch run dev`。

## 发版

- 版本号真源是 `apps/desktop/electrobun.config.ts` 的 `app.version`（烘进 `Contents/Resources/version.json`）；同步面：根/`apps/desktop`/`packages/core` 三个 `package.json` + README 顶部 badge + `CHANGELOG.md` 段题 `## [x.y.z] - 日期` 与文末 compare 链接。
- 动作：同步提交后 `git tag vX.Y.Z` 随分支一起 push → `.github/workflows/release.yml`（macos-15）先校验 tag==config version（不等拒构建），跑 test + typecheck:desktop，`hutch run build` 后用 `softprops/action-gh-release` 把 `apps/desktop/artifacts/*` 挂上 Release，notes 自动抽 CHANGELOG 对应段。
- 产物**未签名未公证**（`build.mac.codesign/notarize` 未开）：用户首启需右键打开（README 安装段写明）。将来上 Developer ID：config 开两个开关 + workflow secrets `ELECTROBUN_DEVELOPER_ID`/`ELECTROBUN_APPLEID`/`ELECTROBUN_APPLEIDPASS`/`ELECTROBUN_TEAMID`。
- `release.baseUrl` = `releases/latest/download` 已烘进包（GitHub latest 只跟正式 release，pre-release 不算）；应用内更新走 `src/bun/updates.ts`（Updater 状态流收敛七相，`updateStatus` 广播 + `getUpdateState`/`checkUpdate`/`applyUpdate` 三 RPC；启动静默查一次，dev/裸跑不触网；apply 受理即返回、换包后由更新助手重启）。`release.generatePatch` 暂 false——首版无前序 release 可 diff，发过 stable 后可改 true 出增量补丁。release 上的 `stable-macos-arm64-*` 更新件禁止改名（updater 按前缀寻址）。

## 目录地图

```
packages/core/src/
  types.ts          全链路类型契约：AgentId / AgentStatus / AgentEvent / AppSnapshot（改动需双端同步）
  paths.ts          各 agent 本机目录解析器（env 可覆盖，见「坑」）
  agents/           8 个 adapter（kimi / zcode / opencode / codex / cursor / devin / qoder / minimax），把各家私有格式翻译成 AgentEvent；
                    <id>/files.ts 会话产物盘点/删除（清理页数据源；trash 回调由主进程注入）
    base.ts         AgentAdapter 接口（detect/installHooks/watch/quota 能力面全可选）+ JsonlTailer + pick()
  engine/           registry.ts 组装根（定时器/快照/广播）+ status-engine.ts 会话状态机
                    + diagnostics.ts 接入诊断（路径/sqlite 探针 + hint 派生 + marker 链路自检）
  ingest/           server.ts（Bun.serve，token 鉴权）+ endpoint.ts（~/.murmur/endpoint）+ spool.ts（离线补投）
  ledger/           db.ts（bun:sqlite 台账、游标、聚合）+ pricing.ts（内置价表估成本）
  hooks/            script.ts（POSIX sh 上报脚本模板）+ install.ts（merge* 合并安装 / unmerge* 卸载，只认脚本路径判归属）
  settings.ts       用户设置（~/.murmur/settings.json）：自启/Dock/通知 + 外观（theme/font）+ agents[]/hooks[] 两级开关，缺省皆 true
  credentials.ts    BYOK 凭据（~/.murmur/credentials.json，0600）：用户自填 API Key，永不进 settings/RPC（对外只有 maskKey 掩码）
  migrate.ts        perch→murmur 一次性迁移（家目录搬迁 + 旧制品清扫，幂等，主进程启动时调用）
  quota/            kimi.ts / codex.ts / zcode.ts / cursor.ts / devin.ts（官方用量端点 client）+ common.ts（超时 fetch / 降级件）
apps/desktop/
  src/bun/index.ts  主进程：tray + 透明面板 + registry 组装 + RPC 推送（唯一桌面 API 入口）
  src/bun/system.ts Dock 显隐（Utils.setDockIconVisible）+ 自启（~/Library/LaunchAgents plist）
  src/shared/rpc.ts 双端 RPC 契约 MurmurRPC
  src/mainview/     React webview：store/murmur.ts（Zustand）+ components/*.tsx + components/ui/（shadcn 生成件 + CUSTOMIZATIONS.md 定制清单）+ lib/appearance.ts（主题/字体应用）+ app.css（design token 唯一真源，暗/亮双主题）
.agent/skill/       code-style（代码风格）、ui-design（视觉契约）、testing（bun test 约定）、rpc-contract（RPC 三同步）四份规范，写码前必读
```

## 架构

数据流一条链：

```
三平面采集（push hook POST / pull watch 轮询 / quota 官方端点）
  → adapter 翻译成归一化 AgentEvent（types.ts）
  → Ledger 落库 + StatusEngine 状态机
  → AgentRegistry 组装 AppSnapshot（80ms 去抖广播）
  → RPC messages.snapshot → Zustand store → 组件渲染
```

### 三平面采集

- **Push**：hook 脚本（`hooks/script.ts` 生成，落 `~/.murmur/agent-hooks/<agent>.sh`）POST `http://127.0.0.1:<随机端口>/hook/<agent>`，`X-Murmur-Hook-Token` 鉴权。脚本铁约：stdout 只吐 `{}`（不干预 agent 决策链；**kimi 例外用 `stdoutAck:false` 完全不吐**——UserPromptSubmit 的 stdout 会被注进用户上下文）、stdin/argv 双兼容、失败追加 spool（`~/.murmur/spool/<agent>.jsonl`，单文件 5MiB 上限）、**任何分支都 exit 0**。spool 启动时 + 每 60s 补投。cursor 的 `hooks.json` 条目必须用**直挂** `{command,timeout}` 形状 + 顶层 `version:1`——嵌套 `{"hooks":[...]}` 组形状只有 IDE 跑，cursor-agent CLI 不触发（CLI 也只发 sessionStart/stop/postToolUse 等子集）。kimi 的 `[[hooks]]` 是 TOML 数组表（0.41 实测）：走 `mergeTomlHooks` 行扫合并、EOF 追加、只认脚本路径判归属；payload 恒带 `session_id`/`cwd` 但**无 usage**。codex 双通道：`hooks.json` 官方 12 生命周期事件（matcher-group 包 command handler，`mergeCodexHooks` 合并、handler 带 `async:true`；**非 managed hook 需用户 /hooks trust**，装好≠生效）+ `config.toml` legacy `notify`（免 trust、仅 agent-turn-complete）兜底；hook payload 的 sessionId 优先取 `transcript_path` 文件名尾段 uuid 与 pull 平面对齐。
- **Push 补充——devin**：merge `~/.config/devin/config.json` 的 `hooks` 键（Claude Code 兼容 matcher-group：`{hooks:[{type:command,command,timeout:10}]}`，不带 async——schema 未文档化该字段），8 事件全挂；payload 带 `hook_event_name`/`session_id`/`prompt_id`。只覆盖**本地**会话：云端会话的 command hook 跑在云机上。
- **Push 补充——qoder**：merge `~/.qoder/settings.json` 的 `hooks` 键（Claude 兼容 matcher-group，`mergeQoderHooks`；条目带 `async:true`），19 事件覆盖生命周期+工具+审批+Elicitation（等输入→waiting:question）；payload 带 `session_id`/`transcript_path`/`cwd`。settings.json 是共享配置（providers 含用户 key），只碰 hooks 子树。官方明示改配置即生效、无 trust 门槛；stdout `{}` 是合法 JSON 不被注入（仅 SessionStart/UserPromptSubmit 注入纯文本）。新 Qoder 桌面端（com.qoder.app）跑内嵌 qodercli runtime，与 CLI 共用 `~/.qoder` 数据根——同一份 sessionId 同时进 transcript 与 app 台账，CLI 会话自然搭车，不拆条目。
- **Pull**：kimi watch `wire.jsonl`（fs.watch + 5s 兜底重扫）——push 已接管状态面后，pull 专职 `usage.record` token 台账（hook payload 无 token，实测）、`state.json` title、`interaction.request` 的 kind 细分（approval→permission.request / question→waiting(question)，均带 detail）、回填与未装 hook 会话的兜底；zcode 轮询 `v2/tasks-index.sqlite` + tail `model-io-*.jsonl`（行 ~300KB 走 `tailRaw` + `json-span` 定向提取，不物化 request 全文）；opencode 按 rowid 游标轮询 `opencode.db` 的 `event` 表并独掌 usage 台账（push 插件在 translateHook 剥离 usage 防双通道重记）——`part` 无 model 字段，usage 经 `message` 表 join 补 modelID（message.updated 行顺路喂 cache）；`session.status` 载荷 v1.x 是 `{type}` 对象、旧版裸字符串，两形兼容；db 缺失的 pre-sqlite 旧版回退 `agents/opencode/legacy.ts` 扫 `storage/message` JSON 按 msgID 记 delta；插件只转白名单事件（含 question.*，流式 part chunk 不 POST）；codex tail `rollout-*.jsonl`；cursor tail `projects/*/agent-transcripts/**.jsonl`（行内无时间戳/token，at 取文件 mtime，subagents 归并父会话）+ 轮询 `chats/*/meta.json` 探 CLI 会话活性（updatedAtMs 启发式）。增量游标存台账 `cursors` 表（`jsonl:<path>` → 字节偏移）。JSONL 增量统一走 `JsonlTailer`（半行缓存、截断归零）。zcode 另有可选 push：合并 `cli/config.json` 的 `hooks.events` 七事件（command+async 旁路，`hooks.enabled` 显式 false 不抢），补 approval 与实时 turn.end——usage/session.end 仍只能 pull。devin 轮询 `cli/sessions.db`（sessions 表 title/cwd/model/秒级 `last_activity_at`）做建档+活性启发式；token 台账走 `message_nodes` 表请求级 `metadata.metrics.{input,output,cache_read,cache_creation}_tokens`——按 `row_id` 游标增量扫、(session_id,message_id,指标签名) 去重（fork/revert 复制行实测占 ~69%，不去重膨胀 3 倍；签名不同=同 id 重推理照计）；`session_locks/*.lock` 陈旧 PID 锁太多不作判据；BYOK `cog_` key 在场时每 60s 轮询 v3 sessions 补**云端**会话态（hook 够不到云机）。注意 hook payload 的 `session_id` 与 sessions.db 的 slug `id` 是否同口径未实测确认，不一致时同会话会并存两条目。qoder 双通道：tail `projects/**/*.jsonl`（Claude 兼容行，带 ISO timestamp + `message.usage` 全量 token + `ai-title`，是唯一计量源；user 行要滤 tool_result 回填块、isSidechain 只心跳）+ 只读轮询 app `main.sqlite`（`com.qoder.app.stable`）的 `chat_sessions` 注册表（title/cwd/model/`updated_at` 活性启发式，`deleted_at`→session.end 一次性）与 `chat_session_turn_states` 瞬态表（有行即 working）。
- **Pull 补充——minimax**：MiniMax Code IDE（mcode/mavis，OpenCode fork 的 Electron 壳）**纯 pull 无 push 面**——官方明示 hooks/plugins 非公开能力，`hookTargets` 空表、诊断/设置页据此跳过分支。数据根 `~/.minimax`（官方 `MINIMAX_DATA_DIR`/旧 `MAVIS_DATA_DIR` 可整体搬迁），唯一真源 `v2/sqlite/runtime-state.sqlite`（只读 `?mode=ro`，库被占/损坏本轮跳过、watcher 空挂）：`local_runtime_sessions` 会话注册表（title/workspace_dir/status/`session_kind`/`parent_session_id`/archived/visibility/`created_at_ms`/`updated_at_ms`/`extra_data_json.effectiveModel`——usage 行 model 恒空，模型从这里回退），`local_runtime_turn_ingress` turn 生命周期（`accepted`→`completed`/`failed`/`aborted`，accepted_at_ms/completed_at_ms 给精确 turn.start/turn.end，窗口内完成的未跟踪 turn 补 end），`local_runtime_token_usage` 请求级计量（自增 id 游标 `minimax:tu_id` 增量扫，input/output/reasoning/cache_read/cache_write 互斥分量，reasoning 只展示不进总量）。子会话（parent_session_id 非空或 kind 非 conversation/unknown）不建档，usage/turn 归并父会话。状态面另叠 `updated_at_ms` 活性启发式（前进→working、连续静默且无开 turn→waiting turn-end）。**quota 缺席**：`auth/<env>/<region>/mcode-public/auth.json` OAuth token 受众 agent-backend，billing 端点 `/backend/account/token_plan/remains_percent` 要 web cookie（实测 1004 not login）。清理页：`v2/sessions/<y>/<m>/<d>/<ts>-session_<b64>/` 目录进废纸篓，manifest.json 钉 sessionId，库行不动。
- **Quota**：本地凭据调官方用量端点（kimi `/usages`、codex 优先 `codex app-server` 官方 JSON-RPC——`account/rateLimits/read` oneshot 即走、登录态由 codex 本体管，失败回落 wham/usage 直读 `auth.json`、cursor `cursor.com/api/usage-summary`——凭据是 IDE `state.vscdb` 里的 `cursorAuth/accessToken` JWT，拼 `WorkosCursorSessionToken` cookie 鉴权，CLI `auth.json` 兜底），8s 超时，10 分钟一轮 + UI 手动触发；失败静默降级 unavailable 并回退上次快照。**凭据严格只读、绝不代刷**（见禁区）。**BYOK**：本地凭据加密不可读的 agent（zcode 的 enc:v1）走用户自填 API Key——存 `credentials.json`（0600），`registry.setAgentKey` 写入并即拉；`quota?(byok)` 签名收凭据、实现方自定优先级；adapter `supportsByok` 让设置页出输入行。zcode 端点 `{base}/api/monitor/usage/quota/limit`（unit3→5h / unit6→每周、TIME_LIMIT unit5→MCP 月度，level=套餐档；type 双形：国际站 TOKENS_LIMIT、中国站实测 CREDIT_LIMIT，条目字段 usage=上限/currentValue=已用/remaining=剩余），base 解析序：手动 baseUrl → `coding-plan-cache.json` entitlement 嗅探（bigmodel→open.bigmodel.cn / zai→api.z.ai）→ api.z.ai。devin 双通道：本机 `credentials.toml` 的 `windsurf_api_key` 打 `server.codeium.com` Connect RPC `SeatManagementService/GetUserStatus`（JSON 媒体类型，metadata 需带 apiKey/ideName/requestId 等）→ 日/周 `*QuotaRemainingPercent`（剩余语义，换算 usedPct）+ reset 时间 + planName + `devinInfo.orgId`——该凭据打 api.devin.ai 实测 403，受众不同；BYOK `cog_`（PAT 或 service user key）→ `v3/organizations/{org}/consumption/daily`（org 嗅探序 config.json `devin.org_id`→user_status）补「最近一日/近30日 ACU」窗口——ACU 是计量计费无上限，limit 恒缺省；org 缺失回落 `/v3/enterprise/consumption/daily`（需企业套餐）。拉取门槛 `hasCredentials || byok 有 key`。qoder 暂无 quota：`.auth/user` 加密 blob 读不了，`/api/v2/quota/usage` 需 bearer——`QODER_PERSONAL_ACCESS_TOKEN` PAT 是官方 BYOK 通路候选（未实测）。

### 回填语义（pull 平面的灵魂）

历史事件不冒充当下：无时间戳或超出 `LIVE_WINDOW_MS`（90s）的旧事件按「建档落真实残态」处理——旧 `turn.end` 落 waiting（真实状态就是等你），旧 `turn.start/tool.call/permission.request` 落 ended（废弃 turn / 废弃审批，旧审批不得冒充当前 waiting），不置 working、不发通知。比该会话已见最新事件更旧的历史事件不覆盖已到达状态（usage 仍累加）。回填语义版本号 `BACKFILL_EPOCH`（ledger/db.ts）变更时自动清库全量重扫。70 天（`BACKFILL_WINDOW_MS`）外的旧事件不落库。

### 状态机（engine/status-engine.ts）

```
session.start → idle    turn.start → working(thinking)    tool.call → working(tool)
permission.request → waiting(approval)    status waiting(question) → waiting(question)
turn.end → waiting(turn-end)「轮到你了」    session.end → ended（grace 60s 后清除）
```

**细分语义**（`SessionSnapshot.phase/waitingDetail/toolName/statusAt/turnStartAt/toolCallAt`，全内存态不落库）：waiting 三细分——approval（等批准，detail=工具名/命令）、question（等回答，detail=问题原文）、turn-end（等继续）；working 两相位——thinking（模型往返中：turn.start 与 PostToolUse 系之间）/ tool（工具执行中：tool.call 起，toolName=当前工具）。phase 是推导不是真值（排队/重试不可分辨），无细粒度源的会话恒缺省。**各 agent 可区分度**（真机核实）：kimi wire `interaction.request` 顶层 `kind` 分 approval/question（问题带 `questions[].question` 原文）；opencode `question.asked/replied`（插件白名单含 `question.`）+ `permission.*`（detail=权限名+首个 pattern）；qoder hook `Elicitation`/`PermissionRequest`；codex/devin/zcode hook `PermissionRequest`（detail=tool_name）+ codex rollout `*_approval_request`；cursor 只有相位（pre*/post* 工具事件），无审批/提问信号；minimax 只有 turn 边界（turn_ingress accepted→终态）+ updated_at 活性，无工具级/审批信号。**轻量时间线** = turnStartAt/toolCallAt/statusAt 三点位，会话行下渲染「发起/工具/等待中」。离开 waiting 清 waitingDetail，离开 working 清 phase；`statusAt` 只在状态迁移（含 turn.start/tool.call 的持续事件）时前进，相位翻转不重置。

常量：working 无事件 3min（`STALE_AFTER_MS`）→ stale（watchdog 每 15s sweep）；stale 30min 无动静 → ended 兜底（进程多半已死）；waiting 30min 衰减回 idle；会话 24h 无动静剔除。**快照只出活跃会话**：working/waiting/stale 直出，idle 仅限 `LIVE_WINDOW_MS` 内新建（start→turn.start 过渡），ended 不进活跃面板（grace 期留 Map 供同 id 复活，经 `StatusEngine.recentlyEnded(limit)` 以 `AppSnapshot.recentlyEnded` 附带出快照喂「最近结束」折叠组，不进聚合态/通知）。聚合态取最高优先级：working > waiting > stale > idle > ended。

### 存储（ledger/db.ts）

`~/.murmur/murmur.db`（WAL）5 张表：`events`（流水审计）、`usage_daily`（**日聚合**用量：PK(day,agent,model) upsert 累加，写入即聚合，无明细行）、`quota_snapshots`（额度快照）、`cursors`（pull 游标）、`meta`（epoch 等元数据）。`raw` 原始 payload 落库前截断 4000 字符。**保留清扫 `Ledger.prune()`**（启动 + 每 24h）：events 7d（纯审计无读方）、usage_daily 无 TTL（每年每 agent 数百行）、quota_snapshots 每 agent 最新 50 条、cursors 清 70d 未推进或源文件已删的游标，收尾 `wal_checkpoint(TRUNCATE)` + `VACUUM`（被占用跳过下轮）。spool `.done` 存档 24h 后由 drainSpool 顺带清。旧 `token_ledger` 明细表在构造时一次性 GROUP BY 折叠进 `usage_daily` 后 DROP。

### 主进程与通信

`apps/desktop/src/bun/index.ts`：tray（标题 `◆n`（waiting）/ `●n`（working）聚合态，只能用默认文本渲染的几何字形，emoji 会在菜单栏变彩色、破坏单色体系；不放原生菜单，挂 menu 会接管左键点击）+ 392×600 面板（`titleBarStyle:"hiddenInset"` + 空标题 + 无按钮，标准窗口几何 + 全尺寸内容，系统圆角+阴影由系统裁——`titleBarStyle:"hidden"` 的无边框窗口在 macOS 26 露方形底板、`"default"` 会画出标题栏、`transparent:true` 关不掉方形原生阴影（2.0.1 无 hasShadow API），都不可用；失焦即 hide）+ RPC。bun 侧 requests：`getSnapshot / installHooks / hidePanel / refreshQuotas / usageDaily / getSettings / updateSettings / setAgentHook / setAgentObserved / setAgentKey / readClipboard / writeClipboard / rebuildLedger / openManager / getDiagnostics / testAgentHook / rescanAgent / installAgentHooks / revealPath / scanSessions / deleteSessions / revealSession / focusSessionApp / openDataDir / getUpdateState / checkUpdate / applyUpdate / quitApp`（quitApp 经 quitMurmur 保证 stop 失败也必 exit）；webview 侧 messages：`snapshot` 全量推送（面板与管理窗双发）+ `managerNav`（管理窗已开时的切 tab 指令）+ `settings`（设置 mutation 落库后广播 SettingsSnapshot——双窗独立 JS context，主题/字体靠它即时同步，并不过快照通道）+ `updateStatus`（更新相位推送，updates.ts 把 Updater 细粒度状态收敛成七相）。**每窗必须各自 `BrowserView.defineRPC` 实例（`makeViewRpc`）**：rpc 对象只持一条 transport，BrowserView 构造时 setTransport 会把它改绑到本窗——共享实例会让推送全落最后创建的窗口、其 dispose 后推送永久 no-op。**管理台窗口**（`#/manage/<tab>` hash 分流、860×640 可缩放、`openManager` 幂等聚焦切 tab；左侧边栏导航 + 限宽内容列 + `PageHead` 页头，分组行走 `GroupList`/`GroupRow`）四 tab：**接入诊断**（doctor-view：逐 agent 数据面探针/hook 上报活性/pull 游标活性 + 「测试链路」marker 全真自检 + 重扫/重装/Finder 恢复操作 + 首启引导卡）、**用量**（区间筛选 7d/30d/自定义 ≤1 个月，hero 与热力图是固定语义不吃筛选）、**会话文件**（盘点各 CLI 磁盘会话产物、勾选批量删——文件进废纸篓、库内行事务永久删标 `needsVacuum`、active 禁删）、**设置**。弹层只留 动态+工具 两视图（「暮色栖木」：天光底 + 刊头 headline 状态头条与栖枝 + waiting hero + 分组会话列表；底栏文字 tab + 今日令牌/管理台/退出）。**首启**（settings.json 缺席=`firstRun`）非 dev channel 自动弹管理台 doctor tab。UI 禁止直接摸 `window.electrobun`，一律走 `@/lib/rpc.ts` 的 `useRpc` 单例。

### 设置与开关（settings.ts + 设置页）

`~/.murmur/settings.json` 是唯一真源（loadSettings/saveSettings 原子写、损坏回默认）。两级 per-agent 开关语义：**监听**（`agents[]`）是总闸——关闭即停 watcher、`ingest_` 丢事件、不拉额度、快照标 `disabled:true` 且不带会话/用量，并顺带卸载其 hook（用户 hooks 偏好保留，重开时回装）；**hook 上报**（`hooks[]`）只管 push 平面——关闭=unmerge* 真卸载我方条目（他人保留），观察退回 pull 轮询。两张表**缺省皆 true**（flagEnabled 约定），`autoInstallHooks`（默认开）让启动时自动装「监听中+已安装+hook 未关」的 agent。系统偏好：Dock 显隐经 `Utils.setDockIconVisible`（默认藏，accessory 策略）；自启写 `~/Library/LaunchAgents/<identifier>.plist`（`open -g <bundle>`），**只写不 bootstrap**——立即 load 会多起一个实例；dev channel 无 .app bundle，开关禁用。waiting 通知（默认关）按 sessionId+waitingReason 集合 diff（同会话原因升级会再发）、逐会话行文「Agent · 项目：原因 · 等待对象」（≤3 条 + 等 n 个）、首快照作基线 + statusAt 2min 新鲜度门槛防回填轰炸，面板可见时静默。外观：`theme`（system/dark/light，默认 system）与 `font`（自定义字体名，空=系统栈）只被 webview 消费——主进程不感知，`lib/appearance.ts` 把 theme 落到 `<html data-theme>`、font prepend 进 CSS 字体栈。

## 代码风格

真源：`.agent/skill/code-style/SKILL.md`（写 TS/TSX 必读）、`.agent/skill/ui-design/SKILL.md`（动 UI 必读）。速查：

- 文件头：`/**` 块注释写「一句话职责 + 数据流/设计决策/实测事实」（如「v0.41 实测路径」）；导出符号一律单行中文 JSDoc；注释只写为什么与契约，不复述代码。
- 命名：文件 kebab-case；类型 PascalCase 无 I 前缀；模块常量 UPPER_SNAKE_CASE；布尔 is/has/can/should 前缀；adapter 工厂 `createXxxAdapter()`、翻译函数 `translateXxx()`。
- import 五段（段间空行）：bun 内建（`bun:sqlite`、`bun:test`）→ `node:` 内建 → 三方 → `@/`、`@core/`、shared → 相对路径；`import type` 与值 import 分行。
- 错误处理哲学：观察者 Never-Crash——watcher/quota/spool 全部失败静默降级；空 `catch {}` 必须带一句中文理由注释（如「DB 被占用时跳过本轮」）。
- 文件体量：单文件 ≤500 有效行（软上限 400），`bun test` 棘轮门禁在 `packages/core/test/file-size.test.ts`（只许降不许升）；拆分触发器与手法见 code-style skill「文件体量」节。
- 格式化：现状 core 单引号、desktop 双引号（Prettier 尚未落地统一），新文件跟随所在包现状。

## 禁区（违者返工）

| 禁区 | 原因 / 正解 |
|---|---|
| 调用 agent 的凭据刷新端点、写 agent 凭据文件 | kimi 的 refresh token 是旋转式：代刷且不回写即作废 CLI 登录态（2026-09 实测事故）。token 过期就降级 unavailable，刷新永远属于 CLI 本体 |
| 覆盖/重写用户 hook 配置文件 | 必须 `mergeJsonHooks` 合并 + `HOOK_MARKER` 幂等；本机可能有 orca/otty 等同类工具共存 |
| `packages/core` import electrobun/react/DOM API | core 纯 TS（bun test 可跑）；桌面能力只能在 `apps/desktop/src/bun` 用 |
| webview 摸 `window.electrobun` / 裸建 RPC | 经 `@/lib/rpc.ts` 的 `useRpc` 单例 |
| hook 脚本非零退出、stdout 非 JSON | 必须 `exit 0`、stdout 只吐 `{}` |
| 伪造成「现在」的时间戳 | 无时间戳的历史事件按 at=0 回填语义处理，绝不冒充当下 |
| UI 裸色板 / hex / 任意 px 字号 | 语义 token；app.css 是 token 唯一真源；彩色只有 accent（谁）与 status（什么状态）；组件内禁止写死品牌色，accent 走 `data-agent` 属性 |
| `any` | 具体类型；外部脏数据用 `as unknown as X` 收敛在 adapter 边界。生产源码由 architecture-boundary 词法门禁卡住（注释、字符串、模板静态文本除外） |
| BYOK key 进 settings.json / RPC 快照 / 日志 | settings.json 经 getSettings 整包发 webview——key 只进 credentials.json（0600），对外一律 maskKey 掩码 |
| 个人路径 / 真实凭据 / 真机使用数据入库（注释、截图、文档都算） | 公开仓库卫生：注释里的示例路径写 `/path/to/` 占位（真机路径曾混进 render.ts 注释，2026-10 靠 filter-repo 重写历史才清掉）；截图只拍 `?seed` 演示快照（main.tsx seed 桩就是为这个准备的）；测试桩 key 必须一眼假（`sk-...do-not-leak` 形）；agent 本机目录按目录级进 .gitignore（`.zcode/` `.qoder/` `.devin/` `.cottontail-tmp/`），只靠 `*.local.json` 会漏新文件 |

规范文档与实现冲突时的仲裁：token/状态色以 `app.css` 为准，类型与 agent 集合以 `packages/core/src/types.ts` 为准，并顺手把 skill 改对。

## 改代码前必读的坑

- `MURMUR_HOME` 在 paths.ts **模块加载时固化**：测试涉及 ingest/endpoint/spool 必须先设 env 再动态 `import()`（见 `test/ingest.test.ts`）；`agentPaths()` 的各 agent 路径在函数体内读 env，可运行时覆盖（见 `test/kimi-quota.test.ts`）。
- 启动迁移（`migrate.ts`）幂等，但制品清扫经 agentPaths 改写各 agent 目录里的旧条目——迁移相关测试必须把 `MURMUR_CURSOR/CODEX/OPENCODE_*_HOME` env 钉进沙箱，绝不指向真机（教训见 `test/migrate.test.ts` 文件头）。
- ingest 端口随机、token 每次启动重新生成并覆写 `~/.murmur/endpoint`（0600）——设计上隐含**单实例假设**。
- 只读打开他人正在写入的 WAL 库（opencode/zcode）必须容错：失败跳过本轮，静默降级，不 crash。
- `tray.getBounds()` 返回 AppKit 主屏左下原点全局坐标，`setPosition`/`Screen.*` 是左上原点逻辑坐标：y_tl = primaryH - bounds.y + gap，x 同轴直用；多屏/全屏 Space 下以光标所在屏钳位（`Screen.getCursorScreenPoint` + `getAllDisplays`），别用 `mainScreenFrame()`（focused 屏会漂移）。菜单栏弹层要 `setVisibleOnAllWorkspaces(true)` + `setAlwaysOnTop(true)`，否则全屏 Space 点托盘会先切屏再展现。
- `screen.ts`（osascript 探测）已不在面板路径用；屏幕信息走 `Screen`（electrobun/main 导出，FFI 直读）。
- codex `hooks.json` 的非 managed hook 按定义 hash 记 trust——command 字符串改一个字节即失效需重新 trust；脚本文件内容重写不影响（hash 不含文件字节）。app-server 额度通道的二进制发现：`MURMUR_CODEX_BIN` env → `Bun.which('codex')`，找不到自动回落 wham。
- `apps/desktop/tsconfig.json` 的 `paths` 是整字段覆盖（不合并 extends）：electrobun 映射从 `.hutch/devkit/tsconfig.json` 生成（值改写为 `./.hutch/devkit/` 前缀），再追加 `@/*`/`@core/*`。不要手抄条数。`hutch.config.ts` 钉着 `electrobun.version`；升级后 `cd apps/desktop && hutch electrobun sync`，再在仓库根跑 `bun run sync:tsconfig`（`bun run check:tsconfig` 查 drift）。漏生成时 tsc 的 electrobun 解析会静默退回报错。CI 用官方 install.sh 把 hutch 装进 runner 临时目录，不读开发机 `~/.hutch`。
- settings/uninstall 测试别信 `MURMUR_HOME` env（全测试进程共享首个固化值）：`loadSettings/saveSettings` 收 `dir` 参数注入沙箱；`hasOurHook` 按**绝对 HOOKS_DIR** 判归属，测试命令串必须经 `writeHookScript()` 产出（见 `test/hooks-uninstall.test.ts`）。
- radix Switch 绑定是 **`checked` / `onCheckedChange`**（shadcn `components/ui/switch.tsx`）；zustand selector 只取原始字段——返回数组/对象的派生用 `lib/selectors.ts` 纯函数 + `useMemo`/`useShallow`，直接 `useMurmurStore(s => 派生)` 每次渲染产新引用会无谓重渲。
- Radix ScrollArea 的 Viewport 给内容包装层**内联** `display:table`（max-content 布局）：长文本不换行、横向撑出 392 面板——`scroll-area.tsx` 用 `[&>div]:block!` 归一为 block；WKWebView 文档级滚动看 documentElement，`html` 必须补 `overflow:hidden + overscroll-behavior:none`（只写 body 不够）。
- `components/ui/` 是 shadcn 复制式组件库：**禁止 CLI `--overwrite` 覆盖已存在组件**（会冲掉本地 token 化定制）；确需升级走「干净工作区 → CLI 覆盖 → `git diff` 对照 → 按 `components/CUSTOMIZATIONS.md` + `grep CUSTOMIZED:` 重打定制 → 更新清单」；改动库文件必须在改动处标 `CUSTOMIZED:` 注释并登记清单。
- Radix Dialog 的 DialogContent 必须限高（`max-h-[90vh]`，长内容 flex 列 + 中部 `min-h-0 overflow-y-auto`）；内层滚动容器固定惯用法 `-ml-1 overflow-y-auto pl-1 pr-1`——`focus-visible:ring-*` 画在边框盒外侧，左缘无 padding 时 ring 左弧被 overflow 裁掉（`-ml-1` 伸进 DialogContent 留白、`pl-1` 推回内容，视觉零位移留 4px 出血），禁止只加 `pl-1` 不补负 margin。
- Radix `AlertDialog.Action` 交互后**自动关闭弹窗**：异步删除等破坏性操作必须用普通 Button 触发、仅在成功后显式关闭；请求期间禁用按钮，失败保持弹窗打开。
- 刊头/底栏是 `absolute` 玻璃覆盖层（`glass-chrome`），滚动区用 `--chrome-top`/`--chrome-bottom` padding 让位——**改刊头/底栏内容后必须回校 app.css 里这两个常量**，否则首行被遮或露缝。
- macOS 编辑快捷键（⌘V/⌘C/⌘A/⌘Z）由**主菜单 keyEquivalent** 派发到第一响应者——菜单栏伴侣没有默认应用菜单，WKWebView 输入框粘贴/全选全废（Electron 同款坑）。`bun/index.ts` 启动时用 `setApplicationMenu`（`electrobun/main/app-menu`）注册最小 App+Edit 菜单（role 走原生 NSResponder selector），另挂隐藏 `Ctrl+V → paste`；webview 输入框再有 `onKeyDown` → `readClipboard` RPC 兜底（菜单已消费的事件到不了 JS，不会双贴；`e.currentTarget` 必须先捕获再 await）。
- 新 UI 组件先上 `#/design` 设计板（`design/design-board.tsx`）再进业务页。
