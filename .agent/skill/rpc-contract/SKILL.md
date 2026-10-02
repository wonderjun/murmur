---
name: rpc-contract
description: 在 Murmur 新增或修改 RPC 能力（shared/rpc.ts 契约、bun/index.ts handler、webview 消费任一环节）时使用。
---

# RPC 契约约定

主进程 ↔ webview 的契约**单一来源**是 `apps/desktop/src/shared/rpc.ts`（`MurmurRPC` 类型，纯类型零依赖，双端共用）。一条 RPC 能力要成套穿透三个同步点，缺一不可。范本：`shared/rpc.ts`、`bun/index.ts`（`defineRPC` 注册段）、`mainview/lib/rpc.ts`（useRpc 单例）。

## 适用场景

- 新增一个 webview→主进程请求或主进程→webview 推送。
- 修改既有 payload / response 结构。
- 排查"webview 调了但主进程没收到"类断链问题。

## 契约扩展三同步（正典流程）

新增能力 `fooBar` 时，三个文件按序成套改：

**① `shared/rpc.ts`** —— 契约类型 + 逐方法中文 JSDoc：

```ts
export type MurmurRPC = {
  bun: RPCSchema<{
    requests: {
      /** 一句话语义（谁调、何时调、返回什么）。 */
      fooBar: { params: { agent: AgentId }; response: { ok: boolean } };
    };
    messages: {};
  }>;
  // ...
};
```

**② `bun/index.ts`** —— `BrowserView.defineRPC<MurmurRPC>` 的 `handlers.requests` 注册实现：

```ts
fooBar: async ({ agent }) => registry.fooBar(agent),
```

**③ webview 消费** —— 一律经 `@/lib/rpc.ts` 的 `useRpc` 单例：

```ts
const rpc = useRpc(onSnapshot);
const { ok } = await rpc.rpc.request.fooBar({ agent });
```

## 规则

1. **禁止任何一端离开契约写实现**——electrobun 的泛型让双端编译期对齐；缺 handler 或签名不符会在 `bun run typecheck:desktop` 直接报错。
2. **request vs message 分工**：问答式（拉数据/触发动作/等结果）走 `bun.requests`；主进程主动推（`snapshot` 全量广播）走 `webview.messages`。现状 messages 只有 snapshot 一条，新增推送先想能不能并入快照。
3. response 尽量小且可序列化（electrobun 走 JSON 桥）；大 payload 考虑分页或让 webview 再拉。
4. **BYOK 凭据永不进 RPC**：key 只进 `credentials.json`（0600），对外一律 maskKey 掩码——`setAgentKey` 只收不回传（见 settings 禁区）。
5. webview **禁摸 `window.electrobun` / 裸建 RPC**——`useRpc` 单例自带无桥离线降级（设计板预览靠它），绕过单例 = 预览白屏。

## 验证链（改契约后必须跑）

```bash
bun run typecheck:desktop   # 覆盖 webview + bun 主进程两端
bun run typecheck           # core（契约引用了 @core/types 时必须）
```

双端 typecheck 都过才算契约同步完成；`bun run dev` 起应用手动点一遍新入口。

## 已知反例（新代码禁止）

| 反例 | 为什么错 |
|---|---|
| webview 裸 `window.electrobun` 或自建 Electroview | 绕过 useRpc 的离线降级，设计板/无桥环境白屏 |
| 契约加了方法但 handler 忘注册 | 运行时才断链，typecheck 护得住注册、护不住"忘了改" |
| 把凭据明文塞进 response | BYOK 禁区：key 出主进程即事故 |

## 自查清单

- [ ] 三同步点（契约 → handler → webview 消费）成套改完？
- [ ] 新方法有中文 JSDoc、request/message 分工对？
- [ ] 没碰 `window.electrobun`、没把凭据放进 RPC？
- [ ] `typecheck:desktop` + `typecheck` 双过？

相关技能：`code-style`、`testing`。
