/**
 * Murmur 主进程（Bun 运行时）。
 *
 * 职责：创建 tray + popover 面板，启动 @murmur/core 引擎
 * （ingest 服务 + 各 agent watcher + 状态机），通过 RPC 向 webview
 * 推送快照。单进程、无守护、退出即全停。
 *
 * 坐标系注意（实测）：tray.getBounds() 返回 AppKit 主屏左下原点坐标，
 * 而 BrowserWindow.setPosition / Screen.* 用左上原点逻辑坐标——面板锚定
 * 换算：y_tl = primaryH - bounds.y + gap，x 直接可用；多屏以光标屏钳位。
 *
 * 设置副作用：Dock 显隐与 LaunchAgent 自启在 system.ts；waiting 通知
 * 在 onChange 里按 sessionId 集合 diff，首个快照作基线防回填轰炸。
 */

import { BrowserView, BrowserWindow, Screen, Tray, Updater, Utils } from "electrobun/main";
import { setApplicationMenu } from "electrobun/main/app-menu";

import { AgentRegistry, migrateLegacyHome, MURMUR_HOME } from "../../../../packages/core/src/index";

import type { MurmurRPC, SettingsSnapshot } from "../shared/rpc";
import {
  appBundlePath,
  applyDockIcon,
  canLaunchAtLogin,
  isDockIconVisible,
  isLaunchAtLogin,
  setLaunchAtLogin,
} from "./system";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const PANEL_WIDTH = 392;
const PANEL_HEIGHT = 600;

/** dev 模式下优先用 vite dev server（HMR），否则走打包的 views://。 */
async function resolveMainViewUrl(): Promise<string> {
  try {
    const channel = await Updater.localInfo.channel();
    if (channel === "dev") {
      // 5173 是 vite 公共默认口，别的项目也能占用——HEAD 通不算数，
      // GET 校验页面特征；外来页面会拿到完整 RPC 桥，绝不能加载。
      const res = await fetch(DEV_SERVER_URL);
      if (res.ok && (await res.text()).includes("<title>Murmur</title>")) {
        console.log(`[murmur] HMR: ${DEV_SERVER_URL}`);
        return DEV_SERVER_URL;
      }
    }
  } catch {
    // 非 dev channel 或 vite 未起。
  }
  return "views://mainview/index.html";
}

// perch 时代数据一次性搬家 + 旧制品清扫（幂等），必须在 Ledger 打开前完成。
if (migrateLegacyHome()) console.log("[murmur] legacy ~/.perch migrated → ~/.murmur");

const registry = new AgentRegistry();

/** 退出主流程：stop 无论成败都必须落到 process.exit，进程绝不能残留。 */
function quitMurmur(): void {
  void Promise.resolve()
    .then(() => registry.stop())
    .catch((err) => console.error("[murmur] stop failed on quit:", err))
    .then(() => process.exit(0));
}

/** 组装设置页快照：持久化设置 + 系统侧读回的实况（对账而非信任写入值）。 */
async function settingsSnapshot(): Promise<SettingsSnapshot> {
  let version = "dev";
  let channel = "dev";
  try {
    const info = await Updater.getLocalInfo();
    version = info.version || "dev";
    channel = info.channel || "dev";
  } catch {
    // version.json 缺失（裸 bun 直跑）按 dev 报。
  }
  return {
    settings: registry.getSettings(),
    runtime: {
      dockIconVisible: isDockIconVisible(),
      launchAtLogin: isLaunchAtLogin(),
      canLaunchAtLogin: canLaunchAtLogin(),
      version,
      channel,
      dataDir: MURMUR_HOME,
      ingestEndpoint: registry.ingestEndpoint(),
    },
  };
}

