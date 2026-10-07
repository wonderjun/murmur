/**
 * AgentAdapter 接口：每家 agent 一个实现，把私有数据源翻译成归一化事件。
 *
 * 三个能力面（全部可选、按需实现）：
 *   installHooks —— push 平面，往 agent 的 hook 配置注入上报脚本；
 *   watch        —— pull 平面，watch/轮询本地存储吐 AgentEvent；
 *   quota        —— 额度平面，用本机凭据调官方用量端点，失败静默降级。
 *
 * 另附 JsonlTailer：JSONL 文件增量 tail 工具（pull 平面共用），
 * 以字节偏移为游标，重启续跑不重算。半行不进持久游标（重启还能拼上前缀）；
 * 截断归零并丢掉内存半行，避免拼进新文件。
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { ByokCredential } from '../credentials';
import type { Ledger } from '../ledger/db';
import type { AgentEvent, AgentId, InstallInfo, QuotaSnapshot, SessionDeleteResult, StoredSession } from '../types';

/** adapter 自报的数据源条目（诊断探针目标）。 */
export interface DataSourceRef {
  /** 展示标签（如「会话存储」「任务库」）。 */
  label: string;
  path: string;
  kind: 'file' | 'dir' | 'sqlite';
}

export interface AgentAdapter {
  id: AgentId;
  /** 探测安装态/版本/凭据/hook 是否已注入。 */
  detect(): Promise<InstallInfo>;
  /** 诊断：pull 平面读取的数据源清单（路径/sqlite 探针目标）。 */
  dataSources?(): DataSourceRef[];
  /** 诊断：hook 安装触碰的配置文件清单（展示/Finder 定位用）。 */
  hookTargets?(): string[];
  /** 注入 hook/插件（幂等）。返回是否有改动。 */
  installHooks(): Promise<{ changed: boolean }>;
  /** 卸载我方 hook/插件条目（保留他人条目），设置页「关闭上报」用。 */
  uninstallHooks?(): Promise<{ changed: boolean }>;
  /** push 平面：把 hook POST 上来的原生 payload 翻译成事件。 */
  translateHook?(payload: unknown): AgentEvent[];
  /** pull 平面：开始 watch，返回取消函数。 */
  watch?(emit: (e: AgentEvent) => void, ledger: Ledger): Promise<() => void>;
  /** 额度快照（可选，失败静默）。byok 是用户在设置页自填的 API Key，实现方自定与本地凭据的优先级。 */
  quota?(byok?: ByokCredential): Promise<QuotaSnapshot>;
  /** 会话文件盘点：列出该 agent 的持久化会话产物（清理页数据源）。 */
  scanSessions?(): Promise<StoredSession[]>;
  /**
   * 删除指定会话产物：fs 路径经注入的 trash 进废纸篓（可恢复），
   * db 行由各 adapter 自行事务删除（不可恢复，UI 侧单列确认）。
   */
  deleteSessions?(ids: string[], trash: (path: string) => boolean): Promise<SessionDeleteResult[]>;
}

/**
 * 把一轮全量扫描串行化：运行中再被触发只记 pending，跑完补一轮。
 * fs.watch 与定时器是同一 tailAll 的双入口，并发轮次会在对方写回偏移前
 * 读到同一旧游标 → 同一段行 emit 两遍 → usage 双计。
 */
export function serialScan(run: () => Promise<void>): () => void {
  let running = false;
  let pending = false;
  return () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          pending = false;
          try {
            await run();
          } catch {
            // 单轮扫描失败不占住串行锁，已经排队的下一轮照跑。
          }
        } while (pending);
      } finally {
        running = false;
      }
    })();
  };
}

/**
 * 缓冲末尾未完成的 UTF-8 序列字节数。
 * toString 会把残缺多字节换成 U+FFFD 并吃掉这些字节，下一截就拼不回原字符。
 * 返回 0 表示整段可解码（纯续字节/非法 lead 交给 toString 替换，避免死等）。
 */
function incompleteUtf8Tail(buf: Buffer, length: number): number {
  const from = Math.max(0, length - 4);
  for (let i = length - 1; i >= from; i--) {
    const b = buf[i] ?? 0;
    if ((b & 0xc0) === 0x80) continue;
    let need = 1;
    if ((b & 0xe0) === 0xc0) need = 2;
    else if ((b & 0xf0) === 0xe0) need = 3;
    else if ((b & 0xf8) === 0xf0) need = 4;
    else return 0;
    const have = length - i;
    return have < need ? have : 0;
  }
  return 0;
}

/** JSONL 增量 tailer：记住偏移，每次调用只读新增内容并按行回调。 */
export class JsonlTailer {
  private offsets = new Map<string, number>();
  private leftover = new Map<string, string>();

  constructor(private ledger?: Ledger) {}

  private cursorKey(path: string) {
    return `jsonl:${path}`;
  }

  /** 读取 path 自上次以来的新增行并按行解析；firstRun 为 true 时从头读（回填）。 */
  async tail(path: string, firstRun: boolean, onLine: (obj: Record<string, unknown>) => void): Promise<number> {
    return this.tailRaw(path, firstRun, (line) => {
      try {
        onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 坏行跳过。
      }
    });
  }

