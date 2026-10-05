# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [未发布]

### Changed

- 💄 UI 焕新「暮色栖木」：墨蓝黑底 + 琥珀天光、叠层表面取代描边卡、IBM Plex Mono 数据字体、面板刊头/栖枝/hero/底栏重排、管理台左侧边栏 + 分组列表、用量页拆分

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

[0.1.1]: https://github.com/chen-wang-jun/murmur/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/chen-wang-jun/murmur/releases/tag/v0.1.0
