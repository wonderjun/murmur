/**
 * 数值跳动：值变即重挂载播放 num-in 上滑入场，父容器溢出裁剪成「转轮」观感。
 * 只动新值一侧——10~22px 字号下旧值退场不可感知，省掉双层交叉的复杂度。
 */

import { cn } from "@/lib/utils";

export default function AnimatedNumber({ value, className }: { value: string | number; className?: string }) {
  return (
    <span className={cn("inline-flex overflow-hidden", className)}>
      <span key={String(value)} className="animate-num-in tabular-nums">
        {value}
      </span>
    </span>
  );
}
