/** agent 徽标：官方 logo 直出，圆角裁切保持方砖轮廓；mono 变体是
 *  currentColor 单色字形（不裁圆角、不铺底色），配 StatusRing 用。 */

import BrandIcon from "@/components/brand-icon";

import type { AgentId } from "@core/types";

export default function AgentIcon({
  agent,
  size = 30,
  variant = "brand",
}: {
  agent: AgentId;
  size?: number;
  variant?: "brand" | "mono";
}) {
  if (variant === "mono") {
    return (
      <span className="inline-flex shrink-0 items-center justify-center" data-agent={agent} style={{ width: size, height: size }}>
        <BrandIcon agent={agent} size={size} variant="mono" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden"
      data-agent={agent}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }}
    >
      <BrandIcon agent={agent} size={size} />
    </span>
  );
}
