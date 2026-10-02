/** agent 徽标：官方 logo 直出，圆角裁切保持方砖轮廓；不再做 accent 颜色渲染。 */

import BrandIcon from "@/components/brand-icon";

import type { AgentId } from "@core/types";

export default function AgentIcon({ agent, size = 30 }: { agent: AgentId; size?: number }) {
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
