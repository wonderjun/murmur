/** 刊头：murmur-mark + headline 状态头条（面板开口说的第一句话）+ 副句
 *  （等待对象/在跑工具/安静日期的 folio），下方横贯栖枝签名。
 *  绝对定位浮于滚动区之上（glass-chrome），高度计入 --chrome-top。 */

import { useMemo } from "react";

import AnimatedNumber from "@/components/animated-number";
import MurmurMark from "@/components/murmur-mark";
import PerchStrip from "@/components/perch-strip";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { allSessions, waitingCount, workingCount } from "@/lib/selectors";
import { waitingReasonLabel } from "@/lib/status-text";
import { useMurmurStore } from "@/store/murmur";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function MurmurHeader() {
  const snapshot = useMurmurStore((s) => s.snapshot);

  const sessions = useMemo(() => allSessions(snapshot), [snapshot]);
  const waiting = useMemo(() => waitingCount(snapshot), [snapshot]);
  const working = useMemo(() => workingCount(snapshot), [snapshot]);

  const agents = snapshot?.agents ?? [];
  const connected = agents.filter((a) => a.install.installed && !a.disabled).length;

  /* 面板失焦即关，日期取挂载时刻即可（不随时间刷新），计数跟随快照。
     分母是 agent 全集（快照未到时也按 7 口径），不写死字面量。 */
  const folio = useMemo(() => {
    const d = new Date();
    return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}月${d.getDate()}日 · 已接入 ${connected}/${agents.length || AGENT_ORDER.length}`;
  }, [connected, agents.length]);

  /* 副句：waiting 报首个等待对象（+ 仍在跑数），纯 working 报工具名列表，
     全静时回落 folio（日期 · 已接入）。 */
  const subline = useMemo(() => {
    const firstWaiting = sessions.find((s) => s.status === "waiting");
    if (firstWaiting) {
      const tail = working > 0 ? ` · 还有 ${working} 个在跑` : "";
      return `${AGENT_META[firstWaiting.agent].name} ${waitingReasonLabel(firstWaiting.waitingReason)}${tail}`;
    }
    if (working > 0) {
      const names = [...new Set(sessions.filter((s) => s.status === "working").map((s) => AGENT_META[s.agent].name))];
      const list = names.slice(0, 3).join("、");
      return `${list}${names.length > 3 ? ` 等 ${names.length} 个` : ""}正在工作`;
    }
    return folio;
  }, [sessions, working, folio]);

  return (
    <header className="animate-enter px-5 pb-3 pt-4">
      <div className="flex items-start gap-3">
        <MurmurMark size={28} live={waiting > 0} className="mt-0.75 text-foreground" />
        <div className="min-w-0 flex-1">
          {/* 状态头条：headline 档当家；waiting 时数字琥珀 */}
          <p className="text-headline font-semibold tracking-tight">
            {waiting > 0 ? (
              <>
                <AnimatedNumber value={waiting} className="font-data text-waiting" />
                <span className="ml-1.5">个任务轮到你了</span>
              </>
            ) : working > 0 ? (
              <>
                <AnimatedNumber value={working} className="font-data" />
                <span className="ml-1.5">个工具正在干活</span>
              </>
            ) : (
              "现在很安静"
            )}
          </p>
          <p className="mt-1 text-meta text-muted-foreground">{subline}</p>
        </div>
      </div>

      <PerchStrip className="mt-3.5" />
    </header>
  );
}
