/**
 * SyncService：技能与 MCP 同步引擎。
 *
 * 以 ~/.murmur/ 为唯一源（skills/<name>/ 包目录 + mcp.json 的 mcpServers），
 * syncAll 把条目同步进各 agent 本机目录（sync/targets.ts 真值表）；
 * overview() 是纯读盘点，产出条目 × agent 的状态矩阵喂管理台「技能」页。
 *
 * 铁律沿用 hook 安装先例：只写我方条目、他人条目原样保留、原子写、
 * 任何失败静默降级不 crash（单个目标记 error 进盘点继续下一个）。
 *
 * 归属判别全靠落盘证据，不信内存：
 *   skills —— 软链化（链目标解析后落在 ~/.murmur/skills 内即我方）；v1 的
 *            .murmur-managed 实体拷贝检出即 stale，下一轮 syncAll 迁移成软链；
 *   MCP    —— sync-state.json 只在写成功后更新 mcpKeys，天然表达「我写过哪些 key」。
 * 同名不默认覆盖：目标在位但非我方 → 冲突只盘点不入写面，等宿主带
 * syncAll(overwrite) 显式裁决回来（覆盖=先废纸篓再挂链）。
 * 清理语义：目标侧我方软链在「源删除」或「条目被 disable」时摘除（unlink 链本体，
 * 不动源）；per-agent sync 闸关闭时只停写不清理（用户目录不留孤儿由
 * 「关同步不回删」这条换）。
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { MURMUR_HOME } from '../paths';
import { flagEnabled, type MurmurSettings } from '../settings';
import type {
  AgentId,
  McpSaveResult,
  McpTestResult,
  SkillDeleteResult,
  SkillImportResult,
  SkillSyncCell,
  SyncConflict,
  SyncItemState,
  SyncOverview,
} from '../types';
import { mergeMcpJson, mergeMcpTomlText, mcpEntryState } from './mcp';
import { probeMcpServer } from './probe';
import {
  importSkills as importSourceSkills,
  listSourceSkills,
  readSourceMcp,
  saveSourceMcp,
  SKILL_MARKER,
  SKILLSHARE_MANIFEST,
  sourceMcpEntry,
  type SourceSkill,
} from './source';
import { loadSyncState, saveSyncState, type SyncState } from './state';
import { allSyncTargets, type McpTarget, type SyncTarget } from './targets';

/** SyncService 装配依赖：settings/installed 由宿主注入（desktop 传 registry 读口）。 */
export interface SyncServiceDeps {
  /** murmur 数据根（缺省 MURMUR_HOME；测试钉沙箱）。 */
  home?: string;
  /** 当前设置读口（同步三键：sync 闸 / disabledSkills / disabledMcp）。 */
  settings: () => MurmurSettings;
  /** agent 安装态读口（未安装的跳过写面，盘点标 off）。 */
  installed: (agent: AgentId) => boolean;
  /** 冲突裁决「覆盖」时把在位他人目录进废纸篓（desktop 注 Utils.moveToTrash；缺席退化 rmSync）。 */
  trash?: (path: string) => boolean;
  /** 设置持久化回调（desktop 注入 registry.updateSettings 使开关变更即时广播）。 */
  save?: (next: MurmurSettings) => void | Promise<void>;
}


/** 单元格合并的优先级序（同一 agent 多目录/多文件时取最需关注态）。 */
const STATE_RANK: SyncItemState[] = ['error', 'conflict', 'stale', 'absent', 'external', 'off', 'synced'];

export class SyncService {
  private readonly home: string;
  private readonly settings: () => MurmurSettings;
  private readonly installed: (agent: AgentId) => boolean;
  private readonly trash: ((path: string) => boolean) | undefined;
  private readonly save: (next: MurmurSettings) => void | Promise<void>;

  constructor(deps: SyncServiceDeps) {
    this.home = deps.home ?? MURMUR_HOME;
    this.settings = deps.settings;
    this.installed = deps.installed;
    this.trash = deps.trash;
    this.save = deps.save ?? (() => {});
  }

  private get skillsDir() {
    return join(this.home, 'skills');
  }

  private get mcpPath() {
    return join(this.home, 'mcp.json');
  }

