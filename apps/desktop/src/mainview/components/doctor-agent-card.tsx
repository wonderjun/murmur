/**
 * 接入诊断 · 单 agent 行：GroupRow + 展开块（融入 GroupList 的 divide-y）。
 *
 * 行 = 彩色品牌砖 + 名称/版本 + hint 一句话 + 健康标签；展开块两列：
 * 左列「数据面」路径探针（✓/✗/打不开，hover 出 Finder），右列「hook 上报」
 * （注入态/触碰文件/最近上报）与「本地读取」（watcher 活性/游标/spool）。
 * 底部动作行：测试链路（全真自检逐步 ✓/✗）/ 重扫 / 重新接入。
 * 展开态由父级 openAgent 单开控制（expanded/onToggle 受控）。
 */

import { FolderSearch, RefreshCw, Wrench, Zap } from "lucide-react";
import { useState } from "react";

import AgentIcon from "@/components/agent-icon";
import { GroupRow } from "@/components/group-list";
import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { relAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentDiagnostics, AgentSnapshot, HookTestResult, PathProbe } from "@core/types";

/** 探针行状态：缺灰 / 异常红 / 正常绿。 */
function probeTone(p: PathProbe): string {
  if (!p.exists) return "bg-faint";
  if (!p.readable || p.openable === false) return "bg-stale";
  return "bg-working";
}

/** 卡片头部健康标签（与 setup-view 的 health() 同语义，数据源换成诊断实况）。 */
export function cardHealth(diag: AgentDiagnostics, snap?: AgentSnapshot): { label: string; tone: string; dot: string } {
  if (!diag.home.exists && !(snap?.install.installed)) return { label: "未安装", tone: "text-faint", dot: "bg-faint" };
  if (snap?.disabled) return { label: "已停用", tone: "text-faint", dot: "bg-ended" };
  if (diag.pull.error || diag.sources.some((s) => s.exists && (!s.readable || s.openable === false))) {
    return { label: "需检查", tone: "text-stale", dot: "bg-stale" };
  }
  if (diag.hook.lastEventAt || diag.pull.lastScanAt || snap?.sessions.length) {
    return { label: "已连接", tone: "text-working", dot: "bg-working" };
  }
  return { label: "等待数据", tone: "text-faint", dot: "bg-faint" };
}

/** 展开块内的 eyebrow 小标。 */
function Eyebrow({ children }: { children: string }) {
  return <p className="mb-1.5 text-micro font-semibold text-faint">{children}</p>;
}

