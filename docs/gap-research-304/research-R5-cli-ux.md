# R5 — CLI HELP / UX TEXTS / SMALL FIXES (official 2.1.303 → 2.1.304)

Research subagent R5. Static byte forensics only — official binaries were never executed.

- Official 2.1.303 ELF: `/tmp/cc-diff-304/vprev/package/claude` (285,809,912 bytes)
- Official 2.1.304 ELF: `/tmp/cc-diff-304/vver/package/claude` (288,730,480 bytes)
- String diffs: `/tmp/cc-diff-304/new_strings.txt` (304 chunks), `removed_strings.txt` (303 chunks). Line numbers pair as 303↔304 versions of the same module.
- OCC: this repo @ 2.1.393 (aligned to official 2.1.303), HEAD = origin/main 87974fd7.

Verdict vocabulary: **PORT** (apply now), **STAGED** (port behind flag / later), **N-A** (not applicable to OCC), **ALREADY-ALIGNED** (OCC behavior already matches 304).

## Verdict table

| # | Changelog item | Verdict |
|---|---|---|
| 29 | help text: `--tools`, `--resume`, `--debug`, `--json-schema`, `--disable-slash-commands`, `--system-prompt-snapshot`, `claude update` | **PORT** ×6, **N-A/STAGED** ×1 (`--system-prompt-snapshot`) |
| 17 | path display `../../…` → `~/…` | **PORT** |
| 33 | /effort guessed level | **PORT** |
| 36 | AskUserQuestion notes truncation <100 cols | **PORT** |
| 40 | transcript mode `{`/`}` row placement | **N-A** (OCC has no `{`/`}` transcript nav) |
| 42 | Ctrl+C agents-view selection cleared without copying | **ALREADY-ALIGNED** (OCC ctrl+c always copies) |
| 43 | /usage rate-limit end time | **PORT** |
| 49 | `claude -p` invalid-settings warning capping | **PORT** |
| 64 | removed "(research preview)" from /fast title on Opus 5.5 | **ALREADY-ALIGNED** |
| 8 | org policy refresh after API-key approval | **PORT** |
| 27 | Consumer Terms notice skipped after server error | **PORT** |
| 28 | /privacy-settings choices after server error | **PORT** |

---

## Item #29 — `claude --help` text corrections (changelog line 31)

> "Fixed `claude --help` text for `--tools`, `--resume`, `--debug`, `--json-schema`, `--disable-slash-commands`, `--system-prompt-snapshot` and `claude update` to match actual behavior"

All offsets are byte offsets into the ELF (`grep -aboF` verified). Help option-definition region: 303 ≈ 117.8M, 304 ≈ 119.0M. `--system-prompt-snapshot` description is stored UTF-16LE.

### Full 7-flag table (verbatim, 303 → 304)

| Flag | 303 offset | 304 offset | 303 text | 304 text | OCC current | Verdict |
|---|---|---|---|---|---|---|
| `--tools <tools...>` | @117853072 | @119005264 | `Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").` | same but `"default" to use the default set` | `src/main.tsx:1082` = 303 text | **PORT** |
| `-r, --resume [value]` | @117857268 | @119009460 | `Resume a conversation by session ID, or open interactive picker with optional search term` | `Resume a conversation by session ID or name, or open interactive picker with optional search term` | `src/main.tsx:1094` = 303 text | **PORT** |
| `-d, --debug [filter]` | @117847436 | @118999612 | `Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")` | `Enable debug mode with optional category filtering (e.g., --debug=hooks,mcp or --debug='!hooks,!mcp')` | `src/main.tsx:1065` = 303 text | **PORT** |
| `--json-schema <schema>` | @117849780 | @119001972 | `JSON Schema for structured output validation. Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}` | `JSON Schema for structured output validation (only works with --print). Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}` | `src/main.tsx:1070` = 303 text | **PORT** |
| `--disable-slash-commands` | @117863476 | @119015676 | `Disable all skills` | `Disable all skills and commands` | `src/main.tsx:1144` = 303 text | **PORT** |
| `--system-prompt-snapshot <on\|off>` (UTF-16LE) | @117854840 | @119007036 | `Record the system prompt once per conversation and reuse it verbatim on every request and resume. on (the default): the prompt is rendered on the conversation's first request — a --system-prompt or --append-system-prompt included — sent, and recorded; every later request and resume sends the record as-is, even when a later launch passes different text, until the conversation is compacted. off: never record; … No effect where system-prompt recording is not yet enabled.` | `on (the default):` → `on (the default, except under --bare outside cloud and background sessions):`; trailing sentence `No effect where system-prompt recording is not yet enabled.` **removed** | Not an OCC Commander help option — only a passthrough flag (`src/utils/argvBackgroundFlag.ts:51`) | **N-A/STAGED** |
| `update` (command) | @127994780 (dups @253344606/@256069289) | @129224248 (dups @256069289-region) | `Check for updates and install if available` | `Check for updates and install if available; package-manager installs update through the package manager` | `src/main.tsx:5072` = 303 text | **PORT** |

### Recipe (PORT ×6)

