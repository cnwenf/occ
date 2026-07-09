# Quickstart

This guide walks through your first OCC session: interactive REPL, pipe mode, and the basics of working with the agent.

## Prerequisites

Make sure OCC is installed and your API key is set:

```bash
# Install from npm (requires Bun >= 1.3.11)
npm i -g @cnwenf/occ

# Set your Anthropic API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Verify
occ --version
# 2.1.204 (Claude Code)
```

For other providers (Bedrock, Vertex, Azure Foundry), see [Installation](./installation.md).

## Interactive REPL

Start an interactive session by running `occ` with no arguments:

```bash
occ
```

On first run in a directory, OCC shows a **trust dialog**. The working directory's `.claude/settings.json` is attacker-controllable, so OCC asks you to confirm trust before loading project-level hooks, skills, and CLAUDE.md files. Pipe mode (`-p`) skips the trust dialog — only use it in directories you trust.

Once the REPL is running you can:

- Type a prompt and press **Enter** to send it.
- Press **Shift+Enter** for a newline (multi-line input).
- Press **Up/Down** arrows to navigate prompt history.
- Type `/` to see available slash commands (Tab autocompletes).
- Press **Ctrl+C** to cancel the current turn; **Ctrl+C** again (or **Ctrl+D**) to exit.
- Press **Esc** to dismiss a dialog or cancel an in-progress edit.

## Pipe mode (non-interactive)

Pipe mode runs a single prompt and prints the result — ideal for scripts and CI:

```bash
echo "say hello" | occ -p
```

Or read the prompt from stdin:

```bash
occ -p "Refactor this function to use async/await"
```

Output format defaults to `text`. Use `--output-format json` for a single JSON result, or `--output-format stream-json` for realtime streaming:

```bash
echo "list the files in this repo" | occ -p --output-format json
```

Common pipe-mode flags:

| Flag | Purpose |
|---|---|
| `-p, --print` | Non-interactive mode (skips trust dialog) |
| `--output-format <format>` | `text` (default), `json`, `stream-json` |
| `--input-format <format>` | `text` (default), `stream-json` |
| `--max-turns <n>` | Cap agentic turns (pipe mode only) |
| `--max-budget-usd <n>` | Cap spend in USD (pipe mode only) |
| `--model <model>` | Model alias (`sonnet`, `opus`) or full name |
| `--append-system-prompt <text>` | Append to the default system prompt |

See the [CLI Reference](./cli-reference.md) for the full list.

## Dev mode (from source)

If you cloned the repo, run from source with Bun:

```bash
bun run dev
# equivalent to: bun run src/entrypoints/cli.tsx
```

Pipe mode from source:

```bash
echo "say hello" | bun run src/entrypoints/cli.tsx -p
```

## Your first task

Ask OCC to explore or change your codebase:

```
> Read src/main.tsx and summarize what the CLI flags do
```

```
> Add a --verbose flag to the build script and wire it through
```

OCC will use its tools (Read, Edit, Bash, Grep, etc.) to investigate and make changes. When a tool needs approval, you'll see a permission prompt — press **y** to allow once, or choose to allow the rule for the session.

## Useful slash commands

| Command | Purpose |
|---|---|
| `/help` | Show all available commands |
| `/model` | Switch the model (e.g. `/model opus`) |
| `/effort` | Set reasoning effort (`low`, `medium`, `high`, `max`) |
| `/compact` | Summarize the conversation to free context |
| `/clear` | Start a fresh session (old one is resumable) |
| `/resume` | Resume a previous conversation |
| `/context` | Visualize current context usage |
| `/doctor` | Diagnose your installation |
| `/config` | Open the settings panel |
| `/permissions` | Manage allow/deny tool rules |
| `/mcp` | Manage MCP servers |

See [Slash Commands](./slash-commands.md) for the full list.

## Continuing a session

Sessions are persisted to disk. To continue the most recent conversation in the current directory:

```bash
occ -c
# or: occ --continue
```

To pick a specific session (interactive picker):

```bash
occ -r
# or: occ --resume
```

Inside the REPL, use `/resume` (or `/continue`) to open the session picker.

## What's next

- [CLI Reference](./cli-reference.md) — every flag and subcommand
- [Tools](./tools.md) — the tools OCC can use
- [Permissions](./permissions.md) — how the permission model works
- [Memory](./memory.md) — CLAUDE.md and auto-memory
