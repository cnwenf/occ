# Tools

OCC's tool system lets the model inspect and modify your codebase, run commands, browse the web, and delegate to subagents. Each tool lives in its own directory under `src/tools/<Name>/`. The tool registry (`src/tools.ts`) assembles the list, with some tools gated behind feature flags or environment variables.

## How tools work

A `Tool` (type in `src/Tool.ts`) defines: `name`, `description()`, `prompt()`, `inputSchema` (Zod), `call()`, `checkPermissions()`, `isEnabled()`, `isReadOnly()`, and optional rendering methods. `getTools()` filters the base list by deny rules, `isEnabled()`, and REPL mode.

In OCC, `feature('FLAG')` returns `true` only for allowlisted flags (`TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `MONITOR_TOOL`, `WORKFLOW_SCRIPTS`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS`). Tools gated on other flags are dead code in this build.

## File tools

### Bash

Executes a bash command with optional timeout. Working directory persists between commands.

| Field | Value |
|---|---|
| Name | `Bash` |
| Input | `command` (string), `timeout` (number, optional), `description` (optional), `run_in_background` (optional), `dangerouslyDisableSandbox` (optional) |
| Gating | Always loaded |
| File | `src/tools/BashTool/BashTool.tsx` |

Includes destructive-command blocking, bash security validators (injection/obfuscation detection), and sandbox support. See [Permissions](./permissions.md).

### Read

Reads a file from the local filesystem. Supports images (PNG/JPG), PDFs (via `pages`), and Jupyter notebooks.

| Field | Value |
|---|---|
| Name | `Read` |
| Input | `file_path` (absolute), `offset` (optional), `limit` (optional), `pages` (optional, PDF page range) |
| Gating | Always loaded; read-only, concurrency-safe |
| File | `src/tools/FileReadTool/FileReadTool.ts` |

### Edit

Performs exact string replacement in a file. Requires the file to have been read first.

| Field | Value |
|---|---|
| Name | `Edit` |
| Input | `file_path`, `old_string`, `new_string`, `replace_all` (optional) |
| Gating | Always loaded |
| File | `src/tools/FileEditTool/FileEditTool.ts` |

### Write

Writes a file to the local filesystem (creates or overwrites).

| Field | Value |
|---|---|
| Name | `Write` |
| Input | `file_path`, `content` |
| Gating | Always loaded |
| File | `src/tools/FileWriteTool/FileWriteTool.ts` |

### NotebookEdit

Edits a Jupyter notebook cell.

| Field | Value |
|---|---|
| Name | `NotebookEdit` |
| Input | `notebook_path`, `cell_id`, `new_source`, `cell_type` (`code`/`markdown`), `edit_mode` |
| Gating | Always loaded |
| File | `src/tools/NotebookEditTool/NotebookEditTool.ts` |

## Search tools

### Glob

Fast file pattern matching.

| Field | Value |
|---|---|
| Name | `Glob` |
| Input | `pattern`, `path` (optional), `tools` (optional) |
| Gating | Default on; excluded when embedded search tools present (re-addable via `--tools`) |
| File | `src/tools/GlobTool/GlobTool.ts` |

### Grep

Search tool built on ripgrep.

| Field | Value |
|---|---|
| Name | `Grep` |
| Input | `pattern`, `path`, `glob`, `output_mode`, `context`, `type`, `head_limit`, `offset`, `multiline` |
| Gating | Default on (same as Glob) |
| File | `src/tools/GrepTool/GrepTool.ts` |

## Delegation & task tools

### Agent

Launches a subagent for complex, multi-step tasks. See [Sub-agents](./sub-agents.md).

| Field | Value |
|---|---|
| Name | `Agent` (legacy alias `Task`) |
| Input | `description`, `prompt`, `subagent_type` (optional), `model` (optional), `run_in_background` (optional), `isolation` (optional), `cwd` (optional) |
| Gating | Always loaded |
| File | `src/tools/AgentTool/AgentTool.tsx` |

### TaskCreate / TaskGet / TaskUpdate / TaskList (Todo v2)