Single-file edit in `src/main.tsx`:
1. `:1082` — `"default" to use all tools` → `"default" to use the default set`
2. `:1094` — `by session ID,` → `by session ID or name,`
3. `:1065` — replace example: `(e.g., "api,hooks" or "!1p,!file")` → `(e.g., --debug=hooks,mcp or --debug='!hooks,!mcp')`
4. `:1070` — insert `(only works with --print)` after `structured output validation`
5. `:1144` — `Disable all skills` → `Disable all skills and commands`
6. `:5072` — append `; package-manager installs update through the package manager`

`--system-prompt-snapshot`: no OCC help entry to fix. If/when OCC adds the flag to Commander help, use the 304 text (with the `--bare` carve-out only if OCC implements `--bare` semantics; otherwise keep 303 phrasing minus the removed trailing sentence — the "not yet enabled" sentence was dropped because recording is now enabled everywhere official ships).

---

## Item #17 — path display `../../…` → `~/…` (changelog line 19)

> "Fixed Write results and rejected edits showing a file outside the working directory as `../../…`; they now show `~/…` or the full path"

### Official change

- Chunk pair: `new_strings.txt:11299` (304) ↔ `removed_strings.txt:12960` (303) — FileWriteTool render.
- 303: `M=c?o:G(ce(),i)` (naive relative-to-cwd). 304: `M=c?o:Fo(o)` wrapped in `e(Uh,{filePath:o,children:M})`.
- Helper `Fo` (`new_strings.txt:4734`), verbatim behavior:
  - path containing NUL → returns `FGr="Path hidden (unsupported characters)"` (string present in BOTH binaries: 303 @127617760, 304 @128846080 — only the *usage* is new)
  - path inside cwd → relative path
  - path under `$HOME` → `~` + home-slice
  - otherwise → full path
- Same treatment in FileEditTool (`new_strings.txt:15005`), NotebookEdit (`new_strings.txt:16641`), tool hints (`new_strings.txt:13542`).
- `Uh` component (`new_strings.txt:17195`): NUL/path-hidden check + width-truncate (`Nd`) + OSC-8 file link (`zt`).

### OCC current

- `src/tools/FileWriteTool/UI.tsx:62,392-393` and `src/components/FileEditToolUseRejectedMessage.tsx:49` use naive `relative(getCwd(), filePath)` → produce `../../…` (the 303 bug).
- OCC **already has** an equivalent helper: `getDisplayPath` in `src/utils/file.ts:155-170` (home → `~/…`, inside cwd → relative, else full path).

### Verdict: **PORT**

Recipe: switch the call sites (`FileWriteTool/UI.tsx:62,392-393`, `FileEditToolUseRejectedMessage.tsx:49`, plus grep for other `relative(getCwd(), filePath)` display sites — NotebookEdit UI, tool hints) to `getDisplayPath`. Optionally add the NUL guard (`if (p.includes('\0')) return 'Path hidden (unsupported characters)'`) to `getDisplayPath` to fully match `Fo`.

---

## Item #33 — /effort guessed level (changelog line 35)

> "Fixed `/effort status`, `/effort ultracode` and the prompt's effort indicator showing a guessed effort level when `CLAUDE_CODE_EFFORT_LEVEL` is `auto` or unset and no level is sent"

### Official change

- 303 `oR(e,n,r){let s=bw(...)?? "high"; return O0(s)}` — always guesses, defaulting to "high".
- 304 `kWe` — no fallback, may return `undefined`; request path uses `p2 = kWe ?? "high"` (guess only where a value is required).
- Indicator `EE` returns `undefined` when unknown → chip hidden.
- Status text `f6t`:
  - undefined → bare `` `Effort level: auto${r}` ``
  - known → `` `Effort level: auto (currently ${e4(o)}${E})${r}` `` with `r = " · Ultracode on"`, `E = ", set by your organization"`
- Ultracode: `f = v(t.effort) ?? kWe(r,t.effort) ?? "auto"` → prints "Effort stays auto." when unknown.
- Binary: `Effort level: auto` — 303 @121656600 ×1; 304 @122700312 + @122700376 ×2 (both the bare and the "(currently …)" template heads).

### OCC current

- `src/utils/effort.ts:442-448 getDisplayedEffortLevel` = the 303 guesser (always returns a level).
- `src/commands/effort/effort.tsx:101-112 showCurrentEffort`; `src/components/EffortIndicator.ts:47-49`.
- `getEffortSuffix` (`effort.ts:456-464`) already undefined-safe.
- No "Effort stays" string anywhere in OCC.

### Verdict: **PORT**

Recipe: make `getDisplayedEffortLevel` return `string | undefined` (drop the `?? 'high'`); hide the indicator chip when undefined; status command prints bare `Effort level: auto` when undefined else `Effort level: auto (currently X[, set by your organization])[ · Ultracode on]`; ultracode command prints "Effort stays auto." when resolution yields undefined. Request-building path keeps `?? 'high'`.

---

## Item #36 — AskUserQuestion preview notes truncation (changelog line 38)

> "Fixed notes typed into a multiple-choice question with previews being cut off with '…' in terminals under about 100 columns, hiding what was typed (anthropics/claude-code#82768)"

### Official change (chunk pair `new_strings.txt:19073` (304) ↔ `removed_strings.txt:16865` (303))

