---
name: ui-design
description: 在 Murmur 编写或修改任何 UI（.tsx / app.css / 组件视觉）时使用——Murmur 视觉契约：token 真源、状态语义、动效与密度纪律。
---

# Murmur UI 设计契约

Murmur 是常驻菜单栏的「状态伴侣」，质感来自**克制与一瞥即读**，不是炫技。设计母题：栖木——每个 agent 是一只栖在枝上的鸟，状态即姿态。主题：**暮色栖木**——深墨蓝黑底 + 琥珀天光，暗/亮双主题经 `<html data-theme>` 切换（settings.theme = system/dark/light，`lib/appearance.ts` 应用，默认跟随系统）；UI chrome 全中性——交互只走前景/背景灰阶反相，无品牌蓝；表面靠前景色的半透明叠层分档，不靠描边。

品牌图形分工（2026-09 定稿，勿混用）：**应用图标（icon.iconset / tray）与面板内品牌印同构——抽象 murmuration 点群波浪 + 栖枝，峰点琥珀 =「轮到你了」**。应用图标母版在 `apps/desktop/icons/*.svg`；面板内品牌印是 `murmur-mark.tsx`（currentColor 线条 + `var(--status-waiting)` 峰点），header 与空态在用。

## Token 真源

唯一真源：`apps/desktop/src/mainview/app.css`（Tailwind v4 `@theme` + `:root` / `:root[data-theme]` CSS vars）。改 token 必须同步本文件。

### 表面与文字（叠层三档 + 浮层）

| Token | 用途 |
|---|---|
| `--background` | 面板底（暮色墨蓝黑 / 晨光暖白） |
| `--surface-1` `--surface-2` `--surface-3` | 前景色半透明叠层：地面分组 / 行 hover 与实体 / 轨道与填充，档位靠堆叠不靠描边 |
| `--overlay` | 悬浮层（ChartTip 明细卡）：暗色亮一档实体、浅色取纯白 |
| `--hairline` | 分隔线（不做卡片描边） |
| `--glow` | 琥珀天光基色（Dawn 组件经 dawn-quiet/dawn-live utility 取两档强度） |
| `--shadow-float` | 浮层唯一阴影（`shadow-float` utility） |
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
| `--font-data` | 面板数据字形（headline/display 数字、琥珀计数）：IBM Plex Mono 经 @fontsource 打包进 dist，栈与 mono 同值 |

**字阶七档**（`@theme` `--text-*` token，禁任意 px、禁 0.5px 半档微差）：

| Utility | 字号 | 用途 |
|---|---|---|
| `text-micro` | 10px | 计数、轴字、胶囊、folia 微信息 |
| `text-meta` | 11px | 副信息行、控件标签 |
| `text-detail` | 12px | 次级行标题（会话/设置行） |
| `text-body` | 13px | 正文、主行标题（agent 名） |
| `text-title` | 15px | 版题、刊头状态头条、waiting hero 标题 |
| `text-headline` | 26px | 版块大题（天光盒内摘要行等） |
| `text-display` | 34px | hero 数字（仅 data/mono + tabular-nums，如「今日令牌」） |

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

`--agent-kimi` 紫 / `--agent-zcode` 蓝 / `--agent-opencode` 绿 / `--agent-codex` 中性（暗底亮灰、亮底深灰）/ `--agent-cursor` 金 / `--agent-devin` 珊瑚朱 / `--agent-qoder` 芽绿 / `--agent-minimax` 品红 / `--agent-omp` 青蓝，双主题各一套取值。

用法：`data-agent="<id>"` 属性 → 自动获得 `--accent` 变量（卡片内 accent 语境）→ `color-mix(in oklab, var(--accent) 15%, transparent)` 做底色；图表直接用 `var(--agent-*)`。组件内**禁止**写死品牌色。**注意：Switch、额度条等 chrome 件不读 --accent**——它们必须全 agent 同色（单色纪律）。

## 纪律（eslint 级约束，违者返工——前四条已由 `apps/desktop/eslint.config.js` 的 `better-tailwindcss/no-restricted-classes` 门禁）

