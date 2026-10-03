# OCC-106 Upstream Version Gap Ledger — Claude Code 2.1.287 → 2.1.288 (2026-10)

**Round**: OCC-106 (issue `d8917114-172a-43c5-84dd-a4771385633a`), executed 2026-10-04 by OCC 程序员.
**Tracked-upstream pointer**: 2.1.287 → **2.1.288** (this round). OCC release: **2.1.368** (tag/publish after 验收 acceptance).
**Official channel state at round time** (npm `dist-tags`, fact-checked by Leader 2026-10-04): `stable=2.1.285`, `latest=next=2.1.288`. Publish time (npm `time`): 2.1.288 → 2026-10-02T18:30:40Z.

## Method

- Binaries: `@anthropic-ai/claude-code-linux-x64@2.1.287` (244,317,368 B, md5 `e2cb95e3d249d216b0d533b798ba70f3`) and `@2.1.288` (245,734,584 B, md5 `2e368f7093aa911f9df0d5224de226d9`), unpacked to `/tmp/cc-diff-288/{v287,v288}/package/claude`. **Never executed** — analysis used only `strings -n 8` dumps (`s287.txt` 457,521 lines / `s288.txt` 459,057 lines), sorted-unique `comm` diff (`new288.txt` **17,944 new unique strings** / `del288.txt` 16,575 removed), `grep -aobF` offsets + `dd` byte-window extraction. Version-marker check: v288 ELF contains `2.1.288` ×2,320, zero `2.1.289`. Temp artifacts removed after the round (`rm -rf /tmp/cc-diff-288`).
- Changelog: **89 bullets** for 2.1.288 (numbered **#1–#89** in changelog order — `docs/gap-research-288/changelog-entries-288.txt`). Research reports under `docs/gap-research-288/`: `cluster-a-permission-sandbox.md`, `cluster-b-protocol-auth-mcp-plugin.md`, `cluster-c-instructions-resume.md`, `cluster-d-session-transport.md`, `cluster-e-ui-features.md`, `cluster-f-platform.md`.
- Porting rule (`aligning-with-official-binary`): port only byte-verified official code; STAGED-with-rationale is success, invented code is failure. Security ports additionally verified by A/B harnesses where feasible.
- Statuses: **PORTED** (landed this round, tests green) · **PORTED(partial)** (core landed; named sub-pieces STAGED) · **STAGED** (real surface or real gap, but needs decompilation/decision/subsystem OCC lacks — recovered code recorded, nothing invented) · **NO-OP** (PLATFORM = other-product surface; NO-SURFACE = feature absent from OCC; ALREADY-ALIGNED).

## Summary counts (89 entries)

_Filled at round end._

## 1. Per-entry ledger (#1–#89)

Cluster column: A=permission-sandbox, B=protocol-auth-mcp-plugin, C=instructions-resume, D=session-transport, E=ui-features, F=platform. Commit hashes are on `main`.

| # | Entry (abridged) | Cluster | Verdict | Disposition / evidence |
|---|---|---|---|---|
| 1 | Added `$.ui.selection()` for mods: returns the text you last selected in fullscreen mode and, when the sele… | E | |
| 2 | Added a built-in `gh api` to cloud sessions whose image has no GitHub CLI, and fixed the built-in sending c… | E | |
| 3 | Added recovery for a prompt cleared with Ctrl+C: pressing Up on the empty prompt brings the draft back, inc… | E | |
| 4 | Added a re-authenticate prompt when an MCP server asks for more OAuth scope during a tool call | B | |
| 5 | Added `--max-findings <n>\|all` to /code-review to report more or fewer findings than the usual limit; the c… | E | |
| 6 | Added Ctrl+F to find a session by name and Alt+↑/↓ to jump between groups in the agents view; both, and ren… | E | |
| 7 | Added a screen reader mode announcement of the new permission mode when you approve a plan, including with … | E | |
| 8 | Fixed mid-response API timeouts failing the turn: non-interactive sessions and subagents now continue from … | D | |
| 9 | Fixed long conversations failing with "Prompt is too long" instead of auto-compacting when the last reply r… | C | |
| 10 | Fixed `--resume` sometimes dropping files and other context that a compaction had just restored | C | |
| 11 | Fixed a resumed session sometimes not saving the last response of a turn, so that the next `--resume` showe… | C | |
| 12 | Fixed resume occasionally loading a transcript cut short when the same session rewrote the file during the … | C | |
| 13 | Fixed resuming a conversation started on 2.1.286 or earlier dropping the model's earlier thinking | C | |
| 14 | Fixed session titles, memory recall and prompt hooks failing on Mantle or behind gateways that reject struc… | D | |
| 15 | Fixed auto mode denials pointing Claude at a Bash permission rule when the blocked tool was not Bash | A | |
| 16 | Fixed auto mode on Bedrock and Mantle switching to the local classifier for the rest of the session after a… | A | |
| 17 | Fixed cloud sessions that restarted on a newly picked model replying with that model after the server refus… | D | |
| 18 | Fixed Cowork cloud sessions staying marked as waiting for input after a WebFetch permission prompt for an u… | F | |
| 19 | Fixed prompt suggestions not appearing on a phone that joins a Cowork cloud session started on another device | F | |
| 20 | Fixed a mod's button sometimes running a different button's action when pressed on a view drawn before Clau… | E | |
| 21 | Fixed a plugin's pane showing nothing when one `Code` element held a diff that does not parse; it now draws… | E | |
| 22 | Fixed plugin LSP servers receiving literal `${user_config.*}` and `${CLAUDE_PLUGIN_ROOT}` placeholders in `… | B | |
| 23 | Fixed a plugin's `tool.call` hook making Bash fail and file searches read the wrong folder in subagents tha… | F | |
| 24 | Fixed `git-subdir` plugin installs failing, or caching an incomplete plugin, on older git (before 2.39, e.g… | B | |
| 25 | Fixed plugins loaded with `--plugin-dir` not showing "Configure options" in `/plugin` | B | |
| 26 | Fixed background sessions ending when a plugin was reloaded or disabled while one of its timers or reads wa… | B | |
| 27 | Fixed sandboxed heredocs with an unquoted delimiter (`python3 <<EOF`) asking for approval on every run unde… | A | |
| 28 | Fixed Bash tool permission check to prompt before a `BASHPID` assignment whose value the shell would evalua… | A | |
| 29 | Fixed fullscreen sessions exiting with "unrecoverable interface error" when opening the background tasks di… | E | |
| 30 | Fixed Claude reporting a message to another session as delivered when that session held it: the notice now … | D | |
| 31 | Fixed OpenTelemetry `claude_code.tool.blocked_on_user` spans reporting `unknown` source or decision in `-p`… | A | |
| 32 | Fixed permission asks that ended unanswered, in `-p` or on an interrupted turn, emitting no `tool_decision`… | A | |
| 33 | Fixed Edit and Retry in Cowork cloud sessions refusing a message sent before `/compact` even though its his… | F | |
| 34 | Fixed unattended sessions (`CLAUDE_CODE_RETRY_WATCHDOG`) retrying for hours after a very long response stre… | D | |
| 35 | Fixed `/login` reporting "Login successful" when credentials could not be saved to secure storage; it now s… | B | |
| 36 | Fixed a Stop during Bedrock credential lookup sometimes moving the session to a fallback model instead of e… | D | |
| 37 | Fixed a second `gcpAuthRefresh`/`awsAuthRefresh` browser sign-in opening when a laptop wakes from sleep whi… | D | |
| 38 | Fixed agent teams: a plugin-defined agent spawned by name now runs with its own prompt, tools, disallowedTo… | B | |
| 39 | Fixed headless (`-p` / SDK) sessions occasionally ignoring SIGTERM when a supervisor such as `timeout` or s… | D | |
| 40 | Fixed restarted cloud sessions restoring a model that the organization's enforced model list refuses | D | |
| 41 | Fixed MCP tool calls sometimes running twice when a remote server's result was over 16 MB or could not be p… | B | |
| 42 | Fixed subagents in Claude Desktop's Code tab getting none of the tools of a user-configured MCP server name… | F | |
| 43 | Fixed Claude in Chrome asking before every screenshot and page read on a site you allowed when auto mode is… | F | |
| 44 | Fixed `claude plugin install` failing for GitHub-source plugins on macOS and Linux machines with no GitHub … | B | |
| 45 | Fixed `sandbox.credentials.files` entries on git config files not taking effect while `permissions.blockRea… | A | |
| 46 | Fixed Claude leaving out your organization's design systems when starting slides or a design with the Artif… | C | |
| 47 | Fixed the keyboard not working on Windows after Claude Code restarts itself (first sign-in to a Claude apps… | E | |
| 48 | Fixed a stall when launching an agent whose `tools:` lists very many `Agent(...)` entries | D | |
| 49 | Fixed sessions on Claude 3 Opus and Claude 3 Sonnet failing on every turn after a whole PDF entered the con… | C | |
| 50 | Fixed the npm auto-updater reporting success when the platform-native binary failed to download and only th… | B | |
| 51 | Fixed Remote Control cleanup archiving a session that is still connected or was just re-attached by another… | F | |
| 52 | Fixed `owner/repo` plugin marketplaces showing only the second attempt's error when both the SSH and HTTPS … | B | |
| 53 | Fixed path-scoped `.claude/rules` and nested CLAUDE.md files not loading when Write or Edit creates or chan… | C | |
| 54 | Fixed a dangerous `rm` (such as one on `/` or the home directory) inside a `bash -c` or `sh -c` script runn… | A | |
| 55 | Fixed LSP tool calls hanging indefinitely when a language server uses dynamic capability registration or st… | F | |
| 56 | Fixed `idle_prompt` notification hooks firing while background agents are still running (anthropics/claude-… | D | |
| 57 | Fixed PreToolUse and PermissionRequest hooks being skipped when matching them failed or the tool's input co… | A | |
| 58 | Fixed the first request in a fresh environment or after a model switch using the built-in output limit and … | D | |
| 59 | Fixed the "What should Claude do instead?" hint showing on the Interrupted row after sending queued message… | E | |
| 60 | Fixed `/login` in a `--bare` session running a sign-in the session never reads, which could replace your sa… | B | |
| 61 | Fixed the InstructionsLoaded hook omitting agent_id and agent_type when a subagent's file access loads a ru… | C | |
| 62 | Fixed the Agent tool in `claude mcp serve` always reporting no available agents and rejecting every subagen… | D | |
| 63 | Fixed the terminal cursor not following the typed text in the fullscreen transcript viewer's search and in … | E | |
| 64 | Fixed `/permissions` in screen reader mode: typing a rule's number now picks it instead of opening the sear… | E | |
| 65 | Improved auto mode: when a conversation grows too long for the client-side safety classifier to review, it … | C | |
| 66 | Improved screen reader mode: short announcements, such as a deleted word, now stay on screen until your nex… | E | |
| 67 | Improved screen reader mode: answered questions in question dialogs now say "answered" beside their box | E | |
| 68 | Improved the `/usage-credits` message shown to Team and Enterprise members whose organization has turned of… | E | |
| 69 | Improved cloud sessions: a new conversation's first turn no longer waits for a stdio MCP server whose confi… | B | |
| 70 | Improved "You should know" notes to say "we", "the main agent" or "you" depending on who was responsible fo… | C | |
| 71 | Improved the error for an artifact database write refused at the database's size limit: it now states the l… | E | |
| 72 | Improved Bash permission prompts to give a shorter reason when part of a command can't be checked before it… | A | |
| 73 | Self-hosted runner: Improved the built-in `gh api`: a refused gh command now prints its `gh api` equivalent… | E | |
| 74 | Improved Remote Control's recovery from an expired server credential: sessions stay connected during renewa… | E | |
| 75 | Changed the background command time limit to apply only in unattended sessions (`-p`, Agent SDK, CI, cloud)… | D | |
| 76 | Changed the client-side auto mode classifier to ignore an `ANTHROPIC_DEFAULT_SONNET_MODEL` pin that names C… | A | |
| 77 | Changed `claude project purge` to `claude purge`; the old name still works and prints a notice | E | |
| 78 | Changed the agents view `n:` filter (and Ctrl+F search) so Enter opens the session whose name matches best … | E | |
| 79 | Changed `/autocompact` to save the auto-compact window per model, so each model keeps its own setting when … | C | |
| 80 | Changed MCP URL prompts from servers that can't report when you're done to wait for "I'm done, continue" be… | B | |
| 81 | [VSCode] Fixed a claude.ai connector staying on "Needs authentication" after you authorize it: the MCP serv… | F | |
| 82 | [VSCode] Fixed the opt-in New Conversation shortcut (Cmd/Ctrl+N) starting a conversation in every visible C… | F | |
| 83 | [VSCode] Fixed the chat view resuming the next saved session after you archive the one it shows; it now sta… | F | |
| 84 | [Cloud sessions] Fixed the Cloud sessions switch in Claude Code admin settings staying locked off while an … | F | |
| 85 | [Cloud sessions] Fixed pressing Stop while a self-hosted runner was still starting not cancelling the queue… | F | |
| 86 | [Claude Tag] Fixed Claude Tag admin settings offering a "Remove this scope" option, which always failed, on… | F | |
| 87 | [Claude Tag] Improved Claude to also follow a related Slack thread in another channel that it only read, so… | F | |
| 88 | [Claude Tag] Improved save errors on a channel's Configure page: too-long channel instructions now say to s… | F | |
| 89 | Fixed `claude plugin test` reporting mods as turned off remotely when it had only read an out-of-date saved… | B | |

## 2. Security disposition summary (kickoff priority list)

_Filled after cluster A/B/C land._

## 3. Verification

_Filled at round end._

## 4. STAGED backlog carried to future rounds

_Filled at round end; includes OCC-105 §4 carry-over status updates._

## 5. Version bumps (this round)

- `package.json`: `2.1.367` → **`2.1.368`**
- `src/entrypoints/cli.tsx` MACRO polyfill `VERSION`: `"2.1.287"` → **`"2.1.288"`**
- `README.md`: badge / intro / capability-parity row / footer — 4 pins `2.1.287` → `2.1.288` with the OCC-106 summary prepended.
- `CHANGELOG.md`: new **`## 2.1.368`** section.

## 6. Files touched (this round)

_Filled at round end._