  /**
   * 全量同步：先写后盘点。写面按目标去重（~/.agents/skills 这类共享目录只写一次），
   * 跳过未安装/监听关/同步关的 agent；最后 overview() 重读盘面出矩阵。
   * overwrite 是宿主带回的同名冲突裁决清单——只放行点名目标，未点名的照常跳过
   * （同名不默认覆盖，用户不批就不动他人产物）。
   */
  async syncAll(overwrite: SyncConflict[] = []): Promise<SyncOverview> {
    const settings = this.settings();
    const skills = listSourceSkills(this.skillsDir);
    const mcpSource = readSourceMcp(this.mcpPath);
    const disabledSkills = new Set(settings.disabledSkills);
    const disabledMcp = new Set(settings.disabledMcp);
    const enabledSkills = skills.filter((s) => s.hasSkillMd && !disabledSkills.has(s.name));
    const enabledSkillNames = new Set(enabledSkills.map((s) => s.name));
    const desiredMcp: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mcpSource)) if (!disabledMcp.has(k)) desiredMcp[k] = v;

    // 裁决按 kind 分箱：技能按目标路径（软链占位全路径），MCP 按配置文件路径→键名集。
    const takeSkillPaths = new Set(overwrite.filter((c) => c.kind === 'skill').map((c) => c.path));
    const takeMcp = new Map<string, Set<string>>();
    for (const c of overwrite) {
      if (c.kind !== 'mcp') continue;
      const set = takeMcp.get(c.path) ?? new Set<string>();
      set.add(c.name);
      takeMcp.set(c.path, set);
    }

    const targets = allSyncTargets();
    const state = loadSyncState(this.home);

    // 写面枚举：目录/文件双去重（kimi 与 cursor 共用 ~/.agents/skills 等），记归属 agent 供字段补丁。
    const skillsDirs = new Map<string, AgentId>();
    const mcpFiles = new Map<string, { target: McpTarget; agent: AgentId }>();
    for (const agent of Object.keys(targets) as AgentId[]) {
      if (!this.installed(agent)) continue;
      if (!flagEnabled(settings.agents, agent)) continue;
      if (!flagEnabled(settings.sync, agent)) continue;
      for (const dir of targets[agent].skillsDirs) {
        if (!skillsDirs.has(dir)) skillsDirs.set(dir, agent);
      }
      for (const t of targets[agent].mcp) {
        if (!mcpFiles.has(t.path)) mcpFiles.set(t.path, { target: t, agent });
      }
    }

    for (const [dir] of skillsDirs) this.writeSkillsDir(dir, enabledSkills, enabledSkillNames, takeSkillPaths);
    for (const [, t] of mcpFiles) this.writeMcpFile(t.target, t.agent, desiredMcp, state, takeMcp.get(t.target.path));
    try {
      saveSyncState(state, this.home);
    } catch {
      // 账本写失败只影响归属记忆（下轮按全文重写兜底），不阻断盘点。
    }
    return this.overview();
  }

  /** 纯读盘点：条目 × agent 的状态矩阵 + 冲突裁决清单，不做任何写操作。 */
  overview(): SyncOverview {
    const settings = this.settings();
    const skills = listSourceSkills(this.skillsDir);
    const mcpSource = readSourceMcp(this.mcpPath);
    const disabledSkills = new Set(settings.disabledSkills);
    const disabledMcp = new Set(settings.disabledMcp);
    const state = loadSyncState(this.home);
    const targets = allSyncTargets();
    const conflicts: SyncConflict[] = [];

    return {
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        hasSkillMd: s.hasSkillMd,
        disabled: disabledSkills.has(s.name),
        cells: (Object.keys(targets) as AgentId[]).map((agent) =>
          this.skillCell(agent, targets[agent], s, settings, conflicts),
        ),
      })),
      mcps: Object.keys(mcpSource)
        .sort()
        .map((name) => ({
          name,
          disabled: disabledMcp.has(name),
          cells: (Object.keys(targets) as AgentId[]).map((agent) =>
            this.mcpCell(agent, targets[agent], name, mcpSource[name], state, settings, conflicts),
          ),
        })),
      conflicts,
      scannedAt: Date.now(),
    };
  }

  /** 条目级启停：写 settings.disabledSkills 后经注入 save 持久化，再全量同步。 */
  async setSkillEnabled(name: string, enabled: boolean): Promise<SyncOverview> {
    const s = this.settings();
    const list = s.disabledSkills.filter((n) => n !== name);
    if (!enabled) list.push(name);
    await this.save({ ...s, disabledSkills: list });
    return this.syncAll();
  }

  /** 条目级启停（MCP）：禁用即不写；曾写入的我方 key 在下一轮 syncAll 被剔除。 */
  async setMcpEnabled(name: string, enabled: boolean): Promise<SyncOverview> {
    const s = this.settings();
    const list = s.disabledMcp.filter((n) => n !== name);
    if (!enabled) list.push(name);
    await this.save({ ...s, disabledMcp: list });
    return this.syncAll();
  }

  /**
   * 删除源技能包：目录进废纸篓（trash 回调由宿主注入），随后 syncAll 顺带清理
   * 各目标侧的我方拷贝。MCP 条目不走这里——禁用即不写入（v1 无删 MCP 的 UI 入口）。
   */
  async deleteSkill(name: string, trash: (path: string) => boolean): Promise<SkillDeleteResult> {
    const dir = join(this.skillsDir, name);
    if (!existsSync(dir)) return { ok: false, error: '源里没有这个技能' };
    let ok = false;
    try {
      ok = trash(dir);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!ok) return { ok: false, error: '移到废纸篓失败' };
    return { ok: true, overview: await this.syncAll() };
  }

  /**
   * 新建/更新源 MCP 条目：defText 是含 mcpServers 键的整段 JSON（编辑器原文）。
   * origName 是编辑前键名（新建传 null）——改名/清空即删旧键。保存成功后 syncAll。
   */
  async saveMcp(origName: string | null, defText: string): Promise<McpSaveResult> {
    const r = saveSourceMcp(origName, defText, this.mcpPath);
    if (!r.ok) return r;
    return { ok: true, overview: await this.syncAll() };
  }

  /**
   * 探测 MCP：name 探源里已存条目；defText 探草稿（含 mcpServers 的整段 JSON——
   * 编辑器一次测多键；单条裸 def 也兼容）。恒返回数组（多键逐条出结果）。
   */
  async testMcp(name?: string, defText?: string): Promise<McpTestResult[]> {
    const targets: [string | undefined, unknown][] = [];
    if (defText !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(defText);
      } catch {
        return [{ ok: false, latencyMs: 0, error: 'JSON 解析失败' }];
      }
      // 兼容两种输入：{"mcpServers":{…}}（编辑器原文）或单条裸 def。
      const wrapped =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'mcpServers' in parsed
          ? parsed.mcpServers
          : undefined;
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        for (const [k, v] of Object.entries(wrapped)) targets.push([k, v]);
      } else {
        targets.push([name, parsed]);
      }
    } else if (name !== undefined) {
      const def = sourceMcpEntry(name, this.mcpPath);
      if (def === null) return [{ name, ok: false, latencyMs: 0, error: '源里没有这个条目' }];
      targets.push([name, def]);
    } else {
      return [{ ok: false, latencyMs: 0, error: '缺 name 或 def' }];
    }
    // 逐条探测串行跑——stdio 型 spawn 进程，并发探测徒增资源（编辑器一次也就几条）。
    const out: McpTestResult[] = [];
    for (const [n, def] of targets) {
      const r = await probeMcpServer(def);
      out.push(n === undefined ? r : { ...r, name: n });
    }
    return out;
  }

  /** 读单条源 MCP 定义（编辑回填；可能含 env/headers 里的凭据，逐条按需取不进快照）。 */
  mcpDef(name: string): Record<string, unknown> | null {
    return sourceMcpEntry(name, this.mcpPath);
  }

  /** 导入本地目录为源技能包（≤3 层扫 SKILL.md），随后全量同步。 */
  async importSkills(srcDir: string): Promise<SkillImportResult & { overview: SyncOverview }> {
    const r = importSourceSkills(srcDir, this.skillsDir);
    return { ...r, overview: await this.syncAll() };
  }

  /**
   * 单目录写面：缺失条目挂软链（链向源目录），漂移/旧版拷贝重挂，
   * 清理源已删或已禁用的我方软链与旧拷贝。同名他人占位只盘点不碰——
   * 除非 take 点名放行（覆盖=先废纸篓再挂链）。
   */
  private writeSkillsDir(
    dir: string,
    enabledSkills: SourceSkill[],
    enabledNames: Set<string>,
    take: ReadonlySet<string>,
  ): void {
    try {
      if (existsSync(join(dir, SKILLSHARE_MANIFEST))) return; // skillshare 管辖——整目录只读。
      // 目录缺席且无可写条目时别空建（否则光跑 syncAll 就给用户目录留空壳）。
      if (!existsSync(dir)) {
        if (!enabledSkills.length) return;
        mkdirSync(dir, { recursive: true });
      }
      // 清理：在场我方产物（指向源根的软链 / 带 marker 的旧拷贝）若源已删/已禁用 → 摘除。
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (enabledNames.has(ent.name)) continue;
        const p = join(dir, ent.name);
        if (this.isOurLink(p) || existsSync(join(p, SKILL_MARKER))) rmSync(p, { recursive: true });
      }
      for (const s of enabledSkills) {
        const dest = join(dir, s.name);
        const linkTo = this.linkTarget(dest);
        if (linkTo === s.path) continue; // 软链已在且指对源——免重写。
        if (linkTo !== null) {
          // 软链在但指偏：我方旧链直接重挂；他人链是冲突，点名裁决才重挂。
          if (this.isOurLink(dest) || take.has(dest)) {
            unlinkSync(dest);
            symlinkSync(s.path, dest, process.platform === 'win32' ? 'junction' : 'dir');
          }
          continue;
        }
        if (existsSync(dest)) {
          if (this.readMarkerSig(dest) !== null) {
            rmSync(dest, { recursive: true }); // v1 旧拷贝自动迁移成软链（我方产物，unlink 粒度等同）。
          } else if (take.has(dest)) {
            this.displace(dest); // 裁决放行的他人同名目录——废纸篓后可回滚。
          } else {
            continue; // 他人同名目录——conflict 留给盘点，不碰。
          }
        }
        symlinkSync(s.path, dest, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } catch {
      // 目录级失败（权限/并发删）跳过：盘点行如实呈现，下轮自愈。
    }
  }

  /** dest 是软链时返回解析后的绝对链目标，否则/断链外返回 null。 */
  private linkTarget(dest: string): string | null {
    try {
      if (!lstatSync(dest).isSymbolicLink()) return null;
      return resolve(dest, '..', readlinkSync(dest));
    } catch {
      return null; // dest 不存在——ENOENT 即「无占位」。
    }
  }

  /** 归属判定：软链且链目标解析后落在源根内（等于我方写过的链接；指源根的他人手作链同权）。 */
  private isOurLink(dest: string): boolean {
    const t = this.linkTarget(dest);
    return t !== null && resolve(this.skillsDir) === resolve(t, '..');
  }

  /** 把在位的他人产物挪走腾位：优先废纸篓（可回滚），宿主没注 trash 才 rmSync 直删。 */
  private displace(dest: string): void {
    try {
      if (this.trash?.(dest)) return;
    } catch {
      // 废纸篓失败不该把占位留在原地冒充已处理——退化直删。
    }
    rmSync(dest, { recursive: true });
  }

  /** marker 读取：不存在→null（他人目录）；存在→行尾 sig（或空串表示旧格式）。 */
  private readMarkerSig(dest: string): string | null {
    try {
      const text = readFileSync(join(dest, SKILL_MARKER), 'utf8');
      const m = /^murmur-sync v1(?: (\w+))?\s*$/m.exec(text.trim());
      return m ? (m[1] ?? '') : '';
    } catch {
      return null;
    }
  }

  /** 单文件 MCP 写面：按 schema 分发 merge；take=裁决放行的冲突键名集；损坏 JSON/TOML 记 error 不碰。 */
  private writeMcpFile(
    target: McpTarget,
    agent: AgentId,
    desired: Record<string, unknown>,
    state: SyncState,
    take?: ReadonlySet<string>,
  ): void {
    try {
      const ours = new Set(state.mcpKeys[target.path] ?? []);
      if (target.schema === 'toml') {
        const text = existsSync(target.path) ? readFileSync(target.path, 'utf8') : '';
        const merged = mergeMcpTomlText(text, desired, ours, take);
        if (merged.result.changed) this.atomicWrite(target.path, merged.text);
        state.mcpKeys[target.path] = merged.result.written;
        return;
      }
      let cfg: Record<string, unknown> = {};
      if (existsSync(target.path)) {
        try {
          const parsed = JSON.parse(readFileSync(target.path, 'utf8')) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
          else return; // 顶层非对象——不当 mcp 配置碰。
        } catch {
          return; // 损坏不碰（install.ts 同款），盘点侧记 error 由 overview 呈现。
        }
      }
      const merged = mergeMcpJson(cfg, target.schema, agent, desired, ours, take);
      if (merged.result.changed) this.atomicWrite(target.path, JSON.stringify(merged.cfg, null, 2) + '\n');
      state.mcpKeys[target.path] = merged.result.written;
    } catch {
      // 写失败（权限/磁盘）跳过该目标；state.mcpKeys 保留旧归属集，下轮再收敛。
    }
  }

  /** 原子写：tmp + chmod 0600 + rename（settings.ts 同款口径）。 */
  private atomicWrite(path: string, content: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.murmur-tmp`;
    writeFileSync(tmp, content);
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  /** 盘点单元格（skill × agent）：多目录取 STATE_RANK 最需关注态；冲突逐目标入 out 裁决清单。 */
  private skillCell(
    agent: AgentId,
    target: SyncTarget,
    skill: SourceSkill,
    settings: MurmurSettings,
    out: SyncConflict[],
  ): SkillSyncCell {
    const off = (detail?: string): SkillSyncCell => ({ agent, state: 'off', detail });
    if (!target.skillsDirs.length) return off('该 agent 没有 skills 目录');
    if (!this.installed(agent)) return off('未安装');
    if (!flagEnabled(settings.agents, agent)) return off('监听已关');
    if (!flagEnabled(settings.sync, agent)) return off('同步已关');
    if (!skill.hasSkillMd) return off('缺 SKILL.md');
    if (settings.disabledSkills.includes(skill.name)) return off('已禁用');

    const cells: { state: SyncItemState; detail?: string }[] = [];
    for (const dir of target.skillsDirs) {
      if (existsSync(join(dir, SKILLSHARE_MANIFEST))) {
        cells.push({ state: 'external', detail: `${dir} 由 skillshare 管辖` });
        continue;
      }
      const dest = join(dir, skill.name);
      const linkTo = this.linkTarget(dest);
      if (linkTo !== null) {
        // 软链在位：指对源即 synced；指偏时我方链可重挂、他人链是冲突。
        if (linkTo === skill.path) cells.push({ state: 'synced' });
        else if (this.isOurLink(dest)) cells.push({ state: 'stale', detail: `${dest} 链目标漂移` });
        else {
          cells.push({ state: 'conflict', detail: `${dest} 同名软链指向他处` });
          out.push({ kind: 'skill', name: skill.name, agent, path: dest });
        }
        continue;
      }
      if (existsSync(dest)) {
        if (this.readMarkerSig(dest) !== null) cells.push({ state: 'stale', detail: `${dest} 旧版实体拷贝待迁移` });
        else {
          cells.push({ state: 'conflict', detail: `${dest} 同名目录非我方安装` });
          out.push({ kind: 'skill', name: skill.name, agent, path: dest });
        }
      } else {
        cells.push({ state: 'absent', detail: dir });
      }
    }
    const best = cells.reduce((a, b) => (STATE_RANK.indexOf(a.state) <= STATE_RANK.indexOf(b.state) ? a : b));
    return { agent, state: best.state, detail: best.detail };
  }

  /** 盘点单元格（MCP × agent）：多配置文件取最需关注态；冲突逐文件入 out 裁决清单。 */
  private mcpCell(
    agent: AgentId,
    target: SyncTarget,
    name: string,
    rawDef: unknown,
    state: SyncState,
    settings: MurmurSettings,
    out: SyncConflict[],
  ): SkillSyncCell {
    const off = (detail?: string): SkillSyncCell => ({ agent, state: 'off', detail });
    if (!target.mcp.length) return off('该 agent 没有 MCP 配置面');
    if (!this.installed(agent)) return off('未安装');
    if (!flagEnabled(settings.agents, agent)) return off('监听已关');
    if (!flagEnabled(settings.sync, agent)) return off('同步已关');
    if (settings.disabledMcp.includes(name)) return off('已禁用');

    const cells: { state: SyncItemState; detail?: string }[] = [];
    for (const t of target.mcp) {
      let text: string | null = null;
      try {
        text = existsSync(t.path) ? readFileSync(t.path, 'utf8') : null;
      } catch {
        cells.push({ state: 'error', detail: `${t.path} 读取失败` });
        continue;
      }
      if (text !== null && t.schema !== 'toml') {
        try {
          JSON.parse(text);
        } catch {
          cells.push({ state: 'error', detail: `${t.path} JSON 损坏` });
          continue;
        }
      }
      const ours = new Set(state.mcpKeys[t.path] ?? []);
      const st = mcpEntryState(text, t, agent, name, rawDef, ours);
      if (st === 'conflict') out.push({ kind: 'mcp', name, agent, path: t.path });
      cells.push({
        state: st,
        detail: st === 'conflict' ? `${t.path} 同名条目值不同` : st === 'absent' ? t.path : st === 'stale' ? `${t.path} 待重写` : undefined,
      });
    }
    const best = cells.reduce((a, b) => (STATE_RANK.indexOf(a.state) <= STATE_RANK.indexOf(b.state) ? a : b));
    return { agent, state: best.state, detail: best.detail };
  }
}
