/** 与 dock 同构的抽象 murmuration：点群波浪悬于栖枝，峰点琥珀（--status-waiting）=「轮到你了」。
 *  live 时峰点慢呼吸——刊头用它把「有待处理」写进品牌印里。 */

import { cn } from "@/lib/utils";

export default function MurmurMark({
  size = 22,
  className,
  live = false,
}: {
  size?: number;
  className?: string;
  live?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn(className)}>
      <circle cx="6.5" cy="17.5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="13.5" r="2.2" fill="currentColor" />
      <circle cx="19" cy="11" r="3.3" fill="var(--status-waiting)" className={live ? "animate-hero-breathe" : undefined} />
      <circle cx="25.5" cy="15" r="2.1" fill="currentColor" />
      <path d="M4 25h24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
