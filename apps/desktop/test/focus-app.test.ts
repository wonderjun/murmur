/**
 * focus-app 单测：ps 表/lsof 输出解析、祖先链宿主 .app 判定、候选排序、
 * createFocusApp 两跳编排（祖先链 → 静态 bundle 兜底）。全走注入假 run，
 * 不碰真机 ps/lsof/open。fixture 按实测形态写：launchd 拉起的 app 主进程
 * argv 是裸名（无路径），宿主判定必须吃 lsof -d txt 的可执行路径。
 */

import { describe, expect, test } from "bun:test";

import {
  appName,
  chainPids,
  createFocusApp,
  findHostApp,
  outermostApp,
  parseLsof,
  parsePsTable,
  sortCandidates,
} from "../src/bun/focus-app";

import type { ProcRow } from "../src/bun/focus-app";

describe("parsePsTable", () => {
  test("pid/ppid/args 三段切分，args 含空格完整保留", () => {
    const rows = parsePsTable(
      [
        "    1     0 /sbin/launchd",
        " 2825     1 ZCode",
        " 2865  2855 zcode-cli",
        "  999  4001 kimi --resume abc def",
        " 垃圾行",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 1, ppid: 0, args: "/sbin/launchd" },
      { pid: 2825, ppid: 1, args: "ZCode" },
      { pid: 2865, ppid: 2855, args: "zcode-cli" },
      { pid: 999, ppid: 4001, args: "kimi --resume abc def" },
    ]);
  });
});

describe("parseLsof", () => {
  test("cwd 与 txt 两类 fd 各入各表，txt 每 pid 只取首条", () => {
    const maps = parseLsof(
      [
        "p2825",
        "fcwd",
        "n/",
        "ftxt",
        "n/Applications/ZCode.app/Contents/MacOS/ZCode",
        "ftxt",
        "n/usr/lib/dyld",
        "p2865",
        "fcwd",
        "n/Users/chen/Documents/flow",
        "ftxt",
        "n/usr/local/bin/zcode-cli",
      ].join("\n"),
    );
    expect(maps.cwd.get(2825)).toBe("/");
    expect(maps.cwd.get(2865)).toBe("/Users/chen/Documents/flow");
    expect(maps.exe.get(2825)).toBe("/Applications/ZCode.app/Contents/MacOS/ZCode");
    expect(maps.exe.get(2865)).toBe("/usr/local/bin/zcode-cli");
  });
});

describe("outermostApp", () => {
  test("主进程路径提取自身 .app", () => {
    expect(outermostApp("/Applications/ZCode.app/Contents/MacOS/ZCode")).toBe("/Applications/ZCode.app");
  });
  test("Helper 嵌套取最外层（Contents/Frameworks/*.app 不冒名）", () => {
    const args =
      "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper --type=gpu-process";
    expect(outermostApp(args)).toBe("/Applications/ZCode.app");
  });
  test("路径含空格的 app（MiniMax Code）同样取外层", () => {
    expect(outermostApp("/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code")).toBe(
      "/Applications/MiniMax Code.app",
    );
  });
  test("参数位的 .app 路径不带 /Contents/MacOS/ 不误判；裸名 argv 无 .app", () => {
    expect(outermostApp("some-cli --app-path=/Applications/ZCode.app/Contents/Resources/app.asar")).toBeNull();
    expect(outermostApp("/usr/bin/zsh -l")).toBeNull();
    expect(outermostApp("ZCode")).toBeNull();
  });
});

describe("appName", () => {
  test("basename 去 .app 扩展", () => {
    expect(appName("/Applications/ZCode.app")).toBe("ZCode");
    expect(appName("/Applications/MiniMax Code.app")).toBe("MiniMax Code");
  });
});

describe("chainPids", () => {
  const rows: ProcRow[] = [
    { pid: 1, ppid: 0, args: "/sbin/launchd" },
    { pid: 4000, ppid: 1, args: "ghostty" },
    { pid: 4001, ppid: 4000, args: "-zsh" },
    { pid: 4002, ppid: 4001, args: "kimi chat" },
  ];
  test("自叶到根的祖先序，不含 launchd", () => {
    expect(chainPids(rows, 4002)).toEqual([4002, 4001, 4000]);
  });
  test("环回/孤儿安全返回", () => {
    const cyclic: ProcRow[] = [
      { pid: 10, ppid: 11, args: "a" },
      { pid: 11, ppid: 10, args: "b" },
    ];
    expect(chainPids(cyclic, 10)).toEqual([10, 11]);
    expect(chainPids(rows, 12345)).toEqual([]);
  });
});

