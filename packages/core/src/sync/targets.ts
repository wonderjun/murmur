/**
 * 技能/MCP 同步目标真值表：每个 agent 接收我方条目的目录与配置文件。
 *
 * 数据源唯一（~/.murmur/skills/<name>/ + ~/.murmur/mcp.json 的 mcpServers），
 * 本表只管「写去哪」。全部路径走 MURMUR_<AGENT>_SKILLS_DIR / MURMUR_<AGENT>_MCP_CONFIG
 * env 覆盖（测试沙箱与非常规安装用）；agent 数据根复用 paths.ts 的解析（其自身
 * env 覆盖也生效）。env 在函数体内读——paths.ts 同款约定，测试可运行时覆盖。
 *
 * 来源可信度分档：✓官方文档 / ◐生态惯例（skillshare target、真机空壳文件）/
 * ✗未找到（minimax 用户级 skills——官方只确认 .builtin-skills 与 plugin 内 skills，
 * skillsDirs 留空，确认后单行补）。
 *
 * skillshare 共处：目标 skills 目录根有 .skillshare-manifest.json 即视为其管辖，
 * engine 只读不写、盘点标 external——同一批 skills 被两家写会互相覆盖成脏副本。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { ompAgentDirs } from '../agents/omp/files';
import { agentPaths } from '../paths';
import type { AgentId } from '../types';

/** MCP 配置文件的写法分档：mcpServers 顶层键 / zcode 的 mcp.servers / opencode 的 mcp 键 / TOML 表段。 */
export type McpSchema = 'mcpServers' | 'zcode' | 'opencode' | 'toml';

/** 一个 MCP 配置文件目标。 */
export interface McpTarget {
  path: string;
  schema: McpSchema;
}

/** 一个 agent 的全部同步目标：skills 目录清单 + MCP 配置文件清单。 */
export interface SyncTarget {
  skillsDirs: string[];
  mcp: McpTarget[];
}

const home = homedir();

/** 通用 skills 目录（多 agent 共用约定 ~/.agents/skills）：写面前按目录去重。 */
function sharedSkillsDir(): string {
  return process.env.MURMUR_AGENTS_SKILLS_DIR ?? join(home, '.agents', 'skills');
}