- ❌ 裸 Tailwind 色板（`bg-red-500`、`text-neutral-400`）、任意 hex、任意 px 字号
- ❌ 组件内写 `dark:` 或亮暗分支——主题差异只走 app.css 的 `:root[data-theme]` token 块
- ❌ UI chrome 上彩色：链接/开关/按钮/焦点全中性；彩色只有 status（什么状态）与 agent accent（谁）
- ❌ 衬线/装饰性字体、噪点颗粒纹理（用户自定义字体设置除外——那是用户自己的选择）
- ❌ **图表禁用原生 `title` 悬浮**（OS 延迟 1-2s）——一律 `chart-tip.tsx` 瞬时浮层（bg-overlay），锚点用 `lib/chart-tip.ts` 的 `anchorTop()` 或准星逻辑，边缘翻转防溢出
- ❌ **shadcn 生成件原样使用**——`components/ui/*.tsx` 落库即项目代码，必须把默认 palette（`bg-primary`/`ring-ring`/`dark:` 等）改写为上述语义 token 后才允许被引用；`data-slot` 属性仅作样式钩子保留。禁止 CLI `--overwrite` 覆盖已存在组件（会冲掉 token 化定制）；确需升级走「干净工作区 → 覆盖 → `git diff` → 按 `components/CUSTOMIZATIONS.md` + `grep CUSTOMIZED:` 重打定制 → 更新清单」，定制处必须标 `CUSTOMIZED:` 注释
- ❌ **玻璃铺满页面**：`glass-*` 是浮层专属材料（吸顶刊头/底栏 `glass-chrome`、浮卡 `glass-overlay`），地面与实体永不玻璃；禁整窗透明（macOS 26 方底板有案底）
- ✅ 动效只用 `duration-fast`(120ms) / `duration-normal`(200ms)；交互动效加 `ease-spring`。keyframes 白名单：`breathe` / `ring-breathe`（状态环不透明度版）/ `attention` / `tip-in` / `enter`（版块入场，打开编排一次排定固定 delay）/ `hop`（保留未用）/ `num-in`（AnimatedNumber 转轮）/ `hero-breathe`（waiting 头条琥珀环境光 4.5s + mark 峰点 live）/ `drift`（椋鸟群游动，每点 `--dx/--dy/--drift-*` 变量）/ `dawn`（天光 live 呼吸 6s）/ `land`（新行落枝 480ms）
- ✅ 密度：行高 9–10px padding、字走七档、hover 才展开次信息；popover 宽约 400px
- ✅ 叠层三档：**surface-1 地面分组**（分组列表容器、版块底）/ **surface-2 行 hover 与实体**（次级按钮、行 hover 态）/ **surface-3 轨道与填充**（segmented 轨道、骨架屏）。描边卡与 `shadow-raised` 退场，阴影只给浮层 `shadow-float`；hero（waiting 头条）独享琥珀左边条 + `bg-waiting/[0.06]` + 卡内 `dawn-quiet` 恒亮天光

## 结构惯例

