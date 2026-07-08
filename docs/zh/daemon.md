# 守护进程

OCC 的守护进程（daemon）是一个长驻监督进程，管理后台代理 worker、异步 workflow、预热池、远程控制桥接。它让你能在后台运行代理和 workflow，同时继续在 REPL 中工作。

## 守护进程做什么

守护进程（`src/daemon/`）是一个 supervisor 进程，负责：

- **派生并管理 worker 子进程** —— 后台代理、预热池、远程控制桥接、异步 workflow。
- **恢复孤儿 worker** —— supervisor 重启后回收先前存活的 worker。
- **远程控制 HTTP 服务器** —— 在 Unix socket 上提供 HTTP API（见 [远程控制](./remote-control.md)）。
- **定时任务** —— 按 cron 调度 prompt 任务。
- **状态快照** —— 写 `~/.claude/daemon-status.json` 供任何 OCC 进程的 FleetView 渲染。

> 注意：`feature('DAEMON')` 在 OCC 中为 false，但守护进程的活路径是 `main.tsx` 的 `daemon` Commander 命令树，**可用**。

## 启动与停止

```bash
# CLI 启动守护进程
occ daemon start       # 启动（默认子命令）
occ daemon status      # 查看状态
occ daemon stop        # 停止（--any/-a 停所有）
occ daemon restart     # 重启
occ daemon logs        # 查看 ~/.claude/daemon.log
```

REPL 内用 `/daemon` 命令：

```bash
> /daemon install      # 安装为系统服务
> /daemon status
> /daemon stop
> /daemon logs
> /daemon scheduled    # 列出定时任务
```

### 安装为系统服务

`occ daemon install`（`src/daemon/install.ts`）安装持久化服务：

| 平台 | 安装位置 |
|------|----------|
| macOS | `~/Library/LaunchAgents/com.anthropic.claude.daemon.plist`（`RunAtLoad`、`KeepAlive`，日志到 `~/.claude/daemon.log`） |
| Linux | `~/.config/systemd/user/claude-daemon.service` + `enable-linger $USER` |

`occ daemon uninstall` 移除它们。

## worker 注册表

守护进程配置在 `~/.claude/daemon.json`（`src/daemon/workerRegistry.ts`）：

```jsonc
{
  "workers": [
    { "kind": "prewarm", "restart": true },
    { "kind": "remote_control", "restart": true },
    { "kind": "workflow", "restart": false }
  ],
  "scheduled": [
    { "id": "daily-standup", "schedule": "0 9 * * *", "prompt": "总结昨日进展" }
  ],
  "prewarmPerSweep": 3
}
```

### worker 类型

| kind | 说明 |
|------|------|
| `default` | 通用后台代理 worker |
| `prewarm` | 预热池（提前启动备用的代理进程） |
| `remote_control` | 远程控制桥接 worker |
| `workflow` | 异步 workflow worker |

`spawnWorker(kind, opts)` 用同一入口点派生真实 `occ` 子进程（`occ --daemon-worker <kind>`），环境变量 `CLAUDE_CODE_DAEMON_WORKER=1`、`CLAUDE_CODE_DAEMON_WORKER_KIND=<kind>`。

### worker 生命周期

每个 worker 的 `WorkerRecord` 记录 `{pid, outcome, cliVersion, startedAt, cwd, restart, kind, id, exitCode}`。`WorkerOutcome` 取值：`running`、`exited_clean`、`exited_error`、`sigterm`、`sigkill`、`stalled`、`orphaned`、`respawned`。

worker 入口 `runDaemonWorker(workerId)`：
- `kind === 'workflow'` → 导入 `runWorkflowWorker`。
- 其他 → keepalive 循环（30 分钟空闲上限）+ 孤儿看门狗（每 5 秒检查 `process.ppid` 是否存活，不存活则退出并打印 "parent supervisor gone — exiting"）。

## 监督循环

supervisor（`src/daemon/supervisor.ts` 的 `runSupervisor`）生命周期：

1. **二进制身份检查** —— 自身可执行文件被删除则拒绝启动。
2. **获取锁文件** —— `~/.claude/daemon.lock`（`O_EXCL` 原子创建）。若被占用，打印 "displaced, yielding" 或 "existing daemon refused to yield"。
3. **恢复孤儿 worker** —— `recoverOrphanedWorkers`。
4. **读取 daemon.json** —— `validateDaemonJsonWorkers`。
5. **启动远程控制服务器** —— 生成 token、启动 socket、写回锁文件。
6. **注册信号处理** —— SIGTERM/SIGINT。
7. **扫描循环** —— 每 `SWEEP_INTERVAL_MS = 5000` 扫描一次：标记死亡 worker、检测 pid 回收、预热、重生 stale worker、启动 daemon.json 配置的 worker。`IDLE_SHUTDOWN_MS = 60000`（无 worker 空闲则关闭）。

## 锁文件

`~/.claude/daemon.lock`（`src/daemon/lockfile.ts`）：

```jsonc
{
  "supervisorPid": 12345,
  "supervisorProcStart": "...",
  "holderPid": 12345,
  "remoteControlToken": "<hex>",
  "remoteControlSocketPath": "~/.claude/daemon-remote.sock"
}
```

`acquireLockfile` 用 `O_EXCL` 原子创建；若持有者已死或 pid 回收则抢占。`displaceHolder` 先 SIGTERM（5 秒）再 SIGKILL。

## 后台会话命令

```bash
# 将当前任务移到后台
> /background

# 列出后台任务
> /tasks

# 按 ID 或 pid 停止
> /stop <id|pid>
```

CLI 等价：

```bash
occ stop <id>      # 停止后台会话
occ attach <id>    # 附加到后台会话
occ logs <id>      # 查看后台会话日志
occ agents         # 后台会话仪表盘（--json、--definitions）
```

## 定时任务

```bash
# 添加定时任务
occ daemon scheduled add <task-id> --schedule "<cron>" --prompt "<prompt>"

# 列出 / 移除
occ daemon scheduled list
occ daemon scheduled remove <task-id>
```

`ScheduledTask` 结构：`{id, schedule, prompt, enabled?}`。

## 冷启动

守护进程冷启动行为（`getDaemonColdStart()`）：
- `CLAUDE_CODE_DAEMON_COLD_START` 环境变量（`transient`|`ask`）优先。
- 其次 `globalConfig.daemonColdStart`。
- 默认 `transient`（按需启动，不常驻）。

设为 `ask` 则首次需要时询问用户是否启动。

## 与 FleetView 的关系

FleetView（见 [FleetView](./fleetview.md)）读取 `~/.claude/daemon-status.json` 渲染 daemon 管理的后台会话行。这是跨进程快照 —— 任何 OCC 进程的 FleetView 都能看到 daemon 管理的会话。

## 下一步

- [远程控制](./remote-control.md) —— 守护进程的 HTTP API。
- [Workflow](./workflows.md) —— 异步 workflow worker。
- [FleetView](./fleetview.md) —— 后台会话可视化。
