# Hooks

Hooks let you run custom logic at specific lifecycle points — before/after tool calls, on session start/stop, on user prompt submission, etc. They are configured in `settings.json` and run as shell commands, prompts, agent calls, HTTP requests, or MCP tool calls.

## Hook events

Hooks are keyed by event in the `hooks` object of `settings.json`. Each event has an array of matchers, each with a `matcher` field (where applicable) and a `hooks` array.

| Event | Matcher | When it fires |
|---|---|---|
| `PreToolUse` | `tool_name` | Before a tool call; can allow/deny/modify input |
| `PostToolUse` | `tool_name` | After a tool call succeeds; can modify output |
| `PostToolUseFailure` | `tool_name` | After a tool call fails |
| `PostToolBatch` | — | Once per tool batch, before the next model request |
| `Notification` | `notification_type` | When a notification is shown (permission prompt, idle, etc.) |
| `UserPromptSubmit` | — | When the user submits a prompt; can block |
| `UserPromptExpansion` | `command_name` | When a slash command expands |
| `SessionStart` | `source` | Session start (startup, resume, clear, compact) |
| `SessionEnd` | `reason` | Session end (clear, logout, exit, other) |
| `PostSession` | — | After session end |
| `Stop` | — | When the model stops; can continue the conversation |
| `SubagentStop` | — | When a subagent stops; can continue it |
| `PreCompact` | `trigger` | Before compaction; can block |
| `PostCompact` | `trigger` | After compaction |
| `PermissionRequest` | `tool_name` | Permission prompt; can allow/deny via JSON |
| `PermissionDenied` | `tool_name` | When a permission request is denied |
| `Setup` | `trigger` | Setup hooks (init, maintenance) |
| `TeammateIdle` | — | When a teammate goes idle |
| `TaskCreated` / `TaskCompleted` | — | Task list events |
| `Elicitation` / `ElicitationResult` | `mcp_server_name` | MCP elicitation dialogs |
| `ConfigChange` | `source` | When settings files change |
| `InstructionsLoaded` | `load_reason` | When CLAUDE.md/rules load (observability only) |
| `CwdChanged` | — | When the working directory changes |
| `FileChanged` | filenames | When watched files change |
| `WorktreeCreate` / `WorktreeRemove` | — | Worktree lifecycle |
| `MessageDisplay` | — | When a message is displayed |

## Hook command types

Each hook entry is one of five types:

### `command` (shell)

```json
{
  "type": "command",
  "command": "prettier --write \"$FILE_PATH\"",
  "shell": "bash",
  "timeout": 10,
  "async": true
}
```

Fields: `command`, `if` (permission-rule filter, e.g. `"Bash(git *)"`), `shell` (`bash`/`powershell`), `timeout` (seconds), `statusMessage`, `once` (remove after run), `async` (background, non-blocking), `asyncRewake` (background, wakes model on exit 2), `args` (exec form, no shell), `continueOnBlock` (feed rejection to model and continue).

### `prompt` (LLM eval)

```json
{
  "type": "prompt",
  "prompt": "Check $ARGUMENTS for secrets.",
  "model": "haiku",
  "timeout": 30
}
```

### `agent` (agent verification)

```json
{
  "type": "agent",
  "prompt": "Verify the test suite passes",
  "model": "haiku",
  "timeout": 60
}
```

### `http`

```json
{
  "type": "http",
  "url": "https://example.com/webhook",
  "headers": { "Authorization": "Bearer $WEBHOOK_TOKEN" },
  "allowedEnvVars": ["WEBHOOK_TOKEN"],
  "timeout": 10
}
```

`headers` supports `$VAR`/`${VAR}` interpolation, gated by `allowedEnvVars` (required for interpolation). URLs must be in the `allowedHttpHookUrls` allowlist.

### `mcp_tool`

```json
{
  "type": "mcp_tool",
  "server": "my-server",
  "tool": "validate",
  "input": { "path": "${tool_input.file_path}" },
  "timeout": 10
}
```

Invokes an MCP tool on a connected server. `${path}` expressions interpolate from the hook input JSON.

## Input (stdin JSON)

