/**
 * Hook ingest 服务：Bun.serve 起在 127.0.0.1 随机端口，收各 agent hook 脚本
 * POST 上来的原始 payload，交给对应 adapter 的 translate() 归一化后喂引擎。
 *
 * 路由：
 *   GET  /health            → 200 ok（hook 脚本探活）
 *   POST /hook/:agent       → 202，body 为 agent 原生 hook JSON
 * 鉴权：X-Murmur-Hook-Token 头必须匹配 endpoint 文件里的 token。
 */

import type { AgentId } from '../types';
import { removeEndpointFile, writeEndpointFile, type HookEndpoint } from './endpoint';

/** 把原始 hook payload 翻译成归一化事件（可返回多条或 null）。 */
export type HookTranslator = (payload: unknown) => unknown;

// 路由白名单：已下线 agent（claude-code）仍放行——旧 hook 脚本打进来 202 后
// 无 adapter 接收即丢弃，比 404 更安静。devin 已收编回来（agents/devin）。
const VALID_AGENTS = new Set<AgentId>([
  'kimi',
  'zcode',
  'opencode',
  'codex',
  'cursor',
  'devin',
  'qoder',
  'omp',
  'claude-code',
] as AgentId[]);

export interface IngestServer {
  endpoint: HookEndpoint;
  close(): void;
}

export function startIngestServer(opts: {
  translate: (agent: AgentId, payload: unknown) => void;
  port?: number;
}): IngestServer {
  let endpoint: HookEndpoint | null = null;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') {
        return new Response('ok');
      }
      const m = /^\/hook\/([a-z-]+)$/.exec(url.pathname);
      if (req.method === 'POST' && m && VALID_AGENTS.has(m[1] as AgentId)) {
        if (!endpoint || req.headers.get('x-murmur-hook-token') !== endpoint.token) {
          return new Response('unauthorized', { status: 401 });
        }
        // hook payload 是单行 JSON，超出即异常——拒收大 body 防无界读。
        if (Number(req.headers.get('content-length') ?? 0) > 1_048_576) {
          return new Response('too large', { status: 413 });
        }
        // Bun 在返回 Response 后会取消请求体，必须先读完再返回。
        const payload = await req.json().catch(() => null);
        if (payload !== null) {
          try {
            opts.translate(m[1] as AgentId, payload);
          } catch {
            // 翻译抛错仍回 202：非 202 会让 hook 脚本把同一条反复补投。
          }
        }
        return new Response(null, { status: 202 });
      }
      return new Response('not found', { status: 404 });
    },
  });

  endpoint = writeEndpointFile(server.port ?? 0);
  return {
    endpoint,
    close() {
      server.stop(true);
      // 退出即全停：撤下投递地址，端口被他人复用时 hook 不会把 payload 送过去。
      removeEndpointFile();
    },
  };
}
