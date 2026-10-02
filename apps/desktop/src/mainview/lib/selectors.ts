/**
 * 快照派生选择器：纯函数，组件内经 useMemo/useShallow 消费。
 * zustand selector 每次渲染求值——返回数组/对象的派生不直接当 selector，
 * 统一取 `s.snapshot` 原始字段后在此聚合。
 */

import type { AgentSnapshot, AppSnapshot, SessionSnapshot } from "@core/types";

/** 活跃 agent：被停用监听的快照里本来就不挂，双保险再滤一层。 */
export function observedAgents(snapshot: AppSnapshot | null): AgentSnapshot[] {
  return snapshot?.agents.filter((a) => !a.disabled) ?? [];
}

export function allSessions(snapshot: AppSnapshot | null): SessionSnapshot[] {
  return observedAgents(snapshot).flatMap((a) => a.sessions);
}

export function waitingCount(snapshot: AppSnapshot | null): number {
  return allSessions(snapshot).filter((s) => s.status === "waiting").length;
}

export function workingCount(snapshot: AppSnapshot | null): number {
  return allSessions(snapshot).filter((s) => s.status === "working").length;
}

export function installedAgents(snapshot: AppSnapshot | null): AgentSnapshot[] {
  return observedAgents(snapshot).filter((a) => a.install.installed);
}

/** 今日全量 token 合计。 */
export function todayTokens(snapshot: AppSnapshot | null): number {
  return observedAgents(snapshot).reduce((sum, a) => sum + (a.today?.tokens ?? 0), 0);
}