- 303 @8019: `{columns:fr,rows:dr}=Te(), tr=fr-30-4, Nr=Math.max(1,dr-26)`; notes TextInput: `showCursor:!0,columns:60,cursorOffset:Dt` — **fixed 60-col input**, wider than the available preview column under ~100 terminal cols → typed text hidden behind `…`.
- 304 @8023: `{columns:wr,rows:jr}=Ee(), rr=wr-30-4, Ar=Math.max(1,rr-ae("Notes:")-1), or=Math.max(1,jr-26)`; TextInput: `showCursor:!0,columns:Ar,maxVisibleLines:5,cursorOffset:Ht,onChangeCursorOffset:Yt,disableEscapeDoublePress:!0`; the `Notes:` label is wrapped `e(s,{flexShrink:0,children:e(n,{color:"suggestion",children:"Notes:"})})`.

Binary verification (`grep -aboF`):
- `showCursor:!0,columns:60,cursorOffset` — 303 @267447686, 304 ×0
- `showCursor:!0,columns:Ar,maxVisibleLines:5` — 304 @268936023, 303 ×0
- `Math.max(1,rr-ae("Notes:")-1)` — 304 @268934013
- `rr=wr-30-4` — 304 @268933999; `tr=fr-30-4` — 303 @267445734
- flexShrink Notes wrapper — 304 @268935589
- `placeholder:"Add notes on this design` — both (303 @267447547, 304 @268935884)

### OCC current

`src/components/permissions/AskUserQuestionPermissionRequest/PreviewQuestionView.tsx:288-292`:
```tsx
<TextInput value={notesValue} placeholder="Add notes on this design…" … showCursor={true} columns={60} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} />
```
= the 303 shape exactly. `previewMaxWidth` is already computed at `:238` (`columns - LEFT_PANEL_WIDTH(30) - GAP(4)`). Notes label at `:287` is a plain `<Text color="suggestion">Notes:</Text>`. OCC's TextInput already supports `maxVisibleLines?: number` (`src/types/textInputTypes.ts:144`).

### Verdict: **PORT**

Recipe (PreviewQuestionView.tsx):
1. `columns={Math.max(1, previewMaxWidth - stringWidth('Notes:') - 1)}` (official subtracts the rendered label width; `stringWidth` or the constant 6 both fine)
2. add `maxVisibleLines={5}`
3. wrap the `Notes:` label in `<Box flexShrink={0}>` so the input gets the remaining width
4. optional: `disableEscapeDoublePress` if OCC's TextInput supports it (official added it here)

---

## Item #40 — transcript mode `{`/`}` row placement (changelog line 42)

> "Fixed transcript mode's `{` and `}` landing the prompt on an inconsistent row, or off screen, instead of the transcript's first row"

### Official change

- Key handler itself is IDENTICAL between versions (`new_strings.txt:5841` ↔ `removed_strings.txt:5278`): `if(!it&&(Rn==="{"||Rn==="}"))…{let or=Rn==="}"?Bo.current?.nextMessage:Bo.current?.prevMessage;…}`.
- Real change is in the virtualized-list chunk pair `new_strings.txt:5122` (304) ↔ `removed_strings.txt:4678` (303):
  - 303: `Ze(se)` simple scrollToMessage (`be(se)>=0?ee.scrollTo(xt(s)):Je(se)`); `prevMessage` had a prompt-text special case `jm(ne.promptText,…)===null` branch.
  - 304: `Ot(re)` reworked jump — flushes pending delta (`Q.getPendingDelta()!==0 → Q.scrollTo(Q.getScrollTop())`), uses the rendered element's computed height/top (`Xe(re)`, `yogaNode.getComputedHeight()`, `YS(Q,Be,ct)`), records `oe.current={request:{kind:"jump",key:Ge},idx,messages,landed:{at,top,height,viewport},cancelGiveUp}` with a give-up timeout `qS`; `prevMessage` keeps you on the current prompt row and aligns it to the first row when partially scrolled off: `Ve = re===null && Xe(Q)!==null && Wm(se.promptText,Ue[Q])!==null && je(Q)+ZS(Ge)<pe.getScrollTop() ? Q : Ze(Q,-1)`.
- Binary: `request:{kind:"jump",key:` — 303 ×0 → 304 ×2 (@266615521, @266615690); `getPendingDelta()!==0` — 303 ×2 → 304 ×3 (new @266615317); `nextMessage:()=>{` — both (@265516299 / @266615889).

### OCC current

OCC has **no `{`/`}` transcript navigation at all**: `src/components/VirtualMessageList.tsx` JumpHandle (:51-54) exposes only jumpToIndex/nextMatch/prevMatch/setAnchor/setSearchQuery/disarmSearch; `src/screens/REPL.tsx:4563-4589` transcript useInput handles only `/` and n/N.

### Verdict: **N-A**

Pre-existing feature absence, not a 304 regression. If `{`/`}` prev/next-prompt jumping is ever ported to OCC, port the 304 logic (jump-request record + pending-delta flush + computed-height landing), not the 303 one.

---

## Item #42 — Ctrl+C agents-view selection (changelog line 44)

