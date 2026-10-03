/** 设置视图：通用（自启/Dock/通知）+ 外观（主题/字体）+ 每 agent 监听与 hook 两级开关 + 数据 + 关于。
 *  栏目是 flat 地面（编号 eyebrow + 上 hairline）；agent 行是实体卡（.setup-row + data-agent）。 */

import { FolderOpen, HardDrive } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import ByokRow from "@/components/byok-row";
import Segmented from "@/components/segmented";
import SwitchRow from "@/components/switch-row";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AGENT_META, AGENT_ORDER, HOOK_IMPACT, OBSERVE_IMPACT } from "@/lib/agent-meta";
import { isFontAvailable } from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { MurmurSettings, ThemePreference } from "@core/settings";
import type { AgentSnapshot } from "@core/types";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
];

/** 栏目头：编号（mono micro）+ 名称（eyebrow 语义），flat 栏目的统一开场。 */
function SectionHead({ index, title }: { index: string; title: string }) {
  return (
    <h2 className="eyebrow flex items-baseline gap-1.5 text-faint">
      <span className="font-mono">{index}</span>
      {title}
    </h2>
  );
}

/** 长操作的一行结果反馈：成功「已完成」/失败带 error.message，3 秒淡出。 */
interface OpResult {
  ok: boolean;
  message: string;
}

