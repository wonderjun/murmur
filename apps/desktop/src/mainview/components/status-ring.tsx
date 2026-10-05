/**
 * 状态环（StatusRing）：会话/agent 的圆形状态框——细环 + 中心内容
 * （通常是 mono 字形 AgentIcon）。环是独立叠层 span（absolute inset-0），
 * 动画只作用于环：working 玉绿配 ring-breathe 呼吸（只起伏不缩放，
 * breathe 含 scale 不适用环）、waiting 琥珀另叠 attention 脉冲层，
 * idle/stale/ended 静态对应色。容器本体不带动画——中心字形不跟环呼吸。
 * 中心字形常态 muted-foreground，working/waiting 提到 foreground 加强可读。
 */

import { cn } from "@/lib/utils";

import type { AgentStatus } from "@core/types";
import type { ReactNode } from "react";

/** 状态 → 环色 token；stale 哑光红警示、ended 是低亮度灰环。 */
const RING_COLOR: Record<AgentStatus, string> = {
  working: "var(--status-working)",
  waiting: "var(--status-waiting)",
  idle: "var(--status-idle)",
  stale: "var(--status-stale)",
  ended: "var(--status-ended)",
};

/** 状态环容器；size 默认 28 与会话行徽标同档。 */
export default function StatusRing({
  status,
  size = 28,
  children,
  className,
}: {
  status: AgentStatus;
  size?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        status === "working" || status === "waiting" ? "text-foreground" : "text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* 环本体：box-shadow 画环；working 呼吸只起环的透明度，不碰中心字形 */}
      <span
        aria-hidden="true"
        className={cn("absolute inset-0 rounded-full", status === "working" && "animate-ring-breathe")}
        style={{ boxShadow: `0 0 0 1.5px ${RING_COLOR[status]}` }}
      />
      {/* attention 改的是 box-shadow，与同位置环层并存（脉冲从环面扩散） */}
      {status === "waiting" && <span aria-hidden="true" className="absolute inset-0 rounded-full animate-attention" />}
      {children}
    </span>
  );
}