- **「天光」是暮色签名氛围**：`dawn.tsx`，面板顶部左侧琥珀径向光晕（quiet 恒亮 / live + `animate-dawn` 呼吸，live=有 waiting），aria-hidden 装饰层垫底不交互
- **「状态环」是徽标新壳**：`status-ring.tsx`，1.5px status 色细环 + 中心 mono `AgentIcon`（currentColor 字形，`variant="mono"`）；working 环 `ring-breathe`、waiting 环叠 `attention` 脉冲
- 面板布局：**玻璃 overlay 外壳**——ScrollArea 铺满，刊头/底栏 `glass-chrome` absolute 浮于其上（滚动内容从其下穿过），main 用 `--chrome-top`/`--chrome-bottom` padding 让位（改刊头内容必须回校这两个常量）；面板根第一子元素是 `<Dawn live={waiting>0}>` 垫底（z-0，玻璃透出光晕）
- 刊头（`murmur-header`）：`px-5 pt-4 pb-3`——murmur-mark 28（waiting>0 峰点 live 呼吸）+ **headline 档状态头条**（waiting 数字琥珀 font-data，working 数字前景色，安静时「现在很安静」）+ 副句（等待对象与在跑数 / 在跑工具名列表 / 安静时 folio 日期·已接入）+ **栖枝** `mt-3.5`
- 底栏：`h-11` 文字 tab（detail 档，选中前景色 + 2px 短下划线——live 且有 waiting 时下划线转琥珀），「动态」后挂 waiting 计数（font-data micro 琥珀 AnimatedNumber）；右侧「今日 {tokens}」font-data 按钮点击刷额度（刷新中数字半透），末位管理台/退出图标钮
- **「栖枝」是签名元素**：`perch-strip.tsx`，20px 高 SVG 微弧枝（linearGradient 两端渐隐）+ 11px `StatusDot`（bg-background 晕环压枝，waiting 鸟额外 `status-waiting-glow` 晕环），状态切换 `land` 落枝、入场按栖位错峰 80ms+i*45ms；hover/focus 出 glass-overlay 小标签
- **「椋鸟群」是签名时刻**：`murmuration.tsx`，26 点 seed 化伪随机 + drift 错峰游动 + 峰点琥珀，空态专用（动态页/用量页）；语义=「群鸟休憩」，与产品名同构
- 动态页：waiting hero（`waiting-hero.tsx`：surface-1 壳 + 琥珀左边条 + 卡内 dawn-quiet 恒亮天光 + 动作行 + 多 waiting 轮换点）→「正在发生」分组（eyebrow + hairline 尾线 + font-data 计数，容器 `rounded-item bg-surface-1 divide-y`）→「已停止更新」（红 eyebrow）→「最近结束」折叠组
- 用量页：PageHead + 概览 hero（`今日令牌` eyebrow + display 档 font-data 数字 + 右列近 7 日/今年/活跃天数三格陪跑）→ 三块 `rounded-item bg-surface-1 p-4` 容器（块头 detail 标题 + 右侧副信息，无编号）：`{年份} 年热力图`（**`--heat` 暖橙密度阶**，`usage-heatmap.tsx`，GitHub 式周列日行；无数据日与未来日同为空格）→「区间」行 + `UsageRangePicker` → `按工具` 堆积柱 + 图例（`usage-bars.tsx`）→ `按模型` 折线（虚线格 + 准星 + `model-line-chart.tsx` 悬浮明细）——块头右侧区间标签旁挂工具多选钮（Popover + Checkbox，只列区间内有量的 agent、空选=全选且各项均勾、单 agent 不出钮、失效选项自动剔除）
- 接入诊断：PageHead（发现/已连接/需检查统计 + 刷新钮）→ 首启引导卡（surface-1 + Dawn quiet + Murmuration 水印，接入回报清单落卡底）→「上报服务」GroupList（ingest 端点 + 健康点）→「工具」GroupList，`doctor-agent-card` 为 GroupRow + 展开块形态（展开两列：左数据面探针 / 右 hook 上报 + 本地读取，底部动作行 + 链路自检 stepper），默认展开首个「需检查」
- 会话文件：PageHead（项数·体积·扫描时刻 meta + 刷新/删除 actions）+ 筛选行（工具 Segmented——胶囊溢出时轨内横滚 + 可滚缘渐隐 + 项目 Select）+ surface-1 表容器（sticky 表头 bg-surface-2，行 h-10 hover surface-2 / 选中 surface-3/60，数字列 font-data 右对齐，活跃行琥珀「活跃」标禁删），限宽 760
- 会话行（AgentRow 明细）：状态点 + 标题（detail）+ 元信息（model · 状态文案 · [等了 x 琥珀]，右 `font-data` 令牌计数）+ 定位行（cwd `font-data` + 「复制路径/在 Finder 显示」`opacity-0` 默认隐身，group-hover/focus-within 浮出）+ font-data 时间线
- 空态：无边框盒子——居中 `Murmuration`（180px）+ body 档一句 + meta 说明
- 管理台：`manager-app` 左栏 200（`manager-sidebar`，bg-surface-1 + hairline 右边）+ 内容列**流体铺满**（px-8 起，不限宽——宽窗居中限宽的双留白实测不可接受），页头走 `page-head.tsx`（headline 标题 + meta + 动作槽）；**`GroupList`/`GroupRow` 是管理台内容的基本单元**（surface-1 叠层 + hairline 分隔，行可点手风琴）；品牌砖只在管理台彩色（面板一律 mono 字形 + 状态环）。**窄窗两档**（`@custom-variant`，仅管理台组件可用——面板恒 392 会误命中）：`mid`（≤700）侧栏收 56px 图标栏（label/folio/尾巴全隐，按钮补 aria-label）；`tight`（≤560）PageHead 纵排、内容列收窄 padding；会话文件表窄于 520 走表内横滚（overflow-x-auto 层在 ScrollArea **外**——Radix viewport 对未启用轴输出 overflow-x:hidden，内包会截胡 sticky 表头）
- 预览页：`#/design` hash 进入 `design/design-board.tsx`，新组件先上板再进业务页
