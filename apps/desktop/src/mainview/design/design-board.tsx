/** 设计板：#/design 进入，token/组件状态矩阵先行验证视觉语言。
 *  焕新展件：六字阶 / 椋鸟群 / 数字转轮 / 编号导航 / 栖枝 / 玻璃浮卡。 */

import { useState } from "react";

import AgentIcon from "@/components/agent-icon";
import AgentRow from "@/components/agent-row";
import AnimatedNumber from "@/components/animated-number";
import ChartTip from "@/components/chart-tip";
import DoctorAgentCard from "@/components/doctor-agent-card";
import ModelLineChart from "@/components/model-line-chart";
import Murmuration from "@/components/murmuration";
import MurmurMark from "@/components/murmur-mark";
import PerchStrip from "@/components/perch-strip";
import QuotaPill from "@/components/quota-pill";
import StatusDot from "@/components/status-dot";
import SwitchRow from "@/components/switch-row";
import { AGENT_META } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";

import type { AgentDiagnostics, AgentId, AgentSnapshot, AgentStatus } from "@core/types";

const STATUSES: AgentStatus[] = ["working", "waiting", "idle", "stale", "ended"];
const AGENTS = Object.keys(AGENT_META) as AgentId[];
const SURFACES = ["--background", "--raised", "--card", "--muted", "--hairline", "--foreground", "--muted-foreground"];
const CHART_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7"];

const DEMO_TIP_ROWS = [
  { name: "grok-4.6", value: "7.9M", color: "var(--chart-2)" },
  { name: "MiniMax-M3", value: "77k", color: "var(--chart-6)" },
  { name: "LongCat-2.0", value: "65k", color: "var(--chart-1)" },
];

const DEMO_DAYS = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.now() - (6 - i) * 86400_000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { day, label: i === 6 ? "今天" : day.slice(5) };
});

const DEMO_SERIES = [
  { name: "kimi-for-coding", color: "var(--chart-1)", width: 1.75, values: [12, 30, 8, 42, 20, 95, 40].map((v) => v * 1.4e6) },
  { name: "gpt-5.6-terra", color: "var(--chart-2)", width: 1.5, values: [60, 52, 40, 6, 4, 70, 18].map((v) => v * 1e6) },
  { name: "k3-256k", color: "var(--chart-3)", width: 1.5, dash: "6 3", values: [30, 36, 20, 4, 2, 60, 10].map((v) => v * 1e6) },
];

/* 与 usage-view 的 MODEL_LINE_STYLES 同序（真源在业务页），仅供图表系列展件演示线型。 */
const CHART_DASHES: (string | undefined)[] = [undefined, undefined, "6 3", "2.5 2.5", "8 3 2.5 3", "1 2", "10 4"];

const NAV_DEMO = ["动态", "工具"];

