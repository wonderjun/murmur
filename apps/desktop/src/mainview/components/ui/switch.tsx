/**
 * shadcn 生成的 Switch（radix-ui 底层），样式已改写为 murmur 语义 token：
 * 单色纪律——off=foreground/15 灰槽，on=前景色槽 + 底色滑块（暗色下白槽黑块、
 * 亮色下黑槽白块），不读 --accent，任何 data-agent 上下文里颜色一致。
 * CUSTOMIZED: 全量 token 化改写（默认 palette → murmur 语义 token），细节见 ../CUSTOMIZATIONS.md。
 */

import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

import type { ComponentProps } from "react";


function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-foreground/15 transition-colors duration-fast data-[disabled]:opacity-40 data-[state=checked]:bg-foreground",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-foreground shadow-raised transition-transform duration-fast data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-background"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
