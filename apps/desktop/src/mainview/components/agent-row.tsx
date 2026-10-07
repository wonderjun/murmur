/** agent 行：折叠头（mono 徽标状态环 + 摘要）+ 展开会话明细 + 额度窗格。
 *  自身不带卡片壳——分组容器（monitor-view / 设计板）提供叠层面与分隔。
 *  展开走 grid-template-rows 0fr↔1fr 过渡（无测量）+ ease-spring 弹性。
 *  会话动作（Finder 定位 / 复制路径）走 useSessionActions：行内提示 3 秒淡出。 */

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import StatusDot from "@/components/status-dot";
import StatusRing from "@/components/status-ring";
import { AGENT_META } from "@/lib/agent-meta";
import { fmtQuotaHeadline, fmtTokens, relAgo } from "@/lib/format";
import { sessionStatusText, sessionTimeline } from "@/lib/status-text";
import { hintLabel, useSessionActions } from "@/lib/use-session-actions";
import { cn } from "@/lib/utils";

import type { AgentSnapshot, AgentStatus, SessionSnapshot } from "@core/types";

const STATUS_ORDER: AgentStatus[] = ["waiting", "working", "stale", "idle", "ended"];

export default function AgentRow({ agent }: { agent: AgentSnapshot }) {
  const [expanded, setExpanded] = useState(true);
  const { reveal, copyCwd, hint } = useSessionActions();

  const name = AGENT_META[agent.agent].name;
  const sessions = useMemo(() => [...agent.sessions].sort((a, b) => b.lastEventAt - a.lastEventAt), [agent.sessions]);
  const quotaWindows = agent.quota?.windows ?? [];
  const primaryStatus = STATUS_ORDER.find((status) => sessions.some((s) => s.status === status)) ?? "idle";

  const s = sessions[0];
  const summary = !s
    ? agent.install.installed
      ? "已连接，等待任务"
      : "未检测到本地安装"
    : `${s.title || compactPath(s.cwd)} · ${statusText(s.status)}`;

  return (
    <article data-agent={agent.agent}>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-surface-2"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusRing status={primaryStatus} size={28}>
          <AgentIcon agent={agent.agent} variant="mono" size={28} />
        </StatusRing>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold">{name}</span>
            {sessions.length > 1 && (
              <span className="font-data text-micro tabular-nums text-faint">{sessions.length} 个任务</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-meta text-muted-foreground">{summary}</p>
        </div>
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-faint transition-transform duration-normal", expanded && "rotate-180")}
        />
      </button>

      {/* 展开区：grid 行高过渡，0fr→1fr 免测量弹性展开 */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-normal ease-spring",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-hairline/60">
            {sessions.map((session) => (
              <div
                key={session.sessionId}
                className="group select-text border-b border-hairline/60 px-3.5 py-2.5 last:border-b-0"
              >
                <div className="flex items-start gap-2.5">
                  <StatusDot status={session.status} size={6} className="mt-1.25" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-detail font-medium" title={session.title || "未命名任务"}>
                        {session.title || "未命名任务"}
                      </span>
                      <span className="shrink-0 font-data text-micro tabular-nums text-faint">
                        {elapsed(session.startedAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
                      <span className="min-w-0 truncate">{modelName(session.model)}</span>
                      <span className="min-w-0 truncate">{sessionStatusText(session)}</span>
                      {session.status === "waiting" && (
                        <span className="text-waiting">等了 {relAgo(session.statusAt)}</span>
                      )}
                      <span className="ml-auto font-data text-micro tabular-nums">
                        {fmtTokens(tokens(session))} 令牌
                      </span>
                    </div>
                    {/* 定位行：cwd + 复制/Finder——动作默认隐身，hover/focus 行才浮出 */}
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className="min-w-0 truncate font-data text-micro text-faint"
                        title={session.cwd ?? undefined}
                      >
                        {compactPath(session.cwd)}
                      </span>
                      {session.cwd && (
                        <button
                          type="button"
                          className="shrink-0 text-micro text-faint opacity-0 transition-[opacity,color] duration-fast hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                          onClick={() => copyCwd(session)}
                        >
                          复制路径
                        </button>
                      )}
                      <button
                        type="button"
                        className="ml-auto shrink-0 text-micro text-faint opacity-0 transition-[opacity,color] duration-fast hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                        onClick={() => void reveal(session)}
                      >
                        在 Finder 显示
                      </button>
                    </div>
                    {hint?.sessionId === session.sessionId && (
                      <p className="mt-0.5 text-micro text-faint">{hintLabel(hint)}</p>
                    )}
                    {/* 轻量时间线：发起 / 最近工具调用 / 等待开始（缺项不渲染） */}
                    {sessionTimeline(session).length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-data text-micro tabular-nums text-faint">
                        {sessionTimeline(session).map((m) => (
                          <span key={m.label}>
                            {m.label} {relAgo(m.at)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {quotaWindows.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline/60 bg-surface-2/60 px-3.5 py-2.5">
                {quotaWindows.map((w) => (
                  <span
                    key={w.label}
                    className="rounded-full bg-surface-3 px-2 py-0.5 font-data text-micro tabular-nums text-muted-foreground"
                  >
                    <span className="font-sans">{w.label}</span> {fmtQuotaHeadline(w)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function statusText(status: AgentStatus) {
  return { waiting: "等待你的处理", working: "正在更新", stale: "长时间没有更新", idle: "空闲", ended: "已结束" }[
    status
  ];
}

function modelName(model?: string) {
  return model ? model.split("/").pop() : "未标注模型";
}

function compactPath(path?: string) {
  if (!path) return "未提供工作目录";
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function elapsed(start: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  if (minutes < 1) return "刚开始";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function tokens(session: SessionSnapshot) {
  return (
    session.tokens.input + session.tokens.output + (session.tokens.cacheRead ?? 0) + (session.tokens.cacheWrite ?? 0)
  );
}
