/**
 * Desktop RPC 契约：键同步只扫源码；行为测试 import 抽出的 handler，不加载 electrobun。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createRpcHandlers } from "../src/bun/rpc-handlers";

import type { RpcHandlerDeps, RpcRegistry } from "../src/bun/rpc-handlers";
import type {
  AgentId,
  AppSnapshot,
  DiagnosticsSnapshot,
  HookTestResult,
  ManagerTab,
  SessionSnapshot,
} from "../../../packages/core/src/types";
import type { MurmurSettings } from "../../../packages/core/src/settings";
import type { SettingsSnapshot } from "../src/shared/rpc";

const desktop = join(import.meta.dir, "..");
const rpcSource = readFileSync(join(desktop, "src/shared/rpc.ts"), "utf8");
const mainSource = readFileSync(join(desktop, "src/bun/index.ts"), "utf8");
const handlerSource = readFileSync(join(desktop, "src/bun/rpc-handlers.ts"), "utf8");

const HOME = "/Users/murmur-test";
const NOW = 1_700_000_000_000;
const API_KEY = "sk-byok-do-not-leak";

describe("MurmurRPC 契约", () => {
  test("扫描器只取对象顶层键", () => {
    const src = `
      requests: {
        // comment: { no: true }
        getSnapshot: { params: {}; response: AppSnapshot };
        setAgentKey: {
          params: { apiKey: string };
          response: SettingsSnapshot;
        };
      };
    `;
    expect(objectKeys(src, nthObjectOpen(src, "requests", 1))).toEqual(["getSnapshot", "setAgentKey"]);
  });

  test("bun requests 与抽出的 handlers 一一对应", () => {
    const contract = objectKeys(rpcSource, nthObjectOpen(rpcSource, "requests", 1));
    const fnAt = handlerSource.indexOf("function createRpcHandlers");
    expect(fnAt).toBeGreaterThanOrEqual(0);
    const body = handlerSource.slice(fnAt);
    const ret = body.indexOf("return {");
    expect(ret).toBeGreaterThanOrEqual(0);
    const handlers = objectKeys(body, ret + "return ".length);
    expect(symmetricDiff(contract, handlers)).toEqual({ missing: [], extra: [] });
    expect(contract.length).toBeGreaterThan(0);
    expect(mainSource).toContain("BrowserView.defineRPC<MurmurRPC>");
    expect(mainSource).toContain("requests: createRpcHandlers(");
  });

  test("webview messages 都有主进程 send", () => {
    const messages = objectKeys(rpcSource, nthObjectOpen(rpcSource, "messages", 2));
    const sent = [...mainSource.matchAll(/\.send\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    expect(symmetricDiff(messages, sent)).toEqual({ missing: [], extra: [] });
    expect(messages).toContain("snapshot");
    expect(messages).toContain("managerNav");
  });
});

describe("createRpcHandlers", () => {
  test("参数透传到 registry，响应形状与设置快照原样返回", async () => {
    const { handlers, registry, settings, deps } = harness();
    const since = NOW - 3 * 86400_000;

    expect(handlers.getSnapshot({})).toEqual(registry.snapshot());
    expect(await handlers.installHooks({})).toEqual({
      kimi: { changed: true, files: ["/tmp/kimi.toml"] },
      zcode: { changed: false, files: [] },
      opencode: { changed: false, files: [] },
      codex: { changed: false, files: [] },
      cursor: { changed: false, files: [] },
      devin: { changed: false, files: [] },
      qoder: { changed: false, files: [] },
      minimax: { changed: false, files: [] },
    });
    expect(handlers.hidePanel({})).toEqual({ ok: true });
    expect(deps.hidden).toBe(true);
    expect(await handlers.refreshQuotas({})).toEqual({ ok: true });
    expect(registry.usageDailySince(since)).toEqual([
      { day: "2023-11-14", agent: "kimi", model: "k2", tokens: 3, costUsd: 0.1 },
    ]);
    expect(handlers.usageDaily({ since })).toEqual(registry.usageDailySince(since));
    expect(handlers.usageDaily({ days: 7 })).toEqual(registry.usageDailySince(NOW - 7 * 86400_000));
    expect(handlers.usageDaily({})).toEqual(registry.usageDailySince(NOW - 70 * 86400_000));

    expect(await handlers.getSettings({})).toBe(settings);
    const patch: Partial<MurmurSettings> = { showDockIcon: true, launchAtLogin: true, theme: "dark" };
    expect(await handlers.updateSettings({ patch })).toBe(settings);
    // 设置变更广播：面板/管理窗双 context 靠 push 同步（主题/字体即时生效）。
    expect(deps.settingsPushed).toEqual([settings]);
    expect(registry.patches).toEqual([patch, { launchAtLogin: false }]);
    expect(deps.dock).toEqual([true]);
    expect(deps.launch).toEqual([true]);

    expect(await handlers.setAgentHook({ agent: "kimi", enabled: false })).toBe(settings);
    expect(registry.hooks).toEqual([{ agent: "kimi", enabled: false }]);
    expect(await handlers.setAgentObserved({ agent: "codex", enabled: true })).toBe(settings);
    expect(registry.observed).toEqual([{ agent: "codex", enabled: true }]);
    // 每个 mutation 各推一次：updateSettings + 这两个累计 3 次广播。
    expect(deps.settingsPushed).toEqual([settings, settings, settings]);

    expect(handlers.readClipboard({})).toEqual({ text: "pasted" });
    expect(handlers.writeClipboard({ text: "cwd" })).toEqual({ ok: true });
    expect(deps.clipboard).toEqual(["cwd"]);
    expect(handlers.rebuildLedger({})).toEqual({ ok: true });
    expect(registry.rebuilt).toBe(true);

    const diagnostics = await handlers.getDiagnostics({});
    expect(diagnostics.ingest).toEqual({ endpoint: "127.0.0.1:9", ok: true });
    expect(diagnostics.agents).toEqual([]);
    const hookTest = await handlers.testAgentHook({ agent: "qoder" });
    expect(hookTest).toEqual({ agent: "qoder", ok: true, steps: [{ name: "marker", ok: true }] });
    expect(registry.tested).toEqual(["qoder"]);
    expect(await handlers.rescanAgent({ agent: "cursor" })).toEqual({ ok: true });
    expect(registry.rescanned).toEqual(["cursor"]);
    expect(await handlers.installAgentHooks({ agent: "devin" })).toEqual({
      changed: true,
      files: ["/tmp/devin.json"],
    });

    const scanned = await handlers.scanAgentSessions({ agent: "kimi" });
    expect(scanned.items).toEqual([
      { agent: "kimi", id: "s1", sizeBytes: 4, createdAt: 1, modifiedAt: 2, kind: "file", active: false },
    ]);
    expect(registry.scannedAgents).toEqual(["kimi"]);
    // 无此 agent 会话产物 → 空组语义（渐进回填的「这家没有」结果）。
    expect(await handlers.scanAgentSessions({ agent: "zcode" })).toEqual({ items: [] });
    expect(registry.scannedAgents).toEqual(["kimi", "zcode"]);
    expect(await handlers.revealSession({ agent: "kimi", id: "s1" })).toEqual({ ok: true });
    expect(deps.revealed).toEqual(["/tmp/session.jsonl"]);

    // focusSessionApp：活跃会话查到 cwd 才传给 focusApp；ended/查无会话各自兜底。
    expect(await handlers.focusSessionApp({ agent: "kimi", id: "s1" })).toEqual({ ok: true, app: "TestApp" });
    expect(deps.focused).toEqual([{ agent: "kimi", cwd: "/work/proj" }]);
    await handlers.focusSessionApp({ agent: "zcode", id: "ended-1" });
    await handlers.focusSessionApp({ agent: "kimi", id: "nope" });
    expect(deps.focused).toEqual([
      { agent: "kimi", cwd: "/work/proj" },
      { agent: "zcode", cwd: "/work/ended" },
      { agent: "kimi", cwd: undefined },
    ]);
    expect(handlers.openDataDir({})).toEqual({ ok: true });
    expect(deps.openedDataDir).toBe(true);

    // 更新三连：读相位 / 触发检查 / 受理换包，全部透传到注入的 updates 服务。
    expect((await handlers.getUpdateState({})).phase).toBe("idle");
    expect((await handlers.checkUpdate({})).phase).toBe("up-to-date");
    expect(await handlers.applyUpdate({})).toEqual({ ok: true });
    expect(deps.updated).toEqual({ checked: 1, applied: 1 });

    expect(handlers.quitApp({})).toEqual({ ok: true });
    expect(deps.quit).toBe(true);
  });

  test("BYOK apiKey 只进 registry，不出现在 response", async () => {
    const { handlers, registry, settings, deps } = harness();
    const response = await handlers.setAgentKey({
      agent: "zcode",
      apiKey: API_KEY,
      baseUrl: "https://example.test",
    });
    expect(response).toBe(settings);
    expect(registry.keys).toEqual([{ agent: "zcode", apiKey: API_KEY, baseUrl: "https://example.test" }]);
    expect(JSON.stringify(response)).not.toContain(API_KEY);
    const cleared = await handlers.setAgentKey({ agent: "zcode", apiKey: null });
    expect(cleared).toBe(settings);
    expect(registry.keys[1]).toEqual({ agent: "zcode", apiKey: null, baseUrl: undefined });
    // apiKey 的响应回了发起窗，但广播载荷也绝不能带明文——推流同受约束。
    expect(JSON.stringify(deps.settingsPushed)).not.toContain(API_KEY);
  });

  test("revealPath 只把家目录内路径交给 callback", () => {
    const { handlers, deps } = harness();
    expect(handlers.revealPath({ path: `${HOME}/.murmur/murmur.db` })).toEqual({ ok: true });
    expect(handlers.revealPath({ path: "/etc/passwd" })).toEqual({ ok: false });
    expect(handlers.revealPath({ path: HOME })).toEqual({ ok: false });
    expect(handlers.revealPath({ path: `${HOME}-evil/secret` })).toEqual({ ok: false });
    expect(deps.revealed).toEqual([`${HOME}/.murmur/murmur.db`]);
  });

  test("deleteSessions 把注入的 trash callback 原样传给 registry", async () => {
    const { handlers, registry } = harness();
    const items = [{ agent: "kimi" as const, id: "s1" }];
    const response = await handlers.deleteSessions({ items });
    expect(response).toEqual({
      results: [{ agent: "kimi", id: "s1", ok: true, freedBytes: 4 }],
    });
    expect(registry.trashedWith).toHaveLength(1);
    const trash = registry.trashedWith[0];
    expect(trash).toBeDefined();
    expect(trash!("/tmp/session.jsonl")).toBe(true);
    expect(trash!("/tmp/keep")).toBe(false);
  });

  test("openManager 缺省 tab 是 doctor", () => {
    const { handlers, deps } = harness();
    expect(handlers.openManager({})).toEqual({ ok: true });
    expect(handlers.openManager({ tab: "files" })).toEqual({ ok: true });
    expect(deps.tabs).toEqual(["doctor", "files"]);
  });
});

interface Harness {
  handlers: ReturnType<typeof createRpcHandlers>;
  registry: FakeRegistry;
  settings: SettingsSnapshot;
  deps: FakeDeps;
}

interface FakeDeps {
  hidden: boolean;
  dock: boolean[];
  launch: boolean[];
  clipboard: string[];
  revealed: string[];
  tabs: ManagerTab[];
  openedDataDir: boolean;
  quit: boolean;
  /** focusApp 调用捕获：handler 必须先查会话 cwd 再唤起。 */
  focused: { agent: AgentId; cwd: string | undefined }[];
  /** pushSettings 广播捕获：settings mutation 必须推一遍最新快照。 */
  settingsPushed: SettingsSnapshot[];
  /** 更新服务调用计数：checkUpdate/applyUpdate 各应落一次。 */
  updated: { checked: number; applied: number };
}

