/** BYOK 行：自填 API Key 的输入/掩码展示/清除 + 端点选择（zcode 等本机凭据加密不可读的 agent）。 */

import { useRef, useState } from "react";

import Segmented from "@/components/segmented";
import { BYOK_ENDPOINTS, BYOK_KEY_SOURCE, BYOK_REASON } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { KeyboardEvent } from "react";
import type { AgentSnapshot } from "@core/types";

export default function ByokRow({ agent }: { agent: AgentSnapshot }) {
  const setAgentKey = useMurmurStore((s) => s.setAgentKey);
  const readClipboard = useMurmurStore((s) => s.readClipboard);
  const [key, setKey] = useState("");
  const [base, setBase] = useState("");
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasKey = agent.byok?.hasKey ?? false;
  const source = BYOK_KEY_SOURCE[agent.agent] ?? "官方控制台";
  // 端点三段选：空值=自动（凭据不带 baseUrl，由 quota client 嗅探/兜底）；无候选不渲染。
  const endpoints = BYOK_ENDPOINTS[agent.agent] ?? [];
  const reason = BYOK_REASON[agent.agent] ?? "本机凭据不可用";
  const placeholder = agent.agent === "devin" ? "cog_…" : "sk-…";

  async function save() {
    const k = key.trim();
    if (!k) return;
    await setAgentKey(agent.agent, k, base || undefined);
    setKey("");
    setBase("");
  }

  async function clear() {
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(false);
    await setAgentKey(agent.agent, null);
  }

  /** ⌘/⌃V 粘贴兜底：菜单 keyEquivalent 未消费的事件才到这儿（原生已粘贴则不会双贴）。 */
  async function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void save();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      const el = e.currentTarget; // currentTarget 在 dispatch 结束后即置空，必须先捕获再 await。
      const text = await readClipboard().catch(() => null);
      if (!text) return;
      el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
      setKey(el.value);
    }
  }

  return (
    <div className="mt-2.5 border-t border-hairline/60 pl-9 pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-meta text-muted-foreground">额度 API Key</p>
          <p className="mt-0.5 text-meta leading-relaxed text-faint">
            {hasKey ? (
              <>
                已配置 <span className="font-mono">{agent.byok?.preview}</span>
              </>
            ) : (
              `${reason}；填入${source}的 API Key 后可拉取额度，只存本机（0600）`
            )}
          </p>
        </div>
        {hasKey && (
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-md border px-2.5 py-1 text-meta font-medium transition-colors duration-fast",
              armed
                ? "border-accent bg-accent-soft text-foreground"
                : "border-hairline bg-surface-1 text-muted-foreground hover:text-foreground",
            )}
            onClick={clear}
          >
            {armed ? "再点一次" : "清除"}
          </button>
        )}
      </div>

      {!hasKey && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => void onKeyDown(e)}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-surface-1 px-2 font-mono text-meta text-foreground outline-none transition-colors duration-fast placeholder:text-faint focus:border-foreground/30"
            />
            <button
              type="button"
              disabled={!key.trim()}
              className="shrink-0 rounded-md border border-hairline bg-surface-1 px-2.5 py-1 text-meta font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-40"
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
          {endpoints.length > 0 && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-meta text-faint">端点</span>
              <Segmented options={endpoints} value={base} onChange={setBase} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
