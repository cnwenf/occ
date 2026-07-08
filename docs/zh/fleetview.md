# FleetView

FleetView 是 OCC REPL 中渲染在输入框下方的可导航代理/workflow 行列表。它让你一眼看到所有正在运行和已完成的后台任务、子代理、workflow，并能快速查看其状态。

## FleetView 是什么

FleetView（`src/components/FleetView/`）是一个内联的可导航行列表，composer（输入框）固定在底部，行列表在其上方滚动。它从两个数据源读取：

- **`appState.tasks`** —— 进程内的子代理、workflow、bash 任务等。
- **`readDaemonStatus()`** —— 守护进程管理的后台会话（跨进程快照，存在 `~/.claude/daemon-status.json`）。

这让任何 OCC 进程的 FleetView 都能看到 daemon 管理的会话。

## 行类型

FleetView 渲染多种行类型（`src/components/FleetView/rowHelpers.ts`）：

| 行类型 | 说明 | 渲染组件 |
|--------|------|----------|
| `local_agent` | 进程内子代理 | `AgentProgressLine` |
| `local_bash` | 后台 bash 任务 | — |
| `remote_agent` | 远程代理 | — |
| `in_process_teammate` | 进程内 teammate | — |
| `local_workflow` | workflow 运行 | — |
| `monitor_mcp` | MCP 监控任务 | — |
| `dream` | 后台记忆整合任务 | `BackgroundTask` |

## 导航

| 按键 | 作用 |
|------|------|
| `↑` / `↓` | 上下导航行 |
| `Enter` | 查看行的 `SessionPreview`（会话预览） |
| `Esc` | 退出预览/返回 |

## 空状态

无任务时，`fleetAgentSuggestions()` 显示 onboarding 提示，建议你启动代理或 workflow。

## 辅助函数

`rowHelpers.ts` 提供：

- `fleetTitle` —— 行标题。
- `fleetAgentSuggestions` —— 空状态建议。
- `fleetVerticalBudget` —— 垂直空间预算。
- `glyphColor` —— 状态图标颜色。
- `jobLabel` —— 任务标签。
- `formatJobAge` —— 任务年龄格式化。
- `actionableStatus` —— 可操作状态。

## 相关轮询

FleetView 的数据由这些轮询器驱动：

- `src/hooks/useWorkflowProgressPoller.ts` —— 轮询 `~/.claude/wf-progress/<runId>.json` 更新 workflow 进度。
- `src/utils/wfProgress.ts` —— workflow 进度读写工具。

## 开启 FleetView

默认左箭头（`←`）打开 FleetView（`leftArrowOpensAgents` 默认 true）。可用 `/config` 关闭。

## 与团队/子代理的关系

FleetView 是团队协作的视图层。子代理（Agent 工具派生）和 teammate 会作为行出现在 FleetView 中。`ListAgents` 工具（别名 `ListPeers`）因 `UDS_INBOX` 关闭而禁用，但 FleetView 仍能渲染进程内子代理。

详见 [子代理](./sub-agents.md) 与 [守护进程](./daemon.md)。

## 下一步

- [子代理](./sub-agents.md) —— FleetView 中显示的代理。
- [守护进程](./daemon.md) —— 后台会话来源。
- [Workflow](./workflows.md) —— `local_workflow` 行类型。