> "Fixed Ctrl+C in the agents view clearing a text selection without copying it when pressed before the mouse button was released"

### Official change (selection-module chunk pair `new_strings.txt:15751` (304) ↔ `removed_strings.txt:14611` (303))

- 303: `function JYo(d,h){return(C)=>{if(!d.hasSelection())return;if(C.key==="c"&&!C.meta&&(C.ctrl||C.superKey)){if(h)d.clearSelection();else d.copySelection();if(C.ctrl&&!C.shift)Mre();C.consume();return}if(mo(C))d.clearSelection()}}` — `h` is a **static boolean** (`copyOnSelect ?? true` captured at wiring time).
- 304: `function qXo(d,h,x){return(R)=>{…if(h.peek()!==null)d.clearSelection();else{let T=d.copySelection();if(T)x?.(T)}if(R.ctrl&&!R.shift)boe();R.consume();…}}` — `h` is the copy-on-select **tracker** `{peek,invalidate}`, `x` a feedback callback.
- Tracker identical in both versions (303 `I2e` / 304 `cVe`): resets while dragging or without selection; `peek()!==null` = already copied on mouse-up; `copyOnSelect ?? true` gate; `copySelectionNoClear()` stores text + fires feedback.
- Agents-view wiring is the fix site:
  - 303 (`removed_strings.txt:18241`): `I2e(qi,!0,(ee)=>gg(J_n(ee))),O2e(qi);let Ru=JYo(qi,ue().copyOnSelect??!0);P2e(qi)` — **tracker return discarded**, static boolean passed.
  - 304 (`new_strings.txt:21149`): `Su=(Z)=>{gg(Jwn(Z))},hg=cVe($i,!0,Su);uVe($i);let yu=qXo($i,hg,Su);dVe($i)` — tracker captured and passed with the feedback callback.
- Bug mechanism: with copyOnSelect defaulting true, 303's Ctrl+C **mid-drag** (before mouse-up, so copy-on-select hasn't fired) just cleared the selection — text lost. 304 copies it (`peek()===null` ⇒ not yet copied) and shows the "copied N chars" feedback.
- Binary: `function JYo(d,h)` — 303 @253946639 → 304 ×0; `function qXo(d,h,x)` — 304 @256925119 → 303 ×0; `JYo(qi,ue().copyOnSelect??!0)` — 303 @254220748 → ×0; `hg=cVe($i,!0,Su)` — 304 @257194280; `if(h.peek()!==null)` — 304 @256925226; `else d.copySelection()` — 303 @253946768; `.peek()!==null` — 303 ×1 @273795124, 304 ×2 @256925230 + @276712349.
- The Me log-wrapper component (`removed_strings.txt:13956` ↔ `new_strings.txt:16698`) is unchanged (literal-list diff clean; it was already peek-based in 303).

### OCC current