describe("findHostApp", () => {
  // 实测形态：launchd 拉起的 app 主进程 argv 裸名，路径只在 lsof txt fd 里。
  const rows: ProcRow[] = [
    { pid: 1, ppid: 0, args: "/sbin/launchd" },
    { pid: 4000, ppid: 1, args: "ghostty" },
    { pid: 4001, ppid: 4000, args: "-zsh" },
    { pid: 4002, ppid: 4001, args: "kimi chat" },
    { pid: 2825, ppid: 1, args: "ZCode" },
    { pid: 2855, ppid: 2825, args: "zcode-host-local-1" },
    { pid: 2865, ppid: 2855, args: "zcode-cli" },
    { pid: 5000, ppid: 1, args: "tmux new-session" }, // 守护化：祖先即 launchd，无 .app
  ];
  const exes = new Map<number, string>([
    [4000, "/Applications/Ghostty.app/Contents/MacOS/ghostty"],
    [4001, "/bin/zsh"],
    [2825, "/Applications/ZCode.app/Contents/MacOS/ZCode"],
    [2865, "/usr/local/bin/zcode-cli"],
    [5000, "/opt/homebrew/bin/tmux"],
  ]);

  test("CLI 在终端里 → 走到宿主终端 .app（lsof txt 补裸名 argv）", () => {
    expect(findHostApp(rows, 4002, exes)).toBe("/Applications/Ghostty.app");
  });
  test("CLI 挂在产品 app 下 → 走到产品本体", () => {
    expect(findHostApp(rows, 2865, exes)).toBe("/Applications/ZCode.app");
    expect(findHostApp(rows, 2855, exes)).toBe("/Applications/ZCode.app");
  });
  test("args 自带 .app 路径时无 lsof 也命中（helper/手启 argv 带全路径）", () => {
    const withPath: ProcRow[] = [
      { pid: 700, ppid: 1, args: "/Applications/Qoder.app/Contents/MacOS/Qoder" },
      { pid: 701, ppid: 700, args: "qodercli" },
    ];
    expect(findHostApp(withPath, 701, new Map())).toBe("/Applications/Qoder.app");
  });
  test("tmux/ssh 断链在 launchd → null", () => {
    expect(findHostApp(rows, 5000, exes)).toBeNull();
    expect(findHostApp(rows, 12345, exes)).toBeNull();
  });
});

describe("sortCandidates", () => {
  const appProc: ProcRow = { pid: 100, ppid: 1, args: "/Applications/Kimi Code.app/Contents/MacOS/Kimi Code" };
  const cliA: ProcRow = { pid: 200, ppid: 50, args: "kimi chat" };
  const cliB: ProcRow = { pid: 300, ppid: 60, args: "kimi --print hi" };

  test("cwd 命中者居首，同分非 .app 进程优先", () => {
    const cwds = new Map([[300, "/work/proj"]]);
    expect(sortCandidates([appProc, cliA, cliB], "/work/proj", cwds).map((r) => r.pid)).toEqual([300, 200, 100]);
  });
  test("无 cwd 时非 .app 候选优先（CLI 比 app 本体更能指向宿主）", () => {
    expect(sortCandidates([appProc, cliA, cliB], undefined, new Map()).map((r) => r.pid)).toEqual([200, 300, 100]);
  });
});

/** 假 run：按 argv[0] 路由到 ps/lsof/open 固件，记录全部调用。 */
function harness(opts: {
  ps: string;
  lsof?: string;
  /** open 的 exit code 裁决（缺省全成功）。 */
  openOk?: (argv: string[]) => boolean;
  selfPid?: number;
}) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "ps") return { code: 0, stdout: opts.ps };
    if (argv[0] === "lsof") return { code: 0, stdout: opts.lsof ?? "" };
    if (argv[0] === "open") return { code: (opts.openOk?.(argv) ?? true) ? 0 : 1, stdout: "" };
    return { code: 1, stdout: "" };
  };
  return { calls, focusApp: createFocusApp(run, opts.selfPid ?? 99999) };
}

const PS_GARDEN = [
  "    1     0 /sbin/launchd",
  " 2825     1 ZCode",
  " 2855  2825 zcode-host-local-1",
  " 2865  2855 zcode-cli",
  " 4000     1 ghostty",
  " 4001  4000 -zsh",
  " 4002  4001 kimi chat",
].join("\n");

