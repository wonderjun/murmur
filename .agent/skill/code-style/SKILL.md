---
name: code-style
description: 在 Murmur 编写或修改任何 TS/TSX 文件时使用（命名、import 排序、中文 JSDoc、注释与禁区速查）。
---

# Murmur 代码风格

格式由 Prettier 统一（printWidth 120、semi、singleQuote、trailingComma all、lf），不要手工对齐。本文只管格式化管不了的：命名、结构、注释、禁区。

## 命名总表

| 对象 | 规则 | 正例 |
|---|---|---|
| 文件（.ts / .tsx） | kebab-case | `status-engine.ts`、`agent-row.tsx` |
| 类型/接口 | PascalCase，无 I 前缀 | `AgentEvent`、`QuotaSnapshot` |
| 变量/函数 | camelCase，动词开头 | `translateWireLine()`、`loadEndpoint()` |
| 模块级常量 | UPPER_SNAKE_CASE | `STALE_AFTER_MS`、`HOOK_MARKER` |
| Zustand store | `useXxxStore` + `create()` | `useMurmurStore`（`store/murmur.ts`） |
| React hook | `use-xxx.ts` + `useXxx` 导出 | `use-rpc.ts` |
| 组件 | 默认导出函数组件，文件名即组件名 | `agent-row.tsx` → `AgentRow` |
| 布尔 | `is/has/can/should` 前缀 | `isVisible`、`hasCredentials` |

## import 排序（五段，段间空行，段内字母序）

```ts
// ① node/bun 内建
import { existsSync, watch } from 'node:fs';
// ② 三方（react、zustand、radix-ui、lucide-react…，按包名字母序）
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
// ③ registry/ui 组件
import StatusDot from '@/components/status-dot';
// ④ 本项目（@/、@core/、shared）
import { useMurmurStore } from '@/store/murmur';
import type { AppSnapshot } from '@core/types';
// ⑤ 相对路径
import { pick } from './base';
```

`import type` 与值 import 分行写；纯类型 import 汇总到末尾一段。

## 注释风格

- **全部中文**，导出符号用 JSDoc `/** */`，句末英文句号。
- 文件头块注释写清模块职责与数据流（谁驱动谁、数据往哪流）。
- 只写"为什么"与契约约束（"payload 契约与 devin 文档镜像，双端改动必须同步"），不复述代码。
- 行内 `//`，前置空行。

## React/Zustand 约定

- 派生态不进 store：selector 只取原始字段（`useMurmurStore(s => s.snapshot)`），数组/对象派生走 `lib/selectors.ts` 纯函数 + `useMemo`，直接内联派生须 `useShallow`（快照 80ms 去抖推送，新引用会无谓重渲）。
- shadcn 生成件落 `components/ui/` 即项目代码：先改写为语义 token 再用，`data-slot` 只作样式钩子。
- Radix 受控件绑定 `checked`/`onCheckedChange`（Switch），不是 Vue 的 `modelValue`。

## 文件体量

机器门禁走 `packages/core/test/file-size.test.ts`（`bun run test` 顺带执行），本节是人肉判断的补充细则：

- **新文件硬上限 500 有效行，软上限 400 行**——接近软上限就考虑下一档拆分，不要顶格写。有效行口径 = 去空行去注释行（与门禁测试一致）。
- 拆分触发器：单文件有效行 >500 必拆（门禁直接 fail）；组件 JSX 大段/弹窗群考虑拆子组件；单个函数 >100 行考虑外移为纯函数。
- 存量超限文件在门禁测试的 `RATCHET` 表逐文件锁死当前有效行数（只许降不许升），拆分达标后删除条目；勿调大数值、勿给新文件加棘轮条目（直接写小）。
- 豁免：`components/ui/`（shadcn 复制式组件库，前缀豁免）、测试文件（体量是被测对象的镜像）；其他例外进 `EXEMPTIONS` 表且必须写清理由。

拆分手法速判（按超限成分对号入座）：

| 超限成分 | 手法 | 去处 |
|---|---|---|
| 可测纯逻辑（解析/转换/派生） | 抽纯函数 + 同名测试 | core 同目录新文件 / `lib/selectors.ts` |
| adapter 单文件堆积 | 按职责切分文件（kimi/devin 的 `files.ts`、`quota.ts` 先例） | `agents/<id>/xxx.ts` |
| UI 区块（JSX 大段/卡片群） | 拆子组件 | `components/` 就近子组件 |
| 主进程编排堆积 | 按域拆模块（tray/system 先例） | `src/bun/` 单域文件 |

拆分纪律：先补/确认测试锁语义再搬代码；搬移优先整块剪切（不重写）；拆完该文件的棘轮条目随之删除。

## 禁区

| 禁区 | 正确做法 |
|---|---|
| webview 代码摸 `window.electrobun`/裸用 RPC | 经 `@/lib/rpc.ts` 的 `useRpc` 单例 |
| `packages/core` import electrobun/react/DOM API | core 必须保持纯 TS（bun test 可跑）；桌面能力只能在 `apps/desktop/src/bun` 用 |
| 覆盖/重写用户 hook 配置文件 | 一律 mergeJsonHooks 合并 + HOOK_MARKER 标记幂等 |
| 在组件写裸色板/hex | 用语义 token（见 ui-design skill） |
| `any` | 具体类型；脏数据用 `as unknown as X` 收敛在 adapter 边界 |
| 非零退出 hook 脚本 / hook 脚本写 stdout 非 JSON | hook 脚本必须 `exit 0`、stdout 只吐 `{}` |

## 自查清单

- [ ] import 五段、`import type` 分行？
- [ ] 导出有中文 JSDoc、文件头有职责说明？
- [ ] 无 I 前缀类型、布尔 is/has 前缀？
- [ ] core 里没有桌面 API、UI 里没有裸色板？
- [ ] zustand selector 没有返回派生新引用？
- [ ] 新文件有效行 ≤400（硬上限 500），没顶格写？
