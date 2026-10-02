/** 栖枝：一根两端渐隐的细枝承起 5 只「鸟」（agent 状态点），签名元素。
 *  珠宝化规格：9px 点（比会话行大）+ 渐变枝（不再与普通 hairline 同规格）
 *  + 状态切换时 hop 鸟跳（key remount，入场按序错峰 55ms）。 */

import { useMemo } from "react";

import StatusDot from "@/components/status-dot";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentStatus } from "@core/types";

export default function PerchStrip({ className }: { className?: string }) {
  const snapshot = useMurmurStore((s) => s.snapshot);

  /** 每个 agent 取会话最高优先级状态，无会话/未安装一律灰寂。 */
  const birds = useMemo(
    () =>
      AGENT_ORDER.map((agent) => {
        const sessions = snapshot?.agents.find((a) => a.agent === agent)?.sessions ?? [];
        const status: AgentStatus =
          (["waiting", "working", "stale"] as AgentStatus[]).find((t) => sessions.some((s) => s.status === t)) ??
          "idle";
        return { agent, status };
      }),
    [snapshot],
  );

  const label = birds.map((b) => `${AGENT_META[b.agent].name} ${b.status}`).join("，");

  return (
    <div className={cn("relative flex h-3.5 items-center justify-between px-1", className)} role="img" aria-label={label}>
      {/* 枝条两端渐隐：与普通分隔线拉开档次，读作「栖枝」而非分隔线 */}
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-hairline to-transparent" />
      {birds.map((bird, i) => (
        <span
          key={bird.agent}
          data-agent={bird.agent}
          className="relative flex items-center justify-center rounded-full bg-background p-[3px]"
        >
          {/* 状态切换即 remount 播 hop；首次入场按栖位错峰，群鸟依次落枝 */}
          <span key={bird.status} className="animate-hop flex" style={{ animationDelay: `${i * 55}ms` }}>
            <StatusDot status={bird.status} size={9} />
          </span>
        </span>
      ))}
    </div>
  );
}