- OCC's ctrl+c-with-selection handler: `src/components/ScrollKeybindingHandler.tsx:623-645` — raw useInput; when a selection exists and `key.ctrl && !key.shift && !key.meta && input==='c'` → `copyAndToast()` (`:413-416`) which calls `selection.copySelection()` **unconditionally** and toasts "copied N chars…". There is no static-boolean clear-without-copy branch — the 303 bug shape does not exist in OCC.
- Mount-order comments: `src/screens/REPL.tsx:4787` and `:4928` — "ctrl+c-with-selection copies instead of cancelling the active task" (ScrollKeybindingHandler mounts before CancelRequestHandler; its handler only stops propagation when a selection exists).
- Copy-on-select tracker: `src/hooks/useCopyOnSelect.ts` (mirrors official tracker but returns void, internal `copiedRef`, no `peek`/`invalidate` API), wired at `ScrollKeybindingHandler.tsx:648`.
- FleetView (`src/components/FleetView/` — OCC's agents-view analog) has **no mouse text selection** at all (only row navigation; rg for selection/copy in FleetViewScreen.tsx/FleetView.tsx shows row-selection only).

### Verdict: **ALREADY-ALIGNED**

OCC's Ctrl+C always copies (mid-drag included) — the data-loss bug cannot occur. Residual cosmetic difference vs 304: after copy-on-select already fired on mouse-up, OCC's Ctrl+C copies the same text a second time and re-toasts, where official 304 clears instead. Optional polish (not required for alignment): expose `peek()`/`invalidate()` from `useCopyOnSelect` and in the ctrl+c branch clear-without-copy when `peek()!==null`.

---

## Item #43 — /usage rate-limit end time (changelog line 45)

> "Improved `/usage` to say when a rate limit on usage data ends instead of 'try again in a moment'"

### Official change

New in 304 (all byte-verified):
- `rate limited until ` (UTF-16LE) @120300236 — 303 ×0
- `heldUntilMs` — 303 ×0 → 304 ×7 (first @120314792)
- `Usage endpoint is ` prefix — 303 ×2 → 304 ×4 (@120314676 region)
- Formatter `fo(o)`: `o===void 0 ? "rate limited — try again in a moment" : `rate limited until ${vA(Math.ceil(o/60000)*60)}`` (minute-rounded clock time)
- `heldUntilMs` source: rate-limit memory store, set on 429/403 responses — `untilMs = Date.now() + Math.min(retryAfterMs>0 ? retryAfterMs : Ft, Ke)` (Retry-After honored, capped).

### OCC current

- `src/components/Settings/Usage.tsx:215,223,232` — static "try again in a moment"-style texts.
- `src/services/api/usage.ts:75` — has `rateLimitedVia` but **no** `heldUntilMs`.

### Verdict: **PORT**

Recipe: add `heldUntilMs?: number` to the usage rate-limit store; set it on 429/403 from Retry-After (capped, official `Math.min(retryAfterMs>0?retryAfterMs:Ft,Ke)` shape); Usage.tsx renders `rate limited until <HH:MM>` (round up to the minute) when present, keep `rate limited — try again in a moment` when absent.

---

## Item #49 — `claude -p` invalid-settings warning (changelog line 51)

> "Improved the `claude -p` invalid-settings warning: a file that did not load lists only what stopped it, and long lists are capped per file"

### Official change (composition functions extracted verbatim; 303 `PC` @261313685 region, 304 `JC` @273485431 region)

- 303 grouping: `h=new Set(s.filter(w=>w.severity!=="warning").map(w=>w.file)), S=s.filter(w=>h.has(w.file))` — the did-not-load block lists **all** entries of failed files.
- 304 grouping: `h=s.filter(w=>w.severity!=="warning")` (ONLY the blocking entries — "only what stopped it"), `S=new Set(h.map(w=>w.file))`, `y=s.filter(w=>!S.has(w.file))`.
- 303 formatter `CC(e)`: `e.slice(0,Lh=10)` + `  … and ${e.length-Lh} more` — cap per **group**.
- 304 formatter `YC(e)`: `for(let[r,s]of Map.groupBy(e,h=>h.file))` with `s.slice(0,Zh=10)` cap **per file** + `  … and ${s.length-Zh} more in ${h}`.
- File label via `Rit(r)` (304 @255645609): `if(t===void 0)return"settings";return wT()!==void 0&&t===IH()?Hmn:t`, `Hmn="--settings (inline JSON)"` (@237015263). (303 used an inline ternary `s.file===n?"--settings (inline JSON)":s.file??"settings"` — same output.)
- Skipped-entries header shortened: 303 `These settings entries were skipped because this version of Claude Code can't apply them; the rest of each file is in effect:` → 304 `These settings entries were skipped; the rest of each file is in effect:`.
- Sanitizer `e_(e)=Ms(e,{maxCodeUnits:hB=500})` unchanged; telemetry `tengu_own_settings_validation_errors` (not_loaded_file_count/skipped_entry_count) unchanged; stderr still suppressed for json/stream-json.
- Binary: long skipped text — 303 ×2 (@128918216, @261314049) → 304 ×0; short text — 303 ×0 → 304 ×2 (@130167960, @273485795); `Map.groupBy(e,(h)=>h.file)` — 0 → ×1 @273486014; `more in ${h}` — 0 → ×1 @273486207.

### OCC current

`src/utils/invalidSettingsReport.ts` (ported from official v299 `jR`, matches the **303** shape exactly):
- `:159-163` — `notLoadedFiles = new Set(reportable.filter(e=>e.severity!=='warning').map(e=>e.file))`; `notLoadedEntries = reportable.filter(e=>notLoadedFiles.has(e.file))` (lists ALL entries of failed files)
- `:107-121` — global cap `MAX_REPORTED_ENTRIES_PER_GROUP=10` + `  … and ${N} more` (per group)
- `:185` — long skipped header text
- `:180` — did-not-load text
- `:108-111` — inline-JSON label ternary
- test: `src/utils/__tests__/invalidSettingsReport076.test.ts`

### Verdict: **PORT**

Recipe (`src/utils/invalidSettingsReport.ts`):
1. did-not-load block: list only the non-warning entries themselves (`reportable.filter(e => e.severity !== 'warning')` becomes the block content; keep the file Set for grouping the skipped side).
2. skipped-block formatter: group by file (`Map.groupBy` or a manual Map for target compatibility), cap 10 per file, overflow line `  … and ${n} more in ${file}`.
3. header text → `These settings entries were skipped; the rest of each file is in effect:`.
4. update `invalidSettingsReport076.test.ts` expectations.
Telemetry/stderr-suppression semantics unchanged.

---

## Item #64 — /fast title "(research preview)" (changelog line 66)

> "Removed the '(research preview)' label from the `/fast` dialog title on Opus 5.5"

### Official change

- 303 @118384872: single literal ` Fast mode (research preview)`.
- 304 @119413010: split into ` Fast mode` + ` (research preview)`; suffix gated by `Yt=kln(Nt)||OGe(Nt)` — true only for claude-opus-4-8 or claude-opus-5, **not** 5.5.

### OCC current

- `src/commands/fast/fast.tsx:168` — unconditional `Fast mode (research preview)`-style label.
- `src/utils/fastMode.ts:145` — OCC's fast model is Opus 4.8, i.e. exactly a model where official KEEPS the suffix.

### Verdict: **ALREADY-ALIGNED**

OCC's label is correct for its model. Optional future-proofing: split the literal and gate the suffix on the model check (only matters if OCC's fast model moves to an Opus 5.5-class model).