interface KeyCall {
  agent: AgentId;
  apiKey: string | null;
  baseUrl: string | undefined;
}

interface FakeRegistry extends RpcRegistry {
  patches: Partial<MurmurSettings>[];
  hooks: { agent: string; enabled: boolean }[];
  observed: { agent: string; enabled: boolean }[];
  keys: KeyCall[];
  rebuilt: boolean;
  tested: string[];
  rescanned: string[];
  trashedWith: Array<((path: string) => boolean) | undefined>;
  scannedAgents: string[];
}

function harness(): Harness {
  const settings = settingsSnapshot();
  const registry: FakeRegistry = {
    patches: [],
    hooks: [],
    observed: [],
    keys: [],
    rebuilt: false,
    tested: [],
    rescanned: [],
    trashedWith: [],
    scannedAgents: [],
    snapshot: () => appSnapshot(),
    installAllHooks: () => ({
      kimi: { changed: true, files: ["/tmp/kimi.toml"] },
      zcode: { changed: false, files: [] },
      opencode: { changed: false, files: [] },
      codex: { changed: false, files: [] },
      cursor: { changed: false, files: [] },
      devin: { changed: false, files: [] },
      qoder: { changed: false, files: [] },
      minimax: { changed: false, files: [] },
    }),
    refreshQuotas: async () => {},
    usageDailySince: (sinceMs) => [
      {
        day: "2023-11-14",
        agent: "kimi",
        model: sinceMs === NOW - 3 * 86400_000 ? "k2" : null,
        tokens: 3,
        costUsd: 0.1,
      },
    ],
    getSettings: () => settings.settings,
    updateSettings: async (patch) => {
      registry.patches.push(patch);
      return settings.settings;
    },
    setAgentHook: async (agent, enabled) => {
      registry.hooks.push({ agent, enabled });
      return settings.settings;
    },
    setAgentObserved: async (agent, enabled) => {
      registry.observed.push({ agent, enabled });
      return settings.settings;
    },
    setAgentKey: async (agent, apiKey, baseUrl) => {
      registry.keys.push({ agent, apiKey, baseUrl });
    },
    rebuildLedger: () => {
      registry.rebuilt = true;
    },
    diagnostics: () => diagnostics(),
    testAgentHook: (agent) => {
      registry.tested.push(agent);
      const result: HookTestResult = { agent, ok: true, steps: [{ name: "marker", ok: true }] };
      return result;
    },
    rescanAgent: async (agent) => {
      registry.rescanned.push(agent);
    },
    installAgentHooks: async (agent) => ({ changed: agent === "devin", files: ["/tmp/devin.json"] }),
    scanAgentSessions: async (agent) => {
      registry.scannedAgents.push(agent);
      return agent === "kimi"
        ? [
            {
              agent: "kimi" as const,
              id: "s1",
              sizeBytes: 4,
              createdAt: 1,
              modifiedAt: 2,
              kind: "file" as const,
              active: false,
            },
          ]
        : [];
    },
    deleteSessions: async (items, trash) => {
      registry.trashedWith.push(trash);
      return items.map((item) => ({ agent: item.agent, id: item.id, ok: true, freedBytes: 4 }));
    },
    sessionPaths: async () => ["/tmp/session.jsonl"],
  };
  const deps: FakeDeps = {
    hidden: false,
    dock: [],
    launch: [],
    clipboard: [],
    revealed: [],
    tabs: [],
    openedDataDir: false,
    quit: false,
    focused: [],
    settingsPushed: [],
    updated: { checked: 0, applied: 0 },
  };
  const moveToTrash = (path: string) => path.endsWith(".jsonl");
  const handlers = createRpcHandlers({
    registry,
    settingsSnapshot: async () => settings,
    pushSettings: (snap) => deps.settingsPushed.push(snap),
    homeDir: HOME,
    now: () => NOW,
    hidePanel: () => {
      deps.hidden = true;
    },
    readClipboard: () => "pasted",
    writeClipboard: (text) => deps.clipboard.push(text),
    applyDockIcon: (visible) => deps.dock.push(visible),
    setLaunchAtLogin: (enabled) => {
      deps.launch.push(enabled);
      return false;
    },
    openManager: (tab) => deps.tabs.push(tab),
    revealInFinder: (path) => deps.revealed.push(path),
    focusApp: async (agent, cwd) => {
      deps.focused.push({ agent, cwd });
      return { ok: true, app: "TestApp" };
    },
    moveToTrash,
    openDataDir: () => {
      deps.openedDataDir = true;
    },
    updateState: async () => ({ phase: "idle", current: "test", channel: "dev" }),
    checkUpdate: async () => {
      deps.updated.checked += 1;
      return { phase: "up-to-date", current: "test", channel: "dev" };
    },
    applyUpdate: async () => {
      deps.updated.applied += 1;
      return { ok: true };
    },
    quit: () => {
      deps.quit = true;
    },
  } satisfies RpcHandlerDeps);
  return { handlers, registry, settings, deps };
}

