/**
 * 会话宿主 app 唤起：把会话真正运行在里面的应用唤到台前。
 *
 * 两跳解析：
 *   ① 进程祖先链——按 agent 进程模式筛 ps 表候选，一次 lsof（-d cwd,txt）
 *      同时取候选 cwd（会话归属匹配）与链上各 pid 的真实可执行路径
 *      （launchd 拉起的 app 主进程 argv 是裸名没路径，必须走 txt fd），
 *      沿 ppid 向上找首个命中 .app/Contents/MacOS/ 的祖先；
 *   ② 静态 bundle 兜底——各 agent 已知 .app 标识（open -b → open -a 名解析），
 *      兜「app 装了但进程未起」与无进程态（ended/stale 会话、云端会话）。
 *
 * 只做激活不传 cwd：open -a <终端> <dir> 会新开窗口，语义跑偏。外部命令经
 * 注入的 run() 执行（index.ts 以 Bun.spawn 实现），本模块纯 TS 可测。
 */

import type { AgentId } from "../../../../packages/core/src/index";

/** 一次外部命令的结果；实现方负责超时兜底（fail 返回非零 code）。 */
export type RunCmd = (argv: string[]) => Promise<{ code: number; stdout: string }>;

/** 唤起结果：app 为激活的 .app 显示名（如 "ZCode"/"Ghostty"），供 UI 反馈。 */
export interface FocusAppResult {
  ok: boolean;
  app?: string;
}

/** `ps axww -o pid=,ppid=,args=` 一行。comm 不取——列宽截断且 argv 已含全路径。 */
export interface ProcRow {
  pid: number;
  ppid: number;
  args: string;
}

/** 各 agent 进程匹配模式（args 全文搜，词边界防 CursorUIViewService 类误伤）。 */
const PROC_PATTERNS: Record<AgentId, RegExp> = {
  kimi: /\bkimi\b/i,
  zcode: /\bzcode\b/i,
  opencode: /\bopencode\b/i,
  codex: /\bcodex\b/i,
  cursor: /\bcursor(?:-agent)?\b/i,
  devin: /\bdevin\b/i,
  qoder: /\bqoder\b/i,
  minimax: /\b(?:mcode|mavis|minimax)\b/i,
  omp: /\b(?:omp|oh-my-pi)\b/i,
};

/** 静态兜底条目：bundleId 走 open -b，name 走 open -a 按 LaunchServices 名解析。 */
interface FallbackApp {
  bundleId?: string;
  name?: string;
}

/**
 * 静态兜底表：本机实测 bundle id 为主，末位 open -a 名解析。
 * codex 无专属 app（CLI/IDE 插件形态）——无兜底，唤起失败回 ok:false。
 */
const FALLBACK_APPS: Record<AgentId, Array<FallbackApp>> = {
  kimi: [{ bundleId: "com.kimi.code.desktop", name: "Kimi Code" }],
  zcode: [{ bundleId: "dev.zcode.app", name: "ZCode" }],
  opencode: [{ bundleId: "ai.opencode.desktop", name: "OpenCode" }],
  codex: [],
  cursor: [{ name: "Cursor" }],
  devin: [{ bundleId: "com.exafunction.windsurf", name: "Devin" }],
  qoder: [
    { bundleId: "com.qoder.app", name: "Qoder" },
    { bundleId: "com.qoder.ide", name: "Qoder IDE" },
  ],
  minimax: [{ bundleId: "com.minimax.agent.cn", name: "MiniMax Code" }],
  // omp 是终端 CLI 无专属 app——祖先链命中宿主终端；静态兜底同 codex 置空。
  omp: [],
};

/** 喂给 lsof 的候选上限与链上 pid 总上限（-p 逗号清单长度保护）。 */
const CANDIDATE_CAP = 8;
const LSOF_PID_CAP = 256;

/** 解析 `ps axww -o pid=,ppid=,args=`：前两 token 是 pid/ppid，其余整串为 args。 */
export function parsePsTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? "" });
  }
  return rows;
}

/** `lsof -Fn` 的两张产物表：fd=cwd → 工作目录；fd=txt → 可执行路径（每 pid 取首条）。 */
export interface LsofMaps {
  cwd: Map<number, string>;
  exe: Map<number, string>;
}

