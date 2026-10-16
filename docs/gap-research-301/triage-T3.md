# Gap triage — Claude Code 2.1.301, cluster T3

Entries: #4, #15, #16, #25, #28, #29, #33, #34, #35, #36, #37, #38, #39, #41, #42, #43, #44, #45, #46–#51.

Method: marker-string search in `/tmp/cc-diff-301/{new_strings,removed_strings,s300s,s301s}.txt`, byte offsets via `grep -aboF` on the two official binaries (`v300/package/claude`, `v301/package/claude`, never executed), bounded `dd` excerpts (~600 bytes), then OCC-side `grep -rn` under `occ/src/`. Dispositions: **PORT** / **ALREADY-ALIGNED** / **STAGED** / **N-A** / **CAND**.

Disposition summary: PORT ×5 (#15, #25, #28, #33, #39) · ALREADY-ALIGNED ×1 (#29) · N-A ×15 (#4, #34, #36, #37, #38, #42, #43, #44, #45, #46–#51) · CAND ×3 (#16, #35, #41).

---

## #4 — mod `Input.rows` multiline field

**Changelog:** Added `rows` to a mod's `Input`: a text field of several lines in the terminal, where Enter submits and Shift+Enter or a backslash before Enter starts a new line.

**Disposition: N-A** (mods subsystem absent from OCC).

**Binary evidence:** v301 contains the mods input machinery; OCC-side fresh greps for the mod-API surface markers all return 0 hits: `virtualText`, `promptDecoration`, `$.ui`, `prompt.submit`, `agent.spawn`, `prompt.change`, `prompt.edit`, `model.fork`, `env.set` — 0 occurrences anywhere in `occ/src/`. OCC does not implement the mod plugin API at all, so an added `rows` property on mod `Input` has no landing surface.

**OCC-side:** none — no mod runtime exists. (Cross-check: this matches the mod-related N-A dispositions of #34, #43, #44, #45 below.)

---

## #15 — VTE < 0.53 stray `>0q` / `>4m`

**Changelog:** Fixed stray characters such as `>0q` covering the folder trust prompt, and `>4m` before the shell prompt at exit, in terminals built on VTE older than 0.53 such as MATE Terminal on RHEL 8.

**Disposition: PORT** (complexity M).

**Binary evidence (v301-only strings; v300 = 0 hits):**
- Log string `XTVERSION: not asked (VTE before 0.53 would show the query as text)` — v301 only, @103383416 and @231943157.
- Capability gate (dd excerpt, v301):
  `hasUnknownSequencePrintingBug(r){return this.isVteBasedTerminal(r)&&Number.parseInt(this.proc.env.VTE_VERSION??"",10)<5300}`
- Probe batch is gated (dd excerpt): `R=!b6(),[T,D,A,H]=await Promise.all([R?n.send(Q5o()):Promise.resolve(void 0),...])` — when the bug flag is set, XTVERSION (and the kittyKeyboard / extendedKeys / programStatus probes) are replaced with `Promise.resolve(void 0)`.
- Capability-init early return: `{settled:!1,source:\`env: terminal=${e}, VTE before 0.53 (shows the query as text)\`}` — the capability record states why nothing was probed.

Old VTE (< 0.53) doesn't parse XTVERSION (`CSI > 0 q`) / modifyOtherKeys (`CSI > 4 m`) style sequences and echoes them as text — hence the stray `>0q` on the trust prompt and `>4m` at exit.

**OCC-side findings:**
- `occ/src/ink/terminal-querier.ts:126-131` — `xtversion()` builds `csi('>0q')` unconditionally; the querier itself has no terminal-family gate.
- OCC already knows VTE: `occ/src/utils/env.ts:204` (`if (process.env.VTE_VERSION) return 'vte-based'`), `occ/src/ink/terminal.ts:116` reads `VTE_VERSION`.
- Precedent exists: `occ/src/ink/termio/osc.ts:119,200` carry a "CC 2.1.296 #017 older-VTE guard" for OSC probes — the same pattern, one version earlier.

**Implementation note:** add a `hasUnknownSequencePrintingBug()`-equivalent predicate (isVteBasedTerminal && parseInt(VTE_VERSION) < 5300) and gate the startup probe batch — XTVERSION, kitty keyboard flags, modifyOtherKeys (`>4m`), and any DECRQM probes that old VTE echoes — resolving `undefined` without writing. Mirror the official `source: "env: terminal=…, VTE before 0.53 (shows the query as text)"` capability-init short-circuit so status reporting shows the skip reason. Landing points: probe batch caller (wherever `xtversion()` is sent at startup — App/terminal init), `occ/src/ink/terminal.ts` (predicate next to the VTE_VERSION read), `occ/src/ink/termio/osc.ts` guard family.

---

## #16 — iTerm2 stray `GOK` at startup

**Changelog:** Fixed stray `GOK` text appearing in the prompt at startup in some versions of iTerm2.

**Disposition: CAND** (no recoverable binary delta).

**Binary evidence:** all candidate markers are count-balanced v300↔v301: `GOK` 1→1, `XTGETTCAP` 0→0, `iterm` 54→54, `iTerm` 100→100. The only startup-probe delta found anywhere in the capability/probe region is the VTE gate from #15. `GOK` is iTerm2's DCS-level "unrecognized command" terminator reply (e.g. to XTGETTCAP or a DCS query it doesn't support); the official fix is most plausibly inside the same probe-gating rework as #15 (suppressing a DCS probe whose error reply leaks) or in bytecode-only code, and cannot be confirmed from string deltas.

**OCC-side:** OCC sends no XTGETTCAP (0 hits). If OCC ever leaks `GOK`, it would come from an unmatched DCS reply; OCC's querier swallows unsolicited responses (`terminal-querier.ts:265` "silently dropped"), which structurally cannot print them.

**Recommendation:** CAND — revisit after #15 lands; if the official gate also suppresses the iTerm-probing sequence, #16 comes free. No standalone OCC action justified without evidence.

---

## #25 — header-only Markdown table too wide draws nothing

**Changelog:** Fixed a Markdown table with only a header row drawing nothing when too wide for the terminal, including in plans on the plan approval card.

**Disposition: PORT** (complexity S).

**Binary evidence:** located via cluster-count on `header.map` (v300: 4 hits @2419944xx region; v301: 5 hits @2444518xx–2444530xx — the extra occurrence is the fix).

v300 vertical-fallback builder (@241994100 region, dd excerpt):
```js
function Y(){return{kind:"vertical",headers:o.header.map((M)=>b(M.tokens).trim()),
rows:x.map((M)=>M.map((O)=>k(O.tokens))),truncatedCount:c}}
```
v301 (@244451500 region, dd excerpt):
```js
function z(){if(x.length===0)return{kind:"vertical",headers:[],
rows:[o.header.map((M)=>k(M.tokens))],truncatedCount:c};
return{kind:"vertical",headers:o.header.map((M)=>b(M.tokens).trim()),
rows:x.map((M)=>M.map((N)=>k(N.tokens))),truncatedCount:c}}
```
**The fix:** when the table has zero body rows, the headers become a single keyless data row (`headers:[]`, `rows:[[...headerTokens]]`) instead of a vertical view with an empty `rows` array.

Vertical renderer `Dt` (v301 @244454250; v300 @241996550) iterates rows (`p.forEach`) and pairs each cell with header label `i[T]||""` — with `rows:[]` it emits nothing → the v300 blank-screen bug. Vertical fallback triggers confirmed in both versions: too-wide `if(le>i-We)return Y()` and `if(V)return Y()` where `V=_()>rs` (maxRowLines > 4). Shared constants: row cap 200 (`Hr`/`Pr`), min column width 3 (`Ne`/`De`), max row lines 4 (`rs`/`ns`).

**OCC-side findings — OCC has the identical bug:**
- `occ/src/components/MarkdownTable.tsx:265` `renderVerticalFormat()` iterates `displayRows` only; with a header-only table it returns the empty string → renders nothing.
- Same fallback triggers: `useVerticalFormat = maxRowLines > MAX_ROW_LINES` (:205) and the safety check `if (maxLineWidth > terminalWidth - SAFETY_MARGIN) return <Ansi>{renderVerticalFormat()}</Ansi>` (~:350).
- Constants already aligned: `SAFETY_MARGIN=4`, `MIN_COLUMN_WIDTH=3`, `MAX_TABLE_ROWS=200` (comment: "Matches the official binary's `DYd = 200` cap"), `formatTruncationNotice` matches official `CHo`.

**Implementation note:** in `renderVerticalFormat()` (MarkdownTable.tsx ~:265), prepend the v301 zero-body-row branch: if `displayRows.length === 0`, render one row whose values are the header cells with no key labels (official shape: `headers:[], rows:[[...headers]]`). Unit test: header-only table narrower/wider than terminal; assert non-empty output containing every header text.

---

## #28 — resumed-session compaction row: ctrl+o for unloaded history; fullscreen display

**Changelog:** Fixed the compaction row in a resumed session offering ctrl+o for history that is not loaded; it now says where the earlier messages are saved, and also shows in fullscreen.

**Disposition: PORT** (complexity M).

**Binary evidence:** markers `Earlier messages are saved in` and `leadsToSummary`: v300 = 0 hits; v301 @102555400 / @102558280 / @247543837 / @247670817 and @102555488 / @247543669 / @247670128.

v300 compaction row (@245041500, dd excerpt) — unconditional ctrl+o offer:
```js
g=e(s,{marginY:1,children:r(n,{dimColor:!0,children:[p,"Conversation compacted (",m," for history)"]})})
// m = ms("app:toggleTranscript","Global","ctrl+o")
```
v301 (@247668700 region, dd excerpts):
- Summary-path scanner prompt text: `Tx="If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: "`
- `F7n(m)` walks messages → `{uuid,summary:null}` or `{uuid,summary:{transcriptPath}}` (transcriptPath parsed after `Tx`).
- Detail helper: ``function dd(m,d){if(m===null)return` (${d} for history)`;return m.summary===null?"":` (${d} for the summary)`}`` and `dGr(m,d,g){let f=F7n(m);return dd(f?.uuid===d?f:null,g)}`.
- Component `pd`: `f=ci()` (fullscreen check), `M=Ee(_zt)` (React context `{uuid, summary:{savedIn}}`), `b = M!==null&&M.uuid===d.uuid ? M : null`, `C=b?.summary?.savedIn`, `U={file:C,shown:ts(C)}` guarded by `xzt(C)`, `O = f && b===null` (fullscreen && no summary context) → `if(O){return null}`.
- Fullscreen branch: `if(g&&Jm(d.compactMetadata,O))` → `W=b&&{leadsToSummary:b.summary!==null,savedIn:U?.shown}` → row `Zm(d.compactMetadata,h,W)` rendered via `e(Ne,{row:j,addMargin:!0})`.
- Row builder `Zm(m,d,g)` (@247543300): `f` = "N message(s) summarized" / "X tokens summarized" / null from `m.messagesSummarized`/`m.preTokens`; `h = g===null ? (f?"to see them":"for history") : g.leadsToSummary ? "for the summary" : null`; returns `{tone:"dim",text:"Compacted",detail:h===null?f??void 0:f?`${f} (${d} ${h})`:`${d} ${h}`, ...g?.savedIn!==void 0 && {subLines:[`Earlier messages are saved in ${g.savedIn}`]}, linkify:!1}`.
- Gate: `Jm(m,d){return m!==void 0&&!(d&&m.trigger==="manual")}`.
- Classic (non-fullscreen) path renders `✻ Conversation compacted` + `dd(b,h)` and a subline column: `["Earlier messages are saved in"," ",e(zS,{filePath:U.file,children:U.shown})]` in a Box `marginY:1`.

Net semantics: a compact boundary whose pre-compaction messages are NOT loaded (resumed session) must not advertise ctrl+o; instead it shows where the earlier messages live (transcript path from the summary message), and the row now also renders in fullscreen mode.

**OCC-side findings:**
- `occ/src/components/messages/CompactBoundaryMessage.tsx:10` — unconditional `<Text dimColor={true}>✻ Conversation compacted ({historyShortcut} for history)</Text>`. No resumed-session awareness, no savedIn subline, no fullscreen variant → both halves of the bug exist in OCC.
- `occ/src/screens/REPL.tsx:5355` — the compaction notification `Conversation summarized (${historyShortcut} for history)` is the second landing point.
- `occ/src/screens/REPL.tsx:2816-2830` — fullscreen keeps pre-compact scrollback (Messages.tsx skips the boundary filter in fullscreen), so OCC's fullscreen already displays history; the "also shows in fullscreen" half still applies to the row/notification rendering path.

**Implementation note:** port the v301 shape: (1) a scanner equivalent to `F7n` that finds the summary/transcript-path message following the boundary (OCC must persist a transcript path in the summary message text or compact metadata); (2) `dd`-style detail selection — `(ctrl+o for history)` only when history is actually loaded, `(… for the summary)` when a summary exists, else saved-path subline "Earlier messages are saved in <path>"; (3) a `_zt`-equivalent context (or prop) carrying `{uuid, summary:{savedIn}}` from REPL into CompactBoundaryMessage; (4) render the boundary row in fullscreen mode (respecting the `Jm` gate: skip manual-trigger rows in fullscreen when no context). Landing: `CompactBoundaryMessage.tsx`, `REPL.tsx:5355` notification, plus wherever compact metadata/summary messages are produced.

---

## #29 — "new task? /clear to save tokens" hint returns after interrupt

**Changelog:** Fixed the "new task? /clear to save tokens" hint coming back right after you interrupt a response.

**Disposition: ALREADY-ALIGNED.**

**Binary evidence:** official idle-hint clock base changed v300→v301: `#f(){return Math.max(this.#t.lastQueryCompletionTime,this.#i)}` → v301 adds `this.#t.lastTurnStopTime` to the max. The official bug: `lastQueryCompletionTime` was only refreshed on natural completion, so an interrupt left the stale timestamp and the idle hint fired immediately.

**OCC-side findings:** OCC refreshes `lastQueryCompletionTime` in the query `finally` block — `occ/src/screens/REPL.tsx:3167` (`if (queryGuard.end(thisGeneration)) { setLastQueryCompletionTime(Date.now()); ... }`, state at :1586). The hint timer effect (:4295-4340, deps `[lastQueryCompletionTime, isLoading, ...]`, notification key `idle-return-hint`, thresholds CLAUDE_CODE_IDLE_TOKEN_THRESHOLD / CLAUDE_CODE_IDLE_THRESHOLD_MINUTES) therefore restarts after interrupts. OCC's finally-refresh structurally covers the interrupt path that the official `lastTurnStopTime` addition patches.

**Action:** none. (Optional: leave a comment at REPL.tsx:3167 noting official v301 fixed the same bug via `lastTurnStopTime` — documentation only.)

---

## #33 — dim text: dark-ANSI theme / 16-color fixes

**Changelog:** Fixed dim text on the dark ANSI theme and 16-color terminals: faint inside filled boxes, not faint under selection and search highlights, and list descriptions dimmed like other secondary text.

**Disposition: PORT** (complexity S; sub-fix 2 partially CAND — see below).

**Binary evidence:** the faintInk dim-emulation condition changed. v300 `h6e` @219912817 (dd excerpt):
```js
if(i.faintInk&&i.faintInk===i.color&&!i.bold&&!i.dim&&!i.backgroundColor&&!i.inverse&&M.has(i.color))e=he.dim(e);
```
v301 `o5e` @220863168:
```js
if(e.faintInk&&e.faintInk===e.color&&!e.bold&&!e.dim&&!e.inverse&&B.has(e.color)&&(!e.backgroundColor||B.has(e.backgroundColor)))i=he.dim(i);
```
**The delta:** `!backgroundColor` (never dim on any bg) → `(!backgroundColor || tracker.has(backgroundColor))` — dim is applied when a background is present *if the color-capability tracker knows that bg color* (i.e. it's one of the terminal's real palette colors, so faint emulation stays correct inside filled boxes). `M`/`B` is the whitish/dark color-capability tracker class (`has(color)`).

Sub-fix mapping: (1) "faint inside filled boxes" = the bg clause above; (2) "not faint under selection/search highlights" — selection/search backgrounds are RGB (non-trackable), so `B.has(bg)` is false → no faint; the same condition implements this, no separate code found; (3) "list descriptions dimmed like other secondary text" — no isolated delta recovered beyond the same condition (CAND for a separate call-site change; the colorize-level fix covers the described symptom class).

**OCC-side findings:**
- `occ/src/ink/colorize.ts:218` — `const whitishColors = new WhitishColorDetector()` (OCC's tracker equivalent).
- `occ/src/ink/colorize.ts:262-278` — OCC carries the **v300-shape** condition, with the comment "CC 2.1.300 changelog #47 — official v300 `h6e` @219912500... byte-verified" (i.e. OCC aligned to v300's version of this exact line last round).

**Implementation note:** one-line change at colorize.ts:262-278: replace `!styles.backgroundColor` with `(!styles.backgroundColor || whitishColors.has(styles.backgroundColor))` and update the provenance comment to v301 `o5e` @220863168. Test: dim text inside a filled box on a 16-color/dark-ANSI palette renders faint; dim text under an RGB selection highlight does not.

---

## #34 — mod `$.model.fork` nothing-to-fork

**Changelog:** Fixed a mod's `$.model.fork` returning `nothing-to-fork` when called before the first response of a new Claude Code process had finished, as in `claude -p` runs and cloud sessions.

**Disposition: N-A** — mods API absent. Fresh grep: `model.fork` = 0 hits in `occ/src/`. No landing surface (see #4).

---

## #35 — fullscreen `/compact` UI freeze

**Changelog:** Fullscreen mode: Fixed `/compact` and auto-compact briefly freezing the UI while the visible transcript is rebuilt.

**Disposition: CAND** (pure performance fix; no recoverable string delta).

**Binary evidence:** every marker tried is count-balanced v300↔v301 (compact/transcript-rebuild vocabulary unchanged). The v301-new "Compacted" cluster (@112298706 / @112323806) and the 242.7–243.2M region (`sendsOfItsCompactedTurn`) are queue/turn-merge logic, not the fullscreen rebuild path — they belong to turn-compaction bookkeeping, not #35. The fix is almost certainly algorithmic (incremental/batched transcript rebuild or memoization) inside code whose strings didn't change.

**OCC-side:** OCC fullscreen keeps pre-compact scrollback (`REPL.tsx:2816-2830`) — a different strategy that may not have the same freeze. No action without evidence; if OCC ever reports a /compact freeze in fullscreen, profile the transcript rebuild first.

---

## #36 — self-hosted runner: Slack sessions + `deniedMcpServers`

**Changelog:** Self-hosted runner: Fixed sessions started from Slack being unable to find or attach a repository when managed settings restrict MCP servers; use `deniedMcpServers` to keep those tools off.

**Disposition: N-A** — OCC has no self-hosted runner. `occ/src/self-hosted-runner/main.ts` and `occ/src/environment-runner/main.ts` are 3-line auto-generated stubs.

**Binary evidence (recorded for completeness):** `deniedMcpServers` v300 = 52 hits → v301 = 54 (+2, the new managed-settings key path). No OCC consumer.

---

## #37 — self-hosted runner: false deleted-source-branch

**Changelog:** Self-hosted runner: Fixed sessions being reported as having a deleted source branch, and not retried, when an unrelated setup or session failure quoted git's missing-ref wording.

**Disposition: N-A** — runner stubs (see #36). The fix is in runner-side error classification of git's missing-ref wording; no OCC surface.

---

## #38 — self-hosted runner: retry-log count

**Changelog:** Self-hosted runner: Fixed the log promising a retry of a failed or declined session release for a session that is ending; repeated failures now show a count.

**Disposition: N-A** — runner stubs (see #36). Logging-only change inside the runner.

---

## #39 — Windows: stopped background PowerShell commands missing `[killed]`

**Changelog:** Windows: Fixed stopped background PowerShell commands missing the closing `[killed]` line in their output file.

**Disposition: PORT** (complexity M) — the *PowerShell/Windows* framing is structural-only in OCC, but OCC is genuinely missing the trailer mechanism for **all** killed background shells (bash included), which is the substance of the fix.

**Binary evidence:** `appendTrailer` s300 = 0 hits → s301 = 3 (new API). `[killed]` v301 @101373909 / @222257185 / @262333259 vs v300 @106897081 / @227579932.

v301 (dd excerpt):
```js
function bWn(e,n){let i=pt(e);
if(n==="killed")i.appendTrailer(`\n[killed]\n`,"killed");
else i.appendTrailer(`\n[exited with code ${n.exitCode??"unknown"}]\n`,"exited")}
```
v300 wrote the trailer only on one path: `if(!r.isAdopted)wUe(e,`\n[killed]\n`)` — adopted (Windows PowerShell chain) tasks skipped it, which is the changelog bug. v301 routes every stop through the typed `appendTrailer(text, kind)` on `DiskTaskOutput`, with kinds `"killed"` and `"exited"`.

**OCC-side findings:**
- `occ/src/tasks/LocalShellTask/killShellTasks.ts:25-68` — `killTask`: `task.shellCommand.kill()` or `treeKill(task.pid,'SIGKILL')`, sets `status:'killed'`, then `void evictTaskOutput(taskId)` — **no trailer is ever written** to the output file. OCC reproduces the v300-era gap for every platform.
- `occ/src/utils/task/diskOutput.ts` — `append()` :148, `appendTaskOutput` :393, `evictTaskOutput` :413; no `appendTrailer` mechanism exists.
- `occ/src/tasks/LocalShellTask/shellTaskResult.ts:30-50` — documents the PowerShell chain as "STRUCTURAL-ONLY... OCC on linux/macos spawns bash only and has no PowerShell producer" and the `RV = { memory_pressure: ... }` stopCause table as having no OCC producer. So the literal Windows bug is N-A, but the trailer write is portable and user-visible (a killed `run_in_background` bash task's output file currently ends mid-stream with no `[killed]` marker).

**Implementation note:** add `appendTrailer(text, kind)` to OCC's DiskTaskOutput (diskOutput.ts) — a typed append that records the trailer kind in task state — and call it from `killTask` (killShellTasks.ts) with `\n[killed]\n` before evicting output, and from the natural-exit path with `\n[exited with code N]\n` where OCC tracks exit codes. Guard: write the trailer before `evictTaskOutput` so it lands in the file readers see. Test: start a background bash task, kill it, assert the output file ends with `[killed]`.

---

## #41 — subagent progress-trail incremental rendering

**Changelog:** Improved rendering performance while a long-running subagent works: its progress trail now updates incrementally instead of being reprocessed in full on every render.

**Disposition: CAND** — official implementation lives in bytecode (no recoverable JS delta); OCC has the *old* full-reprocess shape and could adopt the improvement blindly, but per discipline there is no binary evidence for the exact official mechanism.

**Binary evidence:** `writeSubagentProgress`-region hits land in the Bun symbol-name table (~101M, not extractable JS); string deltas balanced. Only the changelog itself describes the change.

**OCC-side findings:** `occ/src/tools/AgentTool/UI.tsx:248-262` — `buildSubagentLookups(progressMessages.filter(...).map(...))` is memoized on `$[0] !== progressMessages` (array identity), so every new progress message re-filters/re-maps the entire trail — the exact "reprocessed in full on every render" pattern the official fix removes.

**Recommendation:** opportunity, not a verified port. If pursued: memoize per-message (append-only accumulation keyed by message uuid) instead of whole-array identity. Mark CAND; revisit when a future version exposes the mechanism in plain JS or when profiling shows real cost.

---

## #42 — artifact sticky-header band (mobile)

**Changelog:** Improved artifacts: pages Claude writes now paint the band above a sticky header, so scrolled text no longer shows there in the mobile apps.

**Disposition: N-A** — OCC has no artifact publish pipeline. `occ/src/tools/ReviewArtifactTool/ReviewArtifactTool.ts` is a 3-line stub ("Auto-generated stub — replace with real implementation").

**Binary evidence (recorded for future artifact work):** the official artifact skeleton changed — band snippet `content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10` s300 = 0 → s301 = 2 (s301 L68929; new_strings L4910/L11439); `body::before` 1→3; `safe-area` 8→9; publish head reset `Uo="<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}"+ts` (s301 L273373/L275264); authoring guidance string "a sticky page header uses `top: env(safe-area-inset-top, 0px)`, not `0`, with the band above it painted by a fixed `body::before`" (s301 L319702). Preserve these offsets if/when OCC builds artifact publishing.

---

## #43 — mods question-dialog tree: Markdown + 48 rows

**Changelog:** Improved mods: in VS Code and the desktop and mobile apps, a tree drawn above the question dialog can now hold Markdown and up to 48 rows; the terminal keeps 12 plain rows.

**Disposition: N-A** — mods question-dialog API absent from OCC (0-hit greps for `$.ui`, `prompt.submit`, etc. — see #4). The terminal-side limit (12 plain rows) matches the mod API OCC doesn't implement.

---

## #44 — mod hook `.catch` semantics

**Changelog:** Changed a mod hook's `.catch` handler to run only when the hook throws or times out; events raised beneath the hook's own calls now skip that hook without asking its `.catch`.

**Disposition: N-A** — mod hook runtime absent (see #4). Not to be confused with OCC's plugin/Claude Code hooks (`PreToolUse` etc.), which have different semantics and no `.catch` registration API.

---

## #45 — mod `$.env.set` resolution shape

**Changelog:** Changed a mod's `$.env.set` to resolve with `{}` once the variable is set or unset, or with `{ deny }` saying why when the write is not made.

**Disposition: N-A** — `env.set` 0 hits in `occ/src/`; mod API absent (see #4).

---

## #46–#51 — [VSCode] entries

**Changelog:** #46 LaTeX math rendering; #47 "Get more usage" link in usage-limit banner; #48 crash-loop conversation reopen fix; #49 chat panel thinking-text re-parse perf; #50 diagnostics "[object Object]" rule-code fix; #51 native dictation audio module load gating.

**Disposition: N-A ×6** — OCC has no VS Code extension. Repo-root listing confirms: no `extensions/`, no `vscode/` directory (root contains bin, docs, fixtures, packages, patches, scripts, src, test + config files only). All six entries live entirely in the official extension bundle, which is not part of the CLI binary delta either.

---

# Cross-entry observations

1. **Mods API is the biggest structural gap in this cluster** (#4, #34, #43, #44, #45 — five entries, all N-A). If OCC ever implements the mod plugin surface, all five become live at once; none is worth partial groundwork now.
2. **The v301 probe-gating rework (#15) is the one confirmed terminal-capability delta**; #16 (iTerm2 GOK) is most likely a side-effect of the same rework but is unprovable from strings — land #15 first, then re-check #16.
3. **escCount/autoCompactOffer persisted-state subsystem** is v301-new (string evidence) but belongs to another cluster's entries — flagged here so the orchestrator can assign it; NOT part of T3.
4. **Chunk-rename noise is pervasive**: balanced new==removed string counts across v300/v301 for most vocabulary; the cluster-count technique (counting pattern occurrences in a byte region, e.g. `header.map` 4→5) was decisive for #25 and is the recommended method when strings balance.
5. **#33 is a one-line follow-up to last round's #47 port** — OCC's colorize.ts already carries a byte-verified v300 provenance comment at the exact line that changed; cheapest PORT in the cluster.
6. **#39's Windows framing hides a universal gap**: OCC never writes `[killed]`/`[exited with code N]` trailers to background-task output files on any platform; the v301 `appendTrailer(text, kind)` API is small and fully recovered.
7. **Region map for future work**: table renderer ~244.4M (v301), compaction rows ~247.5–247.7M, faintInk ~220.9M, capability/probe logs ~103.4M & ~231.9M, artifact CSS ~s301 L68929/L273373.

# PORT complexity summary

| Entry | Complexity | Landing points |
|---|---|---|
| #25 header-only table | **S** | `MarkdownTable.tsx` renderVerticalFormat (~:265) |
| #33 faintInk bg clause | **S** | `colorize.ts:262-278` |
| #15 VTE<0.53 probe gate | **M** | `terminal-querier.ts` callers, `terminal.ts:116`, `termio/osc.ts` guard family |
| #28 compaction row savedIn + fullscreen | **M** | `CompactBoundaryMessage.tsx`, `REPL.tsx:5355`, summary-message producer |
| #39 appendTrailer [killed]/[exited] | **M** | `diskOutput.ts`, `killShellTasks.ts:25-68` |
