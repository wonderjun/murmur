# Security Policy

## 支持版本

| 版本 | 状态 |
|---|---|
| 0.1.x（最新） | ✅ 接受安全修复 |

项目处于早期阶段，只有最新小版本接受安全修复。

## 报告漏洞

**请不要在公开 issue 里报告安全漏洞。**

优先使用 GitHub [Private vulnerability reporting](https://github.com/chen-wang-jun/murmur/security/advisories/new)；或邮件联系 <chen-wang-jun@foxmail.com>。请附上复现步骤与影响面，我会尽快确认并推进修复。

## 安全模型与边界

Murmur 是纯观察者：所有数据只进 `~/.murmur/`（sqlite 台账、设置、credentials.json），无遥测、无对外上报。设计上有意收敛的攻击面：

- **ingest 服务**只绑 `127.0.0.1` 随机端口，hook 上报需 `X-Murmur-Hook-Token` 鉴权（token 每次启动重新生成，0600 落盘）
- **BYOK key** 明文只存 `~/.murmur/credentials.json`（0600），不进 settings.json / RPC / 日志；对外只有掩码
- **各 agent 凭据**严格只读，绝不代刷、不回写
- **hook 脚本**任何分支 `exit 0`、stdout 只吐 `{}`，不干预 agent 决策链
- **会话产物删除**：文件/目录进废纸篓（可恢复）；db 行在事务内删除；活跃会话禁删

如果你发现以上任一边界被突破（如凭据外泄路径、hook 注入面、删除误伤），请按上方渠道报告。