function settingsSnapshot(): SettingsSnapshot {
  const stored: MurmurSettings = {
    launchAtLogin: false,
    showDockIcon: false,
    notifyOnWaiting: false,
    autoInstallHooks: true,
    theme: "system",
    font: "",
    agents: {},
    hooks: {},
  };
  return {
    settings: stored,
    runtime: {
      dockIconVisible: false,
      launchAtLogin: false,
      canLaunchAtLogin: false,
      version: "test",
      channel: "dev",
      dataDir: "/tmp/murmur-test",
      ingestEndpoint: "127.0.0.1:9",
      firstRun: false,
    },
  };
}

function appSnapshot(): AppSnapshot {
  const session: SessionSnapshot = {
    agent: "kimi",
    sessionId: "s1",
    status: "waiting",
    statusAt: 1,
    lastEventAt: 2,
    startedAt: 1,
    cwd: "/work/proj",
    tokens: { input: 1, output: 2 },
    costUsd: 0,
  };
  const ended: SessionSnapshot = {
    agent: "zcode",
    sessionId: "ended-1",
    status: "ended",
    statusAt: 3,
    lastEventAt: 3,
    startedAt: 1,
    endedAt: 3,
    cwd: "/work/ended",
    tokens: { input: 0, output: 0 },
    costUsd: 0,
  };
  return {
    agents: [
      {
        agent: "kimi",
        install: { installed: true, hasCredentials: false, homeDir: "/h", hookInstalled: false },
        disabled: false,
        sessions: [session],
      },
    ],
    overall: "waiting",
    generatedAt: NOW,
    recentlyEnded: [ended],
  };
}