Manage a structured task list with dependencies (`blocks`/`blockedBy`) and owners. Gated on `isTodoV2Enabled()`.

| Tool | Input | File |
|---|---|---|
| `TaskCreate` | `subject`, `description`, `metadata` | `src/tools/TaskCreateTool/` |
| `TaskGet` | `taskId` | `src/tools/TaskGetTool/` |
| `TaskUpdate` | `taskId`, `subject`, `description`, `status`, `owner`, `blocks`, `blockedBy` | `src/tools/TaskUpdateTool/` |
| `TaskList` | (empty) | `src/tools/TaskListTool/` |

### TodoWrite (Todo v1)

Create/manage a simpler task list. Always loaded. `src/tools/TodoWriteTool/`.

### TaskStop / TaskOutput

Control background tasks (bash shells, background agents, workflows).

| Tool | Input | Notes |
|---|---|---|
| `TaskStop` | `task_id` | Stop a running background task |
| `TaskOutput` | `task_id`, `block`, `timeout` | Retrieve output (deprecated; prefer Read on the output file) |

### SendMessage

Send a message to another agent (teammate by name, `*` broadcast, `uds:`/`bridge:` cross-session). `src/tools/SendMessageTool/`. See [Sub-agents](./sub-agents.md).

### ListAgents (formerly ListPeers)

Lists agents you can SendMessage to: in-process subagents, other local Claude sessions. `src/tools/ListPeersTool/`. Gated on `UDS_INBOX` (off in OCC), though the local scan works regardless.

## Web tools

### WebFetch

Fetches a URL, converts to markdown, and runs a prompt against it.

| Field | Value |
|---|---|
| Name | `WebFetch` |
| Input | `url`, `prompt` |
| File | `src/tools/WebFetchTool/WebFetchTool.ts` |

### WebSearch

Searches the web. US-only.

| Field | Value |
|---|---|
| Name | `WebSearch` |
| Input | `query` (min 2 chars), `allowed_domains` (optional), `blocked_domains` (optional) |
| File | `src/tools/WebSearchTool/WebSearchTool.ts` |

### WebBrowser (navigate / get_page_text / screenshot / browser_batch)

Headless Chrome via puppeteer-core. Not feature-gated.

| Tool | Description |
|---|---|
| `navigate` | Navigate to a URL, or go forward/back in history |
| `get_page_text` | Extract raw text content of the current page |
| `screenshot` | Capture a PNG screenshot (`fullPage` optional) |
| `browser_batch` | Execute a sequence of browser actions in one round trip |

File: `src/tools/WebBrowserTool/WebBrowserTool.ts`.

## Plan & interaction tools

| Tool | Description | File |
|---|---|---|
| `EnterPlanMode` | Request entry to plan mode (read-only exploration) | `src/tools/EnterPlanModeTool/` |
| `ExitPlanMode` | Present the plan for approval and exit plan mode | `src/tools/ExitPlanModeTool/` |
| `AskUserQuestion` | Ask clarifying questions (1-4 questions, 2-4 options each) | `src/tools/AskUserQuestionTool/` |
| `Skill` | Invoke a skill by name (`skill`, `args`) | `src/tools/SkillTool/` |

## Worktree tools

| Tool | Description | File |
|---|---|---|
| `EnterWorktree` | Create an isolated git worktree and switch into it (`name` or `path`) | `src/tools/EnterWorktreeTool/` |
| `ExitWorktree` | Exit a worktree session (`action: keep\|remove`, `discard_changes`) | `src/tools/ExitWorktreeTool/` |

Gated on `isWorktreeModeEnabled()`.

## Specialized tools

### Monitor

Start a background monitor that streams events from a long-running script. Each stdout line is an event. Input: `command` (shell) or `ws` (WebSocket `{url, protocols}`), `description`, `timeout_ms`, `persistent`. Gated on `feature('MONITOR_TOOL')` (live). File: `src/tools/MonitorTool/`.

### Workflow

Run a self-contained workflow script in a sandboxed vm with `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget` primitives. Gated on `feature('WORKFLOW_SCRIPTS')` (live). See [Workflows](./workflows.md).

