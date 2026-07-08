# CLI Reference

OCC's CLI is defined with [Commander.js](https://github.com/tj/commander.js) in `src/main.tsx`. The internal program name is `claude`, but the published binary is `occ` — so you invoke `occ`, and `--version` prints `2.1.200 (Claude Code)`.

```bash
occ [prompt] [options]
```

If a positional `[prompt]` is given and no subcommand matches, OCC launches an interactive session seeded with that prompt. A single-word prompt that closely matches a subcommand triggers a "Did you mean?" suggestion.

## Global options

These apply to the default command (the interactive/pipe session). "Flag" = boolean; "Value" = takes an argument.

### Core

| Flag(s) | Type | Description |
|---|---|---|
| `-h, --help` | Flag | Display help for command |
| `-v, --version` | Flag | Output the version number |
| `-d, --debug [filter]` | Optional value | Enable debug mode with optional category filter (e.g. `api,hooks` or `!1p,!file`) |
| `--debug-to-stderr` | Flag | Enable debug mode (to stderr) |
| `--debug-file <path>` | Value | Write debug logs to a file (implicitly enables debug) |
| `--verbose` | Flag | Override verbose mode setting from config |
| `-p, --print` | Flag | Print response and exit (pipe mode). **Skips the workspace trust dialog** — only use in trusted directories. |
| `--bare` | Flag | Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`. |
| `--safe-mode` | Flag | Disable all plugins, bundled skills, and hooks (for troubleshooting). Sets `CLAUDE_CODE_SAFE_MODE=1`. |

### Output & input format (pipe mode)

| Flag(s) | Type | Description |
|---|---|---|
| `--output-format <format>` | Value | `text` (default), `json`, or `stream-json` (pipe mode only) |
| `--input-format <format>` | Value | `text` (default) or `stream-json` (pipe mode only) |
| `--json-schema <schema>` | Value | JSON Schema for structured output validation |
| `--include-hook-events` | Flag | Include hook lifecycle events in stream-json output |
| `--include-partial-messages` | Flag | Include partial message chunks (stream-json only) |
| `--replay-user-messages` | Flag | Re-emit user messages from stdin (stream-json in/out only) |

### Model & reasoning

| Flag(s) | Type | Description |
|---|---|---|
| `--model <model>` | Value | Model alias (`sonnet`, `opus`) or full name (e.g. `claude-sonnet-4-6`) |
| `--effort <level>` | Value | Effort level: `low`, `medium`, `high`, `max` |
| `--agent <agent>` | Value | Agent for the session (overrides the `agent` setting) |
| `--betas <betas...>` | Variadic | Beta headers for API requests (API key users only) |
| `--fallback-model <model>` | Value | Auto-fallback when the default model is overloaded (pipe mode) |
| `--thinking <mode>` | Value | `enabled`, `adaptive`, `disabled` |
| `--max-thinking-tokens <n>` | Number | Max thinking tokens (pipe mode; deprecated, use `--thinking`) |
| `--max-turns <n>` | Number | Max agentic turns (pipe mode) |
| `--max-budget-usd <n>` | Number | Max spend in USD (pipe mode; must be > 0) |
| `--task-budget <n>` | Number | API-side task budget in tokens |

### Permissions

| Flag(s) | Type | Description |
|---|---|---|
| `--permission-mode <mode>` | Value | `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan` |
| `--dangerously-skip-permissions` | Flag | Bypass all permission checks (sandboxes only) |
| `--allow-dangerously-skip-permissions` | Flag | Allow bypassing as an option without it being the default |
| `--dangerously-skip-protected-paths` | Flag | Skip prompts for writes to `.claude/`, `.git/`, `.vscode/`, shell configs |
| `--allowedTools, --allowed-tools <tools...>` | Variadic | Allowlist tool names (e.g. `Bash(git:*) Edit`) |
| `--disallowedTools, --disallowed-tools <tools...>` | Variadic | Denylist tool names |
| `--tools <tools...>` | Variadic | Specify available built-in tools (`""` = none, `default` = all) |

### Sessions & context

| Flag(s) | Type | Description |
|---|---|---|
| `-c, --continue` | Flag | Continue the most recent conversation in the current directory |
| `-r, --resume [value]` | Optional value | Resume by session ID, or open picker with optional search term |
| `--fork-session` | Flag | When resuming, create a new session ID (use with `--resume`/`--continue`) |
| `--from-pr [value]` | Optional value | Resume a session linked to a PR by number/URL |
| `--session-id <uuid>` | Value | Use a specific session UUID |
| `-n, --name <name>` | Value | Display name for this session (shown in `/resume`, terminal title) |
| `--no-session-persistence` | Flag | Don't save sessions to disk (pipe mode) |
| `--resume-session-at <id>` | Value | Resume only messages up to a given message id (pipe mode) |
| `--rewind-files <user-message-id>` | Value | Restore files to state at a user message and exit (requires `--resume`) |

### System prompt & settings

| Flag(s) | Type | Description |
|---|---|---|
| `--system-prompt <prompt>` | Value | Replace the default system prompt |
| `--system-prompt-file <file>` | Value | Read system prompt from a file |
| `--append-system-prompt <prompt>` | Value | Append to the default system prompt |
| `--append-system-prompt-file <file>` | Value | Read append prompt from a file |
| `--settings <file-or-json>` | Value | Load additional settings from a JSON file or string |
| `--setting-sources <sources>` | Value | Comma-separated setting sources to load (`user,project,local`) |
| `--add-dir <dirs...>` | Variadic | Additional directories to allow tool access to |
| `--agents <json>` | Value | JSON object defining custom agents |

### MCP & IDE

| Flag(s) | Type | Description |
|---|---|---|
| `--mcp-config <configs...>` | Variadic | Load MCP servers from JSON files or strings |
| `--strict-mcp-config` | Flag | Use only MCP servers from `--mcp-config`, ignoring all other configs |
| `--mcp-debug` | Flag | [Deprecated: use `--debug`] Show MCP server errors |
| `--ide` | Flag | Auto-connect to an IDE on startup if exactly one is available |
| `--permission-prompt-tool <tool>` | Value | MCP tool to use for permission prompts (pipe mode) |

### Worktree & tmux

| Flag(s) | Type | Description |
|---|---|---|
| `-w, --worktree [name]` | Optional value | Create a git worktree for this session |
| `--tmux` | Flag | Create a tmux session for the worktree (requires `--worktree`) |

### Other

| Flag(s) | Type | Description |
|---|---|---|
| `--init` | Flag | Run Setup hooks with `init` trigger, then continue |
| `--init-only` | Flag | Run Setup and SessionStart:startup hooks, then exit |
| `--plugin-dir <path>` | Value (repeatable) | Load plugins from a directory for this session |
| `--disable-slash-commands` | Flag | Disable all skills |
| `--chrome` / `--no-chrome` | Flag | Enable/disable Claude in Chrome integration |
| `--file <specs...>` | Variadic | File resources to download at startup (`file_id:relative_path`) |
| `--enable-auto-mode` | Flag | Opt in to auto (AI-classified) permission mode |

> Hidden/internal flags (teammate identity, SDK URL, daemon worker, etc.) are used by OCC itself when spawning subagents and are not user-facing.

## Subcommands

### `mcp` — manage MCP servers

```bash
occ mcp serve                              # start the OCC MCP server
occ mcp list                               # list configured servers
occ mcp get <name>                         # show a server's details
occ mcp add-json <name> <json> [-s scope]  # add a server (stdio or SSE)
occ mcp remove <name> [-s scope]           # remove a server
occ mcp add-from-claude-desktop [-s scope] # import from Claude Desktop (Mac/WSL)
occ mcp reset-project-choices              # reset .mcp.json approvals
```

Scopes: `local` (default), `user`, `project`.

### `auth` — manage authentication

```bash
occ auth login [--email <email>] [--sso] [--console] [--claudeai]
occ auth status [--text]                   # default: --json
occ auth logout
```

### `daemon` — background-agent daemon

```bash
occ daemon start        # start the supervisor (default)
occ daemon stop [-a]    # stop; -a/--any forces it
occ daemon restart
occ daemon status       # show supervisor + worker status
occ daemon logs         # tail ~/.claude/daemon.log
occ daemon install      # install a persistent service (launchd/systemd)
occ daemon uninstall
occ daemon scheduled add <id> [--schedule <cron>] [--prompt <text>]
occ daemon scheduled remove <id>
occ daemon scheduled list
```

### Background sessions

```bash
occ stop <id>     # stop a background session
occ attach <id>   # open/join a background session
occ logs <id>     # print a background session log
```

### `plugin` — manage plugins

```bash
occ plugin list [--json] [--available]
occ plugin install <plugin> [-s scope]
occ plugin uninstall <plugin> [-s scope] [--keep-data]
occ plugin enable <plugin> [-s scope]
occ plugin disable [plugin] [-a] [-s scope]
occ plugin update <plugin> [-s scope]
occ plugin validate <path>
occ plugin marketplace add <source> [--scope scope]
occ plugin marketplace list [--json]
occ plugin marketplace remove <name>
occ plugin marketplace update [name]
```

### Other subcommands

| Subcommand | Purpose |
|---|---|
| `occ agents` | Show background sessions dashboard (`--json`, `--definitions`) |
| `occ doctor` | Check installation health (skips trust dialog) |
| `occ update` / `occ upgrade` | Check for and install updates |
| `occ install [target]` | Install native build (`--force`; target: `stable`/`latest`/version) |
| `occ project purge [path]` | Delete all OCC state for a project (`--dry-run`, `--all`, `-i`) |
| `occ setup-token` | Set up a long-lived auth token (subscription) |
| `occ auto-mode defaults` | Print default auto-mode rules as JSON |
| `occ auto-mode config` | Print effective auto-mode config as JSON |
| `occ auto-mode critique [--model <m>]` | Get AI feedback on your auto-mode rules |
| `occ completion <shell>` | Generate shell completion (`bash`/`zsh`/`fish`, `--output <file>`) |
| `occ ultrareview [target]` | Cloud-hosted multi-agent code review (`--json`, `--timeout <min>`) |

> Some subcommands (`server`, `ssh`, `open`, `remote-control`, `assistant`) are feature-gated and inactive in the default OCC build. See [Feature flags](./overview.md#feature-flags).

## Permission modes

`--permission-mode` accepts:

| Mode | Behavior |
|---|---|
| `default` | Prompt for approval on destructive/sensitive operations (alias: `manual`) |
| `acceptEdits` | Auto-approve file edits, still prompt for other tools |
| `auto` | AI classifier decides (requires `TRANSCRIPT_CLASSIFIER`, live in OCC) |
| `plan` | Plan mode — read-only analysis, no edits until approved |
| `bypassPermissions` | Skip all permission checks (use with `--dangerously-skip-permissions`) |
| `dontAsk` | Don't prompt; deny anything not explicitly allowed |

See [Permissions](./permissions.md) for the full model.

## Examples

```bash
# Interactive session
occ

# Pipe a single prompt
echo "explain this repo" | occ -p

# Resume the last session
occ -c

# Use Opus with high effort
occ --model opus --effort high

# Pipe mode with JSON output and a spend cap
echo "fix the failing tests" | occ -p --output-format json --max-budget-usd 5

# Plan-only review of a change
occ --permission-mode plan "review my uncommitted changes"

# Add a custom agent definition
occ --agents '{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}'

# Continue in a fresh worktree
occ -c -w fix-bug --tmux
```
