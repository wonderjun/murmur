/**
 * codex app-server 额度通道（官方 JSON-RPC，CodexBar 同款路径）。
 *
 * `codex app-server` 默认走 stdio：换行分隔的 JSON-RPC（线上省略 "jsonrpc" 头）。
 * 与直读 auth.json 打私有端点不同——登录态与 token 刷新由 codex 本体负责，
 * 我们只做 initialize → initialized → account/rateLimits/read 一发即走
 * （oneshot 不留常驻进程，对齐「退出即全停」）。
 * 响应 GetAccountRateLimitsResponse.rateLimits = {primary,secondary,planType,...}，
 * RateLimitWindow = {usedPercent, windowDurationMins, resetsAt}。
 * 任何一步失败抛错，由 codex.ts 回落 wham/usage 兜底。
 */

import type { QuotaSnapshot, QuotaWindow } from '../types';

/** app-server 单次 RPC 全程超时。 */
const RPC_TIMEOUT_MS = 8_000;

/** codex 可执行文件：MURMUR_CODEX_BIN 覆盖（测试 fixture/非常规安装）→ PATH。 */
function codexBin(): string {
  const fromEnv = process.env.MURMUR_CODEX_BIN;
  if (fromEnv) return fromEnv;
  const found = Bun.which('codex');
  if (!found) throw new Error('codex 不在 PATH');
  return found;
}

/** windowDurationMins → 展示标签（300→5h、1440→每日、10080→每周）。 */
function windowMinutesLabel(mins: unknown): string {
  if (typeof mins !== 'number' || mins <= 0) return '周期';
  if (mins === 1440) return '每日';
  if (mins === 10080) return '每周';
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

/** 把 stdout 流切成 JSONL 行迭代器。 */
async function* jsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i = buf.indexOf('\n');
      while (i >= 0) {
        yield buf.slice(0, i);
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
    }
    if (buf.trim()) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** account/rateLimits/read 的 result → QuotaSnapshot。 */
function toSnapshot(result: unknown): QuotaSnapshot {
  const r = (result ?? {}) as Record<string, unknown>;
  const rl = (r.rateLimits ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const push = (row: unknown) => {
    const w = row as Record<string, unknown> | null | undefined;
    if (!w || typeof w.usedPercent !== 'number') return;
    windows.push({
      label: windowMinutesLabel(w.windowDurationMins),
      usedPct: Math.min(100, Math.round(w.usedPercent)),
      resetsAt: typeof w.resetsAt === 'number' ? (w.resetsAt > 1e12 ? w.resetsAt : w.resetsAt * 1000) : null,
    });
  };
  push(rl.primary);
  push(rl.secondary);
  const snap: QuotaSnapshot = { agent: 'codex', windows, fetchedAt: Date.now() };
  if (typeof rl.planType === 'string') snap.plan = rl.planType;
  if (!windows.length && r.ordinaryUsageAllowed !== true) snap.error = '未登录或额度不可用';
  return snap;
}

/** oneshot 拉取 codex 额度快照；失败抛错由调用方回落 wham。 */
export async function fetchCodexQuotaViaAppServer(): Promise<QuotaSnapshot> {
  const proc = Bun.spawn([codexBin(), 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const timer = setTimeout(() => proc.kill(), RPC_TIMEOUT_MS);
  try {
    const send = (msg: Record<string, unknown>) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    const it = jsonLines(proc.stdout);
    // 等指定 id 的响应；通知与无关响应跳过。
    const waitFor = async (id: number): Promise<Record<string, unknown>> => {
      for (;;) {
        const next = await it.next();
        if (next.done) throw new Error('app-server 提前退出');
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(next.value) as Record<string, unknown>;
        } catch {
          continue; // 非 JSON 行（日志噪声）跳过。
        }
        if (msg.id === id) return msg;
      }
    };
    // 每连接一次握手：先于一切业务请求，否则服务端回 "Not initialized"。
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'murmur', title: 'Murmur', version: '0' } } });
    const init = await waitFor(0);
    if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
    send({ method: 'initialized', params: {} });
    send({ id: 1, method: 'account/rateLimits/read', params: {} });
    const res = await waitFor(1);
    if (res.error) throw new Error(`rateLimits/read: ${JSON.stringify(res.error)}`);
    return toSnapshot(res.result);
  } finally {
    clearTimeout(timer);
    try {
      proc.kill();
    } catch {
      // 进程已退出时 kill 可能抛错，忽略。
    }
  }
}
