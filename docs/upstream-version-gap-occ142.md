# Upstream Gap Ledger — OCC-142 (official 2.1.285 vs OCC 2.1.361@2.1.284)

Round: 2026-10-01 (daily catch-up, autopilot-triggered). Official npm `latest` = **2.1.285** (published 2026-09-29T17:32:09Z; `stable` tag = 2.1.280). Official changelog section 2.1.285 = exactly **136 bullets** (verified: 60 Fixed / 25 [VSCode] / 20 Changed / 15 Improved / 6 Added / 10 other).
OCC tracked-upstream = **2.1.284** (OCC release baseline v2.1.361) → this is a real porting round (284 → 285).

> **RECONCILIATION NOTE (round close, 2026-10-01).** A **parallel** catch-up round
> (**OCC-102**, ledger `docs/upstream-version-gap-occ102-2026-10.md`) landed on
> `origin/main` mid-round — commits `bc78387` (06:21) + `c973302` (07:41) — and
> shipped a superset of the 2.1.285 subset OCC-142 was independently porting
> (110 files / +15,863 lines, `package.json` → **2.1.362**, all version refs →
> 2.1.285). **Main wins on every overlapping item.** OCC-142's own duplicate
> implementations were dropped at reconciliation; only the two items OCC-102 did
> **not** touch survive as OCC-142-unique and are landed here: **#92 (Bedrock
> SigV4 non-default-port Host header dep-patch)** and **#93 (`widgets` reserved
> MCP server-name cloud gate)**. See §1c for the item-by-item reconciliation and
> §6 for the incident record. This ledger is retained as the OCC-142 forensic
> record even where its work was superseded.

Evidence base:
- Official v2.1.285 linux-x64 GCS binary, sha256 `33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29` — **verified after download**, 240,327,864 bytes. Bucket `claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819`, manifest `claude-code-releases/2.1.285/manifest.json`. Commit `afb212976052ab038df25d5e871f6c049e094d3b`, buildDate 2026-09-29T01:45:50Z. **NEVER executed** — strings/dd/grep/od byte forensics only (occ136 §11.5 discipline).
- Official repo compare v2.1.284…v2.1.285 = 4 commits, docs-only (no source published) — all behavior recovered from the ELF strings corpus.
- Forensic corpus `/tmp/cc-diff-285/` (OCC-142's copy — **still intact on this runtime**, unlike OCC-102's which they removed at their round end): `claude-285` (verified binary), `new285.txt` (full strings dump), `s285.txt`/`s285s.txt` (strings variants), `gone284.txt` (2.1.284 strings dump for before/after diffing), `sec285.md` (136 bullet texts; **bullet N = line N+2**), `cc-CHANGELOG.md`, plus region extracts. Corpus is runtime-local and will be GC'd — **re-extract or copy into the repo before it is garbage-collected** (occ141 §8 lesson).
- Prior-round context: occ141 §1b DEFERRED carry-over lists; occ136 §11.5 forensic discipline; occ140 §9 projectDir e2e rule.

Verdict key: **PORT** = landed this round byte-faithfully + tested; **PARTIAL** = verifiable subset landed, remainder DEFER/NO-OP with reasons; **NO-OP** = surface absent in OCC by design (trimmed feature) or server-side/cloud/VSCode/Tag/RC/Artifacts/ultrareview-local-only; **STAGE** = surface exists but mechanism not byte-recoverable from the minified ELF — never invented; **DEFER** = genuinely portable but not reached this round.
> The **Verdict** column below is OCC-142's *original* triage. Where the parallel
> OCC-102 round already landed the item on main, the Notes column carries
> **[→OCC-102]** and §1c records the final reconciled status.

## §1 136-bullet triage table