export default function SettingsView() {
  const snapshot = useMurmurStore((s) => s.snapshot);
  const snap = useMurmurStore((s) => s.settingsSnap);
  const settingsError = useMurmurStore((s) => s.settingsError);
  const loadSettings = useMurmurStore((s) => s.loadSettings);
  const updateSettings = useMurmurStore((s) => s.updateSettings);
  const setAgentHook = useMurmurStore((s) => s.setAgentHook);
  const setAgentObserved = useMurmurStore((s) => s.setAgentObserved);
  const installHooks = useMurmurStore((s) => s.installHooks);
  const rebuildLedger = useMurmurStore((s) => s.rebuildLedger);
  const openDataDir = useMurmurStore((s) => s.openDataDir);
  const openManager = useMurmurStore((s) => s.openManager);

  const agents = useMemo(
    () =>
      AGENT_ORDER.map((id) => snapshot?.agents.find((a) => a.agent === id)).filter(
        (a): a is AgentSnapshot => Boolean(a),
      ),
    [snapshot],
  );

  const [rebuildArmed, setRebuildArmed] = useState(false);
  const rebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 危险/长操作反馈：进行中禁用按钮 + 文案；结束出一行结果，3 秒淡出。
  const [reinstallPending, setReinstallPending] = useState(false);
  const [rebuildPending, setRebuildPending] = useState(false);
  const [reinstallResult, setReinstallResult] = useState<OpResult | null>(null);
  const [rebuildResult, setRebuildResult] = useState<OpResult | null>(null);

  useEffect(() => {
    if (!reinstallResult && !rebuildResult) return;
    const t = setTimeout(() => {
      setReinstallResult(null);
      setRebuildResult(null);
    }, 3000);
    return () => clearTimeout(t);
  }, [reinstallResult, rebuildResult]);

  function errText(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  /* 字体输入草稿：null=未编辑跟随设置；防抖 500ms 落盘，落盘回读一致后清草稿。 */
  const [fontDraft, setFontDraft] = useState<string | null>(null);
  const fontTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (fontDraft !== null && fontDraft === snap?.settings.font) setFontDraft(null);
  }, [snap, fontDraft]);

  useEffect(
    () => () => {
      if (fontTimer.current) clearTimeout(fontTimer.current);
    },
    [],
  );

  function observed(agent: AgentSnapshot) {
    return snap ? snap.settings.agents[agent.agent] !== false : !agent.disabled;
  }

  function hookOn(agent: AgentSnapshot) {
    return snap ? snap.settings.hooks[agent.agent] !== false : agent.install.hookInstalled;
  }

  function observeStatus(agent: AgentSnapshot) {
    if (!agent.install.installed) return "未安装";
    if (agent.disabled) return "已停用监听";
    return agent.sessions.length ? `${agent.sessions.length} 个活跃会话` : "已连接";
  }

  function hookStatus(agent: AgentSnapshot) {
    if (!hookOn(agent)) return "已关闭";
    if (agent.install.hookInstalled) return "已注入";
    return agent.install.note ?? "待安装";
  }

  async function save(patch: Partial<MurmurSettings>) {
    await updateSettings(patch);
  }

  function onFontInput(value: string) {
    setFontDraft(value);
    if (fontTimer.current) clearTimeout(fontTimer.current);
    fontTimer.current = setTimeout(() => void save({ font: value.trim() }), 500);
  }

  const fontValue = fontDraft ?? snap?.settings.font ?? "";
  const fontHint = !fontValue
    ? "默认使用系统字体，可填字体名如 Maple Mono NF CN"
    : isFontAvailable(fontValue)
      ? `已识别「${fontValue}」`
      : `未检测到「${fontValue}」，已回退系统字体`;

  async function reinstallAll() {
    setReinstallResult(null);
    setRebuildResult(null);
    setReinstallPending(true);
    try {
      await installHooks();
      await loadSettings();
      setReinstallResult({ ok: true, message: "已完成" });
    } catch (e) {
      setReinstallResult({ ok: false, message: errText(e) });
    } finally {
      setReinstallPending(false);
    }
  }

  async function rebuild() {
    if (!rebuildArmed) {
      setRebuildArmed(true);
      rebuildTimer.current = setTimeout(() => setRebuildArmed(false), 3000);
      return;
    }
    if (rebuildTimer.current) clearTimeout(rebuildTimer.current);
    setRebuildArmed(false);
    setReinstallResult(null);
    setRebuildResult(null);
    setRebuildPending(true);
    try {
      await rebuildLedger();
      setRebuildResult({ ok: true, message: "已完成" });
    } catch (e) {
      setRebuildResult({ ok: false, message: errText(e) });
    } finally {
      setRebuildPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="setup-intro animate-enter">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="eyebrow text-faint">设置</p>
            <h1 className="mt-1 text-title font-semibold">偏好</h1>
          </div>
        </div>
        <p className="mt-2 max-w-[310px] text-meta leading-relaxed text-muted-foreground">
          Murmur 只做状态呈现。这里控制它怎么启动、怎么出现、观察哪些工具。
        </p>
      </section>

      {!snap ? (
        settingsError ? (
          <div className="px-4 py-10 text-center" role="alert">
            <p className="text-body font-medium">设置不可用</p>
            <p className="mt-1.5 text-meta text-muted-foreground">设置读取失败，稍候可重试。</p>
            <Button size="sm" className="mt-4" onClick={() => void loadSettings()}>
              重试
            </Button>
          </div>
        ) : (
          <div className="text-meta text-faint">设置读取中…</div>
        )
      ) : (
        <>
          {/* 01 通用 */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: "40ms" }}>
            <SectionHead index="01" title="通用" />
            <div className="mt-3 flex flex-col gap-3">
              <SwitchRow
                label="登录时启动"
                desc={snap.runtime.canLaunchAtLogin ? "登录 macOS 后自动打开 Murmur" : "仅打包版本可用"}
                checked={snap.runtime.launchAtLogin}
                disabled={!snap.runtime.canLaunchAtLogin}
                onCheckedChange={(v) => save({ launchAtLogin: v })}
              />
              <SwitchRow
                label="在 Dock 中显示"
                desc="关闭后只保留菜单栏图标，应用不出现在 Dock 与 Cmd-Tab"
                checked={snap.runtime.dockIconVisible}
                onCheckedChange={(v) => save({ showDockIcon: v })}
              />
              <SwitchRow
                label="「轮到你了」通知"
                desc="有待处理会话新增时发系统通知；面板打开时不发"
                checked={snap.settings.notifyOnWaiting}
                onCheckedChange={(v) => save({ notifyOnWaiting: v })}
              />
            </div>
          </section>

          {/* 02 外观 */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: "80ms" }}>
            <SectionHead index="02" title="外观" />
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-detail font-medium text-foreground">主题</p>
                  <p className="mt-0.5 text-meta leading-relaxed text-muted-foreground">跟随系统，或固定深色/浅色</p>
                </div>
                <Segmented
                  options={THEME_OPTIONS}
                  value={snap.settings.theme}
                  onChange={(v) => void save({ theme: v })}
                  label="主题"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <label htmlFor="setting-font" className="text-detail font-medium text-foreground">
                    界面字体
                  </label>
                  <p className="mt-0.5 text-meta leading-relaxed text-muted-foreground">{fontHint}</p>
                </div>
                <input
                  id="setting-font"
                  aria-label="界面字体名"
                  value={fontDraft ?? snap.settings.font}
                  onChange={(e) => onFontInput(e.target.value)}
                  placeholder="SF / 苹方"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-[130px] shrink-0 rounded-md border border-hairline bg-raised px-2 py-1 text-right font-mono text-meta text-foreground outline-none transition-colors duration-fast placeholder:text-faint focus:border-foreground/30"
                />
              </div>
            </div>
          </section>

          {/* 03 监听：自动接入开关 + 各工具实体卡 */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: "120ms" }}>
            <div className="flex items-center justify-between">
              <SectionHead index="03" title="监听" />
              <button
                type="button"
                disabled={reinstallPending}
                className="text-meta font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] transition-colors duration-fast hover:decoration-foreground/60 disabled:pointer-events-none disabled:opacity-50"
                onClick={reinstallAll}
              >
                {reinstallPending ? "接入中…" : "全部重新接入"}
              </button>
            </div>
            {reinstallResult && (
              <p className={cn("mt-1 text-meta", reinstallResult.ok ? "text-muted-foreground" : "text-destructive")}>
                {reinstallResult.ok ? "已完成" : `接入失败：${reinstallResult.message}`}
              </p>
            )}
            <div className="mt-3">
              <SwitchRow
                label="启动时自动接入 hook"
                desc="给已安装且被监听的工具补齐上报配置；关闭后仍可在下方逐个开"
                checked={snap.settings.autoInstallHooks}
                onCheckedChange={(v) => save({ autoInstallHooks: v })}
              />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {agents.map((agent) => (
                <article key={agent.agent} className="setup-row" data-agent={agent.agent}>
                  <div className="flex items-center gap-3">
                    <AgentIcon agent={agent.agent} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-body font-semibold">{AGENT_META[agent.agent].name}</span>
                        {agent.install.version && (
                          <span className="font-mono text-micro text-faint">{agent.install.version}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-meta text-muted-foreground">{observeStatus(agent)}</p>
                    </div>
                    <Switch
                      checked={observed(agent)}
                      disabled={!agent.install.installed}
                      onCheckedChange={(v: boolean) => setAgentObserved(agent.agent, v)}
                    />
                  </div>

                  {observed(agent) ? (
                    <>
                      <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-hairline/60 pl-9 pt-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-meta text-muted-foreground">实时上报 hook</p>
                          <p className="mt-0.5 text-micro text-faint">{hookStatus(agent)}</p>
                        </div>
                        <Switch checked={hookOn(agent)} onCheckedChange={(v: boolean) => setAgentHook(agent.agent, v)} />
                      </div>
                      {!hookOn(agent) && (
                        <p className="mt-1.5 pl-9 text-meta leading-relaxed text-muted-foreground">
                          {HOOK_IMPACT[agent.agent]}
                        </p>
                      )}
                      {/* BYOK：凭据加密不可读的工具（zcode 等）在此自填 API Key 拉额度 */}
                      {agent.install.supportsByok && <ByokRow agent={agent} />}
                    </>
                  ) : (
                    <p className="mt-2.5 border-t border-hairline/60 pt-2.5 text-meta leading-relaxed text-muted-foreground">
                      {OBSERVE_IMPACT}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>

          {/* 04 数据 */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: "160ms" }}>
            <SectionHead index="04" title="数据" />
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-detail font-medium">本地台账</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">清空事件与用量后由各工具本地数据全量重扫</p>
                </div>
                <button
                  type="button"
                  disabled={rebuildPending}
                  className={cn(
                    "shrink-0 rounded-md border px-2.5 py-1 text-meta font-medium transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50",
                    rebuildArmed
                      ? "border-foreground/40 bg-foreground/10 text-foreground"
                      : "border-hairline bg-raised text-muted-foreground hover:text-foreground",
                  )}
                  onClick={rebuild}
                >
                  {rebuildPending ? "重建中…" : rebuildArmed ? "再点一次确认" : "重建"}
                </button>
              </div>
              {rebuildResult && (
                <p className={cn("-mt-1 text-meta", rebuildResult.ok ? "text-muted-foreground" : "text-destructive")}>
                  {rebuildResult.ok ? "已完成" : `重建失败：${rebuildResult.message}`}
                </p>
              )}
              <button
                type="button"
                className="flex items-center justify-between gap-3 text-left"
                onClick={() => void openManager("files")}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-detail font-medium">会话文件</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">盘点各工具的会话产物，批量清理（进废纸篓）</p>
                </div>
                <HardDrive size={13} className="shrink-0 text-faint" />
              </button>
              <button
                type="button"
                className="flex items-center justify-between gap-3 text-left"
                onClick={() => void openDataDir()}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-detail font-medium">数据目录</p>
                  <p className="mt-0.5 truncate font-mono text-micro text-faint">{snap.runtime.dataDir}</p>
                </div>
                <FolderOpen size={13} className="shrink-0 text-faint" />
              </button>
            </div>
          </section>

          {/* 05 关于 */}
          <section className="animate-enter border-t border-hairline pt-3" style={{ animationDelay: "200ms" }}>
            <SectionHead index="05" title="关于" />
            <div className="mt-3 flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-meta">
                <span className="text-muted-foreground">版本</span>
                <span className="select-text font-mono tabular-nums text-faint">
                  {snap.runtime.version} · {snap.runtime.channel}
                </span>
              </div>
              <div className="flex items-center justify-between text-meta">
                <span className="text-muted-foreground">上报端点</span>
                <span className="select-text font-mono tabular-nums text-faint">{snap.runtime.ingestEndpoint}</span>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
