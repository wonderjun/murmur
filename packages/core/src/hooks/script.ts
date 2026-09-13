/**
 * Hook 脚本模板：生成落在 ~/.murmur/agent-hooks/<agent>.sh 的 POSIX sh 脚本。
 *
 * 行为（参照 orca 已验证模式）：
 *   1. 先吐 "{}"——不干预 agent 的 hook 决策链（cursor 等要求 stdout 是 JSON）。
 *      kimi 等无此契约的 agent 用 stdoutAck:false 关掉：UserPromptSubmit 类事件
 *      的 stdout 会被 agent 附进用户上下文，纯观察者不该注入字符。
 *   2. stdin 读 payload（codex notify 走 argv $1，两种都兼容）；stdin 是
 *      TTY 时不读——notify 场景继承的终端 stdin 会让 cat 挂住并吞用户按键。
 *   3. source ~/.murmur/endpoint 拿端口与令牌，curl POST 到 ingest；
 *      只有 202 才算送达——连接失败、401（token 轮换）、对端是复用端口的
 *      他人进程（任意状态码）一律追加 ~/.murmur/spool/<agent>.jsonl 等补投；
 *      落盘行带 _spooledAt 时刻，补投时按真实时间回放，不冒充当下。
 *   4. 永不以非零码退出——hook 失败不能影响 agent 本体。
 *
 * 脚本含 `murmur-hook v2` 标记，安装器据此识别幂等与卸载；v1（perch 时代）
 * 由迁移改写，见 migrate.ts。
 */

import type { AgentId } from '../types';

export const HOOK_MARKER = 'murmur-hook v2';

export function renderHookScript(agent: AgentId, opts?: { stdoutAck?: boolean }): string {
  const ack = opts?.stdoutAck === false ? '' : "printf '{}\\n'\n";
  return `#!/bin/sh
# ${HOOK_MARKER} — forward ${agent} hook payloads to the Murmur ingest server.
${ack}payload=""
if [ ! -t 0 ]; then payload=$({ command -p cat 2>/dev/null || cat; }); fi
if [ -z "$payload" ]; then payload="\${1:-}"; fi
if [ -z "$payload" ]; then exit 0; fi
endpoint_file="\${MURMUR_AGENT_HOOK_ENDPOINT:-$HOME/.murmur/endpoint}"
if [ -r "$endpoint_file" ]; then . "$endpoint_file" 2>/dev/null || :; fi
if [ -n "\${MURMUR_AGENT_HOOK_PORT:-}" ] && [ -n "\${MURMUR_AGENT_HOOK_TOKEN:-}" ]; then
  code=$(printf '%s' "$payload" | curl -sS -o /dev/null -w '%{http_code}' -X POST \\
    "http://127.0.0.1:\${MURMUR_AGENT_HOOK_PORT}/hook/${agent}" \\
    --connect-timeout 0.5 --max-time 1.5 \\
    -H "Content-Type: application/json" \\
    -H "X-Murmur-Hook-Token: \${MURMUR_AGENT_HOOK_TOKEN}" \\
    --data-binary @- 2>/dev/null)
  [ "$code" = "202" ] && exit 0
fi
spool_dir="$HOME/.murmur/spool"
mkdir -p "$spool_dir" 2>/dev/null || exit 0
spool_file="$spool_dir/${agent}.jsonl"
if [ -f "$spool_file" ] && [ "$(wc -c < "$spool_file" 2>/dev/null || printf 0)" -ge 5242880 ]; then exit 0; fi
printf '{"_spooledAt":%s,"p":%s}\\n' "$(date +%s)" "$payload" >> "$spool_file" 2>/dev/null || :
exit 0
`;
}
