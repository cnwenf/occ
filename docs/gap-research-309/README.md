# Gap research — OCC 2.1.308 → official claude-code 2.1.309

Round date: 2026-10-24. Branch: `agent/occ/8ab7772c`.

> **Superseded by `docs/upstream-version-gap-occ131-2026-10.md`** — that ledger holds the reconciled final
> verdicts (PORT 23 · STAGED 21 · N-A 35) after cross-agent conflict resolution; the tally/WP tables below
> are the first-draft research summary and contain known errata (items 15/16 and 53/54 transposed; item 10
> promoted STAGED→PORT; F-1/F-11 downgraded to STAGED). See gap-doc §2.4 for the full errata list.
> The per-item triage files (byte-offset evidence) remain valid as-is.
Official 2.1.309 changelog: 79 numbered items (`changelog-308-309-items.txt`).
Forensics: official ELF `BIN309=/tmp/cc-diff-309/vver/package/claude` (+ `BIN308` prev) inspected **read-only** via `strings` / `grep -aboF` byte offsets / bounded `dd` / `new_strings.txt` diff. Official binaries were **never executed**. OCC source read-only during triage.

Detailed per-item triage (verdict + OCC surface + current behavior + official byte-offset evidence + action):
- `triage-T1.md` (consolidated items 1–16; chunks `triage-T1-A/B/C/D.md`)
- `triage-T2.md` (items 17–40)
- `triage-T3.md` (items 41–57; deep sub-analysis `triage-T3b.md` for 43/47–51/57)
- `triage-T4.md` (items 58–79)

## Tally

| Verdict | Count | Meaning |
|---|---|---|
| **PORT** | 22 | OCC subsystem exists + lacks the fix → implement this round |
| **STAGED** | 22 | Depends on an unported subsystem / Anthropic-cloud-or-desktop-only / fix mechanism not byte-pinnable → record |
| **N-A** | 35 | Subsystem absent, already aligned, or structurally immune |
| **Total** | **79** | |

## PORT — 22 items (implement this round)

Grouped into uncoupled work packages (WP) for parallel subagent development. Each WP touches a distinct subsystem → safe to develop concurrently.

| WP | Items | Subsystem | Gap (OCC lacks the 309 fix) |
|---|---|---|---|
| WP-sandbox | 1, 3 | `utils/Shell.ts`, `utils/sandbox/sandbox-adapter.ts` | (1) Sandboxed Bash spawns the **user shell** as the outer process, so `~/.zshenv`/`$BASH_ENV`/login profile run **outside** the sandbox before every command — 309 spawns `/bin/sh -c <wrapped>` for all sandboxed POSIX + adds a `sandbox_wrap_unconfined` abort. (3) Sandboxed commands / auto-accepted edits can modify the `--mcp-config` file — 309 protects it. |
| WP-context | 12 | CLAUDE.md loader (`utils/claudemd.ts`, context pipeline) | Nested CLAUDE.md over the size limit loads **whole** → repeated compaction; 309 loads only its **start**. |
| WP-repl-input | 14, 16 | REPL keybinding / transcript (`screens/REPL.tsx`, ctrl+o view) | (14) Key-bound slash commands don't run from `!` shell mode. (16) ctrl+o doesn't show still-waiting messages from other agents/sessions; 309 shows them in full under the transcript, marked waiting. |
| WP-bridge | 20 | `bridge/*`, `utils/git/gitFilesystem.ts` | `claude remote-control` status line shows literal `HEAD` for a non-git folder (`computeBranch` returns `'HEAD'`); 309 uses a `not_a_repo` sentinel. |
| WP-swarm | 21 | `utils/swarm/spawnUtils.ts`, `tools/shared/spawnMultiAgent.ts` | Split-pane / separate-window teammates don't inherit the leader's `--tools` / deny rules (`buildInheritedCliFlags` omits them); in-process path already inherits. |
| WP-rewind | 23 | `components/MessageSelector.tsx`, `utils/fileHistory.ts`, `utils/forkedAgent.ts` | `/rewind` list shows "No code changes" for turns that changed files via Bash / subagent / `/code-review --fix` (list scans transcript for `structuredPatch`, Edit/Write only; subagent checkpointing is a no-op). |
| WP-privacy | 24 | `commands/privacy-settings`, `services/api/grove.ts`, `components/grove/Grove.tsx` | `/privacy-settings` shows a **session-memoized stale** "Help improve our AI models" value; no "can't be fetched" state. |
| WP-feedback | 25, 26, 66 | `components/Feedback.tsx` (+ VSCode feedback surface for 66) | (25) Org-rejected feedback shows generic "try again later" instead of the server's reason + bug-report pointer. (26) Oversized `/feedback` fails instead of resending without the transcript (`fitFeedbackPayloadToBudget`). (66) [VSCode] feedback error shows only an HTTP status when the org doesn't accept feedback. |
| WP-skills | 27 | `skills/loadSkillsDir.ts`, `commands.ts` | A skill in an `--add-dir` folder is unreachable when another skill already holds its name (first-match resolution); 309 offers it as `<folder>:<name>`. |
| WP-hooks | 32 | `utils/hooks.ts`, `utils/shell/powershellProvider.ts` | PowerShell hooks don't block when the hook program exits code 2 (no `$LASTEXITCODE`/`exit 2` propagation in the hook spawn). |
| WP-api | 37 | `utils/api.ts`, `utils/model/providers.ts` | Fine-grained tool streaming stays off on Bedrock even when `ANTHROPIC_BEDROCK_BASE_URL` is the default `bedrock-runtime.<region>.amazonaws.com` (FGTS gate is `firstParty`-only). |
| WP-win-perms | 41 | Windows PowerShell permission checks | PowerShell permission checks auto-approve some `Set-Location`/`cd` to the current dir carrying extra args; 309 prompts. |
| WP-macos | 42 | macOS startup | "Install Command Line Developer Tools" dialog reopens each start on a Mac without Xcode/CLT. |
| WP-git | 44, 56 | git utils, worktree creation | (44) Self-run git commands slow on Windows; errors not forced to English when git is localized. (56) Worktree creation/reuse fetches objects on demand; 309 avoids it (partial clone + sandbox fetches first). |
| WP-disk | 46 | `utils/Shell.ts`, ENOSPC handling | Disk-full: a Bash command cut off by a full disk doesn't say so / name the folder; full temp volume prints a raw ENOSPC. |
| WP-bash-edit | 52 | BashTool, `/rewind` interaction | `sed -i` gets a simulated file-edit preview and is `/rewind`-restored; 309 gives it the standard Bash prompt, runs as written, and excludes it from `/rewind`. |
| WP-ultrareview | 54 | `claude ultrareview` command | `ultrareview` doesn't require workspace trust; 309 asks on a terminal / else refuses, adds `--trust-workspace` (no value) + `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK=1`. |

