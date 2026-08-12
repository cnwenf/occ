# Upstream Version Gap — OCC-91 (2.1.228 read-gate landed; hidden-227 discovery)

**Round:** OCC-91, 2026-08-13
**OCC entering state:** `2.1.298` (npm `@cnwenf/occ` latest; fully aligned through official **2.1.224** per OCC-65/OCC-69; 2.1.225/2.1.226 verified no-op; 2.1.227 reconciled **changelog-only** in OCC-88 as "zero portable items" — this round discovers that reconciliation missed 2.1.227's *hidden* binary-level changes, see §3).
**Official target this round:** `2.1.228` (published 2026-08-12; `latest` == `next`).

## 1. Official latest — three-way verification

| Source | Result |
|---|---|
| npm registry | `latest` = `next` = **2.1.228**, `stable` = 2.1.220 |
| GitHub | release/tag `v2.1.228` (v-prefixed tags: `v2.1.228`…`v2.1.223` listed via `gh api repos/anthropics/claude-code/releases`); full release body fetched via `gh release view v2.1.228` |
| Fresh ELF | official 2.1.228 linux-x64 downloaded to `/tmp/occ91/package/claude`; strings dump `/tmp/occ91/s228.txt` (43.6 MB, ASCII-only — see §2 caveat); 2.1.227 dump retained at `/tmp/occ91/v227/s227.txt` for A/B |

## 2. The 2.1.228 changelog — eighteen items, per-item verdicts

Official release body (verbatim from `gh release view v2.1.228 --repo anthropics/claude-code`):

| # | Item (abridged) | Verdict | Evidence / rationale |
|---|---|---|---|
| 1 | Interactive sessions could stop redrawing after a rare internal layout error | **Staged** | Deep Ink-render-loop error recovery. Porting requires recovering the exact recovery mechanism from the binary render loop; never-invent discipline → staged for a dedicated decompilation round. No redraw-stop observed in this round's live REPL walkthrough (§6). |
| 2 | `git`/Git Bash not found on Windows from a parent folder of the git installation | **N/A** | Windows-installation-path discovery fix; OCC runs on the unix toolchain surface and its git discovery does not share that code path. |
| 3 | `/tui` reverting the session to an earlier model when `/model` changed since the last response | **N/A by construction** | Same as OCC-88 item 3: OCC's `/tui` is settings-only (save + apply next session), no live renderer hot-swap → the revert path structurally does not exist. |
| 4 | Cross-session messaging starting without an inbox after install/upgrade | **N/A** | Inbox (`UDS_INBOX`) is not in OCC's 6-flag `FEATURE_ALLOWLIST`; cross-session messaging surface is off. |
| 5 | Remote Control `/resume` leaking the resumed conversation's title/history into the connected session | **N/A** | Remote Control is trimmed from OCC. |
| 6 | `claude self-hosted-runner` failing on fresh runners when the `checkout` hook fails | **N/A** | Self-hosted-runner subsystem is not part of OCC's surface. |
| 7 | Sessions ending in the gap between a background task finishing and the follow-up turn starting | **N/A** | Scheduled-task / follow-up-turn machinery (the `useScheduledTasks` module family) is flag-gated off in OCC (KAIROS-class surfaces). |
| 8 | Session cleanup deleting contents inside a project's memory folder | **N/A** | OCC's session cleanup (`src/utils/cleanup.ts` / `cleanupRegistry.ts`) contains no memory-folder deletion — grep for `memor`/`MEMORY` returns nothing in those files. The official fix rides on the **memdir-stamping** mechanism (hidden in 2.1.227; §3 skip list, `yOo`), which is itself skipped with rationale. |
| 9 | Background plugin-cache cleanup deleting a symlinked development checkout's only version | **N/A** | Plugin system trimmed from OCC. |
| 10 | Settings-merge: marketplace entry redefined in a higher tier inheriting custom headers | **N/A** | Marketplace trimmed from OCC. |
| 11 | Deferred-tools reminder occasionally sent to the model twice after a skill invocation | **N/A** | Deferred-tools reminder pipeline is not present in OCC's tool loop (no deferred-tools reminder emitter in `src/query.ts`/`src/tools.ts`; the only "deferred" hits are BriefTool/PowerShell/ToolSearch prompts). |
| 12 | Hardened claude.ai-synced skills (no shadowing, sanitized descriptions, no `!`/`@` expansion) | **N/A** | claude.ai skill-sync is a hosted-backend pipeline; OCC has no claude.ai sync surface (OCC's live `MCP_SKILLS` flag fetches skill modules from *connected MCP servers*, a distinct mechanism). |
| 13 | Cross-session messages display inline; Remote Control sender naming | **N/A** | Cross-session messaging / Remote Control trimmed (items 4/5). |
| 14 | Vertex AI credential handling fails within seconds instead of retrying for minutes | **Staged (perf)** | OCC has a Vertex provider, but the fix is a retry-policy rework whose exact mechanism must be recovered from the binary before porting; staged as a low-priority perf candidate. |
| 15 | Compaction progress: retry countdown + stall hint shown during compaction | **Staged (UI)** | Cosmetic/progress-UI addition; OCC's compaction flow has no observed gap, and the exact render addition is not recovered → staged per never-invent. |
| 16 | Terminal title busy-spinner glyphs updated to reduce tab-bar jitter | **PORTED** | Binary-verified: 2.1.227 frames `["⠂","⠐"]` (⠂⠐) → 2.1.228 `iWi=["◐","◑"]` (◐◑); static prefix `✳` (✳) and 960 ms interval (`P3h=960`) unchanged. OCC `src/screens/REPL.tsx` `TITLE_ANIMATION_FRAMES` updated; live-verified in tmux (§6). |
| 17 | Write tool: newer models can overwrite an unread file, matching Edit's rules; older models still require the read | **PORTED (flagship)** | The read-gate guard machinery — see §3 (hidden in 2.1.227 behind `tengu_velvet_mallet`, default off) and §4 (full port). |
| 18 | Removed the "auto mode sessions cost slightly more" note from the first-use notice for Pro/Max/Team | **PORTED** | Binary-verified `_3h` module: description split into base/cost/safety sentences; `AUTO_MODE_DESCRIPTION_WITHOUT_COST_SENTENCE`; `getAutoModeDescription()` (official `NmH`) returns the no-cost variant when `getSubscriptionType()` ∈ {pro, max, team}. OCC `AutoModeOptInDialog.tsx` + REPL first-use notice updated. |

**Round verdict: 3 portable items (16/17/18) landed; 3 staged with explicit rationale (1/14/15); 12 N/A.**

*Caveat on verification method:* the 2.1.228 strings dump is ASCII-only (unicode literals are escaped in the minified bundle — `◐`-style escapes remain greppable; raw unicode probes are not). All three landed ports were verified via those escaped literals + surrounding minified code, not guessed.

## 3. The hidden-227 discovery (why OCC-88's "zero portable items" was incomplete)

OCC-88 reconciled the *published* 2.1.227 changelog (five user-visible items — all correctly N/A/queued) but did not sweep the 2.1.227 **binary** for unchangelogged changes. This round's 227↔228 binary diff surfaces that 2.1.227 quietly introduced a **file-state guard machinery** gated behind the feature flag `tengu_velvet_mallet` (default off — hence invisible in the changelog and in behavior): a shared Write/Edit read-before-write/staleness validator with read-deny coverage, old-model exemptions, notebook exemptions, and stale-read recovery keyed on "would a hypothetical Read of this path have been auto-allowed" (the `Mwt` predicate).

**2.1.228 is the public activation of that machinery**: changelog item #17 is the Write-side skip rule going live for newer models (the flag gate is replaced by the explicit model-tier rule), with Edit following the same predicate. Because the machinery was fully present (but dormant) in 2.1.227, OCC ports it **whole from the 2.1.228 binary** in one step rather than re-deriving the dormant 227 flag path.

**Skip list — 2.1.227/228 hidden machinery NOT ported (with rationale):**

| Binary symbol | What it does | Skip rationale |
|---|---|---|
| `jkr`/`yTr` | Worktree-isolation variants of the guard (errorCode 7/12 paths) | OCC has no worktree-isolation file-state surface; porting would require inventing the surrounding subsystem. |
| `Ibe` | Per-file lock around state validation | OCC's single-turn tool execution has no concurrent same-file tool-call path to protect; lock port without its scheduler context would be speculative. |
| `yOo` | Memory-dir stamping (`memdirStamped`) — protects memory-folder contents (ties to changelog #8) | The stamping substrate (memory-folder write tracking across cleanup + session boundaries) is absent in OCC; OCC's cleanup never deletes memory folders (§2 #8), so there is no bug to fix and porting the stamp alone would be dead machinery. |
| `contentNotInModelContext` | Guard branch for content the model never saw | Its trigger surface (injected-but-unseen content channels beyond `isPartialView`) is not recoverable without the surrounding context-tracking; the partial-view case IS ported. |
| `permissionLayers` | Layered permission evaluation extension | OCC's permission system is the flat rules-by-source model; layering is a separate architectural surface. |
| `gmr`/`Pwt` | Symlink-TOCTOU guard for the guard's own reads | The probe-read path OCC ports already resolves symlinks via `getPathsForPermissionCheck`; the additional race-window hardening needs its own decompilation round. |
| `RT`/`Pwt` plan-file cache | Cached plan-file freshness state | Plan-file subsystem surface differs in OCC; staged. |
| `qGe` | Post-write size verification | Not part of the activated 2.1.228 write path; staged as a candidate. |

## 4. What landed — implementation detail

### 4.1 `src/utils/permissions/fileStateGuard.ts` (new, 436 lines)

Byte-semantic port of the official shared guard module, every function recovered from the 2.1.228 binary with its official minified name recorded in-line:

- Messages: `FILE_NOT_READ_MESSAGE` (`nTo`), `FILE_MODIFIED_SINCE_READ_VALIDATION_MESSAGE`, `FILE_MODIFIED_SINCE_READ_CALL_MESSAGE` (`oTo`), `READ_DENY_EDIT_MESSAGE` (`Sws`), `READ_DENY_WRITE_MESSAGE` (`vws`), `FILE_STATE_CURRENT_NOTE` (`fTo`).
- `FileStateError` (name = `'FileStateError'`).
- Model tiers: `OLD_GUARD_MODELS` (`zGy`, verbatim 10-entry table), `CANONICAL_TO_GUARD_NAME` bridge (OCC's bare `claude-opus-4`/`claude-sonnet-4` canonical names → the `-0` keys), `isOldModel`, `getModelBucket` (`jMo`).
- Path/permission predicates: `isNotebookPathForGuard` (`z7d`), `isCoveredByReadDenyRule` (`cVt`, narrowing-source-aware), `isReadToolUnavailableForGuard` (`FGS`), `isReadAutoAllowedForPath` (`Gxf`), `wouldReadBeAutoAllowed` (`Mwt` — the thunk passed by both tools), stale-read recovery classifier `editWouldApplyToTelemetry` (`k2p`).
- State comparators: `isFullReadOfFileState` (`$ot`), `stripBom` (`Hxe`), `normalizeForComparison` (`J9`), `fileStateMatchesDisk` (`Exe`), `fileStateMatchesNormalized` (`i3o`).
- Entry points: `assertWriteFileStateFresh` (`Ssb`, Write) and `checkEditFileStateAtCall` (`C8b`, Edit; returns `staleRecovered`).

Guard semantics (verbatim from the binary):
- **Write skip** = `!lastRead && !isNotebook && !isOldModel && wouldReadBeAutoAllowed(...)`.
- **Edit skip** = `!isOldModel && wouldReadBeAutoAllowed(...)` (covers partial views; no notebook exemption on Edit).
- **Stale recovery** = `editWouldApply === 'applies' && wouldReadBeAutoAllowed(...)`.
- Read-deny-covered paths fail closed on both tools (errorCode 13, ask) at both `validateInput` and `call()` (re-check covers settings changes between the two).

### 4.2 `src/tools/FileWriteTool/FileWriteTool.ts` (rewritten to the 2.1.228 shape)

Order of checks in `validateInput`: subagent md-report block (errorCode 5) → secrets (0) → edit-deny (1) → `cVt` read-deny (13) → UNC pass-through → stat (perforce errorCode 6 inert; ENOENT → treat-as-new) → read gate (`guardSkipped` + `tengu_write_tool_not_read_hypothetical` telemetry + errorCode 2) → staleness (errorCode 3, full-read content fallback). `call()` re-checks `cVt` first, then skills → diagnosticTracker → fileHistory → read → `assertWriteFileStateFresh` → mkdir → `writeTextContent(..., 'LF')` → LSP → `readFileState.set(normalizeForComparison)` → gitDiff gated on `CLAUDE_CODE_REMOTE` only. `mapToolResult` appends the modified-note + `FILE_STATE_CURRENT_NOTE`.

### 4.3 `src/tools/FileEditTool/FileEditTool.ts` (+ `utils.ts`, `constants.ts`, `types.ts`)

`validateInput` flow to 2.1.228 parity: same-string-equal (1) → edit-deny (2) → `cVt` read-deny (13 + ask) → UNC → size/perforce (10/11) → `readFileBytes` + `normalizeForComparison` → ENOENT (4) → empty old_string (3) → `.ipynb` (5) → hypothetical read gate (`guardSkipped` + `tengu_edit_tool_not_read_hypothetical` + errorCode 6) → staleness block (mtime > read timestamp and not-full-read-content-match) with **recovery** (`wouldApply==='applies' && wouldReadBeAutoAllowed` + `tengu_edit_tool_stale_read` telemetry, else errorCode 7) → `findActualString` (errorCode 8, conditional `\n(note: Edit also tried swapping \uXXXX escapes...)` via `bvp`) → multi-match (9) → settings-file validation. `call()`: `cVt` throw → `checkEditFileStateAtCall` → `staleRecovered` in output data + trailing note. `outputSchema` gains `staleRecovered: z.boolean().optional()`.

Dead code removed (superseded by the guard): `isStaleReadRecoverable` (old `U9i` guard) + its 3 imports from `utils.ts`; `FILE_UNEXPECTEDLY_MODIFIED_ERROR` from `constants.ts`.

### 4.4 `src/screens/REPL.tsx` — item #16

`TITLE_ANIMATION_FRAMES` `['⠂','⠐']` → `['◐','◑']` (2.1.228 `iWi`; changelog "Updated terminal title busy-spinner glyphs to reduce tab-bar jitter on some terminals"). Prefix/interval unchanged (binary `sWi="✳"`, `P3h=960`).

### 4.5 `src/components/AutoModeOptInDialog.tsx` + `src/screens/REPL.tsx` — item #18

Constants split to the official `_3h` shape (`AUTO_MODE_BASE_DESCRIPTION` / `AUTO_MODE_COST_SENTENCE` / `AUTO_MODE_SAFETY_SENTENCE`; `AUTO_MODE_DESCRIPTION` and new `AUTO_MODE_DESCRIPTION_WITHOUT_COST_SENTENCE`; new `getAutoModeDescription()` — subscription-aware per official `NmH`). Consumers: the opt-in dialog body and the REPL first-use auto-mode notice.

**Documented divergences (pre-existing, unchanged this round):** OCC's first-use notice keeps its `TRANSCRIPT_CLASSIFIER`-gated, count-based (×3) shape and `'warning'` level — official is a one-shot `'notice'` posted via `shouldShowAutoModeEntryWarning`; OCC's opt-in dialog itself ("Enable auto mode?") persists from the 2.1.200 port while upstream removed that dialog entirely when auto mode became the default (before 2.1.227). Neither divergence is part of the 227→228 delta.

## 5. Tests

- `src/tools/FileEditTool/__tests__/staleReadRecovery.test.ts` rewritten around the `Mwt` semantics (19 tests / 42 expect): classifier suite, guard-helper suite (model tables incl. canonical bridging, notebook path, BOM/CRLF normalization, full-read semantics, telemetry mapping), and end-to-end `validateInput` stale-read recovery under permission modes — default mode outside cwd fails stale (errorCode 7), `bypassPermissions` recovers, explicit `Read(/<tmpDir>/**)` allow rule recovers in default mode, removed target fails stale even in bypass, bare `Read` deny blocks with errorCode 13. Includes the `MACRO.VERSION` polyfill the permission path needs (mirrors `cli.tsx`).
- Full `bun test src`: **1857 pass / 0 fail / 4405 expect() / 199 files** (baseline entering: 1848/0/4375/199).
- e2e gate subset: `occ-versioning` + `commands-alignment` + `resume-interrupted-turn-221` (7 pass), then the 6 × `version-2.1.219-*` + `cleanupPeriodDays-zero` + `disk-error-log` + `resume-command-name` + `occ-update-argv` + `husky-protected` (63 pass / 1 fail). The single failure (`resume-command-name` PTY, 20 s stall) is **pre-existing**: git-stash A/B run on the untouched baseline fails identically (sandbox PTY constraint, same class as OCC-11's documented TUI deferral).
- Build: `bun run build` green — `dist/cli.js` **28.88 MB**.

## 6. Live acceptance (fresh build, run like a human)

- `bun dist/cli.js --version` → `OCC 2.1.298`.
- `echo "say PONG" | bun dist/cli.js -p` → `PONG`, exit 0 (headless path end-to-end with a live key).
- tmux REPL boot green: welcome chrome (`OCC v2.1.298 · Open C Code`), model + project lines, prompt, auto-mode footer.
- **Item #16 live-verified**: during a live query the pane title cycled `◐ …` / `◑ …` (new frames), then settled; the query completed and the REPL returned to prompt.
- Security review (dedicated pass over the full diff + empirical 31-case permission probe): **no backdoor, no unintended permission bypass; matches the stated official 2.1.228 read-gate semantics.** The relaxation is confined to the read-before-write layer (`checkPermissions`/`checkWritePermissionForTool` untouched); deny rules fail closed on both tools at both validateInput and call; ask rules fail closed in default mode.

## 7. Consequence — tracked-upstream pointer & release

- Tracked-upstream pointer advances to **"fully caught up through 2.1.228"** (latest == next == 2.1.228; stable 2.1.220 long since covered).
- Staged backlog carried forward: items 1/14/15 of 2.1.228 (§2) + the §3 skip list (each needs a dedicated decompilation round) + all prior-round staged items (2.1.219 P1–P4 remainder, 2.1.221/222/223 staged sets per OCC-44/46, 2.1.227 `bashCommandClamp`/fleet-nudge/goal-proposal per OCC-85/88).
- Release **2.1.299** cut from this work (CHANGELOG + version bump + tag `v2.1.299` → `publish.yml`).