const rpc = BrowserView.defineRPC<MurmurRPC>({
  maxRequestTime: 15000,
  handlers: {
    requests: {
      getSnapshot: () => registry.snapshot(),
      installHooks: async () => registry.installAllHooks(),
      refreshQuotas: async () => {
        await registry.refreshQuotas();
        return { ok: true as const };
      },
      usageDaily: ({ days }) => registry.usageDaily(days ?? 70),
      hidePanel: () => {
        panel.hide();
        return { ok: true as const };
      },
      getSettings: () => settingsSnapshot(),
      updateSettings: async ({ patch }) => {
        await registry.updateSettings(patch);
        if (patch.showDockIcon !== undefined) applyDockIcon(patch.showDockIcon);
        if (patch.launchAtLogin !== undefined) {
          const actual = setLaunchAtLogin(patch.launchAtLogin);
          // 实际态与意图不符（如 dev 无 bundle）时回写，设置存储与系统实况保持自洽。
          if (actual !== patch.launchAtLogin) await registry.updateSettings({ launchAtLogin: actual });
        }
        return settingsSnapshot();
      },
      setAgentHook: async ({ agent, enabled }) => {
        await registry.setAgentHook(agent, enabled);
        return settingsSnapshot();
      },
      setAgentObserved: async ({ agent, enabled }) => {
        await registry.setAgentObserved(agent, enabled);
        return settingsSnapshot();
      },
      setAgentKey: async ({ agent, apiKey, baseUrl }) => {
        await registry.setAgentKey(agent, apiKey, baseUrl);
        return settingsSnapshot();
      },
      readClipboard: () => ({ text: Utils.clipboardReadText() }),
      rebuildLedger: () => {
        registry.rebuildLedger();
        return { ok: true as const };
      },
      openSessions: () => {
        openSessionsWindow();
        return { ok: true as const };
      },
      scanSessions: async () => ({ items: await registry.scanSessions(), scannedAt: Date.now() }),
      deleteSessions: async ({ items }) => ({
        // 文件类产物一律进废纸篓（可恢复）；库内行由 adapter 自行事务删。
        results: await registry.deleteSessions(items, (p) => Utils.moveToTrash(p)),
      }),
      revealSession: async ({ agent, id }) => {
        const [p] = await registry.sessionPaths(agent, id);
        if (p) Utils.showItemInFolder(p);
        return { ok: Boolean(p) };
      },
      openDataDir: () => {
        Utils.showItemInFolder(MURMUR_HOME);
        return { ok: true as const };
      },
      quitApp: () => {
        quitMurmur();
        return { ok: true as const };
      },
    },
    messages: {},
  },
});

const url = await resolveMainViewUrl();

/** 会话文件页与面板同 bundle：#/files hash 分流（dev server 需补 / 前缀）。 */
function sessionsViewUrl(): string {
  return url.startsWith("http") ? `${url}/#/files` : `${url}#/files`;
}

/** 会话文件管理窗：独立页面容器（popover 失焦即收起的语义不适用于管理操作）。 */
let sessionsWin: BrowserWindow<typeof rpc> | null = null;
function openSessionsWindow() {
  if (sessionsWin) {
    sessionsWin.show();
    return;
  }
  sessionsWin = new BrowserWindow<typeof rpc>({
    title: "Murmur 会话文件",
    url: sessionsViewUrl(),
    rpc,
    titleBarStyle: "hiddenInset",
    styleMask: { Closable: true, Miniaturizable: true, Resizable: true },
    // 缺省 x/y → 系统居中。
    frame: { width: 780, height: 560 },
  });
  sessionsWin.on("close", () => {
    sessionsWin = null;
  });
}

const panel = new BrowserWindow<typeof rpc>({
  // 标题必须为空：Titled 窗口的标题文字会画在面板顶部（2026-09 实测）。
  title: "",
  url,
  rpc,
  hidden: true,
  // hiddenInset = Titled + FullSizeContentView（SDK 自动补），即"标准窗口几何 +
  // 全尺寸内容"：macOS 26 只对标准窗口套系统圆角+阴影。titleBarStyle:"hidden"
  // 是 Titled:false 无边框窗口，会露出方形底板（实测「圆角外套直角框」）；
  // "default" 会把 webview 排到标题栏下方并画出标题文字；transparent 关不掉
  // 方形原生阴影（2.0.1 无 hasShadow API）——三条路实测都不通，走 hiddenInset。
  titleBarStyle: "hiddenInset",
  styleMask: {
    Closable: false,
    Miniaturizable: false,
    Resizable: false,
  },
  frame: { x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT },
});

// 全屏 Space 就地弹出：canJoinAllSpaces 让窗口属于所有 Space（含其他应用的全屏
// Space），show() 激活时 macOS 不再切屏；floating 层级压过全屏应用内容。
// 对照 flow-desktop/electron 同款处理（setVisibleOnAllWorkspaces + alwaysOnTop）。
panel.setVisibleOnAllWorkspaces(true);
panel.setAlwaysOnTop(true);

// macOS 的编辑快捷键（⌘V/⌘C/⌘A 等）由主菜单的 keyEquivalent 派发到第一响应者——
// 菜单栏伴侣默认没有应用菜单，WKWebView 输入框里粘贴/全选全废（Electron 同款坑）。
// role 项走原生 NSResponder selector（paste:/copy:…），webview 零 JS 介入；
// 隐藏条目补 Ctrl+V → paste，兼容非 mac 习惯的按法。
setApplicationMenu([
  { label: "Murmur", submenu: [{ role: "quit", accelerator: "CommandOrControl+Q" }] },
  {
    label: "Edit",
    submenu: [
      { role: "undo", accelerator: "CommandOrControl+Z" },
      { role: "redo", accelerator: "CommandOrControl+Shift+Z" },
      { type: "divider" },
      { role: "cut", accelerator: "CommandOrControl+X" },
      { role: "copy", accelerator: "CommandOrControl+C" },
      { role: "paste", accelerator: "CommandOrControl+V" },
      { role: "selectAll", accelerator: "CommandOrControl+A" },
      { role: "paste", accelerator: "Control+V", hidden: true },
    ],
  },
]);

