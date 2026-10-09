# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [未发布]

### Added

- 用量页「按模型」折线支持按工具筛选：块头右侧多选下拉（只列当前区间有量的 agent、AGENT_ORDER 序、「全部」行是全选/清空总开关、none 态图清空），区间内动态重算 top6+其他 模型序列；区间切换剔除失效选项

### Changed

- 栖枝与工具页只栖「已安装且监听开启」的 agent（与已连接计数同口径）：停用/未装不占位，栖位随鸟数均分替换写死 7 槽（agent 增至 10 后末位错位一并修复）；全停用时栖枝整根隐去、工具页给空态回设置页出口

## [0.1.3] - 2026-10-07

### Added

- 收编 **claude-code** adapter（Claude Code）：push 面 merge `~/.claude/settings.json` matcher-group hooks（22 事件 + `async:true` + 10s timeout，覆盖生命周期/工具/审批/Elicitation，Notification 按 `notification_type` 分诊 waiting）；pull 面 tail `projects/<slug>/*.jsonl`（orphaned/superseded 变体按文件名 uuid 归并同会话，`message.usage` 全量 token 是唯一计量源，`summary`/`custom-title` 行给标题）；quota 面 OAuth token 走 Keychain 只读、绝不代刷；perch 时代死 hook 条目走换词根收编无缝续用；品牌砖 + 赭橙 accent 接入
- 收编 **omp** adapter（oh-my-pi / omp CLI，Stencil Labs）：push 面是首家「TS 扩展模块」而非 shell hook——生成的 `murmur-agent.ts` 落 `~/.omp/agent/extensions/` 官方自动发现目录（独占文件按 marker 判归属、命名 profile 一并覆盖），扩展内经 endpoint+token POST `/hook/omp`、非 202/超时写 spool、单在途队列不积压；覆盖生命周期/工具/审批事件（`agent_end.willContinue` 续跑不误收尾、`session_switch/branch` 反解旧 id 补 end）。pull 面 tail `sessions/<slug>/<ts>_<uuid>.jsonl` v3 journal（assistant 行全量 usage/stopReason 是唯一计量源、`custom/tool_execution_start` 给 toolName+intent、`ask` 工具→waiting(question)），subagent 目录归并父会话；quota 面本地只读 `agent.db` 的 `usage_history` 额度窗快照（零网络零凭据）；清理页 journal+subagent 目录整组进废纸篓

### Changed

- 工具页额度窗改竖排行列表——横排 flex 均分在 5 窗 ~62px 格宽下长标签竖向挤压，改「label·细条·pct·重置」四槽行列表（图例行同构句式），任意窗口数保读；u/l 与绝对重置时间退 hover title
- desktop eslint/prettier 规范门禁落地（`bun run lint`/`lint:fix`/`format`）：tailwind canonical class 归一（任意 px → spacing 刻度、h/w → `size-*`）、ui-design 设计禁区落成 no-restricted-classes 正则门禁、webview 桥边界 lint 化；CI 加 Lint 步

### Fixed

- 会话文件工具筛选胶囊溢出画出轨道外直顶窗缘（agent 增多/窗窄时）——Segmented 轨道改轨内横滚（`overflow-x-auto` + `scrollbar-none`），可滚方向缘按滚动位 mask 渐隐；不溢出时视觉零变化

## [0.1.2] - 2026-10-06

### Added

- 收编 **minimax** adapter（MiniMax Code IDE，mcode/mavis）：纯 pull 无 push 面——`~/.minimax/v2/sqlite/runtime-state.sqlite` 只读轮询三表（`local_runtime_sessions` 注册表 / `local_runtime_turn_ingress` 精确 turn 边界 / `local_runtime_token_usage` 请求级计量游标增量），子会话归并父会话，`updated_at_ms` 活性启发式补状态面；quota 缺席（billing 端点需 web cookie）；清理页走 `v2/sessions/` 目录废纸篓
- **管理台窗口**（`#/manage/<tab>`、860×640 可缩放、左侧边栏导航）：**接入诊断**（逐 agent 数据面/hook 活性/pull 游标三探针 + 「测试链路」marker 全真自检 + 重扫/重装/Finder + 首启一键接入引导）、**用量**、**会话文件**、**设置**四 tab
- **会话状态细分**：working 两相位（thinking 模型往返 / tool 工具执行带工具名）、waiting 三细分（approval/question/turn-end 带等待对象）、会话行轻量时间线（发起/工具/等待中三点位）
- **waiting 定位闭环**：hero「打开应用」两跳唤起宿主 app 到台前（ps 筛候选 → 一次 lsof 同取 cwd 与可执行路径 → 沿 ppid 祖先链找 `.app` 命中 `open` 激活，CLI 会话落宿主终端；无进程命中走静态 bundle 表兜底）；会话行复制路径/Finder 揭示；「最近结束」折叠组（grace 期会话短暂可见，不进聚合态/通知）
- **GitHub Releases 发版流水线**（`.github/workflows/release.yml`）：推 `v*` tag 触发 macos-15 构建——tag 与 `electrobun.config.ts` `app.version` 一致性校验（不等拒构建）、跑 test + typecheck、`hutch run build` 出稳定件、artifacts（dmg + tar.zst 更新件 + update.json）挂上 Release、notes 自动抽 CHANGELOG 对应段；`release.baseUrl` 烘进包指向 `releases/latest/download`；产物未签名未公证，README 写明首启右键打开
- **应用内自动更新**（`src/bun/updates.ts`）：electrobun Updater 从 GitHub Releases 拉 `update.json` 比对——启动静默查一次 + 设置页「检查更新」手查，可更新时「更新并重启」下载换包自动重启；Updater 细粒度状态流收敛七相（checking/available/downloading 带进度/applying/error），`updateStatus` 推送 + `getUpdateState`/`checkUpdate`/`applyUpdate` RPC 接入，dev/裸跑不触网
- **用量页图表**：自然年热力图（1/1–12/31 GitHub 式网格、拉取窗 365d）、按工具堆积柱、按模型折线（暖橙 ramp + dash 双编码、模型名大小写归并）、自定义区间日历选段（上限 1 个月）、图表自适应铺满容器宽
- 会话文件头部规模随筛选联动（n 项·共 x GB 按当前工具/项目筛选集计算）