const LSOF_GARDEN = [
  "p2825",
  "fcwd",
  "n/",
  "ftxt",
  "n/Applications/ZCode.app/Contents/MacOS/ZCode",
  "p2855",
  "fcwd",
  "n/Users/chen",
  "p2865",
  "fcwd",
  "n/work/zcode-proj",
  "ftxt",
  "n/usr/local/bin/zcode-cli",
  "p4000",
  "ftxt",
  "n/Applications/Ghostty.app/Contents/MacOS/ghostty",
  "p4002",
  "fcwd",
  "n/work/kimi-proj",
].join("\n");

describe("createFocusApp", () => {
  test("CLI 挂在产品 app 下 → open 产品 .app（lsof txt 补裸名 argv），app 名回传", async () => {
    const { calls, focusApp } = harness({ ps: PS_GARDEN, lsof: LSOF_GARDEN });
    expect(await focusApp("zcode", "/work/zcode-proj")).toEqual({ ok: true, app: "ZCode" });
    expect(calls[calls.length - 1]).toEqual(["open", "/Applications/ZCode.app"]);
  });

  test("CLI 在终端里 → open 宿主终端 .app（不是 agent 产品 app）", async () => {
    const { calls, focusApp } = harness({ ps: PS_GARDEN, lsof: LSOF_GARDEN });
    expect(await focusApp("kimi", "/work/kimi-proj")).toEqual({ ok: true, app: "Ghostty" });
    expect(calls[calls.length - 1]).toEqual(["open", "/Applications/Ghostty.app"]);
  });

  test("cwd 区分同 agent 多宿主：cwd 命中终端候选 > 常驻 app 候选", async () => {
    const ps = [PS_GARDEN, " 5000     1 iTerm2", " 5001  5000 -zsh", " 5002  5001 kimi chat"].join("\n");
    const lsof = [
      LSOF_GARDEN,
      "p5000",
      "ftxt",
      "n/Applications/iTerm.app/Contents/MacOS/iTerm2",
      "p5002",
      "fcwd",
      "n/work/b",
    ].join("\n");
    const { calls, focusApp } = harness({ ps, lsof });
    expect(await focusApp("kimi", "/work/b")).toEqual({ ok: true, app: "iTerm" });
    expect(calls[calls.length - 1]).toEqual(["open", "/Applications/iTerm.app"]);
  });

  test("无进程命中 → 静态 bundle 兜底 open -b，且不发 lsof", async () => {
    const { calls, focusApp } = harness({ ps: "    1     0 /sbin/launchd" });
    expect(await focusApp("opencode", "/work/x")).toEqual({ ok: true, app: "OpenCode" });
    expect(calls).toEqual([
      ["ps", "axww", "-o", "pid=,ppid=,args="],
      ["open", "-b", "ai.opencode.desktop"],
    ]);
  });

  test("bundle 失败逐候选降级：-b 主 id → -a 名 → -b 次 id（qoder 双产品）", async () => {
    const { calls, focusApp } = harness({
      ps: "    1     0 /sbin/launchd",
      // 只有 com.qoder.ide 装着的场景：前两次 open 全失败。
      openOk: (argv) => argv.includes("com.qoder.ide"),
    });
    expect(await focusApp("qoder", "/work/x")).toEqual({ ok: true, app: "Qoder IDE" });
    expect(calls.slice(1)).toEqual([
      ["open", "-b", "com.qoder.app"],
      ["open", "-a", "Qoder"],
      ["open", "-b", "com.qoder.ide"],
    ]);
  });

  test("codex 无进程且无兜底 → ok:false，只发一次 ps", async () => {
    const { calls, focusApp } = harness({ ps: "    1     0 /sbin/launchd" });
    expect(await focusApp("codex", "/work/x")).toEqual({ ok: false });
    expect(calls).toEqual([["ps", "axww", "-o", "pid=,ppid=,args="]]);
  });

  test("自身进程行不计入候选", async () => {
    // zcode-cli(2865) 恰是 selfPid → 不计候选；ZCode 主进程仍走祖先链命中。
    const { calls, focusApp } = harness({ ps: PS_GARDEN, lsof: LSOF_GARDEN, selfPid: 2865 });
    expect(await focusApp("zcode", "/work/zcode-proj")).toEqual({ ok: true, app: "ZCode" });
    expect(calls[calls.length - 1]).toEqual(["open", "/Applications/ZCode.app"]);
  });

  test("ps 失败退为空表 → 直接走 bundle 兜底", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "ps") return { code: 1, stdout: "" };
      if (argv[0] === "open") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
    const focusApp = createFocusApp(run);
    expect(await focusApp("devin", undefined)).toEqual({ ok: true, app: "Devin" });
    expect(calls[calls.length - 1]).toEqual(["open", "-b", "com.exafunction.windsurf"]);
  });
});
