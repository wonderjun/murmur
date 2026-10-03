/**
 * 接入诊断页（管理台 doctor tab）：ingest 端点状态 + 首启引导卡 + 逐 agent 诊断卡。
 *
 * 引导卡只在 firstRun（settings.json 尚未写过）时出现：一键接入逐 agent 回报
 * 改动与触碰文件清单；「先逛逛」与接入完成都会写一次设置（settings.json 落盘
 * 即不再算首启，卡片自然消失）。
 */

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import DoctorAgentCard from "@/components/doctor-agent-card";
import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { useMurmurStore } from "@/store/murmur";

import type { AgentId, DiagnosticsSnapshot } from "@core/types";

export default function DoctorView() {
  const getDiagnostics = useMurmurStore((s) => s.getDiagnostics);
  const installHooks = useMurmurStore((s) => s.installHooks);
  const updateSettings = useMurmurStore((s) => s.updateSettings);
  const openDataDir = useMurmurStore((s) => s.openDataDir);
  const snapshot = useMurmurStore((s) => s.snapshot);

  const [diag, setDiag] = useState<DiagnosticsSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [installing, setInstalling] = useState(false);
  const [report, setReport] = useState<Record<AgentId, { changed: boolean; files: string[] }> | null>(null);
  const [dismissed, setDismissed] = useState(false);

  async function load() {
    try {
      setDiag(await getDiagnostics());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const found = diag?.agents.filter((a) => a.home.exists).length ?? 0;
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

  if (status === "loading" || !diag) {
    return (
      <div className="space-y-3" aria-live="polite" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-item bg-raised" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 头：端点状态 + 操作 */}
      <section className="animate-enter flex items-center justify-between gap-3 border-b border-hairline pb-2.5">
        <div>
          <p className="eyebrow text-faint">接入诊断</p>
          <p className="mt-1 text-meta text-muted-foreground">
            ingest <span className="font-mono text-micro">{diag.ingest.endpoint}</span>
            <span className={diag.ingest.ok ? "text-working" : "text-stale"}> · {diag.ingest.ok ? "在听" : "未启动"}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void openDataDir()} className="h-6 px-2 text-micro">
            数据目录
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} className="h-6 px-2 text-micro">
            <RefreshCw size={10} />
            刷新
          </Button>
        </div>
      </section>

      {/* 首启引导卡 */}
      {showOnboarding && (
        <section className="setup-row animate-enter">
          <p className="eyebrow text-faint">欢迎</p>
          <p className="mt-1.5 text-body font-semibold">已在本机发现 {found} 个可观察的工具</p>
          <p className="mt-1.5 text-meta leading-relaxed text-muted-foreground">
            Murmur 只读本地数据：本地读取即可看到会话状态与用量；接入 hook 后还能实时收到「轮到你了」这类回合信号。
          </p>
          {report ? (
            <div className="mt-2.5 flex flex-col gap-1 border-t border-hairline/60 pt-2">
              {Object.entries(report).map(([id, r]) => (
                <div key={id} className="flex min-w-0 items-baseline gap-1.5">
                  <span className={r.changed ? "text-working" : "text-faint"}>·</span>
                  <span className="shrink-0 text-meta text-muted-foreground">{AGENT_META[id as AgentId].name}</span>
                  <span className="min-w-0 truncate font-mono text-micro text-faint">
                    {r.changed ? `已接入 · ${r.files.join("、")}` : "无需改动"}
                  </span>
                </div>
              ))}
              <p className="mt-1.5 text-meta text-muted-foreground">codex 用户：装好的 hook 还需在 /hooks 里信任条目才生效。</p>
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
        </section>
      )}

      {/* 逐 agent 诊断卡 */}
      <div className="flex flex-col gap-2.5">
        {diag.agents.map((a) => (
          <DoctorAgentCard key={a.agent} diag={a} snap={snapshot?.agents.find((s) => s.agent === a.agent)} onChanged={() => void load()} />
        ))}
      </div>
    </div>
  );
}
