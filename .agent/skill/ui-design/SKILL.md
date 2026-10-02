---
name: ui-design
description: 在 Murmur 编写或修改任何 UI（.tsx / app.css / 组件视觉）时使用——Murmur 视觉契约：token 真源、状态语义、动效与密度纪律。
---

# Murmur UI 设计契约

Murmur 是常驻菜单栏的「状态伴侣」，质感来自**克制与一瞥即读**，不是炫技。设计母题：栖木——每个 agent 是一只栖在枝上的鸟，状态即姿态。主题：**Vercel 式单色**，暗/亮双主题经 `<html data-theme>` 切换（settings.theme = system/dark/light，`lib/appearance.ts` 应用，默认跟随系统）；UI chrome 全中性——交互只走前景/背景灰阶反相，无品牌蓝。

品牌图形分工（2026-09 定稿，勿混用）：**应用图标（icon.iconset / tray）与面板内品牌印同构——抽象 murmuration 点群波浪 + 栖枝，峰点琥珀 =「轮到你了」**。应用图标母版在 `apps/desktop/icons/*.svg`；面板内品牌印是 `murmur-mark.tsx`（currentColor 线条 + `var(--status-waiting)` 峰点），header 与空态在用。

## Token 真源

唯一真源：`apps/desktop/src/mainview/app.css`（Tailwind v4 `@theme` + `:root` / `:root[data-theme]` CSS vars）。改 token 必须同步本文件。

### 表面与文字（三层递进 + 浮层）

| Token | 用途 |
|---|---|
| `--background` `--raised` `--card` | 面板底 / 凸起层（hover、tile）/ 卡片，三层递进 |
| `--overlay` | 悬浮层（ChartTip 明细卡）：暗色比 card 亮一档、浅色取纯白 |
| `--muted` `--hairline` | 填充面（segmented 轨道、骨架屏）/ 分隔线 |
| `--shadow-raised` `--shadow-overlay` | 卡片影 / 悬浮明细卡影（按主题定义，浅色弱化） |
| `--foreground` `--muted-foreground` `--faint` | 主文字 / 次文字 / 最弱（计数、时间戳） |

### 交互色（单色纪律）

`--accent` 在 root = `var(--foreground)`：链接、focus 环、选中、确认态全部中性。`text-accent` / `bg-accent-soft` / `accent-solid`（反相 chip）等 utility 在 root 语境下产出灰阶——这是特性不是退化。**彩色只有三种语义：status（什么状态）、agent accent（谁）、heat（用量密度）。**

### 密度色

`--heat`（暖橙单色相 ramp 基色，深/浅主题各一值）仅热力图消费：`HEAT_LEVELS` = 中性空档 + `--heat` 22/45/70/100% 递进。它既非状态也非「谁」——是第三条、也是最后一条彩色通道，别再加第四种。

### 图表系列色（灰阶）

### 图表系列色（heat ramp）

`--chart-1..7`：`--heat` 暖橙 ramp（100/72/52/38/28/21/16% 递减，双主题各一套、同构取值）——折线画的是用量，系列色是密度语义的延伸，与热力图同族；status/agent 语义色禁入系列位。浅档透明度低，系列可读性靠**色阶 + dash 双编码**：rank→dash/width 映射常量 `MODEL_LINE_STYLES` 在 `usage-view.tsx`（rank0 1.75px 实线、rank1 实线、rank2+ 各配一种虚线型），图例用线样不用圆点（圆点表达不了线型）。模型名归并大小写不敏感（`glm-5.3-flash`/`GLM-5.3-Flash` 同系列）。额度阈值同理不走琥珀：≥70% 前景加重（字重）、≥90% 才 `--status-stale` 红，正常态进度底色一律前景 50%（idle 是状态色，不做进度条）。

### 字体

| Token | 用途 |
|---|---|
| `--font-sans`（`font-sans` / body） | 默认系统栈（SF + 苹方）覆盖全部文字；用户可在设置页填自定义字体名（如 `Maple Mono NF CN`），`appearance.ts` 把名字 prepend 进栈——存在即用、缺失自然回退系统栈 |
| `--font-mono` | 数字/额度/token，一律配 `tabular-nums`；自定义字体同样 prepend 进 mono 栈 |

