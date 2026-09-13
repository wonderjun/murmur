---
name: code-style
description: 在 Murmur 编写或修改任何 TS/Vue 文件时使用（命名、import 排序、中文 JSDoc、注释与禁区速查）。
---

# Murmur 代码风格

格式由 Prettier 统一（printWidth 120、semi、singleQuote、trailingComma all、lf），不要手工对齐。本文只管格式化管不了的：命名、结构、注释、禁区。

## 命名总表

| 对象 | 规则 | 正例 |
|---|---|---|
| 文件（.ts / 业务 .vue） | kebab-case | `status-engine.ts`、`agent-row.vue` |
| 类型/接口 | PascalCase，无 I 前缀 | `AgentEvent`、`QuotaSnapshot` |
| 变量/函数 | camelCase，动词开头 | `translateWireLine()`、`loadEndpoint()` |
| 模块级常量 | UPPER_SNAKE_CASE | `STALE_AFTER_MS`、`HOOK_MARKER` |
| Pinia store | `useXxxStore` + kebab-case id | `defineStore('murmur', ...)` |
| composable | `use-xxx.ts` + `useXxx` 导出 | `use-rpc.ts` |
| 布尔 | `is/has/can/should` 前缀 | `isVisible`、`hasCredentials` |

## import 排序（五段，段间空行，段内字母序）

```ts
// ① node/bun 内建
import { existsSync, watch } from 'node:fs';
// ② 三方（vue、pinia、reka-ui、lucide-vue-next…）
import { computed } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
// ③ registry/ui 组件
import StatusDot from '@/components/status-dot.vue';
// ④ 本项目（@/、@core/、shared）
import { useMurmurStore } from '@/store/murmur';
import type { AppSnapshot } from '@core/types';
// ⑤ 相对路径
import { pick } from './base';
```

`import type` 与值 import 分行写。

## 注释风格

- **全部中文**，导出符号用 JSDoc `/** */`，句末英文句号。
- 文件头块注释写清模块职责与数据流（谁驱动谁、数据往哪流）。
- 只写"为什么"与契约约束（"payload 契约与 devin 文档镜像，双端改动必须同步"），不复述代码。
- 行内 `//`，前置空行。

## 禁区

| 禁区 | 正确做法 |
|---|---|
| webview 代码摸 `window.electrobun`/裸用 RPC | 经 `@/lib/rpc.ts` 的 `useRpc` 单例 |
| `packages/core` import electrobun/vue/DOM API | core 必须保持纯 TS（bun test 可跑）；桌面能力只能在 `apps/desktop/src/bun` 用 |
| 覆盖/重写用户 hook 配置文件 | 一律 mergeJsonHooks 合并 + HOOK_MARKER 标记幂等 |
| 在组件写裸色板/hex | 用语义 token（见 ui-design skill） |
| `any` | 具体类型；脏数据用 `as unknown as X` 收敛在 adapter 边界 |
| 非零退出 hook 脚本 / hook 脚本写 stdout 非 JSON | hook 脚本必须 `exit 0`、stdout 只吐 `{}` |

## 自查清单

- [ ] import 五段、`import type` 分行？
- [ ] 导出有中文 JSDoc、文件头有职责说明？
- [ ] 无 I 前缀类型、布尔 is/has 前缀？
- [ ] core 里没有桌面 API、UI 里没有裸色板？
