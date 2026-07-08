# Troubleshooting

Common issues, diagnostics, and debugging tools for OCC.

## Run `/doctor`

The fastest way to diagnose your installation:

```
> /doctor
```

`/doctor` (`src/screens/Doctor.tsx`) checks:

- **Installation** — type (`npm-global` / `npm-local` / `native` / `package-manager` / `development`), version, path, invoked binary, config install method. Warns on multiple installations or PATH mismatches.
- **Search / ripgrep** — working or not, mode (`bundled`/`vendor`/`system`).
- **Updates** — auto-update status, permissions, channel, stable/latest versions.
- **Sandbox** — sandbox status.
- **MCP parsing warnings** — malformed MCP configs.
- **Keybinding warnings** — parse errors, duplicates, reserved-shortcut conflicts in `~/.claude/keybindings.json` (when customization is enabled).
- **Environment variables** — validates `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` against bounds.
- **Agent parse errors** — malformed `.claude/agents/*.md` files.
- **Plugin errors** — count and messages.
- **Context warnings** — large CLAUDE.md files, oversized agent descriptions, MCP tools exceeding token thresholds, and unreachable (shadowed) permission rules.

In the Doctor screen, press `f` to apply a fix, `Esc` to exit.

`/status` opens the Settings panel on the Status tab (version, model, account, API connectivity, tool statuses).

## Common issues

### Bun version errors

OCC requires **Bun >= 1.3.11**. Older Bun versions cause spurious errors.

```bash
bun upgrade
bun --version
```

### API key missing

```
Error: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required
```

Fix:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or run `/login` to authenticate with an Anthropic account (OAuth). For other providers, set `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` with the appropriate cloud credentials. In `--bare` mode, only `ANTHROPIC_API_KEY` or an `apiKeyHelper` from `--settings` is accepted (OAuth/keychain are not read).

### tsc type errors (~1300)

The codebase carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types). **They do not affect Bun runtime execution.** `tsconfig.json` has `strict: false` and `skipLibCheck: true`; `tsc` is not part of CI.

**Fix:** Don't try to fix all tsc errors. Lint (Biome) is the gate:

```bash
bun run lint
```

### Feature flags are off

`feature('FLAG')` returns `true` only for flags in the `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts`): `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `MONITOR_TOOL`, `WORKFLOW_SCRIPTS`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS`. Everything else (COORDINATOR_MODE, KAIROS, PROACTIVE, QUICK_SEARCH, TERMINAL_PANEL, VOICE_MODE, etc.) returns `false` — code behind those flags is dead in this build. This is intentional, not a bug.

### React Compiler `_c()` calls in source

Components contain memoization boilerplate like `const $ = _c(N)`. This is normal React Compiler output (`react/compiler-runtime`), not hand-written code. Don't "clean it up."

### `bun:bundle` import at dev time

`import { feature } from 'bun:bundle'` works at build time. At dev-time, the polyfill in `src/entrypoints/cli.tsx` provides it. If you see `bun:bundle` resolution errors, make sure you're running via `bun run dev` (which uses the entrypoint) rather than importing `src/main.tsx` directly.

### Build fails

```bash
bun run build   # scripts/build.ts → dist/cli.js (~26-28 MB)
```

The build uses `Bun.build` with an `occBundlePlugin` that redirects `bun:bundle`'s `feature()` to a runtime allowlist so feature-gated code isn't dead-code-eliminated. If the build fails, check:

- Bun version (`bun upgrade`).
- `bun install` ran successfully.
- No syntax errors in `src/` (run `bun run lint`).

The pre-commit hook runs `biome lint` on staged `src/*.{ts,tsx,js,jsx}` files. Bypass with `--no-verify` when lint errors are from pre-existing noise.

### Permission prompts too frequent

Run `/permissions` to add allow rules, or use `--allowedTools "Bash(git:*) Read"`. Use `--permission-mode acceptEdits` to auto-approve file edits, or `auto` mode (AI-classified, requires the live `TRANSCRIPT_CLASSIFIER` flag). See [Permissions](./permissions.md).

## Debugging

### Debug mode

```bash
occ -d                 # enable debug mode
occ -d api,hooks       # filter to categories
occ -d '!1p,!file'     # exclude categories
occ --debug-file /tmp/occ.log   # log to a file
occ --debug-to-stderr            # debug to stderr
```

Env vars: `DEBUG` / `DEBUG_SDK` (truthy enables debug). `CLAUDE_CODE_DEBUG_LOG_LEVEL` sets the min log level (`verbose`/`debug`/`info`/`warn`/`error`; default `debug`). Debug logs are written to `~/.claude/`.

### Verbose mode

Press `Ctrl+O` in the REPL to toggle verbose/transcript view (full tool output + thinking). Or pass `--verbose` on startup.

### Safe mode and bare mode

```bash
occ --safe-mode   # disable all plugins, bundled skills, and hooks
occ --bare        # minimal mode (no hooks/LSP/plugins/auto-memory/CLAUDE.md)
```

Use `--safe-mode` to test whether a plugin or hook is causing a problem. Use `--bare` for the most minimal session (auth via `ANTHROPIC_API_KEY` only).

### MCP debug

```bash
occ --mcp-debug   # deprecated; prefer --debug
occ -d mcp        # filter debug to MCP
```

## Health check

```bash
bun run health   # scripts/health-check.ts
```

Reports code size, lint issues, test results, unused code (Knip), and build status.

## Tests

```bash
bun test                          # full suite
bun test test/e2e                 # e2e directory
bun test path/to/file.test.ts     # single file
```

Bun test runner (`bunfig.toml`): root `.`, 10s timeout per test. E2E tests are version-pinned under `test/e2e/`.

## Version tracking

The `.occ-research/` directory tracks alignment between OCC and the official Claude Code binary, with per-version research notes (2.1.89 through 2.1.200+).

## Reporting issues

```
> /feedback <description>
```

`/feedback` files a GitHub issue on `cnwenf/occ` (falls back to a prefilled issue URL if `gh` is unavailable). For non-trivial changes, open an issue to discuss first.

## Related

- [Installation](./installation.md) — requirements and build
- [Settings](./settings.md) — environment variables
- [Overview](./overview.md) — feature flags and trimmed modules
