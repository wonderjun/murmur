/**
 * 会话文件管理页（独立窗口 #/files）：跨 agent 盘点磁盘会话产物。
 *
 * 过滤按工具/项目；排序默认修改时间倒序（表头可切大小/创建/修改）；
 * 勾选批量删除——文件/目录进废纸篓（可恢复），「库内」行是数据库记录
 * 永久删（标 needsVacuum 时提示文件体积需压实才回收）。活跃会话禁删。
 * 行可 Tab 聚焦（role=checkbox，空格/回车勾选），Finder 按钮随行聚焦显形。
 */

import { ArrowDown, ArrowUp, FolderSearch, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import Murmuration from "@/components/murmuration";
import Segmented from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_META, AGENT_ORDER } from "@/lib/agent-meta";
import { fmtBytes, fmtFileTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMurmurStore } from "@/store/murmur";

import type { AgentId, StoredSession } from "@core/types";

type SortKey = "modifiedAt" | "createdAt" | "sizeBytes" | "title";
type SortDir = "asc" | "desc";

/** 行选择键：agent:id 复合（id 跨 agent 可能撞名）。 */
function rowKey(s: Pick<StoredSession, "agent" | "id">): string {
  return `${s.agent}:${s.id}`;
}

/** 项目展示名：路径尾段（空 → 未知）。 */
function projectName(p: string | undefined): string {
  if (!p) return "—";
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** 可排序表头单元格（文本标签语义，不用 chrome 按钮件）。 */
function SortHead({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn(
        "flex items-center gap-0.5 text-left text-micro font-medium transition-colors duration-fast",
        active ? "text-foreground" : "text-faint hover:text-muted-foreground",
        className,
      )}
    >
      {label}
      {active &&
        (sortDir === "desc" ? <ArrowDown size={9} strokeWidth={2.5} /> : <ArrowUp size={9} strokeWidth={2.5} />)}
    </button>
  );
}

const GRID = "grid grid-cols-[26px_26px_minmax(0,1fr)_132px_64px_82px_82px_26px] items-center gap-x-2";

