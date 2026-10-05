/**
 * shadcn Button 的 murmur 版：变体全走语义 token。
 * default 是 bg-surface-2 叠层的次级按钮；inverse 是单色反相的强确认；
 * ghost 无框弱交互；destructive/destructiveSoft 是删除确认的红（独立
 * --destructive token，与 status 红同色相但不占状态色语义）。
 * CUSTOMIZED: 全量 token 化改写（默认 palette → murmur 语义 token），细节见 ../CUSTOMIZATIONS.md。
 */

import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

import type { ComponentProps } from "react";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium outline-none transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // CUSTOMIZED: 暮色栖木——描边退场，次级按钮走叠层 surface-2 → hover surface-3
        default: "border-transparent bg-surface-2 text-muted-foreground hover:bg-surface-3 hover:text-foreground",
        inverse: "border-foreground/40 bg-foreground/10 text-foreground",
        // CUSTOMIZED: hover 走 surface-2 叠层（raised 别名已退场）
        ghost: "border-transparent text-faint hover:bg-surface-2 hover:text-foreground",
        // 破坏性操作两段：软红态（常态可点）→ 实红态（armed 确认），同 token 两级递进。
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // CUSTOMIZED: 软红底改 surface-1 叠层（raised 别名已退场）
        destructiveSoft: "border-destructive/40 bg-surface-1 text-destructive hover:bg-destructive/10",
      },
      size: {
        default: "h-6 px-2.5 text-meta [&_svg]:size-[11px]",
        sm: "h-5 px-2 text-meta [&_svg]:size-[10px]",
        icon: "h-5 w-5 p-0 [&_svg]:size-3",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
