/** 设置视图：通用（自启/Dock/通知/自动接入）+ 外观（主题/字体）+ 工具两级开关 + 数据 + 关于。
 *  管理台内容基本单元是 GroupList/GroupRow（surface-1 叠层 + hairline 分隔）；
 *  agent 行彩色品牌砖（管理台保留彩砖），行可点展开挂 hook/BYOK 子项。 */

import { useEffect, useMemo, useRef, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import ByokRow from "@/components/byok-row";
import { GroupList, GroupRow } from "@/components/group-list";
import PageHead from "@/components/page-head";
import Segmented from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AGENT_META, AGENT_ORDER, HOOK_IMPACT, OBSERVE_IMPACT, UNINSTALLED_HINT } from "@/lib/agent-meta";
import { isFontAvailable } from "@/lib/appearance";
import { useMurmurStore } from "@/store/murmur";

import type { MurmurSettings, ThemePreference } from "@core/settings";
import type { AgentId, AgentSnapshot } from "@core/types";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
];

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

  // 「工具」分组手风琴：单开。
  const [openAgent, setOpenAgent] = useState<AgentId | null>(null);

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

  /* 监听开关呈现语义：未安装视为关（registry 本就 installed+flag 双闸，未安装无事可观察）。
     存储的 flag 保持缺省 true 不落 false——装好工具即自动开，无需手动回开。 */
  function observed(agent: AgentSnapshot) {
    if (!agent.install.installed) return false;
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
    <div className="flex flex-col">
      <PageHead
        title="设置"
        meta="Murmur 只做状态呈现。这里控制它怎么启动、怎么出现、观察哪些工具。"
      />

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
        <div className="flex flex-col gap-7">
          <GroupList title="通用">
            <GroupRow
              label="登录时启动"
              desc={snap.runtime.canLaunchAtLogin ? "登录 macOS 后自动打开 Murmur" : "仅打包版本可用"}
              control={
                <Switch
                  checked={snap.runtime.launchAtLogin}
                  disabled={!snap.runtime.canLaunchAtLogin}
                  onCheckedChange={(v: boolean) => void save({ launchAtLogin: v })}
                />
              }
            />
            <GroupRow
              label="显示 Dock 图标"
              desc="关闭后只保留菜单栏图标，应用不出现在 Dock 与 Cmd-Tab"
              control={
                <Switch checked={snap.runtime.dockIconVisible} onCheckedChange={(v: boolean) => void save({ showDockIcon: v })} />
              }
            />
            <GroupRow
              label="「轮到你了」通知"
              desc="有待处理会话新增时发系统通知；面板打开时不发"
              control={
                <Switch checked={snap.settings.notifyOnWaiting} onCheckedChange={(v: boolean) => void save({ notifyOnWaiting: v })} />
              }
            />
            <GroupRow
              label="启动时自动接入 hook"
              desc="给已安装且被监听的工具补齐上报配置；关闭后仍可在下方逐个开"
              control={
                <Switch checked={snap.settings.autoInstallHooks} onCheckedChange={(v: boolean) => void save({ autoInstallHooks: v })} />
              }
            />
          </GroupList>

          <GroupList title="外观">
            <GroupRow
              label="主题"
              desc="跟随系统，或固定深色/浅色"
              control={
                <Segmented options={THEME_OPTIONS} value={snap.settings.theme} onChange={(v) => void save({ theme: v })} label="主题" />
              }
            />
            <GroupRow
              label={<label htmlFor="setting-font">界面字体</label>}
              desc={fontHint}
              control={
                <input
                  id="setting-font"
                  aria-label="界面字体名"
                  value={fontDraft ?? snap.settings.font}
                  onChange={(e) => onFontInput(e.target.value)}
                  placeholder="SF / 苹方"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-[130px] shrink-0 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-right font-data text-meta text-foreground outline-none transition-colors duration-fast placeholder:text-faint focus:border-foreground/30"
                />
              }
            />
          </GroupList>

          <GroupList title="工具">
            {agents.map((agent) => {
              const open = openAgent === agent.agent;
              return (
                <GroupRow
                  key={agent.agent}
                  leading={<AgentIcon agent={agent.agent} size={24} />}
                  label={
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold">{AGENT_META[agent.agent].name}</span>
                      {agent.install.version && (
                        <span className="font-data text-micro tabular-nums text-faint">{agent.install.version}</span>
                      )}
                    </span>
                  }
                  desc={agent.install.installed ? observeStatus(agent) : UNINSTALLED_HINT}
                  control={
                    <Switch
                      checked={observed(agent)}
                      disabled={!agent.install.installed}
                      onCheckedChange={(v: boolean) => setAgentObserved(agent.agent, v)}
                    />
                  }
                  expanded={open}
                  onClick={() => setOpenAgent(open ? null : agent.agent)}
                >
                  {observed(agent) ? (
                    <div className="flex flex-col">
                      {HOOK_IMPACT[agent.agent] !== undefined ? (
                        <>
                          <div className="flex items-center justify-between py-1.5">
                            <div className="min-w-0 flex-1">
                              <p className="text-meta text-muted-foreground">hook 上报</p>
                              <p className="mt-0.5 text-micro text-faint">{hookStatus(agent)}</p>
                            </div>
                            <Switch checked={hookOn(agent)} onCheckedChange={(v: boolean) => setAgentHook(agent.agent, v)} />
                          </div>
                          {!hookOn(agent) && (
                            <p className="py-1 text-micro leading-relaxed text-faint">{HOOK_IMPACT[agent.agent]}</p>
                          )}
                        </>
                      ) : (
                        <p className="py-1 text-micro leading-relaxed text-faint">纯本地轮询——该工具没有 hook 上报面</p>
                      )}
                      {agent.install.supportsByok && <ByokRow agent={agent} />}
                    </div>
                  ) : (
                    <p className="py-1 text-meta leading-relaxed text-muted-foreground">
                      {agent.install.installed ? OBSERVE_IMPACT : UNINSTALLED_HINT}
                    </p>
                  )}
                </GroupRow>
              );
            })}
          </GroupList>

          <GroupList title="数据">
            <GroupRow
              label="数据目录"
              desc={<span className="font-data text-micro">{snap.runtime.dataDir}</span>}
              control={
                <Button size="sm" onClick={() => void openDataDir()}>
                  打开
                </Button>
              }
            />
            <GroupRow
              label="重新接入全部工具"
              desc={
                reinstallResult
                  ? reinstallResult.ok
                    ? "已完成"
                    : `接入失败：${reinstallResult.message}`
                  : "按当前监听设置重装各工具的上报 hook"
              }
              control={
                <Button size="sm" disabled={reinstallPending} onClick={() => void reinstallAll()}>
                  {reinstallPending ? "接入中…" : "重新接入"}
                </Button>
              }
            />
            <GroupRow
              label="重建台账"
              desc={
                rebuildResult
                  ? rebuildResult.ok
                    ? "已完成"
                    : `重建失败：${rebuildResult.message}`
                  : "清空事件与用量后由各工具本地数据全量重扫"
              }
              control={
                <Button
                  size="sm"
                  variant={rebuildArmed ? "destructive" : "destructiveSoft"}
                  disabled={rebuildPending}
                  onClick={() => void rebuild()}
                >
                  {rebuildPending ? "重建中…" : rebuildArmed ? "确认重建" : "重建"}
                </Button>
              }
            />
          </GroupList>

          <GroupList title="关于">
            <GroupRow
              label="版本"
              control={
                <span className="select-text font-data text-meta tabular-nums text-faint">
                  v{snap.runtime.version} · {snap.runtime.channel}
                </span>
              }
            />
            <GroupRow
              label="上报端点"
              control={
                <span className="select-text font-data text-meta tabular-nums text-faint">{snap.runtime.ingestEndpoint}</span>
              }
            />
            <GroupRow label="接入诊断 →" desc="逐工具的数据面探针与链路自检" onClick={() => void openManager("doctor")} />
          </GroupList>
        </div>
      )}
    </div>
  );
}