### PowerShell

Windows-only PowerShell command runner. Mirrors the Bash schema. Gated on `isPowerShellToolEnabled()`. File: `src/tools/PowerShellTool/`.

### LSP

Interact with Language Server Protocol servers for code intelligence. Gated on `ENABLE_LSP_TOOL` env. File: `src/tools/LSPTool/`.

### ToolSearch

Fetch full schema definitions for deferred tools. Supports `select:Read,Edit`, keyword search, and require-name queries. Gated on `isToolSearchEnabledOptimistic()`. File: `src/tools/ToolSearchTool/`.

### SearchSkills (DiscoverSkills)

Search skills by keyword. Local-only in OCC. File: `src/tools/DiscoverSkillsTool/`.

## MCP tools

Tools exposed by connected MCP servers are named `mcp__<server>__<tool>`. Plus resource tools:

| Tool | Description |
|---|---|
| `ListMcpResourcesTool` | List resources from MCP servers |
| `ReadMcpResourceTool` | Read a specific MCP resource (`server`, `uri`) |
| `ReadMcpResourceDirTool` | List children of a directory resource |
| `mcp__<server>__authenticate` | Start OAuth flow for an unauthenticated server |

See [MCP](./mcp.md).

## Cron / scheduling tools

| Tool | Description | Gating |
|---|---|---|
| `CronCreate` | Schedule a prompt to run on a cron schedule or at a specific time | scheduler enabled via `isKairosCronEnabled()` |
| `CronDelete` | Cancel a scheduled cron job by ID | same |
| `CronList` | List scheduled cron jobs | same |
| `RemoteTrigger` | Manage remote triggers via claude.ai CCR API | `feature('AGENT_TRIGGERS_REMOTE')` (off) |

Files: `src/tools/ScheduleCronTool/`, `src/tools/RemoteTriggerTool/`.

## Internal / stubbed tools

These are stubs or ant-only, not functional in the external OCC build:

| Tool | Status |
|---|---|
| `Config` | ant-only (`USER_TYPE === 'ant'`) |
| `REPL` | ant-only; wraps primitives in a VM context |
| `TungstenTool` | stub |
| `OverflowTestTool` | stub |
| `CtxInspectTool` | stub |
| `TerminalCaptureTool` | stub |
| `SnipTool` | stub |
| `VerifyPlanExecutionTool` | stub |
| `ReviewArtifactTool` | stub |
| `TeamCreate` / `TeamDelete` | deprecated (teams now implicit via Agent `name`) |
| `StructuredOutput` (SyntheticOutput) | special tool for structured output |
| `SendUserMessage` (Brief) | loaded but only referenced when KAIROS on |
| `PushNotification` | KAIROS-gated (off) |
| `Sleep` | PROACTIVE/KAIROS-gated (off) |
| `SendUserFile` / `SubscribePR` / `SuggestBackgroundPR` | stubs |

## Tool gating summary

| Gate | Tools |
|---|---|
| `feature('MONITOR_TOOL')` | Monitor |
| `feature('WORKFLOW_SCRIPTS')` | Workflow |
| `feature('UDS_INBOX')` (off) | ListAgents cross-session |
| `feature('KAIROS')`/`PROACTIVE` (off) | Sleep, PushNotification, SendUserFile |
| `USER_TYPE === 'ant'` | Config, Tungsten, REPL, SuggestBackgroundPR |
| `ENABLE_LSP_TOOL` | LSP |
| `isTodoV2Enabled()` | TaskCreate/Get/Update/List |
| `isWorktreeModeEnabled()` | EnterWorktree/ExitWorktree |
| `isPowerShellToolEnabled()` | PowerShell (Windows) |
| `hasEmbeddedSearchTools()` | excludes Glob/Grep (re-addable via `--tools`) |

## Related

- [Permissions](./permissions.md) — how tool actions are approved
- [Sub-agents](./sub-agents.md) — the Agent tool in depth
- [MCP](./mcp.md) — MCP-exposed tools
- [CLI Reference](./cli-reference.md) — `--tools`, `--allowed-tools`
