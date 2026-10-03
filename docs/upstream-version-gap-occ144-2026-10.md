# OCC-144 Upstream Version Gap Ledger — Claude Code 2.1.286 → 2.1.287 (2026-10)

**Round**: OCC-144 (issue `6067a265-1eed-4124-a17f-583474d036d9`), executed 2026-10-03 by OCC 程序员 (version catch-up, autopilot-triggered).
**Tracked-upstream pointer**: 2.1.286 → **2.1.287** (this round). OCC release: **2.1.367** (from 2.1.366 — see the cross-round addendum below; 2.1.366 was the parallel OCC-105 round's release).

## 0. Cross-round addendum — the parallel OCC-105 round (discovered at merge time)

While this round was running, a **parallel round (OCC-105, ledger `docs/upstream-version-gap-occ105-2026-10.md`)** performed its own 2.1.287 catch-up, merged to main and cut release commit `69d3709` (**2.1.366**) on 2026-10-02 — but **never pushed the `v2.1.366` tag**, so 2.1.366 never published to npm (remote tags/releases end at v2.1.365; npm latest = 2.1.365 as of 2026-10-03T07:55Z). This round therefore:

1. **Merged origin/main into this branch** and deduplicated: the two rounds **independently byte-verified and ported the same #44 revoked-OAuth-token fix** (convergent validation — both recovered the official `PZ` predicate and `Q3n` message; OCC-105 cites `PZ` @198284746, this round @200866142 — different extraction windows of the same function, semantics identical). The **OCC-105 `errors.ts` implementation is canonical** (inline widened predicates at both sites + the print-mode message, with its own test file `revokedTokenLogin287.test.ts`); this round's duplicate `errors.ts` edits and its redundant test file `oauthTokenRevoked287.test.ts` were **dropped at merge resolution**.
2. **Kept this round's complementary delta**: OCC-105 did NOT widen `src/services/api/withRetry.ts`'s local `isOAuthTokenRevokedError` mirror (still 403-only on main). Since the official `PZ` is a **single shared predicate at ALL call sites**, this round's widening (byte-verified @200866142, JSDoc-cited) is a genuine parity fix — behaviorally neutral at OCC's current call sites (every revoked-401 already flows through the plain-401 arms first: `withRetry` lines 491/499 OR it with a bare 401 check, `isCredentialRenewalError` returns true for any 401, `credentialRenewalEligible`'s leading `!(401)` term, and `shouldRetry`'s 401 branch precedes the predicate) but keeps the mirror equivalent for future call sites.
3. **Completes the stranded release chain**: tag `v2.1.366` at OCC-105's release commit `69d3709` (publishes the announced 2.1.366 to npm), then this round's docs/parity release as **`v2.1.367`**.
4. **Status corrections from the OCC-105 changelog** — these entries in §2 below were dispositioned by this round BEFORE the merge was visible; OCC-105 actually landed them (statuses superseded to **PORTED via OCC-105**): #6 (OTEL `prompt_text`), #8 (Windows Bash-deny→PowerShell warning — this round had it NO-OP PLATFORM; OCC has the surface after all), #12 (`asyncRewake` missing-script report-once), #16 (Fable `/model` alias save), #24 (plain-language Bash permission prompts — the "Contains simple_expansion" fix), #27 (JSON/line-shape-aware large-MCP-result guidance), #35 (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` structured-output gate), #37 (`--include-partial-messages` synthetic `content_block_stop`/`message_stop`), #42+#51+#70 (reduce-motion/`/desktop` cause/light-theme contrast), #48 (marketplace http transport — this round guessed ALREADY-ALIGNED from the `gitUrlValidation.ts` allowlist; OCC-105 landed the official "transport 'http' not allowed" https/ssh-only refusal with a real git-http-backend A/B harness — **this round's guess was wrong, corrected**), #61 (piped-stdin startup guard — same NO-OP PLATFORM correction as #8), #85 (`alwaysLoad:false` defers tools behind tool search), #29/#33/#36 (screen-reader sign-in cursor / diff changed-lines / borderless search boxes — partial). The remaining STAGED items (incl. the §3 security P0s #19/#26/#80/#83/#41/#88/#47) are NOT in OCC-105's changelog and stay STAGED for the next round.
**Official channel state at round time** (npm `dist-tags`, fact-checked 2026-10-03): `stable=2.1.285`, `latest=next=2.1.288`. Publish times: 2.1.286 → 2026-09-30T17:14Z, 2.1.287 → 2026-10-01T16:59Z, **2.1.288 → 2026-10-02T18:30Z** (promoted to `latest` DURING this round — at round start `latest` was 2.1.287, per the OCC-104 §8 pre-triage).
**Per directive + convention**: this round aligns to **2.1.287** (the byte-forensics target). **2.1.288 gets pre-triage STAGE only** (§5) — no forced alignment this round; it is the next round's top priority.

## Method

- Binaries: `@anthropic-ai/claude-code-linux-x64@2.1.286` (241,667,256 B) and `@2.1.287` (244,317,368 B), unpacked to `/tmp/cc-diff-287/{v286,v287}/package/claude`. **Never executed** — analysis used only `strings -n 8`, `grep -aobF` byte offsets + `dd bs=1 skip=N count=M`, and `comm` on sorted string dumps (`s286.txt`/`s287.txt`/`new287.txt` [19,730 new lines]/`del287.txt` [15,962]). Code region = offsets > ~195 MB; the ~98–103 MB region is string-table/bytecode blob. v286→v287 offsets drift ~+1.94 MB near 200 MB, up to ~+2.65 MB deeper (binary grew +2,650,112 B); minified identifier renames between versions require structure-based (not name-based) matching.
- Changelog: 106 bullets for 2.1.287 (numbered **#3–#108** below, matching `changelog-287.md` line numbers, source `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`).
- Porting rule (`aligning-with-official-binary`): port only byte-verified official code; STAGED-with-rationale is success, invented code is failure.
- Statuses: **PORTED** (landed this round, tests green) · **PORTED(partial)** (core landed; named sub-pieces STAGED) · **STAGED** (real surface or real gap, but needs per-site decompilation/decision/subsystem work — nothing invented) · **NO-OP** (PLATFORM = other-product surface OCC does not ship; NO-SURFACE = feature absent/trimmed from OCC; ALREADY-ALIGNED = OCC already matches).
- **Round-scope note (honest)**: this round's binary forensics went byte-deep on the **revoked-OAuth-token cluster only** (#44). The remaining 105 entries are dispositioned at **changelog-triage level** (surface-presence confirmed by grep where a security/OCC-relevant site was checked); none were byte-drilled, so none are claimed PORTED. This is a bounded "targeted small port + full triage" round — three prior run sessions on this issue died mid-forensics, so the discipline is: land the one fully-verified fix, disposition the rest honestly, ship, and hand 2.1.288 + the STAGED backlog to the next round rather than risk invented code.

## Summary counts (106 entries, #3–#108)

| Status | Count |
|---|---|
| PORTED | 1 |
| STAGED | 41 |
| NO-OP (PLATFORM) | 43 |
| NO-OP (NO-SURFACE) | 15 |
| NO-OP (ALREADY-ALIGNED) | 6 |

The single PORTED item is the #44 revoked-OAuth-token fix (a §8-security item from the OCC-104 pre-triage). The other 7 OCC-104 §8 security items are STAGED with per-site rationale (§3).

## 1. PORTED — revoked-OAuth-token cluster (#44)

**#44** — *"Fixed a revoked claude.ai login showing a generic `API Error: 401` instead of 'OAuth token revoked'; in `-p` mode the error now starts with 'Failed to authenticate'."* → **PORTED** (byte-verified; first landed on this branch as `8949b28`, then deduplicated at merge in favor of the parallel OCC-105 `errors.ts` implementation — see §0; this round's surviving code delta is the `withRetry.ts` mirror widening).

Two byte-verified deltas recovered from the official 2.1.287 linux ELF (both rounds recovered the same two independently):

**(a) Predicate widened 403-only → 403 ∪ 401.** Official renamed the shared revoked-token predicate `X7`→`PZ` and added the 401 form. v286 `X7` @198922605:
```js
function X7(e){return e instanceof It&&e.status===403&&(e.message?.includes("OAuth token has been revoked")??!1)}
```
v287 `PZ` @200866142:
```js
function PZ(e){if(!(e instanceof xt))return!1;let r=e.message??"";
  return e.status===403&&r.includes("OAuth token has been revoked")||
    e.status===401&&r.includes("OAuth access token has been revoked")}
```
Newness proof: `"OAuth access token has been revoked"` → **zero hits in v286**; v287 hits @102012624 (string table) + @200866303 (inside `PZ`). The old 403 string survives at 5 sites in BOTH versions (the retry-wrapper `withOAuth401Retry` @v286 199173020 / @v287 201120899 and the org-status fetch @v286 199325880 / @v287 201275267 are **byte-identical modulo minified renames** — verified by `dd` window extraction; those two axios sites are NOT part of the delta and OCC's `src/utils/http.ts` `withOAuth401Retry` + `src/utils/fastMode.ts` stay as-is). `PZ` replaced `X7` at ALL call sites (single shared identifier), so every consumer of the predicate widens identically.

**(b) Print-mode message changed.** Official message fn renamed `aYn`→`Q3n`. v286 `aYn`:
```js
function aYn(){return ke()?"Your account does not have access to Claude. Please login again or contact your administrator.":Rst}
```
v287 `Q3n` @207163766:
```js
function Q3n(){return ke()?"Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.":Elt}
```
`ke()` = print-mode (`-p`) predicate (same name both versions); `Elt`/`Rst` = `"OAuth token revoked \xB7 Please run /login"` (the interactive string, unchanged). Newness proof: `"Failed to authenticate: OAuth token revoked"` → zero v286 hits; v287 @98564528 + @207163785.

OCC port (final merged state): `src/services/api/errors.ts` — the two inline 403-only sites (the `getAssistantMessageFromError` classifier + the `token_revoked` type resolver) widened to the full `PZ` shape and `getTokenRevokedErrorMessage()`'s non-interactive branch switched to the explicit revoked wording, interactive branch keeps `TOKEN_REVOKED_ERROR_MESSAGE` (`'OAuth token revoked · Please run /login'`) unchanged (**OCC-105's implementation, canonical**; this round's equivalent port via an exported `isOAuthTokenRevokedAPIError` helper was dropped at merge as a duplicate). `src/services/api/withRetry.ts` — the local `isOAuthTokenRevokedError` mirror widened to the identical `PZ` shape (**this round's surviving delta**; OCC-105 left it 403-only). All 5 withRetry consumers are positive checks (retry classification, credential-renewal arms) and each already handles plain 401s first, so the widening is behaviorally neutral today and matches the official shared-predicate semantics.

Tests: the canonical coverage is OCC-105's `src/services/api/__tests__/revokedTokenLogin287.test.ts` (predicate arms + negative controls + print-mode message through the public classifiers). This round's independent `oauthTokenRevoked287.test.ts` (10 tests / 13 expects — 403-old ✓, 401-new ✓, embedded ✓, cross-wired status/message ✗, unrelated-403 ✗, non-APIError ✗; print-mode explicit wording ✓, not-old-generic ✓, interactive short prompt ✓) passed against this round's implementation pre-merge and was **removed at merge resolution as redundant**. Pre-merge full `src/services/api/` suite with it: **380 pass / 0 fail / 1286 expect()** across 27 files.

## 2. Per-entry triage (#3–#108)

### Large new surfaces — STAGED (need dedicated rounds)

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 3 | Claude Mods: plugins may modify deeper behavior | STAGED (NO-SURFACE-ish) | OCC ships **zero bundled workflows/plugins** by design (CLAUDE.md OCC-31); "Mods" is a new plugin-capability tier with no OCC consumer. Needs a dedicated design round if OCC ever grows a mod surface. |
| 4 | Built-in `cc-plugin-you-should-know` mod (side agent) | NO-OP (NO-SURFACE) | Bundled-plugin/mod — OCC ships none (OCC-31). |
| 5 | Agents-view `n:<text>` filter (session names/tasks) | STAGED | OCC has an agents/daemon view (`occ agents`); the filter is a UI feature needing per-site decompilation of the official agents-view reducer. |
| 6 | OTEL `user_prompt` gains `prompt_text` copy for dotted-key backends | STAGED | OCC telemetry surface exists but the OTEL `user_prompt` span shape needs byte-verification of the official emitter before adding a duplicated field. |
| 7 | MCP URL prompts (2025-11-25 protocol) / `bareElicitationCapability` | STAGED | MCP elicitation is a trimmed OCC surface; protocol-version bump + elicitation capability needs a dedicated MCP round. |
| 85 | MCP `alwaysLoad:false` defers tools behind tool search | STAGED | Interacts with OCC's `EXPERIMENTAL_SKILL_SEARCH`/tool-search; needs per-site decompilation. |

### Security cluster (OCC-104 §8 carryover — top priority)

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 44 | Revoked claude.ai login → "OAuth token revoked" / `-p` "Failed to authenticate" | **PORTED** | See §1 — byte-verified, tested, committed. |
| 19 | Dangerous `rm` (on `/`/`$HOME`) loses always-ask when the same command redirects to a `~`/wildcard path | STAGED | **OCC-AFFECTED (likely)** — OCC has the full bash AST + legacy permission chain (`dangerousRmAutoDeny.ts`, `findCatastrophicSubstitutionBlock`, `pathValidation.ts`, 2.1.223 parity). The fix is a redirect-target × rm-target interaction buried in minified code (string-diff returns 380 KB of noise, no clean needle). Needs dedicated per-site decompilation of the official 2.1.287 redirect-target resolver before porting — not guessed. **Next-round P0.** |
| 26 | Org per-tool permission ceilings silently dropped for an MCP tool named `__proto__` | STAGED | OCC already rejects `__proto__` as a reserved MCP **server** name (`src/services/mcp/config.ts:1727–1736`), but this fix is the **per-tool permission-ceiling map** construction (prototype-key lookup dropping the entry) — a different site. Needs byte-verification of the official ceiling-map builder; OCC's ceiling surface must be located first. **Next-round P0.** |
| 80 | Shell write through a repo-committed symlink onto a sensitive file / out of the working tree → name target + wait for human (now `~` targets too) | STAGED | OCC has symlink/path validation (`pathValidation.ts`); the `~`-target extension needs per-site decompilation of the official symlink-resolution guard. **Next-round P0.** |
| 83 | Whole-tool `Bash` allow rules / allowing hooks must PROMPT (not run) for shell writes to files the file tools refuse outright (profile store, host credentials file) | STAGED | Permission-integrity fix; OCC has the bash allow-rule + hook allow path. Needs byte-verification of the official "file-tools-refuse-outright" target set + the prompt-not-run gate. **Next-round P0.** |
| 41 | Sandboxed Bash on Linux inheriting an open handle on the Claude Code executable | STAGED | fd-leak in the sandbox spawn (`sandbox-runtime`); OCC uses the same runtime family. Needs per-site decompilation of the official spawn fd-closing logic; ambiguous without it. |
| 24 | Bash permission prompts showing internal parser names ("Contains simple_expansion") instead of a plain explanation | STAGED | Cosmetic-but-user-facing. OCC's `simple_expansion` is a tree-sitter node type (`ast.ts:424`); the fix is in the official's permission-prompt reason formatter (not `prompt.ts` — grep found no raw-node-name surfacing there). Locate the official reason-string builder + byte-verify the human-readable replacement before porting. |
| 47 | `/feedback`+`/bug` pre-filled GitHub issue no longer includes recent error messages (data-exposure trim); confirmation screen lists them | STAGED | Data-exposure trim. OCC `/feedback` is post/telemetry-only with **no GitHub-issue pre-fill bundle path** (per OCC-104 #23 — structurally cannot reproduce the leak), but the confirmation-screen listing is a real surface; verify OCC's `/feedback` shape before dispositioning ALREADY-ALIGNED vs STAGED. |
| 88 | Waiting permission prompts show oldest-first (new prompt no longer covers the one being read; countdown prompts still open on top) | STAGED | Permission-queue ordering UX. OCC has a permission prompt queue; the ordering comparator needs byte-verification (oldest-first + countdown-on-top exception). |

### Model / context / provider cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 14 | Bedrock/Vertex startup model checks ignoring enforced `availableModels` → `/model` collapsing to one Opus row | STAGED | Provider-specific model-availability check; needs per-site decompilation. |
| 16 | Picking Fable in `/model` on claude.ai login saving the current version's id (should follow newest Fable) | STAGED | Model-id save semantics; verify against OCC's `/model` picker save path (OCC-36/37 aligned the picker rows). |
| 17 | Switching Opus 5.5 ↔ Sonnet 5.5 rewriting earlier MCP tool announcements (could drop extended thinking) | STAGED | Deep streaming/announcement interaction; needs dedicated decompilation. |
| 23 | `/advisor` pairing: Sonnet 5.5 advises Opus 4.7/4.8; API-refused advisors flagged up front | STAGED | OCC's advisor allowlist was aligned in OCC-37 (1g); this pairing-matrix change needs byte-verification. |
| 81 | Opus 4.7+/Fable → 1M context default on Bedrock/Vertex/Foundry/gateway, no `[1m]` suffix (`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` keeps 200K) | NO-OP (ALREADY-ALIGNED, partial) | OCC already defaults Opus/Sonnet to 1M (`configs.ts:174/202`, `modelSupports1M`, `contextWindowUpgradeCheck.ts`, `CLAUDE_CODE_DISABLE_1M_CONTEXT` honored). The per-provider (Bedrock/Vertex/Foundry) no-`[1m]`-suffix default needs confirmation but OCC's 1M path is live — verify-next-round, no gap expected. |
| 87 | Automatic model switches after a flagged message keep current effort level (not new model's default) | STAGED | Effort-preservation on auto-switch; needs per-site decompilation of the official switch handler. |
| 62 | Bedrock/Vertex/Mantle: model checks under `CLAUDE_CODE_SKIP_*_AUTH` sending a different `Authorization` header when `ANTHROPIC_CUSTOM_HEADERS` repeats it | STAGED | Provider auth-header edge; needs byte-verification. |
| 66 | Claude apps gateway error when Bedrock rejects a model ID (names the unavailable model + logs the sent ID) | NO-OP (PLATFORM) | Claude-apps-gateway surface — not an OCC product path. |
| 18 | Bedrock Guardrails mid-response blocks ending turn with API error instead of guardrail message when reply began with thinking | STAGED | Bedrock-specific streaming guardrail handling; needs per-site decompilation. |

### `-p` / SDK / headless / streaming cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 20 | `claude -p`/SDK repeating a model fallback on every later message after a mid-reply model switch | STAGED | Model-fallback latch in the print/SDK path; needs byte-verification (pairs with OCC-104 #11/#56 wiring). |
| 35 | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` not removing structured-output format from session-title/prompt-hook requests (Bedrock gateways reject) | STAGED | Beta-flag × structured-output interaction; needs per-site decompilation. |
| 37 | `--include-partial-messages` sending a cut-short reply's `message_stop` late/never | STAGED | Partial-message streaming; needs byte-verification of the official `message_stop` emit path. |
| 46 | `--output-format stream-json`/SDK not streaming turns of a `context: fork` skill run by typing `/<skill>` | STAGED | Fork-skill streaming; OCC's stream-json init set diverges by design (CLAUDE.md OCC-24) — needs careful per-site work. |
| 67 | SDK: message sent with priority "now" no longer cancels a running web fetch/search | STAGED | SDK priority-queue semantics; needs per-site decompilation. |
| 13 | Tool heartbeats not reaching SDK hosts while the response stream stalled | STAGED | SDK heartbeat transport; needs byte-verification. |
| 59 | Headless sessions reporting an MCP server as needing auth after one refused call (later calls succeed) | STAGED | Headless MCP auth-state latch; needs per-site decompilation. |
| 75 | MCP headless startup: transient first-connect failure retried without waiting for slowest server | STAGED | MCP connect-retry scheduling; needs byte-verification. |

### Resume / compaction / CLAUDE.md cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 21 | Folder's CLAUDE.md attached a second time after resume/compaction | STAGED | Pairs with OCC-104 #31; dedup logic needs byte-verification. |
| 28 | Commit-attribution reminder delivered inside a tool result after a compaction | STAGED | Attribution-reminder injection site; needs per-site decompilation. |
| 49 | Cloud sessions losing earlier conversation when restarted mid-compaction | NO-OP (PLATFORM) | Cloud-session surface. |

### MCP results / tools cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 27 | Claude told to page large MCP JSON results with Read offset/limit (cannot split one long line) | STAGED | MCP-result paging guidance; needs byte-verification of the official prompt text. |
| 52 | MCP connector tool call running twice / failing until restart when server changed protocol version | STAGED | Pairs with OCC-104 #24 cache-invalidation; protocol-version-change handling needs decompilation. |
| 78 | Large MCP tool results: less memory, smaller session files, no extra upload to count tokens | STAGED | Memory/stream rework of MCP-result handling; dedicated round. |

### Plugin / marketplace cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 48 | `marketplace add --sparse` / `git-subdir` failing with "transport 'http' not allowed" over plain http | NO-OP (ALREADY-ALIGNED, likely) | OCC's `gitUrlValidation.ts` already allowlists `http:` (line 65) + handles the http protocol (line 256). The `--sparse`/`git-subdir` install path is a trimmed OCC surface; no rejection expected. Verify-next-round. |
| 50 | Plugin reload overlapping startup `--plugin-url` download corrupting the cached archive | STAGED | OCC has `fetchPluginZip.ts` + zip-cache; the reload/download race needs per-site decompilation. |
| 53 | SessionStart hooks from synced plugins not running in new cloud sessions | NO-OP (PLATFORM) | Cloud-session plugin sync. |
| 64 | Marketplace errors say in plain words why a marketplace was ignored/refused | STAGED | Error-message UX; needs byte-verification of the official strings. |
| 65 | Plugin listings note uninstalled dependencies; update retries an unfinished install | STAGED | Plugin-dependency installer — OCC has none (OCC-104 #60 dependency-install half NO-OP). |

### UI / config / input cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 63 | `/config`: cycling settings show ‹ › + step both ways, narrow terminals stack value under label, PgUp/PgDn page | STAGED | `/config` UI polish; needs per-site decompilation of the official config renderer. |
| 68 | `/memory`: left/right arrows flip on/off settings (e.g. Auto-memory) | STAGED | `/memory` keybinding; needs byte-verification. |
| 69 | `/skill` names typed mid-message: Claude told they are skills (incl. `disable-model-invocation`) | STAGED | Prompt-injection of skill-name hints; needs per-site decompilation. |
| 70 | Contrast of prompt-input border in light themes + the ❯ before earlier messages | STAGED | Theme contrast; cosmetic, needs the official color values. |
| 73 | Held-message-from-another-session prompt shows the message between dashed lines | STAGED | Prompt-render consistency; needs byte-verification. |
| 74 | MCP/other tool permission prompts show the tool call between dashed lines (match file-edit prompts) | STAGED | Prompt-render consistency; needs byte-verification. |
| 42 | Running-tool dot + 3 spinners still moving with "Reduce motion" on; /rewind confirm updating "ago" while typing | STAGED | Motion-accessibility; needs per-site decompilation of the official spinner gate. |
| 25 | Fullscreen sessions on slow/busy machines exiting with "unrecoverable interface error" while a scroll key held | STAGED | Fullscreen/scroll stability; needs byte-verification of the official fix. |
| 84 | Right-click/middle-click paste happens on button release; moving away before release cancels | STAGED | Mouse-paste semantics (terminal input); needs per-site decompilation. |

### Screen-reader cluster (~8 entries — accessibility)

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 29 | Cursor away from typed text in search boxes (/resume, /permissions) + sign-in code fields | STAGED | Screen-reader cursor placement; OCC has a screen-reader mode — each needs per-site decompilation of the official AX announcements. |
| 30 | Refusing Enter with nothing typed on /rewind summarize (added context optional) | STAGED | Screen-reader /rewind input gate. |
| 31 | "Tab to amend" hint on approval prompts where Tab does nothing | STAGED | Screen-reader hint suppression. |
| 32 | Listing arrow keys that do nothing in /permissions + /mcp; "Select with numbers" in empty menus | STAGED | Screen-reader key-hint accuracy. |
| 33 | Leaving out changed lines in file-edit approval prompts / diffs | STAGED | Screen-reader diff announcement. |
| 34 | Re-sending `--teleport` progress + MCP form field to screen reader every spinner frame | STAGED | Screen-reader announcement debounce (`--teleport` is an OCC-trimmed surface — partial NO-OP). |
| 36 | Leaving out top lines of a second approval prompt / changed /config row / rejected-plan line when prev screen taller than window | STAGED | Screen-reader scroll-region announcement. |
| 43 | Times in `claude agents` changing every second in screen-reader mode → at most every 10s | STAGED | Screen-reader time-announcement throttle. |
| 86 | Write new/changed lines without pausing cursor at line start; `CLAUDE_AX_PREPARK_MS=50` restores pause | STAGED | Screen-reader pre-park env knob; needs byte-verification of the official AX writer. |

### Remote Control / cloud / cross-device cluster

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 11 | Remote Control not receiving messages for minutes when a reconnect got no response → give up after 30s + retry | NO-OP (PLATFORM) | Remote Control — OCC has a bridge/policy surface (OCC-104 #12) but not the full RC reconnect transport; needs a dedicated round if OCC grows RC. |
| 40 | `claude remote-control` failing to register behind an HTTP proxy with misleading "Check your organization permissions" (#97352) | NO-OP (PLATFORM) | Remote Control registration. |
| 60 | macOS: Remote Control sessions stopping mid-turn when Mac went to idle sleep | NO-OP (PLATFORM) | macOS Remote Control. |
| 55 | Files from cloud/RC sessions failing when upload finished just after 30s timeout → waits 35s | NO-OP (PLATFORM) | Cloud/RC file upload. |
| 56 | Repos added mid-session in cloud/SDK not loading skills/plugins + loading CLAUDE.md late | NO-OP (PLATFORM) | Cloud/SDK repo-mid-session. |
| 57 | PNG/JPEG/WebP >8000px failing to send from a remote session → scaled-down copy | NO-OP (PLATFORM) | Remote-session image send. |
| 58 | Messages from Claude apps with 17–20 attached files delivering only first 16 | NO-OP (PLATFORM) | Claude-apps attachment fan-out. |
| 71 | Delivery of files from cloud/RC: retry once on timeout/network/502/503/504 | NO-OP (PLATFORM) | Cloud/RC file delivery retry. |
| 72 | What Claude says when a file can't be sent for a maybe-temporary reason (mention ask-again-in-few-minutes) | NO-OP (PLATFORM) | Cloud/RC file-send messaging. |
| 76 | Files from a remote session: large files stream from disk (not into memory); over-limit refused with server's limit named | NO-OP (PLATFORM) | Remote-session file streaming. |
| 77 | Explanation when the server refuses a file from RC/cloud (e.g. oversized image) | NO-OP (PLATFORM) | RC/cloud file-refusal messaging. |
| 82 | Replies from `claude agents` arrive as queued messages; non-`/stop` slash commands sent mid-turn run when it ends | STAGED | OCC has `occ agents`/daemon; queued-reply semantics need per-site decompilation. |

### Windows / macOS / platform-specific

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 8 | Windows: startup warning when denying Bash also turns off PowerShell (no shell tool) | NO-OP (PLATFORM) | Windows PowerShell-tool surface. |
| 61 | Windows: interactive `claude` hanging/crashing "Raw mode is not supported" when input piped/redirected → says why + exits | NO-OP (PLATFORM) | Windows raw-mode. |
| 79 | Windows: Improved Bash speed by removing a subshell before every command | NO-OP (PLATFORM) | Windows Bash subshell. |
| 9 | Self-hosted runner: built-in `gh api` (REST only) for Anthropic-managed git where gh CLI absent | NO-OP (PLATFORM) | Self-hosted runner surface. |

### Misc fixes / improvements

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 10 | Fast mode staying off in remote sessions owned by an agent with no user account (org allows it) | STAGED | OCC has `fastMode.ts`; the remote-agent-account gate needs byte-verification. |
| 12 | Hooks with `asyncRewake` waking Claude repeatedly with "found issues" when the hook script is missing → report once | STAGED | OCC has hooks; the missing-script dedup needs per-site decompilation (pairs with OCC-108 noteHookFailure). |
| 15 | Claude-in-Chrome browser picker showing JSON parse error when Chrome unreachable | STAGED (partial NO-SURFACE) | OCC has a WebBrowser tool (CDP); the picker error-handling needs byte-verification. |
| 22 | Background sessions not reopenable from `claude agents` after the agent exited + removed the worktree | STAGED | OCC daemon/worktree surface; needs per-site decompilation. |
| 38 | `claude agents` sometimes not showing the permission prompt a background session waits on | STAGED | Background-session permission surfacing; needs byte-verification. |
| 39 | `/ultrareview` advising about `.git/info/attributes` when upload stops on a committed `.gitattributes` it can't read (e.g. UTF-16) | NO-OP (NO-SURFACE) | `/ultrareview` — no OCC surface (grep 0 hits). |
| 45 | `/ultrareview` upload refusals advising to copy a repo-settings variable into user settings | NO-OP (NO-SURFACE) | `/ultrareview` — no OCC surface. |
| 51 | `/desktop` quoting partial output when opening Claude Desktop timed out/printed too much → names the cause | NO-OP (PLATFORM) | Claude Desktop integration. |
| 54 | Transcript's "N hooks ran" + verbose debug matched-hooks count including internal callbacks (one hook shows as two) | STAGED | Hook-count telemetry; needs byte-verification of the official counter filter. |

### [VSCode] block (#89–#101) — all NO-OP (PLATFORM)

| # | Changelog (abridged) | Status |
|---|---|---|
| 89 | "Run in background" on a running command/sub-agent | NO-OP (PLATFORM) |
| 90 | Background shell/Monitor output in agent-map cards | NO-OP (PLATFORM) |
| 91 | Settings dialogs blaming a timeout when reply too large to confirm save | NO-OP (PLATFORM) |
| 92 | Reopening a cloud session the sidebar already brought to this machine | NO-OP (PLATFORM) |
| 93 | Sidebar Web tab not listing cloud sessions started after window load | NO-OP (PLATFORM) |
| 94 | Tab restored after reload starting a second Claude process | NO-OP (PLATFORM) |
| 95 | Tool-row file links / session-list links / two hints showing as plain text | NO-OP (PLATFORM) |
| 96 | Background agent's still-running command showing as failed after main turn ended | NO-OP (PLATFORM) |
| 97 | User's own `/usage`/`/context` opening the extension dialog instead of running | NO-OP (PLATFORM) |
| 98 | File links in plan-preview tab doing nothing when clicked | NO-OP (PLATFORM) |
| 99 | Opening a tool's input/output in an editor tab failing "Timeout waiting after 1000ms" on WSL | NO-OP (PLATFORM) |
| 100 | Manage-plugins dialog: failed marketplace add/remove/refresh now says what went wrong | NO-OP (PLATFORM) |
| 101 | Claude-in-Chrome "Enabled by default" switch also connects editor's own sessions | NO-OP (PLATFORM) |

Rationale: OCC ships **no VSCode extension** (grep: `claude-vscode` appears only as a `clientType` string in `bootstrap/state.ts`/`sessionStoragePortable.ts`/`telemetryAttributes.ts`, not an extension surface).

### [Cloud sessions] / [Claude Tag] / [Code Review] blocks (#102–#108)

| # | Changelog (abridged) | Status | Rationale |
|---|---|---|---|
| 102 | [Cloud] occasional failures to fetch/push GitHub when it briefly refused a newly issued token | NO-OP (PLATFORM) | Cloud-session GitHub token-retry. |
| 103 | [Claude Tag] posting a failure warning in a Slack thread when a background event woke it, nobody waiting | NO-OP (PLATFORM) | Claude Tag / Slack surface. |
| 104 | [Claude Tag] spend-limits page in admin settings leaving out recent/private channels | NO-OP (PLATFORM) | Claude Tag admin. |
| 105 | [Claude Tag] task list in long Slack threads reposting as a new message | NO-OP (PLATFORM) | Claude Tag / Slack. |
| 106 | [Code Review] finding comments + "Why this was flagged" stopping mid-sentence → end on complete sentence | NO-OP (PLATFORM) | Official `/code-review` bundled workflow — OCC ships none (OCC-31); OCC's `/code-review` is a separate surface. |
| 107 | [Code Review] skipping a PR after a new push when its review failed twice on the previous commit | NO-OP (PLATFORM) | Official Code Review CI surface. |
| 108 | [Code Review] failed-review card on a locked-conversation PR says the lock blocked it | NO-OP (PLATFORM) | Official Code Review CI surface. |

## 3. Security-cluster disposition summary

Of the 8 OCC-104 §8 security items: **1 PORTED** (#44, byte-verified), **7 STAGED** (#19 rm-redirect, #26 `__proto__` ceiling, #80 symlink-write, #83 Bash-allow credential-write, #41 sandbox fd-leak, #24 simple_expansion prompt-text, #88 oldest-first ordering) — plus #47 (/feedback trim) STAGED. Each STAGED item has a confirmed OCC surface (or confirmed NO-SURFACE for /feedback's bundle path) and a per-site rationale; **none were guessed** (per `aligning-with-official-binary`: ambiguous → STAGED, not invented). The 4 permission-integrity items (#19, #26, #80, #83) are flagged **next-round P0**.

## 4. Test / build / release evidence

Pre-merge (branch-only tree, before the OCC-105 merge — historical):
- New tests (this round's, since deduped): `src/services/api/__tests__/oauthTokenRevoked287.test.ts` — 10 pass / 0 fail / 13 expect(). Removed at merge as redundant with main's canonical `revokedTokenLogin287.test.ts` (see §0/§1).
- API suite regression: `bun test src/services/api/` — 380 pass / 0 fail / 1286 expect() across 27 files.
- Full suite: `bun test src --isolate` — 6861 pass / 1 skip / 0 fail / 17172 expect() across 545 files (328 s).
- Build: `bun run build` green — `dist/cli.js` 29.71 MB, `MACRO.VERSION=2.1.366` injected; `./dist/cli.js --version` → `OCC 2.1.366`.

Post-merge (final merged tree — the numbers that shipped):
- Full suite: `bun test src --isolate` — **7040 pass / 1 skip / 0 fail / 17750 expect()** across 563 files (337 s).
- Build: `bun run build` green — `dist/cli.js` 29.73 MB, `MACRO.VERSION=2.1.367` injected; `./dist/cli.js --version` → `OCC 2.1.367`.
- REPL/headless smoke on the final build: `echo "say PONG" | ./dist/cli.js -p` → `PONG`, exit 0 (live model; the `unrecognized_model` glm-5.2 warning is pre-existing env config noise, also present in prior rounds); tmux interactive REPL round-trip (`say PONG` → `● PONG`) green.
- OCC release **2.1.367** (from the stranded 2.1.366 — this round completes the `v2.1.366` tag/publish chain, see §0); tracked-upstream pointer advances to **2.1.287**.

## 5. 2.1.288 pre-triage (STAGE only — promoted to `latest` mid-round; next-round top priority)

2.1.288 published 2026-10-02T18:30Z (`latest`/`next`; `stable` remains 2.1.285). **No binary downloaded, no forensics performed this round** — recorded for the next round's kickoff (source: official CHANGELOG top, fetched 2026-10-03):

**Security / permission-integrity (next-round P0):**
- *"Fixed Bash tool permission check to prompt before a `BASHPID` assignment whose value the shell would evaluate as arithmetic, instead of allowing it silently"* — permission-bypass class; OCC has the bash AST/legacy permission chain → likely OCC-AFFECTED; verify against OCC's assignment-arithmetic handling.
- *"Fixed sandboxed heredocs with an unquoted delimiter (`python3 <<EOF`) asking for approval on every run under sandbox auto-allow when the body holds only plain text and simple `$VAR` references"* — sandbox auto-allow correctness (over-prompting); verify OCC's heredoc handling.
- *"Fixed `/login` reporting 'Login successful' when credentials could not be saved to secure storage; now shows the failure + offers retry (#73861)"* — auth-correctness; verify OCC's `/login` secure-storage save path.
- *"Fixed auto mode denials pointing Claude at a Bash permission rule when the blocked tool was not Bash"* — permission-denial message accuracy.

**Reliability / correctness:**
- *"Fixed mid-response API timeouts failing the turn: non-interactive sessions and subagents now continue from the partial response, and thinking-only responses are retried"* — pairs with OCC-104 #11/#56 retry wiring + this round's #20.
- *"Fixed long conversations failing with 'Prompt is too long' instead of auto-compacting when the last reply reported zero token usage"* — auto-compaction trigger edge.
- *"Fixed unattended sessions (`CLAUDE_CODE_RETRY_WATCHDOG`) retrying for hours after a very long response stream failed → streams again, gives up after three timeouts"* — pairs with the OCC-104 retry-watchdog work.
- 4× resume/compaction fixes (`--resume` dropping restored files; resumed session not saving last response; resume loading a cut-short transcript; resume dropping earlier thinking on ≤2.1.286 sessions) — pairs with OCC-104 #6/#31.
- *"Fixed session titles / memory recall / prompt hooks failing on Mantle or gateways rejecting structured outputs; added `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS`"* — pairs with this round's #35.
- *"Fixed OpenTelemetry `claude_code.tool.blocked_on_user` spans reporting `unknown` source/decision in `-p`/SDK + PreToolUse hook approvals"* — telemetry correctness.
- *"Fixed permission asks that ended unanswered (in `-p`/interrupted turn) emitting no `tool_decision` event"* — telemetry.

**New surfaces (need dedicated rounds):** `$.ui.selection()` for mods; built-in `gh api` in cloud sessions; Ctrl+C-cleared-prompt recovery (Up brings draft back); MCP re-auth prompt on more-OAuth-scope mid-tool-call; `/code-review --max-findings <n>|all`; agents-view Ctrl+F find + Alt+↑/↓ group jump (+ keybindings.json rebinds); screen-reader permission-mode announcement; mod/plugin LSP `${user_config.*}`/`${CLAUDE_PLUGIN_ROOT}` substitution; `git-subdir` installs on git <2.39; plugin `tool.call` hook in worktree subagents; several Cowork/cloud-session fixes (PLATFORM).

**Interaction with this round's STAGED backlog:** 2.1.288's mid-response-timeout + retry-watchdog fixes stack on this round's #20 (model-fallback latch) and OCC-104's retry wiring; the resume/compaction fixes stack on OCC-104 #6/#31 + this round's #21; `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` pairs with this round's #35 (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`). Next round should download BOTH 2.1.287 and 2.1.288 binaries and do a combined 286→288 diff to catch cross-version interactions.

## 6. Cleanup

Forensic artifacts under `/tmp/cc-diff-287` + `/tmp/gap-research-287` (binaries, string dumps, changelog fetches) removed after the round. No sub-issues created (per issue directive: all work advanced in-issue via foreground execution).