### Changed

- 💄 UI 焕新「暮色栖木」：墨蓝黑底 + 琥珀天光、叠层表面取代描边卡、IBM Plex Mono 数据字体、面板刊头/栖枝/hero/底栏重排、管理台左侧边栏 + 分组列表、用量页拆分
- 面板收敛为两视图「动态 / 工具」，用量/设置/会话文件迁入管理台窗口
- 设置页「未安装」agent 监听开关按 installed 派生默认关（装好自动开）+ 专属文案
- shadcn 基础件 token 化定制（`CUSTOMIZATIONS.md` 清单登记定制点）；可访问性收敛（导航 aria-current、分段器方向键、状态点读屏文案、会话行可聚焦）
- devin token 台账改走 `message_nodes` 请求级明细（按 row_id 游标增量扫，fork/revert 复制行去重）
- 工程质量门禁补齐：文件体量棘轮、显式 any 门禁、RPC 契约与架构边界测试、focus-app/updates 单测接入 `test:desktop`；组件内任意 px 值收敛 Tailwind spacing scale

### Fixed

- 首启聚焦态：WKWebView 面板首次变 key 时初焦点误落可聚焦元素，被 WebKit 画出系统蓝 focus-visible 环——focusin 守卫按用户事件距离判别意图
- 纯百分比额度窗被当计量窗渲染成 0（主数字/副行取值收敛 lib/format）
- Devin 计量去重键改结构化编码消除 id 拼接碰撞，去重集加 5 万条 LRU 上限
- 根目录 `bun test` 未加载 core preload 沙箱

## [0.1.1] - 2026-10-02

### Added

- 收编 **devin** adapter：`config.json` hooks matcher-group 上报 + `sessions.db` 活性轮询 + transcripts `final_metrics` 台账 + BYOK `cog_` key 时 v3 API 补云端会话态
- 收编 **qoder** adapter：`settings.json` hooks 合并（19 事件）+ `projects/*.jsonl` Claude 兼容行计量 + app `main.sqlite` 注册表/瞬态表双通道轮询
- **BYOK 自填 API Key**：独立凭据仓 `~/.murmur/credentials.json`（0600，永不进 settings/RPC，对外 `maskKey` 掩码），`quota?(byok)` 签名改造；zcode（z.ai/bigmodel 端点嗅探）与 devin 额度通道落地
- **会话文件管理窗**（`#/files` hash 分流，独立 780×560 窗口）：盘点各 CLI 磁盘会话产物、按工具/项目过滤、勾选批量删除——文件/目录进废纸篓可恢复，库内行事务永久删并标 `needsVacuum`；活跃会话禁删
- **外观设置**：`theme`（system/dark/light）+ `font`（自定义字体名），双主题 design token

### Changed

- webview 整体迁移 **Vue → React 19 + shadcn/ui（radix-ui）+ Zustand + Tailwind v4**；派生态移出 store，走 `lib/selectors` 纯函数 + `useMemo`/`useShallow`
- `typecheck:desktop` 从 vue-tsc 换 `tsc --noEmit`
- 面板定位改用 electrobun `Screen` API，移除 osascript 屏幕探测（`notch/screen.ts` 删除）

### Fixed

- 多屏/全屏 Space 下托盘面板定位漂移与先切屏再展现——以光标所在屏钳位 + `setVisibleOnAllWorkspaces` + `alwaysOnTop`
- WKWebView 输入框编辑快捷键（⌘V/⌘C/⌘A/⌘Z）失效——注册最小 App+Edit 应用菜单（role 走原生 selector），webview 侧 `readClipboard` 兜底

## [0.1.0] - 2026-09-19

### Added

- 初始版本：菜单栏状态伴侣，5 adapter（kimi / zcode / opencode / codex / cursor）
- 三平面采集架构：push hook 脚本（token 鉴权 + spool 离线补投）/ pull watcher（JSONL tailer + sqlite 轮询，回填语义不冒充当下）/ quota 官方端点
- 状态机：working / waiting / stale / idle / ended，快照 80ms 去抖广播
- 用量台账 `~/.murmur/murmur.db`（WAL）：events 审计 + usage_daily 日聚合 + quota 快照 + pull 游标
- 两级 per-agent 开关（监听总闸 / hook 上报）、perch→murmur 一次性迁移

[0.1.3]: https://github.com/chen-wang-jun/murmur/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/chen-wang-jun/murmur/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/chen-wang-jun/murmur/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/chen-wang-jun/murmur/releases/tag/v0.1.0
