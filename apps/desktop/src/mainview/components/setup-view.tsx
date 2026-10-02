/** 接入视图：逐 agent 的安装/来源/额度三行实况 + 额度窗口进度条。 */

import { useMemo } from "react";

import AgentIcon from "@/components/agent-icon";
import { AGENT_META, AGENT_ORDER, BYOK_REASON } from "@/lib/agent-meta";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentSnapshot, QuotaWindow } from "@core/types";

export default function SetupView() {
  const snapshot = useMurmurStore((s) => s.snapshot);

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
        <p className="mt-2 max-w-[310px] text-meta leading-relaxed text-muted-foreground">
          Murmur 只读取本机工具。不同工具的观察方式不同，这里会把数据来源和额度状态分开说明。
        </p>
      </section>

      <div className="space-y-2">
        {agents.map((agent, i) => {
          const h = health(agent);
          return (
            <article key={agent.agent} className="setup-row animate-enter" data-agent={agent.agent} style={{ animationDelay: `${i * 45 + 40}ms` }}>
              <div className="flex items-center gap-3">
                <AgentIcon agent={agent.agent} size={30} />
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
                  <span className={cn("h-1.5 w-1.5 rounded-full", h.dot)} />
                  {h.label}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline/60 pt-2.5 text-meta text-muted-foreground">
                <span>
                  <b className="font-normal text-faint">安装</b> {agent.install.installed ? "已发现" : "未发现"}
                </span>
                <span>
                  <b className="font-normal text-faint">来源</b> {sourceLabel(agent)}
                </span>
                <span>
                  <b className="font-normal text-faint">额度</b> {quotaLabel(agent)}
                </span>
              </div>

              {agent.quota?.windows.length ? (
                <div className="quota-strip mt-3">
                  {agent.quota.windows.map((w) => (
                    <div key={w.label} className="quota-window">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-meta font-medium text-foreground">{w.label}</span>
                        <span className={cn("font-mono text-meta tabular-nums", quotaTone(w.usedPct))}>
                          {w.limit !== undefined ? `${w.usedPct}%` : fmtAmount(w.used ?? 0)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
                        <span
                          className={cn("block h-full rounded-full transition-[width]", quotaBar(w.usedPct))}
                          style={{ width: `${Math.min(w.usedPct, 100)}%` }}
                        />
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-micro text-faint">
                        <span>{quotaAmount(w)}</span>
                        <span>{resetText(w)}</span>
                      </div>
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
  return { label: "等待数据", tone: "text-waiting", dot: "bg-waiting" };
}

function quotaTone(usedPct: number) {
  return usedPct >= 90 ? "text-stale" : usedPct >= 70 ? "text-waiting" : "text-foreground";
}

/* 正常态中性灰——彩色只留给阈值语义（≥70% 琥珀 / ≥90% 红）。 */
function quotaBar(usedPct: number) {
  return usedPct >= 90 ? "bg-stale" : usedPct >= 70 ? "bg-waiting" : "bg-foreground/50";
}

function quotaAmount(window: QuotaWindow) {
  if (window.used === undefined) return "用量未提供";
  // 无上限窗口（devin ACU 这类计量计费）：只报已用，不编 limit。
  if (window.limit === undefined) return `${fmtAmount(window.used)} 已用`;
  return `${fmtAmount(window.used)} / ${fmtAmount(window.limit)}`;
}

/** 额度数字：小数值（ACU 这类小数计量）保一位小数，大数走紧凑格式。 */
function fmtAmount(n: number) {
  return n < 100 && !Number.isInteger(n) ? n.toFixed(1) : fmtTokens(n);
}

function resetText(window: QuotaWindow) {
  if (!window.resetsAt) return "无重置时间";
  const ms = window.resetsAt - Date.now();
  if (ms <= 0) return "正在重置";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}天后重置`;
  if (hours) return `${hours}小时后重置`;
  return `${minutes}分钟后重置`;
}
