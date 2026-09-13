---
name: ui-design
description: 在 Murmur 编写或修改任何 UI（.vue / app.css / 组件视觉）时使用——Murmur 视觉契约：token 真源、状态语义、动效与密度纪律。
---

# Murmur UI 设计契约

Murmur 是常驻菜单栏的「状态伴侣」，质感来自**克制与一瞥即读**，不是炫技。设计母题：栖木——每个 agent 是一只栖在枝上的鸟，状态即姿态。当前主题：**暖纸·编辑室**（浅色暖纸底 + 衬线展示字体 + 纸面颗粒）。

品牌图形分工（2026-09 定稿，勿混用）：**应用图标（icon.iconset / tray）与面板内品牌印同构——抽象 murmuration 点群波浪 + 栖枝，峰点琥珀 =「轮到你了」**。应用图标母版在 `apps/desktop/icons/*.svg`；面板内品牌印是 `murmur-mark.vue`（currentColor 线条 + 固定琥珀点），header 与空态在用。

## Token 真源

唯一真源：`apps/desktop/src/mainview/app.css`（Tailwind v4 `@theme` + `:root` CSS vars）。改 token 必须同步本文件。

### 表面与文字（三层递进 + 暖调阴影）

| Token | 用途 |
|---|---|
| `--background` `--raised` `--card` | 纸底 / 凸起层 / 卡片，三层递进 |
| `--muted` `--hairline` | hover 面 / 分隔线 |
| `--shadow-raised` `--shadow-overlay` | 卡片紧贴环境影 / 悬浮明细卡影（ink 暖调低透明度） |
| `--foreground` `--muted-foreground` `--faint` | 主文字 / 次文字 / 最弱（计数、时间戳） |
| 纸面颗粒 | `#app::before` 极淡灰度噪点 multiply，勿在组件里重复加 |

### 字体

| Token | 用途 |
|---|---|
| `--font-display`（`font-display` utility） | Lora variable（内嵌 latin 子集）：刊头字标、视图标题、头条标题、空态一句 italic；CJK 自动回退苹方 |
| `--font-mono` | 数字/额度/token，一律配 `tabular-nums` |
| 默认 sans | 系统栈（SF + 苹方），正文与标签 |

### 状态色（语义严格）

| Token | 语义 | 视觉 |
|---|---|---|
| `--status-working` | 干活中 | 绿点 + `breathe` 呼吸动画（2.6s） |
| `--status-waiting` | **轮到你了/等批准** | **琥珀**点 + `attention` 脉冲环（1.8s），与 murmur-mark 峰点琥珀同族 |
| `--status-idle` | 空闲 | 灰点 |
| `--status-stale` | 疑似卡住 | 红点（警示但不打扰） |
| `--status-ended` | 已结束 | 空心环 |

**waiting 琥珀 ≠ accent 赤陶**：琥珀只属于「轮到你了」，赤陶 `--accent` 只做品牌（eyebrow、接入页）。这是 2026-09 重设计拆开的语义，禁止再合并。

### Agent accent（品牌识别色，唯一的彩色入口）

`--agent-kimi` 紫 / `--agent-zcode` 蓝 / `--agent-opencode` 绿 / `--agent-codex` 墨 / `--agent-cursor` 金。

用法：`data-agent="<id>"` 属性 → 自动获得 `--accent` 变量 → `color-mix(in oklab, var(--accent) 15%, transparent)` 做底色。组件内**禁止**写死品牌色。

## 纪律（eslint 级约束，违者返工）

- ❌ 裸 Tailwind 色板（`bg-red-500`、`text-neutral-400`）、任意 hex、任意 px 字号
- ❌ `dark:` 双写——暖纸浅色是当前唯一主题，语义 token 为未来暗色留门
- ❌ 给非 agent 元素上彩色；彩色只有两种：accent（谁）与 status（什么状态）
- ❌ **图表禁用原生 `title` 悬浮**（OS 延迟 1-2s）——一律 `chart-tip.vue` 瞬时浮层，锚点用 `lib/chart-tip.ts` 的 `anchorTop()` 或准星逻辑，边缘翻转防溢出
- ✅ 动效只用 `duration-fast`(120ms) / `duration-normal`(200ms) ease-out；状态动画只用已定义的 keyframes（`breathe` / `attention` / `tip-in`）
- ✅ 密度：行高 9–10px padding、12–13px 字、hover 才展开次信息；popover 宽约 400px

## 结构惯例

- 面板三段：`murmur-header`（衬线字标 + folio 微信息行 + 待处理徽标 + **栖枝**）→ 滚动列表 → 底栏 segmented tabs
- **「栖枝」是签名元素**：`perch-strip.vue`，一根 hairline 横枝，5 个 `data-agent` 状态点栖于其上（bg-background 晕环把枝条压在点后），聚合全局状态
- 动态页：尺规索引条（运行中/需处理/今日令牌 + 新鲜度）→ waiting 头条（琥珀左边条 + 衬线标题）→ agent 账本分录
- 用量页：编号版式（`01 · 近 10 周`），热力图色阶 ink→琥珀；模型折线带水平虚线格 + 竖直准星 + 悬浮明细卡（`model-line-chart.vue`）
- 会话行：状态点 + 标题 + 元信息（model · 相对时间）+ 右侧 token 计数 / 「轮到你」旗标
- 预览页：`#/design` hash 进入 `design/design-board.vue`，新组件先上板再进业务页
