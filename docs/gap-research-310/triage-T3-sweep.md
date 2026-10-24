# Triage T3 — items 13–26 (N-A formalization) + new-surface sweep

Round: official claude-code 2.1.309 → 2.1.310. Scope: (A) changelog items 13–26 (VSCode extension / Cloud sessions web / Claude Tag / Code Review admin) — N-A formalization with grep evidence; (B) portable-surface sweep of `/tmp/cc-diff-310/new_strings.txt` (27,851 lines) for env vars, settings keys, hook events, slash commands, tool names.
Method: official ELFs **never executed** — forensics only via `grep -caboF` byte counts/offsets + bounded `dd` context reads on `bin309/package/claude` (293,469,552 B) and `bin310/package/claude` (291,638,640 B); OCC side is read-only `grep -rn` over `src/`+`packages/`. Format follows `docs/gap-research-309/triage-T3.md`.

Verdict summary (14 items, 13–26): **N-A 14**. No item's fix leaks a CLI-side string that OCC renders — the exception check found exactly one CLI-binary-adjacent family (cloud-session setup-script snapshot strings, sibling of item 19) and OCC has **zero** cloud-session-checklist surface, so even that stays N-A (documented for a future cloud-client port).
Sweep summary (Job B): **1 verified new portable surface** — `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE` (enum `"capacity"`; disables the retry watchdog) — flagged for T1/T2 follow-up against OCC's `withRetry.ts`. Plus 6 verified-new env/export names that are cloud/Desktop/dormant (N-A), 1 new CLI string family (cloud-session snapshot checklist, N-A for OCC), and **no** new hook events, slash commands, tool names, or settings.json keys.

| # | Item (short) | Verdict |
|---|---|---|
| 13 | [VSCode] plan-review "Send feedback and keep planning" Enter-key fix | N-A |
| 14 | [VSCode] "Something went wrong" after "Switch branch & continue" | N-A |
| 15 | [Cloud sessions] cloud-session/Remote-Control perms in Enterprise custom roles | N-A |
| 16 | [Cloud sessions] Choose-file button for env setup script | N-A |
| 17 | [Cloud sessions] env-edit dialog save/archive errors shown in dialog | N-A |
| 18 | [Cloud sessions] routine API-token errors shown in routine edit dialog | N-A |
| 19 | [Cloud sessions] session-start checklist setup-script output scrolling box | N-A (CLI sibling strings new in 310 — see §Job B-6) |
| 20 | [Cloud sessions] confirmation + role list when enabling Cloud sessions/Remote Control | N-A |
| 21 | [Cloud sessions] env dialog row-based editors | N-A |
| 22 | [Claude Tag] `!` commands in bold/italic/strikethrough | N-A |
| 23 | [Claude Tag] admin pages not replaced by bundle-refresh load error | N-A |
| 24 | [Claude Tag] spend-limits page filter vs still-loading channel names | N-A |
| 25 | [Code Review] admin section keeps repos/switches after failed refresh | N-A |
| 26 | [Code Review] admin first-load retry + single "Try again" banner | N-A |

---

## Job A — items 13–26 verdicts

