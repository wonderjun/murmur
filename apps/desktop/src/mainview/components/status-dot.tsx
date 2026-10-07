/** 签名元素：状态点。working=呼吸绿 waiting=脉冲琥珀 idle=灰 stale=红 ended=空心环。
 *  纯色块无文本语义，内置 visually-hidden 状态词供读屏（容器已有可感知文案时听感略重复，可接受）。 */

import { cn } from "@/lib/utils";

import type { AgentStatus } from "@core/types";

const TONE: Record<AgentStatus, string> = {
  working: "bg-working animate-breathe",
  waiting: "bg-waiting animate-attention",
  idle: "bg-idle",
  stale: "bg-stale",
  ended: "border-1.5 border-ended bg-transparent",
};

const STATUS_TEXT: Record<AgentStatus, string> = {
  working: "进行中",
  waiting: "待处理",
  idle: "空闲",
  stale: "疑似卡住",
  ended: "已结束",
};

export default function StatusDot({
  status,
  size = 8,
  className,
  hasSrText = true,
}: {
  status: AgentStatus;
  size?: number;
  className?: string;
  /** 容器已自带可感知状态文案（agent-row 旗标、栖枝 aria-label）时关掉，防读屏重复。 */
  hasSrText?: boolean;
}) {
  return (
    <span
      className={cn("inline-block shrink-0 rounded-full", TONE[status], className)}
      style={{ width: size, height: size }}
    >
      {hasSrText && <span className="sr-only">{STATUS_TEXT[status]}</span>}
    </span>
  );
}
