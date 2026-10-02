/** 动态视图：尺规索引条（计数 + 新鲜度）→ waiting 琥珀头条 → 编号分组列表 → 已停更清单。
 *  版块入场 stagger（enter + 序位 delay）；空态投放椋鸟群签名时刻。 */

import { useMemo } from "react";

import AgentIcon from "@/components/agent-icon";
import AgentRow from "@/components/agent-row";
import AnimatedNumber from "@/components/animated-number";
import Murmuration from "@/components/murmuration";
import StatusDot from "@/components/status-dot";
import { AGENT_META } from "@/lib/agent-meta";
import { fmtTokens } from "@/lib/format";
import { allSessions, todayTokens } from "@/lib/selectors";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentId, WaitingReason } from "@core/types";

export default function MonitorView() {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const loading = useMurmurStore((s) => s.loading);

  const sessions = useMemo(() => allSessions(snapshot), [snapshot]);
  const waitingSessions = sessions.filter((s) => s.status === "waiting");
  const workingSessions = sessions.filter((s) => s.status === "working");
  const staleSessions = sessions.filter((s) => s.status === "stale");
  const activeSessions = sessions.filter((s) => ["waiting", "working"].includes(s.status));
  const activeAgents = (snapshot?.agents ?? []).filter((a) =>
    a.sessions.some((s) => ["waiting", "working"].includes(s.status)),
  );
  const tokens = todayTokens(snapshot);
  const freshness = snapshot ? `更新于 ${age(snapshot.generatedAt)}` : "连接中";

  /* 入场序位：渲染顺序即 stagger 顺序，每次渲染从 0 重新排 */
  let slot = 0;
  const enterDelay = () => `${slot++ * 40}ms`;

  if (loading) {
    return (
      <div className="space-y-3" aria-live="polite">
        <div className="h-20 animate-pulse rounded-item bg-raised" />
        <div className="h-14 animate-pulse rounded-item bg-raised" />
        <div className="h-14 animate-pulse rounded-item bg-raised" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 索引条：计数 + 新鲜度；上边线由玻璃刊头的底边线兼任，只保留下规线 */}
      <section
        className="animate-enter flex items-center justify-between border-b border-hairline py-2"
        style={{ animationDelay: enterDelay() }}
      >
        <div className="flex items-center gap-3.5 text-meta text-muted-foreground">
          <span>
            运行中
            <AnimatedNumber
              value={workingSessions.length}
              className={cn(
                "ml-1 font-mono text-detail",
                workingSessions.length ? "font-medium text-working" : "text-faint",
              )}
            />
          </span>
          <span>
            需处理
            <AnimatedNumber
              value={waitingSessions.length}
              className={cn(
                "ml-1 font-mono text-detail",
                waitingSessions.length ? "font-medium text-waiting" : "text-faint",
              )}
            />
          </span>
          <span>
            今日令牌
            <AnimatedNumber
              value={tokens ? fmtTokens(tokens) : "·"}
              className={cn("ml-1 font-mono text-detail", tokens ? "font-medium text-foreground" : "text-faint")}
            />
          </span>
        </div>
        <span className="font-mono text-micro tabular-nums text-faint">{freshness}</span>
      </section>

      {/* 头条：waiting 的第一条会话——琥珀左边条 + 慢呼吸光晕 + 淡染卡面，本页唯一 hero */}
      {waitingSessions.length > 0 && (
        <section
          className="animate-enter relative overflow-hidden rounded-item border border-waiting/25 bg-waiting/[0.06] shadow-raised"
          style={{ animationDelay: enterDelay() }}
          aria-live="polite"
        >
          <span className="animate-hero-breathe pointer-events-none absolute -left-8 -top-10 h-24 w-44 rounded-full bg-waiting/15 blur-2xl" />
          <span className="absolute inset-y-0 left-0 w-[3px] bg-waiting" />
          <div className="px-4 py-3.5">
            <p className="text-micro font-semibold tracking-[0.1em] text-waiting">
              轮到你了 · {agentName(waitingSessions[0].agent)}
            </p>
            <p className="mt-1.5 text-title font-medium leading-snug">
              {waitingSessions[0].title || "一个任务正在等你继续"}
            </p>
            <p className="mt-1 text-meta text-muted-foreground">
              {waitingReason(waitingSessions[0].waitingReason)} · {age(waitingSessions[0].lastEventAt)}
            </p>
          </div>
          {waitingSessions.length > 1 && (
            <div className="border-t border-waiting/15 px-4 py-2 text-meta text-muted-foreground">
              还有 {waitingSessions.length - 1} 个任务等待处理
            </div>
          )}
        </section>
      )}

      {activeAgents.length > 0 && (
        <section className="animate-enter space-y-2" style={{ animationDelay: enterDelay() }}>
          <div className="flex items-center gap-2 px-0.5">
            <span className="eyebrow flex items-baseline gap-1.5 text-faint">
              <span className="font-mono">01</span>正在发生
            </span>
            <span className="h-px flex-1 bg-hairline" />
            <span className="font-mono text-micro tabular-nums text-faint">{activeSessions.length}</span>
          </div>
          {/* 分组列表：单一面 + hairline 分隔，AgentRow 自身不带卡片壳 */}
          <div className="divide-y divide-hairline/60 overflow-hidden rounded-item border border-hairline bg-card shadow-raised">
            {activeAgents.map((agent) => (
              <AgentRow key={agent.agent} agent={agent} />
            ))}
          </div>
        </section>
      )}

      {staleSessions.length > 0 && (
        <section className="animate-enter space-y-2" style={{ animationDelay: enterDelay() }}>
          <div className="flex items-center gap-2 px-0.5">
            <span className="eyebrow flex items-baseline gap-1.5 text-stale">
              <span className="font-mono">02</span>已停止更新
            </span>
            <span className="h-px flex-1 bg-stale/20" />
          </div>
          <div className="divide-y divide-hairline/60 overflow-hidden rounded-item border border-hairline bg-card shadow-raised">
            {staleSessions.map((session) => (
              <div key={session.sessionId} className="flex items-center gap-3 bg-stale/[0.03] px-3.5 py-2.5">
                <AgentIcon agent={session.agent} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-detail font-medium">{session.title || "未命名任务"}</span>
                    <StatusDot status={session.status} size={7} />
                  </div>
                  <p className="mt-0.5 truncate text-meta text-muted-foreground">
                    {agentName(session.agent)} · {age(session.lastEventAt)}没有更新
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 空态：椋鸟群在栖枝上休憩——签名时刻，群鸟游动 + 峰点琥珀 */}
      {!activeSessions.length && !staleSessions.length && (
        <div className="animate-enter px-4 py-14 text-center" style={{ animationDelay: enterDelay() }}>
          <Murmuration size={120} className="mx-auto" />
          <p className="mt-4 text-body font-medium">现在很安静</p>
          <p className="mt-1.5 text-meta text-muted-foreground">启动一个工具后，Murmur 会在这里显示它的任务。</p>
        </div>
      )}
    </div>
  );
}

function agentName(agent: AgentId) {
  return AGENT_META[agent].name;
}

function waitingReason(reason?: WaitingReason) {
  if (reason === "approval") return "等待批准";
  if (reason === "question") return "等待回答";
  return "本轮完成，等待继续";
}

function age(at: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}
