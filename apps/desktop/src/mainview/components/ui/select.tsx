/**
 * shadcn Select 的 murmur 版（radix-ui 底层）：trigger 是 bg-raised + hairline
 * 的 meta 小号形态，content 走 bg-card + shadow-raised 浮层语言（与 ScrollArea
 * 同族 token 化，无彩色）。
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
        "flex items-center justify-between gap-1.5 rounded-md border border-hairline bg-raised px-2 py-1 text-meta text-muted-foreground outline-none transition-colors duration-fast",
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
          "z-50 max-h-64 min-w-32 overflow-hidden rounded-lg border border-hairline bg-card text-foreground shadow-raised",
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
        "flex cursor-pointer select-none items-center gap-1.5 rounded px-2 py-1 text-meta text-muted-foreground outline-none",
        "data-[highlighted]:bg-raised data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