export default function SessionsView() {
  const scanSessions = useMurmurStore((s) => s.scanSessions);
  const deleteSessions = useMurmurStore((s) => s.deleteSessions);
  const revealSession = useMurmurStore((s) => s.revealSession);

  const [items, setItems] = useState<StoredSession[] | null>(null);
  const [scannedAt, setScannedAt] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [agentFilter, setAgentFilter] = useState<"all" | AgentId>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("modifiedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /* armed 删除：沿用设置页 rebuild 的 3s 二次确认模式。 */
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function rescan() {
    setScanning(true);
    try {
      const r = await scanSessions();
      setItems(r.items);
      setScannedAt(r.scannedAt);
      setSelected(new Set());
    } catch {
      setItems((prev) => prev ?? []);
    } finally {
      setScanning(false);
    }
  }

  /* 进页即扫。 */
  useEffect(() => {
    void rescan();
  }, []);

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  /* 联动过滤：工具段只列当前项目下产过会话的工具，项目下拉只列当前工具下的项目。 */
  const agents = useMemo(() => {
    const seen = new Set(
      (items ?? []).filter((i) => projectFilter === "all" || i.project === projectFilter).map((i) => i.agent),
    );
    return AGENT_ORDER.filter((a) => seen.has(a));
  }, [items, projectFilter]);

  const projects = useMemo(() => {
    const set = new Map<string, number>();
    for (const i of items ?? []) {
      if (agentFilter !== "all" && i.agent !== agentFilter) continue;
      if (!i.project) continue;
      set.set(i.project, (set.get(i.project) ?? 0) + 1);
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [items, agentFilter]);

  /* 一侧选中收窄后，另一侧的已选项可能失效——回落「全部」而非留死选项。 */
  useEffect(() => {
    if (projectFilter !== "all" && !projects.some(([p]) => p === projectFilter)) setProjectFilter("all");
    if (agentFilter !== "all" && !agents.includes(agentFilter)) setAgentFilter("all");
  }, [projectFilter, projects, agentFilter, agents]);

  const filtered = useMemo(() => {
    let list = items ?? [];
    if (agentFilter !== "all") list = list.filter((i) => i.agent === agentFilter);
    if (projectFilter !== "all") list = list.filter((i) => i.project === projectFilter);
    const dir = sortDir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = sortKey === "title" ? (a.title ?? "") : a[sortKey];
      const bv = sortKey === "title" ? (b.title ?? "") : b[sortKey];
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [items, agentFilter, projectFilter, sortKey, sortDir]);

  const selectable = filtered.filter((i) => !i.active);
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(rowKey(i)));
  const someSelected = selectable.some((i) => selected.has(rowKey(i)));

  const selectedItems = filtered.filter((i) => selected.has(rowKey(i)));
  const selectedBytes = selectedItems.reduce((s, i) => s + i.sizeBytes, 0);
  const selectedDb = selectedItems.filter((i) => i.kind === "db").length;
  const totalBytes = (items ?? []).reduce((s, i) => s + i.sizeBytes, 0);

  function onSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir(k === "title" ? "asc" : "desc");
    }
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) return new Set([...prev].filter((k) => !selectable.some((i) => rowKey(i) === k)));
      const next = new Set(prev);
      for (const i of selectable) next.add(rowKey(i));
      return next;
    });
  }

  function toggleOne(i: StoredSession) {
    if (i.active) return;
    const k = rowKey(i);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  async function doDelete() {
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(false);
    setDeleting(true);
    setNotice(null);
    try {
      const results = await deleteSessions(selectedItems.map((i) => ({ agent: i.agent, id: i.id })));
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      const freed = results.reduce((s, r) => s + r.freedBytes, 0);
      const vacuum = results.some((r) => r.needsVacuum);
      setNotice(
        `已删 ${ok} 项 · 释放 ${fmtBytes(freed)}` +
          (failed.length ? ` · 失败 ${failed.length}（${failed[0].error ?? ""}）` : "") +
          (vacuum ? " · 库内删除已生效，文件体积需对应工具压实数据库后回收" : ""),
      );
    } catch (e) {
      setNotice(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
      await rescan();
    }
  }

  const headCell = "text-micro font-medium text-faint";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* 顶部拖拽条：hiddenInset 红绿灯落在这条里 */}
      <div className="h-8 shrink-0" />

      {/* 头行：标题 + 规模合计 + 重扫 */}
      <header className="flex items-end justify-between gap-3 px-4 pb-3">
        <div>
          <p className="eyebrow text-faint">Murmur</p>
          <h1 className="mt-0.5 text-title font-semibold">会话文件</h1>
        </div>
        <div className="flex items-center gap-3">
          <p className="font-mono text-micro tabular-nums text-faint">
            {items ? `${items.length} 项 · 共 ${fmtBytes(totalBytes)} · ${fmtFileTime(scannedAt)} 扫` : "…"}
          </p>
          <Button type="button" onClick={() => void rescan()} disabled={scanning}>
            <RefreshCw size={11} />
            重扫
          </Button>
        </div>
      </header>

      {/* 工具行：工具/项目过滤 */}
      <div className="flex items-center gap-3 border-b border-hairline px-4 pb-2.5">
        <Segmented
          options={[{ value: "all" as const, label: "全部" }, ...agents.map((a) => ({ value: a, label: AGENT_META[a].name }))]}
          value={agentFilter}
          onChange={(v) => setAgentFilter(v)}
          label="按工具过滤"
        />
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="ml-auto w-55" aria-label="按项目过滤">
            <SelectValue placeholder="全部项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部项目</SelectItem>
            {projects.map(([p, n]) => (
              <SelectItem key={p} value={p}>
                {projectName(p)} · {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 表头 */}
      <div className={cn(GRID, "border-b border-hairline px-4 py-1.5")}>
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={toggleAll}
          disabled={!selectable.length}
        />
        <span className={headCell}>工具</span>
        <SortHead label="会话" k="title" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span className={headCell}>项目</span>
        <SortHead label="大小" k="sizeBytes" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="justify-end" />
        <SortHead label="创建" k="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortHead label="修改" k="modifiedAt" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span />
      </div>

      {/* 行列表 */}
      <ScrollArea className="min-h-0 flex-1">
        {items === null && scanning ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-item bg-raised" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 pb-16">
            <Murmuration size={120} />
            <p className="text-body text-muted-foreground">没有会话产物</p>
            <p className="text-meta text-faint">接入的 CLI 跑过会话后会出现在这里</p>
          </div>
        ) : (
          <div>
            {filtered.map((i) => {
              const k = rowKey(i);
              const checked = selected.has(k);
              return (
                <div
                  key={k}
                  role="checkbox"
                  aria-checked={checked}
                  aria-disabled={i.active || undefined}
                  tabIndex={i.active ? -1 : 0}
                  className={cn(
                    GRID,
                    "group cursor-pointer border-b border-hairline/40 px-4 py-2 transition-colors duration-fast focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/45",
                    checked ? "bg-raised" : "hover:bg-raised/60 focus-visible:bg-raised/60",
                    i.active && "opacity-60",
                  )}
                  onClick={() => toggleOne(i)}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      toggleOne(i);
                    }
                  }}
                >
                  <Checkbox
                    checked={checked}
                    disabled={i.active}
                    onCheckedChange={() => toggleOne(i)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <AgentIcon agent={i.agent} size={16} />
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="select-text truncate text-detail text-foreground" title={i.title ?? i.id}>
                      {i.title || i.id}
                    </span>
                    {i.kind === "db" && (
                      <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-micro text-faint">库内</span>
                    )}
                    {i.active && (
                      <span className="shrink-0 font-mono text-micro text-faint">活跃</span>
                    )}
                  </div>
                  <span className="select-text truncate text-meta text-muted-foreground" title={i.project}>
                    {projectName(i.project)}
                  </span>
                  <span className="text-right font-mono text-micro tabular-nums text-muted-foreground">
                    {fmtBytes(i.sizeBytes)}
                  </span>
                  <span className="font-mono text-micro tabular-nums text-faint">{fmtFileTime(i.createdAt)}</span>
                  <span className="font-mono text-micro tabular-nums text-faint">{fmtFileTime(i.modifiedAt)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="在 Finder 中显示"
                    className="opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void revealSession(i.agent, i.id);
                    }}
                  >
                    <FolderSearch size={12} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* 底栏：选择汇总 + 删除 */}
      <footer className="flex items-center gap-3 border-t border-hairline px-4 py-2.5">
        <p className="text-meta text-muted-foreground">
          {selectedItems.length
            ? `已选 ${selectedItems.length} 项 · ${fmtBytes(selectedBytes)}${selectedDb ? ` · 含 ${selectedDb} 项库内记录（永久删）` : ""}`
            : (notice ?? "勾选会话后可批量删除，文件类进废纸篓")}
        </p>
        {notice && selectedItems.length > 0 && <p className="truncate text-meta text-faint">{notice}</p>}
        <Button
          variant={armed ? "destructive" : "destructiveSoft"}
          disabled={!selectedItems.length || deleting}
          onClick={() => void doDelete()}
          className="ml-auto"
        >
          <Trash2 size={11} />
          {deleting ? "删除中…" : armed ? "再点一次确认删除" : `删除 ${selectedItems.length || ""} 项`}
        </Button>
      </footer>
    </div>
  );
}
