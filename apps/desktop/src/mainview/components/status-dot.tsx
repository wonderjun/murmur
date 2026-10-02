/** 签名元素：状态点。working=呼吸绿 waiting=脉冲琥珀 idle=灰 stale=红 ended=空心环。 */

import { cn } from "@/lib/utils";

import type { AgentStatus } from "@core/types";

const TONE: Record<AgentStatus, string> = {
  working: "bg-working animate-breathe",
  waiting: "bg-waiting animate-attention",
  idle: "bg-idle",
  stale: "bg-stale",
  ended: "border-[1.5px] border-ended bg-transparent",
};

export default function StatusDot({ status, size = 8, className }: { status: AgentStatus; size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-block shrink-0 rounded-full", TONE[status], className)}
      style={{ width: size, height: size }}
    />
  );
}
