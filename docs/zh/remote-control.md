# 远程控制

OCC 的远程控制（Remote Control）让外部客户端通过 Unix socket 上的 HTTP API 与守护进程交互 —— 发送 prompt、查询状态、停止任务、绑定 Slack 频道。它支持手机 App、Slack 集成、跨机器（通过 SSH 隧道）控制 OCC。

## 架构

远程控制由两部分组成（`src/daemon/`）：

- **服务器**（`remoteControlServer.ts`）—— 守护进程 supervisor 启动，监听 Unix socket，Bearer token 认证。
- **客户端**（`remoteControlClient.ts`）—— 从锁文件发现端点，通过 Unix socket 发 HTTP 请求。

```
外部客户端 ──HTTP──> Unix socket (~/.claude/daemon-remote.sock)
                          │
                  remoteControlServer (在 supervisor 进程内)
                          │
                  promptQueue / activeChannel
```

## 服务器

`startRemoteControlServer(token)`（`src/daemon/remoteControlServer.ts`）启动一个 Node `http` 服务器（无 WebSocket 库）：

- **监听地址**：`~/.claude/daemon-remote.sock`（`getRemoteControlSocketPath`，`REMOTE_SOCKET_NAME = 'daemon-remote.sock'`）。若 socket 路径 > 100 字符，回退到 `127.0.0.1` TCP 端口 0。
- **认证**：`Authorization: Bearer <token>` 头。`generateRemoteControlToken()` = `randomBytes(24).toString('hex')`，近似常数时间比较。
- **请求体上限**：256KB。

### 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 存活检查（无需认证） |
| `GET` | `/status` | supervisorPid + workers + pendingPrompts + channel |
| `POST` | `/prompt` | `{content, source?}` 入队 prompt；可选 `{channel:{name,source}}` 绑定 Slack 频道 |
| `POST` | `/prompts/drain` | 返回并清空待处理 prompts |
| `POST` | `/stop` | `{id?|pid?}` 停止任务 |
| `POST` | `/channel` | `{name, source?}` 设置/清除 Slack 频道绑定 |

### 持久状态

- `promptQueue`（内存）镜像到 `~/.claude/daemon-remote-prompts.json`（`REMOTE_PROMPTS_FILE`）。
- `activeChannel`（内存）镜像到 `~/.claude/daemon-remote-channel.json`（`REMOTE_CHANNEL_FILE`）。

两者在远程控制重启后存活。

### 数据类型

```typescript
type PendingPrompt = { id: string; content: string; receivedAt: string; source?: string };
type RemoteChannel = { name: string; source?: string };
```

## 客户端

`connectRemoteControlClient()`（`src/daemon/remoteControlClient.ts`）：

1. **发现端点** —— `resolveRemoteControlEndpoint` 读 `~/.claude/daemon.lock`，提取 `remoteControlToken` 与 `remoteControlSocketPath`。
2. **探测 socket** —— `isSocketReachable` 检查可达性。
3. **返回客户端** —— 提供 `getStatus`、`sendPrompt(content, source?)`、`stopTask({id?|pid?})`、`drainPrompts`、`setChannel(name?, source?)`。

HTTP 请求通过 Node `http.request` 的 `socketPath` 选项走 Unix socket，10 秒超时。

`fetchRemoteControlStatus()` 是非抛出的状态获取（守护进程/远程控制不可用时返回 null），供进程内 REPL 轮询器使用。

## supervisor 集成

supervisor（`src/daemon/supervisor.ts`）获取锁文件后：

1. `generateRemoteControlToken()` 生成 token。
2. `startRemoteControlServer(token)` 启动服务器。
3. `updateLockfileRemoteControl(identity, token, socketPath)` 把 token 与 socket 路径写回 `~/.claude/daemon.lock`，供客户端发现。

远程控制是**尽力而为**的 —— 守护进程没有它也能工作。

## 外部客户端连接流程

1. 读 `~/.claude/daemon.lock` → 提取 `remoteControlSocketPath` + `remoteControlToken`。
2. 向 Unix socket 发 HTTP 请求，带 `Authorization: Bearer <token>` 头。

示例（用 `curl --unix-socket`）：

```bash
# 发现端点
cat ~/.claude/daemon.lock | jq '{socket: .remoteControlSocketPath, token: .remoteControlToken}'

# 健康检查
curl --unix-socket ~/.claude/daemon-remote.sock http://localhost/health

# 发送 prompt（带 token）
curl --unix-socket ~/.claude/daemon-remote.sock \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"content":"查看 git status"}' \
  http://localhost/prompt

# 查询状态
curl --unix-socket ~/.claude/daemon-remote.sock \
  -H "Authorization: Bearer <token>" \
  http://localhost/status
```

## 跨机器控制

通过 SSH 隧道转发 Unix socket 即可从另一台机器控制：

```bash
# 在远程机器上建 SSH 隧道转发 socket
ssh -L /tmp/occ-remote.sock:~/.claude/daemon-remote.sock user@host

# 然后用本地 socket 发请求
curl --unix-socket /tmp/occ-remote.sock ...
```

## CLI 与命令

```bash
# CLI 子命令（gated）
occ remote-control
occ rc            # 别名

# 自动添加 remote_control worker 到 daemon.json
# （autoAddRemoteControlDaemonWorker）
```

> `/remote-control` 不是斜杠命令目录（`src/commands/remoteControlServer/` 是空 stub，需 `DAEMON && BRIDGE_MODE`，OCC 中均关闭，不注册）。

## /bridge 命令

`/bridge`（`src/commands/bridge/`）驱动 REPL 桥接句柄（`getReplBridgeHandle`/`isReplBridgeActive`），用于 `SendMessage` 工具的 `bridge:<session-id>` 寻址 —— 让一个 OCC 会话向另一个发消息。

## 远程控制 worker

`autoAddRemoteControlDaemonWorker`（`workerRegistry.ts`）会自动向 daemon.json 添加 `{kind:'remote_control', restart:true}` worker，确保持久的远程控制桥接。

## 安全

- **Bearer token** 认证，24 字节随机十六进制。
- **Unix socket** 本地访问（不暴露到网络）。
- **256KB 请求体上限**。
- `/health` 无需认证（仅存活检查），其余端点均需 token。

跨机器的 `bridge:` 消息发送需要**显式用户同意**（bypass 免疫）。

## 下一步

- [守护进程](./daemon.md) —— 远程控制服务器的宿主。
- [FleetView](./fleetview.md) —— 远程会话的可视化。
- [子代理](./sub-agents.md) —— `SendMessage` 的 `bridge:` 寻址。
