/** agent 行：折叠头（徽标 + 摘要 + 聚合态旗标）+ 展开会话明细 + 额度窗格。
 *  自身不带卡片壳——分组容器（monitor-view / 设计板）提供 border/bg/分隔。
 *  展开走 grid-template-rows 0fr↔1fr 过渡（无测量）+ ease-spring 弹性。 */

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import StatusDot from "@/components/status-dot";
import { AGENT_META } from "@/lib/agent-meta";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { AgentSnapshot, AgentStatus, SessionSnapshot } from "@core/types";

const STATUS_ORDER: AgentStatus[] = ["waiting", "working", "stale", "idle", "ended"];

const STATUS_LABEL: Record<AgentStatus, string> = {
  waiting: "待处理",
  working: "工作中",
  stale: "已停止更新",
  idle: "空闲",
  ended: "已结束",
};

const STATUS_TONE: Record<AgentStatus, string> = {
  waiting: "bg-waiting/12 text-waiting",
  working: "bg-working/10 text-working",
  stale: "bg-stale/10 text-stale",
  idle: "bg-muted text-muted-foreground",
  ended: "bg-muted text-faint",
};

export default function AgentRow({ agent }: { agent: AgentSnapshot }) {
  const [expanded, setExpanded] = useState(true);

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
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-foreground/[0.03]"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <AgentIcon agent={agent.agent} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold">{name}</span>
            {sessions.length > 1 && (
              <span className="font-mono text-micro tabular-nums text-faint">{sessions.length} 个任务</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-meta text-muted-foreground">{summary}</p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-semibold",
            STATUS_TONE[primaryStatus],
          )}
        >
          <StatusDot status={primaryStatus} size={6} />
          {STATUS_LABEL[primaryStatus]}
        </span>
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
              <div key={session.sessionId} className="border-b border-hairline/60 px-3.5 py-2.5 last:border-b-0">
                <div className="flex items-start gap-2.5">
                  <StatusDot status={session.status} size={7} className="mt-[5px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-detail font-medium leading-snug">{session.title || "未命名任务"}</span>
                      <span className="shrink-0 font-mono text-micro tabular-nums text-faint">
                        {elapsed(session.startedAt)}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-micro text-faint">{compactPath(session.cwd)}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
                      <span>{modelName(session.model)}</span>
                      <span>{statusDetail(session)}</span>
                      <span className="ml-auto font-mono text-micro tabular-nums">
                        {fmtTokens(tokens(session))} 令牌
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {quotaWindows.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-hairline/60 bg-raised/60 px-3.5 py-2.5">
                {quotaWindows.map((w) => (
                  <span
                    key={w.label}
                    className="rounded-full border border-hairline px-2 py-0.5 font-mono text-micro tabular-nums text-muted-foreground"
                  >
                    <span className="font-sans">{w.label}</span> {w.usedPct}%
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

function statusDetail(session: SessionSnapshot) {
  if (session.status === "waiting")
    return session.waitingReason === "approval"
      ? "等待批准"
      : session.waitingReason === "question"
        ? "等待回答"
        : "等待继续";
  if (session.status === "stale") return `最后更新 ${age(session.lastEventAt)}`;
  return `更新于 ${age(session.lastEventAt)}`;
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

function age(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}

function tokens(session: SessionSnapshot) {
  return session.tokens.input + session.tokens.output + (session.tokens.cacheRead ?? 0) + (session.tokens.cacheWrite ?? 0);
}
