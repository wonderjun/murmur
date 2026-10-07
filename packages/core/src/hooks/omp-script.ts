/**
 * omp 扩展模块模板：生成落在 <agentDir>/extensions/murmur-agent.ts 的 TS 模块。
 *
 * omp 没有 shell command hook——扩展是跑在 agent 进程内的 TS 模块
 * （pi.on(event, handler) 订阅生命周期），~/.omp/agent/extensions/ 是官方
 * 自动发现目录。行为契约与 sh hook 铁约等价：
 *   1. 只观察不改写：只挂 notification 事件（tool_call 是可拦截事件，
 *      扩展抛错会 fail-closed 拦工具，不挂）；所有 handler 永不 throw、
 *      永不返回行为改写字段。
 *   2. source ~/.murmur/endpoint 拿端口与令牌（按 mtime 缓存，事件级开销小）；
 *      fetch POST 到 ingest，只有 202 算送达——连接失败/超时/其他状态码
 *      一律追加 ~/.murmur/spool/omp.jsonl 等补投（{_spooledAt,p} 行格式与
 *      sh 脚本一致，drainSpool 回放时不冒充当下）。单文件 5MiB 上限。
 *   3. 上报不阻塞 agent：~1.2s 超时 + 单在途串行队列（FIFO 上限 64，溢出
 *      直接落 spool——murmur 长挂时边界事件不被静默顶丢）。
 *   4. 事件名直传 omp snake_case（pi.on 订阅名），翻译归一化在 core 侧做。
 *
 * 模块含 `murmur-hook v2` 标记，安装器据此识别幂等与卸载归属。
 */

import { HOOK_MARKER } from './script';

