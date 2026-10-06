/** 栖枝：一根两端渐隐的微弧细枝承起 7 只「鸟」（agent 状态点），签名元素。
 *  珠宝化规格：SVG 微弧枝（中间略抬 3 单位，linearGradient 两端渐隐）+
 *  11px StatusDot（working 呼吸 / waiting 脉冲 + 琥珀晕环）+ bg-background
 *  晕环压枝；状态切换播 land 落枝（key remount，入场错峰 80ms + i*45ms，
 *  跟在刊头 animate-enter 之后依次落枝）。
 *  hover/focus 出玻璃小标签（group-hover + tip-in，不引 ChartTip）。 */

import { useId, useMemo } from "react";

import StatusDot from "@/components/status-dot";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentStatus } from "@core/types";

const STATUS_TEXT: Record<AgentStatus, string> = {
  working: "进行中",
  waiting: "待处理",
  idle: "空闲",
  stale: "疑似卡住",
  ended: "已结束",
};

/** 栖位 y 偏移：跟随枝弧（中点略高），7 只按序写死。 */
const BIRD_Y = [0, -0.9, -1.4, -1.5, -1.4, -0.9, 0];

export default function PerchStrip({ className }: { className?: string }) {
  const snapshot = useMurmurStore((s) => s.snapshot);
  /* 渐变 id 用 useId 生成——同页多个 PerchStrip（刊头 + 设计板展件）不写死 id。 */
  const fadeId = useId();

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

  const label = birds.map((b) => `${AGENT_META[b.agent].name} ${STATUS_TEXT[b.status]}`).join("，");

  return (
    <div className={cn("relative flex h-5 items-center justify-between px-1", className)} role="group" aria-label={label}>
      {/* 枝条微弧（中点略高），linearGradient 做两端渐隐——读作「栖枝」而非分隔线 */}
      <svg className="absolute inset-0 h-full w-full text-hairline" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={fadeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="0.15" stopColor="currentColor" />
            <stop offset="0.85" stopColor="currentColor" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M0 11.5 Q 50 8.5 100 11.5" fill="none" stroke={`url(#${fadeId})`} strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
      </svg>
      {birds.map((bird, i) => (
        <button
          key={bird.agent}
          type="button"
          data-agent={bird.agent}
          aria-label={`${AGENT_META[bird.agent].name} ${STATUS_TEXT[bird.status]}`}
          className="group relative flex items-center justify-center"
          style={{ transform: `translateY(${BIRD_Y[i]}px)` }}
        >
          {/* hover/focus 小标签：纯 CSS 显形，玻璃浮层材料 */}
          <span
            aria-hidden="true"
            className="glass-overlay pointer-events-none absolute -top-6 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-micro text-foreground opacity-0 transition-opacity duration-fast group-hover:animate-tip-in group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {AGENT_META[bird.agent].name}
          </span>
          {/* 晕环压枝：bg-background 圆晕把枝线从点下挤开 */}
          <span className="flex items-center justify-center rounded-full bg-background p-0.75">
            {/* 状态切换即 remount 播 land；首次入场按栖位错峰，群鸟依次落枝。
                waiting 鸟额外一圈琥珀晕环，一眼锁定「轮到你了」 */}
            <span
              key={bird.status}
              className={cn("animate-land flex rounded-full", bird.status === "waiting" && "shadow-[0_0_0_4px_var(--status-waiting-glow)]")}
              style={{ animationDelay: `${80 + i * 45}ms` }}
            >
              <StatusDot status={bird.status} size={11} hasSrText={false} />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
