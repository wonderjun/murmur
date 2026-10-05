/**
 * 会话行动作 hook：Finder 定位（revealSession 走主进程 lastSessionScan 缓存，
 * miss 返回 false 时行内提示，不静默）+ 复制 cwd（writeClipboard）+
 * 行内提示 3 秒自动淡出。agent-row 与 waiting-hero 共用，防两套漂移。
 */

import { useEffect, useState } from "react";

import { useMurmurStore } from "@/store/murmur";

import type { SessionSnapshot } from "@core/types";

/** 行内提示：定位 miss（未找到磁盘产物）或复制成功，3 秒自动淡出。 */
export interface RowHint {
  sessionId: string;
  kind: "miss" | "copied";
}

/** 会话动作组；session 自带 agent 字段，无需另传。 */
export function useSessionActions() {
  const [hint, setHint] = useState<RowHint | null>(null);
  const revealSession = useMurmurStore((s) => s.revealSession);
  const writeClipboard = useMurmurStore((s) => s.writeClipboard);

  // 提示行 3 秒淡出；同会话再次操作会以新引用重置计时。
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(t);
  }, [hint]);

  async function reveal(session: SessionSnapshot) {
    try {
      const ok = await revealSession(session.agent, session.sessionId);
      setHint(ok ? null : { sessionId: session.sessionId, kind: "miss" });
    } catch {
      // 离线预览无桥必 reject；真桥下也按 miss 提示，不静默。
      setHint({ sessionId: session.sessionId, kind: "miss" });
    }
  }

  function copyCwd(session: SessionSnapshot) {
    if (!session.cwd) return;
    // 真桥 clipboardWriteText 无失败通路；离线预览无桥必 reject，静默即可。
    writeClipboard(session.cwd)
      .then(() => setHint({ sessionId: session.sessionId, kind: "copied" }))
      .catch(() => {});
  }

  return { reveal, copyCwd, hint };
}
