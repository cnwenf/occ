# 工具

工具是 OCC 执行实际操作的接口 —— 运行命令、读写文件、搜索代码、派生子代理等。模型在对话中决定调用哪个工具，OCC 执行后把结果返回给模型。

## 工具系统

每个工具定义在 `src/tools/<ToolName>/` 下，通过 `src/tools.ts` 的 `getAllBaseTools()` 注册。工具类型接口在 `src/Tool.ts`：

- `name` —— 发给模型的工具名（wire name）。
- `description(input, options)` —— 输入相关的一句话描述。
- `inputSchema` —— Zod 对象 schema（输入校验）。
- `call(args, context, canUseTool, parentMessage, onProgress?)` —— 执行入口。
- `isEnabled()` / `isReadOnly(input)` / `isConcurrencySafe(input)` / `isDestructive?(input)` —— 能力标记。
- `checkPermissions(input, context)` —— 权限检查。
- `prompt(options)` —— 注入系统 prompt 的长篇使用说明。

工具经 `buildTool(def)` 构造，填充安全默认值（`isEnabled→true`、`isConcurrencySafe→false`、`isReadOnly→false`、`checkPermissions→{behavior:'allow'}`）。

## 工具开关

OCC 的工具按多个条件启用（`src/tools.ts`）：

| 条件 | 在 OCC 中的值 |
|------|---------------|
| `feature(flag)` | 仅白名单 6 个 flag 为 true，其余 false |
| `isWorktreeModeEnabled()` | 恒为 true（GrowthBook 门槛已移除） |
| `isTodoV2Enabled()` | REPL 中 true；SDK/print 模式 false（除非 `CLAUDE_CODE_ENABLE_TASKS`） |
| `isPowerShellToolEnabled()` | 仅 Windows 且启用时；Linux 下 false |
| `USER_TYPE === 'ant'` | false（ant 内部专用） |
| `isToolSearchEnabledOptimistic()` | 默认 true（first-party API） |

## 文件操作

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `Read` | 读取本地文件。支持图片（PNG/JPG）、PDF、Jupyter notebook。 | 启用 |
| `Edit` | 精确字符串替换。需先 Read 过该文件。 | 启用 |
| `Write` | 写入文件（覆盖或新建）。需先 Read 过已存在文件。 | 启用 |
| `NotebookEdit` | 替换 Jupyter notebook 单元格。 | 启用 |
| `Glob` | 快速文件模式匹配，按修改时间排序返回路径（如 `**/*.js`）。 | 启用 |
| `Grep` | 基于 ripgrep 的强大搜索，支持正则、文件/类型过滤、上下文行。 | 启用 |

## Shell 执行

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `Bash` | 执行 bash 命令，可选超时。工作目录在命令间持久。 | 启用 |
| `PowerShell` | 运行 PowerShell 命令。 | 仅 Windows 启用 |

Bash 工具有多层安全校验（`src/tools/BashTool/bashSecurity.ts`）：基于 tree-sitter 的 AST 安全解析、命令注入检测、破坏性命令拦截（见 [权限](./permissions.md)）。

## 搜索与网络

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `WebFetch` | 抓取 URL 转为 markdown，用小模型回答针对内容的提问。 | 启用 |
| `WebSearch` | 网络搜索，返回结果块（标题+URL）。 | 启用 |
| `WebBrowserTool` | 浏览器操作：`navigate`、`get_page_text`、`screenshot`、`browser_batch` 等。 | 启用 |

> WebBrowser 工具暴露多个子操作（`navigate`、`get_page_text`、`screenshot`、`browser_batch`），chrome 路径可用 `OCC_WEBBROWSER_CHROME_PATH` 环境变量指定。

## 任务管理

OCC 有两代任务管理系统：

### TodoWrite（v1，始终启用）

| 工具名 | 说明 |
|--------|------|
| `TodoWrite` | 更新当前会话的 todo 列表，主动跟踪进度与待办。 |

### Task 系列（v2，REPL 中启用）

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `TaskCreate` | 在任务列表中创建新任务。 | REPL 启用 |
| `TaskGet` | 按 ID 获取任务。 | REPL 启用 |
| `TaskUpdate` | 更新任务。 | REPL 启用 |
| `TaskList` | 列出所有任务。 | REPL 启用 |
| `TaskStop` | 停止后台任务（别名 `KillShell`）。 | 启用 |
| `TaskOutput` | [已弃用] 读取任务输出文件（改用 Read）。 | 启用 |

## 代理与子代理

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `Agent` | 派生新代理处理复杂多步任务。支持隔离模式（fork/async/background/remote）。别名 `Task`。 | 启用 |
| `SendMessage` | 向其他代理发消息（teammate 邮箱、广播、bridge、uds）。 | 启用 |
| `EnterWorktree` | 创建隔离 git worktree 并切换会话进入。 | 启用（worktree 恒启用） |
| `ExitWorktree` | 退出 worktree 会话，恢复原工作目录。 | 启用 |

