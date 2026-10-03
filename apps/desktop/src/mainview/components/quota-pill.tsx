/** 额度窗口胶囊：标签 + 用量百分比 + 迷你进度槽 + 重置倒计时。
 *  阈值语义与 setup-view 的额度条同规：≥70% 前景加重、≥90% 红；
 *  琥珀只属于「轮到你了」，正常态进度底色一律前景 50%（idle 是状态色，不做进度条）。 */

import { fmtQuotaHeadline } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { QuotaWindow } from "@core/types";

export default function QuotaPill({ window: w }: { window: QuotaWindow }) {
  const warn = w.usedPct >= 70 && w.usedPct < 90;
  const danger = w.usedPct >= 90;

  let countdown = "";
  if (w.resetsAt) {
    const ms = w.resetsAt - Date.now();
    if (ms <= 0) {
      countdown = "重置中";
    } else {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const d = Math.floor(h / 24);
      countdown = d > 0 ? `${d}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
    }
  }

  const parts = [w.label];
  if (w.used !== undefined && w.limit !== undefined && w.limit > 0) {
    parts.push(`${fmt(w.used)} / ${fmt(w.limit)}`);
  }
  if (w.resetsAt) parts.push(`重置 ${new Date(w.resetsAt).toLocaleString()}`);
  const title = parts.join(" · ");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-hairline bg-raised px-2.5 py-1 font-mono text-micro leading-none",
        danger ? "text-stale" : warn ? "text-foreground" : "text-muted-foreground",
      )}
      title={title}
    >
      <span className="font-sans font-medium">{w.label}</span>
      <span className="tabular-nums">{fmtQuotaHeadline(w)}</span>
      <span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-foreground/10">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", danger ? "bg-stale" : warn ? "bg-foreground" : "bg-foreground/50")}
          style={{ width: `${w.usedPct}%` }}
        />
      </span>
      {countdown && <span className="text-faint tabular-nums">{countdown}</span>}
    </span>
  );
}

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}
