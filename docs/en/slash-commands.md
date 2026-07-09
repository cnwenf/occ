# Slash Commands

Slash commands are shortcuts invoked from the REPL prompt by typing `/` followed by the command name. OCC ships dozens of built-in commands, and you can add your own as custom skills.

## Using slash commands

Type `/` at the prompt to see a typeahead of available commands. Press **Tab** to autocomplete. Some commands take arguments (shown as an `argumentHint`); others open an interactive UI.

```
> /model opus
> /compact summarize the API design discussion
> /resume
```

Commands fall into three implementation types:

| Type | Behavior |
|---|---|
| `local` | Runs synchronously, returns text (no Ink UI) |
| `local-jsx` | Renders a React/Ink component (interactive UI) |
| `prompt` | Expands into a prompt sent to the model |

## Custom slash commands

Custom commands are markdown files with YAML frontmatter, loaded from:

- `~/.claude/skills/` (user-level) and `.claude/skills/` (project-level) — directory format: `<name>/SKILL.md`
- `~/.claude/commands/` and `.claude/commands/` (legacy) — directory or single `.md` file format

A minimal custom command:

```markdown
---
description: Lint the current file and fix issues
argument-hint: <file>
allowed-tools: Bash(biome:*)
---

Run `biome check --apply $ARGUMENTS` and summarize any remaining issues.
```

The body becomes the prompt sent to the model. Frontmatter keys include `description`, `allowed-tools`, `argument-hint`, `default-enabled` (`false` to skip loading), and `user-invocable` (`false` to hide from the prompt UI).

## Session & conversation

| Command | Description |
|---|---|
| `/clear` (`/reset`, `/new`) | Start a fresh session; the old one stays on disk and is resumable with `/resume` |
| `/compact [instructions]` | Summarize the conversation to free context (runs pre-compact hooks) |
| `/resume` (`/continue`) | Open the session picker; supports `--from-pr <url>` to resume a PR-linked session |
| `/context` | Visualize current context usage as a colored grid (reflects what the model sees) |
| `/exit` (`/quit`) | Exit the REPL (detaches from a tmux session instead of killing it) |
| `/goal <condition>` | Set a goal Claude checks before stopping (registers a Stop hook). `clear`/`off`/`none` to remove. |

## Configuration & settings

| Command | Description |
|---|---|
| `/config` (`/settings`) | Open the settings panel. Non-interactive: `/config key=value ...` (e.g. `/config theme=dark`) |
| `/model [name]` | Show the model picker, or set the model for the session (`/model default` resets). "Set as default" persists to user settings. |
| `/effort [level]` | Set effort: `low`, `medium`, `high`, `max`, `ultracode` (session-only orchestration mode), `auto` |
| `/theme` | Change the terminal theme (supports custom themes) |
| `/permissions` (`/allowed-tools`) | Manage allow/deny tool permission rules |
| `/keybindings` | Open or create `~/.claude/keybindings.json` in `$EDITOR` (preview feature) |
| `/memory` | Open a CLAUDE.md / memory file in `$EDITOR` |
| `/pause-memory` | Toggle loading of CLAUDE.md and memory files into context |
| `/doctor` | Diagnose and verify your installation and settings |
| `/init` | Generate a CLAUDE.md (and optional skills/hooks) by analyzing your codebase |

## Tools, skills, plugins, MCP, hooks

| Command | Description |
|---|---|
| `/mcp [enable\|disable [server]]` | Manage MCP servers. `/mcp reconnect <server>` reconnects. (`/mcp add` is a CLI subcommand: `occ mcp add-json`.) |
| `/plugin` (`/plugins`, `/marketplace`) | Manage installed plugins and browse the marketplace |
| `/skills` | List available skills |
| `/hooks` | View hook configurations for tool events |
| `/workflows` | Browse running and completed workflows (requires the workflow engine) |

## Git & code review