function diagnostics(): DiagnosticsSnapshot {
  return { agents: [], ingest: { endpoint: "127.0.0.1:9", ok: true }, firstRun: false, generatedAt: NOW };
}

/** 第 n 个 `label: {` 的花括号下标（1-based）。 */
function nthObjectOpen(source: string, label: string, n: number): number {
  const re = new RegExp(`\\b${label}\\s*:\\s*\\{`, "g");
  let seen = 0;
  for (const match of source.matchAll(re)) {
    seen += 1;
    if (seen === n) return match.index + match[0].length - 1;
  }
  throw new Error(`找不到第 ${n} 个 ${label} 对象`);
}

/** 取对象字面量深度为 1 的键，跳过注释、字符串和嵌套块。 */
function objectKeys(source: string, openBrace: number): string[] {
  const keys: string[] = [];
  let depth = 1;
  let pending = "";
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "{") {
      depth += 1;
      pending = "";
      i += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      pending = "";
      i += 1;
      continue;
    }
    if (depth === 1 && c === ":") {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(pending)) keys.push(pending);
      pending = "";
      i += 1;
      continue;
    }
    if (depth === 1 && /[A-Za-z0-9_]/.test(c)) pending += c;
    else if (depth === 1 && !/\s/.test(c)) pending = "";
    i += 1;
  }
  if (depth !== 0) throw new Error("对象花括号不配对");
  return keys;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function symmetricDiff(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((name) => !actualSet.has(name)),
    extra: actual.filter((name) => !expectedSet.has(name)),
  };
}