/** 解析 `lsof -a -p <pids> -d cwd,txt -Fn`：p<pid> 行后 f<fd>/n<path> 字段对。 */
export function parseLsof(stdout: string): LsofMaps {
  const maps: LsofMaps = { cwd: new Map(), exe: new Map() };
  let pid = 0;
  let fd = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      fd = "";
    } else if (line.startsWith("f")) {
      fd = line.slice(1);
    } else if (line.startsWith("n")) {
      if (fd === "cwd") maps.cwd.set(pid, line.slice(1));
      else if (fd === "txt" && !maps.exe.has(pid)) maps.exe.set(pid, line.slice(1));
      fd = "";
    }
  }
  return maps;
}

/** 取路径文本里最外层 .app 前缀：先定位 /Contents/MacOS/ 再截首个 .app（防 Contents/Frameworks 嵌套）。 */
export function outermostApp(text: string): string | null {
  const m = /(\/[^\n]*?)\/Contents\/MacOS\//.exec(text);
  if (!m) return null;
  const idx = m[1].indexOf(".app");
  return idx >= 0 ? m[1].slice(0, idx + 4) : null;
}

/** .app 路径 → 显示名（basename 去扩展）。 */
export function appName(appPath: string): string {
  const base = appPath.split("/").filter(Boolean).pop() ?? appPath;
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

/** startPid 与其全部祖先的 pid 序（向上到 ppid≤1 或环回为止，≤32 深）。 */
export function chainPids(rows: ProcRow[], startPid: number): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const out: number[] = [];
  let row = byPid.get(startPid);
  while (row && !seen.has(row.pid) && out.length < 32) {
    out.push(row.pid);
    seen.add(row.pid);
    row = row.ppid > 1 ? byPid.get(row.ppid) : undefined;
  }
  return out;
}

/** 沿祖先链找宿主 .app：先查 lsof txt 真实可执行路径（覆盖裸名 argv），再查 args。 */
export function findHostApp(rows: ProcRow[], startPid: number, exes: Map<number, string>): string | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  for (const pid of chainPids(rows, startPid)) {
    const app = outermostApp(exes.get(pid) ?? "") ?? outermostApp(byPid.get(pid)?.args ?? "");
    if (app) return app;
  }
  return null;
}

/** 候选排序：cwd 命中 > 非 .app 内进程（CLI 比 app 本体更能指向宿主）> pid 小。 */
export function sortCandidates(cands: ProcRow[], cwd: string | undefined, cwds: Map<number, string>): ProcRow[] {
  const score = (r: ProcRow) => (cwd && cwds.get(r.pid) === cwd ? 4 : 0) + (outermostApp(r.args) ? 0 : 2);
  return [...cands].sort((a, b) => score(b) - score(a) || a.pid - b.pid);
}

/** 组装 focusApp：run 为外部命令执行器；selfPid 过滤自身进程行。 */
export function createFocusApp(run: RunCmd, selfPid: number = process.pid) {
  return async function focusApp(agent: AgentId, cwd?: string): Promise<FocusAppResult> {
    const ps = await run(["ps", "axww", "-o", "pid=,ppid=,args="]);
    const rows = ps.code === 0 ? parsePsTable(ps.stdout) : [];
    const pattern = PROC_PATTERNS[agent];
    const candidates = rows.filter((r) => r.pid !== selfPid && pattern.test(r.args)).slice(0, CANDIDATE_CAP);

    // 一次 lsof 拿全链数据：cwd 做会话归属匹配，txt 补裸名 argv 的真实可执行路径。
    const chainPidsAll = [...new Set(candidates.flatMap((c) => chainPids(rows, c.pid)))].slice(0, LSOF_PID_CAP);
    let maps: LsofMaps = { cwd: new Map(), exe: new Map() };
    if (chainPidsAll.length > 0) {
      const res = await run(["lsof", "-a", "-p", chainPidsAll.join(","), "-d", "cwd,txt", "-Fn"]);
      if (res.code === 0) maps = parseLsof(res.stdout);
    }

    // ① 祖先链：首个能走到 .app 的候选即激活（CLI → 宿主终端/IDE；本体 → 产品 app）。
    for (const c of sortCandidates(candidates, cwd, maps.cwd)) {
      const app = findHostApp(rows, c.pid, maps.exe);
      if (!app) continue;
      const opened = await run(["open", app]);
      if (opened.code === 0) return { ok: true, app: appName(app) };
    }

    // ② 静态 bundle 兜底：app 装了但进程未起、ended/stale/云端会话。
    for (const fb of FALLBACK_APPS[agent]) {
      if (fb.bundleId && (await run(["open", "-b", fb.bundleId])).code === 0) {
        return { ok: true, app: fb.name ?? fb.bundleId };
      }
      if (fb.name && (await run(["open", "-a", fb.name])).code === 0) {
        return { ok: true, app: fb.name };
      }
    }
    return { ok: false };
  };
}
