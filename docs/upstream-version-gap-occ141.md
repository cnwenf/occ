# Upstream Gap Ledger — OCC-141 (official 2.1.284 vs OCC 2.1.359@2.1.283)

Round: 2026-09-30. Official latest = **2.1.284** (changelog section = exactly 100 bullets, verified).
OCC tracked-upstream = **2.1.283** → this is a real porting round.

Evidence base:
- Official v2.1.284 linux-x64 GCS binary, sha256 `5cd90aabd83f8a15136c35aa37bb1d92b348993573316643dc3fe4e04afbf88f` — **verified**, 243,059,896 bytes. NEVER executed — strings/dd/grep/perl byte forensics only.
- Official v2.1.283 binary + npm tarballs (both versions) under `/tmp/cc-diff-284/`.
- Strings corpus: `s283s.txt` (301,049 sorted lines), `s284s.txt` (303,459), `new284.txt` (18,922 lines new in 284), `gone283.txt` (16,512).
- Official repo compare 283→284: only CHANGELOG/feed-type files changed (no source published).
- Prior-round context: occ140 §7 (284 pre-triage) / §5 (Gap-140b/c/d/e), occ138 §6.3 (F5 carry-over), occ140 §9 (projectDir incident rule), occ140 §10 (nudge probe dedup P3).

Verdict key: **PORT** = landed this round byte-faithfully; **PARTIAL** = subset landed, rest staged with reasons; **NO-OP** = surface absent in OCC by design (trimmed feature) or server-side-only (gateway/cloud/VSCode/Tag); **STAGE** = surface exists but mechanism not byte-recoverable from the binary — never invented.

## §1 100-bullet triage table

