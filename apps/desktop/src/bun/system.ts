/**
 * 桌面系统偏好：Dock 图标显隐 + 登录启动（LaunchAgent）。
 *
 * 自启实现：写/删 ~/Library/LaunchAgents/<identifier>.plist，ProgramArguments
 * 走 `open -g <bundle>`（后台打开、不抢焦点）。只写文件、不 launchctl
 * bootstrap——立即加载会当场多起一个实例，违反单实例假设；LaunchAgents
 * 目录下的 plist 由 launchd 在下次登录自动加载。
 *
 * dev channel 下 process.execPath 是 bun 而非 .app 内二进制——自启对 dev
 * 不可控，canLaunchAtLogin() 报 false，UI 据此禁用开关。
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

import { Utils } from "electrobun/main";

import electrobunConfig from "../../electrobun.config";

/** LaunchAgent 标识：与 electrobun.config 的 app.identifier 对齐。 */
const LAUNCH_AGENT_LABEL = electrobunConfig.app.identifier;
const LAUNCH_AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);

/** 当前进程所属的 .app bundle 路径；不在 bundle 里（dev/bun 直跑）返回 null。 */
export function appBundlePath(): string | null {
  const bundle = resolve(dirname(process.execPath), "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/** 自启功能当前是否可操作（仅打包版）。 */
export function canLaunchAtLogin(): boolean {
  return appBundlePath() !== null;
}

/** 自启当前状态：plist 存在即视为开启（我们独占该文件，无第三方改写的判歧需求）。 */
export function isLaunchAtLogin(): boolean {
  return existsSync(LAUNCH_AGENT_PLIST);
}

/** 写/删 LaunchAgent plist。无 bundle（dev）时开启返回 false。 */
export function setLaunchAtLogin(enabled: boolean): boolean {
  if (!enabled) {
    try {
      if (existsSync(LAUNCH_AGENT_PLIST)) unlinkSync(LAUNCH_AGENT_PLIST);
    } catch {
      // 删除失败保守回报现状。
    }
    return isLaunchAtLogin();
  }
  const bundle = appBundlePath();
  if (!bundle) return false;
  // bundle 路径含 & < > 会破坏 plist XML，插值必须转义。
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${esc(LAUNCH_AGENT_LABEL)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/open</string>
		<string>-g</string>
		<string>${esc(bundle)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`;
  try {
    mkdirSync(dirname(LAUNCH_AGENT_PLIST), { recursive: true });
    writeFileSync(LAUNCH_AGENT_PLIST, plist);
  } catch {
    return isLaunchAtLogin();
  }
  return isLaunchAtLogin();
}

/** 应用 Dock 图标显隐（electrobun 直接调 NSApplication activationPolicy）。 */
export function applyDockIcon(show: boolean): void {
  try {
    Utils.setDockIconVisible(show);
  } catch {
    // 非打包环境/native 未起时静默降级。
  }
}

/** 当前 Dock 图标实际状态（失败保守报 true）。 */
export function isDockIconVisible(): boolean {
  try {
    return Utils.isDockIconVisible();
  } catch {
    return true;
  }
}
