# 子代理

子代理（sub-agent）是 OCC 派生的独立代理实例，处理复杂多步任务。子代理有自己的上下文、工具集和会话，可在前台或后台运行，可隔离在 git worktree 中。

## Agent 工具

工具名 `Agent`（别名 `Task`，`src/tools/AgentTool/`）：

> 启动新代理处理复杂多步任务。每个代理类型有特定能力与可用工具。

模型在对话中调用 `Agent` 工具派生子代理。子代理运行后把结果返回给主代理。

## 隔离模式

Agent 工具支持多种隔离/运行模式：

| 模式 | 说明 |
|------|------|
| `fork` | 在隔离子代理中运行（独立上下文） |
| `async` | 异步运行（后台 promise，不阻塞） |
| `background` | 后台 daemon worker（跨会话存活） |
| `remote` | 远程隔离（云/远程环境） |

技能的 `context: 'fork'` 也用 `executeForkedSkill` → `runAgent` 在隔离子代理中运行。

## 自定义代理

用 `--agents` CLI 参数或 `.claude/agents/*.md` 定义自定义代理：

```bash
# CLI 定义
occ --agents '{"reviewer": {"description": "代码审查", "prompt": "你是代码审查员"}}'

# 文件定义
mkdir -p .claude/agents
# .claude/agents/reviewer.md 含 frontmatter (name, description, prompt, tools)
```

`--agent <name>` 指定本次会话使用的代理，覆盖 `agent` 设置。

## worktree 隔离

`EnterWorktree` / `ExitWorktree` 工具（`src/tools/EnterWorktreeTool/`、`ExitWorktreeTool/`）让会话进入隔离的 git worktree：

```bash
# REPL 内
> 进入 worktree（模型调用 EnterWorktree）
# 或 CLI
occ --worktree my-feature
occ -w my-feature --tmux   # 在 tmux 中运行 worktree 会话
```

### worktree 配置

settings.json 的 `worktree` 键：

```jsonc
{
  "worktree": {
    "symlinkDirectories": ["node_modules"],
    "sparsePaths": ["src/"],
    "baseRef": "fresh",        // 从 origin/<默认分支> 分支；"head" 从当前 HEAD
    "bgIsolation": "worktree"  // 后台隔离用 worktree
  }
}
```

`isWorktreeModeEnabled()` 在 OCC 中恒为 true（GrowthBook 门槛已移除）。

### teammate 选项

`--worktree` 配合的隐藏选项（多代理 worktree 场景）：

| 选项 | 说明 |
|------|------|
| `--agent-id <id>` | 代理 ID |
| `--agent-name <name>` | 代理显示名 |
| `--team-name <name>` | 团队名 |
| `--agent-color <color>` | 代理颜色 |
| `--teammate-mode <mode>` | teammate 模式：`auto`/`tmux`/`in-process` |
| `--agent-type <type>` | 代理类型 |
| `--parent-session-id <id>` | 父会话 ID |
| `--parent-agent-id <id>` | 父代理 ID |
| `--plan-mode-required` | 强制 plan 模式 |

## 团队（Teams）

> 注意：`TeamCreate` 与 `TeamDelete` 在 B11/2.1.178 **弃用**。团队现在通过 Agent 的 `name` 参数隐式创建，不在 `getAllBaseTools()` 中注册。

团队文件由 `src/utils/swarm/teamHelpers.ts` 管理（`readTeamFile`/`writeTeamFileAsync`/`getTeamFilePath`）。`TEAM_LEAD_NAME` 常量定义领队代理。teammate 模式由 `getResolvedTeammateMode`（`src/utils/swarm/backends/registry.ts`）解析。

## SendMessage 工具

工具名 `SendMessage`（`src/tools/SendMessageTool/`），输入 `{to, summary?, message}`。按 `to` 路由：

| 寻址 | 路由 |
|------|------|
| teammate 名 | 写入 teammate 邮箱（`writeToMailbox`） |
| `*` | 广播 |
| in-process 子代理名 | `queuePendingMessage` 或 `resumeAgentBackground` 自动恢复 |
| `bridge:<session-id>` | 远程控制（`postInterClaudeMessage`，需 `isReplBridgeActive()`） |
| `uds:<socket-path>` | UDS socket（`sendToUdsSocket`） |

结构化消息类型：`shutdown_request`、`shutdown_response`、`plan_approval_response`（仅领队可批准/拒绝）。跨机器 bridge 发送需**显式用户同意**（bypass 免疫）。

> `uds:` 与 `bridge:` 寻址需 `UDS_INBOX` feature flag，OCC 中为 false（禁用）。进程内子代理与 teammate 邮箱路由仍可用。

## ListAgents 工具

工具名 `ListAgents`（别名 `ListPeers`）—— 列出可发消息的代理：进程内子代理、其他本地 OCC 会话、云端会话、远程桥接会话。

> 此工具需 `feature('UDS_INBOX')`，OCC 中为 false，**禁用**。本地会话注册表扫描（`~/.claude/sessions/*.json` PID 注册表）不运行。

## /fork 与 /branch

```bash
> /branch my-feature    # 在当前点创建会话分支
> /fork <directive>     # 派生继承完整对话的后台代理（默认禁用）
```

`/fork` 默认禁用（需 `CLAUDE_CODE_FORK_SUBAGENT=1` 或 `FORK_SUBAGENT` flag，OCC 中关闭）。未启用时 `/branch` 接受 `fork` 作为别名。

## /agents 命令

```bash
> /agents
```

`/agents` 是 stub（2.1.198 向导已移除）—— 提示让 Claude 创建/管理子代理，或编辑 `.claude/agents/`。CLI 的 `occ agents` 子命令是独立的后台会话仪表盘。

## 子代理在 FleetView 中的显示

子代理作为 `local_agent` 行类型显示在 FleetView 中（见 [FleetView](./fleetview.md)）。daemon 管理的后台会话从 `~/.claude/daemon-status.json` 读取。

## 子代理技能隔离

当技能在 fork 子代理中运行时，`sessionSkillAllowlist`（`src/skills/sessionSkillAllowlist.ts`）可限制该子代理能调用哪些技能（越权返回 errorCode 8）。

## 下一步

- [工具](./tools.md) —— Agent、SendMessage、EnterWorktree 等工具。
- [FleetView](./fleetview.md) —— 子代理的可视化。
- [Workflow](./workflows.md) —— `agent()` 原语派生子代理。
- [守护进程](./daemon.md) —— 后台 daemon worker。