| # | Bullet (abridged; full text in official changelog) | Verdict | Owner / notes |
|---|---|---|---|
| 1 | Sonnet 5.5 (`claude-sonnet-5-5`) default Sonnet on Anthropic API, 1M ctx, $2/$10, $0.20 cache read | PORT | P0-1 series — see §2 |
| 2 | Auto mode: "Yes, but ask again next time" for read outside working dirs | PENDING | auto-mode cluster (Gap-140c agent) |
| 3 | Gateway spend-limit dollar amounts in `/usage` + statusline (`used_usd`/`limit_usd`/`period`) | NO-OP | OCC statusline `rate_limits` carries only `five_hour`/`seven_day` (StatusLine.tsx:55) — no `spend_limit` surface at all; gateway-dependent. Whole-surface port out of 284-delta scope; recorded as gap note §5 |
| 4 | `effortSlider:decreaseEffort/increaseEffort/toggleUltracode` keybinding actions | PORT | effort/ultracode agent |
| 5 | `/rate-limit-options` in `/help` + command menu (claude.ai subscribers) | PORT | self-port: binary delta 283→284 = description `"Show options when rate limit is reached"`→`"Manage usage limits and upgrade options"` + `isHidden:!0` REMOVED (subscriber gate unchanged). Landed in src/commands/rate-limit-options/index.ts |
| 6 | `/mcp reconnect all` | PORT | MCP agent (M2) |
| 7 | Gateway startup warnings: empty `availableModels` / start model missing | NO-OP | gateway SERVER-side (strings live beside the bundled gateway server: `cne()`/`gr("warn"…)`/`Ut(400,…)` role-allowlist code in the same ELF); OCC ships no claude-apps gateway server |
| 8 | Gateway telemetry `auth: { google: {} }` forward_to | NO-OP | gateway server-side config |
| 9 | Gateway `private_key_jwt` certificate client auth | NO-OP | gateway server-side |
| 10 | Damaged stream ("JSON Parse error"/"undefined is not an object") → retry/interrupted | PORT | robustness agent (R1) |
| 11 | Overloaded/server error right after thinking block → retry not turn-error | PORT | robustness (R2) |
| 12 | "Prompt is too long" persists after compact → compact a second time | PORT | robustness (R3) |
| 13 | Model unavailable, no fallback → proper notice + Learn more (not bare message) | PORT | robustness (R6) |
| 14 | Malformed image `source` / document block → explanatory note, no crash | PORT | robustness (R8) |
| 15 | Resumed session MCP call "No such tool available" while connecting → wait 10s | PORT | MCP (M1) |
| 16 | plan-usage endpoint backoff after rate-limit/login rejection (`/usage`, `/extra-usage`, IDE) | PENDING | leftover agent (L1) |
| 17 | `claude mcp add` reports success under managed plugins-only MCP restriction → refuse + guidance | PORT | MCP (M4) |
| 18 | `/plugin` configure screen: boolean true/false choice, number validation, ←/→ field nav | STAGE | OCC has PluginOptionsDialog/PluginOptionsFlow; fix is Ink interaction logic (not string-recoverable — the single `true/false` new284 string belongs to `--config` CLI parsing, not the dialog). Needs dedicated component-level decompilation; not invented |
| 19 | `ANTHROPIC_FOUNDRY_RESOURCE` interpolated unvalidated → refused unless plain resource name | PORT | P0-2① Foundry agent |
| 20 | Desktop behind gateway: 1M-capable models marked automatically | NO-OP | gateway server + Desktop surface |
| 21 | ↓ in shell mode selects hidden background-tasks pill (breaks Backspace/Ctrl+U) | PORT | misc agent (J) |
| 22 | Windows: plugin `bin/` dirs that don't exist not added to PATH; no dup inherited entries | NO-OP | OCC has no plugin-bin PATH augmentation surface (grep src/utils/plugins + shell env: no PATH-building from plugin bin dirs) |
| 23 | `sparsePaths` marketplaces clone empty on git <2.39, replace working copy | PORT | plugin agent (D) |
| 24 | Fullscreen: `[` transcript-mode scrollback write erases output above (macOS/Linux) | STAGE | OCC HAS the surface (REPL.tsx:739 dump-to-scrollback + alt-screen 1049 handling in gracefulShutdown/promptEditor), but the official fix targets its fullscreen renderer mode whose delta is not string-recoverable; porting blind risks regressions in OCC's own alt-screen dance — needs dedicated renderer forensics round |
| 25 | Fullscreen scroll position jumps when reply finishes while scrolled up | STAGE | same fullscreen-renderer family as #24 — scroll-anchoring logic not recoverable from strings |
| 26 | Dialog tab bars (`/config`, `/plugin`) break labels mid-word in narrow terminal | STAGE | Ink layout math (wrap-whole-tab-to-next-line) not recoverable from minified binary; do not invent layout heuristics |
| 27 | `/model` picker "+1 model" count after scrolling to last model | PORT | added to model agent scope |
| 28 | `/keybindings` writes Backspace/Delete for dead footer action into keybindings.json | PORT | added to effort/keybindings agent scope |
| 29 | Rebound `footer:close` types "x" on agent-panel row | PORT | added to effort/keybindings agent scope |
| 30 | vim `.` not repeating fast/pasted text w/o bracketed paste; INSERT stuck after `cw`+Esc repeat | PORT | vim agent (H2) |
| 31 | vim cursor left on image-placeholder `[` after `dd` last line / `yy` at end | PORT | vim agent (H2) |
| 32 | Remote Control enable prompt: key on refocus answers before safety delay | NO-OP | Remote Control not in OCC |
| 33 | Workspace trust dialog re-appears after renderer switch/update when started in home dir | PENDING | misc agent forensics-only (permissions owned elsewhere) |
| 34 | rules symlinked into `.claude/rules` skipped without external-imports prompt; `.claude` dir symlink asks | PORT | P0-2② rules-symlink agent |
| 35 | Plugins pre-approving own tools via `allowed-tools` under managed `allowManagedPermissionRulesOnly` → official/vouched sources only | PORT | P0-2③ plugin agent |
| 36 | Failed first `plugin install` left plugin enabled+recorded on dep version-range failure | PORT | plugin agent (D) |
| 37 | Hook debug log: failed hook stderr kept when stdout also written; status code logged; no-output failures logged | PORT | misc agent (J) |
| 38 | Elicitation/ElicitationResult hooks `{"decision":"block"}` honored (declines elicitation) | PORT | MCP (M6) |
| 39 | Sessions without `SendMessage` tool still told to use it | PENDING | leftover agent (L2) |
| 40 | RC photo lost when queued message pulled into prompt; cursor off for captionless photo | NO-OP | Remote Control surface |
| 41 | Typing during usage-limit wait took wait out of "Continue automatically" setting's control | PENDING | misc agent (J) |
| 42 | Usage-limit warnings suggest `/upgrade` on highest Max plan → point at `/usage-credits` | PENDING | misc agent (J) |
| 43 | Explore subagent switches to Opus on unrecognized session model ID → inherits session model | PORT | robustness (R4) |
| 44 | `/loop` self-paced status updates only in reasoning → visible text | PENDING | leftover agent (L3) |
| 45 | `/ultrareview` worktree upload from desktop-created git worktree | NO-OP | OCC's /ultrareview = RemoteAgentTask cloud-session polling (remoteReviewFailure.ts) — no local working-tree upload path exists in OCC to fix |
| 46 | Sandboxed Bash fails on Linux: write-denied cwd containing read-denied dir | PENDING | leftover agent (L4) |
| 47 | Artifact DB write results: `data/users/` viewer-private wording; `as_level` "view" | NO-OP | artifacts trimmed in OCC |
| 48 | Gateway `431` for many-group IdP sign-ins → accept headers up to 256 KiB | NO-OP | gateway server-side |
| 49 | Usage-limit wait: state+countdown as one block under prompt; no repeated countdown | PENDING | misc agent (J) |
| 50 | "No such tool available" for prefix-less Chrome tools names the tool to call | PENDING | leftover agent (L5) |
| 51 | Monitor event rows show what each event printed; stop repeating unchanged "Waiting for N…" | PORT | misc agent (J); MONITOR_TOOL is LIVE |
| 52 | Workflow tool sandbox hardening: errors thrown by async script hooks | PORT | P0-2④ workflow agent; WORKFLOW_SCRIPTS LIVE |
| 53 | Startup time/memory: build only used parts of settings schema | STAGE | perf re-architecture of schema build; not byte-recoverable |
| 54 | `/claude-api` `hillclimb` round-efficiency; extra page single local file | NO-OP | OCC claude-api skill .md files are intentional stubs |
| 55 | `/tasks` `/copy` `/hooks` list details column alignment | PENDING | leftover agent (L6) |
| 56 | `marketplace add` says when it replaces same-name marketplace + how to undo | PORT | plugin agent (D) |
| 57 | Startup refusal under `forceLoginMethod`/`forceLoginOrgUUID` names credential, location, removal | PENDING | misc agent (J) |
| 58 | Auto-memory: invisible chars + markup-imitating tags neutralized in MEMORY.md/recalled notes | PORT | misc agent (J) |
| 59 | `claude remote-control` asks workspace trust on terminal instead of exiting | NO-OP | Remote Control surface |
| 60 | Artifact pages: design plan into page; use given name as title | NO-OP | artifacts trimmed |
| 61 | Artifact tool asks for right link/content on claude.ai links/artifact ids | NO-OP | artifacts trimmed |
| 62 | Interactive terminal + VSCode start in **auto mode** when no permission mode configured (all plans/providers); `permissions.defaultMode` overrides | PENDING | Gap-140c auto-mode agent — PORT per official semantics or STAGE with full reasons |
| 63 | Ultracode = own toggle in `/effort` (Tab, `/effort ultracode [on|off]`); no forced xhigh; stays at any effort | PORT | effort/ultracode agent |
| 64 | Mid-response dropped-connection retries share one budget with request retries | PORT | robustness (R5) |
| 65 | Sonnet safeguards notice explains why + offers edit/retry | PORT | robustness (R7) |
| 66 | Safety model switches with pinned Opus (`ANTHROPIC_DEFAULT_OPUS_MODEL`/`modelOverrides`): API picks switch target per flag kind | NO-OP | switch target selection is API-server-side; the client-side companion (`switchModelsOnFlag` gate + refusal-fallback-suppression telemetry `no_dialog_host_setting_off`/`no_consumer_capability_setting_off`/`remote_controlled_session_setting_off`) is a subsystem OCC never had (0 hits in src/) — recorded as subsystem gap §5, out of 284-delta scope |
| 67 | Non-interactive first turn waits ≤2s for `--allowedTools`/`mcp_tool`-hook-named servers even when `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0` | PORT | MCP (M5) |
| 68 | `/recap` declines when relayed from chat thread/routine/webhook | PENDING | leftover agent (L7) |
| 69 | `/artifacts` filter tabs beside title (All/Mine/Shared) | NO-OP | artifacts trimmed |
| 70 | Artifact publishing refuses network-share files unless `--add-dir` mapped drive | NO-OP | artifacts trimmed |
| 71–88 | [VSCode] ×18 (timestamps, plugin load errors, Ultracode switch, Memory reload, restored tabs, Focus view, /model usage text, /feedback on 3P, Python-ext wait, Restart Extensions, raw-XML sender, agent messages reload, command shadowing, Escape bg agents, install links, post-compaction attachments, non-ASCII links, CLAUDE_CONFIG_DIR absolute-only) | NO-OP | OCC ships no VSCode extension |
| 89 | [Cloud sessions] routine Edit/Duplicate offline messaging | NO-OP | cloud surface |
| 90–99 | [Claude Tag] ×10 (model family choices, org spend projection, GHE underscore host, silent-channel notice, sign-in notice per mention, Notify members, runner wait notice, channel-manager error, access lists, repo admin sign-in) | NO-OP | Slack/Tag surface not in OCC |
| 100 | [Code Review] retries posting finished review when unsubmitted App review open | NO-OP | GitHub App cloud service |

