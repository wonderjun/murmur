/**
 * agent 展示元数据：名称、缩写、accent 变量名。
 * accent 走 data-agent 属性 → CSS var(--accent)，组件不写死颜色。
 */

import type { AgentId } from "@core/types";

export const AGENT_META: Record<AgentId, { name: string; abbr: string }> = {
  kimi: { name: "Kimi Code", abbr: "K" },
  zcode: { name: "ZCode", abbr: "Z" },
  opencode: { name: "OpenCode", abbr: "O" },
  codex: { name: "Codex", abbr: "X" },
  cursor: { name: "Cursor", abbr: "⌘" },
};

export const AGENT_ORDER: AgentId[] = ["kimi", "zcode", "opencode", "codex", "cursor"];

/**
 * 关闭 hook 上报的降级说明（设置页开关下展示）：push 平面撤掉后退回 pull 轮询，
 * token 台账不受影响（用量本来就走 pull）。
 */
export const HOOK_IMPACT: Record<AgentId, string> = {
  kimi: "关闭后退回 wire.jsonl 轮询：状态与「轮到你了」提示延迟数秒，用量统计不受影响",
  zcode: "关闭后丢失审批与实时回合结束信号，退回任务表轮询",
  opencode: "关闭后退回 2s 事件表轮询，实时性略降",
  codex: "关闭后退回 rollout 文件 tail；重新开启可能需在 codex /hooks 重新信任",
  cursor: "关闭后 CLI 会话活性退回 meta.json 启发式轮询，延迟约十秒",
};

/** 关闭整个监听的后果说明（设置页主开关下展示）。 */
export const OBSERVE_IMPACT = "停止读取该工具的本地数据：会话状态、用量、额度全部不再更新";