  /** 同 tail，但回调收原始行文本——大行 JSONL 由调用方决定物化哪些字段（见 agents/json-span.ts）。 */
  async tailRaw(path: string, firstRun: boolean, onLine: (line: string) => void): Promise<number> {
    if (!existsSync(path)) return 0;
    const key = this.cursorKey(path);
    let offset = this.offsets.get(path);
    if (offset === undefined) {
      let saved: string | null | undefined;
      try {
        saved = this.ledger?.getCursor(key);
      } catch {
        // 游标读失败不能当成 0（历史 usage 会重放双计），本轮跳过这个文件，下轮再试。
        return 0;
      }
      offset = saved !== null && saved !== undefined ? Number(saved) : firstRun ? 0 : statSync(path).size;
    }
    // 坏游标（NaN/负数）宁漏不重：offset=0 重读会把已入账的历史 usage 双计。
    if (!Number.isFinite(offset) || offset < 0) offset = statSync(path).size;
    const size = statSync(path).size;
    if (size < offset) {
      // 截断/重建：内存半行属于旧文件，留下会拼进新内容；游标不归零的话，
      // 文件再长过旧偏移就检测不到截断，前缀被永久跳过。
      offset = 0;
      this.leftover.delete(path);
      this.offsets.set(path, 0);
      try {
        this.ledger?.setCursor(key, '0');
      } catch {
        // 内存已归零，本进程仍会重读；落库失败留到下次成功写入。
      }
    }
    if (size === offset) return 0;

    const fh = await open(path, 'r');
    try {
      const { bytesRead, buffer } = await fh.read(Buffer.alloc(size - offset), 0, size - offset, offset);
      if (bytesRead <= 0) return 0;
      const pending = incompleteUtf8Tail(buffer, bytesRead);
      const usable = bytesRead - pending;
      if (usable <= 0) return 0; // 末尾只有半个字符，留在文件里等下一截。
      const partialBefore = this.leftover.get(path) ?? '';
      const text = partialBefore + buffer.toString('utf8', 0, usable);
      const lines = text.split('\n');
      const partial = lines.pop() ?? '';
      this.leftover.set(path, partial); // 最后半行留到下次。
      let consumed = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        onLine(t);
        consumed += 1;
      }
      // 内存偏移停在已解码字节（不含未完成的 UTF-8）；持久游标停在当前半行开头，
      // 进程重启丢了 leftover 也能把前缀再读出来。整行都完整时两者重合。
      const next = offset + usable;
      this.offsets.set(path, next);
      const partialBytes = Buffer.byteLength(partial);
      const durable = partialBytes <= next ? next - partialBytes : next;
      try {
        this.ledger?.setCursor(key, String(durable));
      } catch {
        // 行已经交给回调，内存偏移不能退回去重放；落库失败留到进程重启后的重扫。
      }
      return consumed;
    } finally {
      await fh.close();
    }
  }
}

/** 目录递归总大小（字节）；文件则自身大小，不存在/不可读按 0 计。 */
export function dirSize(path: string): number {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try {
    for (const name of readdirSync(path)) total += dirSize(join(path, name));
  } catch {
    // 权限/竞态删除导致的读失败：按已扫到的部分算。
  }
  return total;
}

/** 读文件头部最多 max 字节（取首行元数据用，避免物化大行 JSONL）。 */
export function readHead(path: string, max = 16384): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(max);
      const n = readSync(fd, buf, 0, max, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 文件不可读时按空头处理，调用方走「没有 title」分支。
    return '';
  }
}

/** 通用 payload 取字段助手：兼容 snake/camel 两种命名。 */
export function pick(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** detail 摘要截断：压成单行、限长（面板只给一瞥，原文在 raw/数据源里）。 */
export function clip(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const slugCache = new Map<string, string | undefined>();

/**
 * projects 目录名是工作区绝对路径把 '/' 换成 '-'（Claude 系约定：非字母数字
 * 统一编码成 '-'，如 -Users-chen-Documents-flow）。逐段贪心最长匹配真实目录
 * 还原（目录名本身含 '-' 的歧义靠 existsSync 裁决），还原不出宁可不填 cwd。
 */
export function slugToPath(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  if (slugCache.has(slug)) return slugCache.get(slug);
  // slug 带前导 '-' 代表根 '/'（如 -Users-chen-x）；剥掉后首段就是根目录。
  const normalized = slug.startsWith('-') ? slug.slice(1) : slug;
  const segs = normalized.split('-');
  let path = '/';
  let i = 0;
  while (i < segs.length) {
    let hit = '';
    for (let j = segs.length; j > i; j--) {
      const cand = segs.slice(i, j).join('-');
      if (existsSync(join(path, cand))) {
        hit = cand;
        break;
      }
    }
    if (!hit) break;
    path = join(path, hit);
    i += hit.split('-').length;
  }
  const resolved = i === segs.length && path ? path : undefined;
  slugCache.set(slug, resolved);
  return resolved;
}
