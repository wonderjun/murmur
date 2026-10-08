/**
 * 技能与 MCP 同步页（管理台 skills tab，#/manage/skills）。
 *
 * 以 ~/.murmur/ 为唯一源（skills/<name>/ 包 + mcp.json 的 mcpServers）：每行一个
 * 源条目，行内 10 个 agent 状态格（dot + 缩写，title tooltip 出明细）。页内
 * 技能/MCP 分段（Segmented 工具行，导入/新建动作随 tab 显隐），首屏盘点渲染
 * 骨架行防假空态。技能导入走系统目录选择框（pickDirectory RPC → electrobun
 * Utils.openFileDialog）；MCP 条目行内新建/编辑（JSON 原文写 mcp.json，编辑器
 * 等 getMcpDef 回填后再 mount）与 initialize 握手探测（testMcp）。
 * 盘点是只读刷新，「全部同步」才写目标。
 */

import { FolderInput, Pencil, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { GroupList, GroupRow } from "@/components/group-list";
import Murmuration from "@/components/murmuration";
import PageHead from "@/components/page-head";
import Segmented from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { fmtFileTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { McpTestResult, SkillSyncCell, SyncItemState } from "@core/types";

/** 状态格圆点色：synced 用 working 绿表示「已就位」（状态色唯一合法彩色通道）。 */
const STATE_DOT: Record<SyncItemState, string> = {
  synced: "bg-working",
  stale: "bg-waiting",
  absent: "bg-faint/40",
  conflict: "bg-stale",
  external: "bg-faint/25",
  off: "bg-faint/15",
  error: "bg-stale",
};

const STATE_LABEL: Record<SyncItemState, string> = {
  synced: "已同步",
  stale: "待更新",
  absent: "未同步",
  conflict: "同名冲突",
  external: "skillshare 管辖",
  off: "关",
  error: "错误",
};

/** 单行状态格：data-agent 出 accent 色名缩写 + 状态点；off/external 降半透。 */
function AgentCells({ cells }: { cells: SkillSyncCell[] }) {
  return (
    <span className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1">
      {AGENT_ORDER.map((id) => {
        const cell = cells.find((c) => c.agent === id);
        if (!cell) return null;
        const dim = cell.state === "off" || cell.state === "external";
        return (
          <span
            key={id}
            data-agent={id}
            title={`${AGENT_META[id].name}：${STATE_LABEL[cell.state]}${cell.detail ? ` · ${cell.detail}` : ""}`}
            className={cn("inline-flex items-center gap-1", dim && "opacity-50")}
          >
            <i className={cn("size-1.5 rounded-full", STATE_DOT[cell.state])} />
            <span className="text-micro text-accent">{AGENT_META[id].abbr}</span>
          </span>
        );
      })}
    </span>
  );
}

/** MCP 条目编辑器（新建/编辑共用）：整段 {"mcpServers":{…}} JSON，逐键写 mcp.json。 */
function McpEditor({
  origName,
  initialDef,
  onClose,
}: {
  origName: string | null;
  initialDef: string;
  onClose: () => void;
}) {
  const saveMcp = useMurmurStore((s) => s.saveMcp);
  const testMcp = useMurmurStore((s) => s.testMcp);
  const [def, setDef] = useState(initialDef);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<McpTestResult[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runTest() {
    setTesting(true);
    setTestResults(null);
    try {
      setTestResults(await testMcp({ def }));
    } catch (e) {
      setTestResults([{ ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setTesting(false);
    }
  }

  async function runSave() {
    setSaving(true);
    setErr(null);
    try {
      const r = await saveMcp(origName, def);
      if (r.ok) onClose();
      else setErr(r.error ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-96 flex-col gap-2 p-2">
      <textarea
        value={def}
        onChange={(e) => setDef(e.target.value)}
        rows={10}
        placeholder='{"mcpServers":{"name":{"command":"npx","args":["-y","some-mcp"]}}}'
        spellCheck={false}
        autoComplete="off"
        className="resize-y rounded-md border border-hairline bg-surface-2 p-2 font-data text-meta/relaxed text-foreground outline-none placeholder:text-faint focus:border-foreground/30"
      />
      {err && <p className="px-1 text-meta text-stale">{err}</p>}
      {testResults?.map((t, i) => (
        <p key={i} className={cn("px-1 text-meta", t.ok ? "text-working" : "text-stale")}>
          {t.name ? `${t.name}：` : ""}
          {t.ok ? `✓ 连通 ${t.latencyMs}ms${t.server ? ` · ${t.server}` : ""}` : `✗ ${t.error}`}
        </p>
      ))}
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" disabled={testing || !def.trim()} onClick={() => void runTest()}>
          {testing ? "探测中…" : "测试"}
        </Button>
        <Button size="sm" disabled={saving || !def.trim()} onClick={() => void runSave()}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}

/** 行内 MCP 编辑入口：打开时拉取现值包成 {"mcpServers":{name:def}} 回填。
 *  编辑器靠 useState(initialDef) 捕获初值——必须等定义到位再 mount，
 *  否则先 mount 的空态永远不回填（打开空白的实测 bug）。 */
function McpEditPopover({ name }: { name: string }) {
  const getMcpDef = useMurmurStore((s) => s.getMcpDef);
  const [open, setOpen] = useState(false);
  /** null=加载中（编辑器未 mount）。 */
  const [def, setDef] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) return;
        setDef(null);
        setLoadErr(null);
        getMcpDef(name)
          .then((d) => setDef(JSON.stringify({ mcpServers: { [name]: d ?? {} } }, null, 2)))
          .catch(() => setLoadErr("读取定义失败"));
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" title="编辑定义" aria-label={`编辑 ${name}`} className="opacity-60">
          <Pencil size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        {def !== null ? (
          <McpEditor origName={name} initialDef={def} onClose={() => setOpen(false)} />
        ) : (
          <div className="flex w-96 flex-col gap-2 p-2" aria-live="polite" aria-busy={!loadErr}>
            <div className="h-40 animate-pulse rounded-md bg-surface-2" />
            {loadErr && <p className="px-1 text-meta text-stale">{loadErr}</p>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default function SkillsView({ embedded }: { embedded?: boolean }) {
  const overview = useMurmurStore((s) => s.syncOverview);
  const getSyncStatus = useMurmurStore((s) => s.getSyncStatus);
  const syncAll = useMurmurStore((s) => s.syncAll);
  const importSkills = useMurmurStore((s) => s.importSkills);
  const deleteSkill = useMurmurStore((s) => s.deleteSkill);
  const setSkillEnabled = useMurmurStore((s) => s.setSkillEnabled);
  const setMcpEnabled = useMurmurStore((s) => s.setMcpEnabled);
  const pickDirectory = useMurmurStore((s) => s.pickDirectory);
  const testMcp = useMurmurStore((s) => s.testMcp);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** 技能/MCP 分段：技能多时不再单栏长滚，导入/新建动作随 tab 显隐。 */
  const [pane, setPane] = useState<"skills" | "mcp">("skills");
  /** 行级 MCP 探测实况：name → testing | 结果。 */
  const [rowTest, setRowTest] = useState<Record<string, "testing" | McpTestResult>>({});
  /** armed 删除：沿用会话文件页的 3s 二次确认模式（行级，per-skill）。 */
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await getSyncStatus();
    } catch {
      // 桥未就绪/主进程失联：保留旧盘点，下次手动刷新。
    } finally {
      setLoading(false);
    }
  }, [getSyncStatus]);

  /* 进页即盘点（纯读）。 */
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      window.clearTimeout(armTimer.current);
    },
    [],
  );

  async function doSync() {
    setSyncing(true);
    setNotice(null);
    try {
      await syncAll();
    } catch (e) {
      setNotice(`同步失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function doPickImport() {
    setImporting(true);
    setNotice(null);
    try {
      const path = await pickDirectory();
      if (!path) return;
      const r = await importSkills(path);
      const skipped = r.skipped.map((s) => `${s.name}（${s.reason}）`).join("、");
      setNotice(
        r.imported.length || r.skipped.length
          ? `导入 ${r.imported.length} 项${r.imported.length ? `（${r.imported.join("、")}）` : ""}${skipped ? ` · 跳过 ${skipped}` : ""}`
          : "目录里没有找到 SKILL.md",
      );
    } catch (e) {
      setNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  async function doDelete(name: string) {
    if (armed !== name) {
      setArmed(name);
      window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(null), 3000);
      return;
    }
    window.clearTimeout(armTimer.current);
    setArmed(null);
    const r = await deleteSkill(name);
    if (!r.ok) setNotice(`删除失败：${r.error ?? "未知错误"}`);
  }

  async function runRowTest(name: string) {
    setRowTest((m) => ({ ...m, [name]: "testing" }));
    try {
      const r = await testMcp({ name });
      setRowTest((m) => ({ ...m, [name]: r[0] ?? { ok: false, latencyMs: 0, error: "无结果" } }));
    } catch (e) {
      setRowTest((m) => ({ ...m, [name]: { ok: false, latencyMs: 0, error: String(e) } }));
    }
  }

  const skills = overview?.skills ?? [];
  const mcps = overview?.mcps ?? [];

  return (
    <div className="flex h-full flex-col">
      {!embedded && <div className="h-8 shrink-0" />}

      <PageHead
        title="技能与 MCP"
        meta={`源：~/.murmur/skills 与 ~/.murmur/mcp.json${overview ? ` · 盘点于 ${fmtFileTime(overview.scannedAt)}` : " · 盘点中…"}`}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              title="重新盘点"
              aria-label="重新盘点"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />
            </Button>
            {pane === "skills" && (
              <Button
                variant="ghost"
                size="icon"
                title="导入技能目录"
                aria-label="导入技能目录"
                disabled={importing}
                onClick={() => void doPickImport()}
              >
                <FolderInput size={14} />
              </Button>
            )}
            {pane === "mcp" && (
              <Popover open={addOpen} onOpenChange={setAddOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" title="新建 MCP 条目" aria-label="新建 MCP 条目">
                    <Plus size={14} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto p-0">
                  <McpEditor
                    origName={null}
                    initialDef={`{
  "mcpServers": {
    "name": {
      "command": "npx",
      "args": ["-y", "some-mcp"]
    }
  }
}`}
                    onClose={() => setAddOpen(false)}
                  />
                </PopoverContent>
              </Popover>
            )}
            <Button onClick={() => void doSync()} disabled={syncing}>
              {syncing ? "同步中…" : "全部同步"}
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-3 pb-3">
        <Segmented
          options={[
            { value: "skills" as const, label: `技能${overview ? ` ${overview.skills.length}` : ""}` },
            { value: "mcp" as const, label: `MCP${overview ? ` ${overview.mcps.length}` : ""}` },
          ]}
          value={pane}
          onChange={setPane}
          label="切换技能与 MCP 列表"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!overview ? (
          /* 首屏盘点中：骨架行（与 doctor/usage 同范式），避免渲染假空态。 */
          <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-item bg-surface-1" />
            ))}
          </div>
        ) : pane === "skills" ? (
          <GroupList>
            {skills.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10">
                <Murmuration size={120} />
                <p className="text-body text-muted-foreground">源目录还没有技能包</p>
                <p className="text-meta text-faint">
                  用右上角「导入」把本地目录收进来，或直接把包放进 ~/.murmur/skills
                </p>
              </div>
            ) : (
              skills.map((row) => (
                <GroupRow
                  key={row.name}
                  label={
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{row.name}</span>
                      {!row.hasSkillMd && (
                        <span className="rounded-md bg-surface-2 px-1 py-0.5 text-micro text-faint">缺 SKILL.md</span>
                      )}
                      {row.disabled && (
                        <span className="rounded-md bg-surface-2 px-1 py-0.5 text-micro text-faint">已停用</span>
                      )}
                    </span>
                  }
                  desc={
                    <span className="block">
                      {row.description && <span className="block truncate">{row.description}</span>}
                      <AgentCells cells={row.cells} />
                    </span>
                  }
                  control={
                    <span className="flex items-center gap-1.5">
                      <Switch
                        checked={!row.disabled}
                        onCheckedChange={(v: boolean) => void setSkillEnabled(row.name, v)}
                        aria-label={`${row.name} 同步开关`}
                      />
                      <Button
                        variant={armed === row.name ? "destructive" : "ghost"}
                        size="icon"
                        title={armed === row.name ? "确认删除（进废纸篓）" : "删除技能"}
                        aria-label={`删除 ${row.name}`}
                        className={cn(armed !== row.name && "opacity-60")}
                        onClick={() => void doDelete(row.name)}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </span>
                  }
                />
              ))
            )}
          </GroupList>
        ) : (
          <GroupList>
            {mcps.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10">
                <p className="text-body text-muted-foreground">没有 MCP 条目</p>
                <p className="text-meta text-faint">点右上角「+」新建一条，或直接编辑 ~/.murmur/mcp.json</p>
              </div>
            ) : (
              mcps.map((row) => {
                const t = rowTest[row.name];
                return (
                  <GroupRow
                    key={row.name}
                    label={
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{row.name}</span>
                        {row.disabled && (
                          <span className="rounded-md bg-surface-2 px-1 py-0.5 text-micro text-faint">已停用</span>
                        )}
                      </span>
                    }
                    desc={
                      <span className="block">
                        <AgentCells cells={row.cells} />
                        {t && (
                          <span
                            className={cn(
                              "mt-0.5 block text-micro",
                              t === "testing" ? "text-faint" : t.ok ? "text-working" : "text-stale",
                            )}
                          >
                            {t === "testing"
                              ? "探测中…"
                              : t.ok
                                ? `✓ 连通 ${t.latencyMs}ms${t.server ? ` · ${t.server}` : ""}`
                                : `✗ ${t.error}`}
                          </span>
                        )}
                      </span>
                    }
                    control={
                      <span className="flex items-center gap-1.5">
                        <Switch
                          checked={!row.disabled}
                          onCheckedChange={(v: boolean) => void setMcpEnabled(row.name, v)}
                          aria-label={`${row.name} 同步开关`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          title="探测连通（initialize 握手）"
                          aria-label={`探测 ${row.name}`}
                          className="opacity-60"
                          disabled={t === "testing"}
                          onClick={() => void runRowTest(row.name)}
                        >
                          <Zap size={12} />
                        </Button>
                        <McpEditPopover name={row.name} />
                      </span>
                    }
                  />
                );
              })
            )}
          </GroupList>
        )}
      </ScrollArea>

      <p className="pt-2.5 text-meta text-muted-foreground">
        {notice ?? "状态格：绿=已同步 · 琥珀=待更新 · 灰=未同步 · 红=冲突/错误 · 半透明=已停用或外部管辖"}
      </p>
    </div>
  );
}