export default function DoctorAgentCard({
  diag,
  snap,
  onChanged,
  expanded,
  onToggle,
}: {
  diag: AgentDiagnostics;
  snap?: AgentSnapshot;
  onChanged: () => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const testAgentHook = useMurmurStore((s) => s.testAgentHook);
  const rescanAgent = useMurmurStore((s) => s.rescanAgent);
  const installAgentHooks = useMurmurStore((s) => s.installAgentHooks);
  const revealPath = useMurmurStore((s) => s.revealPath);

  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<HookTestResult | null>(null);
  const [busy, setBusy] = useState<"rescan" | "hook" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const h = cardHealth(diag, snap);
  const probes = [diag.home, ...diag.sources];

  async function doTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await testAgentHook(diag.agent));
    } catch {
      setTest({ agent: diag.agent, ok: false, steps: [{ name: "自检执行", ok: false, detail: "调用失败" }] });
    } finally {
      setTesting(false);
    }
  }

  async function doRescan() {
    setBusy("rescan");
    setNotice(null);
    try {
      await rescanAgent(diag.agent);
      setNotice("已触发重扫");
    } catch {
      setNotice("重扫失败");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function doInstall() {
    setBusy("hook");
    setNotice(null);
    try {
      const r = await installAgentHooks(diag.agent);
      setNotice(r.changed ? `已接入 · 触碰 ${r.files.length} 个文件` : "无需改动（已是最新）");
    } catch {
      setNotice("接入失败");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <GroupRow
      leading={<AgentIcon agent={diag.agent} size={24} />}
      label={
        <span className="flex items-baseline gap-2">
          {AGENT_META[diag.agent].name}
          {snap?.install.version && (
            <span className="font-data text-micro font-normal tabular-nums text-faint">{snap.install.version}</span>
          )}
        </span>
      }
      desc={diag.hint}
      control={
        <span className={cn("flex shrink-0 items-center gap-1.5 text-meta font-medium", h.tone)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", h.dot)} />
          {h.label}
        </span>
      }
      onClick={onToggle}
      expanded={expanded}
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* 左列 · 数据面：路径探针 */}
        <div>
          <Eyebrow>数据面</Eyebrow>
          {probes.map((p) => (
            <div key={`${p.label}:${p.path}`} className="group flex min-w-0 items-center gap-2 py-1 text-meta">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", probeTone(p))} />
              <span className="shrink-0 text-muted-foreground">{p.label}</span>
              <span className="min-w-0 flex-1 truncate font-data text-micro text-faint" title={p.path}>
                {p.path}
              </span>
              {p.openable === false || !p.exists || !p.readable ? (
                <span className="shrink-0 text-micro text-faint">
                  {p.openable === false ? "打不开" : !p.exists ? "缺失" : "不可读"}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void revealPath(p.path).catch(() => {})}
                  className="shrink-0 text-micro text-faint opacity-0 transition-opacity duration-fast hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  在 Finder 显示
                </button>
              )}
            </div>
          ))}
        </div>

        {/* 右列 · hook 上报 + 本地读取（纵排）；targets 空表=无 push 面，整块不渲染 */}
        <div className="flex flex-col gap-4">
          {diag.hook.targets.length > 0 && (
            <div>
              <Eyebrow>hook 上报</Eyebrow>
              <div className="flex flex-col gap-1 text-meta text-muted-foreground">
                <span>
                  {diag.hook.installed ? "已注入" : diag.hook.enabled ? "未注入" : "已停用"}
                  <span className="ml-1.5 text-faint">
                    最近上报 <span className="font-data tabular-nums">{relAgo(diag.hook.lastEventAt)}</span>
                  </span>
                </span>
                {diag.hook.targets.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => void revealPath(t).catch(() => {})}
                  title={`${t}（点击在 Finder 显示）`}
                  className="group flex min-w-0 items-center gap-1.5 py-0.5 text-left"
                >
                  <span className="min-w-0 flex-1 truncate font-data text-micro text-faint">{t}</span>
                  <FolderSearch
                    size={10}
                    className="shrink-0 text-faint opacity-0 transition-opacity duration-fast group-hover:opacity-70"
                  />
                </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <Eyebrow>本地读取</Eyebrow>
            <div className="flex flex-col gap-1 text-meta text-muted-foreground">
              <span>
                {diag.pull.active ? "轮询中" : "未在扫描"}
                <span className="ml-1.5 text-faint">
                  最近扫描 <span className="font-data tabular-nums">{relAgo(diag.pull.lastScanAt)}</span>
                </span>
              </span>
              {diag.pull.sources.length > 0 && (
                <span className="text-faint">
                  {diag.pull.sources.length} 个游标 · 最新 {diag.pull.sources[0].name}
                </span>
              )}
              {diag.spool.pendingFiles > 0 && (
                <span className="text-stale">{diag.spool.pendingFiles} 个暂存待补投</span>
              )}
              {diag.pull.error && <span className="text-stale">watcher 启动失败：{diag.pull.error}</span>}
            </div>
          </div>
          {diag.quota && (
            <div>
              <Eyebrow>额度</Eyebrow>
              <div className="flex flex-col gap-1 text-meta text-muted-foreground">
                <span>
                  最近拉取 <span className="font-data tabular-nums">{relAgo(diag.quota.fetchedAt)}</span>
                  {diag.quota.error ? (
                    <span className="ml-1.5 text-stale">{diag.quota.error}</span>
                  ) : (
                    <span className="ml-1.5 text-faint">接口正常</span>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 链路自检结果：竖向 stepper（✓ working / ✗ stale） */}
      {test && (
        <div className="mt-3 flex flex-col gap-1">
          {test.steps.map((s) => (
            <div key={s.name} className="flex min-w-0 items-baseline gap-2 text-meta">
              <span className={cn("shrink-0 font-data", s.ok ? "text-working" : "text-stale")}>
                {s.ok ? "✓" : "✗"}
              </span>
              <span className="shrink-0 text-muted-foreground">{s.name}</span>
              {s.detail && <span className="min-w-0 truncate font-data text-micro text-faint">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 动作行（未安装工具无可操作面，整行藏） */}
      {diag.home.exists && (
        <div className="mt-3 flex items-center gap-2 border-t border-hairline/60 pt-3">
          {diag.hook.targets.length > 0 && (
            <Button size="sm" onClick={() => void doTest()} disabled={testing}>
              <Zap size={11} />
              {testing ? "自检中…" : "测试链路"}
            </Button>
          )}
          <Button size="sm" onClick={() => void doRescan()} disabled={busy !== null}>
            <RefreshCw size={11} />
            {busy === "rescan" ? "重扫中…" : "重扫"}
          </Button>
          {diag.hook.targets.length > 0 && (
            <Button size="sm" onClick={() => void doInstall()} disabled={busy !== null}>
              <Wrench size={11} />
              {busy === "hook" ? "接入中…" : "重新接入"}
            </Button>
          )}
          {notice && <span className="ml-auto text-micro text-faint">{notice}</span>}
        </div>
      )}
    </GroupRow>
  );
}
