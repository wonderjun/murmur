/**
 * 同名冲突裁决弹层（技能页）：syncAll 盘点出的 SyncConflict[] 逐条让用户选
 * 「覆盖」或「放弃」——全部裁决完才放「应用」，未决条目不进写面。
 *
 * 交互约束：同名不默认操作（用户明确要求的铁律），所以每行必须显式二选一，
 * 应用键在全裁决前禁用；「先跳过」等于本轮全部放弃（盘点照常，不改动任何文件）。
 * 技能覆盖把在位他人产物进废纸篓再挂软链；MCP 覆盖改目标配置里的同名条目值
 * 并烙归属。共享目录（~/.agents/skills 这类多 agent 共写）按 path 去重只出
 * 一行——覆盖一次即对全体引用生效。
 */

import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { SyncConflict } from "@core/types";

/** path 去重：共享 skills 目录会被多个 agent 各报一次同一落点。 */
export function dedupeConflicts(list: SyncConflict[]): SyncConflict[] {
  const seen = new Map<string, SyncConflict>();
  for (const c of list) if (!seen.has(c.path)) seen.set(c.path, c);
  return [...seen.values()];
}

export default function SyncConflicts({ conflicts, onClose }: { conflicts: SyncConflict[]; onClose: () => void }) {
  const syncAll = useMurmurStore((s) => s.syncAll);
  const rows = useMemo(() => dedupeConflicts(conflicts), [conflicts]);
  /** path → 用户裁决；undefined=未决。 */
  const [verdicts, setVerdicts] = useState<Record<string, "overwrite" | "skip">>({});
  const [applying, setApplying] = useState(false);

  const decided = rows.every((c) => verdicts[c.path] !== undefined);
  const overwriteCount = rows.filter((c) => verdicts[c.path] === "overwrite").length;

  async function apply() {
    setApplying(true);
    try {
      // 只有显式选「覆盖」的条目才进写面；放弃与误传进来的重复项一并滤掉。
      await syncAll(rows.filter((c) => verdicts[c.path] === "overwrite"));
    } finally {
      setApplying(false);
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩：只 dim 不毛玻璃（glass 系列留给浮层卡本身）。 */}
      <div className="absolute inset-0 bg-background/60" onClick={onClose} />
      <div
        role="dialog"
        className="glass-overlay relative flex max-h-[70vh] w-lg flex-col overflow-hidden rounded-item border border-hairline shadow-float"
        aria-label="同名冲突裁决"
      >
        <div className="flex items-center gap-2 border-b border-hairline/60 px-3 py-2.5">
          <TriangleAlert size={14} className="text-waiting" />
          <h2 className="text-body font-medium">同名冲突 {rows.length} 处</h2>
          <p className="ml-auto text-micro text-faint">逐条选「覆盖」或「放弃」</p>
        </div>
        <div className="min-h-0 flex-1 divide-y divide-hairline/60 overflow-y-auto">
          {rows.map((c) => {
            const v = verdicts[c.path];
            return (
              <div key={c.path} className="flex items-center gap-2.5 px-3 py-2">
                <span
                  data-agent={c.agent}
                  className="w-8 shrink-0 rounded-md bg-surface-2 px-1 py-0.5 text-center text-micro text-accent"
                  title={AGENT_META[c.agent].name}
                >
                  {AGENT_META[c.agent].abbr}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-meta font-medium">
                    <span className="text-faint">{c.kind === "skill" ? "技能" : "MCP"}</span> {c.name}
                  </p>
                  <p className="truncate font-data text-micro text-faint" title={c.path}>
                    {c.path}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant={v === "overwrite" ? "inverse" : "ghost"}
                    size="sm"
                    onClick={() => setVerdicts((m) => ({ ...m, [c.path]: "overwrite" }))}
                  >
                    覆盖
                  </Button>
                  <Button
                    variant={v === "skip" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setVerdicts((m) => ({ ...m, [c.path]: "skip" }))}
                  >
                    放弃
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 border-t border-hairline/60 px-3 py-2.5">
          <p className="min-w-0 flex-1 truncate text-micro text-faint">覆盖=在位他人产物进废纸篓；放弃=本轮保留现状</p>
          <Button variant="ghost" size="sm" onClick={onClose}>
            先跳过
          </Button>
          <Button
            size="sm"
            disabled={!decided || applying}
            className={cn(!decided && "opacity-60")}
            onClick={() => void apply()}
          >
            {applying ? "应用中…" : `应用选择${overwriteCount ? `（覆盖 ${overwriteCount}）` : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