## STAGED — 22 items (record, do not implement this round)

2 (macOS denyWrite glob real-location twins — needs unported `realPathTwins` machinery + `tengu_hushed_caraway` gate) · 4 (disabled MCP reconnect — needs 308→309 unified-snapshot-config + `mcp-config-changed` rebuild) · 5 (Bash redirect-failure variable trust — needs unported `INJECTED_SHELL_VARIABLE_CODE_DETECTION` AST parser) · 6 (compound `cd`-then-git prompting — needs 309's reworked `commandMayBeGit` recursive splitting) · 7 (`Edit(path)` deny vs Bash redirect in subshell — OCC already immune; needs bash-prefix-parser port) · 8, 9, 10 (worktree-isolation locale/arithmetic guards, git replace-refs — see T1-C) · 13 (ctrl+enter send-now queuing / hook restart) · 15 (long tool-output preview cut through emoji breaking `jq`) · 18 (Claude-Desktop-hosted session message loss — desktop transport unported) · 28 (`/verify` `/code-review` nested-package skill on shell changes — shell-touched-files mechanism not byte-pinnable) · 38 ("Waiting for API response" keepalive flicker / 45s off-backend — first-byte-timeout subsystem unported, prior-round A5) · 39 (GitHub role-name/placeholder mentions notifying users — fix mechanism not byte-pinnable) · 45 (hooks module nested-too-deep error names file) · 47, 48, 49, 51, 53, 55, 57 (see T3/T3b — mostly skill-content / cloud / self-hosted-runner surfaces).

## N-A — 35 items (no action)

Absent subsystem / already aligned / structurally immune / Claude-Desktop / Slack / GitHub-cloud / VSCode-extension-UI / skill-content-stub. Notable:
- **17** (PDF page-range "File does not exist" under shared `/proc`) — OCC **structurally immune**: page-range renders via unsandboxed `execa` and re-throws plain `Error` (no errno), so the ENOENT-gated message branch is unreachable.
- **22** (`/rename` generated-name leak) — **already aligned**: OCC stores `custom-title` vs `ai-title` separately with resume-safe load.
- **40** (Linux sandbox write denies lifting for outlived background command) — OCC **immune**: `@anthropic-ai/sandbox-runtime` adapter rebuilds `denyWrite` per command (no session state); nested-userns bypass already patched (2.1.305 backport).
- 19, 29, 30, 31, 33, 34, 35, 36 (desktop app / claude-api skill `.md` stubs OCC-44 / mods `turn.step` / claude.ai sync / artifact cloud subsystem) · 58–65, 67–79 (VSCode extension UI, Cloud sessions web UI, Claude Tag Slack, Code Review cloud — see T4).

## Next steps

1. Implement the 22 PORTs via parallel subagents, one per WP above (WPs are subsystem-disjoint → no merge coupling). Each WP: TDD (red→green), then real e2e incl. REPL where the WP touches the interactive loop (WP-repl-input, WP-rewind, WP-feedback, WP-privacy, WP-skills, WP-context).
2. Re-verify each PORT against `BIN309` byte evidence in the triage file before/after implementing (no invented behavior).
3. STAGED items: leave a tracking note; revisit when the prerequisite subsystem (MCP snapshot config, bash AST parser, first-byte-timeout, realPathTwins, desktop transport) is ported.
4. Update `docs/upstream-version-gap-occ*-2026-10.md` once 309 PORTs land, and bump the tracked official version.