| Command | Description |
|---|---|
| `/review` | Review a GitHub PR; for your working diff use `/code-review`. Runs `gh pr view`/`gh pr diff` and produces a structured review. |
| `/code-review [level] [--fix] [--comment] [<target>]` | Multi-agent code review at a chosen effort level (`low`/`medium`/`high`/`xhigh`/`max`, default `high`). The target may be a PR number, a branch name, or omitted (reviews your current working diff). `--fix` applies verified findings; `--comment` posts them as inline PR comments. Examples: `/code-review high 1234` reviews PR #1234; `/code-review max --fix 1234` reviews and fixes. |
| `/security-review` | Security review of pending changes on the current branch (3-phase analysis, false-positive filtered) |
| `/ultrareview` | Cloud-hosted multi-agent bug hunt (~10-20 min). Gated; checks overage/Extra-Usage balance. |

> `/commit` (create a git commit) is an internal-only command in upstream builds and is stripped from the external OCC build. Use the model directly to stage and commit, or run `git` via Bash.

## Status, auth, usage

| Command | Description |
|---|---|
| `/status` | Show version, model, account, API connectivity, and tool statuses |
| `/login` | Sign in with your Anthropic account (OAuth) |
| `/logout` | Sign out and clear credentials |
| `/usage` (`/cost`, `/stats`) | Show session cost, plan usage, and activity stats |
| `/usage-credits` | Configure spend credits to keep working past a limit |
| `/version` | Print the running version (internal-only in upstream; may be unavailable) |
| `/feedback` (`/bug`) | File a GitHub issue on `cnwenf/occ` (falls back to a prefilled issue URL) |

## Background tasks, daemon, agents

| Command | Description |
|---|---|
| `/background` | Move the current task to a background daemon worker |
| `/daemon <subcommand>` | Manage the daemon: `install`, `status`, `stop`, `logs`, `scheduled` |
| `/stop [id\|pid]` | Stop a background agent/session by ID or PID (no arg lists all) |
| `/tasks` (`/bashes`) | List and manage background tasks |
| `/agents` | Stub — points you to `.claude/agents/` or asking the model to create subagents |
| `/add-dir` | Add a working directory to the session |

## Plan mode

| Command | Description |
|---|---|
| `/plan [open\|<description>]` | Enable plan mode (read-only analysis). `/plan open` opens the plan file in `$EDITOR`. With a description, it starts a planning query. |

## Help

| Command | Description |
|---|---|
| `/help` | Show help and all available commands |

## Notes on OCC-specific deviations

- **`/feedback`** files issues against the OCC repo (`cnwenf/occ`) instead of Anthropic.
- **`/agents`** wizard was removed in 2.1.198 — it's now a text stub directing you to `.claude/agents/`.
- **`/peers`** and **`/remote-control`** are feature-gated stubs (`UDS_INBOX` and `DAEMON`+`BRIDGE_MODE`) and are effectively absent in the default build.
- Several commands are lazily loaded to reduce startup time; some are feature-flag gated (workflows, fork, buddy, proactive, bridge, voice, ultraplan, torch).
- **`/vim`** does not exist as a slash command. Vim-style input is a config setting: `/config editor=vim`.

## Autocomplete

When you type `/`, the typeahead (`src/hooks/useTypeahead.tsx`) shows matching commands. After a command name and a single trailing space, it shows the command's `argumentHint`. For `prompt`-type commands with an `argNames` array, it shows progressive argument hints. `/resume <term>` searches session custom titles. Keybindings: **Tab** accepts, and there are dismiss/previous/next bindings (see [Keybindings](./keybindings.md)).

## Related

- [Skills](./skills.md) — the skill system that backs custom commands
- [Hooks](./hooks.md) — `/goal` and `/compact` register lifecycle hooks
- [CLI Reference](./cli-reference.md) — CLI subcommands like `occ mcp`, `occ daemon`
