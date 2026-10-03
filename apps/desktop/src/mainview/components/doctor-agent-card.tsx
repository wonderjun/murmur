/**
 * 接入诊断 · 单 agent 实体卡：健康点 + hint 一句话 + 三面详情。
 *
 * 数据面 = agentPaths/adapter.dataSources 声明路径的探针行（✓/✗/打不开）；
 * push 面 = hook 注入态 + 触碰文件（点击 Finder 定位）+ 最近上报 + 「测试链路」
 * 全真自检（逐步 ✓/✗ 回报）；pull 面 = 游标推进的最近扫描时间与 watcher 活性。
 * 操作行：重扫（重启 watcher 拾漏）/ 重新接入（重装 hook）。
 * 彩色只给状态语义点（working 绿 / stale 红 / faint 灰），中性 chrome 不破。
 */

import { FolderSearch, RefreshCw, Wrench } from "lucide-react";
import { useState } from "react";

import AgentIcon from "@/components/agent-icon";
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
function cardHealth(diag: AgentDiagnostics, snap?: AgentSnapshot): { label: string; tone: string; dot: string } {
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

export default function DoctorAgentCard({
  diag,
  snap,
  onChanged,
}: {
  diag: AgentDiagnostics;
  snap?: AgentSnapshot;
  onChanged: () => void;
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
    <article className="setup-row animate-enter" data-agent={diag.agent}>
      {/* 头：图标 + 名称/版本 + 健康标签 */}
      <div className="flex items-center gap-3">
        <AgentIcon agent={diag.agent} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold">{AGENT_META[diag.agent].name}</span>
            {snap?.install.version && <span className="font-mono text-micro text-faint">{snap.install.version}</span>}
          </div>
          <p className="mt-1 text-meta leading-snug text-muted-foreground">{diag.hint}</p>
        </div>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-meta font-medium", h.tone)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", h.dot)} />
          {h.label}
        </span>
      </div>

      {/* 数据面：路径探针 */}
      <div className="mt-3 border-t border-hairline/60 pt-2.5">
        <p className="eyebrow text-faint">数据</p>
        <div className="mt-1.5 flex flex-col gap-1">
          {probes.map((p) => (
            <button
              key={`${p.label}:${p.path}`}
              type="button"
              onClick={() => p.exists && void revealPath(p.path).catch(() => {})}
              title={p.exists ? `${p.path}（点击在 Finder 显示）` : p.path}
              className={cn(
                "group flex min-w-0 items-center gap-2 rounded px-0.5 py-0.5 text-left",
                p.exists && "hover:bg-raised/60",
              )}
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", probeTone(p))} />
              <span className="w-20 shrink-0 text-meta text-muted-foreground">{p.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint">{p.path}</span>
              <span className="shrink-0 text-micro text-faint">
                {p.openable === false ? "打不开" : !p.exists ? "缺失" : !p.readable ? "不可读" : ""}
                {p.exists && (
                  <FolderSearch size={10} className="ml-1 inline opacity-0 transition-opacity group-hover:opacity-70" />
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* push 面：hook 注入态 + 触碰文件 + 最近上报 + 链路自检 */}
      <div className="mt-3 border-t border-hairline/60 pt-2.5">
        <div className="flex items-center justify-between">
          <p className="eyebrow text-faint">上报 · hook</p>
          <Button size="sm" variant="ghost" onClick={() => void doTest()} disabled={testing} className="h-5 px-1.5 text-micro">
            {testing ? "自检中…" : "测试链路"}
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
          <span>
            {diag.hook.installed ? "已注入" : diag.hook.enabled ? "未注入" : "已停用"}
            <span className="ml-1.5 text-faint">最近上报 {relAgo(diag.hook.lastEventAt)}</span>
          </span>
        </div>
        {diag.hook.targets.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {diag.hook.targets.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => void revealPath(t).catch(() => {})}
                title={`${t}（点击在 Finder 显示）`}
                className="group flex min-w-0 items-center gap-1.5 rounded px-0.5 py-px text-left hover:bg-raised/60"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint">{t}</span>
                <FolderSearch size={10} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-70" />
              </button>
            ))}
          </div>
        )}
        {test && (
          <div className="mt-2 flex flex-col gap-0.5 rounded-item bg-raised/50 px-2 py-1.5">
            {test.steps.map((s) => (
              <div key={s.name} className="flex min-w-0 items-baseline gap-1.5">
                <span className={cn("mt-0.5 h-1.5 w-1.5 shrink-0 self-center rounded-full", s.ok ? "bg-working" : "bg-stale")} />
                <span className="shrink-0 text-meta text-muted-foreground">{s.name}</span>
                {s.detail && <span className="min-w-0 truncate font-mono text-micro text-faint">{s.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* pull 面：watcher 活性 + 最近扫描 + spool */}
      <div className="mt-3 border-t border-hairline/60 pt-2.5">
        <p className="eyebrow text-faint">本地读取</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
          <span>{diag.pull.active ? "轮询中" : "未在扫描"}</span>
          <span>
            最近扫描 <span className="font-mono tabular-nums">{relAgo(diag.pull.lastScanAt)}</span>
          </span>
          {diag.pull.sources.length > 0 && (
            <span className="text-faint">
              {diag.pull.sources.length} 个游标 · 最新 {diag.pull.sources[0].name}
            </span>
          )}
          {diag.spool.pendingFiles > 0 && <span className="text-stale">{diag.spool.pendingFiles} 个暂存待补投</span>}
        </div>
        {diag.pull.error && <p className="mt-1 text-meta text-stale">watcher 启动失败：{diag.pull.error}</p>}
      </div>

      {/* 额度面：最近拉取时间与失败原因（「额度接口不可用」异常态落点） */}
      {diag.quota && (
        <div className="mt-3 border-t border-hairline/60 pt-2.5">
          <p className="eyebrow text-faint">额度</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
            <span>
              最近拉取 <span className="font-mono tabular-nums">{relAgo(diag.quota.fetchedAt)}</span>
            </span>
            {diag.quota.error ? (
              <span className="text-stale">{diag.quota.error}</span>
            ) : (
              <span className="text-faint">接口正常</span>
            )}
          </div>
        </div>
      )}

      {/* 操作行：重扫 / 重新接入 + 操作回报（未安装工具无可操作面，整行藏） */}
      {diag.home.exists && (
      <div className="mt-3 flex items-center gap-2 border-t border-hairline/60 pt-2.5">
        <Button size="sm" variant="ghost" onClick={() => void doRescan()} disabled={busy !== null} className="h-6 px-2 text-micro">
          <RefreshCw size={10} />
          {busy === "rescan" ? "重扫中…" : "重扫"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void doInstall()} disabled={busy !== null} className="h-6 px-2 text-micro">
          <Wrench size={10} />
          {busy === "hook" ? "接入中…" : "重新接入"}
        </Button>
        {notice && <span className="ml-auto text-meta text-faint">{notice}</span>}
      </div>
      )}
    </article>
  );
}
