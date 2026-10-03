/**
 * 会话状态文案唯一真源：monitor-view（hero）与 agent-row（明细行）共用，
 * 防两处措辞漂移。细分口径：waiting 带原因+等待对象，working 带相位
 * （thinking=模型往返中 / tool=工具执行中），无细粒度源的会话回落粗文案。
 */

import { relAgo } from "@/lib/format";

import type { SessionSnapshot, WaitingReason, WorkingPhase } from "@core/types";

/** waiting 细分原因短签（hero/通知/徽标共用）。 */
export function waitingReasonLabel(reason?: WaitingReason): string {
  if (reason === "approval") return "等待批准";
  if (reason === "question") return "等待回答";
  return "本轮完成，等待继续";
}

/** working 相位短签。 */
export function phaseLabel(phase?: WorkingPhase): string {
  if (phase === "tool") return "调用工具";
  if (phase === "thinking") return "思考中";
  return "工作中";
}

/** 会话行状态明细一句话：waiting 带对象（审批命令/问题摘要），working 带相位与工具名。 */
export function sessionStatusText(s: SessionSnapshot): string {
  if (s.status === "waiting") {
    const reason =
      s.waitingReason === "approval" ? "等待批准" : s.waitingReason === "question" ? "等待回答" : "等待继续";
    return `${reason}${s.waitingDetail ? ` · ${s.waitingDetail}` : ""}`;
  }
  if (s.status === "working") {
    if (s.phase === "tool") return `调用工具${s.toolName ? ` · ${s.toolName}` : ""}`;
    return s.phase === "thinking" ? "思考中" : "工作中";
  }
  if (s.status === "stale") return `最后更新 ${relAgo(s.lastEventAt)}`;
  return `更新于 ${relAgo(s.lastEventAt)}`;
}

/** 轻量时间线条目：发起 / 最近工具调用 / 等待开始，缺项不产。 */
export function sessionTimeline(s: SessionSnapshot): { label: string; at: number }[] {
  const out: { label: string; at: number }[] = [];
  if (s.turnStartAt) out.push({ label: "发起", at: s.turnStartAt });
  if (s.toolCallAt) out.push({ label: s.toolName ? `工具 ${s.toolName}` : "工具调用", at: s.toolCallAt });
  if (s.status === "waiting") out.push({ label: "等待中", at: s.statusAt });
  return out;
}