| # | Bullet (abridged; full text in `/tmp/cc-diff-285/sec285.md` line #+2) | Verdict | Notes |
|---|---|---|---|
| 1 | `CLAUDE_CODE_DISABLE_WEB_FETCH` env turns off WebFetch | PORT | §2.1 — dup impl; **[→OCC-102 Agent B]** landed on main, mine dropped |
| 2 | `claude --desktop` opens Claude desktop app on cwd/session | NO-OP | OCC ships no Claude-desktop-app launch integration |
| 3 | `claude plugin configure <plugin>` shows/saves options (`--values-stdin`) | DEFER | **[→OCC-102 Agent E]** `pluginConfigure.ts` landed |
| 4 | `claude plugin install --config <server>.<key>=<value>` for bundled `.mcpb` | DEFER | **[→OCC-102 Agent E]** `pluginInstallConfig.ts` landed |
| 5 | `allowedProviders` managed setting limits which API providers a machine may use | DEFER | **[→OCC-102 Agent A]** full architecture landed (`allowedProvidersEnforcement.ts`) |
| 6 | `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` caps non-streaming fallback re-sends | PORT | §2.2 — dup impl; **[→OCC-102 Agent B]** landed on main, mine dropped |
| 7 | `claude -p` + `CLAUDE_CODE_FORK_SUBAGENT=1`: subagent's own Agent call runs foreground | NO-OP | **[OCC-102 Agent D]** `FORK_SUBAGENT` not in flag allowlist → dead in prod builds |
| 8 | plugin/marketplace installs over SSH honor `GIT_SSH`/`core.sshCommand` | DEFER | **[→OCC-102 Agent E]** `gitSshCommand.ts` landed |
| 9 | OS denies reading managed settings → warn+start w/o policies (other errors still stop) | DEFER | **[→OCC-102 Agent A]** `managedReadDenial285` landed |
| 10 | cloud sessions restarted post-compact refusing artifact update | NO-OP | cloud + artifacts surface |
| 11 | `plugin disable/enable` with `name@marketplace` id changing another-case settings entry | DEFER | **[→OCC-102 Agent E]** `pluginSettingsKeyResolution.ts` landed |
| 12 | Remote Control attachments dropped after single failed download → retry 2× | NO-OP | Remote Control surface |
| 13 | mid-session `set_model` switch leaving new model on built-in output-token/compact window | DEFER | model-switch context reset — not reached by either round |
| 14 | redacted logs/transcripts leaking URL password containing `@` / `%40` | PARTIAL | §2.3 — text-scrubber regex; **[→OCC-102]** main `redactUrl.ts` has official `Nbn` `%40` regex; mine dropped |
| 15 | SSH passphrase/new-host prompts from worktree + `/teleport` fetches → fail fast | DEFER | **[→OCC-102 Agent E]** `gitFetchSshFailFast.ts` landed |
| 16 | switching off mid-session MCP server in SDK/`-p` leaving its tools available | DEFER | MCP enable/disable tool refresh — not reached |
| 17 | `claude -p --permission-prompt-tool`: bg subagent permission request auto-denied → route to tool | DEFER | **[→OCC-102 Agent D]** `resolveShouldAvoidPermissionPrompts` landed (SECURITY) |
| 18 | `claude mcp list/get` + not-found of `remove/login/logout` printing escapes from names/values | PORT | §2.4 — dup impl; **[→OCC-102 Agent E]** `cliMessages.ts` `Tn` landed; mine dropped |
| 19 | sandbox auto-allow asking on every inline script (`python3 -c`,`node -e`) containing `=` | DEFER | auto-mode classifier (STAGE-grade) — not reached |
| 20 | fork subagents not keeping session plan/`dontAsk` mode | DEFER | **[→OCC-102 Agent D]** fork permission-mode inheritance landed (SECURITY) |
| 21 | `claude remote-control --help` `--[no-]chrome` default text | NO-OP | Remote Control surface |
| 22 | auto-mode bg subagents prompting redundant 2nd reply after each report | STAGE | **[OCC-102 Agent D]** report-ack subsystem has no live OCC counterpart — STAGED |
| 23 | cloud session creation + `/remote-env` reading only newest 20 environments | NO-OP | cloud surface |
| 24 | Remote Control marking message read on arrival vs on start; losing queued msg on quit | NO-OP | Remote Control surface |
| 25 | plugin install into another plugin's cache/data folder when ids differ only by `.`/`-`/`@`/case → refuse | DEFER | **[→OCC-102 Agent E]** `pluginFolderCollision.ts` landed |
| 26 | hooks/SDK permission callbacks seeing stale ExitPlanMode plan written same response | DEFER | hook/permission mechanism (STAGE-grade) — not reached |
| 27 | cloud first reply tens-of-ms late (2.1.283 regression) | NO-OP | cloud surface |
| 28 | `ANTHROPIC_AUTH_TOKEN` vs Anthropic API never loading org policy | DEFER | **[→OCC-102 Agent A]** `authBearerFallback285` landed (SECURITY) |
| 29 | failed `agent()`/`parallel()`/`pipeline()` awaited later → unhandled rejection ending bg session | DEFER | workflow-script promise handling — not reached |
| 30 | synchronous hooks hanging while a bg process the hook started keeps output open | DEFER | hook process lifecycle — not reached |
| 31 | WebFetch reporting rate-limited domain safety check as network/enterprise block | DEFER | WebFetch error classification — not reached |
| 32 | fullscreen ctrl+o transcript freezing on turns w/ hundreds of reads/searches | STAGE | fullscreen-renderer family (occ141 #24/#25) |
| 33 | Bedrock mid-stream `modelTimeoutException`/`serviceUnavailableException` raw JSON body | DEFER | Bedrock error-message extraction — not reached |
| 34 | `/autofix-pr`+`/schedule` saying GitHub App not installed before status checked | NO-OP | GitHub App cloud service |
| 35 | `/artifacts` dismiss-row (x) unlinking file → republish creates new artifact | NO-OP | artifacts trimmed |
| 36 | Artifact publish after rewind (Esc Esc) overwriting newer content | NO-OP | artifacts trimmed |
| 37 | `Artifact` allow-rule letting publish outside working dirs w/o asking | NO-OP | artifacts trimmed |
| 38 | `/cost`+SDK `modelUsage` wrong model when server answers refusal w/ different fallback | DEFER | cost/model attribution — not reached |
| 39 | Artifact publish overwriting source file w/o re-read (short read / changed since) | NO-OP | artifacts trimmed |
| 40 | auto mode skipping classifier for Artifact uploads / others' artifact reads | NO-OP | artifacts surface trimmed (classifier piece is auto-mode family) |
| 41 | misleading "core.worktree is set" from `/ultrareview` on transient read failure | NO-OP | `/ultrareview` = RemoteAgentTask cloud polling in OCC; no local worktree path |
| 42 | `/ultrareview` macOS/Linux failing to upload worktree w/ per-worktree `core.longpaths` | NO-OP | `/ultrareview` local-upload surface absent |
| 43 | Artifact publish reported as cross-session conflict after retrying temp error that succeeded | NO-OP | artifacts trimmed |
| 44 | `/ultrareview` uploads incl uncommitted credential files w/ colon-before-ext (`server:8443.key`) | NO-OP | `/ultrareview` local-upload surface absent (credential-check piece) |
| 45 | rare auth failure when two sessions recover a login refresh lock left by a crashed process | DEFER | auth refresh-lock recovery — not reached |
| 46 | PowerShell permission check skipping deny+ask rules and caching failure when parser fails to start | PORT | §2.5 — dup impl; **[→OCC-102]** main `parser.ts` has EncodeError/UnexpectedError fail-closed; mine dropped |
| 47 | `/ultrareview` uploads slow on unusual names; credential-check missing many backup/editor marks | NO-OP | `/ultrareview` local-upload surface absent |
| 48 | cancelled shell command/hook still starting when cancel arrives during setup | DEFER | shell/hook cancellation race — not reached by either round |
| 49 | vim: after Ctrl+G external editor, `x`/`r` in NORMAL breaks pasted-text placeholder | DEFER | vim mode — not reached |
| 50 | output-content-filter-blocked responses re-sent/retried for minutes instead of showing error | DEFER | **[→OCC-102 Agent B]** `isOutputContentFilteredError` + `output_content_filtered` landed |
| 51 | plugins silently skipping bundled `.mcpb` needing config → now say so + point to Configure | DEFER | **[→OCC-102 Agent E]** `mcpbNeedsConfig.ts` landed |
| 52 | compacting/resuming failing/crashing on transcript w/ malformed compaction-marker/loop-wakeup fields | DEFER | transcript parse robustness — not reached |
| 53 | WSL: `/ultrareview` refusing Linux-volume checkout w/ colon/dot/space file names | NO-OP | `/ultrareview` local-upload surface absent |
| 54 | `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` re-running a turn that ended at `--max-turns` | DEFER | **[→OCC-102 Lead]** `exitCommit.ts` + `conversationRecovery.ts` landed |
| 55 | sign-in waiting forever after browser showed success | DEFER | sign-in flow completion — not reached |
| 56 | Windows: `/ultrareview` uploading linked worktree of home-rooted repo | NO-OP | `/ultrareview` local-upload surface absent |
| 57 | cloud sessions reporting uploads folder missing before any upload | NO-OP | cloud surface |
| 58 | reply from `claude agents` to bg session on permission prompt sometimes approving pending command | NO-OP | **[OCC-102 Agent D]** `occ agents` read-only dashboard; no route to approve — surface absent |
| 59 | `claude attach/logs/stop/respawn/rm` starting session w/ command name as prompt when options precede | DEFER | `claude agents` CLI arg parsing — not reached |
| 60 | `claude mcp list` leaving out WebSocket (`ws`) servers → list w/ URL + health | DEFER | **[→OCC-102 Agent E]** `mcp list` ws rows landed (marker v285-only) |
| 61 | `claude mcp get` showing no Type/Command/Args/Environment for typeless-field stdio servers | PORT | §2.4 — dup impl; **[→OCC-102 Agent E]** `Die(i)&&Die(h)` landed; mine dropped |
| 62 | `.claude/settings.local.json` allow rules held back outside git repo when git trace2 configured | DEFER | settings/git-trace2 interaction — not reached |
| 63 | `/claude-api` eval runner scaffold/report writing through symlink/hardlink at output file | STAGE | occ141: OCC claude-api skill .md are intentional stubs — verify eval-runner surface; not invented |
| 64 | `/claude-api` eval runner counting `max_tokens`-truncated responses in score averages | STAGE | companion to #63 (same eval-runner surface) |
| 65 | `&nbsp;` showing as literal text when a reply uses it to indent (e.g. table row labels) | DEFER | markdown renderer entity handling — not reached |
| 66 | brief freeze (≤1s) partway through long sessions outside fullscreen, back after `/clear`/`/compact` | STAGE | perf; not byte-recoverable |
| 67 | approved Edit never applying when target is a device (e.g. symlink to /dev/null) via IDE diff/changed edit | DEFER | Edit mechanism (device-target handling) — not reached |
| 68 | failing API request retried ≤21× when streaming kept failing → non-streaming fallback shares retry budget | DEFER | distinct from #6 cap; not claimed by either round |
| 69 | Claude in Chrome native host reporting computer name (label browsers by computer) | NO-OP | Claude-in-Chrome native-host surface absent in OCC |
| 70 | Bedrock/Vertex switch to older same-tier model when admin removes default access; titles fall back | DEFER | 3P fallback (threePFallback lineage) — not reached |
| 71 | plugin marketplace errors naming why a git address is refused vs citing enterprise policy | DEFER | **[→OCC-102 Agent E]** covered by git-URL named-refusal landing (#72) |
| 72 | improved git-URL validation for plugins/marketplaces/current-repo remote | DEFER | **[→OCC-102 Agent E]** `gitUrlValidation.ts` landed (SECURITY) |
| 73 | Artifact results suggesting publish in same step as write/edit | NO-OP | artifacts trimmed |
| 74 | Remote Control `/btw` side question seeing in-progress turn (app-hosted session) | NO-OP | Remote Control surface |
| 75 | BMP/HEIC/HEIF/AVIF/TIFF images: Claude apps show preview where Claude Code can convert | DEFER | image-format conversion support — not reached |
| 76 | auto-mode subagent run ending when it hands report back vs extra turns reaching no one | STAGE | **[OCC-102 Agent D]** report-ack subsystem STAGED (no live counterpart) |
| 77 | Bedrock/Vertex start-up model checks remembering unusable models ≤1 day vs re-check each launch | DEFER | 3P model-check caching — not reached |
| 78 | Artifact publish results using fewer tokens (shorter update note) | NO-OP | artifacts trimmed |
| 79 | SDK liveness in non-streaming fallback: `ping` stream event every 30s (API/AWS/gateways) | DEFER | streaming keepalive — not reached |
| 80 | `/resume`+`claude --resume` on bg session opening it vs refusing; prompt sent as next turn | DEFER | resume/bg-session — not reached |
| 81 | per-turn perf when many permission deny rules + MCP tools configured | STAGE | perf; not byte-recoverable |
| 82 | responsiveness leaving ctrl+o transcript in long sessions w/ fullscreen off | STAGE | fullscreen-renderer/perf |
| 83 | Bedrock/Vertex/Mantle start-up model checks sending same User-Agent/x-app/session-ID headers | DEFER | 3P request headers — not reached |
| 84 | MCP tool setting own `_meta['anthropic/alwaysLoad']`=false stays deferred under server `alwaysLoad` | DEFER | **[→OCC-102 Agent E]** tool-level `alwaysLoad:false` precedence landed |
| 85 | background Bash/PowerShell stop after time limit (`timeout` w/ `run_in_background`, 30min default, 2h max) | DEFER | **[→OCC-102 Lead]** `backgroundDeadline.ts` deadline-reap subsystem landed |
| 86 | Code Review PR reviews + `/ultrareview` run when `disableWorkflows` on (unless MDM-set) | DEFER | `disableWorkflows` gating — not reached |
| 87 | custom `ANTHROPIC_BASE_URL` sessions using 1M context window of models that have one | DEFER | context-window/base-URL — not reached |
| 88 | Team/Enterprise (and undetermined-plan) sessions withholding WebFetch until org policy loads | DEFER | org-policy gating (STAGE-grade) — not reached |
| 89 | `/memory`: Auto-memory can't be turned ON from bg/tool-started session (OFF still works) | DEFER | **[→OCC-102 Agent D]** `autoMemorySessionGate.ts` landed (SECURITY) |
| 90 | one-time auto-mode-default offer also on 3P providers + telemetry off | STAGE | auto-mode default family (STAGE-grade; Gap-140c lineage) |
| 91 | `claude -p`/Python SDK on 3P/telemetry-off starting in auto mode when none configured | STAGE | auto-mode default family (**forbidden to blind-bump `CURRENT_MIGRATION_VERSION`** src/main.tsx =11) |
| 92 | Bedrock/Mantle/Claude-Platform-on-AWS non-default-port base URL → port in SigV4-signed Host | **PARTIAL — OCC-142 UNIQUE** | §2.6 — Bedrock clause PORTED (dep patch `hostname`→`host`); Mantle/Claude-Platform-on-AWS NO-OP (no SigV4 path). **Not touched by OCC-102.** |
| 93 | MCP server name `widgets` reserved in cloud sessions + self-hosted runners (close spellings too) | **PARTIAL — OCC-142 UNIQUE** | §2.7 — cloud-session env gate PORTED; `hostCarrier` carve-out DEFER (unreachable: OCC runner is a no-op stub). **Not touched by OCC-102.** |
| 94 | `/ultrareview` macOS/Linux leaving symbolic refs out; refusing symbolic-ref branch | NO-OP | `/ultrareview` local-upload surface absent |
| 95 | Windows: project/local settings `env` no longer sets `ALLUSERSPROFILE`/`SystemDrive`/`CommonProgramFiles` | DEFER | Windows settings-env blocklist — not reached |
| 96 | `/tasks` folding Claude's own background work under one "System tasks" row | DEFER | `/tasks` UI grouping — **[OCC-102 §4]** forensic'd but not landed |
| 97 | `/ultrareview` macOS/Linux requiring git 2.31+; refusing `--separate-git-dir` | NO-OP | `/ultrareview` local-upload surface absent |
| 98 | `/ultrareview` sending partial clone as worktree snapshot on git 2.31+ | NO-OP | `/ultrareview` local-upload surface absent |
| 99 | `/ultrareview` refusing partial clone missing worktree files on older git | NO-OP | `/ultrareview` local-upload surface absent |
| 100 | Bedrock/Vertex/Mantle start-up model checks identifying as Claude Code | DEFER | 3P request headers (companion to #83) — not reached |
| 101 | `claude mcp get` hiding command/args/env values of plugin-provided stdio servers (names shown) | PORT | §2.4 — dup impl; **[→OCC-102 Agent E]** `mcpGetHandler` redaction landed; mine dropped |
| 102 | `/claude-api` no longer runnable from Remote Control clients | NO-OP | Remote Control surface |
| 103 | `/config chrome=true` directing to /config panel vs enabling Claude in Chrome by default | NO-OP | Claude-in-Chrome surface (verify) |
| 104 | sandbox settings: project can't widen/disable admin-required sandbox, replace managed proxy, extend strict allowlist, reopen managed read-denies | DEFER | **[→OCC-102 Agent C]** `trustedTierGrants.ts` collapse landed (SECURITY) |
| 105–129 | [VSCode] ×25 (restored-tab note, plugin options form, on-demand diagnostics, slash-command Enter, agent transcript, quoted-tag text, sent-while-working msg, Web-tab account switch, RESUME_INTERRUPTED_TURN tabs, Escape turn-stop, Past-conversations replace, reloaded-tab blank, already-open conversation, hook block reason, stuck tabs, Read/Write/Edit 10-min stall, agent-map subagent model, plugin uninstall wrong install, sign-in auth-code step, chat-panel row-trim stall, conversation disappearing w/ many agents, editor-tab old name after rename, agent-map transcript omission, Manage-plugins failure popup, Manage-plugins shared-settings confirm) | NO-OP | OCC ships no VSCode extension |
| 130–131 | [Cloud sessions] ×2 (Run-now internal-error text; `MCP_DISCOVERY_CACHE=1` env-vs-settings reuse) | NO-OP | cloud surface |
| 132–134 | [Claude Tag] ×3 (Enterprise DM seat; Default-model org-usable filter; fallback-model note persistence on edit) | NO-OP | Slack/Tag surface not in OCC |
| 135–136 | [Code Review] ×2 (org menu scroll-load; REVIEW.md not-applied notice) | NO-OP | GitHub App cloud service |

## §1b Original OCC-142 verdicts (pre-reconciliation)

OCC-142's independent triage tally over the 136 bullets: PORT 6 (#1,#6,#18,#46,#61,#101) · PARTIAL 3 (#14,#92,#93) · STAGE 6 (#32,#63,#64,#66,#81,#82) · NO-OP 63 · DEFER 58. This round was **Leader-executed directly** (no sub-issues, per this issue's 不派发子 issue discipline) after the programmer agent died mid-forensics twice (runs a27158a3 + 0f80ba40). The Leader salvaged the a27158a3 worktree, its `/tmp/cc-diff-285` corpus, and the completed #46 parser edit, then re-executed the high-confidence verifiable subset via 4 parallel synchronous port subagents + direct work.

**Those 6 PORTs + the #14 PARTIAL were later found to be duplicates of the parallel OCC-102 landing** and were dropped at reconciliation (main's versions win). Only #92 and #93 (OCC-102 never touched them) survive as OCC-142-unique — see §1c.

## §1c Reconciliation against the parallel OCC-102 round (FINAL)

`origin/main` at reconciliation = `c973302` (OCC-102's second push). Cross-walk of OCC-142's items:

**OCC-142-UNIQUE (landed on this branch `occ142-final`, on top of main):**
- **#92** Bedrock SigV4 non-default-port Host header — `patches/@anthropic-ai%2Fbedrock-sdk@0.26.4.patch` + `package.json`/`bun.lock` `patchedDependencies` (§2.6). 5 tests.
- **#93** `widgets` reserved MCP server-name cloud gate — `src/services/mcp/mcpStringUtils.ts` (`getMcpServerNameCollisionKey`) + `src/services/mcp/config.ts` (`isReservedWidgetsServerName`) (§2.7). 9 tests.
- This ledger (`docs/upstream-version-gap-occ142.md`).
- `CLAUDE.md` one-line prose fix (dev-polyfill "Version prints as 2.1.284" → "2.1.285").

**OCC-142 PORTs that were DUPLICATES (main wins, mine dropped):** #1, #6 (→OCC-102 Agent B); #18, #61, #101 (→OCC-102 Agent E); #14 text-scrubber (→OCC-102); #46 parser fail-closed (→OCC-102). Verified no clobber: `git diff --stat 08759e8 c973302 -- src/services/mcp/config.ts src/services/mcp/mcpStringUtils.ts` is empty → OCC-102 never touched #92/#93's files.

**OCC-142 DEFERs the parallel OCC-102 round landed (19):** #3, #4, #5, #8, #9, #15, #17, #20, #25, #28, #50, #51, #54, #60, #72, #84, #85, #89, #104. Plus #7/#58 confirmed NO-OP and #22/#76 STAGED by OCC-102 Agent D.

**Still open after both rounds (neither landed — re-triage next round):** #13, #16, #19, #26, #29, #30, #31, #33, #38, #45, #48, #49, #52, #55, #59, #62, #65, #67, #68, #70, #75, #77, #79, #80, #83, #86, #87, #88, #90(STAGE), #91(STAGE), #95, #96, #100. Of these, STAGE-grade mechanisms needing dedicated decompilation: #19/#90/#91 (auto-mode classifier + default migration — **forbidden to blind-bump `CURRENT_MIGRATION_VERSION`**), #88 (org-policy managed-settings), #67 (Edit device-target). P0-security-adjacent remaining: #67, #88.

## §2 Landed-item detail (byte evidence)

> §2.1–§2.5 below document OCC-142's *original* duplicate implementations. They
> were **superseded by OCC-102's versions on main and dropped**; the sections are
> kept only as a forensic record of the byte evidence (which is identical — both
> rounds recovered the same official strings). **§2.6 (#92) and §2.7 (#93) are the
> live OCC-142-unique landings.**

### §2.1 #1 `CLAUDE_CODE_DISABLE_WEB_FETCH` — DUPLICATE (superseded by OCC-102 Agent B)
Official byte evidence (new285.txt): @34173852 `isEnabled(){return!a.CLAUDE_CODE_DISABLE_WEB_FETCH&&Yt(wye)}` (285 gate); gone284.txt @34608671 `isEnabled(){return Qt(_ye)}` (284 policy-only — env name has 0 occurrences in the 284 dump → genuinely new). Main's `WebFetchTool.isEnabled()` (OCC-102 Agent B) implements the gate; OCC-142's parallel implementation was dropped.

### §2.2 #6 `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` — DUPLICATE (superseded by OCC-102 Agent B)
Official byte evidence (new285.txt): @37235288 `let Xn,vn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES;if(vn!==void 0&&r.nonStreamingTimeoutMs!==void 0&&Ft instanceof gI&&Date.now()-Et>=r.nonStreamingTimeoutMs*bIo&&!XW()){if(K>=vn)throw m("api_request","api_request_nonstreaming_timeout_exhausted"),new ic(Ft,h);K++,Xn=vn-K}`; @37229988 `bIo=0.9`; @15536037 `class gI extends nu` = APIConnectionTimeoutError; @15602450 `$I=M.int({min:0,digitsOnly:!0})`. Main's `withRetry.ts` has `NONSTREAMING_TIMEOUT_ELAPSED_RATIO = 0.9` + cap parser and `claude.ts:1216` wires `nonStreamingTimeoutMs: fallbackTimeoutMs` (OCC-102 Agent B); OCC-142's parallel implementation was dropped.

### §2.3 #14 URL-password redaction — DUPLICATE (superseded by OCC-102)
Official byte evidence: gone284 @21838036 `function qbn(e){return e.replace(/:\/\/[^/?#]*@/g,"://")}` (literal-`@` only); new285 @19241497 `function Nbn(e){return e.replace(/:\/\/[^/?#]*(@|%40)/g,(n,r)=>r==="@"?"://":"://[REDACTED]%40")}`. Main's `src/utils/redactUrl.ts` carries the official `Nbn` regex `/:\/\/[^/?#]*(@|%40)/g` with the replacer (OCC-102); OCC-142's parallel implementation was dropped. The `[REDACTED]` secret-rules array half (3 new ids: `url-userinfo-tail`, `url-userinfo-later-at`, `url-userinfo-encoded`) remains DEFER by both rounds — OCC has no low-confidence url-userinfo scanner to port into.

### §2.4 #18 + #61 + #101 MCP CLI — DUPLICATE (superseded by OCC-102 Agent E)
Official byte evidence: `Die` @203349574 (`type==="stdio"||type===void 0`); display-branch `h=Die(i)&&!OKe.has(i.scope)?Y(i):Ie({[o]:i})[o]??Y(i)`; #101 plugin-stdio redaction gate in `mcpGetHandler`. Main's `cliMessages.ts` `Tn` output sanitization + `Die(i)&&Die(h)` typeless-stdio inference + plugin-stdio value redaction (OCC-102 Agent E) implement these; OCC-142's parallel implementation (`displaySanitize.ts`/`types.ts`/`utils.ts`/`mcp.tsx`) was dropped.

### §2.5 #46 PowerShell parser fail-closed — DUPLICATE (superseded by OCC-102)
Official byte evidence: new285.txt @856289 `try{s=IQ(pMn(e))}catch(ye){return t(...),Ew(e,"PowerShell parser could not be started","EncodeError")}`; @857682 `n=_Mn(e).catch((s)=>{try{u(s)}catch{}return Ew(e,"PowerShell parser failed unexpectedly","UnexpectedError")})`; @857484 `SMn=new Set([…"EncodeError","UnexpectedError"])`. Main's `src/utils/powershell/parser.ts` has the EncodeError/UnexpectedError fail-closed + TRANSIENT set (OCC-102); OCC-142's parallel implementation was dropped.

### §2.6 #92 SigV4 Host port — PARTIAL (Bedrock clause PORTED) — **OCC-142 UNIQUE (live)**
`patches/@anthropic-ai%2Fbedrock-sdk@0.26.4.patch` (new) + `package.json`/`bun.lock` `patchedDependencies` (OCC's sanctioned patch mechanism; precedent = the existing `@anthropic-ai/sandbox-runtime@0.0.44` patch): in both `core/auth.mjs` and `core/auth.js`, `headers['host'] = url.hostname` → `url.host` so a non-default-port base URL produces a SigV4 canonical Host header matching the request line. `URL.host` = `hostname[:port]`, auto-omitting the default port (443/https, 80/http) → default-port behavior unchanged.
Byte evidence: gone284 @23548950 `…delete n.connection,n.host=s.hostname;…`; new285 @23453100 `…delete o.connection,o.host=s.host;…` (the fix is exactly `s.hostname`→`s.host`). The same-hunk `query:` rewrite is a separate multi-value-param signing fix (NOT #92, not ported). OCC locus: `src/services/api/client.ts` builds `new AnthropicBedrock(…)` and delegates signing to `@anthropic-ai/bedrock-sdk@0.26.4` (`getAuthHeaders` reads `url.hostname`). Tests: `src/services/api/__tests__/bedrockSigv4HostPort285.test.ts` (5 pass; offline/deterministic via fake creds; imports only the package public subpath `@anthropic-ai/bedrock-sdk/core/auth.mjs`, not transitive deps; mutation-verified — reverting `url.host`→`url.hostname` fails exactly the 2 non-default-port cases). **CI-safe on fresh install verified**: `rm -rf node_modules && bun install` applies the patch (`auth.mjs:59` = `url.host`) and the test passes 5/0.
**NO-OP (other clauses):** Claude-Platform-on-AWS (client.ts) uses the plain `Anthropic` SDK with `apiKey: ANTHROPIC_AWS_API_KEY` (API-key auth, no SigV4); no Mantle request path in client.ts/query.ts; `src/utils/model/bedrock.ts` uses `@aws-sdk/client-bedrock*` whose `@smithy/middleware-host-header` already appends the port (byte-identical 284↔285). Concern: patch lives in a 3rd-party dep — a bedrock-sdk bump off 0.26.4 must re-cut it (bun errors loudly on version mismatch, won't silently no-op).

### §2.7 #93 `widgets` reserved MCP name — PARTIAL (cloud gate PORTED) — **OCC-142 UNIQUE (live)**
`src/services/mcp/mcpStringUtils.ts`: added exported `getMcpServerNameCollisionKey(serverName)` = verbatim official `Jd`: `mcpInfoFromString(\`${getMcpPrefix(serverName)}tool\`)?.serverName` (round-trip absorbing trailing underscores into the `__` delimiter, so `widgets_` → `widgets`). `src/services/mcp/config.ts`: `WIDGETS_SERVER_NAME='widgets'`, `WIDGETS_COLLISION_KEY=getMcpServerNameCollisionKey('widgets')` (mirrors official `CN=Jd(a9e)`), `isReservedWidgetsServerName(name)` = `isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) && getMcpServerNameCollisionKey(name)===WIDGETS_COLLISION_KEY`, OR'd into `isReservedMcpServerName`. Load-time enforcement reuses the existing `parseDynamicMcpConfig` check (`&& validated.type!=='sdk'`, byte-identical official `reserved_name` message).
Byte evidence: new285.txt @23972878 `a9e="widgets"`; @34903711 `function Jd(e){return ys(\`${Us(e)}tool\`)?.serverName}`; @19977107 `Us(e)=\`mcp__${wn(e)}__\``; @34904041 `CN=Jd(a9e);…if(r===CN)return(n?.hosted??a.CLAUDE_CODE_REMOTE)&&!(n?.hostCarrier&&e===a9e);`; gone284.txt @35296792 `MRe` has NO widgets branch → 285 added it. Tests: `src/services/mcp/__tests__/widgetsReservedName285.test.ts` (9 pass, no mock.module — env read fresh per call). Mutation-verifiable pins: gate-off → `widgets`+`widgets_` LOAD; gate-on → `reserved_name` skip; `type:"sdk"` exempt; `Widgets`/`widgets-`/`_widgets`/`mywidgets`/`widgets1` NOT reserved; `widgets_`/`widgets__`/`widgets ` reserved.
**DEFER (`hostCarrier` carve-out):** official gate is `(hosted ?? CLAUDE_CODE_REMOTE) && !(hostCarrier && name==="widgets")` — the 2nd term lets a self-hosted runner's OWN internal `widgets` server load. OCC's `src/self-hosted-runner/main.ts` is a no-op stub with no `hostCarrier` plumbing and OCC registers no internal `widgets` server → carve-out unreachable; ported the portable cloud-env half (satisfies the bullet's user-facing contract). Re-add if OCC ships a real runner carrier. Did NOT port other new-in-285 reserved-name branches (`Uc`/`zJ`, loopback, `webagent`, `claude_ai`/`remote-devices`/`hearthbot`/`pmt`) — #93 is widgets-only.

## §3 Carry-overs & known-red

- occ141 §5 items remain open: **F5** mcp add/remove silent config-write failure (occ138 §6.3); nudge-probe fixture dedup (occ140 §10 P3); Gap-140b/e staged sets. Effort-cap ⑥ known-red belongs to OCC-82 — do NOT touch.
- occ141 §1b 284 DEFERRED list — still open; re-triage 284 + the surviving 285 DEFERs (§1c "still open") together next round.
- **Leftover remote branch `agent/occ/184194a6`** (earlier failed programmer run) — already cleaned; `git ls-remote origin 'refs/heads/agent/*'` returns empty at reconciliation.

## §4 Version-ref sync + release

- Version refs → 2.1.285 were **already synced on main by OCC-102** (README badge/prose/parity-table/footer, `src/entrypoints/cli.tsx` dev-polyfill `VERSION="2.1.285"`, CHANGELOG "Now tracks" line, `package.json` → 2.1.362). OCC-142 adds only the `CLAUDE.md` dev-polyfill prose line fix (2.1.284 → 2.1.285) that OCC-102 left stale, plus its two unique code items.
- CI gate (this branch, on top of main): `bun run build` + `CI=true bash scripts/ci-test.sh` green → commit direct to main (no sub-issues per discipline).
- **Release v2.1.362 (OCC-142 completes it — OCC-102 staged 2.1.362 in `package.json`/CHANGELOG but never tagged/published; remote tags end v2.1.361, npm `latest` = 2.1.361):** tag `v2.1.362` → publish.yml (build → set version from tag → strip `workspace:*` deps → npm publish → `gh release create --generate-notes`, `if: success()`, `permissions: contents: write`, no `--target`, idempotent) → verify npm `@cnwenf/occ` `latest` = 2.1.362 + GitHub Release + `/releases` ≡ `/tags` (expect 162/162) → report link.
- e2e: REPL tmux smoke + live `-p`; **projectDir NEVER inside agent workdir or any CLAUDE.md-containing tree** (occ140 §9 hardened rule; use `/tmp/occ142-e2e`).

## §5 Test baseline

- OCC-102's main-merge baseline (their §6): full suite `bun test src/` single-worker 6276 pass / 67 fail; the 67 are pre-existing order-dependent single-worker pollution failures (zero new fails vs the pristine 5819/71 baseline; 4 baseline fails fixed as a side effect of their mock-leak repair). `bun run build` → `OCC 2.1.362`.
- OCC-142's per-file-isolation CI on its own pre-reconciliation branch: 691 files checked, 0 failed, CI_EXIT=0 (`CI=true bash scripts/ci-test.sh`, per-file process isolation).
- This branch (`occ142-final` = main + #92/#93): both unique test files green (14 pass / 0 fail) in isolated bun processes; build + affected-area (`src/services/mcp/`, `src/services/api/`) + full CI gate re-run recorded in the round result comment.
- Pre-existing tsc errors (non-blocking; build uses bun not tsc) carry over from main unchanged; zero new type errors from #92/#93.

## §6 Incident-prevention notes (this round)

- **Programmer agent failed twice** (runs a27158a3 + 0f80ba40; an earlier round also had 184194a6 + f1b42a41). 0f80ba40 died at seq 736 mid-forensics — all 10 cluster subagent results lost. Per the stall instruction, the **Leader took over directly** rather than re-dispatching: salvaged the a27158a3 worktree + `/tmp/cc-diff-285` corpus + the completed #46 parser edit, and re-executed the high-confidence verifiable subset via 4 parallel synchronous subagents + direct work.
- **PARALLEL-ROUND COLLISION (the defining incident of this round).** The occ141 §8 "check origin/main for in-flight rounds" lesson was applied at *dispatch* time and correctly found no parallel 285 round then (all prior catch-up issues done, other actives content-production, agents idle) → early-exit clause not applicable, round proceeded. **But a parallel round (OCC-102) started *after* that check and pushed to main mid-round** (`bc78387` 06:21, `c973302` 07:41). The dispatch-time check cannot catch a round that begins later. **Corrected lesson:** re-check `origin/main` for new catch-up commits *immediately before merging*, not only at dispatch — and when a parallel round has landed a superset, reconcile by dropping duplicate work and keeping only the verified-unique delta (here #92/#93) rather than force-pushing a competing history. Reconciliation was clean because OCC-102 never touched `config.ts`/`mcpStringUtils.ts`/`patches/` (git-diff-verified) → zero clobber.
- **Background-task safety honored:** all subagents ran synchronously (run_in_background:false); the long full-CI run was backgrounded only to survive the 10-min tool ceiling and was blocked-on to completion before any push/release — no turn yielded with run-owned work pending.
- **Dep-patch lesson (#92):** `bun patch --commit` (bun 1.4.2) materialized `node_modules/@anthropic-ai/bedrock-sdk` as a real dir instead of the isolated-linker symlink, breaking transitive resolution — repaired in-worktree, and CI-safety confirmed via a clean `rm -rf node_modules && bun install` (patch applies, test green). Future dep-patch rounds: always verify on a fresh install, not the patched-in-place tree.
- **Corpus preservation:** `/tmp/cc-diff-285` (OCC-142's copy) is runtime-local and will be GC'd — next round must re-extract or copy it into the repo early (occ141 §8 lesson repeated). OCC-102 already removed their copy at their round end.
