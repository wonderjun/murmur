---
name: testing
description: 在 Murmur 编写或修改 bun test 测试、为新纯函数补测试或变更既有行为时使用。
---

# Murmur 测试约定

bun test，测试集中在 `packages/core/test/`（**不与源码同目录**），`bun run test` 一把跑全量。本文骨架提炼自 `settings.test.ts`（沙箱注入正典）与 `ingest.test.ts`（env + 动态 import 正典）。

## 适用场景

- 新建纯函数 / translateXxx 翻译函数后补测试。
- 变更既有行为（先补测试锁定旧语义，再改）。
- 给涉及文件系统 / 单例固化的模块写测试。

## 铁律

1. **纯函数层必须有测试**：adapter 的 `translateXxx()`、`ledger/`、`hooks/install.ts` 的 merge/unmerge 系列、状态机迁移——凡是被采集链路与 RPC 消费的纯函数，改它必配测试。
2. 行为变更前先补测试锁定当前语义（失败 → 改实现 → 绿），禁止先改后补到"能过就行"。
3. 验证命令：`bun run test`（全量）；开发期定向跑 `bun test packages/core/test/<名>.test.ts`。
4. webview 组件无测试链——组件逻辑抽成纯函数（`lib/selectors.ts` 模式）后测函数本身。

## 环境隔离三坑（murmur 专属，全踩过）

1. **`MURMUR_HOME` 在 `paths.ts` 模块加载时固化**：涉及 ingest/endpoint/spool 的测试必须**先设 env 再动态 `import()`**，静态 import 会拿到真家目录：

```ts
// 隔离 MURMUR_HOME 再加载模块（endpoint 写在临时目录）。
process.env.MURMUR_HOME = mkdtempSync(join(tmpdir(), 'murmur-test-'));

const { startIngestServer } = await import('../src/ingest/server');
```

2. **全测试进程共享首个固化的 MURMUR_HOME**：settings/uninstall 类测试别信 env——`loadSettings/saveSettings` 收 `dir` 参数，全程钉进自己的 `mkdtempSync` tmpdir（`settings.test.ts` 正典）。同理 **`new Ledger()` 必须传 dir**（`new Ledger(HOME)`）——裸调在单文件跑时碰巧冻结到自己的沙箱，全量跑时冻结赢家是别的文件，会开到**真机 `~/.murmur/murmur.db`**：游标 1069050 之类真实值让增量扫描全跳过（devin message_nodes 测试曾因此全量红、单跑绿），更糟时会把测试用量写真机台账。
3. **migrate / 制品清扫测试必须把各 agent HOME env 钉进沙箱**（`MURMUR_CURSOR/CODEX/OPENCODE_*_HOME`），绝不指向真机——教训见 `migrate.test.ts` 文件头。`agentPaths()` 的各 agent 路径在函数体内读 env，可运行时再覆盖（`kimi-quota.test.ts` 先例）。

另：`hasOurHook` 按**绝对 HOOKS_DIR** 判归属，测试命令串必须经 `writeHookScript()` 产出（手写假路径判不上归属，见 `hooks-uninstall.test.ts` 头注释）。

## spec 正典骨架

```ts
/**
 * <模块名> 单测：一句话职责 + 隔离手段说明。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSettings } from '../src/settings';

describe('loadSettings', () => {
  test('损坏的 settings.json 回退默认值', () => {
    // ...
  });
});
```

规则：

- `bun:test` 一段、`node:` 内建一段、被测模块相对路径一段（import 五段在测试文件同样生效）。
- describe/it 文案用中文，写完读一遍能当行为文档。
- 命名 `<被测模块>.test.ts`；一个文件测一个模块/一个主题面。

## 不测什么

- 组件渲染（无组件测试链）。
- Never-Crash 的静默降级分支不强行造故障注入——但**降级的对外语义**（返回 unavailable / 空表 / 上次的快照）可测且应测。

## 自查清单

- [ ] 纯函数/翻译函数改了，测试同改？
- [ ] 涉及 MURMUR_HOME 的走了动态 import、其余钉 tmpdir？
- [ ] 没有指向真机家目录的路径？
- [ ] `bun run test` 全量绿（含 file-size 门禁）？

相关技能：`code-style`。