/** 生成的扩展模块源码（自包含、零依赖、双端可跑 TS/JS 发现面）。 */
export function renderOmpExtension(): string {
  return `// ${HOOK_MARKER} — forward omp session events to the Murmur ingest server.
// 纯观察者：只订阅 notification 事件，不改写行为、不注入上下文；任何失败静默。
// 手动卸载：删除本文件（或 ~/.murmur 设置页关闭该 agent 上报）。

var ENDPOINT_ENV = 'MURMUR_AGENT_HOOK_ENDPOINT';
var SPOOL_LIMIT = 5242880;
var POST_TIMEOUT_MS = 1200;

// endpoint 小文件按 mtime 缓存——事件路径上不做无谓的 re-parse。
var cachedKey = '';
var cachedCoords = null;
function hookCoords() {
  var fs = require('fs');
  var path = process.env[ENDPOINT_ENV] || ((process.env.HOME || '') + '/.murmur/endpoint');
  try {
    var st = fs.statSync(path);
    var key = st.mtimeMs + ':' + st.size + ':' + st.ino;
    if (key !== cachedKey || !cachedCoords) {
      var out = {};
      for (var line of String(fs.readFileSync(path, 'utf8')).split(/\\r?\\n/)) {
        var m = /^(?:export\\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/\\r$/, '');
      }
      cachedKey = key;
      cachedCoords = out;
    }
  } catch (e) {
    cachedKey = '';
    cachedCoords = null;
  }
  return {
    port: cachedCoords && cachedCoords.MURMUR_AGENT_HOOK_PORT,
    token: cachedCoords && cachedCoords.MURMUR_AGENT_HOOK_TOKEN,
  };
}

// spool 落盘与 sh hook 同格式：{_spooledAt:秒,p:payload}——补投按真实时间回放。
function spool(payload) {
  try {
    var fs = require('fs');
    var dir = (process.env.HOME || '') + '/.murmur/spool';
    fs.mkdirSync(dir, { recursive: true });
    var file = dir + '/omp.jsonl';
    var st = null;
    try { st = fs.statSync(file); } catch (e) {}
    if (st && st.size >= SPOOL_LIMIT) return;
    fs.appendFileSync(file, JSON.stringify({ _spooledAt: Math.floor(Date.now() / 1000), p: payload }) + '\\n');
  } catch (e) {}
}

// 单在途串行 FIFO：murmur 卡住时按序投递；队列上限外直接落 spool——
// 边界事件（turn.end/审批/会话收尾）被顶丢会把会话卡在错误的等待态。
var active = false;
var pending = [];
var PENDING_LIMIT = 64;
function post(hookEventName, extra, ctx) {
  var sessionId = '';
  var sessionFile = '';
  try {
    var sm = ctx && ctx.sessionManager;
    sessionId = typeof sm.getSessionId === 'function' ? String(sm.getSessionId() || '') : '';
    sessionFile = typeof sm.getSessionFile === 'function' ? String(sm.getSessionFile() || '') : '';
  } catch (e) {}
  var payload = { hook_event_name: hookEventName };
  for (var k in (extra || {})) payload[k] = extra[k];
  payload.session_id = sessionId || payload.session_id || '';
  payload.session_file = sessionFile;
  payload.cwd = (ctx && ctx.cwd) || '';
  if (pending.length >= PENDING_LIMIT) { spool(payload); return; }
  pending.push(payload);
  drain();
}
function drain() {
  if (active || !pending.length) return;
  var next = pending.shift();
  active = true;
  deliver(next).catch(function () {}).then(function () {
    active = false;
    drain();
  });
}
async function deliver(payload) {
  var c = hookCoords();
  if (!c.port || !c.token) { spool(payload); return; }
  try {
    var res = await fetch('http://127.0.0.1:' + c.port + '/hook/omp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Hook-Token': c.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (res.status !== 202) spool(payload);
  } catch (e) {
    spool(payload);
  }
}

// 订阅安全网：单个事件名不存在（版本差异）不能拖垮整个模块加载。
function on(pi, event, fn) {
  try { pi.on(event, fn); } catch (e) {}
}

export default function (pi) {
  on(pi, 'session_start', function (_e, ctx) { post('session_start', {}, ctx); });
  on(pi, 'session_switch', function (e, ctx) {
    post('session_switch', { previous_session_file: e && e.previousSessionFile }, ctx);
  });
  on(pi, 'session_branch', function (e, ctx) {
    post('session_branch', { previous_session_file: e && e.previousSessionFile }, ctx);
  });
  on(pi, 'session_shutdown', function (_e, ctx) { post('session_shutdown', {}, ctx); });
  // before_agent_start 带用户 prompt：最早 working 信号 + 会话标题候选（截断）。
  on(pi, 'before_agent_start', function (e, ctx) {
    var prompt = e && typeof e.prompt === 'string' ? e.prompt : '';
    post('before_agent_start', { prompt: prompt.slice(0, 500) }, ctx);
  });
  on(pi, 'agent_end', function (e, ctx) {
    post('agent_end', { will_continue: Boolean(e && e.willContinue) }, ctx);
  });
  on(pi, 'agent_settled', function (_e, ctx) { post('agent_settled', {}, ctx); });
  // turn_start 是模型往返粒度（非 prompt 粒度）——只作 working 心跳。
  on(pi, 'turn_start', function (_e, ctx) { post('turn_start', {}, ctx); });
  on(pi, 'tool_execution_start', function (e, ctx) {
    post('tool_execution_start', { tool_name: e && e.toolName }, ctx);
  });
  on(pi, 'tool_approval_requested', function (e, ctx) {
    post('tool_approval_requested', {
      session_id: e && e.sessionId,
      tool_name: e && e.toolName,
      reason: e && e.reason,
      approval_mode: e && e.approvalMode,
    }, ctx);
  });
  on(pi, 'tool_approval_resolved', function (e, ctx) {
    post('tool_approval_resolved', { tool_name: e && e.toolName, approved: Boolean(e && e.approved) }, ctx);
  });
  // message_end 只作活性心跳——usage 计量归 murmur 拉取侧 journal 独掌，
  // push 再报会同一份数据双计（字段照传留 raw，翻译侧剥离）。
  on(pi, 'message_end', function (e, ctx) {
    var m = e && e.message;
    if (!m || m.role !== 'assistant') return;
    post('message_end', { model: m.model }, ctx);
  });
}
`;
}
