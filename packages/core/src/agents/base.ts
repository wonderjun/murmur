/**
 * AgentAdapter 接口：每家 agent 一个实现，把私有数据源翻译成归一化事件。
 *
 * 三个能力面（全部可选、按需实现）：
 *   installHooks —— push 平面，往 agent 的 hook 配置注入上报脚本；
 *   watch        —— pull 平面，watch/轮询本地存储吐 AgentEvent；
 *   quota        —— 额度平面，用本机凭据调官方用量端点，失败静默降级。
 *
 * 另附 JsonlTailer：JSONL 文件增量 tail 工具（pull 平面共用），
 * 以字节偏移为游标，重启续跑不重算。
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { ByokCredential } from '../credentials';
import type { Ledger } from '../ledger/db';
import type { AgentEvent, AgentId, InstallInfo, QuotaSnapshot, SessionDeleteResult, StoredSession } from '../types';

export interface AgentAdapter {
  id: AgentId;
  /** 探测安装态/版本/凭据/hook 是否已注入。 */
  detect(): Promise<InstallInfo>;
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
          await run();
        } while (pending);
      } finally {
        running = false;
      }
    })();
  };
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
      const saved = this.ledger?.getCursor(key);
      offset = saved !== null && saved !== undefined ? Number(saved) : firstRun ? 0 : statSync(path).size;
    }
    // 坏游标（NaN/负数）宁漏不重：offset=0 重读会把已入账的历史 usage 双计。
    if (!Number.isFinite(offset) || offset < 0) offset = statSync(path).size;
    const size = statSync(path).size;
    if (size < offset) offset = 0; // 文件被截断重建。
    if (size === offset) return 0;

    const fh = await open(path, 'r');
    try {
      const { bytesRead, buffer } = await fh.read(Buffer.alloc(size - offset), 0, size - offset, offset);
      if (bytesRead <= 0) return 0;
      const text = (this.leftover.get(path) ?? '') + buffer.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      this.leftover.set(path, lines.pop() ?? ''); // 最后半行留到下次。
      let consumed = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        onLine(t);
        consumed += 1;
      }
      const next = offset + bytesRead;
      this.offsets.set(path, next);
      this.ledger?.setCursor(key, String(next));
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
