/**
 * 会话文件管理页（管理台 files tab，#/manage/files）：跨 agent 盘点磁盘会话产物。
 *
 * PageHead 标题 + 规模 meta（跟随筛选联动）+ 刷新/删除 actions；surface-1
 * 容器内 sticky 表头 + ScrollArea 行列表。勾选批量删除——文件/目录进废纸篓
 * （可恢复），「库内」行是数据库记录永久删（标 needsVacuum 时提示文件体积需
 * 压实才回收）。活跃会话禁删（checkbox disabled + 「活跃」琥珀标）。
 * 行可 Tab 聚焦（role=checkbox，空格/回车勾选），Finder 按钮随行聚焦显形。
 */

import { ArrowDown, ArrowUp, FolderSearch, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import AgentIcon from "@/components/agent-icon";
import Murmuration from "@/components/murmuration";
import PageHead from "@/components/page-head";
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

type SortKey = "modifiedAt" | "sizeBytes" | "title";
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
        "flex items-center gap-0.5 text-left text-micro font-semibold transition-colors duration-fast",
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

/* 列宽：860 窗内为标题列挤到 ≥230px（~20 汉字）——chk 28/图标 24/项目 96/
   大小 64/修改 80/Finder 28，列距 gap-x-1.5；标题 flex-1 min-w-0 truncate。 */
const GRID = "grid grid-cols-[28px_24px_minmax(0,1fr)_96px_64px_80px_28px] items-center gap-x-1.5";

export default function SessionsView({ embedded }: { embedded?: boolean }) {
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
  /* 头部规模合计跟随当前筛选（联动）；扫时间是全量扫描时刻，不随筛选变。 */
  const filteredBytes = filtered.reduce((s, i) => s + i.sizeBytes, 0);

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

  const headCell = "text-micro font-semibold text-faint";

  return (
    <div className="flex h-full flex-col">
      {/* 顶部拖拽条：独立窗时给 hiddenInset 红绿灯让位；管理台嵌入态由外壳出 chrome。 */}
      {!embedded && <div className="h-8 shrink-0" />}

      <PageHead
        title="会话文件"
        meta={
          items ? `${filtered.length} 项 · 共 ${fmtBytes(filteredBytes)} · 扫描于 ${fmtFileTime(scannedAt)}` : "扫描中…"
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              title="重新扫描"
              aria-label="重新扫描"
              disabled={scanning}
              onClick={() => void rescan()}
            >
              <RefreshCw size={14} />
            </Button>
            {selectedItems.length > 0 && (
              <Button
                variant={armed ? "destructive" : "destructiveSoft"}
                disabled={deleting}
                onClick={() => void doDelete()}
              >
                <Trash2 size={11} />
                {deleting ? "删除中…" : armed ? "确认删除" : `删除 ${selectedItems.length} 项`}
              </Button>
            )}
          </>
        }
      />

      {/* 筛选行：工具分段（胶囊溢出轨内横滚）+ 项目下拉（联动收窄）；窄窗允许折行，下拉保持右对齐 */}
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <Segmented
          options={[
            { value: "all" as const, label: "全部" },
            ...agents.map((a) => ({ value: a, label: AGENT_META[a].name })),
          ]}
          value={agentFilter}
          onChange={(v) => setAgentFilter(v)}
          label="按工具过滤"
        />
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="ml-auto w-55 max-w-full" aria-label="按项目过滤">
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

      {/* 表容器：surface-1 叠层。横滚层在 ScrollArea 外（overflow-x-auto 若放 viewport
          内会截胡 sticky 表头的滚动容器），内层 min-w 520px 保列宽可横滚；
          sticky 表头 + 行列表共用 ScrollArea 的纵向滚动区 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-item bg-surface-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
          <div className="flex h-full min-w-130 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              {items === null && scanning ? (
                <div className="flex flex-col gap-2 p-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-9 animate-pulse rounded-item bg-surface-2" />
                  ))}
                </div>
              ) : (
                <>
                  {/* 表头（sticky）：激活列前景色 + 方向箭头 */}
                  <div className={cn(GRID, "sticky top-0 z-10 h-9 bg-surface-2 px-3")}>
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={toggleAll}
                      disabled={!selectable.length}
                    />
                    {/* 图标列表头：须占住 grid 格（sr-only 是 absolute 会让后续列左移一格），用 overflow 裁掉文字 */}
                    <span className={cn(headCell, "overflow-hidden text-transparent select-none")} aria-label="工具">
                      工具
                    </span>
                    <SortHead label="会话" k="title" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    <span className={headCell}>项目</span>
                    <SortHead
                      label="大小"
                      k="sizeBytes"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                      className="justify-end"
                    />
                    <SortHead
                      label="修改"
                      k="modifiedAt"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                      className="justify-end"
                    />
                    <span />
                  </div>

                  {filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 px-3 py-16">
                      <Murmuration size={120} />
                      <p className="text-body text-muted-foreground">没有会话产物</p>
                      <p className="text-meta text-faint">接入的 CLI 跑过会话后会出现在这里</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-hairline/60">
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
                              "group h-10 cursor-pointer px-3 transition-colors duration-fast focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/45",
                              checked ? "bg-surface-3/60" : "hover:bg-surface-2 focus-visible:bg-surface-2",
                              i.active && "opacity-60",
                            )}
                            onClick={() => toggleOne(i)}
                            onKeyDown={(e) => {
                              // 行内 Checkbox 等子控件的按键不抢，只认落在行身的 Space/Enter。
                              if (e.target !== e.currentTarget) return;
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
                            <AgentIcon agent={i.agent} size={18} />
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className="select-text truncate text-detail text-foreground"
                                title={i.title ?? i.id}
                              >
                                {i.title || i.id}
                              </span>
                              {i.kind === "db" && <span className="shrink-0 text-micro text-faint">库内</span>}
                              {i.active && <span className="shrink-0 text-micro text-waiting">活跃</span>}
                            </div>
                            <span className="select-text truncate text-meta text-muted-foreground" title={i.project}>
                              {projectName(i.project)}
                            </span>
                            <span className="text-right font-data text-meta tabular-nums text-muted-foreground">
                              {fmtBytes(i.sizeBytes)}
                            </span>
                            <span className="text-right font-data text-meta tabular-nums text-faint">
                              {fmtFileTime(i.modifiedAt)}
                            </span>
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
                </>
              )}
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* 尾行：选择汇总 / 操作回报（删除按钮已上提至 PageHead actions） */}
      <p className="pt-2.5 text-meta text-muted-foreground">
        {selectedItems.length
          ? `已选 ${selectedItems.length} 项 · ${fmtBytes(selectedBytes)}${selectedDb ? ` · 含 ${selectedDb} 项库内记录（永久删）` : ""}`
          : (notice ?? "勾选会话后可批量删除，文件类进废纸篓")}
        {notice && selectedItems.length > 0 && <span className="ml-2 text-faint">{notice}</span>}
      </p>
    </div>
  );
}
