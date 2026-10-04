# shadcn/ui 组件定制清单

`ui/` 是 shadcn 复制式组件库（radix-ui 底层）：**落库即项目代码**，所有本地定制必须在本清单登记，并在改动处标 `CUSTOMIZED:` 注释。

- 禁止对已存在的组件执行 CLI `--overwrite` 覆盖（会冲掉下方全部定制）。
- 确需升级某组件：干净工作区 → CLI 覆盖 → `git diff` 对照 → 按本清单与 `grep -rn "CUSTOMIZED:" ui/` 重打定制 → 更新清单。
- 新增组件正常 CLI add，落库后随即 token 化并登记本清单。

## 通用定制（全部件）

默认 palette（`bg-primary` / `ring-ring` / `dark:` 双写等）全量改写为 murmur 语义 token（`app.css` 唯一真源）；彩色只有 status 与 agent accent 两条语义通道，chrome 件不读 `--accent`。

## 逐件登记

| 文件 | 定制点 |
|---|---|
| `ui/button.tsx` | 变体全走语义 token：default=bg-raised+hairline 次级；inverse=单色反相强确认；ghost 无框；destructive/destructiveSoft 走独立 `--destructive`（不占 status 红语义） |
| `ui/calendar.tsx` | react-day-picker 底层；chrome 全单色——选中端点/单选=前景反相实心、range 中段=前景 10% 底（after 伪元素补 1px 竖缝）、today=前景加重、hover=raised；日数字 mono tabular detail 档；默认 `zhCN` locale；`--cell-size/--cell-radius` 钉在 Root（不依赖 shadcn 样式表注入） |
| `ui/checkbox.tsx` | 3.5px 小方框 + hairline 描边；选中/半选 foreground 实心反相（单色，不引彩色） |
| `ui/popover.tsx` | content=glass-overlay 浮层材料（与 ChartTip 浮卡同族）+ rounded-item + hairline + shadow-overlay，无彩色 |
| `ui/scroll-area.tsx` | 1.5px 细轨道 + foreground/15 圆头滑块；Viewport `[&>div]:block!` 归一（Radix 内联 `display:table` 会让长文本撑出面板，见 AGENTS.md 坑节） |
| `ui/select.tsx` | trigger=bg-raised+hairline meta 小号形态；content=bg-card+shadow-raised 浮层语言（无彩色） |
| `ui/switch.tsx` | 单色纪律：off=foreground/15 灰槽，on=前景色槽+底色滑块；不读 `--accent`，全 agent 同色 |