(PENDING verdicts are finalized in §1b as agent reports land; this table is the working triage, not the final word. **Round close: the Verdict column records DISPATCH ASSIGNMENTS, not outcomes — see §1b for what actually landed.**)

## §1b Finalized verdicts (round close, 2026-09-30)

Two events shaped the round: the §8 dispatch cancellation destroyed OCC-141's cluster work, and **the parallel OCC-101 round** (merged to origin/main as 12d0f2b + a967d0f, ledger `docs/upstream-version-gap-occ101-2026-09.md`) independently landed most of 2.1.284 — while OCC-141 re-ported the same P0 series byte-equivalently on this branch. At reconciliation, OCC-141 **dropped its duplicate implementation** (fast-forwarded to main) and kept only the genuinely additive delta. Final shipped state (v2.1.360 = origin/main + OCC-141 delta):

**Landed via OCC-101 (on main before this branch merged):**
- Bullet 1 — Sonnet 5.5 launch series (§2), complete: catalog entry + alias + canonicalization (longer-id-first) + [1m] + COST_TIER_2_10 + effort/betas/advisor/commitAttribution + VERTEX_REGION_CLAUDE_5_5_SONNET + prompts + claude-api skill var table + picker rows (Sonnet 5.5 default row, NEW Sonnet 5 previous-gen row, Sonnet 4.6 → Legacy) + `sonnet` alias default flip; per-provider defaults unchanged. Tests: their sonnet55Launch284.test.ts (395 lines, ELF-offset-cited).
- Bullet 19 — ANTHROPIC_FOUNDRY_RESOURCE validation (§3.1): client-construction guard in `getAnthropicClient` (client.ts), byte-verbatim official message + regex, foundryResourceGuard284.test.ts.
- Bullet 38 — elicitation hook exit-2 blocked surfacing (hooks.ts + elicitationHookBlocked284.test.ts).
- CLAUDE.md memory-rules walker escape/depth hardening (OCC-101 item 2; adjacent to bullets 34/58 territory, distinct mechanism).
- Keybinding-customization gate default TRUE → /help row live (OCC-101 item 12 = §5 Gap-140d — no longer staged).
- Version refs: README badge/prose/table/dev-note + cli.tsx dev-polyfill VERSION → 2.1.284 (a967d0f).