---

## Item #8 — org policy refresh after API-key approval (changelog line 10)

> "Fixed the organization policy not refreshing until the hourly check after approving an `ANTHROPIC_API_KEY` at startup or switching 'Use custom API key' in `/config`"

### Official change (all byte-verified)

**(a) Startup approval dialog** — chunk pair `new_strings.txt:15549` (304) ↔ `removed_strings.txt:13514` (303):
- 303 (`FQn`) "yes" branch: `Ae((v)=>{…approved:[...j,a]…},s),c(!0)` — save + done, nothing else.
- 304 (`Otr`) "yes" branch: `Ae((b)=>{…approved:[...V,a]…},d),DB(),c(!0)` — **`DB()` inserted** (only on "yes", not "no").
- Binary: `DB(),c(!0)` — 304 @274989686; 303 ×0.

**(b) /config "Use custom API key" toggle** — chunk pair `new_strings.txt:15382` (304) ↔ `removed_strings.txt:13618` (303):
- 303 onChange tail: `}}),v(o6t())` (binary `v(o6t())}}]:[]` @256690767).
- 304 onChange tail: `}}),DB(),v(W5t())` (binary @259964843) — **`DB()` fires on every toggle** (on and off).

**(c) The emitter** — credentials chunk 303 `removed_strings.txt:22367` @31141-region / 304 `new_strings.txt:26242` @33487:
- 303: `var VP=new G(()=>Me());function Vh(){return VP.of(j().host)}function rle(){Vh().emit()}function K4n(e){return Vh().subscribe(e)}` — the emitter **already existed** in 303.
- 304: `var kM=new W(()=>Me());function gy(){return kM.of(j().host)}function DB(){gy().emit()}function KUt(e){return gy().subscribe(e)}` — identical infra, renamed. The fix = new **call sites**, not new infra.

**(d) Org-policy cache class watcher expansion** — `ensureCredentialWatch`:
- 303 binary @242401229: `…stopCredentialWatch=K4n(this.onCredentialMayHaveChanged);…stopTunnelEpochWatch=a1s(this.onTunnelCredentialEpoch)}` — 2 watches.
- 304 binary @244834217: `…stopCredentialWatch=KUt(this.onCredentialMayHaveChanged);…stopTunnelEpochWatch=nVs(this.onTunnelCredentialEpoch);if(this.stopRegimeRefusalWatch===null)this.stopRegimeRefusalWatch=vt(this.refetchAfterRegimeRefusal);if(this.stopKeyApprovalWatch===null)this.stopKeyApprovalWatch=tFo(this.onCredentialMayHaveChanged)}` — 4 watches.
- New fields only in 304: `stopKeyApprovalWatch` / `stopRegimeRefusalWatch` — 303 ×0 → 304 ×6 each (class fields @244804839, teardown in `stop()` @244808779).
- `tFo` (304 @239731381, NEW — 303 has only `Gln()` @237229258 and inline `z0r(Yme(n))==="approved"` in the credential getter @237228858/@237280742):
  ```js
  function vf(){try{let e=a.ANTHROPIC_API_KEY;if(!e)return!1;return A9n(Wle(e))==="approved"}catch(e){l(U(e));return}}
  function tFo(e){let n=vf(),r=[KUt(()=>{n=vf()}),x4(()=>{let s=vf();if(s!==n)n=s,e()})];return()=>r.forEach((s)=>s())}
  ```
  i.e. fire `onCredentialMayHaveChanged` whenever the ANTHROPIC_API_KEY approved-boolean flips (watching both the credential emitter and the settings-change emitter `x4`). `vf()` @239731265.
- `refetchAfterRegimeRefusal` (304, same class): HIPAA-gated debounced refetch after a "regime refusal" — **cross-cluster note**: this belongs to the org-policy/managed-settings cluster, not to the API-key fix; flag for whoever owns policy items.

### OCC current

- Org-policy analog = `src/services/remoteManagedSettings/index.ts`: background poll interval `POLLING_INTERVAL_MS = 60*60*1000` (:62) — the "hourly check".
- Immediate `refreshRemoteManagedSettings()` callers: only `src/main.tsx:2738` (post-onboarding login) and `src/commands/login/login.tsx:89` (post-/login).
- **No refresh** in `src/components/ApproveApiKey.tsx` ("yes" branch saves config + `onDone(true)`, ~:31-42) nor in `src/components/Settings/Config.tsx` apiKey onChange (~:1076-1102, ends with `setGlobalConfig(getGlobalConfig())`).
- No `onCredentialMayHaveChanged` / credential-change emitter anywhere in OCC.

### Verdict: **PORT**

Recipe (KISS — OCC has no emitter infra; direct calls match official observable behavior):
1. `src/components/ApproveApiKey.tsx` "yes" branch: after the config save, add `void refreshRemoteManagedSettings()` (official fires only on approve, not reject).
2. `src/components/Settings/Config.tsx` apiKey onChange: after `setGlobalConfig(getGlobalConfig())`, add `void refreshRemoteManagedSettings()` (official fires on both on and off).
3. Optional (full fidelity): a key-approval-flip watcher (`tFo`-style) inside remoteManagedSettings polling — skip unless OCC grows more approval paths; the two direct calls cover both official trigger points.

