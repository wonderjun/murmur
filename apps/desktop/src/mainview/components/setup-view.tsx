/** 接入视图：逐 agent 的安装/来源/额度三行实况 + 额度窗口进度条。 */

import { useMemo } from "react";

import AgentIcon from "@/components/agent-icon";
import { AGENT_META, AGENT_ORDER, BYOK_REASON } from "@/lib/agent-meta";
import { fmtQuotaAmount, fmtQuotaHeadline } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentSnapshot, QuotaWindow } from "@core/types";

export default function SetupView() {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const openManager = useMurmurStore((s) => s.openManager);

  const agents = useMemo(
    () =>
      AGENT_ORDER.map((id) => snapshot?.agents.find((agent) => agent.agent === id)).filter(
        (agent): agent is AgentSnapshot => Boolean(agent),
      ),
    [snapshot],
  );
  const connectedCount = agents.filter((agent) => agent.install.installed && !agent.disabled).length;

  return (
    <div className="flex flex-col gap-4">
      <section className="setup-intro animate-enter">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="eyebrow text-faint">接入</p>
            <h1 className="mt-1 text-title font-semibold">工具状态</h1>
          </div>
          <span className="font-mono text-micro tabular-nums text-faint">
            {connectedCount}/{agents.length} 已连接
          </span>
        </div>
        <p className="mt-2 max-w-77.5 text-meta/relaxed text-muted-foreground">
          Murmur 只读取本机工具。不同工具的观察方式不同，这里会把数据来源和额度状态分开说明。
        </p>
      </section>

      <div className="space-y-2">
        {agents.map((agent, i) => {
          const h = health(agent);
          return (
            <article
              key={agent.agent}
              className="setup-row animate-enter"
              data-agent={agent.agent}
              style={{ animationDelay: `${i * 45 + 40}ms` }}
            >
              <div className="flex items-center gap-3">
                {/* 单色字形栖在叠层圆托上——工具页不收彩色品牌砖 */}
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
                  <AgentIcon agent={agent.agent} variant="mono" size={28} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-body font-semibold">{AGENT_META[agent.agent].name}</span>
                    {agent.install.version && (
                      <span className="font-mono text-micro text-faint">{agent.install.version}</span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-meta text-muted-foreground">
                    {agent.install.note || homeLabel(agent)}
                  </p>
                </div>
                <span className={cn("flex shrink-0 items-center gap-1.5 text-meta font-medium", h.tone)}>
                  <span className={cn("size-1.5 rounded-full", h.dot)} />
                  {h.label}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-hairline/60 pt-2.5">
                <div>
                  <p className="text-micro text-faint">安装</p>
                  <p className="mt-0.5 text-meta text-foreground">{agent.install.installed ? "已发现" : "未发现"}</p>
                </div>
                <div>
                  <p className="text-micro text-faint">来源</p>
                  <p className="mt-0.5 text-meta text-foreground">{sourceLabel(agent)}</p>
                </div>
                {/* 额度文案可能带错误细节，长文本跨两列 */}
                <div className="col-span-2">
                  <p className="text-micro text-faint">额度</p>
                  <p className="mt-0.5 text-meta text-foreground">{quotaLabel(agent)}</p>
                </div>
              </div>

              {agent.quota?.windows.length ? (
                /* 行列表而非横排格：窗口数不设上限（omp 实测 5 窗），单行四槽
                   「label · 细条 · pct · 重置」任意数量都保读，与 probe/图例行同构。 */
                <div className="mt-3 flex flex-col border-t border-hairline/60 pt-1">
                  {agent.quota.windows.map((w) => (
                    <div key={w.label} className="flex items-center gap-2 py-1" title={quotaTitle(w)}>
                      <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">{w.label}</span>
                      <span className="relative h-0.75 w-14 shrink-0 overflow-hidden rounded-full bg-surface-3">
                        <span
                          className={cn(
                            "absolute inset-y-0 left-0 rounded-full transition-[width]",
                            quotaBar(w.usedPct),
                          )}
                          style={{ width: `${Math.min(w.usedPct, 100)}%` }}
                        />
                      </span>
                      <span
                        className={cn(
                          "w-10 shrink-0 whitespace-nowrap text-right font-data text-meta tabular-nums",
                          quotaTone(w.usedPct),
                        )}
                      >
                        {fmtQuotaHeadline(w)}
                      </span>
                      <span className="w-16 shrink-0 whitespace-nowrap text-right font-data text-micro text-faint">
                        {resetText(w)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : agent.quota?.error ? (
                <p className="mt-3 border-t border-hairline/60 pt-2.5 text-meta text-faint">
                  额度拉取失败：{agent.quota.error}
                </p>
              ) : (
                agent.install.supportsByok &&
                !agent.byok?.hasKey && (
                  <p className="mt-3 border-t border-hairline/60 pt-2.5 text-meta text-faint">
                    {BYOK_REASON[agent.agent] ?? "本机凭据不可用"}；设置页填入 API Key 后可显示额度。
                  </p>
                )
              )}
            </article>
          );
        })}
      </div>

      {/* 深查入口：诊断/链路自检/恢复操作都在管理台窗口 */}
      <button
        type="button"
        onClick={() => void openManager("doctor")}
        className="mx-auto text-meta text-faint transition-colors duration-fast hover:text-muted-foreground"
      >
        管理与诊断 →
      </button>
    </div>
  );
}

function homeLabel(agent: AgentSnapshot) {
  return agent.install.installed ? agent.install.homeDir : "未检测到本地数据";
}

function sourceLabel(agent: AgentSnapshot) {
  if (!agent.install.installed) return "等待安装";
  if (agent.disabled) return "已停用（设置页可开回）";
  if (agent.install.hookInstalled) return "上报 + 本地读取";
  return "本地读取";
}

function quotaLabel(agent: AgentSnapshot) {
  if (agent.quota?.windows.length) return `${agent.quota.windows.length} 个窗口`;
  if (agent.quota?.error) return agent.quota.error;
  // 拉取成功但零窗口（schema 漂移/该 plan 无额度面）——别停在"获取中"假死。
  if (agent.quota) return "端点无窗口数据";
  if (agent.install.supportsByok) return agent.byok?.hasKey ? "获取中" : "未配置 Key";
  if (agent.install.hasCredentials) return "获取中";
  return "未配置";
}

function health(agent: AgentSnapshot) {
  if (!agent.install.installed) return { label: "未安装", tone: "text-faint", dot: "bg-faint" };
  if (agent.disabled) return { label: "已停用", tone: "text-faint", dot: "bg-ended" };
  if (agent.sessions.some((session) => session.status === "stale"))
    return { label: "需检查", tone: "text-stale", dot: "bg-stale" };
  if (agent.sessions.length || agent.install.hookInstalled)
    return { label: "已连接", tone: "text-working", dot: "bg-working" };
  return { label: "等待数据", tone: "text-faint", dot: "bg-faint" };
}

/* 阈值语义：≥70% 前景加重（字重升级，不动琥珀）、≥90% 才红色警示；
   琥珀只属于「轮到你了」，不进额度通道。 */
function quotaTone(usedPct: number) {
  return usedPct >= 90 ? "text-stale" : usedPct >= 70 ? "text-foreground font-semibold" : "text-foreground";
}

/* 进度条灰阶与 quota-pill 同规：正常态前景 50%、≥70% 前景实色、≥90% 红。 */
function quotaBar(usedPct: number) {
  return usedPct >= 90 ? "bg-stale" : usedPct >= 70 ? "bg-foreground" : "bg-foreground/50";
}

/* 行内只放得下短文案：无重置时间留空，重置中点一个点，其余 N 天/时/分后。 */
function resetText(window: QuotaWindow) {
  if (!window.resetsAt) return "";
  const ms = window.resetsAt - Date.now();
  if (ms <= 0) return "重置中";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}天后`;
  if (hours) return `${hours}小时后`;
  return `${minutes}分钟后`;
}

/* 悬浮细目：行内被密度省掉的 u/l 与绝对重置时间在这里补齐（probe 行 title 先例）。 */
function quotaTitle(w: QuotaWindow) {
  const parts = [w.label];
  const amount = fmtQuotaAmount(w);
  if (amount) parts.push(amount);
  if (w.resetsAt) parts.push(`重置 ${new Date(w.resetsAt).toLocaleString()}`);
  return parts.join(" · ");
}
