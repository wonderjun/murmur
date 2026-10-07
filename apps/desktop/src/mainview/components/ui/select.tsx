/**
 * shadcn Select 的 murmur 版（radix-ui 底层）：trigger 是 bg-surface-1 + hairline
 * 的 meta 小号形态，content 走 bg-overlay 实色浮层 + shadow-float——surface-* 是
 * 半透明叠层，直接垫在浮层下会透出底下内容，浮层只用 --overlay / glass-*。
 * CUSTOMIZED: 全量 token 化改写（默认 palette → murmur 语义 token），细节见 ../CUSTOMIZATIONS.md。
 */

import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

import type { ComponentProps } from "react";

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        // CUSTOMIZED: trigger 底改 surface-1 叠层（raised 别名已退场）
        "flex items-center justify-between gap-1.5 rounded-md border border-hairline bg-surface-1 px-2 py-1 text-meta text-muted-foreground outline-none transition-colors duration-fast",
        "hover:text-foreground data-[state=open]:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50",
        "[&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={10} className="shrink-0 text-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position="popper"
        sideOffset={4}
        className={cn(
          // CUSTOMIZED: 浮层改 bg-overlay 实色 + shadow-float（surface-* 半透明，垫浮层会透底）
          "z-50 max-h-64 min-w-32 overflow-hidden rounded-lg border border-hairline bg-overlay text-foreground shadow-float",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "flex cursor-pointer select-none items-center gap-1.5 rounded-sm px-2 py-1 text-meta text-muted-foreground outline-none",
        // CUSTOMIZED: 高亮底改 surface-2 叠层（raised 别名已退场）
        "data-highlighted:bg-surface-2 data-highlighted:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator asChild>
        <Check size={10} className="shrink-0 text-foreground" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
