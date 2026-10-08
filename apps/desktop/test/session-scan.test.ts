/**
 * 会话文件渐进盘点（scanSessionFiles）的 store 行为验证。
 *
 * 无 electrobun 桥时 useRpc 落到离线替身：所有 request 立即 reject——
 * 正好覆盖「agent 扫描失败 → 剔除其旧行、计数收敛、整轮可收尾」的降级路径。
 * 成功/单飞/fresh 语义靠向替身 request 注入可控 stub（逐 agent deferred + 计数）验证。
 */

import { beforeEach, expect, test } from "bun:test";

// electrobun/view 顶层摸 window——垫空对象让 useRpc 走离线替身分支（__electrobun 缺席）。
// 静态 import 提升会先求值依赖链，垫片来不及生效；故此处有意用动态 import（测试加载序边界）。
Object.assign(globalThis, { window: {} });

const { seedStoredSessions } = await import("../src/mainview/design/demo-data");
const { useMurmurStore } = await import("../src/mainview/store/murmur");
const { useRpc } = await import("../src/mainview/lib/rpc");

/** 手动 settle 的 promise（逐 agent 控制盘点节奏用）。 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

/** deferred resolve → store .then → set → .finally 一串微任务；排干若干拍保证副作用落到位。 */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

interface ScanItem {
  agent: string;
  id: string;
  sizeBytes: number;
  createdAt: number;
  modifiedAt: number;
  kind: "file";
  active: boolean;
}

function item(agent: string, id = `${agent}-1`): ScanItem {
  return { agent, id, sizeBytes: 1, createdAt: 1, modifiedAt: 2, kind: "file", active: false };
}

/**
 * 替身 request 换成可控 stub：scanAgentSessions 逐 agent 返回 deferred 并记调用数。
 * useRpc 单例的视图实例已由 store 创建——直接覆写其 request 字段，本轮起计数。
 */
function installScanSpy() {
  const view = useRpc();
  const deferreds = new Map<string, Deferred<{ items: ScanItem[] }>>();
  const calls: string[] = [];
  Object.assign(view.rpc, {
    request: {
      scanAgentSessions: ({ agent }: { agent: string }) => {
        calls.push(agent);
        const d = deferred<{ items: ScanItem[] }>();
        deferreds.set(agent, d);
        return d.promise;
      },
    },
  });
  return { deferreds, calls };
}

const SEED_AGENTS = ["kimi", "zcode", "opencode", "codex", "cursor", "devin", "qoder", "minimax", "omp", "claude-code"];

function resolveAll(deferreds: Map<string, Deferred<{ items: ScanItem[] }>>) {
  for (const [agent, d] of deferreds) d.resolve({ items: [item(agent)] });
}

beforeEach(() => {
  useMurmurStore.setState({ sessionFiles: null, sessionFilesAt: 0, sessionScanPending: 0 });
});

test("渐进回填：先到先落行、pending 递减，收敛后记时间戳", async () => {
  const { deferreds, calls } = installScanSpy();
  const p = useMurmurStore.getState().scanSessionFiles();
  // set 先于首个 deferred settle——同步观察 pending 起点（全量十家并发出去了）。
  expect(useMurmurStore.getState().sessionScanPending).toBe(10);
  expect(calls).toEqual(SEED_AGENTS);

  deferreds.get("kimi")!.resolve({ items: [item("kimi", "k1")] });
  await flush();
  // kimi 先完成：行已上屏（渐进价值），其余九家仍在途。
  expect(useMurmurStore.getState().sessionFiles?.map((i) => i.agent)).toEqual(["kimi"]);
  expect(useMurmurStore.getState().sessionScanPending).toBe(9);
  expect(useMurmurStore.getState().sessionFilesAt).toBe(0);

  resolveAll(deferreds);
  await p;
  const s = useMurmurStore.getState();
  expect(s.sessionScanPending).toBe(0);
  expect(s.sessionFiles?.length).toBe(10);
  expect(s.sessionFilesAt).toBeGreaterThan(0);
});

test("失败 agent 的旧行被剔除（聚合版「失败即剔除」语义的渐进对应）", async () => {
  const rows = seedStoredSessions(Date.now());
  expect(rows.length).toBeGreaterThan(0);
  useMurmurStore.setState({ sessionFiles: rows });
  const { deferreds } = installScanSpy();
  const p = useMurmurStore.getState().scanSessionFiles();
  deferreds.get("kimi")!.reject(new Error("scan boom"));
  for (const [agent, d] of deferreds) if (agent !== "kimi") d.resolve({ items: [] });
  await p;
  const s = useMurmurStore.getState();
  // kimi 失败：其旧行（seed 有 6 条）被清掉；其余空结果也清。
  expect(s.sessionFiles?.some((i) => i.agent === "kimi")).toBe(false);
  expect(s.sessionScanPending).toBe(0);
});

test("重入并入同一轮：in-flight 期间再调不追加第二轮", async () => {
  const { deferreds, calls } = installScanSpy();
  const a = useMurmurStore.getState().scanSessionFiles();
  const b = useMurmurStore.getState().scanSessionFiles();
  resolveAll(deferreds);
  await Promise.all([a, b]);
  // 单飞证据：每 agent 恰好一条 RPC——若无守卫会是 20 条。
  expect(calls.length).toBe(10);
  expect(useMurmurStore.getState().sessionScanPending).toBe(0);
});

test("fresh 落在途轮之后另起新轮（删除后重扫不许吃旧快照）", async () => {
  const spy = installScanSpy();
  const p1 = useMurmurStore.getState().scanSessionFiles();
  const p2 = useMurmurStore.getState().scanSessionFiles(true);
  // 第一轮收敛 → fresh 调用另起第二轮（再发十条），p2 等到第二轮才返回。
  resolveAll(spy.deferreds);
  await p1;
  await flush();
  expect(spy.calls.length).toBe(20);
  expect(useMurmurStore.getState().sessionScanPending).toBe(10);
  for (const d of spy.deferreds.values()) d.resolve({ items: [] });
  await p2;
  expect(useMurmurStore.getState().sessionScanPending).toBe(0);
});
