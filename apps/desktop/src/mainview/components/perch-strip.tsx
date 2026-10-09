/** 栖枝：一根两端渐隐的微弧细枝承起若干只「鸟」（agent 状态点），签名元素。
 *  珠宝化规格：SVG 微弧枝（中间略抬 3 单位，linearGradient 两端渐隐）+
 *  11px StatusDot（working 呼吸 / waiting 脉冲 + 琥珀晕环）+ bg-background
 *  晕环压枝；状态切换播 land 落枝（key remount，入场错峰 80ms + i*45ms，
 *  跟在刊头 animate-enter 之后依次落枝）。
 *  只栖「已安装且监听开启」的鸟（与「已连接」计数同口径）：停用/未装不占位，
 *  栖位随鸟数动态均分——agent 全集扩张与极客清空两边都不塌。
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

/** 栖位 y 偏移：鸟心沿枝弧悬浮，弧方程 y=11.5-6t(1-t) 恒在鸟心下 1.5px，
 *  lift = -6t(1-t)。t 为栖位（均分枝长，单鸟独占中点 apex）。 */
function birdLift(i: number, n: number) {
  const t = n <= 1 ? 0.5 : i / (n - 1);
  return -6 * t * (1 - t);
}

export default function PerchStrip({ className }: { className?: string }) {
  const snapshot = useMurmurStore((s) => s.snapshot);
  /* 渐变 id 用 useId 生成——同页多个 PerchStrip（刊头 + 设计板展件）不写死 id。 */
  const fadeId = useId();

  /** 每只在栖鸟取会话最高优先级状态，无会话一律灰寂；
      栖位只给「已安装且监听开启」的 agent（观测面=弹窗面，与已连接计数同口径）。 */
  const birds = useMemo(() => {
    const list: { agent: (typeof AGENT_ORDER)[number]; status: AgentStatus }[] = [];
    for (const agent of AGENT_ORDER) {
      const snap = snapshot?.agents.find((a) => a.agent === agent);
      if (!snap?.install.installed || snap.disabled) continue;
      const status: AgentStatus =
        (["waiting", "working", "stale"] as AgentStatus[]).find((t) => snap.sessions.some((s) => s.status === t)) ??
        "idle";
      list.push({ agent, status });
    }
    return list;
  }, [snapshot]);

  /* 全停用时栖枝整根隐去，不留无鸟裸线当谜面。 */
  if (!birds.length) return null;

  const label = birds.map((b) => `${AGENT_META[b.agent].name} ${STATUS_TEXT[b.status]}`).join("，");

  return (
    <div
      className={cn(
        "relative flex h-5 items-center px-1",
        birds.length === 1 ? "justify-center" : "justify-between",
        className,
      )}
      role="group"
      aria-label={label}
    >
      {/* 枝条微弧（中点略高），linearGradient 做两端渐隐——读作「栖枝」而非分隔线 */}
      <svg
        className="absolute inset-0 size-full text-hairline"
        viewBox="0 0 100 20"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={fadeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="0.15" stopColor="currentColor" />
            <stop offset="0.85" stopColor="currentColor" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0 11.5 Q 50 8.5 100 11.5"
          fill="none"
          stroke={`url(#${fadeId})`}
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {birds.map((bird, i) => (
        <button
          key={bird.agent}
          type="button"
          data-agent={bird.agent}
          aria-label={`${AGENT_META[bird.agent].name} ${STATUS_TEXT[bird.status]}`}
          className="group relative flex items-center justify-center"
          style={{ transform: `translateY(${birdLift(i, birds.length)}px)` }}
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
              className={cn(
                "animate-land flex rounded-full",
                bird.status === "waiting" && "shadow-[0_0_0_4px_var(--status-waiting-glow)]",
              )}
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