---

## Item #27 — Consumer Terms notice skipped after server error (changelog line 27)

> "Fixed the Consumer Terms notice being skipped for a day or longer after a server error"

Internal codename: **Grove**. Notice UI + `tengu_grove_print_viewed` / `tengu_grove_privacy_settings_viewed` telemetry / `notice_is_grace_period` / `domain_excluded` all confirmed in binaries ("Consumer Terms" ×15 in each binary — count unchanged; the fix is logic). `grove` total: 303 ×65 → 304 ×79.

### Official change — standalone Grove module (printed as its own bytecode chunk, banner `// Version: 2.1.30x`)

303 module @256456400-region (`hoe`,`Bar`,`yTt`,`Sot`,`u`,`LCe`,`jar`); 304 module @256289500-region (`ose`,`Ypr`,`yCt`,`dit`,`_`,`Hbe`,`Xpr`,`v`,`u`). Diffs:

1. **Config fetcher** — 303 `LCe` catch: `t(…);{success:!1}` (memoized failure STICKS for the session — `eo` memoize, no cache clear). 304 `Hbe` catch: `t(…),Hbe.cache.clear?.(),o instanceof v?{success:!1,errorStatus:o.status}:{success:!1}` — failure is never memoized, and HTTP status is carried out.
2. **New HTTP status guard + error class** (304 only): `class v extends x{status;constructor(e){super(`HTTP ${e}`,"Grove request answered with an error status");this.status=e}} function u(e){if(e<200||e>=300)throw new v(e)}` — applied in `ose` (settings GET), `Hbe` (config GET), `Ypr` (mark-viewed POST), `yCt` (settings PATCH).
3. **New shape validation** (304 only):
   - config GET: `if(typeof c.data?.grove_enabled!=="boolean")throw Error("Grove notice config answer has no boolean grove_enabled")`
   - settings GET: `if(r.data?.grove_enabled!==null&&typeof r.data?.grove_enabled!=="boolean")throw Error("Grove settings answer has no boolean or null grove_enabled")`
   → a server error page / proxy body can no longer be stored as `grove_enabled: undefined` (falsy) with a fresh 24h timestamp, which is what suppressed the notice "for a day or longer" in 303.
4. **mark-viewed / update-settings cache invalidation moved to `finally`** — 303 `Bar`/`yTt` cleared `hoe.cache` only on success; 304 `Ypr`/`yCt` clear `ose.cache` in `finally` (stale settings never survive a failed write).
5. **Background fetch+store** — 303 `u`: `if(!a.success)return` (no-op). 304 `_`: on failure, if `errorStatus!==void 0 && errorStatus!==401` and account is known (`lN()`) and a cache entry exists → **re-stamp the existing cached `grove_enabled` with `timestamp:Date.now()`** (server error keeps the last known-good decision alive for another 24h window instead of leaving a stale entry that re-triggers hourly).
6. `Sot`→`dit` (cache-first qualification) and `jar`→`Xpr` (should-show logic, incl. `grove_notice_viewed_at` + `notice_reminder_frequency` day math and `Invalid grove_notice_viewed_at from API` guard): unchanged except renames. Print-mode entry `vcs` unchanged.

Binary verification:
- `Grove request answered with an error status` — 303 ×0 → 304 ×2 (@123033700, @256297098)
- `Grove notice config answer has no boolean grove_enabled` — 303 ×0 → 304 ×2
- `Grove settings answer has no boolean or null grove_enabled` — 303 ×0 → 304 ×2
- `errorStatus!==void 0` — 303 ×0 → 304 ×1 (@256294747)
- new_strings.txt:13284/13285/13286 = the three new error strings as standalone lines; 0 hits in removed_strings.txt.

### OCC current — `src/services/api/grove.ts` (357 lines, full 303-shape port)

- `:42` — `ApiResult<T> = {success:true;data:T} | {success:false}` — **no `errorStatus`**.
- `:52-85 getGroveSettings` — catch clears memo cache (matches 303 `hoe`), **no boolean-or-null shape validation**.
- `:90-115 markGroveNoticeViewed` / `:120-148 updateGroveSettings` — `getGroveSettings.cache.clear?.()` on **success only** (303 shape; 304 moved it to finally).
- `:157-193 isQualifiedForGrove` = `Sot`/`dit`; `:198-225 fetchAndStoreGroveConfig` — `if (!result.success) return` (303 shape; no errorStatus re-stamp).
- `:232-278 getGroveNoticeConfig` — catch: `logForDebugging(...); return { success: false }` — **no `cache.clear?.()`** (303 `LCe` bug), **no grove_enabled boolean validation**. (Note: axios rejects non-2xx by default, so the raw status guard is partially implicit — but there is no `errorStatus` propagation and a 200-with-garbage body still "succeeds".)
- `:284-321 calculateShouldShowGrove` = `jar`/`Xpr` — already fails closed on either fetch failing.
- `:323-357 checkGroveForNonInteractive` = `vcs` — matches official (texts use `occ` instead of `claude`).

