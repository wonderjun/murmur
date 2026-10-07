/** P0「暮色栖木」地基展件：暮色天光 / 表面叠层 / 字阶新档 / 单色字形 + 状态环。
 *  从 design-board 拆出守 400 行软上限，展件排在板面最前。 */

import AgentIcon from "@/components/agent-icon";
import Dawn from "@/components/dawn";
import StatusRing from "@/components/status-ring";
import { AGENT_META } from "@/lib/agent-meta";

import type { AgentId, AgentStatus } from "@core/types";

const AGENTS = Object.keys(AGENT_META) as AgentId[];

/* 七只栖位轮取状态，working/waiting 各两次看动效密度 */
const RING_STATUSES: AgentStatus[] = ["working", "waiting", "idle", "stale", "ended", "working", "waiting"];

function BoardHead({ children }: { children: string }) {
  return <h2 className="eyebrow mb-2.5 text-faint">{children}</h2>;
}

export default function BoardFoundation() {
  return (
    <>
      <section>
        <BoardHead>暮色天光（quiet 恒亮 / live 呼吸 · 琥珀 = 轮到你了）</BoardHead>
        <div className="flex gap-3">
          <div className="relative h-35 w-98 overflow-hidden rounded-item bg-background">
            <Dawn />
            <p className="relative p-4 text-headline font-semibold">
              <span className="font-data tabular-nums">2</span> 个任务
            </p>
          </div>
          <div className="relative h-35 w-98 overflow-hidden rounded-item bg-background">
            <Dawn live />
            <p className="relative p-4 text-headline font-semibold">
              <span className="font-data tabular-nums text-glow">2</span> 个任务
              <span className="text-muted-foreground"> / 轮到你了</span>
            </p>
          </div>
        </div>
      </section>

      <section>
        <BoardHead>表面叠层（surface-1/2/3 前景透明叠层 + overlay 浮层 · 不靠描边）</BoardHead>
        <div className="flex items-center gap-3">
          <div className="rounded-item bg-surface-1 p-2.5">
            <div className="rounded-row bg-surface-2 p-2.5">
              <div className="rounded-row bg-surface-3 px-3 py-2 text-meta text-muted-foreground">
                surface-1 → 2 → 3
              </div>
            </div>
          </div>
          <div className="rounded-item bg-overlay px-3 py-2 text-meta text-muted-foreground shadow-float">overlay</div>
        </div>
      </section>

      <section>
        <BoardHead>单色字形 + 状态环（mono AgentIcon · working 呼吸 / waiting 脉冲，下排彩色对照）</BoardHead>
        <div className="flex flex-wrap items-end gap-4">
          {AGENTS.map((a, i) => (
            <span key={a} className="flex flex-col items-center gap-1.5">
              <StatusRing status={RING_STATUSES[i]} size={28}>
                <AgentIcon agent={a} variant="mono" size={18} />
              </StatusRing>
              <span className="font-mono text-micro text-muted-foreground">{RING_STATUSES[i]}</span>
            </span>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          {AGENTS.map((a) => (
            <span key={a} className="flex flex-col items-center gap-1.5">
              <AgentIcon agent={a} size={28} />
              <span className="font-mono text-micro text-faint">{AGENT_META[a].name}</span>
            </span>
          ))}
        </div>
      </section>
    </>
  );
}