Baseline repo evidence (shared by all 14 items): OCC ships no VSCode extension source, no cloud-sessions web/admin client, no Claude Tag product surface, and no Code Review admin web section.
`find . -maxdepth 3 -type d \( -iname '*vscode*' -o -iname '*extension*' \)` (excluding node_modules/.git) → **0 dirs**; `src/entrypoints/` = `cli.tsx`, `init.ts`, `mcp.ts`, `sdk/` only. `grep -rli 'vscode' src` hits are host-*detection* references only (e.g. `src/tools/BashTool/prompt.ts` notes the desktop/vscode entrypoint gates are constant-false because OCC doesn't ship those hosts; `dangerousRmAutoDeny.ts`, `bashPermissions.ts`, `forkSubagent.ts` — same pattern, per the round-309 item-54 verdict). `grep -rn 'Choose file\|custom role' src -i` → **0 hits**. `grep -rn 'repository list\|repositories and switches' src -i` → **0 hits**.

### Item 13 — VERDICT: N-A
[VSCode] plan-review card "Send feedback and keep planning" button: Enter approved the plan instead of sending comments. The plan-review card is a VSCode-extension webview component; OCC ships no extension (baseline evidence above) — OCC's plan-mode surface is the terminal `ExitPlanMode` permission prompt (`src/components/permissions/`), which has no such button. Exception check: `grep -cF 'Send feedback and keep planning' new_strings.txt` → **0** (string never entered the CLI binary; extension-bundle-only fix). Nothing for OCC to render or port.

### Item 14 — VERDICT: N-A
[VSCode] panel "Something went wrong" after "Switch branch & continue" on a cloud session opened from Session history's Web tab. Extension + cloud-session-web interaction; OCC has neither (baseline). Exception check: `grep -cF 'Switch branch' new_strings.txt` → **0**; `'Something went wrong'` → 4 lines in new_strings, but `grep -caboF` in both binaries → **7 (309) / 7 (310)** — the generic error-boundary string is pre-existing and unchanged in count; the 4 new lines merely reference it from churned extension-host chunks. No CLI-side delta.

### Item 15 — VERDICT: N-A
[Cloud sessions] Claude Code cloud sessions + Remote Control permissions added to Enterprise **custom roles** (claude.ai org admin backend). Pure web/backend entitlement surface; OCC has no admin console, no custom-role concept (`grep -rn 'custom role' src -i` → 0). Exception check: `'custom role'` → **0** lines in new_strings.txt. N-A.

### Item 16 — VERDICT: N-A
[Cloud sessions] "Choose file" button to load a cloud environment's setup script from a file — a control in the claude.ai cloud-environment editor (web). OCC: no cloud-environment editor (baseline). Exception check: `'Choose file'` → **0** in new_strings.txt. N-A.

### Item 17 — VERDICT: N-A
[Cloud sessions] failed saves/archives in the cloud-environment edit dialog now surface the error inside the dialog — web dialog error-rendering fix. OCC has no such dialog (baseline). No distinctive CLI string exists for the fix (dialog-scoped web code). N-A.

### Item 18 — VERDICT: N-A
[Cloud sessions] failed routine API-token actions now error inside the routine edit dialog instead of only a toast — web dialog fix. OCC: no routine-editor surface (`grep -rn 'routine edit' src -i` → 0). Exception check: `'routine edit'` → **0** in new_strings.txt. N-A.

### Item 19 — VERDICT: N-A (with CLI-sibling evidence recorded)
[Cloud sessions] session-start checklist shows the cloud environment's setup-script output in a scrolling box — the scrolling box is the **web** checklist. The CLI binary does contain the terminal-side session-start checklist renderer, and 310 adds a **setup-script snapshot** mode to it (verified new: `'Restored from snapshot of setup script'` → BIN309 **0**, BIN310 **2** @127115528, @264395599; dd @264394799 shows the full renderer: sessionMode `"restored"`, `setup_script` step → `"Restored from snapshot"`, suffix builder over `setupSource ∈ {building_checkpoint → " · saving so your next session skips this", checkpoint_restore_failed → " · couldn't use snapshot", checkpoint}` and `completedMode==="restored" → " · saved about ${duration}"`, plus `Remote session ready in X · restored from snapshot`). HOWEVER, OCC ships **none** of this checklist surface — even the pre-309 strings are absent: repo grep for `'Setting up a cloud container'`, `'Remote session ready in'`, `'Ran setup script'`, `'Setup script failed'`, `'setupScriptDurationMs'`, `'Restored from snapshot'` → **0 files each**. OCC has no cloud-session start client to render into, so the fix (and its CLI sibling) is N-A today. Recorded here so a future cloud-session-client port adopts the snapshot strings verbatim from day one (offsets above).

### Item 20 — VERDICT: N-A
[Cloud sessions] enabling Cloud sessions / Remote Control in **admin settings** now asks confirmation and lists custom roles holding that permission — org-admin web console behavior. OCC: no admin settings console, no custom roles (item-15 evidence). `'custom role'` → 0 in new_strings.txt; the 107 `'Remote Control'` new-string lines are the pre-existing CLI remote-control pairing surface (present in 309 too), not this admin toggle. N-A.

### Item 21 — VERDICT: N-A
[Cloud sessions] cloud-environment dialog reorganized: network access, setup script, environment variables open from rows instead of all editors at once — web dialog layout. OCC: no cloud-environment dialog (baseline). N-A.

### Item 22 — VERDICT: N-A
[Claude Tag] `!` commands (`!restart`, `!help`) were treated as ordinary messages when sent in Slack bold/italic/strikethrough — Tag's Slack-message parsing (Tag server product). OCC ships no Claude Tag runtime: `grep -rn 'Claude Tag\|claude-tag\|claudeTag' src` → only `'claude-tag-plugins'` in `src/utils/plugins/schemas.ts:43` (+2 tests), which is a **reserved-plugin-name** denylist entry, not Tag product code. OCC's `/install-slack-app` (`src/commands/install-slack-app/`) is the Slack-app install CLI command and does no `!`-command parsing. Exception check: `'!restart'` → **0**, `'!help'` → **0** in new_strings.txt (parsing fix is server-side, not in the CLI binary). N-A.

### Item 23 — VERDICT: N-A
[Claude Tag] admin channel/workspace pages were replaced by a load error when a background bundle-list refresh failed — Tag **admin web** error-boundary fix. OCC: no Tag admin pages (item-22 evidence). The binary does embed Tag-admin backend handler code (pre-existing in both versions — `grep -caboF 'spend_limit.delete'` → **2 (309) / 2 (310)**), but OCC ships none of it and the fix is web-page rendering, not handler behavior. N-A.

### Item 24 — VERDICT: N-A
[Claude Tag] spend-limits admin page claimed "no channels match the filter" while channel names were still loading — web page loading-state fix. OCC: no spend-limits page (`grep -rn 'spend limit' src -i` → 0 product hits). new_strings' 15 `'spend limit'` lines are the embedded Tag-admin backend (SQL/Response.json handlers, pre-existing family per item-23 evidence) — not an OCC-rendered surface. N-A.

### Item 25 — VERDICT: N-A
[Code Review] admin section hid repositories and switches after a failed repository-list refresh — claude.ai admin **web** section state fix. OCC has the CLI-side review surface (`src/tools/ReviewArtifactTool/`, `/code-review`) but no admin web section: `grep -rn 'repository list\|repositories and switches' src -i` → **0**. N-A.

### Item 26 — VERDICT: N-A
[Code Review] admin section retries first load and shows one "Try again" banner on repeated failure — same web admin section as item 25. OCC's `'Try again'` hits are unrelated surfaces (ComputerUseApproval button, voice-module message, MCP credential-store error text, remote-auth notification) — none is a Code Review admin banner. N-A.

---

## Job B — new-surface sweep of new_strings.txt (verified findings only)

Verification bar for everything below: token present in BIN310 (`grep -caboF` > 0, offsets cited), **absent** in BIN309 (= 0), plus OCC `grep -rn src packages` status. Names extracted from new_strings were re-checked in full-token form because the string dumps glue minifier artifacts onto tokens (e.g. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS0`, `MCP_READ_COMMENTS_TOOL` ⊂ `ARTIFACTS_MCP_READ_COMMENTS_TOOL`) — all such glued forms were resolved to their true names before verification, and 8 candidates (`ANTHROPIC_DEFAULT_{FABLE,HAIKU}_MODEL_SUPPORTED_CAPABILITIES`, `CLAUDE_CODE_ARTIFACT_MCP`, `CLAUDE_CODE_AUTO_MODE_REMOTE_BROWSER`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISPATCH_V2`, `CLAUDE_CODE_FOUND_REPOSITORY_GIT`, `CLAUDE_CODE_MEMORY_API_TOKEN`) were **rejected as not-new** (present in BIN309 with equal counts — they merely appear on changed lines).

### B-1. `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE` — VERIFIED NEW — **PORTABLE (flag for T1/T2)**
- Evidence: BIN310 **3** hits — @116653064 (env name table, between `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` and `…USAGE_LIMIT_RECHECK_MS`), @237740334 (export map `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE:()=>Hx`), @249421445 (the gate). BIN309: **0**.
- Parser/schema (new_strings line 16535, env-schema chunk): `Hx=D.enum(["capacity"])` — a single-valued enum.
- Behavior delta, byte-recovered: BIN309 gate `function S3(){return i.CLAUDE_CODE_RETRY_WATCHDOG}` (dd @251729200) → BIN310 gate `function zb(){return i.CLAUDE_CODE_RETRY_WATCHDOG&&i.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE!=="capacity"}` (dd @249421195). I.e. setting `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE=capacity` now **disables** the retry watchdog (host/SDK can scope watchdog handling to the capacity layer). No other SCOPE use exists (3 hits total).
- OCC status: **EXISTS but stale** — `src/services/api/withRetry.ts:103` mirrors the 309 gate exactly (`return isEnvTruthy(process.env.CLAUDE_CODE_RETRY_WATCHDOG)`), no SCOPE check anywhere (`grep -rn RETRY_WATCHDOG_SCOPE src` → 0).
- Relevance: **portable** — small parity change (add `&& process.env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE !== 'capacity'` to the watchdog-enable predicate + enum-value note). Hand to T1/T2.

### B-2. `CLAUDE_CODE_ARTIFACT_ASK_FIRST` — VERIFIED NEW — N-A (artifacts/cowork subsystem)
- Evidence: BIN310 **3** — @116617880 (name table), @237706146 (export map), @269443514 (live code: `Of(e){…return …&&(i.CLAUDE_CODE_ARTIFACT_ASK_FIRST??k("cai_proud_planet",!1))===!0}` beside `kw={slides:[…],design:[…]}` — an ask-first gate for the Cowork artifacts flows). GrowthBook gate `cai_proud_planet`: BIN309 **0** → BIN310 **2**.
- OCC status: **MISSING** — `grep -rn 'proud_planet\|ASK_FIRST\|askFirst' src` → 0; OCC has no artifacts/cowork subsystem (`ReviewArtifactTool` is the unrelated code-review artifact tool).
- Relevance: N-A — cloud/cowork product surface OCC deliberately doesn't ship (cf. round-309 dataviz/managed-agents precedent).

### B-3. `CLAUDE_CODE_DESKTOP_CONNECTOR_NAMES` (+ `setDesktopConnectorNames`) — VERIFIED NEW — N-A (Desktop host plumbing)
- Evidence: BIN310 **5** — @116620552 (name table), @237708712 (export map), @237960088/@237960136 (consume-then-scrub: `let d=l9r();if(t.setDesktopConnectorNames(d&&i.CLAUDE_CODE_DESKTOP_CONNECTOR_NAMES),d)i.unset("CLAUDE_CODE_DESKTOP_CONNECTOR_NAMES")`), @241906651 (subprocess scrub allowlist). `setDesktopConnectorNames`: BIN309 **0** → BIN310 **3**. The paired schema describe text `"@internal Desktop host only: the words an SDK host puts on an ask's permission card (PreToolUse…)"` is pre-existing family (2/2).
- OCC status: **MISSING** — `grep -rn DESKTOP_CONNECTOR src` → 0.
- Relevance: N-A — Desktop-host-only plumbing (host passes connector display names to the child, then scrubs); OCC ships no Desktop host (same posture as round-309 item 54's host-scoped half).

### B-4. `CLAUDE_CODE_TOOL_CONTAINER_PLUGINS_NAMED` — VERIFIED NEW — N-A (dormant flag)
- Evidence: BIN310 **2** — @116628896 (name table), @237716825 (export map `…:()=>qs`). BIN309: **0**. **No code-usage hit** (`i.CLAUDE_CODE_TOOL_CONTAINER_PLUGINS_NAMED` never appears; only the 2 table entries) — a registered-but-unreferenced flag in this build, behavior not string-recoverable.
- OCC status: **MISSING** — `grep -rn TOOL_CONTAINER_PLUGINS src packages` → 0.
- Relevance: N-A/monitor — nothing to port without a usage site (porting a guessed behavior would violate the skill's never-invent rule). Re-check next round whether code usage appears.

### B-5. `ARTIFACTS_MCP_READ_COMMENTS_TOOL` / `ARTIFACTS_MCP_REPLY_COMMENT_TOOL` / `ARTIFACTS_MCP_RESOLVE_COMMENT_TOOL` — VERIFIED NEW — N-A (artifacts MCP)
- Evidence: each BIN309 **0** → BIN310 **2**: name-table @118813502 / @118813158 / @118813018 and export chunk @262473383–262473568 (`export{YWr as ARTIFACTS_MCP_GET_TOOL, QAe as ARTIFACTS_MCP_READ_COMMENTS_TOOL, …, ogn as ARTIFACTS_MCP_REPLY_COMMENT_TOOL, xQn as ARTIFACTS_MCP_RESOLVE_COMMENT_TOOL, …}`). The surrounding artifacts-MCP module (`ARTIFACTS_MCP_GET_TOOL` 4/4, `artifactMcpToolsReplaceBuiltIn` 4/4) is pre-existing — 310 extends it with the three **comment** tools. (The raw regex hits `MCP_{READ_COMMENTS,REPLY_COMMENT,RESOLVE_COMMENT}_TOOL` were substrings of these.)
- OCC status: **MISSING** — `grep -rn ARTIFACTS_MCP src` → 0 (no artifacts subsystem, per B-2).
- Relevance: N-A — cloud artifacts (Cowork) tooling.

### B-6. Cloud-session setup-script snapshot string family — VERIFIED NEW — N-A for OCC (record for future cloud-client port)
Full detail under item 19 above. Verified-new strings with offsets: `'Restored from snapshot of setup script'` (309:0 → 310:2 @127115528, @264395599), `'Restored from snapshot'` (0→4), `" · saved about "` (0→2), `" · saving so your next session skips this"` + `" · couldn't use snapshot"` (0→2), enum values `building_checkpoint`/`checkpoint_restore_failed`, sessionMode `restored`. OCC grep: 0 files for every member of the family (including pre-309 members) — no surface exists.

### B-7. Negative results (swept, nothing new)
- **Hook events**: set-diff of quoted hook-event names (`PreToolUse|PostToolUse|PermissionRequest|PermissionDenied|SessionStart|SessionEnd|Stop|SubagentStop|SubagentStart|PreCompact|PostCompact|Notification|DirectoryAdded|TeammateIdle|TaskCreated|TaskCompleted|UserPromptSubmit|PostToolUseFailure|InstructionsLoaded|Workflow*`) over full string dumps s310 vs s309 → **∅ new, ∅ removed**. (These names appear on many *changed lines* in new_strings.txt — line novelty ≠ name novelty.)
- **Slash commands**: set-diff of `type:"(local-jsx|local|prompt)",name:"…"` over s310 vs s309 → **∅ new, ∅ removed** (the whole command table re-serializes each build, which is why ~30 command literals appear in new_strings).
- **Tool names**: set-diff of `name:"[A-Z][A-Za-z]{2,30}"` PascalCase tokens over s310 vs s309 → **∅ new, ∅ removed** (no new built-in tool; note changelog item 1's Monitor-on-Bedrock/Vertex/Foundry is an enablement change to the existing Monitor tool, covered by T1/T2).
- **Settings.json keys**: 809 camelCase tokens are new-in-310-only; prefix- and suffix-filtering (`disable|enable|allow|deny|use|show|auto|cleanup|default|…` / `Enabled|Mode|Days|Timeout|Allowlist|…`) left 7 candidates; all 6 verified-new ones are **internal identifiers, not settings keys** — `showPermissionsHint` @126243520 (UTF-16 UI-string blob inside the permission-modal prop table), `skipPlainTaskProgress` @120941552 (remote/cloud event-upload plumbing beside `heartbeatIntervalMs`/`uploadTrim`), `automountPoints` @123295028 (sandbox automounter internals beside Windows-CA/bwrap strings), `allowLinkTextClimbs` @123486704 (PR-link/`linkSessionToPR` region), `denyEntryMatchesModel` @119426572 (managed-model-deny internals), `denyEntryHostNotJudged` @117614184 (diagnostics reason-code list); 7th (`excludeThirdPartyTranscripts`) rejected — 8/8 present in BIN309. Also `isCommentWakeEnabled` (0→2) sits in the background-session holder-probe diagnostics region — internal. **No new settings.json key in 310.**
- **Env-var full-diff**: the `CLAUDE_CODE_*|ANTHROPIC_*|MCP_*` extraction over s310 vs s309 produced 15 raw candidates; after artifact-resolution and binary re-verification, exactly the 7 names in B-1…B-5 are new (B-1 portable; rest N-A/dormant).

## Handoffs
- **T1/T2**: B-1 `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE` — add the `!=="capacity"` clause to OCC's watchdog-enable predicate in `src/services/api/withRetry.ts:103` (byte-recovered 310 gate `zb()` @249421445) + test that `SCOPE=capacity` disables the watchdog while unset/other values keep the `CLAUDE_CODE_RETRY_WATCHDOG` truthiness behavior.
- **Next-round watch**: B-4 (does `CLAUDE_CODE_TOOL_CONTAINER_PLUGINS_NAMED` gain a usage site?), B-6 (if a cloud-session client is ever ported, adopt the snapshot strings verbatim).
