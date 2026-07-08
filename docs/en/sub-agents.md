# Sub-agents

The `Agent` tool launches subagents — independent agent instances with their own context, tool set, and system prompt. Subagents handle complex, multi-step tasks and can run in the background or in isolated worktrees.

## The Agent tool

| Field | Value |
|---|---|
| Name | `Agent` (legacy alias `Task`) |
| Input | `description`, `prompt`, `subagent_type` (optional), `model` (optional), `run_in_background` (optional), `isolation` (optional), `cwd` (optional) |
| File | `src/tools/AgentTool/AgentTool.tsx` |

### Input parameters

| Parameter | Type | Description |
|---|---|---|
| `description` | string | Short 3-5 word task description |
| `prompt` | string | The task for the agent to perform |
| `subagent_type` | string | Agent type (selects a definition from `.claude/agents/`); defaults to `general-purpose` |
| `model` | `sonnet`/`opus`/`haiku` | Override the model (else agent def frontmatter, else inherit parent) |
| `run_in_background` | boolean | Run asynchronously; returns immediately, notifies on completion |
| `isolation` | `worktree`/`remote` | Run in an isolated git worktree (`remote` is ant-only) |
| `cwd` | string | Absolute path; overrides working dir (mutually exclusive with `isolation: "worktree"`) |

Gated fields (`cwd`, `run_in_background`, multi-agent `name`/`team_name`) are omitted from the schema when their feature flag is off, so the model never sees them.

## Agent definitions

Agent definitions are markdown files with YAML frontmatter, loaded from `.claude/agents/` (project) and `~/.claude/agents/` (user). Priority: built-in → plugin → custom (first match wins).

### Frontmatter

| Field | Type | Description |
|---|---|---|
| `name` | string (required) | The agent type identifier |
| `description` | string (required) | When to use this agent (becomes `whenToUse`) |
| `tools` | list | Tool allowlist (`*` = all) |
| `disallowedTools` | list | Tool denylist |
| `model` | string | `inherit` or a model alias |
| `effort` | string/number | Thinking effort |
| `permissionMode` | enum | Permission mode for the agent |
| `maxTurns` | int | Max agentic turns |
| `skills` | list | Skill names to preload |
| `mcpServers` | array | MCP server refs or inline configs |
| `hooks` | object | Session-scoped hooks |
| `color` | string | UI color |
| `memory` | `user`/`project`/`local` | Persistent memory scope |
| `background` | boolean | Always run as a background task |
| `isolation` | `worktree` | Run in an isolated git worktree |
| `initialPrompt` | string | Prepended to the first user turn |

The markdown **body** becomes the system prompt.

### Example agent definition

```markdown
---
name: reviewer
description: Reviews code for quality, security, and best practices. Use after writing or modifying code.
tools: ['Read', 'Grep', 'Glob', 'Bash']
model: sonnet
---

You are an expert code reviewer. Review changes for:
- Correctness and potential bugs
- Security vulnerabilities
- Performance issues
- Adherence to coding standards

Provide actionable feedback with file paths and line numbers.
```

## Built-in agents

| Agent | Description | Notes |
|---|---|---|
| `general-purpose` | Default; all tools (`*`); no static model | Uses `getDefaultSubagentModel()` |
| `Explore` | Read-only file search specialist | `disallowedTools`: Agent, ExitPlanMode, Edit, Write, NotebookEdit; `omitClaudeMd: true`; one-shot |
| `Plan` | Planning specialist | One-shot |
| `verification` | Verifies changes work end-to-end | Gated on `VERIFICATION_AGENT` flag |
| `claude-code-guide` | Answers questions about Claude Code | Non-SDK entrypoints |
| `statusline-setup` | Configures the status line | |

`Explore` and `Plan` are one-shot (`ONE_SHOT_BUILTIN_AGENT_TYPES`) — they run once and return a report; the parent never SendMessages back.

## Background agents

`run_in_background: true` runs the agent asynchronously. The tool returns immediately with `{ agentId, description, prompt, outputFile }`. The calling agent gets a completion notification later. You can read the output file or use `TaskOutput` to retrieve results.

The `background: true` frontmatter field makes an agent always run as a background task when spawned.

> In-process teammates cannot spawn background agents — they must use `run_in_background: false`.

## Worktree isolation

`isolation: 'worktree'` (or the agent def's `isolation` frontmatter) creates a temporary git worktree under `.claude/worktrees/` so the subagent works on an isolated copy of the repo. The `cwd` param is mutually exclusive with worktree isolation.

Use `EnterWorktree`/`ExitWorktree` tools to manage worktrees manually. `ExitWorktree` with `action: 'remove'` refuses if there are uncommitted changes unless `discard_changes: true`.

## Agent teams

Agents can coordinate via the `SendMessage` tool and team files.

### SendMessage

| Field | Value |
|---|---|
| Name | `SendMessage` |
| Input | `to`, `summary` (optional), `message` (string or structured) |
| File | `src/tools/SendMessageTool/SendMessageTool.ts` |

`to` can be:
- A teammate name — delivered via file-based mailbox (`~/.claude/teams/<team>/inboxes/<agent>.json`)
- `"*"` — broadcast to all team members except sender
- An in-process subagent by name/agentId — queued, or auto-resumes a stopped agent
- `"uds:<socket>"` / `"bridge:<session-id>"` — cross-session (gated on `UDS_INBOX`, off in OCC)

Structured messages support protocol responses: `shutdown_response` (`{request_id, approve}`) and `plan_approval_response` (`{request_id, approve, feedback}`).

### TeamCreate / TeamDelete

`TeamCreate` (`{ team_name, description?, agent_type? }`) creates a team with a lead. `TeamDelete` cleans up team and task directories. Both are deprecated in favor of the implicit team model (Agent `name` parameter), but still functional.

### `/team-onboarding`

A prompt command that walks you through designing a team (goal/roles/workflow/communication) and proposes a roster.

## Task* tools vs Agent tool

These are distinct families:

- **Agent tool** — spawns subagent processes/sessions.
- **TaskCreate/Update/List/Get** — manage a structured todo list (with dependencies and owners). Do NOT spawn processes.
- **TaskStop/TaskOutput** — control existing background tasks (bash shells, background agents, workflows).

`/stop` is the user-facing way to stop a background agent or daemon worker.

## Managing agents

### `/agents`

The wizard was removed in 2.1.198. It's now a stub pointing you to `.claude/agents/` or asking the model to create subagents.

### `occ agents` (CLI)

Shows a background-sessions dashboard. Flags: `--definitions` (list configured agents), `--json`. Prefers live data from the daemon RC server, falls back to the on-disk `daemon-status.json` snapshot.

## Related

- [Tools](./tools.md) — the full tool list
- [Workflows](./workflows.md) — multi-agent workflow scripts
- [Daemon](./daemon.md) — background agents and workers
- [FleetView](./fleetview.md) — fleet monitoring
