/**
 * 用户设置：~/.murmur/settings.json，面板设置页的唯一真源。
 *
 * 两级 per-agent 语义：
 *   agents —— 监听总闸。关闭即停 watch、ingest 丢弃该 agent 事件、不拉额度、
 *             面板隐藏；卸载其 hook 由 registry 顺带处理（用户 hook 偏好保留，
 *             重开监听时按 hooks[] 回装）。
 *   hooks  —— push 平面上报开关。关闭即卸载我方 hook 条目（他人条目保留），
 *             观察退回 pull 轮询；开回即重装（merge 幂等）。
 *   两张表缺省值都是 true——「没写过」等于「要」。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MURMUR_HOME } from './paths';
import type { AgentId } from './types';

/** 面板主题：system=跟随 macOS 外观，dark/light=固定。仅 webview 消费。 */
export type ThemePreference = 'system' | 'dark' | 'light';

export interface MurmurSettings {
  /** 登录时启动（写 ~/Library/LaunchAgents plist，desktop 侧执行）。 */
  launchAtLogin: boolean;
  /** Dock 图标显隐：菜单栏伴侣默认藏（accessory 策略，desktop 侧执行）。 */
  showDockIcon: boolean;
  /** 「轮到你了」会话增多时发系统通知，默认关（克制，不打扰）。 */
  notifyOnWaiting: boolean;
  /** 启动时自动给已安装且被监听的 agent 装 hook。 */
  autoInstallHooks: boolean;
  /** 面板主题，默认跟随系统。 */
  theme: ThemePreference;
  /** 自定义 UI 字体名（如 "Maple Mono NF CN"）；空串=系统栈（SF+苹方）。 */
  font: string;
  /** per-agent 监听总闸；缺省 true。 */
  agents: Partial<Record<AgentId, boolean>>;
  /** per-agent hook 上报开关；缺省 true。 */
  hooks: Partial<Record<AgentId, boolean>>;
}

export const DEFAULT_SETTINGS: MurmurSettings = {
  launchAtLogin: false,
  showDockIcon: false,
  notifyOnWaiting: false,
  autoInstallHooks: true,
  theme: 'system',
  font: '',
  agents: {},
  hooks: {},
};

/** 读设置：文件缺失/损坏回默认，逐键缺省合并（未来加键不用迁移）。dir 供测试注入。 */
export function loadSettings(dir = MURMUR_HOME): MurmurSettings {
  const file = join(dir, 'settings.json');
  if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<MurmurSettings>;
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      agents: { ...raw.agents },
      hooks: { ...raw.hooks },
    };
  } catch {
    // 损坏文件不当真源，也不覆写——用户可能正在手改，下次保存自然修复。
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** 写设置：原子写（tmp + rename），0600 与其他 murmur 文件同口径。dir 供测试注入。 */
export function saveSettings(s: MurmurSettings, dir = MURMUR_HOME): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const tmp = `${file}.murmur-tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** per-agent 布尔表读取约定：缺省 true，显式 false 才算关。 */
export function flagEnabled(flags: Partial<Record<AgentId, boolean>> | undefined, agent: AgentId): boolean {
  return flags?.[agent] !== false;
}