**Landed via OCC-141 (this round's shipped delta):**
- Bullet 5 — `/rate-limit-options`: description → "Manage usage limits and upgrade options" + `isHidden` REMOVED (byte evidence in file header comment; NOT covered by OCC-101; subscriber gate unchanged).
- CLAUDE.md:60 tracked-version prose → 2.1.284 (missed by a967d0f's sweep).
- Test hygiene fix: OCC-101's sonnet55Launch284.test.ts triggered a real (memoized) `ListInferenceProfiles` fetch in its five bedrock-env blocks — offline, its credential resolution hangs the module-level `sequential` queue and starves bedrockRegionPrefix.test.ts's beforeEach drain (4 × 5 s timeouts in shared-process directory sweeps; invisible under ci-test.sh's per-file process isolation, so main's CI was green). Fixed with a file-wide `getBedrockInferenceProfiles` mock + afterAll restore, matching that file's existing auth/settings mock discipline. Directory sweep green: 270 pass / 0 fail.
- This ledger — the 100-bullet triage (wider than OCC-101's 16-item scope) plus the DEFERRED lists below for the next round.

**DEFERRED to the next round (lost in §8 AND not covered by OCC-101 — NOT present, do not assume):**
- Agent-assigned PORTs: bullets 4, 6, 10–15, 17, 21, 23, 27–31, 36, 37, 43, 51, 56, 58, 63–65, 67. (Bullet 38 and the keybindings-gate piece of 28/29 landed via OCC-101; concrete keybinding bugs 28/29 remain open.) Dispatch transcripts gone; the /tmp/cc-diff-284 corpus remains valid for re-triage from the §1 table.
- Bullets 2 + 62 (Gap-140c auto-mode, §4.1): STAGE-grade — official migration v12→v14 semantics are not byte-recoverable from strings; bumping `CURRENT_MIGRATION_VERSION` (src/main.tsx:341, =11) blind risks corrupting user-config migration. Dedicated forensics round required.
- PENDING bullets 16, 33, 39, 41, 42, 44, 46, 49, 50, 55, 57, 68: untouched.
- §3.2 (bullet 34 rules-symlink approval dialog), §3.3 (bullet 35 plugin allowed-tools), §3.4 (bullet 52 workflow sandbox): binary strings recorded but ports need component/permission-level decompilation not performed — deferred rather than invented.
- STAGE bullets 18, 24, 25, 26, 53 remain STAGE; NO-OP verdicts unchanged (surface absent in OCC).

**Dropped as duplicate at reconciliation** (preserved only in this ledger's history + the branch stash, not shipped): OCC-141's own 19-file Sonnet 5.5 implementation, src/utils/foundryResource.ts + foundryResource284.test.ts, and its own sonnet55Launch284.test.ts (36 assertions) — main's accepted OCC-101 equivalents win.

## §2 P0-1 Sonnet 5.5 launch series (bullet 1) — **LANDED via OCC-101 (§1b)**

Mirror of the OCC-35→37 Opus-5 precedent. Verbatim binary evidence (284 ELF, byte-extracted; `claude-sonnet-5` entry byte-identical 283↔284 — purely additive):

- Catalog entry `claude-sonnet-5-5`: family sonnet, display_name "Sonnet 5.5", knowledge_cutoff "June 2026", provider_ids {first_party/vertex/foundry/anthropic_aws/anthropic_google_cloud/gateway: `claude-sonnet-5-5`, bedrock: `us.anthropic.claude-sonnet-5-5`, mantle: `anthropic.claude-sonnet-5-5`}, eager_input_streaming {bedrock,vertex}, `vertex_region_env_var:"VERTEX_REGION_CLAUDE_5_5_SONNET"`, `fallback_3p:"claude-sonnet-5"`, context {window 1e6, native_1m, native_1m_3p {bedrock,vertex,foundry}, supports_1m_beta}, max_output_tokens {default 128000, upper 128000}, pricing `tier_2_10`, capabilities ["effort","max_effort","xhigh_effort","adaptive_thinking","mid_conv_system","context_management","rejects_disabled_thinking","per_turn_effort","lean_prompt","refusal_fallback","silent_turn_reminder","org_locked_thinking"], default_effort "medium", image_limits 2000×2000, advisor_rank 3.
- Defaults: sonnet `default:"claude-sonnet-5"` → `"claude-sonnet-5-5"`; **per_provider UNCHANGED** (bedrock/vertex/foundry/mantle stay `claude-sonnet-4-5`; anthropic_aws/gateway stay `claude-sonnet-4-6`).
- `latest_per_family`: sonnet → `claude-sonnet-5-5` (fable 5-1, opus 5-5, haiku 4-5 unchanged).
- Registry `ere` = 21 ids (adds `claude-sonnet-5-5`).
- Alias pair `["sonnet-5-5","claude-sonnet-5-5"]` inserted BEFORE `["sonnet-5","claude-sonnet-5"]`; `claude-sonnet-5-5[1m]` suffix string exists.
- Canonicalization: `includes("claude-sonnet-5-5")` check BEFORE `includes("claude-sonnet-5")`.
- Refusal-fallback arm: `if(e==="claude-sonnet-5-5"||e==="claude-sonnet-5-5[1m]")return $2;` (order: opus-5-5→B2, opus-5→F2, sonnet-5-5→$2, default N2).
- Telemetry short-name: `"claude-sonnet-5-5":"sonnet55"`.
- claude-api skill: `SONNET_ID:"claude-sonnet-5-5"`, `SONNET_NAME:"Claude Sonnet 5.5"`, `PREV_SONNET_ID:"claude-sonnet-5"`, `PREV_SONNET_NAME:"Claude Sonnet 5"`.
- `tier_2_10` pricing {input:2, output:10, cache_write_5m:2.5, cache_write_1h:4, cache_read:0.2, web_search:0.01} — byte-identical 283→284 (tier existed; new model maps onto it).
- Vertex region env table: `["claude-sonnet-5-5","VERTEX_REGION_CLAUDE_5_5_SONNET"]` after the 4-6 entry.
- **Picker caveat**: NO `name:"Sonnet 5.5"` picker-row string exists anywhere in the 284 binary (only `display_name`); baked picker lists still show `{id:"claude-sonnet-5",name:"Sonnet 5",…}`. Picker-row treatment must follow binary evidence, not invention — careful/STAGE per site.

OCC landing sites (audit list; the shipped OCC-101 implementation covers this same file set — commit 192697f): `src/utils/model/configs.ts` (catalog), `context.ts` (max-tokens registry), `model.ts` (`getDefaultSonnetModel` flip + canonicalization order + alias), refusal-fallback table, `modelCost.ts` (firstPartyNameToCanonical), telemetry short-names, `src/skills/bundled/claudeApiContent.ts`, `ModelPicker.tsx`/`MessageModel.tsx` (highlight-newest + rows per evidence), effort/thinking/betas/advisor allowlists, ~30 files referencing bare `claude-sonnet-5` (audit each: default-flip sites vs pinned-version sites).

## §3 P0-2 security fixes (bullets 19, 34, 35, 52)

<!-- per-agent evidence + before→after lands here -->

### §3.1 ① ANTHROPIC_FOUNDRY_RESOURCE validation (bullet 19) — **LANDED via OCC-101**
Binary-verbatim: validator regex `/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/i` (`Ixr`), sanitize-or-undefined `lf()`, base-URL builder `Ry()` now validates before interpolating `https://${e}.services.ai.azure.com`; startup throw with exact message: "ANTHROPIC_FOUNDRY_RESOURCE must be a Foundry resource name (2-64 letters, digits and hyphens, not starting or ending with a hyphen, such as my-resource), not a URL or host name. To use a full URL, set ANTHROPIC_FOUNDRY_BASE_URL instead."
Shipped implementation (OCC-101, origin/main): guard in `getAnthropicClient` (`src/services/api/client.ts` @ v284 `Ixr` 203883609 + guard 203891512) — throws only when RESOURCE is set, BASE_URL is unset, and the regex fails; message byte-verbatim; tests `src/services/api/__tests__/foundryResourceGuard284.test.ts`. OCC-141's parallel `src/utils/foundryResource.ts` variant was semantically equivalent and dropped as duplicate at reconciliation.

### §3.2 ② .claude/rules + .claude symlink external-imports approval (bullet 34) — **DEFERRED (§1b)**
Binary-verbatim new 284 string: "This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for third-party repositories."; dialog title "Allow external CLAUDE.md file imports?", severity warning, "External imports:", "… +N imports not shown.", "Yes covers those too, plus any this project adds later.". OCC gate is 282-era `shouldRefuseMemorySymlink` (src/utils/claudemd.ts:845) which REFUSES silently — official 284 asks for approval instead. Port needs the approval-dialog component + decision plumbing, not string-recoverable; deferred rather than invented.

### §3.3 ③ plugin allowed-tools self-pre-approval tightening (bullet 35) — **DEFERRED (§1b)**
Lost in §8 cancellation; vouched-source gate mechanism not byte-recovered.

### §3.4 ④ Workflow sandbox async script hooks hardening (bullet 52) — **DEFERRED (§1b)**
Lost in §8 cancellation; async-hook error-throwing semantics not byte-recovered.

## §4 P1 clusters

### §4.1 Gap-140c auto-mode default migration (bullets 2, 62) — **DEFERRED / STAGE (§1b)**
occ140 §5 baseline: official fresh-HOME runs migrations to v14 and boots auto mode; OCC `CURRENT_MIGRATION_VERSION = 11` (src/main.tsx:341), boots manual. Not landed this round: the official v12/v13/v14 per-migration semantics are not byte-recoverable from the strings corpus (migration functions are minified closures over config shapes, not strings), and bumping the version constant without them would replay/skip real user-config migrations blind. Dedicated forensics round required.

### §4.2 Query robustness cluster (bullets 10-14, 43, 64, 65) — **DEFERRED (§1b, lost in §8)**

### §4.3 MCP cluster (bullets 6, 15, 17, 40[Elicitation], 67 + F5 carry-over) — **DEFERRED (§1b, lost in §8)**
Bullet 38 (elicitation hook exit-2 blocked surfacing) LANDED via OCC-101 item 4 (hooks.ts + elicitationHookBlocked284.test.ts) — removed from this cluster's open set.
F5 (occ138 §6.3): `mcp add/remove` silent config-write failure — remains open, re-assign next round.

### §4.4 vim fixes (bullets 30, 31) — **DEFERRED (§1b, lost in §8)**

### §4.5 effortSlider + Ultracode toggle (bullets 4, 63) + keybindings fixes (28, 29) — **DEFERRED (§1b, lost in §8)**
Note: the keybinding-customization *gate* piece (Gap-140d, §5) landed via OCC-101 item 12; the two concrete keybinding bugs 28/29 remain open.
Binary-verbatim evidence retained for next round: `effortSlider:decreaseEffort/increaseEffort/toggleUltracode`; `/effort` usage `|ultracode [on|off]` conditional; slider row "ultracode" color `#d0b4ff`; help "Enable ultracode for the session: standing dynamic-workflow orchestration at any effort level."; app-state `ultracode` independent boolean (`getLiveUltracode`); statusline `${h}${M?" · ultracode":""} · /effort`; `apply_flag_settings: ultracode is not available for this session (` …; `ultra_effort_enter/exit`.

### §4.6 Misc portables (bullets 21, 37, 41, 42, 49, 51, 57, 58, 33-forensics) — **DEFERRED (§1b, lost in §8)**

### §4.7 Leftover portables (bullets 16, 39, 44, 46, 50, 55, 68) — **DEFERRED (§1b, lost in §8)**

## §5 Carry-overs & known-red

- **F5** mcp add/remove silent failure (occ138 §6.3) — assigned to MCP agent this round.
- **Nudge probe file dedup** (occ140 §10, P3) — merge duplicate probe fixtures between `test/e2e/version-2.1.283-thinking-only-nudge.e2e.test.ts` and `version-2.1.283-nudge-statemachine-wiring.e2e.test.ts` without losing assertions.
- **Effort-cap ⑥ known-red** belongs to OCC-82 — do NOT touch.
- Gap-140b (request assembly/cache topology), Gap-140e P3 set — remain staged per occ140 §5 unless 284 evidence changes the picture. Gap-140d (`/keybindings to customize` statsig gate) — **LANDED via OCC-101 item 12** (gate default TRUE, /help row live); no longer staged.

## §6 Version-ref sync + release

- Version refs → 2.1.284: README badge/prose/table/dev-note + `src/entrypoints/cli.tsx` dev polyfill VERSION landed via OCC-101 acceptance fix (a967d0f); CLAUDE.md tracked-version prose landed via OCC-141 (missed by a967d0f).
- CI gate: `bun run build` then `CI=true bash scripts/ci-test.sh` green → push main.
- e2e: REPL tmux + live model; **projectDir NEVER inside agent workdir or any CLAUDE.md-containing tree** (occ140 §9 hardened rule).
- Release v2.1.360 executed directly by OCC Leader per this issue's 不派发子 issue discipline: security review inline (no backdoors in the shipped delta) → merge to main → chore(release) version bump → tag v2.1.360 → publish.yml → verify /releases ≡ /tags → report link on OCC-141.

## §7 Test baseline

Full `bun test src` baseline: 5737 pass / **73 pre-existing fails** / 1 skip. CI gate = `CI=true bash scripts/ci-test.sh` (needs `bun run build` first).

## §8 Incident-prevention notes (this round)

- First dispatch was cancelled server-side mid-flight (7 agents stopped, zero edits persisted; /tmp/cc-diff-284 forensics survived). Re-dispatch resumed all 7 from transcript + launched 5 more clusters. Checkpoint commits land locally as reports integrate.
- **Round close (reconciled):** the re-dispatched cluster work was also lost before integration (see §1b DEFERRED lists). The Leader salvaged bullets 5 + 19 and directly re-ported bullet 1 (Sonnet 5.5 series) — then discovered the parallel OCC-101 round had already landed equivalent (accepted, acceptance-fixed) implementations of bullets 1/19/38 on origin/main. At reconciliation the Leader fast-forwarded to main, dropped the duplicate implementation, and kept only the additive delta (bullet 5, CLAUDE.md fix, this ledger, the bedrock test-hygiene fix). Next round should re-triage from §1 using the surviving /tmp/cc-diff-284 corpus before it is garbage-collected — copy it into the repo or re-extract early. **Coordination lesson:** two rounds triaging the same upstream version in parallel burned a full duplicate P0 port; check origin/main for in-flight ledger docs (docs/upstream-version-gap-*) BEFORE dispatching.
- Lesson (test hygiene): provider-env tests that hit `getModelStrings()` with null bootstrap state can enqueue a REAL background bedrock profile fetch that hangs the shared `sequential` queue across test files in the same worker. Seed bootstrap state (or mock `getBedrockInferenceProfiles`) before asserting under `CLAUDE_CODE_USE_BEDROCK`.
