/**
 * MCP 探测：对单个 server 定义做一次 initialize 握手，报 ok/latency/自报名。
 *
 * stdio 形（{command,args?,env?,cwd?}）：Bun.spawn 起子进程，写一行 initialize
 * JSON-RPC，读 stdout 首个完整 JSON 行即判定通——不回写、不列工具，握完手就杀。
 * remote 形（{url,headers?}）：POST initialize（Accept: application/json,
 * text/event-stream 双列），2xx + 合法 JSON-RPC 回包判通（SSE 流取首个 data: 行）。
 * Never-crash：任何异常收敛成 {ok:false,error}；探测上限 10s。
 */

import type { McpTestResult } from '../types';

/** initialize 请求体（protocolVersion 用 MCP 现行版号；capabilities 空即可握手）。 */
const INIT_MSG = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'murmur', version: '0.0.0' },
  },
};

const TIMEOUT_MS = 10_000;

/** string 值字典提取：env/headers 这类逐键 string 的脏字段，非 string 值丢弃。 */
function strMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

/** JSON-RPC 回包的 error 文案（运行时收窄：error 可能是非对象）。 */
function rpcError(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object' || !('error' in msg)) return undefined;
  const err = msg.error;
  if (!err || typeof err !== 'object') return 'JSON-RPC error';
  return 'message' in err && typeof err.message === 'string' ? err.message : 'JSON-RPC error';
}

/** JSON-RPC 回包里的 result.serverInfo（有 name 就拼 name@version 回显）。 */
function serverLabel(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object' || !('result' in msg)) return undefined;
  const result = msg.result;
  if (!result || typeof result !== 'object' || !('serverInfo' in result)) return undefined;
  const info = result.serverInfo;
  if (!info || typeof info !== 'object' || !('name' in info) || typeof info.name !== 'string') return undefined;
  return 'version' in info && typeof info.version === 'string' ? `${info.name}@${info.version}` : info.name;
}

/** def 归一成探测目标；无法探测（非对象/缺 command 与 url）返回 null。 */
function probeTarget(def: unknown): { kind: 'stdio'; command: string } | { kind: 'remote'; url: string } | null {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return null;
  const command = 'command' in def && typeof def.command === 'string' && def.command ? def.command : null;
  if (command) return { kind: 'stdio', command };
  const url = 'url' in def && typeof def.url === 'string' && def.url ? def.url : null;
  if (url) return { kind: 'remote', url };
  return null;
}

/** 探测一个 MCP server 定义（stdio 或 remote 两形自动分诊）。 */
export async function probeMcpServer(def: unknown): Promise<McpTestResult> {
  const started = Date.now();
  const target = probeTarget(def);
  if (!target) return { ok: false, latencyMs: 0, error: '条目缺 command 或 url' };
  try {
    return target.kind === 'stdio' ? await probeStdio(def, started) : await probeRemote(def, started);
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

/** stdio 探测：spawn → 写 initialize → 读首行 JSON-RPC。超时/早退/坏行都归 error。 */
async function probeStdio(def: unknown, started: number): Promise<McpTestResult> {
  const d = def as Record<string, unknown>; // probeTarget 已验证 object；命令行安全由 spawn 无 shell 保证。
  const command = String(d.command);
  const args = Array.isArray(d.args) ? d.args.map(String) : [];
  const env = { ...process.env, ...strMap(d.env) };
  const cwd = typeof d.cwd === 'string' && d.cwd ? d.cwd : undefined;

  const proc = Bun.spawn([command, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    cwd,
  });

  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    proc.stdin.write(JSON.stringify(INIT_MSG) + '\n');
    // stdin 立即收尾：stub/真 server 都可能读 EOF 才动手；不回写是探测语义。
    proc.stdin.end();

    // Bun.spawn 的 stdout 在 'pipe' 形下是 ReadableStream（库类型标的是联合）。
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // 等首个含 \n 的块；行内 JSON.parse 成功即出结果（server 也可能回 error 对象——能答即通）。
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const errText = await new Response(proc.stderr).text();
        const tail = errText.trim().split('\n').pop();
        return { ok: false, latencyMs: Date.now() - started, error: tail || '进程未应答即退出' };
      }
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf('\n');
      if (nl < 0) continue;
      const line = buf.slice(0, nl).trim();
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return { ok: false, latencyMs: Date.now() - started, error: `非 JSON-RPC 应答：${line.slice(0, 80)}` };
      }
      const errMsg = rpcError(msg);
      if (errMsg) return { ok: false, latencyMs: Date.now() - started, error: `握手被拒：${errMsg}` };
      return { ok: true, latencyMs: Date.now() - started, server: serverLabel(msg) };
    }
  } finally {
    clearTimeout(timer);
    try {
      proc.kill();
    } catch {
      // 进程可能已退——kill 幂等性不保证，吞掉。
    }
  }
}

/** remote 探测：POST initialize，Accept 双列 json+sse；SSE 响应取首个 data: JSON 行。 */
async function probeRemote(def: unknown, started: number): Promise<McpTestResult> {
  const d = def as Record<string, unknown>;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...strMap(d.headers),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(String(d.url), { method: 'POST', headers, body: JSON.stringify(INIT_MSG), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - started, error: `HTTP ${res.status}` };
    }
    // SSE：data: {json}\n\n 取首个 data 行；JSON：整 body。
    const payload = /^data:/m.test(text) ? (text.match(/^data:\s*(.+)$/m)?.[1] ?? '') : text;
    let msg: unknown;
    try {
      msg = JSON.parse(payload);
    } catch {
      return { ok: false, latencyMs: Date.now() - started, error: '回包非合法 JSON-RPC' };
    }
    const errMsg = rpcError(msg);
    if (errMsg) return { ok: false, latencyMs: Date.now() - started, error: `握手被拒：${errMsg}` };
    return { ok: true, latencyMs: Date.now() - started, server: serverLabel(msg) };
  } finally {
    clearTimeout(timer);
  }
}