Hooks receive JSON on stdin. Base fields (all events): `session_id`, `transcript_path`, `cwd`, `permission_mode`, `agent_id`, `agent_type`, `effort: { level }`.

Event-specific fields:

| Event | Extra fields |
|---|---|
| `PreToolUse`/`PostToolUse` | `tool_name`, `tool_input`, `tool_use_id` (+ `response` for PostToolUse) |
| `PostToolUseFailure` | + `error`, `error_type`, `is_interrupt`, `is_timeout` |
| `UserPromptSubmit` | `prompt` |
| `SessionStart` | `source` (startup, resume, clear, compact) |
| `SessionEnd` | `reason` (clear, logout, prompt_input_exit, other) |
| `Stop` | in-flight background tasks + session crons |
| `SubagentStart`/`SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path` |
| `PreCompact`/`PostCompact` | `trigger` (manual, auto); PostCompact adds `summary` |
| `PermissionRequest` | `tool_name`, `tool_input` |
| `ConfigChange` | `source`, `file_path` |
| `FileChanged` | `file_path`, `event` (change, add, unlink) |
| `CwdChanged` | `old_cwd`, `new_cwd` |

String fields are capped at 1000 chars.

## Output & exit codes

### Exit codes

| Code | Behavior |
|---|---|
| `0` | Success (stdout handling varies by event) |
| `2` | Blocking — show stderr to model/user and block (PreToolUse blocks the call; UserPromptSubmit blocks processing; Stop continues the conversation; PreCompact blocks compaction) |
| other | Show stderr to user only, continue |

`StopFailure` is fire-and-forget. `InstructionsLoaded` is observability-only. `SessionStart`/`Setup`/`PostSession` ignore blocking.

### JSON output (stdout)

Stdout can be JSON (`SyncHookJSONOutput`):

```json
{
  "continue": false,
  "decision": "approve",
  "systemMessage": "Formatted the file",
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "permissionDecisionReason": "Pre-commit formatter passed",
    "updatedInput": { "command": "echo formatted" },
    "additionalContext": "..."
  }
}
```

- `continue: false` — prevent continuation (with optional `stopReason`)
- `decision`: `"approve"` / `"block"` (legacy)
- `hookSpecificOutput` — must match the event. For `PreToolUse`: `permissionDecision` = `allow`/`deny`/`ask`/`defer`; `updatedInput`; `additionalContext`.

PreToolUse permission resolution: a hook `allow` does **not** bypass `deny`/`ask` rules in settings.json (rule-based checks still apply); a hook `deny` always blocks; a hook `ask` forces a prompt.

## Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "node check-file-length.js",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "prettier --write \"$FILE_PATH\"", "async": true }
        ]
      }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "echo done >> ~/done.log" } ] }
    ]
  },
  "disableAllHooks": false,
  "allowManagedHooksOnly": false,
  "allowedHttpHookUrls": ["https://example.com/*"],
  "httpHookAllowedEnvVars": ["WEBHOOK_TOKEN"]
}
```

### Hook sources

| Source | File |
|---|---|
| `userSettings` | `~/.claude/settings.json` |
| `projectSettings` | `.claude/settings.json` |
| `localSettings` | `.claude/settings.local.json` |
| `policySettings` | managed |
| `pluginHook` | plugin `hooks/hooks.json` (lowest priority) |
| `sessionHook` | in-memory (temporary) |
| `builtinHook` | built-in |

`allowManagedHooksOnly` (policy only) hides all but managed hooks. `disableAllHooks` disables everything. `--safe-mode` disables all hooks for troubleshooting.

## Managing hooks

### `/hooks`

Opens `HooksConfigMenu` — view hooks grouped by event and matcher.

### Skill-declared hooks

Skills can declare `hooks:` frontmatter. On skill load, they're registered as session hooks (`addSessionHook`) for the session duration. `once: true` hooks auto-remove after first successful execution. `CLAUDE_PLUGIN_ROOT` env is set from the skill root.

## Related

- [Settings](./settings.md) — `hooks`, `disableAllHooks`, `allowedHttpHookUrls`
- [Skills](./skills.md) — skill-declared hooks
- [Permissions](./permissions.md) — PreToolUse permission resolution
