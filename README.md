# Open C Code (OCC)

> A safe, open-source coding agent — capabilities aligned with Claude Code.

[![npm version](https://img.shields.io/npm/v/@cnwenf/occ.svg)](https://www.npmjs.com/package/@cnwenf/occ)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-%23000000.svg)](https://bun.sh/)
[![Tracks: Claude Code 2.1.282](https://img.shields.io/badge/Tracks-Claude%20Code%202.1.282-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

[简体中文](./README.zh-CN.md) · **English**

---

## What is OCC

**Open C Code (OCC)** is an open-source coding agent. Its capabilities are aligned with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (currently tracking `2.1.282` — the OCC-137 round, 2026-09-26, landed the byte-verified 2.1.282 P1 settings-trust security clusters (86 changelog entries triaged + a full v281↔v282 linux-x64 ELF binary diff against the official v2.1.282 binary, md5 `54435b7e…`; **five security clusters (A–E)** — mid-pattern `:*` Bash rules respected from all sources with the official startup warnings, policy-source strict parse (fail-closed boolean locks + partial-block salvage so one invalid nested value no longer discards a whole `permissions`/`autoMode`/`worktree`/`attribution` block), the project/local telemetry-env blocklist + `sandbox.excludedCommands` managed scoping, frontmatter `allowed-tools` grant gating + `anthropic-skills`/`claude-ai` reserved-namespace anti-squatting, and the macOS kernel-path/automounter denylist + fail-closed symlink gate for CLAUDE.md/rules repo symlinks — plus the `maxProseWidth` and telemetry startup-notice + `/status`/`doctor` UI batch; REPL tmux + official-binary string A/B verified; session/transport reliability items judged NO-OP/STAGE (backend-dependent) and the vim batch STAGE — honest partial, full triage and forensics ledger in `docs/upstream-version-gap-occ97-2026-09.md`); the OCC-96 round, 2026-09-25, landed the byte-verified portable subset of 2.1.281 (176 changelog entries triaged + a full v280↔v281 linux-x64 ELF binary diff; **39 byte-verified ports including 9 security ports** — headlined by the S1 dangerous-rm command-substitution-target guard (recursive `rm` whose target is only `$(…)`/backtick output now denies in all modes, including auto and `--dangerously-skip-permissions`), the P2 NUL-byte permission-rule guard, the macOS kernel-resolved path denial, the NUL-byte path guards, and the dangerous-rm auto-deny-window infra (#137; immediate deny live); real attack-surface e2e A/B-verified against the official v2.1.281 binary; 2.1.282 triaged STAGE-only per promotion discipline), full triage and forensics ledger in `docs/upstream-version-gap-occ96.md` (merged with the parallel OCC-136 2.1.281 subset, ledger `docs/upstream-version-gap-occ136.md`); the OCC-134 round, 2026-09-23, landed the byte-verified portable subset of 2.1.280 (2.1.279 never published; 114 changelog entries triaged + a full v278↔v280 linux-x64 ELF binary diff, 26 byte-verified ports — headlined by the Opus 5.5 launch registration, the Pro/Team default-Opus switch, and five security fixes: the symlink-landing write-permission subsystem, marketplace credential-helper removal, plugin reserved-name imitation defense, MCP OAuth auth-cache removal, and the invisible-Unicode ZWNJ script-context clause), full triage and forensics ledger in `docs/upstream-version-gap-occ134.md`; the OCC-131 round, 2026-09-20, landed the byte-verified portable subset of 2.1.277/2.1.278 (89 changelog entries triaged, 26 byte-verified ports — headlined by AGENTS.md `instructionFiles` support, the `/status` "Auto mode server" row, and four security fixes: sandbox `excludedCommands` every-part matching, subagent hand-back provenance framing, marketplace-policy fail-closed per-entry validation, and invisible-Unicode prompt stripping), full triage and forensics ledger in `docs/upstream-version-gap-occ131.md`; the OCC-130 round landed the byte-verified portable subset of 2.1.275 (~95 changelog entries) plus the 2.1.276 advisor entry-refused hotfix, including three security fixes (npm-source plugin installs hardened with `npm pack --ignore-scripts` + SRI integrity verification, plugin/marketplace URL credential scrubbing, and a git-address parser hardening that closes a blocklist bypass), the sandboxed-zsh exit-code and bare-git-repo `hooks/`/`config/` write fixes, transcript/resume malformed-entry robustness, the send-now key (ctrl+enter / ctrl+x ctrl+s) with gray-render until the model receives queued prompts, ripgrep 20MB output-cap and Read stream-decode robustness, `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` global prompt caching for `--system-prompt`, otelHeadersHelper failure surfacing, `/rewind` truncated-restore and marketplace-update data-loss fixes, and stdout backpressure responsiveness — full triage and forensics ledger in `docs/upstream-version-gap-occ130.md`; the parallel OCC-90 round landed the byte-verified 2.1.276 advisor proxy-400 fix — advisor-model resolution now gated on a first-party `ANTHROPIC_BASE_URL` (official module #489 `!Ia()||` gate), the growthbook experiment key corrected to `tengu_sage_compass2`, strict firstParty advisor enablement with the `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` env override and the `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` arm — plus removal of the dead `src/services/api/src/` stub tree and a full 96-entry triage of 2.1.275, per `docs/upstream-version-gap-occ129.md`; prior rounds landed the 2.1.274 MCP auth-stub description secret-leak fix (byte-verified display-sanitizer family port) with NO-OP behavioral verification of the 2.1.274 bash special-variable and worktree nested-expansion hardening (OCC-127), the 2.1.273 gateway-hint request headers, the spinner doubled-ellipsis guard, the shell-mode `!` insert fix, and the subshell-hidden dangerous-`rm` bypass fix, per `docs/upstream-version-gap-occ127.md`; still not landed from the 2.1.270→2.1.272 delta: `/config` panel fullscreen mouse support (PORTABLE-LARGE) and the spinner status ladder (STAGED), plus the pre-existing sandbox per-command `allowed_domains` gap; prior alignment through 2.1.270 landed via OCC-122/OCC-123/OCC-84/OCC-124/OCC-85/OCC-125/OCC-126). The code is fully open, auditable, backdoor-free, and your data stays under your control.

If you worry that a closed-source CLI might hide backdoors, or that your code and credentials are uploaded to unauditable services, OCC is for you: all source is open and unobfuscated, the build is reproducible from source, and API credentials are sent only to endpoints you configure.

## Positioning

- 🔓 **Open & auditable** — full source, no obfuscation, line-by-line reviewable.
- 🛡️ **Transparent & safe** — no telemetry black boxes, no hidden reporting; behavior you can supervise.
- 🎯 **Capability-aligned** — REPL, tool system, permission model, MCP, sub-agents, slash commands — on par with Claude Code.
- 🔧 **Data sovereignty** — API Key / Bedrock / Vertex / Azure credentials stay on your machine; requests go only to endpoints you specify.
- 🧩 **Hackable** — trim, extend, or fork subsystems; feature flags and a workspace stub layer make the boundary between live and trimmed code explicit.

## Quick install

```bash
npm i -g @cnwenf/occ   # install
occ                    # launch the interactive REPL
```

Requires a valid Anthropic API Key (or AWS Bedrock / Google Vertex / Azure Foundry credentials).

## Feature highlights

- 🖥️ **Interactive REPL** — Ink terminal renderer with full UI: vim mode, themes, scroll, search highlight, virtual lists.
- 🔧 **Full tool suite** — Bash, Read, Edit, Write, NotebookEdit, Grep, Glob, Agent, WebFetch, WebSearch, WebBrowser (real Chrome via CDP), Todo, Skills, and more.
- 🤖 **Sub-agents** — spawn fork / async / background / remote agents; team swarms (`TeamCreate`/`TeamDelete`) and worktree isolation.
- 🔀 **Workflow engine** — vm-sandboxed multi-agent workflow scripts; `/workflows` browse + async launch (`remote: true`) + progress tracking. _(live via `WORKFLOW_SCRIPTS`)_
- 📊 **Monitor tool** — self-contained monitoring. _(live via `MONITOR_TOOL`; events and the deadline-expiry notice are recorded internally — chat delivery wiring is an occ127 follow-up, and the deadline kill itself is enforced)_
- 🌐 **WebBrowser** — navigate, read page text, screenshot, and batch actions through a real Chrome instance (CDP).
- 🛡️ **Permission model** — `default` / `acceptEdits` / `plan` / `bypassPermissions` modes, auto-approval, destructive-command blocking, path validation, rule matching.
- 🪝 **Hooks** — `PreToolUse`, `PostToolUse`, `PermissionDenied`, `Stop`, and more, configurable via `settings.json`.
- 🧩 **MCP support** — connect external tools via Model Context Protocol servers (`--mcp-config`, `.mcp.json`); list/read MCP resources.
- 🎯 **Skills system** — frontmatter-driven skills, `/skills` discovery + cache, attribution, MCP-delivered skills. _(live via `EXPERIMENTAL_SKILL_SEARCH` + `MCP_SKILLS`)_
- 📝 **`/goal` tracking** — set a session goal with a Stop hook that keeps the agent on-target.
- ⚡ **`/effort ultracode`** — max-reasoning effort level with badge + keyword trigger; also `low`/`medium`/`high`/`max`/`auto`.
- 🎨 **Custom themes** — `/color` and `/theme` for live theming and custom theme creation.
- ⌨️ **Keybindings** — vim mode, `Ctrl+L` clear, `Ctrl+J` newline, scroll, configurable via `/keybindings`.
- 🌍 **Language setting** — instruct OCC to respond in your preferred language.
- 🔄 **Session management** — `/resume`, auto-compaction, `/doctor`, `/status`, `/cost`.
- 🧠 **Smart classifiers** — transcript + bash command classification. _(live via `TRANSCRIPT_CLASSIFIER` + `BASH_CLASSIFIER`)_

## OCC vs Claude Code

| | OCC | Claude Code |
|---|---|---|
| **Source** | Fully open, unobfuscated | Closed binary |
| **Auditability** | Line-by-line reviewable | No |
| **Telemetry** | Minimal (analytics stubbed) | Standard |
| **Data sovereignty** | Credentials stay on your machine; requests only to endpoints you configure | Anthropic endpoints |
| **Capability parity** | Tracks CC `2.1.282` (2.1.282 P1 settings-trust security clusters A–E + UI batch via OCC-137 — mid-pattern `:*` rule fix + startup warnings, policy-source strict parse (fail-closed locks + partial-block salvage), telemetry-env blocklist + `sandbox.excludedCommands` managed scoping, frontmatter grant gating + reserved-namespace anti-squatting, macOS kernel-path symlink gate, `maxProseWidth` + telemetry notice/`/status`/`doctor`; session/transport NO-OP/STAGE + vim batch STAGE, honestly accounted in `docs/upstream-version-gap-occ97-2026-09.md`; 2.1.281 portable subset via OCC-96 + OCC-136 — 39 byte-verified ports incl. 9 security: S1 dangerous-rm command-substitution-target guard, P2 NUL-byte permission-rule guard, macOS kernel-path deny, NUL-byte path guards, dangerous-rm auto-deny-window infra; 2.1.280 portable subset via OCC-134; 2.1.276 fully aligned via OCC-90 + OCC-130; 2.1.271–2.1.281 partial) | Reference implementation |
| **Providers** | Anthropic Direct, Bedrock, Vertex, Azure | Anthropic, Bedrock, Vertex |
| **Cost** | Free & open-source (MIT) | Subscription |
| **Build** | Reproducible from source | N/A |

## Quick start

```bash
# interactive REPL
occ

# pipe mode (-p) — non-interactive
echo "say hello" | occ -p

# run from source (dev)
bun run dev
```

## Slash commands

OCC ships dozens of slash commands. Highlights:

| Category | Commands |
|---|---|
| **Session** | `/clear` `/compact` `/autocompact` `/resume` `/status` `/cost` `/doctor` `/export` `/context` |
| **Model & effort** | `/model` `/effort` `/fast` `/usage` |
| **Configuration** | `/config` `/permissions` `/keybindings` `/color` `/theme` `/memory` `/init` `/login` `/logout` |
| **Agents & tasks** | `/agents` `/background` `/daemon` `/stop` `/tasks` `/goal` `/skills` `/hooks` `/plugin` |
| **MCP** | `/mcp` |
| **Review & git** | `/review` `/commit` `/commit-push-pr` `/diff` `/branch` `/pr_comments` |
| **Help** | `/help` `/update` `/onboarding` |

## Tools

**Always available:** `Bash`, `FileRead`, `FileEdit`, `FileWrite`, `NotebookEdit`, `Grep`, `Glob`, `Agent`, `TaskOutput`, `TaskStop`, `WebFetch`, `WebSearch`, `WebBrowser` (Navigate / GetPageText / Screenshot / Batch), `TodoWrite`, `AskUserQuestion`, `Skill`, `EnterPlanMode`, `ExitPlanMode`, `Cron` (Create / Delete / List), `Brief`, `ListMcpResources`, `ReadMcpResource`, `ReadMcpResourceDir`.

**Live (feature-allowlisted):** `Workflow` (`WORKFLOW_SCRIPTS`), `Monitor` (`MONITOR_TOOL`).

**Conditional:** `TaskCreate`/`Get`/`Update`/`List` (Todo v2), `EnterWorktree`/`ExitWorktree` (worktree mode), `ToolSearch` (deferred tool loading), `PowerShell` (Windows), `LSP` (`ENABLE_LSP_TOOL`).

**Disabled / stubbed:** subsystems behind non-allowlisted feature flags — `Sleep`, `RemoteTrigger`, `SendUserFile`, `PushNotification`, `SubscribePR`, `ListPeers`, `Snip`, coordinator/bridge/voice modes, and ANT-only stubs (`Tungsten`, `REPL`, `SuggestBackgroundPR`). Computer Use (`@ant/*`) and most `*-napi` packages are stubs (`color-diff-napi` is fully implemented). Analytics / GrowthBook / Sentry are empty implementations.

## Configuration

OCC reads settings from (later files override earlier):

- `~/.claude/settings.json` — user-global
- `.claude/settings.json` — project-shared (checked in)
- `.claude/settings.local.json` — project-local (gitignored)

Configure permissions, hooks, model, theme, MCP servers, and keybindings there. Provider credentials live in env vars (`ANTHROPIC_API_KEY`, `AWS_*`, `CLAUDE_CODE_USE_VERTEX`, etc.) — never in source.

For the full settings reference, environment variables, and permission modes, see [CLAUDE.md](./CLAUDE.md).

## Architecture overview

```
src/entrypoints/cli.tsx   true entrypoint (runtime polyfills, macros)
src/main.tsx              Commander.js CLI definition
src/query.ts              main API query loop (streaming + tool-call loop)
src/QueryEngine.ts        conversation orchestrator (state, compaction, attribution)
src/screens/REPL.tsx      interactive REPL screen (React/Ink)
src/services/api/         API clients (Anthropic / Bedrock / Vertex / Azure)
src/tools/<Name>/         one directory per tool
src/ink/                  custom Ink framework (reconciler, hooks, virtual list)
src/commands/<Name>/      one directory per slash command
packages/                 workspace stubs (@ant/*, *-napi)
```

**Runtime & build:** Bun (not Node). ESM + TSX with `react-jsx`. Single-file bundle via `bun build`. Bun workspaces resolve internal `packages/*`.

**Core loop:** `query.ts` sends messages to the Claude API, handles streaming, processes tool calls, and manages the conversation turn loop. `QueryEngine.ts` wraps it with state, compaction, and file-history snapshots.

**Feature flags:** `feature(name)` returns `true` for an allowlist — `WORKFLOW_SCRIPTS`, `MONITOR_TOOL`, `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS` — and `false` for everything else. This reactivates the workflow engine, Monitor tool, skill discovery, MCP skills, and the transcript/bash classifiers at runtime; most other internal subsystems (COORDINATOR_MODE, KAIROS, PROACTIVE, BRIDGE_MODE, VOICE_MODE, etc.) stay disabled.

## Build from source

Requires [Bun](https://bun.sh/) >= 1.3.11 (use `bun upgrade` — older Bun causes spurious errors).

```bash
bun install
bun run dev          # run from source; version prints 2.1.282 (dev polyfill; build overrides with pkg.version) when working
bun run build        # output: dist/cli.js (~26 MB, single-file bundle)
bun test             # test suite (Bun test runner)
bun run lint         # Biome lint (formatter disabled to avoid large diffs)
bun run check:unused # knip — detect unused exports/dependencies
bun run health       # code health check
```

> **Note on type errors:** the codebase carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types throughout). They do **not** affect Bun runtime execution. Lint (Biome) is the gate, not `tsc`.

For architecture, entry/bootstrap, tool system, UI layer, and module-status details, see [CLAUDE.md](./CLAUDE.md).

## Status

- Tracks Claude Code **`2.1.282`** (2.1.282 honest-partial via OCC-137 — the OCC-137 round, 2026-09-26, landed the five P1 settings-trust security clusters (A–E) byte-verified one-by-one against the official v2.1.282 linux-x64 ELF (md5 `54435b7e…`) — mid-pattern `:*` Bash rules respected from all sources with startup warnings, policy-source strict parse (fail-closed boolean locks + partial-block salvage), the project/local telemetry-env blocklist + `sandbox.excludedCommands` managed scoping, frontmatter `allowed-tools` grant gating + `anthropic-skills`/`claude-ai` reserved-namespace anti-squatting, and the macOS kernel-path/symlink fail-closed gate — plus the `maxProseWidth` and telemetry startup-notice/`/status`/`doctor` UI batch, 86 changelog entries triaged; session/transport ★-subset NO-OP/STAGE (backend-dependent) and the vim batch STAGE — full ledger in `docs/upstream-version-gap-occ97-2026-09.md`; 2.1.281 partial — the OCC-96 round, 2026-09-25, landed 39 byte-verified ports incl. 9 security ports (headlined by the S1 dangerous-rm command-substitution-target guard — recursive `rm` whose target is only `$(…)`/backtick output now denies in all modes, including auto and `--dangerously-skip-permissions`; the P2 NUL-byte permission-rule guard — a rule containing a NUL byte matches nothing; plus the macOS kernel-resolved path denial, the NUL-byte path guards, and the dangerous-rm auto-deny-window infra), 176 changelog entries triaged + a full v280↔v281 linux-x64 ELF binary diff, live-REPL A/B against the official v2.1.281 binary, and 2.1.282 triaged STAGE-only — see `docs/upstream-version-gap-occ96.md`; 2.1.280 partial — the OCC-134 round, 2026-09-23, landed the byte-verified portable subset (2.1.279 never published; 114 changelog entries triaged + full v278↔v280 ELF binary diff, 26 byte-verified ports — Opus 5.5 launch registration + Pro/Team default-Opus switch, the symlink-landing write-permission subsystem, four more security fixes (marketplace credential-helper removal, plugin reserved-name imitation defense, MCP OAuth auth-cache removal, invisible-Unicode ZWNJ script-context clause), background-shell benign-exit classification, agent-type-hook PermissionRequest errors) — see `docs/upstream-version-gap-occ134.md`; 2.1.277/2.1.278 partial — the OCC-131 round, 2026-09-20, landed the byte-verified portable subset (89 changelog entries triaged, 26 byte-verified ports — AGENTS.md `instructionFiles` support, the `/status` "Auto mode server" row, and four security fixes: sandbox `excludedCommands` every-part matching, subagent hand-back provenance framing, marketplace-policy fail-closed per-entry validation, invisible-Unicode prompt stripping) — see `docs/upstream-version-gap-occ131.md`; 2.1.276 fully aligned via OCC-90 + OCC-130 (advisor proxy-400 fix + the 2.1.275 portable subset incl. three security fixes, see `docs/upstream-version-gap-occ129.md`/`-occ130.md`); 2.1.271–2.1.275 partial — full ledger in the corresponding `docs/upstream-version-gap-occ*.md`; residual fullscreen-renderer items and the bg-session fd-exhaustion entry are triaged there as STAGED with per-item rationale; prior rounds landed the 2.1.274 MCP auth-stub description secret-leak fix with NO-OP verification of the bash special-variable and worktree nested-expansion hardening (OCC-127, `docs/upstream-version-gap-occ127.md`), the 2.1.273 gateway-hint request headers, the spinner doubled-ellipsis guard, the shell-mode `!` insert fix, and the subshell-hidden dangerous-`rm` bypass fix; still not landed from the 2.1.270→2.1.272 delta: `/config` fullscreen mouse support (PORTABLE-LARGE) and the spinner status ladder (STAGED), plus the pre-existing sandbox per-command `allowed_domains` gap; prior alignment through 2.1.270 landed via OCC-122/OCC-123/OCC-84, OCC-124 + OCC-85, OCC-125, and OCC-126 — see `docs/upstream-version-gap-occ124.md`, `docs/upstream-version-gap-occ125.md`, and `docs/upstream-version-gap-occ126.md`).
- Published to npm as [`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ).
- Many modules are intentionally stubbed or feature-flagged off — see "Disabled / stubbed" above.

## Docs

- [CLAUDE.md](./CLAUDE.md) — engineering guide: commands, architecture, working with the codebase.
- [docs/](./docs/) — architecture whitepaper (Mintlify `.mdx`): [introduction](./docs/introduction/what-is-claude-code.mdx), [the loop](./docs/conversation/the-loop.mdx), [tools](./docs/tools/what-are-tools.mdx), [permission model](./docs/safety/permission-model.mdx), [hooks](./docs/extensibility/hooks.mdx), [skills](./docs/extensibility/skills.mdx), [MCP](./docs/extensibility/mcp-protocol.mdx), [sub-agents](./docs/agent/sub-agents.mdx).

## Contributing

Contributions are welcome. Please:

1. Open an issue to discuss the change first for non-trivial work.
2. Keep code under 800 lines/file, functions under 50 lines, no deep nesting.
3. Run `bun run lint` and `bun test` before submitting — Biome lint is the gate.
4. Follow [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
5. Don't try to fix all `tsc` type errors — they don't affect the Bun runtime and `tsc` is not in CI.

A `pre-commit` hook (`.githooks/`, wired via `bun run prepare`) runs `biome lint` on staged `src/*.{ts,tsx,js,jsx}` files. Bypass with `--no-verify` when lint errors are from pre-existing noise.

## License

MIT License — see [LICENSE](./LICENSE).