/** env 名用大写前缀（claude-code → MURMUR_CLAUDE_CODE_*）。 */
export function syncTargets(agent: AgentId): SyncTarget {
  const paths = agentPaths(agent);
  switch (agent) {
    case 'kimi':
      // ✓官方：KIMI_CODE_HOME 下 skills/ + 通用 ~/.agents/skills 都扫；mcp.json 顶层 mcpServers。
      return {
        skillsDirs: [process.env.MURMUR_KIMI_SKILLS_DIR ?? join(paths.home, 'skills'), sharedSkillsDir()],
        mcp: [{ path: process.env.MURMUR_KIMI_MCP_CONFIG ?? join(paths.home, 'mcp.json'), schema: 'mcpServers' }],
      };
    case 'zcode':
      // ✓官方：~/.zcode/skills；user 级 MCP 在 cli/config.json 的 mcp.servers（schema zcode）。
      return {
        skillsDirs: [process.env.MURMUR_ZCODE_SKILLS_DIR ?? join(paths.home, 'skills')],
        mcp: [{ path: process.env.MURMUR_ZCODE_MCP_CONFIG ?? join(paths.home, 'cli', 'config.json'), schema: 'zcode' }],
      };
    case 'opencode': {
      // ◐skillshare 在用 <config>/skills；✓opencode.json 的 mcp 键（v1 直挂 / v2 .servers 嵌套）。
      // config 根 = hookConfig（plugins 目录）的父目录（MURMUR_OPENCODE_CONFIG 覆盖已生效）。
      const cfgRoot = join(paths.hookConfig ?? join(home, '.config', 'opencode'), '..');
      return {
        skillsDirs: [process.env.MURMUR_OPENCODE_SKILLS_DIR ?? join(cfgRoot, 'skills')],
        mcp: [{ path: process.env.MURMUR_OPENCODE_MCP_CONFIG ?? join(cfgRoot, 'opencode.json'), schema: 'opencode' }],
      };
    }
    case 'codex':
      // ◐~/.codex/skills（cursor 官方文档列其为兼容技能目录；codex 自身约定未实锤——marker 写入安全）。
      // ✓config.toml [mcp_servers.<name>] 表（schema toml）。
      return {
        skillsDirs: [process.env.MURMUR_CODEX_SKILLS_DIR ?? join(paths.home, 'skills')],
        mcp: [{ path: process.env.MURMUR_CODEX_MCP_CONFIG ?? join(paths.home, 'config.toml'), schema: 'toml' }],
      };
    case 'cursor':
      // ✓官方：~/.cursor/skills + ~/.agents/skills（另兼容读 ~/.claude/skills、~/.codex/skills——
      // 那两处已被 claude-code/codex 行覆盖，不重复写）。mcp.json 顶层 mcpServers，
      // stdio 条目官方表格标 type:"stdio" 必填——merge 时补。
      return {
        skillsDirs: [process.env.MURMUR_CURSOR_SKILLS_DIR ?? join(paths.home, 'skills'), sharedSkillsDir()],
        mcp: [{ path: process.env.MURMUR_CURSOR_MCP_CONFIG ?? join(paths.home, 'mcp.json'), schema: 'mcpServers' }],
      };
    case 'devin': {
      // ◐<config>/skills（skillshare target）；◐mcp_config.json（真机存在 mcpServers 空壳）。
      // hookConfig 即 ~/.config/devin/config.json——取其父目录作配置根。
      const cfgRoot = join(paths.hookConfig ?? join(home, '.config', 'devin', 'config.json'), '..');
      return {
        skillsDirs: [process.env.MURMUR_DEVIN_SKILLS_DIR ?? join(cfgRoot, 'skills')],
        mcp: [{ path: process.env.MURMUR_DEVIN_MCP_CONFIG ?? join(cfgRoot, 'mcp_config.json'), schema: 'mcpServers' }],
      };
    }
    case 'qoder':
      // ◐~/.qoder/skills（真机在用）；◐mcp.json（真机 mcpServers 空壳）。
      return {
        skillsDirs: [process.env.MURMUR_QODER_SKILLS_DIR ?? join(paths.home, 'skills')],
        mcp: [{ path: process.env.MURMUR_QODER_MCP_CONFIG ?? join(paths.home, 'mcp.json'), schema: 'mcpServers' }],
      };
    case 'minimax':
      // ✗用户级 skills 目录官方未文档化（只确认 .builtin-skills 与 plugin 包内 skills）——不写。
      // ✓~/.minimax/mcp.json 顶层 mcpServers；type 必填 stdio/streamable-http/sse（merge 时补）。
      return {
        skillsDirs: process.env.MURMUR_MINIMAX_SKILLS_DIR ? [process.env.MURMUR_MINIMAX_SKILLS_DIR] : [],
        mcp: [{ path: process.env.MURMUR_MINIMAX_MCP_CONFIG ?? join(paths.home, 'mcp.json'), schema: 'mcpServers' }],
      };
    case 'omp': {
      // ✓官方 mcp-config.md：每个 agent 目录（默认 + 命名 profile）下 skills/ 与 mcp.json 各一份，
      // profile 隔离；枚举复用 agents/omp/files.ts 的 ompAgentDirs（与清理页同一目录全集）。
      const dirs = ompAgentDirs();
      const skillsOverride = process.env.MURMUR_OMP_SKILLS_DIR;
      const mcpOverride = process.env.MURMUR_OMP_MCP_CONFIG;
      return {
        skillsDirs: skillsOverride ? [skillsOverride] : dirs.map((d) => join(d, 'skills')),
        mcp: mcpOverride
          ? [{ path: mcpOverride, schema: 'mcpServers' }]
          : dirs.map((d) => ({ path: join(d, 'mcp.json'), schema: 'mcpServers' as const })),
      };
    }
    case 'claude-code':
      // ✓~/.claude/skills；◐~/.claude.json 顶层 mcpServers——`claude mcp add --scope user` 惯写处。
      // 注意：~/.claude.json 是用户家目录文件，不随 CLAUDE_CONFIG_DIR（数据根）搬迁。
      return {
        skillsDirs: [process.env.MURMUR_CLAUDE_CODE_SKILLS_DIR ?? join(paths.home, 'skills')],
        mcp: [{ path: process.env.MURMUR_CLAUDE_CODE_MCP_CONFIG ?? join(home, '.claude.json'), schema: 'mcpServers' }],
      };
  }
}

/** 全部 agent 的同步目标表（盘点/写面共用枚举顺序）。 */
export function allSyncTargets(): Record<AgentId, SyncTarget> {
  return {
    kimi: syncTargets('kimi'),
    zcode: syncTargets('zcode'),
    opencode: syncTargets('opencode'),
    codex: syncTargets('codex'),
    cursor: syncTargets('cursor'),
    devin: syncTargets('devin'),
    qoder: syncTargets('qoder'),
    minimax: syncTargets('minimax'),
    omp: syncTargets('omp'),
    'claude-code': syncTargets('claude-code'),
  };
}
