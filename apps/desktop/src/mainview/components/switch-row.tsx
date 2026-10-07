/** 设置行：标题 + 说明 + 右侧开关。开关是单色件（前景/底色反相），不随 agent 变色。 */

import { Switch } from "@/components/ui/switch";

import type { ReactNode } from "react";

export default function SwitchRow({
  label,
  desc,
  checked,
  disabled = false,
  onCheckedChange,
  children,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange?: (value: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-detail font-medium text-foreground">{label}</p>
        {desc && <p className="mt-0.5 text-meta/relaxed text-muted-foreground">{desc}</p>}
        {children}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}
