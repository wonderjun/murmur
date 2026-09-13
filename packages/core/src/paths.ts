/**
 * 各 agent 本机数据目录解析器。
 *
 * 负责把 macOS/Linux/Windows 的平台差异收敛成一组常量路径；
 * 全部可通过环境变量覆盖（测试 fixture 与非常规安装用）。
 * 约定：返回的都是「目录」路径；文件路径由各 adapter 自己 join。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentId } from './types';

const home = homedir();
const platform = process.platform;

const appData = platform === 'win32' ? (process.env.APPDATA ?? join(home, 'AppData/Roaming')) : join(home, '.config');
const localShare =
  platform === 'win32' ? (process.env.LOCALAPPDATA ?? join(home, 'AppData/Local')) : join(home, '.local/share');
// macOS 的 Application Support（VS Code 系 IDE 的用户数据根）；其他平台与 appData 同构。
const appSupport = platform === 'darwin' ? join(home, 'Library', 'Application Support') : appData;

/** Murmur 自身数据根（endpoint/spool/db），可用 MURMUR_HOME 覆盖。 */
export const MURMUR_HOME = process.env.MURMUR_HOME ?? join(home, '.murmur');

export interface AgentPaths {
  /** agent 主目录（检测存在性用）。 */
  home: string;
  /** 会话/数据存储目录（pull 平面 watch 目标），无则为 null。 */
  sessions: string | null;
  /** 凭据位置（quota 用），文件或目录。 */
  credentials: string | null;
  /** hook 配置文件（push 平面注入目标），无则为 null。 */
  hookConfig: string | null;
}

/** 每个 agent 的本地布局真值表。 */
export function agentPaths(agent: AgentId): AgentPaths {
  switch (agent) {
    case 'kimi': {
      // 官方数据根：KIMI_CODE_HOME ?? ~/.kimi-code（旧版 ~/.kimi 已迁移）。
      const modern = process.env.KIMI_CODE_HOME ?? join(home, '.kimi-code');
      const dir = process.env.MURMUR_KIMI_HOME ?? modern;
      return {
        home: dir,
        sessions: join(dir, 'sessions'),
        credentials: join(dir, 'credentials'),
        // kimi hooks 已实测（0.41 [[hooks]] 数组表）：pull 仍保留 usage/title/回填。
        hookConfig: join(dir, 'config.toml'),
      };
    }
    case 'zcode': {
      // ZCode（z.ai/GLM 系）：~/.zcode，v2/tasks-index.sqlite 是任务状态表，
      // cli/rollout/model-io-*.jsonl 是模型调用流水（用量真源），
      // cli/config.json 是用户级 hook 配置（hooks.enabled 全局开关 + events 表）。
      const dir = process.env.MURMUR_ZCODE_HOME ?? join(home, '.zcode');
      return {
        home: dir,
        sessions: join(dir, 'v2'),
        credentials: join(dir, 'v2', 'credentials.json'), // enc:v1 加密，暂不可用于 quota。
        hookConfig: join(dir, 'cli', 'config.json'),
      };
    }
    case 'opencode': {
      const data = process.env.MURMUR_OPENCODE_DATA ?? join(localShare, 'opencode');
      const cfg = process.env.MURMUR_OPENCODE_CONFIG ?? join(appData, 'opencode');
      return {
        home: data,
        sessions: data,
        credentials: join(data, 'auth.json'),
        // 插件文件直接落在 plugins/ 目录，hookConfig 指向目录由 adapter 处理。
        hookConfig: join(cfg, 'plugins'),
      };
    }
    case 'codex': {
      const dir = process.env.MURMUR_CODEX_HOME ?? join(home, '.codex');
      return {
        home: dir,
        sessions: join(dir, 'sessions'),
        credentials: join(dir, 'auth.json'),
        hookConfig: join(dir, 'config.toml'),
      };
    }
    case 'cursor': {
      const dir = process.env.MURMUR_CURSOR_HOME ?? join(home, '.cursor');
      return {
        home: dir,
        // pull 真源：projects/<slug>/agent-transcripts/*.jsonl（ai-code-tracking.db 是
        // 代码溯源库、无 token 字段，实测为空弃用）。chats/（CLI 会话）由 adapter 从 home 拼。
        sessions: join(dir, 'projects'),
        // IDE 全局状态库（VS Code 系 state.vscdb 约定），ItemTable 里存 cursorAuth/accessToken。
        credentials:
          process.env.MURMUR_CURSOR_STATE_DB ?? join(appSupport, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        hookConfig: join(dir, 'hooks.json'),
      };
    }
  }
}
