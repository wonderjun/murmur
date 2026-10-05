/**
 * 接入诊断页（管理台 doctor tab）：PageHead 统计 + 首启引导卡 + 上报服务 +
 * 逐 agent 诊断行（GroupList 容器，「需检查」默认展开）。
 *
 * 引导卡只在 firstRun（settings.json 尚未写过）时出现：一键接入逐 agent 回报
 * 改动与触碰文件清单；「先逛逛」与接入完成都会写一次设置（settings.json 落盘
 * 即不再算首启，卡片自然消失）。
 */

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import Dawn from "@/components/dawn";
import DoctorAgentCard, { cardHealth } from "@/components/doctor-agent-card";
import { GroupList, GroupRow } from "@/components/group-list";
import Murmuration from "@/components/murmuration";
import PageHead from "@/components/page-head";
import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { useMurmurStore } from "@/store/murmur";

import type { AgentId, DiagnosticsSnapshot } from "@core/types";

export default function DoctorView() {
  const getDiagnostics = useMurmurStore((s) => s.getDiagnostics);
  const installHooks = useMurmurStore((s) => s.installHooks);
  const updateSettings = useMurmurStore((s) => s.updateSettings);
  const snapshot = useMurmurStore((s) => s.snapshot);

  const [diag, setDiag] = useState<DiagnosticsSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [installing, setInstalling] = useState(false);
  const [report, setReport] = useState<Record<AgentId, { changed: boolean; files: string[] }> | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [openAgent, setOpenAgent] = useState<AgentId | null>(null);

  const snapOf = useMemo(
    () => (agent: AgentId) => snapshot?.agents.find((s) => s.agent === agent),
    [snapshot],
  );

  async function load() {
    try {
      const d = await getDiagnostics();
      setDiag(d);
      setStatus("ready");
      // 默认展开第一个「需检查」的，没有则全收起（openAgent 只认首载定值）。
      setOpenAgent((prev) => {
        if (prev) return prev;
        const bad = d.agents.find((a) => cardHealth(a, snapOf(a.agent)).label === "需检查");
        return bad?.agent ?? null;
      });
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const found = diag?.agents.filter((a) => a.home.exists).length ?? 0;
  const connected = diag?.agents.filter((a) => cardHealth(a, snapOf(a.agent)).label === "已连接").length ?? 0;
  const needCheck = diag?.agents.filter((a) => cardHealth(a, snapOf(a.agent)).label === "需检查").length ?? 0;
  const showOnboarding = Boolean(diag?.firstRun) && !dismissed;

  async function dismiss() {
    setDismissed(true);
    try {
      await updateSettings({}); // 写盘即「见过」，下次启动不再弹。
    } catch {
      // 写不了也只是下次再弹一次，不挡路。
    }
  }

  async function onboard() {
    setInstalling(true);
    try {
      setReport(await installHooks());
      await updateSettings({});
      await load();
    } catch {
      setReport(null);
    } finally {
      setInstalling(false);
    }
  }

  if (status === "error") {
    return (
      <div className="px-4 py-14 text-center" role="alert">
        <p className="text-body font-medium">诊断读取失败</p>
        <p className="mt-1.5 text-meta text-muted-foreground">主进程暂时不响应，稍候可重试。</p>
        <Button size="sm" className="mt-4" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <PageHead
        title="接入诊断"
        meta={
          diag
            ? `${found} 个工具已发现 · ${connected} 已连接${needCheck ? ` · ${needCheck} 需检查` : ""}`
            : "诊断中…"
        }
        actions={
          <Button
            variant="ghost"
            size="icon"
            title="重新诊断"
            aria-label="重新诊断"
            disabled={status === "loading"}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
          </Button>
        }
      />

      {status === "loading" || !diag ? (
        <div className="flex flex-col gap-3" aria-live="polite" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-item bg-surface-1" />
          ))}
        </div>
      ) : (
        <>
          {/* 首启引导卡：surface-1 叠层 + quiet 天光 + 椋鸟群水印 */}
          {showOnboarding && (
            <section className="relative overflow-hidden rounded-item bg-surface-1 p-5">
              <Dawn />
              <Murmuration size={120} className="absolute right-4 top-3 opacity-80" />
              <div className="relative">
                <p className="eyebrow text-faint">欢迎</p>
                <p className="mt-1.5 text-body font-semibold">已在本机发现 {found} 个可观察的工具</p>
                <p className="mt-1.5 max-w-[380px] text-meta leading-relaxed text-muted-foreground">
                  Murmur 只读本地数据：本地读取即可看到会话状态与用量；接入 hook 后还能实时收到「轮到你了」这类回合信号。
                </p>
                {report ? (
                  <div className="mt-2.5 flex flex-col gap-1 border-t border-hairline/60 pt-2">
                    {Object.entries(report).map(([id, r]) => (
                      <div key={id} className="flex min-w-0 items-baseline gap-1.5">
                        <span className={r.changed ? "text-working" : "text-faint"}>·</span>
                        <span className="shrink-0 text-meta text-muted-foreground">{AGENT_META[id as AgentId].name}</span>
                        <span className="min-w-0 truncate font-data text-micro text-faint">
                          {r.changed ? `已接入 · ${r.files.join("、")}` : "无需改动"}
                        </span>
                      </div>
                    ))}
                    <p className="mt-1.5 text-meta text-muted-foreground">
                      codex 用户：装好的 hook 还需在 /hooks 里信任条目才生效。
                    </p>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <Button size="sm" onClick={() => void onboard()} disabled={installing}>
                      {installing ? "接入中…" : `为 ${found} 个工具一键接入`}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
                      先逛逛
                    </Button>
                  </div>
                )}
              </div>
            </section>
          )}

          <GroupList title="上报服务">
            <GroupRow
              label="本机 ingest"
              desc={<span className="font-data text-micro">{diag.ingest.endpoint}</span>}
              control={
                <span className="flex items-center gap-1.5 text-meta">
                  <span className={`h-1.5 w-1.5 rounded-full ${diag.ingest.ok ? "bg-working" : "bg-stale"}`} />
                  <span className={diag.ingest.ok ? "text-muted-foreground" : "text-stale"}>
                    {diag.ingest.ok ? "在听" : "未启动"}
                  </span>
                </span>
              }
            />
          </GroupList>

          <GroupList title="工具">
            {diag.agents.map((a) => (
              <DoctorAgentCard
                key={a.agent}
                diag={a}
                snap={snapOf(a.agent)}
                onChanged={() => void load()}
                expanded={openAgent === a.agent}
                onToggle={() => setOpenAgent((prev) => (prev === a.agent ? null : a.agent))}
              />
            ))}
          </GroupList>
        </>
      )}
    </div>
  );
}