详见 [子代理](./sub-agents.md)。

### 团队（已弃用）

`TeamCreate` 与 `TeamDelete` 在 B11/2.1.178 弃用 —— 团队现在通过 Agent 的 `name` 参数隐式创建。不在 `getAllBaseTools()` 中注册。

## 规划

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `EnterPlanMode` | 请求进入 plan 模式，做探索与设计不执行写操作。 | 启用 |
| `ExitPlanMode` | 提示用户退出 plan 模式开始编码（ExitPlanModeV2Tool）。 | 启用 |

## 技能与工具搜索

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `Skill` | 执行技能：内联或 fork 子代理。输入 `{skill, args?}`。 | 启用 |
| `SearchSkills` | 按关键词搜索本地技能（1–8 关键词）。 | 启用（`EXPERIMENTAL_SKILL_SEARCH`） |
| `ToolSearch` | 查找延迟加载的工具（`select:<tool_name>` 或关键词）。 | 默认启用 |

`SearchSkills` 不在 `getAllBaseTools()` 中，属于技能搜索系统（`src/skills/searchSkills.ts`），在 `EXPERIMENTAL_SKILL_SEARCH` 启用时浮现。详见 [技能](./skills.md)。

## Workflow 与监控

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `Workflow` | 从自包含 `.js` 脚本运行多步 workflow，vm 沙箱内执行，提供 `agent`/`parallel`/`pipeline` 等原语。 | 启用（`WORKFLOW_SCRIPTS`） |
| `Monitor` | 启动后台监控，流式输出长运行脚本的事件（每行 stdout 一个事件）。 | 启用（`MONITOR_TOOL`） |

详见 [Workflow](./workflows.md)。

## 定时与通知

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `CronCreate` | 安排定时 prompt（cron 周期或单次）。 | 启用 |
| `CronDelete` | 按 ID 取消定时任务。 | 启用 |
| `CronList` | 列出定时任务。 | 启用 |
| `AskUserQuestion` | 向用户提多选题以澄清/决策。 | 启用 |
| `SendUserMessage` | BriefTool —— 发送通知（别名 `Brief`）。 | 启用 |

## MCP 工具

| 工具名 | 说明 | 状态 |
|--------|------|------|
| `MCPTool` | 调用已连接 MCP 服务器暴露的工具（运行时按连接合并）。 | 启用（按需） |
| `ListMcpResourcesTool` | 列出 MCP 资源。 | 连接 MCP 时启用 |
| `ReadMcpResourceTool` | 读取 MCP 资源。 | 连接 MCP 时启用 |
| `ReadMcpResourceDirTool` | 读取 MCP 资源目录。 | 连接 MCP 时启用 |
| `McpAuthTool` | 处理 MCP OAuth 认证。 | 启用 |

> `MCPTool` 是基类/模板，运行时按 MCP 连接在 `services/mcp/client.ts` 中被覆盖。MCP 工具通过 `assembleToolPool()`/`getMergedTools()` 从 `appState.mcp.tools` 合并，而非来自内置列表。详见 [MCP](./mcp.md)。

## 禁用 / Stub 工具

以下工具在 OCC 默认构建中**禁用**（feature flag 或条件为 false）：

| 工具名 | 禁用原因 |
|--------|----------|
| `RemoteTrigger` | `feature('AGENT_TRIGGERS_REMOTE')` = false |
| `ListAgents`（别名 `ListPeers`） | `feature('UDS_INBOX')` = false |
| `PushNotification` | `feature('KAIROS')` = false |
| `Sleep` | `feature('PROACTIVE')` = false |
| `TerminalCapture` | `feature('TERMINAL_PANEL')` = false（且为 stub） |
| `Config` / `REPL` / `Tungsten` | `USER_TYPE === 'ant'`（ant 专用） |
| `LSP` | `ENABLE_LSP_TOOL` 环境变量未设 |
| `OverflowTest` / `CtxInspect` / `Snip` / `SendUserFile` / `SubscribePR` / `SuggestBackgroundPR` / `VerifyPlanExecution` | 各自 feature/env flag，默认 false |

## 限制工具集

用 CLI 参数限制可用工具：

```bash
# 只允许某些工具
occ --allowed-tools "Bash(git:*) Read Edit"

# 指定工具集合
occ --tools "Bash,Read,Edit"        # 只用这三个
occ --tools "default"               # 用全部
occ --tools ""                      # 禁用全部

# 禁止某些工具
occ --disallowed-tools "Bash(rm:*)"
```

详见 [权限](./permissions.md)。

## 下一步

- [子代理](./sub-agents.md) —— Agent 工具与隔离模式。
- [Workflow](./workflows.md) —— Workflow 工具与多代理脚本。
- [权限](./permissions.md) —— 工具权限规则。
- [MCP](./mcp.md) —— MCP 工具接入。