/** 接入诊断卡展件：正常态 + 故障态各一（DoctorAgentCard 离线替身下按钮降级不炸）。 */
const DEMO_DIAG_OK: AgentDiagnostics = {
  agent: "kimi",
  home: { label: "数据根", path: "~/.kimi-code", kind: "dir", exists: true, readable: true },
  sources: [
    { label: "会话存储", path: "~/.kimi-code/sessions", kind: "dir", exists: true, readable: true },
    { label: "凭据", path: "~/.kimi-code/credentials", kind: "dir", exists: true, readable: true },
  ],
  hook: {
    installed: true,
    enabled: true,
    targets: ["~/.kimi-code/config.toml", "~/.murmur/agent-hooks/kimi.sh"],
    lastEventAt: Date.now() - 300_000,
  },
  pull: { active: true, lastScanAt: Date.now() - 90_000, sources: [{ name: "wire.jsonl", at: Date.now() - 90_000 }] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "数据源正常——暂无活跃会话",
};

const DEMO_DIAG_BAD: AgentDiagnostics = {
  agent: "zcode",
  home: { label: "数据根", path: "~/.zcode", kind: "dir", exists: true, readable: true },
  sources: [
    {
      label: "任务库",
      path: "~/.zcode/v2/tasks-index.sqlite",
      kind: "sqlite",
      exists: true,
      readable: true,
      openable: false,
      note: "无法只读打开（被占用或损坏）",
    },
  ],
  hook: { installed: false, enabled: true, targets: ["~/.zcode/cli/config.json"], lastEventAt: null },
  pull: { active: false, lastScanAt: null, sources: [] },
  spool: { pendingFiles: 0, bytes: 0 },
  hint: "hook 未注入——点「重新接入」或开启自动接入",
};

function demoAgent(agent: AgentId, status: AgentStatus): AgentSnapshot {
  return {
    agent,
    install: { installed: true, hasCredentials: true, homeDir: "", hookInstalled: true },
    disabled: false,
    quota:
      agent === "kimi"
        ? {
            agent,
            plan: "Pro",
            fetchedAt: Date.now(),
            windows: [
              { label: "5h", usedPct: 42, resetsAt: Date.now() + 2.2 * 3600e3 },
              { label: "每周", usedPct: 67, resetsAt: Date.now() + 52 * 3600e3 },
            ],
          }
        : undefined,
    sessions: [
      {
        agent,
        sessionId: "demo-session-1",
        status,
        waitingReason: status === "waiting" ? "turn-end" : undefined,
        cwd: "~/Documents/flow",
        title: "重构 datasource 三层架构",
        model: "kimi-k2.7-code",
        lastEventAt: Date.now() - 60_000,
        startedAt: Date.now() - 600_000,
        tokens: { input: 42000, output: 8100, cacheRead: 9000 },
        costUsd: 0.12,
      },
    ],
  };
}

function BoardHead({ children }: { children: string }) {
  return <h2 className="eyebrow mb-2.5 text-faint">{children}</h2>;
}

export default function DesignBoard() {
  const [navDemo, setNavDemo] = useState(0);
  const [numDemo, setNumDemo] = useState(3);

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto bg-background p-5">
      <div>
        <h1 className="text-title font-semibold">Murmur 设计板</h1>
        <p className="mt-1 text-detail text-muted-foreground">
          token / 字阶 / 椋鸟群 / 数字转轮 / 编号导航 / 栖枝 / 状态点 / 品牌标 / 额度胶囊 / 图表悬浮 / 分组列表样例。
        </p>
      </div>

      <section>
        <BoardHead>字阶六档（micro 10 · meta 11 · detail 12 · body 13 · title 15 · display 22）</BoardHead>
        <div className="rounded-item border border-hairline bg-card p-3.5 shadow-raised">
          <p className="font-mono text-display font-semibold tabular-nums leading-none">128.4M</p>
          <p className="mt-2 text-title font-semibold">3 个任务轮到你了</p>
          <p className="mt-1 text-body font-medium">重构 datasource 三层架构</p>
          <p className="mt-1 text-detail text-muted-foreground">detail · 次级行标题</p>
          <p className="mt-1 text-meta text-muted-foreground">meta · 副信息行 secondary label</p>
          <p className="mt-1.5 font-mono text-micro tabular-nums text-faint">micro · 4.2G · 715.5M · 09-13 12:00</p>
        </div>
      </section>

      <section>
        <BoardHead>椋鸟群（空态签名 · 群鸟游动 + 峰点琥珀）</BoardHead>
        <div className="flex items-center gap-6 rounded-item border border-hairline bg-card px-3.5 py-4 shadow-raised">
          <Murmuration size={120} />
          <Murmuration size={72} className="text-muted-foreground" />
        </div>
      </section>

      <section>
        <BoardHead>数字转轮（点按钮换值，新值上滑入场）</BoardHead>
        <div className="flex items-center gap-4 rounded-item border border-hairline bg-card px-3.5 py-3 shadow-raised">
          <p className="text-meta text-muted-foreground">
            需处理
            <AnimatedNumber value={numDemo} className="ml-1 font-mono text-detail font-medium text-waiting" />
          </p>
          <button
            type="button"
            className="rounded-md border border-hairline bg-raised px-2.5 py-1 text-meta font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground"
            onClick={() => setNumDemo((n) => (n + 1) % 10)}
          >
            换一个数
          </button>
        </div>
      </section>

      <section>
        <BoardHead>底栏导航（pill 分段 · bg-muted 轨道 + 选中 bg-raised）</BoardHead>
        <div className="glass-chrome flex items-center rounded-item border border-hairline px-3 py-2">
          <nav className="flex items-center gap-0.5 rounded-full bg-muted p-0.5">
            {NAV_DEMO.map((label, i) => (
              <button
                key={label}
                type="button"
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-meta font-medium transition-colors duration-fast",
                  navDemo === i
                    ? "border-hairline bg-raised text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setNavDemo(i)}
              >
                {label}
                {i === 0 && <span className="font-mono text-micro tabular-nums text-waiting">3</span>}
              </button>
            ))}
          </nav>
        </div>
      </section>

      <section>
        <BoardHead>栖枝（当前快照 · 9px 点 + 渐变枝 + 鸟跳）</BoardHead>
        <div className="rounded-item border border-hairline bg-card px-3.5 py-3 shadow-raised">
          <PerchStrip />
        </div>
      </section>

      <section>
        <BoardHead>状态点</BoardHead>
        <div className="flex flex-wrap gap-5">
          {STATUSES.map((s) => (
            <span key={s} className="flex flex-col items-center gap-1.5">
              <StatusDot status={s} size={10} />
              <span className="font-mono text-micro text-muted-foreground">{s}</span>
            </span>
          ))}
        </div>
      </section>

      <section>
        <BoardHead>品牌徽标</BoardHead>
        <div className="flex flex-wrap items-center gap-4">
          {AGENTS.map((a) => (
            <span key={a} className="flex flex-col items-center gap-1.5">
              <AgentIcon agent={a} size={32} />
              <span className="text-micro text-muted-foreground">{AGENT_META[a].name}</span>
            </span>
          ))}
          <span className="flex flex-col items-center gap-1.5">
            <MurmurMark size={32} live className="text-foreground" />
            <span className="text-micro text-muted-foreground">murmur-mark live</span>
          </span>
        </div>
      </section>

      <section>
        <BoardHead>额度胶囊</BoardHead>
        <div className="flex flex-wrap gap-2">
          <QuotaPill window={{ label: "5h", usedPct: 34, resetsAt: Date.now() + 2.2 * 3600e3 }} />
          <QuotaPill window={{ label: "每周", usedPct: 71, resetsAt: Date.now() + 52 * 3600e3 }} />
          <QuotaPill window={{ label: "每月", usedPct: 93, resetsAt: Date.now() + 300 * 3600e3 }} />
        </div>
      </section>

      <section>
        <BoardHead>图表悬浮（玻璃浮卡 · 悬停试试，瞬时无延迟）</BoardHead>
        <div className="relative h-[120px] rounded-item border border-hairline bg-card shadow-raised">
          <ChartTip tip={{ x: 80, y: 60, place: "top" }}>
            <p className="whitespace-nowrap text-meta">
              <span className="font-mono tabular-nums text-faint">09-11</span>
              <span className="mx-1.5 text-faint">·</span>
              <span className="font-mono tabular-nums font-medium">426.5M 令牌</span>
            </p>
          </ChartTip>
          <ChartTip tip={{ x: 300, y: 20, place: "left" }}>
            <p className="text-meta font-semibold">9月11日 周五</p>
            <div className="mt-1.5 flex min-w-[150px] flex-col gap-1">
              {DEMO_TIP_ROWS.map((row) => (
                <span key={row.name} className="flex items-center gap-1.5 text-meta">
                  <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: row.color }} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
                  <span className="font-mono tabular-nums">{row.value}</span>
                </span>
              ))}
            </div>
          </ChartTip>
        </div>
      </section>

      <section>
        <BoardHead>模型折线（准星 + 明细卡 + 峰值标注）</BoardHead>
        <div className="rounded-item border border-hairline bg-card px-3 py-2.5 shadow-raised">
          <ModelLineChart days={DEMO_DAYS} series={DEMO_SERIES} />
        </div>
      </section>

      <section>
        <BoardHead>设置开关</BoardHead>
        <div className="flex max-w-[360px] flex-col gap-3 rounded-item border border-hairline bg-card p-3.5 shadow-raised">
          <SwitchRow label="登录时启动" desc="登录 macOS 后自动打开 Murmur" checked={true} onCheckedChange={() => {}} />
          <SwitchRow label="「轮到你了」通知" desc="有待处理会话新增时发系统通知" checked={false} onCheckedChange={() => {}} />
          <SwitchRow label="禁用态" desc="未安装的工具不可开关" checked={false} disabled={true} onCheckedChange={() => {}} />
        </div>
      </section>

      <section>
        <BoardHead>色板</BoardHead>
        <div className="flex flex-wrap gap-2">
          {SURFACES.map((t) => (
            <span
              key={t}
              className="flex h-12 w-[92px] items-end rounded-lg border border-hairline p-1.5"
              style={{ background: `var(${t})` }}
            >
              <span className="font-mono text-micro text-foreground/70">{t}</span>
            </span>
          ))}
        </div>
      </section>

      <section>
        <BoardHead>图表系列（--chart-1..7 · heat 暖橙 ramp + dash 双编码，用量密度语义与热力图同族）</BoardHead>
        <div className="flex flex-wrap gap-2">
          {CHART_TOKENS.map((t, i) => (
            <span
              key={t}
              className="flex h-12 w-[92px] flex-col justify-between rounded-lg border border-hairline p-1.5"
            >
              <svg width="100%" height="6" aria-hidden="true">
                <line
                  x1="2"
                  y1="3"
                  x2="76"
                  y2="3"
                  stroke={`var(${t})`}
                  strokeWidth={i === 0 ? 1.75 : 1.5}
                  strokeDasharray={CHART_DASHES[i]}
                  strokeLinecap="round"
                />
              </svg>
              <span className="font-mono text-micro text-faint">{t}</span>
            </span>
          ))}
        </div>
      </section>

      <section>
        <BoardHead>分组列表样例（业务页同款容器）</BoardHead>
        <div className="max-w-[360px] divide-y divide-hairline/60 overflow-hidden rounded-item border border-hairline bg-card shadow-raised">
          <AgentRow agent={demoAgent("kimi", "working")} />
          <AgentRow agent={demoAgent("zcode", "waiting")} />
          <AgentRow agent={demoAgent("opencode", "idle")} />
        </div>
      </section>

      <section>
        <BoardHead>接入诊断卡（管理台 · 数据/push/pull 三面 + 链路自检，正常与故障态）</BoardHead>
        <div className="grid max-w-[860px] gap-2.5 md:grid-cols-2">
          <DoctorAgentCard diag={DEMO_DIAG_OK} onChanged={() => {}} />
          <DoctorAgentCard diag={DEMO_DIAG_BAD} onChanged={() => {}} />
        </div>
      </section>
    </div>
  );
}
