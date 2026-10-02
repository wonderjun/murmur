/** 刊头：裸放 murmur-mark + MURMUR 眉题 + 状态头条（面板开口说的第一句话）
 *  + folio 微信息行（日期 · 已接入数），下方横贯栖枝签名。
 *  绝对定位浮于滚动区之上（glass-chrome），高度计入 --chrome-top。 */

import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import AnimatedNumber from "@/components/animated-number";
import MurmurMark from "@/components/murmur-mark";
import PerchStrip from "@/components/perch-strip";
import { AGENT_ORDER } from "@/lib/agent-meta";
import { waitingCount, workingCount } from "@/lib/selectors";
import { useMurmurStore } from "@/store/murmur";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function MurmurHeader() {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const refreshQuotas = useMurmurStore((s) => s.refreshQuotas);
  const [refreshing, setRefreshing] = useState(false);

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

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshQuotas();
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }

  return (
    <header className="px-4 pb-2.5 pt-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MurmurMark size={20} live={waiting > 0} className="text-foreground" />
          <span className="font-mono text-micro font-medium tracking-[0.18em] text-muted-foreground">MURMUR</span>
        </div>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-muted hover:text-foreground"
          title="刷新额度"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
        </button>
      </div>

      {/* 状态头条：面板的第一句话，title 档当家；waiting 时数字琥珀 */}
      <p className="mt-2 text-title font-semibold">
        {waiting > 0 ? (
          <>
            <AnimatedNumber value={waiting} className="font-mono text-waiting" />
            <span className="ml-1">个任务轮到你了</span>
          </>
        ) : working > 0 ? (
          <>
            <AnimatedNumber value={working} className="font-mono" />
            <span className="ml-1">个工具正在干活</span>
          </>
        ) : (
          "现在很安静"
        )}
      </p>
      <p className="mt-0.5 text-meta text-muted-foreground">{folio}</p>

      <PerchStrip className="mt-2.5" />
    </header>
  );
}
