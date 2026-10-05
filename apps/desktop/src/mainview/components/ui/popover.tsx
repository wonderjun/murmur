/**
 * shadcn Popover 的 murmur 版（radix-ui 底层）：content 走 glass-overlay 浮层材料
 * （与 ChartTip 浮卡同族），rounded-item + hairline + shadow-float，无彩色。
 * CUSTOMIZED: 全量 token 化改写（默认 palette → murmur 语义 token），细节见 ../CUSTOMIZATIONS.md。
 */

import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

import type { ComponentProps } from "react";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // CUSTOMIZED: shadow-overlay 别名退场，浮层直走 shadow-float
          "glass-overlay z-50 w-72 rounded-item border border-hairline p-1 text-foreground shadow-float outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
