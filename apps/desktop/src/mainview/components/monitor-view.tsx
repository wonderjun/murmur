/** 动态视图：尺规索引条（计数 + 新鲜度）→ waiting 琥珀头条 → 编号分组列表 → 已停更清单
 *  → 最近结束折叠组（快照 recentlyEnded，grace 期短暂可见）。
 *  版块入场 stagger（enter + 序位 delay）；空态投放椋鸟群签名时刻。
 *  waiting hero 可点击：滚动到「正在发生」里的目标 AgentRow 并展开（data-agent-row 锚）。 */

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import AgentRow from "@/components/agent-row";
import AnimatedNumber from "@/components/animated-number";
import Murmuration from "@/components/murmuration";
import StatusDot from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { fmtTokens } from "@/lib/format";
import { allSessions, todayTokens } from "@/lib/selectors";
import { waitingReasonLabel } from "@/lib/status-text";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentId, SessionSnapshot } from "@core/types";

export default function MonitorView() {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const loading = useMurmurStore((s) => s.loading);
  const snapshotError = useMurmurStore((s) => s.snapshotError);
  const refresh = useMurmurStore((s) => s.refresh);

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
  const recentlyEnded = snapshot?.recentlyEnded ?? [];
  // 「最近结束」折叠组：本地展开态，默认收起。
  const [endedOpen, setEndedOpen] = useState(false);
  // hero 点击定位：对目标 agent 的 AgentRow 发展开信号（递增计数驱动 effect）。
  const [expandSignals, setExpandSignals] = useState<Partial<Record<AgentId, number>>>({});

  function focusAgent(agent: AgentId) {
    setExpandSignals((m) => ({ ...m, [agent]: (m[agent] ?? 0) + 1 }));
    // 等展开信号落地后再滚动；行头锚点常在（不受 0fr 折叠高度影响）。
    requestAnimationFrame(() => {
      document.querySelector(`[data-agent-row="${agent}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

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

  // 永无数据 + 刷新失败 ≠ 空态：显式失败态 + 重试；有旧快照时沿用现有渲染不挡。
  if (snapshotError && !snapshot) {
    return (
      <div className="px-4 py-14 text-center" role="alert">
        <p className="text-body font-medium">连接主进程失败</p>
        <p className="mt-1.5 text-meta text-muted-foreground">面板暂时联系不上主进程，稍候可重试。</p>
        <Button size="sm" className="mt-4" onClick={() => void refresh()}>
          重试
        </Button>
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

      {/* 头条：waiting 的第一条会话——琥珀左边条 + 慢呼吸光晕 + 淡染卡面，本页唯一 hero。
          点击滚动到「正在发生」的对应行并展开（waiting 会话必在 01 分组里）。 */}
      {waitingSessions.length > 0 && (
        <section
          className="animate-enter relative cursor-pointer overflow-hidden rounded-item border border-waiting/25 bg-waiting/[0.06] shadow-raised focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-foreground/45"
          style={{ animationDelay: enterDelay() }}
          aria-live="polite"
          role="button"
          tabIndex={0}
          onClick={() => focusAgent(waitingSessions[0].agent)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              focusAgent(waitingSessions[0].agent);
            }
          }}
        >
          <span className="animate-hero-breathe pointer-events-none absolute -left-8 -top-10 h-24 w-44 rounded-full bg-waiting/15 blur-2xl" />
          <span className="absolute inset-y-0 left-0 w-[3px] bg-waiting" />
          <div className="px-4 py-3.5">
            <p className="text-micro font-semibold tracking-[0.1em] text-waiting">
              轮到你了 · {agentName(waitingSessions[0].agent)}
            </p>
            <p className="mt-1.5 text-title font-medium leading-snug">
              {/* 提问类等待直接把问题原文顶到标题位——"发生了什么"一瞥即读 */}
              {waitingSessions[0].waitingReason === "question" && waitingSessions[0].waitingDetail
                ? waitingSessions[0].waitingDetail
                : waitingSessions[0].title || "一个任务正在等你继续"}
            </p>
            <p className="mt-1 text-meta text-muted-foreground">
              {waitingReasonLabel(waitingSessions[0].waitingReason)}
              {waitingSessions[0].waitingReason !== "question" && waitingSessions[0].waitingDetail
                ? ` · ${waitingSessions[0].waitingDetail}`
                : ""}{" "}
              · 等了 {age(waitingSessions[0].statusAt)}
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
              <AgentRow key={agent.agent} agent={agent} expandSignal={expandSignals[agent.agent]} />
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

      {/* 最近结束：grace 期内的 ended 会话（快照 recentlyEnded），默认收起；无则不渲染。 */}
      {recentlyEnded.length > 0 && (
        <section className="animate-enter space-y-2" style={{ animationDelay: enterDelay() }}>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-0.5"
            aria-expanded={endedOpen}
            onClick={() => setEndedOpen(!endedOpen)}
          >
            <span className="eyebrow flex items-baseline gap-1.5 text-faint">
              <span className="font-mono">03</span>最近结束
            </span>
            <span className="h-px flex-1 bg-hairline" />
            <span className="font-mono text-micro tabular-nums text-faint">{recentlyEnded.length}</span>
            <ChevronDown
              size={13}
              className={cn("text-faint transition-transform duration-normal", endedOpen && "rotate-180")}
            />
          </button>
          {endedOpen && (
            <div className="divide-y divide-hairline/60 overflow-hidden rounded-item border border-hairline bg-card shadow-raised">
              {recentlyEnded.map((session) => (
                <EndedRow key={`${session.agent}:${session.sessionId}`} session={session} />
              ))}
            </div>
          )}
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

/** 最近结束行：徽标 + 标题 + 相对结束时间 + 空心环，只读（ended 会话不再接动作）。 */
function EndedRow({ session }: { session: SessionSnapshot }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <AgentIcon agent={session.agent} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-detail font-medium">{session.title || "未命名任务"}</span>
          <StatusDot status="ended" size={7} />
        </div>
        <p className="mt-0.5 truncate text-meta text-muted-foreground">
          {agentName(session.agent)} · {age(session.endedAt ?? session.lastEventAt)}结束
        </p>
      </div>
    </div>
  );
}

function agentName(agent: AgentId) {
  return AGENT_META[agent].name;
}

function age(at: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}
