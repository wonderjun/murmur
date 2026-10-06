/**
 * waiting 头条（hero）：动态页唯一的「轮到你了」卡——surface-1 叠层壳 +
 * 左侧 3px 琥珀边条 + 卡内局部天光（dawn-live 恒亮不呼吸，环境光语义：
 * 琥珀亮起 = 轮到你了）。
 * 多 waiting 时底部圆点 + 「下一个」轮换展示；动作行（复制路径 /
 * 在 Finder 显示 / 打开应用 ›）走 useSessionActions，与 agent-row 同源。
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { AGENT_META } from "@/lib/agent-meta";
import { fmtAge } from "@/lib/format";
import { waitingReasonLabel } from "@/lib/status-text";
import { hintLabel, useSessionActions } from "@/lib/use-session-actions";
import { cn } from "@/lib/utils";

import type { SessionSnapshot } from "@core/types";

/** waiting 会话卡列表轮换头条；「打开应用」唤起宿主 app 到台前。 */
export default function WaitingHero({ sessions }: { sessions: SessionSnapshot[] }) {
  const [idx, setIdx] = useState(0);
  const { reveal, copyCwd, focus, hint } = useSessionActions();
  const session = sessions[Math.min(idx, sessions.length - 1)];
  if (!session) return null;

  return (
    <section aria-live="polite" className="relative overflow-hidden rounded-item bg-surface-1">
      {/* 局部天光：quiet 档恒亮（面板级 Dawn 已是 live，卡内只留一点环境光） */}
      <span aria-hidden="true" className="dawn-quiet pointer-events-none absolute inset-0" />
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-waiting" />
      <div className="relative px-4 py-3.5">
        <p className="text-micro font-semibold tracking-[0.1em] text-waiting">
          轮到你了 · {AGENT_META[session.agent].name}
        </p>
        {/* 提问类等待直接把问题原文顶到标题位——"发生了什么"一瞥即读 */}
        <p className="mt-1.5 line-clamp-3 text-title font-medium leading-snug">
          {session.waitingReason === "question" && session.waitingDetail
            ? session.waitingDetail
            : session.title || "一个任务正在等你继续"}
        </p>
        <p className="mt-1 text-meta text-muted-foreground">
          {waitingReasonLabel(session.waitingReason)}
          {session.waitingReason !== "question" && session.waitingDetail ? ` · ${session.waitingDetail}` : ""}
          {` · 等了 ${fmtAge(session.statusAt)}`}
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          {session.cwd && (
            <Button size="sm" variant="ghost" onClick={() => copyCwd(session)}>
              复制路径
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void reveal(session)}>
            在 Finder 显示
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void focus(session)}>
            打开应用 ›
          </Button>
        </div>
        {hint?.sessionId === session.sessionId && (
          <p className="mt-1 text-micro text-faint">{hintLabel(hint)}</p>
        )}
      </div>
      {sessions.length > 1 && (
        <div className="relative flex items-center gap-2 border-t border-waiting/15 px-4 py-2">
          {sessions.map((s, i) => (
            <button
              key={s.sessionId}
              type="button"
              aria-label={`第 ${i + 1} 个待处理`}
              aria-current={i === idx}
              className={cn("h-1.5 w-1.5 rounded-full transition-colors duration-fast", i === idx ? "bg-waiting" : "bg-waiting/30")}
              onClick={() => setIdx(i)}
            />
          ))}
          <button
            type="button"
            className="ml-auto text-meta text-muted-foreground transition-colors duration-fast hover:text-foreground"
            onClick={() => setIdx((idx + 1) % sessions.length)}
          >
            {idx + 1}/{sessions.length} · 下一个 ›
          </button>
        </div>
      )}
    </section>
  );
}