// 失焦即收起（popover 语义）。记录收起时刻，供托盘点击判竞态。
let hiddenAt = 0;
panel.on("blur", () => {
  hiddenAt = Date.now();
  panel.hide();
});

const tray = new Tray({
  title: "Murmur",
  image: "views://assets/tray-icon.png",
  template: true,
  width: 22,
  height: 22,
});

function updateTrayTitle() {
  const snap = registry.snapshot();
  const waiting = snap.agents.flatMap((a) => a.sessions).filter((s) => s.status === "waiting").length;
  const working = snap.agents.flatMap((a) => a.sessions).filter((s) => s.status === "working").length;
  // 聚合态字形只能用默认文本渲染的几何符号（●/◆）：emoji（如 ⏰）在菜单栏走
  // Apple 彩色渲染，逃出 template 单色体系，会突兀（2026-09 实测）。
  tray.setTitle(waiting > 0 ? `◆ ${waiting}` : working > 0 ? `● ${working}` : "");
}

/** 通知里的人类可读写法：与 mainview AGENT_META 同名，bun 侧独立小表避免跨包依赖。 */
const AGENT_NAMES: Record<string, string> = {
  kimi: "Kimi Code",
  zcode: "ZCode",
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor",
};

// 「轮到你了」通知：waiting 集合只增才发。首个快照作基线——回填建档的旧 waiting
// 是历史残态不是新事件，不该在启动时轰炸通知中心。
let prevWaiting: Set<string> | null = null;
function maybeNotifyWaiting() {
  const snap = registry.snapshot();
  const waiting = new Map(
    snap.agents.flatMap((a) => a.sessions.filter((s) => s.status === "waiting").map((s) => [`${a.agent}:${s.sessionId}`, a.agent])),
  );
  if (prevWaiting === null) {
    prevWaiting = new Set(waiting.keys());
    return;
  }
  const fresh = [...waiting.entries()].filter(([k]) => !prevWaiting!.has(k)).map(([, agent]) => agent);
  prevWaiting = new Set(waiting.keys());
  if (!fresh.length || !registry.getSettings().notifyOnWaiting || panel.isVisible()) return;
  const names = [...new Set(fresh.map((id) => AGENT_NAMES[id] ?? id))];
  try {
    Utils.showNotification({
      title: "Murmur",
      body: `${names.join("、")} 有 ${fresh.length} 个会话轮到你了`,
    });
  } catch {
    // 通知失败不打断主流程。
  }
}

function showPanel() {
  const b = tray.getBounds();
  // 定位以光标所在屏为准：多屏/全屏 Space 下 tray.getBounds() 可能返回另一块屏
  // 的菜单栏坐标（flow-desktop 同款教训）；光标在点托盘时必处目标屏。
  // AppKit bounds 是主屏左下原点全局坐标 → 左上原点逻辑坐标：x 同轴、
  // y_tl = 主屏高 - b.y。
  const primary = Screen.getPrimaryDisplay();
  const cursor = Screen.getCursorScreenPoint();
  const display =
    Screen.getAllDisplays().find(
      (d) =>
        cursor.x >= d.bounds.x &&
        cursor.x < d.bounds.x + d.bounds.width &&
        cursor.y >= d.bounds.y &&
        cursor.y < d.bounds.y + d.bounds.height,
    ) ?? primary;
  if (b && b.width > 0 && primary.bounds.height > 0 && display.bounds.width > 0) {
    const x = Math.min(
      Math.max(display.bounds.x + 8, Math.round(b.x + b.width / 2 - PANEL_WIDTH / 2)),
      display.bounds.x + display.bounds.width - PANEL_WIDTH - 8,
    );
    const y = Math.max(display.bounds.y + 6, Math.round(primary.bounds.height - b.y + 6));
    panel.setPosition(x, y);
  }
  panel.show();
}

function togglePanel() {
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  // blur 与 tray-clicked 竞态：面板刚因失焦收起时，本次托盘点击就是"关闭"，
  // 不再重开（否则点托盘永远关不上面板）。
  if (hiddenAt > 0 && Date.now() - hiddenAt < 200) {
    hiddenAt = 0;
    return;
  }
  showPanel();
}

// 左键 = 面板开关；操作（上报/退出）都在面板底栏。不放托盘原生菜单：
// NSStatusItem 挂了 menu 后 AppKit 会接管点击弹菜单，左键直接开关面板的
// 交互就废了（2026-09 实测）。
tray.on("tray-clicked", () => togglePanel());

registry.onChange(() => {
  updateTrayTitle();
  maybeNotifyWaiting();
  try {
    panel.webview.rpc?.send.snapshot(registry.snapshot());
  } catch {
    // 面板尚未加载完成时忽略推送失败。
  }
});

// Dock 图标按设置应用（默认隐藏——纯菜单栏伴侣）。
applyDockIcon(registry.getSettings().showDockIcon);

await registry.start();
updateTrayTitle();
if (appBundlePath()) console.log("[murmur] bundle:", appBundlePath());
console.log("[murmur] started — ingest endpoint:", registry.ingestEndpoint());
