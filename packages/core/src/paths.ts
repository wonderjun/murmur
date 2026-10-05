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
        credentials: join(dir, 'v2', 'credentials.json'), // enc:v1 加密读不了；quota 走 BYOK（quota/zcode.ts）。
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
    case 'devin': {
      // Devin CLI/Desktop（Cognition）：数据根 ~/.local/share/devin——cli/sessions.db
      // 是统一会话库（Desktop 经 ACP 桥写同库）、cli/transcripts/*.json 含 final_metrics、
      // cli/session_locks/*.lock 是 PID 锁（陈旧锁多，不当判据）、credentials.toml 的
      // windsurf_api_key 是 CLI 登录凭据（server.codeium.com Connect API 用）。
      // 用户级 hook 配置在 ~/.config/devin/config.json 的 hooks 键（Claude 兼容组形状）。
      const data = process.env.MURMUR_DEVIN_DATA ?? join(localShare, 'devin');
      return {
        home: data,
        sessions: join(data, 'cli'),
        credentials: join(data, 'credentials.toml'),
        hookConfig: process.env.MURMUR_DEVIN_CONFIG ?? join(appData, 'devin', 'config.json'),
      };
    }
    case 'minimax': {
      // MiniMax Code IDE（mcode/mavis，OpenCode fork 的 Electron 壳）：数据根 ~/.minimax，
      // 官方整体搬迁 env 是 MINIMAX_DATA_DIR（旧名 MAVIS_DATA_DIR）。
      // v2/sqlite/runtime-state.sqlite 是唯一真源：local_runtime_sessions 会话注册表、
      // local_runtime_turn_ingress turn 生命周期、local_runtime_token_usage 请求级计量。
      // auth/prod/<region>/<clientId>/auth.json 是 OAuth 凭据（audience agent-backend，
      // 只认 mavis 网关——billing 端点要 web cookie，quota 面缺席）。
      // 官方明示 hooks/plugins 非公开能力面 → 无 hookConfig，pull-only。
      const dir =
        process.env.MURMUR_MINIMAX_HOME ?? process.env.MINIMAX_DATA_DIR ?? process.env.MAVIS_DATA_DIR ?? join(home, '.minimax');
      return {
        home: dir,
        sessions: join(dir, 'v2'),
        credentials: join(dir, 'auth'),
        hookConfig: null,
      };
    }
    case 'qoder': {
      // 新「Qoder」桌面产品（com.qoder.app）：Electron 壳 + 内嵌 qodercli runtime，
      // 与 qodercli/旧 IDE 共用 ~/.qoder 数据根（官方 QODER_CONFIG_DIR 可整体搬迁）。
      // projects/<slug>/<uuid>.jsonl 是会话 transcript（Claude 兼容行格式，带 ISO
      // 时间戳与 message.usage 全量 token）；transcript/ 子目录放委派任务转录。
      // .auth/user 是加密凭据（非明文，读不了——quota 平面临时缺席，BYOK PAT 留 v2）。
      // settings.json 是共享配置（providers 有用户 key），hook 只 merge hooks 子树。
      // app 侧会话台账在 com.qoder.app.stable/main.sqlite，路径由 adapter 自拼。
      const dir = process.env.MURMUR_QODER_HOME ?? process.env.QODER_CONFIG_DIR ?? join(home, '.qoder');
      return {
        home: dir,
        sessions: join(dir, 'projects'),
        credentials: join(dir, '.auth', 'user'),
        hookConfig: join(dir, 'settings.json'),
      };
    }
  }
}