### Verdict: **PORT**

Recipe (`src/services/api/grove.ts`):
1. `getGroveNoticeConfig` catch: add `getGroveNoticeConfig.cache.clear?.()` before returning failure (core of the "skipped for a day" fix within a session), and return `{ success: false, errorStatus }` when the error is an HTTP-status error (axios: `err.response?.status`).
2. Validate shapes: config response must have `typeof grove_enabled === 'boolean'`; settings response must have `grove_enabled === null || typeof === 'boolean'` — else treat as failure (log the official messages).
3. `markGroveNoticeViewed` / `updateGroveSettings`: move `getGroveSettings.cache.clear?.()` into a `finally` block.
4. `fetchAndStoreGroveConfig`: on failure with `errorStatus !== undefined && errorStatus !== 401` and an existing cache entry for the account, re-save the entry with `timestamp: Date.now()` (keep `grove_enabled` as-is).
5. Update/extend tests in `src/services/api/__tests__/` (grove tests) accordingly.

---

## Item #28 — /privacy-settings choices after server error (changelog line 28)

> "Fixed `/privacy-settings` offering choices that may not apply to you after a network or server error"

### Official change — slash-command chunk pair `new_strings.txt:15099` (304) ↔ `removed_strings.txt:13367` (303)

- 303 @17299-region:
  ```js
  let[r,l]=await Promise.all([hoe(a.credentials),LCe(a.credentials)]);
  if(!r.success)return t(c),null;
  let o=r.data,g=l.success?l.data:null;
  …
  if(o.grove_enabled!==null)return e(CZn,{settings:o,domainExcluded:g?.domain_excluded,onDone:d});
  ```
  → when the **config** fetch failed but settings succeeded, the dialog still rendered with `domainExcluded: undefined` — offering choices that may not apply (the domain-excluded variant).
- 304 @17647-region:
  ```js
  let[r,l]=await Promise.all([ose(a.credentials),Hbe(a.credentials)]);
  if(!r.success||!l.success)return t(c),null;
  let o=r.data,g=l.data;
  …
  if(o.grove_enabled!==null)return e(vrr,{settings:o,domainExcluded:g.domain_excluded,onDone:d});
  ```
  → **both** fetches must succeed; otherwise just the fallback message `c="Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls"` and no dialog.
- The dialog component itself (`CZn`→`vrr` / `AZn`→`wrr`; chunk pair `new_strings.txt:12815` ↔ `removed_strings.txt:11395`, both exactly 7692 chars) is **rename-only** — no UI change.
- Binary: `if(!r.success||!l.success)return t(c),null` — 304 @279110047, 303 ×0; `if(!r.success)return t(c),null` — 303 @277513517.

### OCC current — `src/commands/privacy-settings/privacy-settings.tsx` (57 lines)

- `:13` — `const [settingsResult, configResult] = await Promise.all([getGroveSettings(), getGroveNoticeConfig()]);`
- `:15` — `if (!settingsResult.success) { onDone(FALLBACK_MESSAGE); return null; }` — **303 gate** (config failure passes through)
- `:20` — `const config = configResult.success ? configResult.data : null;`
- `:52` — `<PrivacySettingsDialog settings={settings} domainExcluded={config?.domain_excluded} …>` — the buggy `undefined` domainExcluded path.
- FALLBACK_MESSAGE `:6` matches official `c` verbatim.

### Verdict: **PORT**

Recipe (privacy-settings.tsx):
1. `:15` → `if (!settingsResult.success || !configResult.success) { onDone(FALLBACK_MESSAGE); return null; }`
2. `:20` → `const config = configResult.data;` (now guaranteed success)
3. `:52` → `domainExcluded={config.domain_excluded}` (drop the `?.`)
Pairs naturally with the #27 grove.ts changes (same fetchers); one PR can cover both.

---

## Cross-cluster notes

1. **#8(d)**: 304's org-policy cache class also gained `stopRegimeRefusalWatch = vt(this.refetchAfterRegimeRefusal)` — a HIPAA-gated, debounced refetch after a "regime refusal" (`refetchAfterRegimeRefusal` verbatim in report §8). Not part of the API-key fix; belongs to whoever owns org-policy/managed-settings items.
2. **#27**: the Grove module fix introduces a reusable HTTP-status error class (`class v extends x` carrying `.status`) and `u(status)` guard applied to all four Grove endpoints. If R3/R6 touch adjacent `/api/oauth/account/*` code, note the pattern.
3. **#49**: 304 uses `Map.groupBy` (newer JS builtin) — OCC should use a manual Map grouping unless the runtime target guarantees it (Bun does; keep TS lib in mind).
4. **#17**: `Path hidden (unsupported characters)` exists in BOTH 303 and 304 binaries (303 @127617760) — the string is not a valid new-code marker by itself; the `Fo(o)`/`Uh` usage is.
5. **#42**: official agents-view selection now passes the copy-on-select **tracker object** (with `peek`/`invalidate`) into the ctrl+c handler instead of a static boolean. If OCC ever ports mouse text selection into FleetView, replicate the tracker-passing shape (304 `qXo`), not the boolean shape (303 `JYo`).
