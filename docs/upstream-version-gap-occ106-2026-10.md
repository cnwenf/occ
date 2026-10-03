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
| 4 | Added a re-authenticate prompt when an MCP server asks for more OAuth scope during a tool call | B | NO-OP{ALREADY-ALIGNED} | Step-up surface struct-equal v287↔v288 (`re-authenticate` 41→41, `stepUp` 31→31, no novel prompt string) — dark-shipped in v287, changelog-only in v288. OCC has markStepUpPending on 403 `insufficient_scope` (`services/mcp/auth.ts:1664-1684`) + McpAuthError re-auth mapping (`client.ts:3945-3959`). cluster-b §4. |
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
| 15 | Fixed auto mode denials pointing Claude at a Bash permission rule when the blocked tool was not Bash | A | PORTED | Official `bKn` @211301793: hint names the actual tool (`…add a permission rule for ${tool} to their settings.`), suppressed via `dXo` @209972359 predicate when tool has no allow rule; OCC hardcoded-Bash hint in `messages.ts` buildYoloRejectionMessage replaced (also drops OCC-original `Bash(prompt:…)` phrasing found in neither binary). cluster-a §15. |
| 16 | Fixed auto mode on Bedrock and Mantle switching to the local classifier for the rest of the session after a… | A | NO-OP{PLATFORM} | `k5o` bedrock/mantle old-model gate @202200032 belongs to official's server-classifier beta negotiation; OCC has no server classifier (`isAutoModeServerEnabled()`=false, Status.tsx:43-45), no Mantle provider, no dangerous-tool-use beta latch, no session-latch shape. cluster-a §16. |
| 17 | Fixed cloud sessions that restarted on a newly picked model replying with that model after the server refus… | D | |
| 18 | Fixed Cowork cloud sessions staying marked as waiting for input after a WebFetch permission prompt for an u… | F | NO-OP{PLATFORM} | Cowork Sessions-API server state (`waiting for input`); no CLI binary delta; OCC cloud surface is poll-only (`RemoteAgentTask.tsx:633`). cluster-f. |
| 19 | Fixed prompt suggestions not appearing on a phone that joins a Cowork cloud session started on another device | F | NO-OP{PLATFORM} | `set_prompt_suggestions_paused` byte-identical v287↔v288; needs joining-host relay — OCC remoteControlServer exposes /status,/prompt,/stop only. cluster-f. |
| 20 | Fixed a mod's button sometimes running a different button's action when pressed on a view drawn before Clau… | E | |
| 21 | Fixed a plugin's pane showing nothing when one `Code` element held a diff that does not parse; it now draws… | E | |
| 22 | Fixed plugin LSP servers receiving literal `${user_config.*}` and `${CLAUDE_PLUGIN_ROOT}` placeholders in `… | B | PORTED | Official @207469709 deep-substitutes `${user_config.*}`/`${CLAUDE_PLUGIN_ROOT}` in `initializationOptions`+`settings` (NX walker) + warns `Left unexpanded in plugin LSP initializationOptions/settings (not set): …`; OCC `lspPluginIntegration.ts:229-292` substituted only command/args/env/workspaceFolder. cluster-b §22. |
| 23 | Fixed a plugin's `tool.call` hook making Bash fail and file searches read the wrong folder in subagents tha… | F | NO-OP{ALREADY-ALIGNED} | OCC wraps the whole worktree turn in `runWithCwdOverride` (AgentTool.tsx:813/867); hooks + Bash/Grep/Glob read ALS-aware getCwd(); hook spawn uses `cwd:safeCwd` (hooks.ts:1956). cluster-f §23. |
| 24 | Fixed `git-subdir` plugin installs failing, or caching an incomplete plugin, on older git (before 2.39, e.g… | B | PORTED | Official @210993448/@210994570 adds `git read-tree -u --reset` after `sparse-checkout set --cone` (cone doesn't materialize on git <2.39, e.g. Ubuntu 22.04's 2.34) with redacted-stderr error; OCC `pluginLoader.ts` installFromGitSubdir (~778-787) lacked it → empty/incomplete cached plugin. cluster-b §24. |
| 25 | Fixed plugins loaded with `--plugin-dir` not showing "Configure options" in `/plugin` | B | NO-OP{ALREADY-ALIGNED} | Official fix is a code motion (configure-options moved out of the `!re&&!de` gate @~237323129); OCC's only gate is `marketplace!=='builtin'` (ManagePlugins.tsx:1330) which already admits `--plugin-dir` plugins — v287 bug never existed in OCC. cluster-b §25. |
| 26 | Fixed background sessions ending when a plugin was reloaded or disabled while one of its timers or reads wa… | B | STAGED | Reload-hold/cache-impact machinery byte-identical v287↔v288 (`hold_on_cache_impact` 5→5, `pluginForwardingAdmission` 4→4 …) — NOT the fix; real change is a lifecycle guard with no novel string → unrecoverable by binary delta. OCC surface: `disablePluginOp` (pluginOperations.ts:722-737) has no in-flight coordination. cluster-b §26. |
| 27 | Fixed sandboxed heredocs with an unquoted delimiter (`python3 <<EOF`) asking for approval on every run unde… | A | NO-OP{ALREADY-ALIGNED} | Official fix (`plainUnquotedHeredocs` reparse under `tengu_amber_larch` @209762993) repairs official's AST+sandbox-auto-allow path — dormant in OCC (TREE_SITTER_BASH not in FEATURE_ALLOWLIST); OCC's live legacy path (`checkSandboxAutoAllow`, bashPermissions.ts:1813-1901) already auto-allows unquoted heredocs → symptom absent. AST-activation prerequisites recorded (`differential:!0` flag, reparse option, re-allow call site). cluster-a §27. |
| 28 | Fixed Bash tool permission check to prompt before a `BASHPID` assignment whose value the shell would evalua… | A | PORTED | Official `fyt` integer-attr shell-var set grows 41→42: `BASHPID` inserted after `EPOCHREALTIME` (@203549536 region, byte-verified); OCC `INTEGER_ATTR_SHELL_VARS` (ast.ts:187-227) had 39 members — aligned to the full official set. `BASHPID=1/0` now prompts; `BASHPID=5` still silently allowed. cluster-a §28. |
| 29 | Fixed fullscreen sessions exiting with "unrecoverable interface error" when opening the background tasks di… | E | |
| 30 | Fixed Claude reporting a message to another session as delivered when that session held it: the notice now … | D | |
| 31 | Fixed OpenTelemetry `claude_code.tool.blocked_on_user` spans reporting `unknown` source or decision in `-p`… | A | PORTED | Official span fallbacks `'unknown'` → derived decision/source (`Ymn("reject",er?.source||mo.source)` @208844295/@208848422; mapper `Aho` @208819059 + `MIt` @208818518); OCC sessionTracing.ts 'unknown' fallbacks (~574-578/~627-632) replaced with the derived mapper values for `-p`/SDK sessions and hook approvals. cluster-a §31. |
| 32 | Fixed permission asks that ended unanswered, in `-p` or on an interrupted turn, emitting no `tool_decision`… | A | PORTED | Official v288 @~208843300 removes the `behavior!=="ask"` gate on the `tool_decision` emit (v287 @207738136 had it): unanswered asks (aborted turn or `-p`) now emit `tool_decision` derived via `Aho` (ask→reject, aborted?user_abort:config); OCC toolExecution.ts (~1006-1015) ask-gate dropped. cluster-a §32. |
| 33 | Fixed Edit and Retry in Cowork cloud sessions refusing a message sent before `/compact` even though its his… | F | NO-OP{PLATFORM} | Delta fully recovered (`transcriptGcOn`→`rowsOffDisk` + deleted-rows check) but lives in remote Cowork `rewind_conversation`; OCC rewind is local-only (REPL.tsx:3884). cluster-f. |
| 34 | Fixed unattended sessions (`CLAUDE_CODE_RETRY_WATCHDOG`) retrying for hours after a very long response stre… | D | |
| 35 | Fixed `/login` reporting "Login successful" when credentials could not be saved to secure storage; it now s… | B | PORTED | Official v288 @223558737: success toast moved into the else branch of the credential-save check; failure raises `auth_storage_failure` — `Claude Code login needs attention: credentials may not have been saved` (transient) / `could not be saved` (permanent). OCC ConsoleOAuthFlow.tsx:589 + cli/handlers/auth.ts:294 printed success unconditionally — now gated on the persisted result. cluster-b §35. Security rank B1. |
| 36 | Fixed a Stop during Bedrock credential lookup sometimes moving the session to a fallback model instead of e… | D | |
| 37 | Fixed a second `gcpAuthRefresh`/`awsAuthRefresh` browser sign-in opening when a laptop wakes from sleep whi… | D | |
| 38 | Fixed agent teams: a plugin-defined agent spawned by name now runs with its own prompt, tools, disallowedTo… | B | PORTED | Official v288 @232028744: in-process spawn resolves+forwards `agentDefinition` (placeholder rejected via `Ma`), so a plugin teammate spawned by name runs its own prompt/tools/disallowedTools/effort; OCC `spawnMultiAgent.ts:890-901` set `agentDefinition:undefined` → `inProcessRunner.ts` defaulted `tools:['*']` (privilege-scope regression) — now resolves from active agent definitions. cluster-b §38. Security-relevant. |
| 39 | Fixed headless (`-p` / SDK) sessions occasionally ignoring SIGTERM when a supervisor such as `timeout` or s… | D | |
| 40 | Fixed restarted cloud sessions restoring a model that the organization's enforced model list refuses | D | |
| 41 | Fixed MCP tool calls sometimes running twice when a remote server's result was over 16 MB or could not be p… | B | NO-OP{ALREADY-ALIGNED} | OCC structurally immune — `capMcpResponseBody` THROWS over 16MB (`client.ts:786-808`), `transformMCPResult` THROWS on unparseable (`:3364-3369`); no retry-after-oversize path exists (session retry not triggered by these throws). No novel binary marker recovered. cluster-b §41. |
| 42 | Fixed subagents in Claude Desktop's Code tab getting none of the tools of a user-configured MCP server name… | F | NO-OP{PLATFORM} | Desktop Code-tab product surface; `memory` ∉ OCC reserved MCP names (config.ts:1588) and OCC subagent MCP wiring (runAgent.ts:242) has no name filter. cluster-f §42. |
| 43 | Fixed Claude in Chrome asking before every screenshot and page read on a site you allowed when auto mode is… | F | NO-OP{ALREADY-ALIGNED} | OCC WebBrowserTool already auto-allows read-only `screenshot`/`get_page_text` and gates only `navigate` (WebBrowserTool.ts:9-12, actions.ts:25). cluster-f §43. |
| 44 | Fixed `claude plugin install` failing for GitHub-source plugins on macOS and Linux machines with no GitHub … | B | PORTED | Official v288 `drt` @~207590400 hardens the SSH-configured probe: `git ls-remote --get-url` rewrite check + `ssh -G git@github.com` hostname/proxycommand/proxyjump parse (logs `…staying on SSH`); OCC `marketplaceManager.ts:827-857` used `ssh -T` only. Base SSH→HTTPS fallback pre-existed in v287/OCC. cluster-b §44. Security rank B3. |
| 45 | Fixed `sandbox.credentials.files` entries on git config files not taking effect while `permissions.blockRea… | A | NO-OP{NO-SURFACE} | Delta recovered (`_He`→`p1e` settings-override merge @210245781) but the bug needs BOTH `sandbox.credentials.files` and `permissions.blockReadsOutsideWorkingDirectories`; OCC ships neither (sandboxTypes.ts:191-200, settings/types.ts:46-88). Port `p1e` shape if/when those settings land. cluster-a §45. |
| 46 | Fixed Claude leaving out your organization's design systems when starting slides or a design with the Artif… | C | |
| 47 | Fixed the keyboard not working on Windows after Claude Code restarts itself (first sign-in to a Claude apps… | E | |
| 48 | Fixed a stall when launching an agent whose `tools:` lists very many `Agent(...)` entries | D | |
| 49 | Fixed sessions on Claude 3 Opus and Claude 3 Sonnet failing on every turn after a whole PDF entered the con… | C | |
| 50 | Fixed the npm auto-updater reporting success when the platform-native binary failed to download and only th… | B | PORTED | Official v288 @~211722400 re-probes the installed claude after the updater's install exits 0 and refuses success on a placeholder stub (`…exited 0 but the installed claude is still the placeholder stub…`; deliberate `npm config get ignore-scripts`=true → trust exit code; inconclusive probe → trust + log). SCOPED port: OCC ships no platform-native binary (NATIVE_PACKAGE_URL='') so the `native_package_missing` wording is PLATFORM — post-install version re-probe added to autoUpdater.ts (~677-696 had none) + localInstaller.ts stub-awareness. cluster-b §50. Security rank B2. |
| 51 | Fixed Remote Control cleanup archiving a session that is still connected or was just re-attached by another… | F | NO-OP{PLATFORM} | Zero "archiv" in OCC remote/daemon/server surface; fix is in official's Remote Control cleanup (no string delta: `re-attached` 0→0); OCC daemon differs. cluster-f. |
| 52 | Fixed `owner/repo` plugin marketplaces showing only the second attempt's error when both the SSH and HTTPS … | B | PORTED | Official v288 @210734308 combines both transport errors — `Fetching the marketplace from GitHub failed on both attempts. ${t1} (${url1}): ${err1}\n\n${t2} (${url2}): ${err2}` (first-tried first); OCC `marketplaceManager.ts:1831-1837/1893-1905` threw the last error only, hiding the SSH auth failure. cluster-b §52. Security rank B4. |
| 53 | Fixed path-scoped `.claude/rules` and nested CLAUDE.md files not loading when Write or Edit creates or chan… | C | |
| 54 | Fixed a dangerous `rm` (such as one on `/` or the home directory) inside a `bash -c` or `sh -c` script runn… | A | PORTED | New v288 inline-shell-rm subsystem fully recovered (@209742531+): extractor for `/^(?:r?ba)?sh$/ -c` scripts, depth-8 value walker, synthetic rebuild re-judged through the permission checker, forced-ask (`decisionReason {type:'safetyCheck',classifierApprovable:false,circuitBreaker:'dangerousRemoval'}`), kill-switch `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT`. OCC demonstrated the SAME bypass (all 7 probe shapes returned null from findCatastrophicSubstitutionBlock) — ported + wired into the all-mode pre-gate in bashPermissions.ts; all 7 now block/ask. cluster-a §54. SECURITY RANK 1 of round. |
| 55 | Fixed LSP tool calls hanging indefinitely when a language server uses dynamic capability registration or st… | F | PORTED | Official v288 adds per-server `requestTimeout` (Zod `int().positive().max(2147483647)`, describe "…Defaults to 60000." @101997701; arming `if(n.requestTimeout)s.setTimeout(n.requestTimeout,i)`; error `Request has exceeded the configured ${ms} ms requestTimeout.`); OCC `LSPClient.sendRequest` (LSPClient.ts:289-304) had NO timeout → indefinite hangs. NOTE: CLAUDE.md "LSP removed" row is STALE — OCC LSP client is live (`initializeLspServerManager()` unconditional, main.tsx:2720). cluster-f §55. |
| 56 | Fixed `idle_prompt` notification hooks firing while background agents are still running (anthropics/claude-… | D | |
| 57 | Fixed PreToolUse and PermissionRequest hooks being skipped when matching them failed or the tool's input co… | A | PORTED | Official v288 (code @207801396+, generator @~209522800): guarded set `PreToolUse`/`PermissionRequest`; matcher crash / JSON-unwritable input / over-size payload (>MAX_STRING_LENGTH/2) now BLOCK the call (PermissionRequest → deny) instead of silently skipping hooks; settings opt-out; telemetry `hook_matching_failed`/`hook_input_too_large`/`hook_input_stringify_failed`. OCC was fail-open at hooks.ts (6 sites)/toolHooks.ts/PermissionContext.ts — now fail-closed for the two guarded events. cluster-a §57. SECURITY RANK 2. |
| 58 | Fixed the first request in a fresh environment or after a model switch using the built-in output limit and … | D | |
| 59 | Fixed the "What should Claude do instead?" hint showing on the Interrupted row after sending queued message… | E | |
| 60 | Fixed `/login` in a `--bare` session running a sign-in the session never reads, which could replace your sa… | B | STAGED | Bare credential-source resolver byte-identical v287↔v288 (`$k`@201658612 ≡ `Qk`@202473225); the 3 net-new `bare` hits are unrelated; no /login-specific novel string → fix is a pure logic gate, unrecoverable by string novelty. OCC surface real: isBareMode gates in utils/auth.ts are read-side only. cluster-b §60. |
| 61 | Fixed the InstructionsLoaded hook omitting agent_id and agent_type when a subagent's file access loads a ru… | C | |
| 62 | Fixed the Agent tool in `claude mcp serve` always reporting no available agents and rejecting every subagen… | D | |
| 63 | Fixed the terminal cursor not following the typed text in the fullscreen transcript viewer's search and in … | E | |
| 64 | Fixed `/permissions` in screen reader mode: typing a rule's number now picks it instead of opening the sear… | E | |
| 65 | Improved auto mode: when a conversation grows too long for the client-side safety classifier to review, it … | C | |
| 66 | Improved screen reader mode: short announcements, such as a deleted word, now stay on screen until your nex… | E | |
| 67 | Improved screen reader mode: answered questions in question dialogs now say "answered" beside their box | E | |
| 68 | Improved the `/usage-credits` message shown to Team and Enterprise members whose organization has turned of… | E | |
| 69 | Improved cloud sessions: a new conversation's first turn no longer waits for a stdio MCP server whose confi… | B | PORTED | Official v288 @226009370: prewait skip-set `$h` (pending stdio + `alwaysLoad:false` + not in requiredServerNames + not referenced by first-turn messages; guarded conversation read logs `MCP prewait: reading the conversation failed`) threaded as `skipServerNames` through the wait orchestrator; OCC `waitForMcpConnectionBatch` (client.ts:3043-3067) waited unconditionally. cluster-b §69. |
| 70 | Improved "You should know" notes to say "we", "the main agent" or "you" depending on who was responsible fo… | C | |
| 71 | Improved the error for an artifact database write refused at the database's size limit: it now states the l… | E | |
| 72 | Improved Bash permission prompts to give a shorter reason when part of a command can't be checked before it… | A | PORTED | Both v288 tables fully recovered: 27-entry sentence-case node map + `${X} in this command can't be checked before it runs` template (@203543557; `"cannot be checked in advance"` 24→0) + 11 short wrapper reasons (@203551221); OCC ast.ts (NODE_TYPE_EXPLANATIONS ~2712-2739, tooComplex ~2753-2765) was a byte-exact v287 port — replaced; missing jobs/xargs/awk wrapper reasons (pre-existing gap) added in the same change; 287 test file refreshed. cluster-a §72. |
| 73 | Self-hosted runner: Improved the built-in `gh api`: a refused gh command now prints its `gh api` equivalent… | E | |
| 74 | Improved Remote Control's recovery from an expired server credential: sessions stay connected during renewa… | E | |
| 75 | Changed the background command time limit to apply only in unattended sessions (`-p`, Agent SDK, CI, cloud)… | D | |
| 76 | Changed the client-side auto mode classifier to ignore an `ANTHROPIC_DEFAULT_SONNET_MODEL` pin that names C… | A | PORTED | Official v288 `bI()` @~202157300: pin normalizing to `claude-sonnet-5-5`/`claude-opus-5-5` is discarded (warn-once `Auto mode classifier: ANTHROPIC_DEFAULT_SONNET_MODEL=${g} cannot serve as the classifier; using the Sonnet 5 default instead`) → sonnet5 default; OCC getClassifierModel() (yoloClassifier.ts:1490-1522) honored the pin unconditionally. cluster-a §76. |
| 77 | Changed `claude project purge` to `claude purge`; the old name still works and prints a notice | E | |
| 78 | Changed the agents view `n:` filter (and Ctrl+F search) so Enter opens the session whose name matches best … | E | |
| 79 | Changed `/autocompact` to save the auto-compact window per model, so each model keeps its own setting when … | C | |
| 80 | Changed MCP URL prompts from servers that can't report when you're done to wait for "I'm done, continue" be… | B | PORTED | Official v288 @229244616: when the server can't emit ElicitationCompleteNotification, accept button renders ` I'm done, continue  ` and the tool call resumes only on explicit press (capable servers keep ` Accept  ` + auto-continue); OCC ElicitationDialog/elicitationHandler had no capability branch. cluster-b §80. |
| 81 | [VSCode] Fixed a claude.ai connector staying on "Needs authentication" after you authorize it: the MCP serv… | F | NO-OP{PLATFORM} | VS Code extension surface ("Check connection" ∉ CLI binary); OCC CLI /mcp status strings already match (services/mcp/utils.ts:461). cluster-f. |
| 82 | [VSCode] Fixed the opt-in New Conversation shortcut (Cmd/Ctrl+N) starting a conversation in every visible C… | F | NO-OP{PLATFORM} | VS Code New-Conversation shortcut; no binary marker; OCC is a single-view terminal REPL (ctrl+n=select:next, defaultBindings.ts:144). cluster-f. |
| 83 | [VSCode] Fixed the chat view resuming the next saved session after you archive the one it shows; it now sta… | F | NO-OP{PLATFORM} | VS Code chat-view archive/resume; no binary marker; no OCC surface. cluster-f. |
| 84 | [Cloud sessions] Fixed the Cloud sessions switch in Claude Code admin settings staying locked off while an … | F | NO-OP{PLATFORM} | claude.ai org-admin web UI switch; nothing in CLI binary; no OCC admin surface. cluster-f. |
| 85 | [Cloud sessions] Fixed pressing Stop while a self-hosted runner was still starting not cancelling the queue… | F | NO-OP{NO-SURFACE} | OCC self-hosted-runner/main.ts is a 3-line stub; fix is server-side queue cancel (no client delta). cluster-f. |
| 86 | [Claude Tag] Fixed Claude Tag admin settings offering a "Remove this scope" option, which always failed, on… | F | NO-OP{PLATFORM} | Claude Tag admin surface ∉ binary; OCC Slack surface is only /install-slack-app browser opener. cluster-f. |
| 87 | [Claude Tag] Improved Claude to also follow a related Slack thread in another channel that it only read, so… | F | NO-OP{PLATFORM} | Relay prompts identical v287↔v288; OCC RemoteControl binds a single channel, no thread concept. cluster-f. |
| 88 | [Claude Tag] Improved save errors on a channel's Configure page: too-long channel instructions now say to s… | F | NO-OP{PLATFORM} | Claude Tag channel-Configure page ∉ binary; no OCC surface. cluster-f. |
| 89 | Fixed `claude plugin test` reporting mods as turned off remotely when it had only read an out-of-date saved… | B | NO-OP{NO-SURFACE} | Fix is in the `claude plugin test` harness's saved mod-enablement read; OCC ships no plugin-test mods surface. cluster-b §89. |

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
