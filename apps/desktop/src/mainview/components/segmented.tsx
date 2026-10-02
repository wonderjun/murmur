/** 分段选择器：bg-muted 轨道 + 选中 bg-raised + hairline 描边，与底栏 tabs 同视觉语言。 */

import { cn } from "@/lib/utils";

export default function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-muted p-0.5" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-meta font-medium transition-colors duration-fast",
            opt.value === value
              ? "border-hairline bg-raised text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
