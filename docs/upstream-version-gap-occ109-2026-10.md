# Upstream version gap — OCC-109 round (2026-10-07): official 2.1.289 → 2.1.291

> NOTE: `docs/upstream-version-gap-occ109.md` (no date suffix) is the OLD
> 2.1.251-era OCC-109 catch-up ledger (2026-08). This file is the
> **2026-10 gap round** on Multica issue OCC-109
> (`5692d37e-030e-4699-b021-a63dbac9b37c`): official shipped **2.1.290**
> (190-entry changelog) + **2.1.291** (2 regression fixes) after OCC-108
> closed at 2.1.289.

## 1. Version facts (re-verified this turn, not transcribed)

| Item | Value |
|---|---|
| Official npm `@anthropic-ai/claude-code` dist-tags | `latest` = **2.1.291** (published 2026-10-06T03:32Z), `stable` = 2.1.285, `next` = 2.1.292 (published 2026-10-06T17:10Z — one minute AFTER this round's kickoff; next-channel staging, out of scope, flagged to Leader) |
| OCC tracked upstream before this round | **2.1.289** (README badge + CHANGELOG) |
| OCC package version / main HEAD | 2.1.370 @ `5ab0d1e` (== tag v2.1.370) |
| OCC npm `@cnwenf/occ` | dist-tags.latest = **2.1.367** — v2.1.368/369/370 still unpublished (NPM_TOKEN E404 carry-over, §6) |
| publish.yml run for v2.1.370 | run `37368416515` (head `5ab0d1e`) = **failure**, `npm error 404 Not Found - PUT …@cnwenf%2focc` (re-confirmed from run log this turn) |

## 2. Forensic binaries (never executed — strings/grep -aboF/dd only)

| Version | Source | Size | md5 |
|---|---|---|---|
| 2.1.289 | `@anthropic-ai/claude-code-linux-x64@2.1.289` npm pack | 246,107,320 B | `5c920e4c2e6c73c2858cc48e5123582e` |
| 2.1.290 | `@anthropic-ai/claude-code-linux-x64@2.1.290` npm pack | 249,687,224 B | `acc2b427816611d7c48666fd4b1cf9b7` |
| 2.1.291 | `@anthropic-ai/claude-code-linux-x64@2.1.291` npm pack | 249,642,168 B | `82c1f303d0dd7ef19d869f7b3d886043` |

Version markers verified inside each ELF (`2.1.289` ×2460 in v289; `2.1.290`
×2526 in v290; `2.1.291` ×2526 in v291). `strings -n 6` dumps: 531,386
(v289) / 536,055 (v290) / 536,034 (v291) lines. Sorted set-diff v289↔v291:
**22,658 strings new in 291**, **19,052 gone from 289**; v290↔v291: 9,874
new. Raw artifacts in `docs/gap-research-291/` (`changelog-entries-290.txt`,
`new-in-291.txt`, `gone-from-289.txt`).

## 3. Changelog triage (190 entries @ 2.1.290 + 2 @ 2.1.291)

Cluster research files (byte evidence per item):

- `cluster-a-bash-permissions.md` — Bash/command permission checks (6 entries)
- `cluster-b-read-deny-mentions.md` — Read deny / images / @-mentions / memory-file symlink (5 entries)
- `cluster-c-settings-sandbox-mcp.md` — settings files / sandbox / MCP config (11 entries)
- `cluster-d-classifier-network.md` — plan/auto classifier + network/proxy/streaming (7 entries)
- `cluster-e-parser-dos-perf.md` — parser DoS / paste / perf robustness (12 entries)
- `cluster-f-session-durability.md` — session durability / headless / resume / scheduled tasks (12 entries)
- `cluster-g-misc-ux.md` — misc UX / i18n / config semantics (19 entries)
- `cluster-h-removed-surfaces.md` — removed-surface N/A sweep (all remaining entries)

All 8 cluster files landed 2026-10-07 (byte-evidence per item inside each):

| Cluster | File | Items | Verdict roll-up |
|---|---|---|---|
| A | `cluster-a-bash-permissions.md` | 6 | 2 NO-OP (security face; OCC stricter) · 4 STAGED→ported this round (#2 zsh var differential, #3 `ps`, #4 pyright removal, #5 declare-prefix readings) |
| B | `cluster-b-read-deny-mentions.md` | 5 | B1/B2/B3-stash/B4-deny PORT (ported this round) · B3 `--restricted`+`prompt.mention` halves N-A · B4 outside-arm N-A, unsettled-arm NO-OP · B5 N-A (nested AGENTS.md never attached; feature-gap semantics recorded) |
| C | `cluster-c-settings-sandbox-mcp.md` | 11 | 6 STAGED (#1 ported this round; #2/#3/#6/#7/#10/#11 deferred — #2 managed-link-walk is a whole subsystem) · 4 N-A (#4 partial-port note kept) · 1 N-A+LOW |
| D | `cluster-d-classifier-network.md` | 7 | 6 STAGED (#1 ported this round; #2/#3/#4/#5/#7 deferred) · 1 NO-OP (#6) |
| E | `cluster-e-parser-dos-perf.md` | 12 | 5 STAGED (#1/#5/#6 ported this round; #8/#9 deferred) · 6 NO-OP · 1 N-A |
| F | `cluster-f-session-durability.md` | 12 | A+C PORT (ported this round) · B/K/L + D/E/F PORT-marked deferred to next wave · rest NO-OP/N-A |
| G | `cluster-g-misc-ux.md` | 19(+1) | P1 #5/#7/#9 ported this round (+#8 WebSearch refill if capacity) · #19 PORTED already · 4 NO-OP · 5 N-A · P2 #3/#10/#13/#14/#15 STAGED deferred |
| H | `cluster-h-removed-surfaces.md` | 120 swept | 74 N-A (grep-proven absent/stub surfaces) · 46 NEEDS-REVIEW (real OCC path exists; confirmation deferred — tracked in doc) |

2.1.291 delta: only cluster F items A (session-tail loss — PORT, ported this round) and B (cloud permission prompts — STAGED, narrow live surface) touch OCC; all other clusters verified 290≡291 for their strings/mechanisms.

## 4. PORTED items this round

All ports TDD (RED→GREEN), byte-verified against the 2.1.290/2.1.291 ELFs
(strings/dd only — binaries never executed; sole exception: the sanctioned
`/tmp/cc291/package/claude` A/B control). Full per-item byte evidence in the
cluster docs; agent field reports archived in `docs/gap-research-291/agent-report-*.md`.

### 4.A Cluster A — bash permission parity (4 items, 53 new tests)

| Item | Port | Files |
|---|---|---|
| A#2 zsh non-ASCII differential escalation | official `We`/`Ue` verbatim; reason string byte-matched | `src/utils/bash/ast.ts` + `zshDifferentialVar290.test.ts` (13) |
| A#3 `ps` read-only four-condition callback | byte-exact incl. `respectsDoubleDash:!1` | `readOnlyValidation.ts` + `psFlags290.test.ts` (15) |
| A#4 pyright de-listed from read-only allow | entry removed; completion spec KEPT | `readOnlyValidation.ts`, `readOnlyCommandValidation.ts` + `pyrightNotReadOnly290.test.ts` (7) |
| A#5 declare-prefix readings | official `Ior` port: `DECLARATION_BUILTINS`, `enumerateDeclarationPrefixReadings`, `finalizeDeclarationPrefix`, branch/loop `inBranch` tracking; `resolveDeclarationPrefixDecision` deny/ask fold | `ast.ts`, `bashPermissions.ts` + `declarationPrefix290.test.ts` (18) |

Suite: `bun test src/utils/bash src/tools/BashTool` → **963 pass / 0 fail / 2275 expect()** (was 945; +18 net new, 0 regressions). Note: the AST path is dormant in the shipped build (`TREE_SITTER_BASH_SHADOW` off) — these are defense-in-depth/future-parity ports; the LIVE legacy path already fail-safes (asks) on all covered forms, matching the cluster doc's "STAGED, 非 P0" judgment. Adaptations documented in-report: OCC's pure-TS parser emits `concatenation`/`simple_expansion` (never ERROR) so the #2 matcher is anchored on the token; #5 keeps one `declarationPrefixes: string[]` field (count = `.length`) and per-parse module state (sync, non-reentrant).

### 4.C Cluster C — QueryEngine structured-output endTurn (item C, 2.1.291)

Official predicate chain ported byte-faithful: `yOo`/`uht`/`ehn`/`VKt` with
`KKt="claude/endTurn"`, `captureTerminalReason` yield* wrapper,
`is_error=false`, `stop_reason='tool_use'`, `JSON.stringify(structured_output)`,
`tengu_trailing_api_error_notice_skipped` — `src/QueryEngine.ts`; `print.ts`
untouched (exit code derives from `is_error`, unchanged).
`test/engine/structuredOutputIsError291.test.ts` GREEN.

### 4.C1 Cluster C item #1 — symlinked-settings-file link gate (2.1.291 security)

- NEW `src/utils/permissions/settingsFileLinks.ts` — verbatim official `ol()` @206550974 + `nMe`: `SETTINGS_LINK_TTL_MS=2000` (`gf`), `\x00`-joined settings-path-set cache key, monotonic clock, **empty map stashed BEFORE the walk** (throw ⇒ degraded 2s window cached — official semantics), per-path `resolveWritePathDescriptor` walk (`bi(R)`=`wn(R,"permission")` @202223164), unresolved → exact official `logForDebugging` text, skip `!leafIsSymlink`, register every leaf spelling + `expandPath` variant (deduped `D([I,$n(I)])`) unless `isClaudeSettingsPath` (`il`), catch → `logError(new Error(<official message>,{cause}))` + empty map — never crashes the permission check.
- `filesystem.ts` `checkPathSafetyForAutoEdit` — official `y1` settings branch inserted in official order (Windows-loop → settings branch → `isClaudeConfigFilePath` loop). Trigger = `pathsToCheck.some(isSettingsFileLink)` (binary `hf=nMe∪…` proves link-table membership fires the branch — this IS the 289→291 fix). Suffix `L` with self-reference suppression; `classifierApprovable: I===undefined`; `circuitBreaker:'claudeSettingsFile'` forwarded through `checkWritePermissionForTool` into `decisionReason` (official `Yf` @204082772).
- `types/permissions.ts` — union extended `circuitBreaker?: 'dangerousRemoval'|'claudeSettingsFile'`.
- Tests: 15 new (8 module + 7 gate); `bun test src/utils/permissions` → **288 pass / 1 skip / 0 fail** (24 files, no regressions).
- **3 cluster-doc errors corrected against the binary**: (1) cc289 `dB` @204091940 already had `circuitBreaker:"claudeSettingsFile"` — the true delta is `Mrr` extraction + link-table lookup + suffix + conditional `classifierApprovable`; (2) writing the symlinked settings file itself → `classifierApprovable:false` (doc said true; binary `I===void 0` wins); (3) `wn` walker `onHop` registers composed spellings on **leaf** hops only in `"permission"` mode — dir-hop spellings are NOT registered (doc's test bullet corrected).

### 4.E Cluster E — parser DoS guards (items #1/#5/#6, 112 tests)

- NEW `src/utils/markdownLexLevel.ts` — `createLexLevelGuard`, `MAX_LEX_NESTING=100`, `flattenNestedMarkdown` (official `H` verbatim), `maxNestingFallbackToken` (`B`).
- NEW `src/utils/chunkedNormalize.ts` — `chunkedNFKC/NFKD` (window 128, combining-run detector `[\p{M}ﾞﾟ]{32,}`, 4096-chunk slices) — bounds the pathological NFKC blowup.
- `markdown.ts` — official `z` extension @216038583; `applyMarkdown` RangeError → `MARKDOWN_STACK_FALLBACK_MESSAGE`.
- `Markdown.tsx` — RangeError catches (React Compiler cache slots preserved).
- `displaySanitize.ts` — both NFKC sites → `chunkedNFKC`.
- 4 test suites, **112 pass combined**.

### 4.F Cluster F — session durability (items A + C + E + F)

- **F-A session-tail loss (2.1.291)**: `transcriptRewriteCoordinator.ts` DELETED (official removed the rewrite-coordinator surface); `sessionStorage.ts` cleaned; `main.tsx` early-SIGINT path → `void gracefulShutdown(0)`. `transcriptCoordinationRemoved291.test.ts` 5 GREEN.
- **F-C structured-output endTurn**: see §4.C.
- **F-E plan-mode resume (2.1.290)**: NEW `src/utils/planModeResume.ts` — byte-faithful port of official `hws`/`M`/`T`/`R`/`x`/`E`/`S`/`vy`; wired into `sessionRestore.ts`; `main.tsx` `startupModePinned`. 21 GREEN tests (`planModeResume290.test.ts`).
- **F-F `/rewind` lists prompts queued while working (2.1.290, changelog:20)**: official `LMe` @232117xxx (NEW in 290; cc289 `vht` @228917878 passed messages straight through) recovered byte-verbatim + full restore chain (`Rln` @217805353, `tU` @204690011, `n_` @204689971, `xMe` @232103682, `i2r` @210039574, `E`/`G` @210039160, origin stamp `{kind:"human"}` @232019514). OCC adaptation (structural, behavior-identical): queued prompts live in the module-level `commandQueue`, not transcript attachment rows → NEW `src/utils/queuedRewindMessages.ts` APPENDS synthesized virtual user rows (always newer ⇒ official `nNe` tool-split guard @229151684 structurally N/A, documented not ported); `undefined origin = human keyboard` ≡ official stamp; `bridgeOrigin` excluded; WeakMap row→entry side table; NEW `src/components/RewindMessageSelector.tsx` (official `nSt` wrapper analogue: leaf-level `useSyncExternalStore` queue subscription + memoized transform + restore-consumption `remove([queued])` before delegating to standard `handleRestoreMessage`); `REPL.tsx` selector swap. 19 GREEN tests (`queuedRewindMessages290.test.ts`) incl. integration: synthesized rows pass the real `selectableUserMessagesFilter`.

### 4.G Cluster G + D — UX/config quick wins (G#5/#7/#9 + D#1, 24 new tests)

- **G#5** binary-file read message → official 2.1.291 text (`FileReadTool.ts:633`); 3 tests.
- **G#7** preconnect essential-traffic gate: `isEssentialTrafficOnly()` → skip preconnect (`apiPreconnect.ts:51`); 2 tests. Pre-existing URL divergence noted NOT changed (OCC fetches `baseUrl`; official `${baseUrl}/api/hello`) — flagged for a future round.
- **G#9** line-break filename escaping: NEW `src/utils/displayEscape.ts` — verbatim official 2.1.291 escaper (`&#NN;` for control chars incl. U+2028/U+2029, `<>` escape, plain-path fast test); wired into 3 file tools (Read device-file/not-found, Edit not-found, Write isDirectory/non-regular errorCode) + 4 permission components (FileEdit/FileWrite/SedEdit request titles+subtitles, ShowInIDEPrompt symlinkTarget — `.startsWith("..")` logic kept on the RAW value). 8 unit + 4 wiring + 3 tool tests (incl. real temp dir named `evil\napproved`).
- **D#1** plan-mode classifier structural gate: NEW `src/utils/permissions/planModeClassifierGate.ts` (`shouldHonorClassifierAllow` + `PLAN_MODE_FLOOR_REASON`); official `_rn` plan-branch reduced to `parseOk && tool.isReadOnly(parsedInput, context)` (OCC Tool interface has no `ignoresWholeToolAllowRule` → treated inert per allowRuleHint.ts precedent; omitted OR-branch fails safe toward ask); `permissions.ts` wiring (:1129 guard, :1143 floor reason); `Tool.ts` `isReadOnly(input, context?)` backward-compatible optional 2nd param. 8 tests + 296-test permissions regression green.
- Consolidated scope run: **393 pass / 1 skip / 0 fail / 1022 expect() across 41 files**.
- **G#8 (WebSearch hourly refill budget) SKIPPED** — optional item; blocked twice over: (1) file-scope conflict (`sessionLimits.ts`/`taskRegistry.ts` outside the agent's declared scope, sibling-owned); (2) official `u()` refresh body + `msUntilNextCall()`'s `f`/`s` are `…`-elided in the cluster doc → verbatim port impossible, "never invent" forbids guessing. Follow-up agent owning those files recommended.

### 4.B Cluster B — read-deny / image / @-mention guards (B1+B2+B3+B4, 41 new tests)

| Item | Port | Files |
|---|---|---|
| B1 paste/drag image deny | official `iLo` @216794877 — the reader is a **REQUIRED** param (`tryReadImageFromPath(text, readPastedFile)`) so an unguarded call site is a type error; `'refused'` arm checked before the falsy check (v290 order) | `src/utils/imagePaste.ts` + `imagePasteDeny291.test.ts` (8) |
| B1 paste-handler wiring | official `()=>{let he=o?.getState().toolPermissionContext; return he?[he,igs(he)]:[]}` @220572106 — live store context **plus** `getPersistedReadDenyContext()` (= `igs`/`N2`); missing store ⇒ `[]` ⇒ fail-closed; `anyRefused` withholds the image and kills the temp-screenshot clipboard fallback; `input_image_drag` reasons `read_withheld` / `read_failed` / `read_threw` (289 had only `read_failed`) | `src/hooks/usePasteHandler.ts` + `usePasteHandlerDeny291.test.tsx` (4 / 17 expect() — REAL hook through a REAL ink mount, telemetry via `CLAUDE_CODE_DIAGNOSTICS_FILE`) |
| B1 folder-listing deny | `listMentionedDirectoryEntries` / `isMentionedDirEntryReadDenied` (official `d7n`/`Gkt` @210756965) | `src/utils/attachments.ts` (landed earlier this round) |
| B2 image-read TOCTOU | guarded landing read + `assertSymlinkResolutionsUnchangedForRead`; **not** platform-gated (official isn't either) | `src/utils/permissions/guardedRead.ts` + `guardedRead291.test.ts` (23) |
| B3 @-mention stash arm | `checkTimeReadResolutions` / `guardedAttachedReadContext` / `assertGuardedReadUnchanged` wired at all **3** `FileReadTool.call` sites; `hasReadDenyRules(appState.toolPermissionContext)` computed once per sweep (official `h=sy(r)`); the image-branch assert sits BEFORE the inner `try` so a `SymlinkReadRefusedError` lands in the sweep's outer catch (`return null`) | `src/utils/attachments.ts` + `attachmentsAttachedReadStash291.test.ts` (6 / 19 expect()) |
| B4 instruction files | `isFileReadDenied(filePath, getPersistedReadDenyContext())` — landed pre-round | `src/utils/claudemd.ts:580` |

- One shared primitive module (`src/utils/permissions/guardedRead.ts`) serves the paste, attachment and mention paths, mirroring official's single read-guard module @210752500–210758104; the in-file deviation table lists all 5 substitutions.
- **Byte-evidence correction to the cluster doc**: the earlier reading of official `he=K.every((be)=>yr(PNr(be)??""))` as the temp-screenshot regex was WRONG — the chunk's import header @220572106 is `import{basename as wr,isAbsolute as yr}from"path"`, so `yr` = `isAbsolute`. Ported as `allPastedImagePathsAbsolute()`; `cluster-b-read-deny-mentions.md` corrected.
- Deviations documented, never invented: official `MMe` verified-open → OCC's 2.1.251 `SymlinkResolutionStash` one-shot gate (`stashCheckTimeResolutions` + `assertSymlinkResolutionsUnchangedForRead`); the UNC `MD`/`Gf` bypass stays dropped; `--restricted`, `blockReadsOutsideWorkingDirectories`, `trustedNetworkDirectories`, the `prompt.mention` hook event and the macOS `stashIdentity`/`VOe` lane are grep-proven N-A; 3 pre-existing `imagePaste.ts` divergences (logError text, post-resize mediaType detection, no WSL `toLocalPath` arm) left untouched as out-of-delta.
- Cluster-B suites: **41 new tests**; 40-file cluster sweep **476 pass / 1 skip / 0 fail / 1120 expect()**.
- Test-harness finding: OCC's ink fork does **not** resolve `waitUntilExit()` on an explicit `unmount()` (probe: `render` 83 ms, `unmount` fine, promise hangs) — hook tests must unmount and return.

## 5. STAGED / NO-OP summary

STAGED (deferred to a next round, per-site rationale in the cluster docs):

- **A**: none left (all 4 STAGED items ported; 2 NO-OP stand).
- **B**: B3 `--restricted` + `prompt.mention` halves N-A; B4 outside-arm N-A, unsettled-arm NO-OP; B5 N-A (nested AGENTS.md never attached — feature-gap semantics recorded).
- **C**: #2 managed-link-walk (whole subsystem), #3/#6/#7/#10/#11 deferred; 4 N-A (#4 partial-port note kept); 1 N-A+LOW.
- **D**: #2/#3/#4/#5/#7 deferred (per-site decompilation needed); #6 NO-OP.
- **E**: #8/#9 deferred; 6 NO-OP; 1 N-A.
- **F**: B (cloud permission prompts — narrow live surface), K, L + D/E/F PORT-marked items deferred to next wave; rest NO-OP/N-A. `nNe` tool-split guard NOT ported (structurally N/A for OCC's append-at-end synthesis — documented in `queuedRewindMessages.ts`).
- **G**: #8 SKIPPED (see §4.G); P2 #3/#10/#13/#14/#15 deferred; #19 was already PORTED pre-round; 4 NO-OP; 5 N-A.
- **H**: 74 N-A (grep-proven absent/stub); **46 NEEDS-REVIEW** (real OCC path exists; confirmation deferred — tracked in `cluster-h-removed-surfaces.md`).

NO-OP standouts: 2.1.290 changelog security-face entries where OCC is already stricter (cluster A #1/#6); 2.1.291 delta beyond F-A/F-B/C1 verified 290≡291 for every other cluster's strings/mechanisms.

## 6. Carry-over: NPM_TOKEN (re-verified 2026-10-07)

**STILL NOT ROTATED (owner side).** npm `@cnwenf/occ` latest = 2.1.367;
v2.1.368/369/370 Publish runs all failed `npm error code E404 … PUT
https://registry.npmjs.org/@cnwenf%2focc - Not found` (auth). Latest failed
run: `37368416515` @ tag v2.1.370 (head `5ab0d1e`). Owner action: rotate
repo secret `NPM_TOKEN`, then re-run the Publish workflow **for the newest
tag only** (never re-run historical runs pinned to old SHAs — that would
publish stale content).

## 7. Verification (e2e)

### 7.1 Unit / integration (`bun test`)

| Run | Result |
|---|---|
| `bun test src` — working tree, all clusters landed (+ the pre-commit hygiene pass) | **8017 pass / 1 skip / 105 fail / 1 error** (8123 tests, 649 files, 163 s) |
| `bun test src` — baseline HEAD `5ab0d1e` in a clean detached worktree | **7736 pass / 2 skip / 105 fail / 1 error** |
| `diff` of the two sorted `(fail)` name lists | **empty** → the 105 failures are pre-existing (29 files, all tracked and unmodified this round); **+281 new passing tests, zero regressions** |
| those 29 files run in isolation, both trees | 339 pass / 18 fail, identical failing set (network/sandbox-dependent: api retry, policyLimits, WebFetch, mcp OAuth, nativeInstaller download, …) |
| cluster-B sweep (40 files) | 476 pass / 1 skip / 0 fail / 1120 expect() |
| cluster-B shared primitives, re-measured after the pre-commit hygiene pass | `bun test src/utils/permissions` → **337 pass / 1 skip / 0 fail / 824 expect()** (27 files), incl. the new `readDeny291.test.ts` 18 pass / 28 expect() |
| cluster A (`bun test src/utils/bash src/tools/BashTool`) | 963 pass / 0 fail / 2275 expect() |
| cluster G+D consolidated (41 files) | 393 pass / 1 skip / 0 fail / 1022 expect() |
| `bun test test/e2e/{repl-image-paste,occ-versioning,commands-alignment}` | 7 pass / 0 fail |

### 7.2 Lint gate (Biome — `tsc` is not CI; the repo carries ~1341 pre-existing type errors)

| | working tree | baseline HEAD |
|---|---|---|
| `bun run lint` errors | **17** — `src/bridge/bridgeMain.ts` (10), `src/cli/handlers/mcp.tsx` (7), `src/cli/handlers/__tests__/purgeRename288.test.ts` (2), `src/cli/exit.ts` (1); none of these files were touched this round | 17 |
| `bun run lint` warnings | 230 | 229 |
| `bunx biome lint` on this round's **64 changed files** | **0 errors**, 13 warnings (11 stale `suppressions/unused` in `main.tsx`, 2 cosmetic `noUselessStringRaw` in `displaySanitize.ts`) | — |
| `bunx biome lint` on the **37 new files** | **0 errors**, 1 warning — `readDeny.ts:150 noAccumulatingSpread`, ACCEPTED: the reduce builds each permission context immutably (coding-style immutability rule) over a bounded, settings-derived rule list | — |

### 7.3 Build

`bun run build` → `dist/cli.js` **29.89 MB (31,337,280 B)**, injected
`MACRO.VERSION=2.1.370`, `MACRO.BINARY_NAME=occ`.

Post-release-record rebuild (after the CHANGELOG 2.1.371 section +
`package.json` bump, commit `chore(release): 2.1.371`): `bun run build` →
same 29.89 MB (31,337,280 B), injected `MACRO.VERSION=2.1.371`;
`./dist/cli.js --version` → `OCC 2.1.371`; headless `echo "say PONG" |
./dist/cli.js -p` → `PONG`, exit 0; key-suite spot-check (`bun test
src/utils/permissions` + `queuedRewindMessages290` + `planModeResume`)
→ **356 pass / 1 skip / 0 fail / 854 expect()** across 28 files.

### 7.4 Live e2e — real API, production binary, tmux REPL

Runtime env note: `ANTHROPIC_BASE_URL` points at the owner's Aliyun MaaS
Anthropic-compatible proxy with model `glm-5.2` (hence the benign
`[claude-code:unrecognized_model]` line on the headless path); both
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are set in this environment,
which OCC itself warns about at boot.

1. `occ --version` → `OCC 2.1.370`.
2. Headless: `echo "say PONG" | occ -p` → `PONG`, exit 0.
3. REPL boot in the repo: prompt in 2 s; `say PONG` → `● PONG` (58,451 tokens);
   `/status` renders Version 2.1.370 / Session name / Session ID / cwd / auth
   token / API key / base URL / Model / `MCP servers: 2 connected, 1 failed` /
   Setting sources / Auto-mode server; Esc dismisses the dialog.
4. **Real bracketed paste** into the live REPL (`printf '\033[200~<png>\033[201~'`
   injected with `tmux send-keys -l`), allowed PNG → `❯ [Image #1]` chip in ~1 s.
   Regression control for the rewritten paste path (B1).
5. Second REPL in a scratch project whose `.claude/settings.json` carries
   `permissions.deny: ["Read(//tmp/…/secret/**)"]`, with
   `CLAUDE_CODE_DIAGNOSTICS_FILE` set:
   - **denied** PNG pasted → no chip; the path lands as plain text (official
     `onPaste(pastedText)` fallback) and diagnostics carry
     `{"event":"input_image_drag","data":{"reason":"read_withheld"}}`;
   - **allowed** PNG pasted in the same session → `[Image #1]` chip, no new telemetry;
   - `@/tmp/…/secret/s.png` submitted → **not auto-attached**; the model replied
     `NOTATTACHED` and its own follow-up `Read` was blocked with
     `File is in a directory that is denied by your permission settings`
     (B1 folder/mention arm + B3 live).
6. Trap recorded for future rounds: absolute-path `Read` deny rules need the
   doubled slash — `Read(//tmp/x/**)`. A single leading slash is
   settings-dir-relative and silently matches nothing (verified deterministically
   with a throwaway probe: rule loaded + `hasReadDenyRules` true, yet
   `isFileReadDenied` false with `/tmp/…`, true with `//tmp/…`). Official CC
   gitignore-style anchoring, not an OCC defect.

### 7.5 对拍 — official `claude` 2.1.291 run side-by-side (sanctioned A/B control)

The forensic ELFs were never executed for evidence (§2); this is the round's one
sanctioned live control run, on the Leader's `uvx claude-code`/2.1.291 对拍
requirement: `/tmp/cc291/package/claude` booted in tmux (fresh `HOME`, same
scratch project, same `permissions.deny: ["Read(//tmp/…/secret/**)"]`), driven
through the identical onboarding (theme → env-API-key approval → folder trust)
and the identical real bracketed-paste injection.

| Gesture | official 2.1.291 | OCC 2.1.370 (this round) | match |
|---|---|---|---|
| paste **denied** PNG path | no `[Image #1]` chip; path lands as plain text | no chip; path lands as plain text | ✅ |
| paste **allowed** PNG path | `❯ [Image #1]` chip in ~1 s | `❯ [Image #1]` chip in ~1 s | ✅ |

Only divergence: official routes `input_image_drag` to its OTel counter (nothing
lands in `CLAUDE_CODE_DIAGNOSTICS_FILE`), while OCC writes it to the PII-free
diagnostics sink — already recorded as the telemetry deviation in §4.B; the
user-visible behavior is identical.

Control run cleaned up afterwards: tmux session killed, the scratch project and
the throwaway `HOME` removed (verified no `sk-ant-` material was persisted by
official's env-key approval, and nothing secret left on disk).

tmux sessions killed; scratch dirs and the throwaway probe removed after the run.

### 7.6 Pre-commit hygiene pass (same round, before the merge to `main`)

Two findings from commit prep, both traps worth carrying forward (full detail
in `docs/gap-research-291/cluster-b-read-deny-mentions.md` §Pre-commit hygiene):

1. **`src/utils/permissions/readDeny.ts` was staged as a git-binary file.**
   `rulesFingerprint` used *literal* NUL / SOH control bytes as separators, so
   git recorded `Bin 0 -> 7953 bytes` (`file(1)` → `data`): no reviewable diff,
   and the pre-commit biome hook cannot lint a path git treats as binary.
   Replaced with the `\u0000` / `\u0001` escapes — byte-identical runtime
   strings, ASCII-clean source. The separators stay control characters on
   purpose (they cannot occur in a settings-derived rule value, so no two
   distinct rule sets can collide on a fingerprint).
2. **A `mock.module` spy wrapper must capture the original function first.**
   The new `readDeny291.test.ts` counts `getPathsForPermissionCheck` calls to
   pin the official `aje` short-circuit; delegating to
   `actualFsOperations.getPathsForPermissionCheck(...)` recursed into the
   wrapper (the awaited namespace is the same object `mock.module` rebinds) and
   hung the file — 600 s timeout, zero output. Fix: hold the function reference
   before mocking and call that.

New unit suite `src/utils/permissions/__tests__/readDeny291.test.ts`
(**18 pass / 28 expect()**) pins the cluster-B shared primitives directly
instead of only through their consumers: `hasReadDenyRules` (empty /
other-tool-only / Read-deny), `isFileReadDenied` (surface deny, symlink-landing
deny, allow, and **both** short-circuits asserted by resolution call count),
`loadPersistedReadDenyRules` (deny-only filter + source),
`extendContextWithPersistedReadDenyRules` (input not mutated, per-source
keying, dedup — official `N2`), and `getPersistedReadDenyContext`
(persisted-only deny enforced, memo **identity** while the rule set is
unchanged, invalidation on a settings change, test reset — official `igs`).

Re-measured after the pass: `bun test src` → **8017 pass / 1 skip / 105 fail /
1 error** (was 7999/1/105/1 — the +18 is exactly the new suite, the failing set
is unchanged), `bun test src/utils/permissions` → **337 pass / 1 skip / 0
fail**, `biome lint` on the two touched files → 0 errors / 1 accepted warning.

Repo hygiene: `docs/gap-research-*/new-in-*.txt` and `gone-from-*.txt` (the
38–39 MB raw ELF strings set-diffs) are now `.gitignore`d — regenerable from the
recorded md5s plus the commands in §2, and prior rounds commit only the
markdown cluster docs and `changelog-entries-*.txt`.

### 7.7 Post-merge CI catch — one stale pre-290 test (fixed same round)

Local verification ran `bun test src`; CI runs the broader suite including
`test/`. CI run **37544611823** on merge commit `5801585`: **9370 pass / 1
fail / 335 skip** across 854 files. The single failure was
`test/tools/EnterPlanModeAutoBash.test.ts` → "plan+auto bash reaches
classifier path": a 2.1.218-era fixture that (a) mocked a `Tool` via
`as unknown as Tool` **without** the required `isReadOnly` method — the D#1
port of official `_rn` (@213320210) calls `tool.isReadOnly(parsed.data,
context)`, so the mock threw `TypeError` — and (b) asserted the pre-290
outcome (`allow` + `decisionReason.type 'classifier'`), which official 2.1.290
**intentionally changed**: a non-read-only plan-mode classifier allow is now
floored to ask with reason `plan_mode_floor`. Per the official semantics the
test was stale, not the implementation. Fixed: mock gained `isReadOnly: () =>
false` (mirrors the real BashTool for an unprovable command and the
`Tool.ts:859` default "assume writes"), assertions updated to `behavior
'ask'` + `decisionReason.reason 'plan_mode_floor'`, test name and HONEST
CONCLUSION comment rewritten to document the 290 floor. Re-run: file **6 pass
/ 0 fail**; sanity `bun test test/tools src/utils/permissions` **386 pass / 1
skip / 0 fail**; biome clean on the changed file. Lesson recorded: future
rounds must run `bun test` over `test/` too, not just `src/`, before merge.

### 7.8 验收 打回 fix round (2026-10-07) — P2-1 / P2-2 / P3

验收员 rejected release v2.1.371 pending three hand-reproduced defects on HEAD
`21d0477`. All three fixed this round (byte-verified against cc289/290/291; no
official binary executed).

**P2-1 — `ad(e)` display escaping is 2.1.290-global, not item-1-local.** The y1
settings-link write message (`filesystem.ts:716`) and every other
path-interpolated permission message shipped a raw `${path}`. Byte ruling: cc289
has **zero** `${ad(` message shapes; cc290 and cc291 each carry **6**
`write to ${ad(` + **9** `read from ${ad(` shapes → `ad()` wrapping is a
2.1.290-GLOBAL change, not local to the settings-link branch. Fix: wrapped all
10 raw-path sites in `filesystem.ts` (:675/716/727/738/1916/1930/1974/2041/2323/2388)
plus the G7 shell-startup redirect reason in `bashPermissions.ts` (~:432) in
`escapeControlCharsAsEntities` (the verbatim `ad` port, `displayEscape.ts`;
identity for plain paths → zero regression on the existing assertions). Tests:
`settingsFileLinkGate291.test.ts` gained a `describe` asserting a `\n` in the
path renders `&#10;` (and a `\x1b`+`\n` hostile name renders `&#27;…&#10;`,
single-line, no raw control byte). 17 pass / 67 expect() across the two
settings-link files.

**P2-2 — plan-mode floor was bypassed by the acceptEdits fast-path.** The
reviewer's probe (a real-FileWrite-semantics tool: `isReadOnly→false`, allow
under acceptEdits, ask otherwise) under `mode:'plan'` + `isPlanModeAutoBashActive`
returned `allow {type:'mode',mode:'auto'}` on HEAD — the acceptEdits simulation
fast-path (`permissions.ts:744`) fired BEFORE the 2.1.290 `plan_mode_floor`
(which only gates the classifier-allow landing at `:1143`). The `:180` test's
"ask in ALL modes" mock exercised a fictional path (a real write tool allows
under acceptEdits), and the test-comment / cluster-d "plan mode NEVER
auto-allows" claim was false. Official binary ruling (dd + `grep -aboF`, no
execution): **all three** binaries gate the acceptEdits simulation on a plan
guard — `X=Ce==="plan"&&!Kn` feeding the fast-path `try` gate `…&&!X)try{`:

| ver | guard def | gated `try` |
|---|---|---|
| cc289 | `Wo=Ce==="plan"&&!nn` @210258204 | `!Wo)try` @210258689 |
| cc290 | `br=Ce==="plan"&&!Kn` @213334712 | `!br)try` @213335197 |
| cc291 | `Er=Ce==="plan"&&!Kn` @213291816 | `!Er)try` @213292302 |

`Kn` is the server-held-shell-allow reroute (no OCC surface), so the OCC guard
reduces to `mode === 'plan'`. Contrast: the official **safe-allowlist** fast-path
(cc291 `if(!Di&&!Bo&&jr)` @~213295651, `jr=ot===void 0&&!Bt&&Cmt(e,n)`) carries
**no** `Er` guard — allowlisted safe tools still auto-allow in plan mode; OCC's
allowlist fast-path (`permissions.ts:804`) already matches and was left
untouched. Fix: added `appState.toolPermissionContext.mode !== 'plan'` to the
acceptEdits fast-path entry condition (mirrors `!Er`). Tests:
`EnterPlanModeAutoBash.test.ts` `:180` replaced with `createWriteTool`
(real write semantics); the two flag-set/flag-clear plan tests now assert
`ask + plan_mode_floor` (flag set, block entered) vs plain `ask` with NO floor
reason (flag clear, block skipped); the auto-mode control asserts the fast-path
STILL fires (`allow {type:'mode',mode:'auto'}`, `Er` false). Header "NEVER"
overclaim corrected to the scoped form (non-read-only never auto-allowed via
acceptEdits-sim OR classifier; read-only + safe-allowlist still allowed).
cluster-d Item 1 gained a 验收-P2-2 修正 subsection with the byte table.

**P3 — guardedRead landing-read timeout was declared but unwired.**
`guardedRead.ts:81` defined `GUARDED_READ_TIMEOUT_MS = 1000` (official `XA`) and
even exported it (`:447`), but the `readFileBytes` call at `:313`
(`readGuardedAtLanding`, the verified-landing read) had no timeout. Byte ruling:
official `Vkt`/`Nkt` open the landing with `AbortSignal.timeout` — cc291 `Nkt`
@210714577 `lMe(Ke(e),n,AbortSignal.timeout(jA))((h)=>h.handle.readFile())`,
`jA`=1000. OCC's `readFileBytes(path, maxBytes?)` seam takes no signal, so
`readLandingBytes` now RACES the read against
`AbortSignal.timeout(GUARDED_READ_TIMEOUT_MS)`; on timeout the promise rejects
into the existing catch → `absent`/`refused` sentinel, matching official's
`r===void 0` mapping. Honest sub-points recorded in module deviation 6 +
cluster-b deviation 5: (a) the `unexamined` branch (`:351`) is deliberately NOT
wrapped — official `ogs` (@210715481 `oe().readFileBytes(Une(e))`) has no signal
there either, so OCC matches (the 验收 "both live reads" note lumped the two;
only the landing read carries an official timeout); (b) the absence probe
(`resolutionsUnchangedAndAbsent`→lstat) is not timeout-wrapped whereas official
`Ekt` passes `AbortSignal.timeout(jA)` — a residual, low-risk (metadata lstat on
an already-resolved path). Test seam `_setGuardedReadTimeoutForTesting(ms)`
added; `guardedRead291.test.ts` +2 tests (hang→refused with a 30 ms timeout,
fast-read→bytes control) → 25 pass.

Verification this round ran BOTH trees per the §7.7 lesson (`bun test src` and
`bun test test/`), plus biome on every changed file and a build sanity — see
the run log in the 复验 comment.
