# OCC-105 Upstream Version Gap Ledger — Claude Code 2.1.286 → 2.1.287 (2026-10)

**Round**: OCC-105 (issue `9ef285dc-c433-461e-b25f-5b3f160fe631`), executed 2026-10-03 by OCC 程序员.
**Tracked-upstream pointer**: 2.1.286 → **2.1.287** (this round). OCC release: **2.1.366** (tag/publish after 验收 acceptance — not this round).
**Official channel state at round time** (npm `dist-tags`, fact-checked 2026-10-03): `stable=2.1.285`, `latest=next=2.1.287`. Publish times (npm `time`): 2.1.286 → 2026-09-30T17:14:38Z, 2.1.287 → 2026-10-01T16:59:25Z.

## Method

- Binaries: `@anthropic-ai/claude-code-linux-x64@2.1.286` (241,667,256 B, md5 `7a1a1bf1223b8dc705fec6124dd82df1`) and `@2.1.287` (244,317,368 B, md5 `e2cb95e3d249d216b0d533b798ba70f3`), unpacked to `/tmp/cc-diff-287/{v286,v287}/package/claude`. **Never executed** — analysis used only `strings -n 8` dumps (`s286.txt` 452,805 lines / `s287.txt` 457,521 lines), sorted-unique `comm` diff (`new287.txt` **19,730 new unique strings** / `del287.txt` 15,962 removed), `rg -aobF` offsets + `dd`/python byte-window extraction. Version-marker check: v287 ELF contains `2.1.287` ×2,306, zero `2.1.288`. Temp artifacts removed after the round (`rm -rf /tmp/cc-diff-287`).
- Changelog: **106 bullets** for 2.1.287 (numbered **#1–#106** below in changelog order). Research reports committed under `docs/gap-research-287/`: `cluster-a-permission-integrity.md`, `cluster-b-protocol-auth-security.md`, `cluster-c-features.md`, `cluster-d1-api-session.md`, `cluster-d2-misc.md`, `cluster-e-screenreader-platform.md`.
- Porting rule (`aligning-with-official-binary`): port only byte-verified official code; STAGED-with-rationale is success, invented code is failure. Security ports additionally verified by A/B needle harnesses where a harness is feasible.
- Statuses: **PORTED** (landed this round, tests green) · **PORTED(partial)** (core landed; named sub-pieces STAGED) · **STAGED** (real surface or real gap, but needs decompilation/decision/subsystem OCC lacks — recovered code recorded, nothing invented) · **NO-OP** (PLATFORM = other-product surface; NO-SURFACE = feature absent from OCC; ALREADY-ALIGNED).

## Summary counts (106 entries)

| Disposition | Count | Entries |
|---|---|---|
| PORTED | 18 | #4 #6 #10 #14 #22 #25 #27 #31 #33 #35 #40 #42 #45 #46 #49 #59 #68 #83 |
| STAGED | 21 | #1 #2 #3 #5 #18 #21 #32 #34 #38 #44 #57 #61 #62 #65 #67 #71 #72 #73 #78 #79 #80 |
| NO-OP{ALREADY-ALIGNED} | 9 | #9 #17 #19 #28 #48 #52 #76 #84 #86 |
| NO-OP{PLATFORM} | 4 | #16 #58 #64 #77 |
| NO-OP{NO-SURFACE} | 54 | all remaining |
| **Total** | **106** | |

PORTED(partial) annotations: #40/#49/#68 landed as one small-fixes commit with per-item PARTIAL notes (§4); #10 `uWt` path-redaction sub-piece STAGED; #25 subagent-prompt (`QMt`) variant deferred; #35 item-7 companion suppression latch STAGED (#18).

## 1. Per-entry ledger (#1–#106)

Cluster column: A=permission-integrity, B=protocol-auth-security, C=features, D1=api-session, D2=misc, E=screenreader-platform. Commit hashes are on `main`.

| # | Entry (abridged) | Cluster | Verdict | Disposition / evidence |
|---|---|---|---|---|
| 1 | Claude Mods (plugins modify deeper behavior) | C | STAGED | `claude-code-mods` string count v286=2=v287 (dark-shipped); big subsystem, no portable diff |
| 2 | You-should-know built-in mod | C | STAGED | plugin id 6=6; tip id 0→3; depends on #1 subsystem |
| 3 | agents view `n:<text>` name/task filter | C | STAGED | feature add on `occ agents` daemon dashboard; needs design pass |
| 4 | OTEL `user_prompt` gains `prompt_text` | C | **PORTED** | `04c472a` — processTextPrompt.ts emits both keys from one redacted value (official `G$t` shape) + processTextPromptOtel287.test.ts |
| 5 | MCP URL prompts / 2025-11-25 protocol / `bareElicitationCapability` | C | STAGED | legacy-elicitation flag default flips `!1`→`!0`; OCC bare `{}` capabilities deliberate — conflict documented, decision needed |
| 6 | Windows startup warning: Bash deny also disables PowerShell | E | **PORTED** | E-item10 — decision-function factoring + verbatim warning string; see §6 |
| 7 | Self-hosted runner built-in `gh api` | E | NO-OP{NO-SURFACE} | Anthropic-managed-git self-hosted runner absent from OCC |
| 8 | Fast mode off in agent-owned remote sessions | D1 | NO-OP{NO-SURFACE} | no remote-session owner surface; OCC fast-mode is local pricing only |
| 9 | RC reconnect gives up after 30s and retries | D2 | NO-OP{ALREADY-ALIGNED} | OCC daemon/RC architecture differs; no stalled-reconnect shape |
| 10 | asyncRewake missing hook script reported once | D2 | **PORTED** | `ab9a792` — MISSING_SCRIPT_SIGNATURE + reportedMissingHookScripts dedup + handleAsyncRewakeExit2 (hooks.ts) + asyncRewakeMissingScript287.test.ts; PARTIAL: `uWt` path-redaction unrecovered, enqueue shape maps body→value |
| 11 | Tool heartbeats to SDK hosts on stalled stream | D1 | NO-OP{NO-SURFACE} | `tool_heartbeat` = 0 hits in OCC; no heartbeat-to-SDK channel |
| 12 | Bedrock/Vertex startup checks ignore enforced availableModels | D1 | NO-OP{NO-SURFACE} | managed-settings enforcement path absent; OCC allowlist filters picker post-build |
| 13 | Chrome browser picker JSON parse error | D2 | NO-OP{NO-SURFACE} | Claude-in-Chrome picker absent |
| 14 | Fable `/model` row saves version id not alias | D1 | **PORTED** | D1-item4 — `getFablePickerRow` `value: model` → `value: 'fable'` (official `U8`→`U3` entire delta, v286@203061451/v287@205079818); see §6 |
| 15 | Opus5.5↔Sonnet5.5 switch rewrites MCP announcements / drops thinking | D1 | NO-OP{NO-SURFACE} | all dedicated machinery STRUCT-EQUAL; site unrecoverable (honesty note in D1 report); OCC lacks thinkingStrip/announce-rewrite machinery |
| 16 | Bedrock Guardrails mid-response block w/ leading thinking | D1 | NO-OP{PLATFORM} | `guardrail` = 0 hits; Bedrock-Guardrails streaming interception absent |
| 17 | Dangerous `rm` loses always-ask on `~`/wildcard redirect | A | NO-OP{ALREADY-ALIGNED} | detector byte-identical v286↔v287; OCC raw-command RM_ROOT_HOME_PATTERN never strips redirects — 11/11 bypass forms match |
| 18 | `-p`/SDK repeats model fallback after mid-reply switch | D1 | STAGED | official `gdn` suppression latch recovered; must port together with #35 stream-state rework; prerequisite absent in OCC |
| 19 | Folder CLAUDE.md attached twice after resume/compaction | D1 | NO-OP{ALREADY-ALIGNED} | official site unrecoverable (all dedupe candidates STRUCT-EQUAL); OCC uses Set-based triggers + unseenFiles — structurally immune |
| 20 | Background sessions unopenable after worktree removal | D2 | NO-OP{NO-SURFACE} | `claude agents` cloud worktree lifecycle absent |
| 21 | /advisor pairing checks (Sonnet 5.5 advises Opus 4.7/4.8) | D2 | STAGED | data-only upstream change; OCC advisor pairing table would need the new matrix — deferred with recovered values |
| 22 | Bash prompts show "Contains simple_expansion" internal names | D2 | **PORTED** | `3520a6f` — ast.ts NODE_TYPE_EXPLANATIONS (26 entries) + tooComplex() rewrite + bashPromptPlainLanguage287.test.ts |
| 23 | Fullscreen "unrecoverable interface error" on held scroll key | D2 | NO-OP{NO-SURFACE} | official fullscreen-alt-screen machinery absent |
| 24 | Org per-tool permission ceilings dropped for `__proto__` MCP tool | B | NO-OP{NO-SURFACE} | no org ceiling surface (`effective_max_permission` = 0 hits); note: use Object.create(null) if ever ported |
| 25 | Large MCP JSON: Read offset/limit cannot split one long line | D1 | **PORTED** | D1-item9 — getLargeOutputInstructions line-shape aware (official `vsn` legacy branch verbatim, 3-way JSON/long-line/short-lines) + call-site lineStats; see §6 |
| 26 | Commit-attribution reminder inside tool result after compaction | D1 | NO-OP{NO-SURFACE} | `remote_session_change` attachment path absent; v287 change was constant-hoist only |
| 27 | SR: cursor away from typed text in search boxes / sign-in code fields | E | **PORTED** | E-UI — ConsoleOAuthFlow focus/showCursor + SearchBox SR borderless/cursor (official `showCursor:` 42→45 sites + `vy`→`By`); see §6 |
| 28 | SR: Enter refused with nothing typed on /rewind summarize | E | NO-OP{ALREADY-ALIGNED} | OCC /rewind summarize already accepts empty input |
| 29 | SR: "Tab to amend" hint where Tab does nothing | E | NO-OP{NO-SURFACE} | OCC has no Tab-to-amend affordance; official JS delta unrecoverable |
| 30 | SR: arrow-key / "Select with numbers" hint lies | E | NO-OP{NO-SURFACE} | OCC menus don't emit those hints; delta recovered for future g5 port |
| 31 | SR: changed lines left out of file-edit approval diffs | E | **PORTED** | E-UI — StructuredDiff SR gate emits changed-line text; see §6 |
| 32 | SR: --teleport progress + MCP form re-sent every spinner frame | E | STAGED | needs SR announcement-engine rework; bundle with #34 |
| 33 | DISABLE_EXPERIMENTAL_BETAS keeps structured-output format | B | **PORTED** | `04c472a` — betas.ts/claude.ts/sideQuery.ts env gate (session-title + prompt-hook requests) + structuredOutputsEnvGate287/FormatGate287 tests |
| 34 | SR: top lines dropped when previous screen taller than window | E | STAGED | SR engine viewport-diff work; bundle with #32 |
| 35 | `--include-partial-messages` message_stop late/never on cut-short reply | D1 | **PORTED** | D1-item11 — flushStreamClose generator + openBlockIsTool suppression set (official `Um`/`INo`) at terminal points in claude.ts; see §6 |
| 36 | `claude agents` not showing waited-on permission prompt | D2 | NO-OP{NO-SURFACE} | daemon dashboard permission relay absent |
| 37 | /ultrareview `.git/info/attributes` advice on UTF-16 .gitattributes | D2 | NO-OP{NO-SURFACE} | /ultrareview gated off in OCC build |
| 38 | `claude remote-control` register behind HTTP proxy | D2 | STAGED | official fix NOT RECOVERED (code-only change, no new strings) — nothing to port faithfully |
| 39 | Sandboxed Bash inherits open handle on the executable | B | NO-OP{NO-SURFACE} | OCC delegates to sandbox-runtime npm pkg; no embedded /proc/self/fd handle mechanism |
| 40 | Reduce-motion: dot + 3 spinners + /rewind "ago" still moving | D2 | **PORTED** | `fcb65a8` — AssistantThinkingMessage reducedMotion prop + spinner gates + BashPermissionRequest shimmer gate; PARTIAL: render test replaced by probe tests |
| 41 | `claude agents` times changing every second in SR mode | D2 | NO-OP{NO-SURFACE} | daemon dashboard + SR time-quantum absent |
| 42 | Revoked claude.ai login shows generic 401 | B | **PORTED** | `04c472a` — errors.ts "OAuth token revoked" + `-p` "Failed to authenticate" prefix + revokedTokenLogin287.test.ts |
| 43 | /ultrareview upload-refusal variable advice | D2 | NO-OP{NO-SURFACE} | /ultrareview gated off |
| 44 | stream-json/SDK not streaming `context: fork` skill turns | C | STAGED | fork-path streaming logic; `invocation_trigger` 7=7 — delta needs dedicated decompilation |
| 45 | /feedback pre-filled issue includes recent errors | B | **PORTED** | `04c472a` — Feedback.tsx feedbackGitHubIssueUrl287 (errors moved to confirmation screen) + feedbackGitHubIssueUrl287.test.ts; PARTIAL: consent-render visual test STAGED |
| 46 | marketplace `--sparse`/`git-subdir` fail over plain http | B | **PORTED** | `684972f` — gitTransport.ts (91L) transport gate + marketplaceManager/pluginLoader/schemas call sites (byte-exact describe text) + gitTransport287/partialCloneTransport287 tests + real git-http-backend A/B e2e |
| 47 | Cloud session restart during compaction loses conversation | D2 | NO-OP{NO-SURFACE} | cloud-session restart machinery absent |
| 48 | Plugin reload × `--plugin-url` cache corruption | D2 | NO-OP{ALREADY-ALIGNED} | OCC plugin archive cache path already serializes writes |
| 49 | /desktop quotes partial output; error now names cause | D2 | **PORTED** | `fcb65a8` — desktopDeepLink.ts OpenerExecResult + timedOut/isMaxBuffer pass-through + 2 early returns; PARTIAL: `/\.+$/` widening not ported (out of scope) |
| 50 | MCP connector double-call on protocol-version change | D1 | NO-OP{NO-SURFACE} | no claudeai-proxy connector; validators STRUCT-EQUAL, fix silent |
| 51 | SessionStart hooks from synced plugins in cloud sessions | D2 | NO-OP{NO-SURFACE} | plugin sync (cloud) absent |
| 52 | "N hooks ran" counts internal callbacks twice | D2 | NO-OP{ALREADY-ALIGNED+NO-SURFACE} | OCC hook summary counts configured hooks only |
| 53 | Remote file upload 30s→35s timeout wait | D2 | NO-OP{NO-SURFACE} | remote file-delivery family absent (7 entries: #53 #55 #56 #69 #70 #74 #75) |
| 54 | Mid-session repo adds don't load skills/plugins (cloud/SDK) | D2 | NO-OP{NO-SURFACE} | cloud repo-add machinery absent |
| 55 | >8000px images fail to send from remote session | D2 | NO-OP{NO-SURFACE} | remote file-delivery family |
| 56 | Claude apps 17–20 attached files deliver only 16 | D2 | NO-OP{NO-SURFACE} | remote file-delivery family |
| 57 | Headless MCP needs-auth pinned after one refused call | D1 | STAGED | official `clearNeedsAuth` recovered verbatim; OCC pins via disk TTL cache — needs tool-success hook + peekSettledConnection analogue first |
| 58 | macOS idle sleep stops RC turn | D2 | NO-OP{PLATFORM} | macOS power-assertion path absent |
| 59 | Windows interactive hang/crash on piped stdin | D2 | **PORTED** | `e13fcd2` — stdinGuard.ts (250L) + main.tsx pre-Ink guard + renderOptions getStdinOverride export + stdinGuard287.test.ts (23 tests) + live CLI e2e (fires under setsid+piped stdin; silent on TTY/-p/--version); PARTIAL: full-boot integration test STAGED (needs pty harness) |
| 60 | SKIP_*_AUTH probes send different Authorization header | B | NO-OP{NO-SURFACE+ALREADY-ALIGNED} | no 3p-model-memory probe subsystem; getCustomHeaders already last-wins |
| 61 | /config: ‹ › chevrons, ←/→ both ways, stacked narrow layout, PgUp/PgDn | C | STAGED | render-only improvements; PgUp/PgDn 8→6 delta needs per-site decompilation |
| 62 | Marketplace plain-language ignore/refuse errors | D2 | STAGED | bundle with admission-validator rework (M1 cache-only admission filter) |
| 63 | Plugin dependency notes / update retries unfinished install | D2 | NO-OP{NO-SURFACE} | trimmed plugin surface |
| 64 | Claude apps gateway Bedrock model-ID error detail | D2 | NO-OP{PLATFORM} | server-side gateway change |
| 65 | SDK priority "now" no longer cancels running web fetch/search | C | STAGED | `'now'` 7→11; preempt-path logic needs decompilation |
| 66 | /memory arrow keys flip on/off settings | C | NO-OP{NO-SURFACE} | OCC /memory is a file-selector, no on/off rows |
| 67 | /skill names typed mid-message announced to Claude | C | STAGED | `disable-model-invocation` 18=18; behavior delta needs decompilation |
| 68 | Light-theme prompt border + ❯ contrast | D2 | **PORTED** | `fcb65a8` — theme.ts :169/:416 rgb(153,153,153)→rgb(138,138,138) + HighlightedThinkingText subtle→inactive + tests |
| 69 | Remote file upload retry once on timeout/network/502-504 | D2 | NO-OP{NO-SURFACE} | remote file-delivery family |
| 70 | Temporary file-send failure wording ("ask again in a few minutes") | D2 | NO-OP{NO-SURFACE} | remote file-delivery family |
| 71 | Held-message prompt between dashed lines | C | STAGED | `"dashed"` 3=3; cosmetic delta not isolable |
| 72 | MCP/tool permission prompts between dashed lines | C | STAGED | same isolable-delta problem as #71 |
| 73 | Headless MCP startup transient-connect per-server retry | D1 | STAGED | official `lEt`/`k` recovered verbatim (s6t=[500,1500,4000] + telemetry); needs memoized-connect-result store + discardMemoizedConnectResult prerequisite |
| 74 | Remote large files stream from disk; size-limit refusal names limit | D2 | NO-OP{NO-SURFACE} | remote file-delivery family |
| 75 | Server-refused file explanation (oversized image etc.) | D2 | NO-OP{NO-SURFACE} | remote file-delivery family |
| 76 | Large MCP results: less memory, smaller session files, no token-count upload | D1 | NO-OP{ALREADY-ALIGNED} | persist + countTokens infra STRUCT-EQUAL v286↔v287; no portable diff; OCC persist-to-disk design already matches the described behavior |
| 77 | Windows Bash subshell removal (speed) | D2 | NO-OP{PLATFORM} | OCC Windows shell path differs; no subshell pre-run |
| 78 | Shell write via repo symlink onto sensitive file → name landing + person-only ask | A | STAGED | OCC validatePath write-tail already resolves landing + prompts (core NOT-AFFECTED); residual: carriedOut not forced `classifierApprovable:!1` — low-severity hardening carried |
| 79 | Opus 4.7+/Fable 1M context default on 3P, no `[1m]` suffix | C | STAGED | `native_1m_3p` 5→0 catalog refactor; OCC substring-based model matching — needs decision on catalog reshape |
| 80 | `claude agents` replies arrive queued; slash cmds deferred to turn end | C | STAGED | daemon dashboard behavior change |
| 81 | Whole-tool Bash allow rules / hooks prompt for shell writes to refuse-outright files | A | NO-OP{NO-SURFACE} | no WIF profile store / host-creds file / settings-review store in OCC (0 hits) |
| 82 | Right/middle-click paste on button release; move-away cancels | E | NO-OP{NO-SURFACE} | OCC has no mouse-paste interception; official delta unrecoverable |
| 83 | MCP `alwaysLoad: false` defers all server tools behind tool search | C | **PORTED** | `04c472a` — mcp/client.ts fetchToolsForClient `serverDefersAllTools` gate (byte-exact) + alwaysLoad285.test.ts extension |
| 84 | SR: no prepark pause; CLAUDE_AX_PREPARK_MS=50 restores | E | NO-OP{ALREADY-ALIGNED} | OCC has no prepark pause to remove |
| 85 | Auto model switch after flagged message keeps effort level | C | NO-OP{NO-SURFACE} | official `carriedEffort:lt.latchEffort` in refusal-fallback latch; OCC has no auto-model-switch-after-flag path |
| 86 | Waiting permission prompts show oldest first | C | NO-OP{ALREADY-ALIGNED} | OCC already appends tail + renders `[0]` |
| 87 | [VSCode] Run in background for running command/sub-agent | E | NO-OP{NO-SURFACE} | VSCode extension surface (13 entries #87–#99) |
| 88 | [VSCode] background shell/Monitor output on agent-map cards | E | NO-OP{NO-SURFACE} | VSCode |
| 89 | [VSCode] settings dialog false timeout blame on large reply | E | NO-OP{NO-SURFACE} | VSCode |
| 90 | [VSCode] cloud session reopen shows side bar instead of new tab | E | NO-OP{NO-SURFACE} | VSCode |
| 91 | [VSCode] Web tab missing new cloud sessions; better empty error | E | NO-OP{NO-SURFACE} | VSCode |
| 92 | [VSCode] restored tab no longer starts second process | E | NO-OP{NO-SURFACE} | VSCode |
| 93 | [VSCode] tool-row file links/hints render as links | E | NO-OP{NO-SURFACE} | VSCode |
| 94 | [VSCode] background agent's running command shown as failed | E | NO-OP{NO-SURFACE} | VSCode |
| 95 | [VSCode] own /usage //context runs instead of opening dialog | E | NO-OP{NO-SURFACE} | VSCode |
| 96 | [VSCode] plan-preview file links open the file | E | NO-OP{NO-SURFACE} | VSCode |
| 97 | [VSCode] tool input/output editor tab 1000ms timeout on WSL | E | NO-OP{NO-SURFACE} | VSCode |
| 98 | [VSCode] Manage plugins dialog surfaces failure reasons | E | NO-OP{NO-SURFACE} | VSCode |
| 99 | [VSCode] Chrome "Enabled by default" also connects editor sessions | E | NO-OP{NO-SURFACE} | VSCode |
| 100 | [Cloud sessions] GitHub token retry on brief refusal | E | NO-OP{NO-SURFACE} | cloud-session GitHub integration absent |
| 101 | [Claude Tag] failure warning posted in Slack thread on background wake | E | NO-OP{NO-SURFACE} | Claude Tag product absent (3 entries #101–#103) |
| 102 | [Claude Tag] spend-limits page missing recent/private channels | E | NO-OP{NO-SURFACE} | Claude Tag |
| 103 | [Claude Tag] task list no longer reposted by background work | E | NO-OP{NO-SURFACE} | Claude Tag |
| 104 | [Code Review] finding comments end on complete sentence | E | NO-OP{NO-SURFACE} | hosted Code Review product absent (3 entries #104–#106) |
| 105 | [Code Review] review after new push despite two prior failures | E | NO-OP{NO-SURFACE} | hosted Code Review |
| 106 | [Code Review] locked-conversation failed-review card wording | E | NO-OP{NO-SURFACE} | hosted Code Review |

## 2. Security disposition summary (kickoff priority list)

The kickoff flagged the security-relevant subset for priority handling. Dispositions:

| Entry | Subject | Disposition |
|---|---|---|
| #17 | dangerous-`rm` always-ask vs redirect | NO-OP{ALREADY-ALIGNED} — A/B harness: 11/11 bypass forms fail closed in OCC |
| #24 | org per-tool ceilings `__proto__` drop | NO-OP{NO-SURFACE} — ceiling feature absent; Object.create(null) guidance recorded |
| #33 | DISABLE_EXPERIMENTAL_BETAS structured-output leak | **PORTED** (`04c472a`) — env gate + 2 test files |
| #39 | sandboxed Bash inherits executable handle | NO-OP{NO-SURFACE} — sandbox-runtime delegation, no persistent fd |
| #42 | revoked OAuth token generic 401 | **PORTED** (`04c472a`) — explicit "OAuth token revoked" / "Failed to authenticate" |
| #46 | git transport 'http' not allowed (sparse/git-subdir) | **PORTED** (`684972f`) — https/ssh-only gate kept, byte-exact error text, real git-http-backend A/B e2e |
| #60 | SKIP_*_AUTH probe Authorization divergence | NO-OP — no probe subsystem; header build already last-wins |
| #78 | shell-write symlink landing person-only ask | STAGED (core NOT-AFFECTED; low-severity carriedOut hardening backlog) |
| #81 | Bash allow rules vs refuse-outright files | NO-OP{NO-SURFACE} — target stores absent |

## 3. Verification

_(filled at round end)_

## 4. STAGED backlog carried to future rounds

_(filled at round end)_

## 5. Version bumps (this round)

_(filled at round end)_

## 6. Files touched (this round)

_(filled at round end)_
