/**
 * shadcn Button 的 murmur 版：变体全走语义 token。
 * default 是 bg-raised + hairline 的次级按钮；inverse 是单色反相的强确认；
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
        default: "border-hairline bg-raised text-muted-foreground hover:text-foreground",
        inverse: "border-foreground/40 bg-foreground/10 text-foreground",
        ghost: "border-transparent text-faint hover:bg-raised hover:text-foreground",
        // 破坏性操作两段：软红态（常态可点）→ 实红态（armed 确认），同 token 两级递进。
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
        destructiveSoft: "border-destructive/40 bg-raised text-destructive hover:bg-destructive/10",
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