**字阶六档**（`@theme` `--text-*` token，禁任意 px、禁 0.5px 半档微差）：

| Utility | 字号 | 用途 |
|---|---|---|
| `text-micro` | 10px | 计数、轴字、胶囊、folia 微信息 |
| `text-meta` | 11px | 副信息行、控件标签 |
| `text-detail` | 12px | 次级行标题（会话/设置行） |
| `text-body` | 13px | 正文、主行标题（agent 名） |
| `text-title` | 15px | 版题、刊头状态头条、waiting hero 标题 |
| `text-display` | 22px | hero 数字（仅 mono + tabular-nums，如「今日令牌」） |

中文层级四件套=字号落差+字重+灰度+留白；**eyebrow 不吃西文招**（`.eyebrow` 10px semibold + tracking 0.05em，无 uppercase 依赖，编号用 mono `01`）。禁 italic；衬线/装饰字体退场（2026-09 重设计定案，自定义入口只开给用户显式填写）。

### 状态色（语义严格，按主题取对比度合格值）

| Token | 语义 | 视觉 |
|---|---|---|
| `--status-working` | 干活中 | 玉绿点 + `breathe` 呼吸动画（2.6s） |
| `--status-waiting` | **轮到你了/等批准** | **琥珀**点 + `attention` 脉冲环（1.8s），与 murmur-mark 峰点琥珀同族 |
| `--status-idle` | 空闲 | 灰点 |
| `--status-stale` | 疑似卡住 | 哑光红点（警示但不打扰） |
| `--status-ended` | 已结束 | 空心环 |

**waiting 琥珀 ≠ agent accent**：琥珀只属于「轮到你了」。

### Agent accent（品牌识别色，图表/图例唯一彩色入口）

`--agent-kimi` 紫 / `--agent-zcode` 蓝 / `--agent-opencode` 绿 / `--agent-codex` 中性（暗底亮灰、亮底深灰）/ `--agent-cursor` 金 / `--agent-devin` 珊瑚朱 / `--agent-qoder` 芽绿，双主题各一套取值。

用法：`data-agent="<id>"` 属性 → 自动获得 `--accent` 变量（卡片内 accent 语境）→ `color-mix(in oklab, var(--accent) 15%, transparent)` 做底色；图表直接用 `var(--agent-*)`。组件内**禁止**写死品牌色。**注意：Switch、额度条等 chrome 件不读 --accent**——它们必须全 agent 同色（单色纪律）。

## 纪律（eslint 级约束，违者返工）

- ❌ 裸 Tailwind 色板（`bg-red-500`、`text-neutral-400`）、任意 hex、任意 px 字号
- ❌ 组件内写 `dark:` 或亮暗分支——主题差异只走 app.css 的 `:root[data-theme]` token 块
- ❌ UI chrome 上彩色：链接/开关/按钮/焦点全中性；彩色只有 status（什么状态）与 agent accent（谁）
- ❌ 衬线/装饰性字体、噪点颗粒纹理（用户自定义字体设置除外——那是用户自己的选择）
- ❌ **图表禁用原生 `title` 悬浮**（OS 延迟 1-2s）——一律 `chart-tip.tsx` 瞬时浮层（bg-overlay），锚点用 `lib/chart-tip.ts` 的 `anchorTop()` 或准星逻辑，边缘翻转防溢出
- ❌ **shadcn 生成件原样使用**——`components/ui/*.tsx` 落库即项目代码，必须把默认 palette（`bg-primary`/`ring-ring`/`dark:` 等）改写为上述语义 token 后才允许被引用；`data-slot` 属性仅作样式钩子保留。禁止 CLI `--overwrite` 覆盖已存在组件（会冲掉 token 化定制）；确需升级走「干净工作区 → 覆盖 → `git diff` → 按 `components/CUSTOMIZATIONS.md` + `grep CUSTOMIZED:` 重打定制 → 更新清单」，定制处必须标 `CUSTOMIZED:` 注释
- ❌ **玻璃铺满页面**：`glass-*` 是浮层专属材料（吸顶刊头/底栏 `glass-chrome`、浮卡 `glass-overlay`），地面与实体永不玻璃；禁整窗透明（macOS 26 方底板有案底）
- ✅ 动效只用 `duration-fast`(120ms) / `duration-normal`(200ms)；交互动效加 `ease-spring`。keyframes 白名单：`breathe` / `attention` / `tip-in` / `enter`（版块入场，父级 inline delay 错峰 ≤40ms 步进）/ `hop`（栖枝鸟跳，key remount 驱动）/ `num-in`（AnimatedNumber 转轮）/ `hero-breathe`（waiting 头条琥珀环境光 4.5s + mark 峰点 live）/ `drift`（椋鸟群游动，每点 `--dx/--dy/--drift-*` 变量）
- ✅ 密度：行高 9–10px padding、字走六档、hover 才展开次信息；popover 宽约 400px
- ✅ 卡片语法三档：**flat 地面**（编号栏目：hairline 上边 + mono 编号 + 名称，图表/设置栏目用）/ **card 实体**（`rounded-item + border + bg-card + shadow-raised`，会话组列表、工具行、额度卡等可交互实体用）/ **hero**（waiting 头条独享：琥珀左边条 + `bg-waiting/[0.06]` + 慢呼吸光晕）。shadow-raised 只出现在实体与 hero 上

