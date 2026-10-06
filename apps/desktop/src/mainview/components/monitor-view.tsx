/** 动态视图：waiting hero（暮色天光卡）→「正在发生」分组 → 已停更清单
 *  → 最近结束折叠组（快照 recentlyEnded，grace 期短暂可见）。
 *  打开编排一次排定：刊头 0ms 先行（animate-enter），hero 120 / 正在发生 160 /
 *  已停更 200 / 最近结束 220 / 空态 160；切 tab main remount 重播（期望行为）。
 *  hero「打开应用」经 RPC 唤起会话宿主 app 到台前。 */

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import AgentRow from "@/components/agent-row";
import Murmuration from "@/components/murmuration";
import StatusDot from "@/components/status-dot";
import StatusRing from "@/components/status-ring";
import WaitingHero from "@/components/waiting-hero";
import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { fmtAge } from "@/lib/format";
import { allSessions } from "@/lib/selectors";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { SessionSnapshot } from "@core/types";

export default function MonitorView() {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const loading = useMurmurStore((s) => s.loading);
  const snapshotError = useMurmurStore((s) => s.snapshotError);
  const refresh = useMurmurStore((s) => s.refresh);

  const sessions = useMemo(() => allSessions(snapshot), [snapshot]);
  const waitingSessions = sessions.filter((s) => s.status === "waiting");
  const staleSessions = sessions.filter((s) => s.status === "stale");
  const activeSessions = sessions.filter((s) => ["waiting", "working"].includes(s.status));
  const activeAgents = (snapshot?.agents ?? []).filter((a) =>
    a.sessions.some((s) => ["waiting", "working"].includes(s.status)),
  );
  const recentlyEnded = snapshot?.recentlyEnded ?? [];
  // 「最近结束」折叠组：本地展开态，默认收起。
  const [endedOpen, setEndedOpen] = useState(false);

  if (loading) {
    return (
      <div className="space-y-3" aria-live="polite">
        <div className="h-20 animate-pulse rounded-item bg-surface-1" />
        <div className="h-14 animate-pulse rounded-item bg-surface-1" />
        <div className="h-14 animate-pulse rounded-item bg-surface-1" />
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
      {/* 头条：waiting 会话轮播——琥珀左边条 + 卡内天光，本页唯一 hero。 */}
      {waitingSessions.length > 0 && (
        <div className="animate-enter" style={{ animationDelay: "120ms" }}>
          <WaitingHero sessions={waitingSessions} />
        </div>
      )}

      {activeAgents.length > 0 && (
        <section className="animate-enter space-y-2" style={{ animationDelay: "160ms" }}>
          <div className="flex items-center gap-2 px-0.5">
            <span className="eyebrow text-faint">正在发生</span>
            <span className="h-px flex-1 bg-hairline" />
            <span className="font-data text-micro tabular-nums text-faint">{activeSessions.length}</span>
          </div>
          {/* 分组列表：surface-1 叠层 + hairline 分隔，AgentRow 自身不带卡片壳 */}
          <div className="divide-y divide-hairline/60 overflow-hidden rounded-item bg-surface-1">
            {activeAgents.map((agent) => (
              <AgentRow key={agent.agent} agent={agent} />
            ))}
          </div>
        </section>
      )}

      {staleSessions.length > 0 && (
        <section className="animate-enter space-y-2" style={{ animationDelay: "200ms" }}>
          <div className="flex items-center gap-2 px-0.5">
            <span className="eyebrow text-stale">已停止更新</span>
            <span className="h-px flex-1 bg-stale/20" />
            <span className="font-data text-micro tabular-nums text-stale/70">{staleSessions.length}</span>
          </div>
          <div className="divide-y divide-hairline/60 overflow-hidden rounded-item bg-surface-1">
            {staleSessions.map((session) => (
              <div key={session.sessionId} className="flex items-center gap-3 bg-stale/3 px-3.5 py-2.5">
                <StatusRing status={session.status} size={24}>
                  <AgentIcon agent={session.agent} variant="mono" size={24} />
                </StatusRing>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-detail font-medium">{session.title || "未命名任务"}</span>
                    <StatusDot status={session.status} size={7} />
                  </div>
                  <p className="mt-0.5 truncate text-meta text-muted-foreground">
                    {AGENT_META[session.agent].name} · {fmtAge(session.lastEventAt)}没有更新
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 最近结束：grace 期内的 ended 会话（快照 recentlyEnded），默认收起；无则不渲染。 */}
      {recentlyEnded.length > 0 && (
        <section className="animate-enter space-y-2" style={{ animationDelay: "220ms" }}>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-0.5"
            aria-expanded={endedOpen}
            onClick={() => setEndedOpen(!endedOpen)}
          >
            <span className="eyebrow text-faint">最近结束</span>
            <span className="h-px flex-1 bg-hairline" />
            <span className="font-data text-micro tabular-nums text-faint">{recentlyEnded.length}</span>
            <ChevronDown
              size={13}
              className={cn("text-faint transition-transform duration-normal", endedOpen && "rotate-180")}
            />
          </button>
          {endedOpen && (
            <div className="divide-y divide-hairline/60 overflow-hidden rounded-item bg-surface-1">
              {recentlyEnded.map((session) => (
                <EndedRow key={`${session.agent}:${session.sessionId}`} session={session} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* 空态：椋鸟群在栖枝上休憩——签名时刻，群鸟游动 + 峰点琥珀 */}
      {!activeSessions.length && !staleSessions.length && (
        <div className="animate-enter px-4 py-10 text-center" style={{ animationDelay: "160ms" }}>
          <Murmuration size={180} className="mx-auto" />
          <p className="mt-4 text-body font-medium">现在很安静</p>
          <p className="mt-1.5 text-meta text-muted-foreground">启动一个工具后，Murmur 会在这里显示它的任务。</p>
        </div>
      )}
    </div>
  );
}

/** 最近结束行：mono 徽标环 + 标题 + 相对结束时间，只读（ended 会话不再接动作）。 */
function EndedRow({ session }: { session: SessionSnapshot }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <StatusRing status="ended" size={24}>
        <AgentIcon agent={session.agent} variant="mono" size={24} />
      </StatusRing>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-detail font-medium">{session.title || "未命名任务"}</span>
          <StatusDot status="ended" size={7} />
        </div>
        <p className="mt-0.5 truncate text-meta text-muted-foreground">
          {AGENT_META[session.agent].name} · {fmtAge(session.endedAt ?? session.lastEventAt)}结束
        </p>
      </div>
    </div>
  );
}
