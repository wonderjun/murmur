/**
 * 椋鸟群（活的签名时刻）：26 个 seed 化伪随机圆点悬于栖枝上方缓慢游动，
 * 峰点琥珀 = murmur-mark 同构的「轮到你了」语义。投放空态。
 * 每点 --dx/--dy/--drift-dur/--drift-delay 驱动 drift keyframes 错峰漂移，
 * 纯 transform 动画；reduced-motion 由全局媒体查询一并降级。
 */

import { useMemo } from "react";

import { cn } from "@/lib/utils";

import type { CSSProperties } from "react";

const W = 120;
const H = 64;
const PERCH_Y = 55;
const DOT_COUNT = 26;

interface Bird {
  x: number;
  y: number;
  r: number;
  style: CSSProperties;
  opacity: number;
  isPeak: boolean;
}

/** mulberry32：固定 seed 的确定性伪随机——每次渲染同一片群，不闪不跳。 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function Murmuration({ size = 112, className }: { size?: number; className?: string }) {
  const birds = useMemo<Bird[]>(() => {
    const rand = mulberry32(20260922);
    /* 群云呈松散椭圆分布在枝上方：x 均匀铺开，y 集中中带长尾 */
    const dots = Array.from({ length: DOT_COUNT }, (_, i) => {
      const spread = Math.sin((i / DOT_COUNT) * Math.PI);
      return {
        x: 10 + rand() * (W - 20),
        y: 8 + rand() * (PERCH_Y - 18) * (0.55 + spread * 0.45),
        r: 0.9 + rand() * 1.5,
        opacity: 0.3 + rand() * 0.5,
        style: {
          "--dx": `${((rand() - 0.5) * 6).toFixed(1)}px`,
          "--dy": `${((rand() - 0.5) * 5).toFixed(1)}px`,
          "--drift-dur": `${(6 + rand() * 5).toFixed(1)}s`,
          "--drift-delay": `${(-rand() * 10).toFixed(1)}s`,
        } as CSSProperties,
        isPeak: false,
      };
    });
    /* 峰点取群云最高点（最小 y），放大 + 琥珀——与 murmur-mark 的峰点同构 */
    const peak = dots.reduce((a, b) => (a.y < b.y ? a : b));
    peak.isPeak = true;
    peak.r = 2.6;
    peak.opacity = 0.95;
    return dots;
  }, []);

  return (
    <svg
      width={size}
      height={size * (H / W)}
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      aria-hidden="true"
      className={cn("text-faint", className)}
    >
      {birds.map((b, i) => (
        <circle
          key={i}
          cx={b.x}
          cy={b.y}
          r={b.r}
          fill={b.isPeak ? "var(--status-waiting)" : "currentColor"}
          opacity={b.opacity}
          className="animate-drift"
          style={b.style}
        />
      ))}
      <path
        d={`M8 ${PERCH_Y} h${W - 16}`}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}