## 结构惯例

- 面板布局：**玻璃 overlay 外壳**——ScrollArea 铺满，刊头/底栏 `glass-chrome` absolute 浮于其上（滚动内容从其下穿过），main 用 `--chrome-top`/`--chrome-bottom` padding 让位（改刊头内容必须回校这两个常量）
- 刊头（`murmur-header`）：裸放 murmur-mark（无 tile 壳，waiting>0 时峰点 `live` 呼吸）+ `MURMUR` mono 眉题 + **状态头条**（title 档，waiting 数字琥珀）+ folio 行（日期 · 已接入）+ **栖枝**
- 底栏：**pill 分段导航**（`bg-muted` 轨道 + 选中 `bg-raised` + hairline 描边，lucide 12px 图标 + meta 标签）；waiting 计数是「动态」后的琥珀上标数字。编号版式试过一轮被否了——分段控件是惯例区，别在这里玩花样
- **「栖枝」是签名元素**：`perch-strip.tsx`，两端渐隐的渐变枝 + 9px `data-agent` 状态点（bg-background 晕环压枝），状态切换 `hop` 鸟跳、入场按栖位错峰 55ms
- **「椋鸟群」是签名时刻**：`murmuration.tsx`，26 点 seed 化伪随机 + drift 错峰游动 + 峰点琥珀，空态专用（动态页/用量页）；语义=「群鸟休憩」，与产品名同构
- 动态页：尺规索引条（运行中/需处理/今日令牌 AnimatedNumber + 新鲜度）→ waiting hero（琥珀左边条 + `bg-waiting/[0.06]` + hero-breathe 光晕 + title 档标题）→ `01 · 正在发生` 分组列表（card 实体，`divide-y` hairline，AgentRow 无卡片壳、grid-rows 弹性展开）→ `02 · 已停止更新`
- 用量页：概览 hero（`今日令牌` eyebrow + display 档 mono 数字 + 右列近 7 日/10 周/活跃天数陪跑）→ flat 编号栏目：`01 · 近 10 周` 热力图（**`--heat` 暖橙密度阶**，月份行 + 一三五日星期列，GitHub 式周列日行）→ `02 · 按工具` 堆积柱 + 图例 → `03 · 按模型` 折线（虚线格 + 准星 + 峰值图注 + `model-line-chart.tsx` 悬浮明细，浮卡 glass-overlay）
- 会话行：状态点 + 标题（detail）+ 元信息（model · 相对时间，meta）+ 右侧 token 计数（micro mono）
- 空态：无边框盒子——居中 `Murmuration`（120px）+ body 档一句 + meta 说明
- 预览页：`#/design` hash 进入 `design/design-board.tsx`，新组件先上板再进业务页
