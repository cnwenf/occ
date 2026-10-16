# Gap research — official Claude Code 2.1.301 triage, batch T2

Scope: changelog entries **#3, #7, #10, #11, #12, #13, #14, #19, #22, #23, #24, #27, #30, #31, #32** (full list: `/tmp/cc-diff-301/entries.md`).
Binaries: `v301/package/claude` (md5 `7f52c3d8eda2796a6002cb7380aabfb9`, verified) vs `v300/package/claude`. Forensics only — `strings`/`grep -aboF` byte offsets + bounded `dd`/`tail -c` excerpts. The official binary was never executed. Offsets are byte offsets into the ELF; matches below 100 M were filtered out as binary false positives.

Disposition legend: **PORT** = OCC has the surface at pre-301 behavior, fix is portable · **ALREADY-ALIGNED** · **STAGED** = mechanism unrecoverable or too large · **N-A** = surface absent in OCC · **CAND** = candidate, evidence insufficient to port faithfully.

---

## #3 — vim `%` bracket motion

> Added the `%` motion to vim mode: jump to the matching bracket, alone or with d/c/y

**Disposition: PORT (M)**

### Binary evidence (v301)

Motion switch gained `case"%"` @236317723:

```js
case"%":{let r=fn(y5o(e.text),e.offset);return r===null?e:new di(e.measuredText,r)}
```

Jump target finder `fn` (same region):

```js
function fn(t,e){let r=t.indexOf(`\n`,e),n=r===-1?t.length:r,s=t.slice(e,n).search(/[()[\]{}]/);
if(s===-1)return null;let o=e+s,i=ne(t,o,t[o],!1);if(!i)return null;
return i.start===o?i.end-1:i.start}
```

Semantics: scan forward **within the current logical line** for the first `()[]{}` bracket; run the existing pair-finder `ne` on it; if the found pair starts at the scanned bracket, jump to `end-1` (the closer), else jump to `start` (the opener). If no bracket on the line, cursor is unchanged (`return e`).

Inclusive-motion predicate changed @236318043: `He(t){"eE$%".includes(t)}` — v300 @235538867 is `"eE$".includes(d)`. So `%` is characterwise-inclusive (`d%` deletes the bracket pair inclusive of both ends), matching vim.

Pair-finder `ne` @236314964 is **pre-existing** (v300 has the identical function `vn` @235539092+ with pair table `ci`) — v301 only wires `%` into the motion switch on top of it:

```js
function ne(t,e,r,n){if(r==="w")return ct(t,e,n,rVe);if(r==="W")return ct(t,e,n,(o)=>!Ntt(o));
let s=sn[r];if(s){let[o,i]=s;return o===i?an(t,e,o,n):un(t,e,o,i,n)}return null}
```

Text masking `y5o` @236281883 (also pre-existing) replaces UI placeholder spans with spaces so `%` does not match brackets inside them; placeholder regex `mt` @236281643:

```
\[(?:Pasted text|Image|\.\.\.Truncated text|✦ Team setup guide) #\d+(?: \+\d+ lines)?\.*\]|\[⧉ [^\]\n]+\]
```

v300 motion switch extracted in full @235538268 — confirmed **no `case"%"`**.

### OCC side

- `src/vim/motions.ts:31-69` — `applySingleMotion` switch, no `%` case.
- `src/vim/motions.ts:75-77` — `isInclusiveMotion` = `'eE$'.includes(key)` (pre-301 form).
- `src/vim/textObjects.ts:19` — `PAIRS` table exists for text objects (`i{`/`a(` etc.), but no line-scanning `%`-style "find matching bracket from offset" helper equivalent to official `ne(t,offset,char,forward)`.

### Implementation note

1. Add a `matchBracketFrom(text, offset)` util (port of official `fn` + the `ne` pair scan; OCC's `PAIRS` table can seed the pair set — official `sn`/`ci` covers `()[]{}` plus `<>`-family per the pre-existing table; keep the scan line-bounded like `fn`).
2. Apply official placeholder masking before the scan (OCC's PromptInput paste placeholders are the local analogue of `mt`).
3. `applySingleMotion`: `case '%': return cursor.moveTo(matchBracketFrom(...)) ?? cursor` — needs a Cursor constructor from `(measuredText, offset)` (official `new di(e.measuredText,r)`); OCC `Cursor` already carries measuredText+offset.
4. `isInclusiveMotion`: `'eE$%'.includes(key)`.
5. Operators (`d`/`c`/`y`) already consume `resolveMotion` + inclusivity — no operator changes needed.

---

## #7 — quitting removes WorktreeCreate-hook worktree without asking

> Fixed quitting removing a worktree made by a `WorktreeCreate` hook without asking when it may hold unpushed commits

**Disposition: PORT (M)**

### Binary evidence (v301 NEW, v300 = 0 hits)

@101828806 / @250244409:

```
A WorktreeCreate hook made this worktree, so Claude Code can't tell whether it has unpushed commits.
${Co?` This session was named "${Co}". Keep the worktree to resume it later.`:""}
```

Compare the normal-worktree warning (both versions): `branch ${ir} may hold ${Et===null?"unpushed commits (commit baseline unavailable)":"commits that could not be counted"}. The branch will be deleted...`. So v301 adds a dedicated hook-worktree branch in the exit dialog: when the worktree came from a `WorktreeCreate` hook (git-based unpushed counting is unreliable/unknown), always ask, with its own subtitle text + session-name hint.

### OCC side

- `src/components/WorktreeExitDialog.tsx:38-82` — `loadChanges()` runs `git status --porcelain` (:41) and `git rev-list --count ${originalHeadCommit}..HEAD` (:52) **unconditionally**; if no changes and count === 0 → silent `cleanupWorktree()` (:57-73) without asking. For hook-created worktrees the git queries can fail (foreign layout / no baseline) → `parseInt('') || 0` = 0 → **silent removal = exact pre-301 bug**.
- `src/utils/worktree.ts:1027-1033` — `cleanupWorktree` already destructures `hookBased` and routes hook worktrees to `executeWorktreeRemoveHook`; the *dialog* just doesn't know to stop and ask.
- `src/utils/worktree.ts:1322-1339` — stale-agent-worktree cleanup has an unpushed check; not the quit path.

### Implementation note

In `loadChanges()`, when the worktree record is `hookBased`: skip the silent-removal fast path and force the dialog, with subtitle = official text above (+ session-name sentence when a session name exists). The keep/remove actions already exist (:97-167); removal already calls the WorktreeRemove hook via `cleanupWorktree`.

---

## #10 — Grep/Glob report error instead of "no matches" on unexpected search failure

> Fixed Grep and Glob reporting no matches when the search program failed unexpectedly before returning any results; they now return an error saying the search failed

**Disposition: PORT (S)**

### Binary evidence

NEW class in v301 (v300 = 0) `FU` @223101274:

```js
class FU extends x{constructor(){super('The search failed, so this is not a "no matches" result: matches may exist. What happened to the search program (ripgrep) is not known, and no results were read. Run the search once more. If it fails again, tell the user that searches are failing. Do not run a recursive search in the shell instead (for example grep -r, find or rg): it can reach what this tool is set to leave out.',"ripgrep unexpected exit with no results");this.name="RipgrepAbnormalExitError"}}
```

Throw-site gating (v301 @223117590 region) vs v300 (@222168255 region) — the **only** semantic diff:

```js
// v300:  if(w.code!==2&&w.code!=="ABORT_ERR"){ ...else l(tjo(...)) }        // log only, then fall through to resolve([])
// v301:
if(w.code!==2&&w.code!=="ABORT_ERR"){
  let le=UU.has(E(w)??"");                                    // spawn-resource errno (EAGAIN/ENOMEM/EMFILE/ENFILE)
  if(q||K||Z||le||AU(R)) t(`rg failed ...`,{level:"error"})   // timeout||overflow||vanished||spawnResource||EAGAIN-stderr → log
  else{
    let pe=re.length===0&&s?.rejectOnInputError&&w.code!=="ECHILD"
      ? (r.aborted?IU(r):new FU) : void 0;
    if(l(wGo(...)),pe!==void 0){y(pe);return}                 // reject
  }
}
```

i.e. v301 rejects with `RipgrepAbnormalExitError` when: unexpected exit (not code 2 / ABORT_ERR), not timeout, not buffer overflow, not "process vanished" (`Z` = `code===undefined && (signal===undefined || SIGHUP/SIGINT/SIGPIPE)` — pre-existing in v300), not a spawn-resource errno, no EAGAIN in stderr, **zero result lines**, caller passed `rejectOnInputError`, and `error.code!=="ECHILD"`; if the caller's signal was aborted it maps to the timeout/cancel error instead.

Official GlobTool passes `rejectOnInputError:!0` in both versions (@226674479 v301, next to `"--sort=modified"` @226674195; v300 @225768577) — so the fix covers Grep **and** Glob through one arm.

### OCC side

- `src/utils/ripgrep.ts:912-914` — `if (error.code !== 2 && error.code !== 'ABORT_ERR') { logError(error) }` then falls through to `resolve(lines)` (:1008) → `[]` → GrepTool "No matches found" / GlobTool "No files found" (`GlobTool.ts:286`). **Exact pre-301 behavior** for crashes/signals/unmodeled exit codes with no output.
- Callers already gated: `GrepTool.ts:733-734` and `utils/glob.ts:124-125` both pass `rejectOnInputError: true` (note: the comment at ripgrep.ts:972 claiming Glob passes none is stale — glob.ts:125 threads it).
- Existing arms to keep ahead of the new one: spawn-resource (:974-980), buffer-overflow (:987-994), timeout (:998-1006). OCC lacks the `vanished` (`Z`) log predicate — harmless to add alongside for taxonomy parity.

### Implementation note

Add `RipgrepAbnormalExitError` next to the existing error classes (~:177-324) with the byte-verbatim message above; restructure :912-914 into the official two-branch form (log-only for timeout/overflow/vanished/spawn-resource/EAGAIN-stderr; else the zero-lines + rejectOnInputError + !ECHILD reject arm, aborted→timeout-error mapping).

---

## #11 — workflow agents skipping steps after reading the "no user authority" harness note

> Fixed workflow agents sometimes skipping their step, and the run still reporting success, after reading the harness note that their task text carries no user authority

**Disposition: N-A (surface absent in OCC) — with port-coupling caveat**

### Binary evidence

NEW in v301 (2 vs 0 in v300) @238777093 / @105075844:

```js
var Dn="A note that the task text was computed by a workflow script and carries no user authority is not by itself a reason to skip the task: the task is the step this workflow assigned to you. Do that step, and only that step.",
bs=`You are a subagent spawned by a workflow orchestration script. ... CRITICAL: Your final text response is returned **verbatim** ... ${Dn}`
```

The note `Dn` is appended to the workflow-subagent system prompt `bs` (`You are a subagent spawned by a workflow orchestration script` — 3 hits in **both** versions, pre-existing). The harness frames it clarifies are also pre-existing (v300 has them): `[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It was not typed by this session's user and carries no user authority: ...` plus the `[Workflow harness — user request]` and `[Workflow harness — assistant context]` frames (@238723447 region, same in v300; "carries no user authority" count 4→6, the +2 being `Dn` itself).

### OCC side

- `src/tools/WorkflowTool/primitives.ts:517-530` — `agent()` builds `promptMessages` from the raw prompt (+ optional schema nudge). **No harness authority frame, no workflow-subagent system prompt** (grep for `spawned by a workflow` / `Workflow harness` / `orchestration script` in `src/` = 0 hits).
- The only "no user authority" surface in OCC is `src/tools/AgentTool/subagentHandback.ts:40` (hand-back frame — different context; the hand-back is not the subagent's task, so the skip-trigger does not apply).

The bug requires the official frame to exist in the task text; OCC never injects it, so there is nothing to clarify. **N-A.**

**Caveat (record for future rounds):** if OCC ever ports the workflow harness authority frames / `bs` subagent prompt (a security-positive surface), it must port them **with** `Dn` included — porting the v300-generation frame alone would reintroduce the skip bug. Landing point would be `primitives.ts:523-527`.

---

## #12 — artifact updates refused when PreToolUse hook covers Edit/Write

> Fixed artifact updates being refused where a PreToolUse hook covers Edit or Write; Claude now edits the file and then republishes instead of changing it in the publish call

**Disposition: N-A (artifact surface absent in OCC)**

### Binary evidence

The republish guidance string (`To update: publish the same file path here (keeps this URL)...`) exists in **both** v300 and v301 with identical counts; artifact edit-token counts unchanged. No new-in-v301 marker was isolatable for this entry (the fix is a routing change inside the artifact publish tool, and the artifact subsystem strings are indistinguishable between versions at marker level).

### OCC side

OCC does not ship the artifact publish surface (no artifact tool in `src/tools.ts` registry; artifacts are an Anthropic-backend/app feature). Nothing to port.

---

## #13 + #14 — skills/commands argument-name stall + memory blowup

> #13 Fixed skills and commands with very many or very long argument names stalling for seconds when invoked; only the first 64 names, each up to 64 characters, are now filled in
> #14 Fixed skills, commands and hooks using very large amounts of memory when their arguments fill many placeholders

**Disposition: PORT (S) — one combined change**

### Binary evidence

v301 fill function `bNe` @226104536 region (fully extracted) vs v300 `MLe` @225199386 region (fully extracted) — otherwise byte-identical modulo minifier renames. v301 adds:

```js
var _pr=4000000, mSo=64, gSo=64, GW="￿", C3="￾";
```

1. **Name caps (#13):** the named-argument list is built as
   `H = s.map((Q,ye)=>({name:Q,i:ye})).filter((Q)=>Boolean(Q.name)&&Q.name.length<=gSo).slice(0,mSo).sort((Q,ye)=>ye.name.length-Q.name.length)`
   — v300 filters only `Boolean(V.name)`, with no length cap, no count cap, no sort-order relevance beyond correctness. The longest-name-first sort is pre-existing (prevents a shorter name substituting inside a longer one); the caps are new.
2. **Total-size cap (#14):** during value insertion, `y += ke.length` accumulates substituted size; when `y > _pr` it throws:
   ```
   nT(`This skill, command or hook and the arguments filled into it add up to more than ${_pr.toLocaleString("en-US")} characters. Use shorter arguments or fewer placeholders such as $ARGUMENTS.`)
   ```
   v300 has no size tracking — many placeholders × large values produce unbounded intermediate strings (the memory blowup).

### OCC side

`src/utils/argumentSubstitution.ts` is v300-generation:

- :47-49 — sentinels `SHIELDED_DOLLAR`/`VALUE_BOUNDARY` (= official `GW`/`C3`).
- :165-175 — `insertValue` with **no** accumulated-size tracking.
- :180-183 — `namedArgs` filter is `Boolean(entry.name)` only — **no** 64-name / 64-char caps.
- Pre-existing minor divergence (not part of this fix): OCC appends `'\nARGUMENTS: '` at :253 where official uses `\n\n` — leave or note, do not conflate.

### Implementation note

Mirror the three constants (MAX_TOTAL = 4_000_000, MAX_NAMES = 64, MAX_NAME_LEN = 64); add `.filter(name.length <= 64).slice(0, 64)` before the longest-first sort; accumulate inserted-value length in `insertValue` and throw the byte-verbatim message when > 4 M. Both tools (skills + commands) and hooks share this function in OCC, so one edit covers #13 and #14.

---

## #19 — tool call cut off mid-turn during permission check reported as user-rejected

> Fixed a tool call cut off by a message sent mid-turn during its permission check being reported to the model as rejected by the user

**Disposition: CAND (mechanism not recoverable at marker level)**

### Binary evidence (negative result — exhaustive)

All candidate regions are rename-only between versions:

- Permission-prompt race: v301 @243370240 vs v300 @252252412 — identical `Promise.race([ye,Z,se])`, abort → `{behavior:"deny",message:"Permission prompt was aborted.",decisionReason:...}`.
- `interruptRunningTurn` sites (v301: 101819260 / 250027229 / 250184640; v300: 101814676 / 247701257 / 247857999) — identical.
- Rejection-constant cluster v301 @218162288 vs v300 @217507075 — the only NEW constant is `$Ft="The turn did not end: a tool call in your last message asked to end it, but another call in that message failed. Deal with the failure, then finish the turn. The calls that succeeded took effect, so do not repeat them."` (2 vs 0) — belongs to a different fix (end-turn tool + sibling failure), not #19.
- Probe strings all unchanged in count: `is_interrupt` 5/5, `interruptedMessageId` 10/10, `[Request interrupted by user]` 6/6, `cutIndex` 7/7.

The fix is therefore a pure control-flow change (how an in-flight permission check resolves when the turn is interrupted by a queued user message — likely rejecting with an interrupt-flavored result instead of the user-rejection message) inside minified logic with no unique string to anchor it. Per discipline: **CAND** — do not guess.

### OCC side (for reference if a future round cracks it)

Permission-await + interrupt interaction lives around `src/screens/REPL.tsx` (interrupt handling) and the permission request promise plumbing in `src/types/permissions.ts` / `src/hooks/usePermissionRequestLogic*`. The official fix direction: a tool call whose permission check is pending when the turn is cut must be reported to the model as *cut off / interrupted*, not as `rejected by user`.

---

## #22 — vim stuck in INSERT after Escape on slow/busy machine

> Fixed vim mode sometimes staying in INSERT after Escape on a slow or busy machine

**Disposition: PORT (M) — verify-first**

### Binary evidence (all NEW in v301)

Keypress class gains late-read reinterpretation @231961993:

```js
this.soloKeypress=u?.soloKeypress, this.readLate=n.readLate===!0 }
readAsEscapeThenKey(){return this.#e=this.soloKeypress!==void 0&&Jc(this.sequence),this.#e}
get isReadAsEscapeThenKey(){return this.#e}
```

Vim key handler @236349205 (NEW guard at the top; escape handling below for reference):

```js
function tn(a,f){let l=b.current;
if(l.mode==="INSERT"&&a.readLate&&An.test(a.sequence)&&a.readAsEscapeThenKey()){a.preventDefault();return}
...
if(a.name==="escape"){if(T(),l.mode==="NORMAL")b.current={mode:"NORMAL",command:{type:"idle"},wanted:l.wanted};else ...
```

Mechanism (as recoverable): on a slow/busy machine a keypress that was really a lone Escape can be **read late** and delivered merged with following bytes. v301 marks such reads (`readLate`), and in INSERT mode the vim handler swallows the merged raw event (`preventDefault`) after confirming via `readAsEscapeThenKey()` that the sequence re-splits into Escape-then-key (`Jc` re-queues/validates the split; `An` matches escapable sequences), so the transition runs on the correctly-split events instead of being lost. Exact `Jc`/`An` definitions are chunk-imported and were not traced further (minified import graph) — the verbatim strings above are the fidelity ceiling for this entry.

### OCC side

- `src/hooks/useVimInput.ts:415` — `if (key.escape && state.mode === 'INSERT')` → NORMAL transition; depends entirely on the parser classifying the event as escape.
- `src/ink/parse-keypress.ts` — OCC has the 2.1.269 (E44) flush path (:261-284) and a flush-timer note at :329 ("the buffered ESC was flushed as a lone Escape"): a trailing bare ESC stays in the tokenizer until the next feed or the flush timer. This is the same race window the official fix addresses — under load, ESC + next key can arrive in one feed and tokenize as a merged sequence rather than a lone Escape.

### Implementation note (verify-first)

1. Reproduce: feed `\x1bj` in one chunk while INSERT — confirm whether OCC's tokenizer emits a meta-j (or text) instead of Escape+`j`, leaving mode INSERT. If OCC's tokenizer already splits correctly, the port is a no-op guard — document and close.
2. If affected: port the keypress-level flags (`soloKeypress`, `readLate`, `readAsEscapeThenKey`) into the parse-keypress keypress shape, and add the INSERT-mode swallow guard in `useVimInput.ts` ahead of the existing escape branch (:415).

---

## #23 — Esc discarding a typed AskUserQuestion answer in vim mode

> Fixed Esc discarding a typed AskUserQuestion answer in vim mode: the free-text field now supports vim NORMAL mode, and Esc cancels only from NORMAL

**Disposition: PORT (M)**

### Binary evidence (NEW tokens: `vimEditing` 5 vs 0, `VIM_TERMINAL` 2 vs 0)

Producer — the vim-enabled text input inside a Select input option @243844694:

```js
{mode:c,setMode:u,cancelPendingRemap:g,forgetColumn:d,isCommandPending:b}=m
...
let f=t.focus!==!1, E=c!=="NORMAL"||b;
... H({mode:c,takesEscape:E}) ...   // onEditingStateChange
```

`takesEscape = mode !== "NORMAL" || isCommandPending`, reported while focused (`f`), cleared on unmount (`H(null)`).

Consumer — Select's `select:cancel` keybinding @243853550:

```js
f["select:cancel"]=()=>{let E=i.getFocusedValue(),C=a.find((O)=>O.value===E);
if(C?.type==="input"&&C.vimEditing?.takesEscape&&Do(W?.singleKeyEvent()??null))return!1;
i.onCancel()}
```

with the plain-Escape predicate (same region): `function Do(t){return t?.name==="escape"&&!t.ctrl&&!t.meta}`.

Semantics: when the focused option is the free-text input and its vim state consumes Escape (INSERT/VISUAL or a pending command), the cancel binding no-ops and the Escape goes to the vim input (INSERT→NORMAL). Only from NORMAL (takesEscape false) does Esc bubble to `onCancel()`. The input option object carries `vimEditing` (props cluster @101749996).

### OCC side

- `src/components/CustomSelect/select-input-option.tsx:12` — the "Other" free-text field renders a **plain `TextInput`**, no vim support at all (pre-fix state is even older than official v300 here).
- `src/components/CustomSelect/use-multi-select-state.ts:279` — while an input option is focused, `key.escape` is an *allowed* key and falls through to :417-420 → `onCancel()` + `stopImmediatePropagation()` — **Esc discards the typed answer and cancels the question** = the exact bug.
- `QuestionView.tsx:85-87` (`__other__` focus → `setTextInputMode`) and `AskUserQuestionPermissionRequest.tsx:245-250` (`isInTextInput`) track focus but do not gate Esc.
- OCC has a full vim input stack to reuse: `src/components/VimTextInput.tsx` + `src/hooks/useVimInput.ts` (mode/setMode/isCommandPending all present).

### Implementation note

1. Make the Select input option vim-capable when `editorMode === 'vim'`: render `VimTextInput` (or wire `useVimInput`) inside `select-input-option.tsx`, and surface `{mode, takesEscape: mode!=='NORMAL'||isCommandPending}` up to the option state (`onEditingStateChange` analogue → store on the focused option's `vimEditing`).
2. Guard the cancel path in `use-multi-select-state.ts:417` (and the single-select equivalent in `use-select-navigation.ts`/`use-select-input.ts` if it has the same arm): if focused option is `type==='input'` and `vimEditing?.takesEscape` and the event is a plain Escape → return without `onCancel()`.
3. Also audit `QuestionView.tsx:146` footer Esc — unaffected (footer-focused only), no change.

---

## #24 — Read tool treating binary files as text

> Fixed the Read tool reading binary files such as .xlsm, .parquet, .epub and .heic as text

**Disposition: PORT (S)**

### Binary evidence

Extension set `be` v301 @224955508 vs v300 @224062630, consumed by `YPe(e){let n=e.slice(e.lastIndexOf(".")).toLowerCase();return be.has(n)}`. v300: 94 extensions; v301: 121. **27 added, 0 removed:**

```
.apk .avif .dmg .docm .dotm .dotx .epub .feather .heic .heif .lz4 .npy .npz
.numbers .parquet .pickle .potm .potx .ppsm .ppsx .pptm .whl .xlsb .xlsm
.xltm .xltx .zst
```

### OCC side

- `src/constants/files.ts:5` — `BINARY_EXTENSIONS` Set; `hasBinaryExtension` :117-119.
- `src/tools/FileReadTool/FileReadTool.ts:828-842` — binary-extension check gates text reading.

### Implementation note

Add the 27 extensions to `BINARY_EXTENSIONS` (keep OCC's set ordering/style). One-line-class change; check `test/constants` snapshots if any enumerate the set.

---

## #27 — skills not listed to the model after /rewind

> Fixed skills no longer being listed to the model after using `/rewind`

**Disposition: PORT (S/M)**

### Binary evidence (NEW in v301)

Reconcile function `NXt` @229467373:

```js
function NXt(e,n){let r=kAe.of(n);
 for(let s of e){
  if(s.type!=="attachment")continue;
  if(s.attachment.type==="skill_listing"){
   if(r.suppressNext=!1,!s.attachment.names){r.sentSkillNames.delete(""),r.resumeSeedNames=null;continue}
   for(let h of s.attachment.names)
    r.sentSkillNames.get("")?.delete(h),r.resumeSeedNames?.delete(h)}}}
```

Per-session skill-listing state (class `DIn`, session-scoped via Lazy `kAe`): `{sentSkillNames: Map, replacedSkillNamesRead: Map, suppressNext: false, resumeSeedNames: null, reportedUncBlockedPaths: Set}`. Semantics: for every **removed** message that carried a `skill_listing` attachment, un-record its names from `sentSkillNames` (and the resume seed) so the dedup filter no longer believes those skills were already listed — the next turn re-lists them. `suppressNext` is cleared. Full-listing attachments (no `names`) reset the whole entry.

Call sites: eviction path @243127162 (`NXt(r,e.session)`), and inside `rewindConversationTo(h,C)` @249031065:

```js
ee.evictRewoundFileTracking(NCn(Ne)), NXt(Ne,L)     // Ne = the sliced-off (removed) messages
```

v300 has no counterpart (`skill_listing` 16 vs 14 hits; no reconcile logic).

### OCC side

- `src/utils/attachments.ts:3156` — module-scope `sentSkillNames` Map (keyed by agentId); dedup filter ~:3249-3259 skips listing skills whose names are already recorded. `resetSentSkillNames` :3161-3164 (full reset, used elsewhere), `suppressNextSkillListing` :3182-3185.
- `src/screens/REPL.tsx:3933` — `rewindConversationTo`: slices the conversation and logs `tengu_conversation_rewind` (:3937) but **never touches `sentSkillNames`** → after /rewind the dedup map still claims the (now removed) listing was delivered → skills never re-listed. Exact pre-301 bug.

### Implementation note

Add a `resyncSentSkillNamesAfterRewind(removedMessages)` in `attachments.ts` mirroring `NXt` (walk removed messages; for `skill_listing` attachments delete recorded names / reset on full listings; clear suppressNext), and call it from `rewindConversationTo` in `REPL.tsx:3933` with the sliced-off messages. Note OCC's map is module-scope keyed by agentId (official is per-session Lazy) — use the `''`/main-agent key for the REPL path, matching OCC's existing convention at :3249-3259.

---

## #30 — permission prompt not showing which plugin/skill a hook `ask` comes from

> Fixed the permission prompt for a plugin or skill hook's `ask` decision not showing which plugin or skill the hook comes from

**Disposition: PORT (M)**

### Binary evidence (NEW: `hookPluginId` 12 vs 0; `pluginId` 701 vs 695)

- Hook execution result carries the registry entry's plugin id @229019002: `...Vs?.pluginId!==void 0&&{hookPluginId:Vs.pluginId}` (`Vs` = registry entry from `Nr.get(Ko.hook)`); passthrough on yield @228985846.
- Permission decision reason @228172827:

```js
{type:"hook",hookName:`PreToolUse:${n.name}`,hookSource:Re.hookSource,hookPluginId:Re.hookPluginId,
 reason:Re.hookPermissionDecisionReason,...Re.heldForServedCall&&{heldForServedCall:!0}}
```

- Analytics @242104338: `decision_reason_hook_plugin_id:mvn(R.hookPluginId), decision_reason_hook_source:fvn(R.hookSource)`.

The prompt UI renders the source label from `hookSource` (pre-existing) and now also has `hookPluginId` available to name the owning plugin/skill.

### OCC side

- `src/types/permissions.ts:314-319` — `{type:'hook', hookName:string, hookSource?:string, reason?:string}` — **no `hookPluginId`**.
- `src/utils/hooks/AsyncHookRegistry.ts:23,42,61,71,97` — registry entries already track `pluginId` (the data source official uses).
- `src/services/tools/toolHooks.ts:634,697` — `hookSource` is already threaded from hook result → decision reason; `hookPluginId` can ride the same path.
- `src/components/permissions/PermissionRuleExplanation.tsx:47-49` — `sourceLabel = reason.hookSource ? ` [${reason.hookSource}]` : ''` + "Hook X requires confirmation..." — the render site to extend with the plugin/skill name.

### Implementation note

Add `hookPluginId?: string` to the hook decision-reason type; populate it in `toolHooks.ts` from the registry entry (where `hookSource` is populated, :634/:697); render it in `PermissionRuleExplanation.tsx` alongside `hookSource` (official shows the plugin/skill the hook comes from — use plugin name lookup from the registry by id). Analytics field is optional (OCC analytics are stubbed).

---

## #31 — /diff missing conflicted cherry-pick/revert in reftable repos on git-check timeout

> Fixed `/diff` not noticing a conflicted cherry-pick or revert in reftable repositories when one of its git checks timed out or failed

**Disposition: STAGED / N-A for the fix itself (surface absent) — fix-forward advisory recorded**

### Binary evidence

v300 `Pct` @222788443: on any `show-ref` exit ∉ {0,2} → `return null` (discards refs already found).
v301 `Nut` @223694332 + `e8e` @223694282:

```js
var e8e=["CHERRY_PICK_HEAD","REVERT_HEAD"], re=2;
async function Nut(e,n,r){let t=new Set;
 if(n.length===0||!await h_t(e))return t;
 let o=await Promise.all(n.map((s)=>r(["show-ref","--exists",s]))),i=!1;
 for(let[s,l]of o.entries()) if(l===0)t.add(n[s]); else if(l!==re)i=!0;
 return t.size===0&&i?null:t}
```

Semantics: run `git show-ref --exists CHERRY_PICK_HEAD / REVERT_HEAD` (the reftable-safe probe — fs file checks don't work in reftable repos); keep every ref found; only return `null` when **nothing** was found **and** at least one check failed (timeout/unknown) — so a found conflicted state survives a sibling check's failure.

### OCC side

- OCC's transient-git-state detection is fs-only: `src/utils/gitDiff.ts:308` `isInTransientGitState` checks for files (`CHERRY_PICK_HEAD`, `MERGE_HEAD`, ...) on disk; `src/utils/commitAttribution.ts:878` similar. No `show-ref` lane at all.
- Related carried items in `docs/upstream-version-gap-occ118-2026-10.md` §7: reftable `tables.list` STAGED item + #20 reftable blind-spot advisory; `src/utils/worktree.ts:975` `isReftableGitDir` exists (detection only).

The official fix repairs a git-query lane OCC never had → nothing to port 1:1. **STAGED/N-A.**

**Advisory (fix-forward):** OCC's fs-only check has the same blind spot in reftable repos (`CHERRY_PICK_HEAD` lives in the ref table, not as a loose file) and it also misses sequencer/`BISECT_LOG` states. When OCC adds a git-query lane, adopt the v301 `Nut` pattern verbatim: preserve found refs; `null` only when nothing found AND a check failed.

---

## #32 — workflow scripts asking permission after Bash `cd`

> Fixed workflow scripts asking for permission or being refused when read, edited or re-run after a Bash `cd` in the same session

**Disposition: PORT (S)**

### Binary evidence

Workflow-script module region-diff (v300 @238029600 vs v301 @238753200, ~11.5 KB): the **only** semantic change in the whole region is the resolve base for `scriptPath`:

```js
// v300: srr(e,n){let o=No(le(),e)...}   (+ LEn)
// v301: Psr(e,n){let o=No(de(),e)...}   (+ $Tn)      // No = path.resolve
```

Accompanying error text (both versions): `scriptPath must be a script path this tool returned, or a file you can already read (the working directory or a directory you have added): ${e}`. The exact identities of `le()`/`de()` are not traceable through the minified chunk imports (honest limitation), but the changelog direction is unambiguous: v300 resolved relative scriptPaths against the **cd-tracked** cwd (so after a Bash `cd` the same script path resolved elsewhere → permission ask/refusal); v301 resolves against a cd-immune base (session start dir / original cwd).

### OCC side

- `src/tools/WorkflowTool/scriptLoader.ts:206` and `:244` — `resolve(getCwd(), scriptPath)`; `getCwd()` is the cd-tracked cwd (`src/utils/cwd.ts` — Bash `cd` updates it) → **exact pre-301 behavior**.
- `scriptLoader.ts:146` — `isAbsolute(scriptPath) ? scriptPath : resolve(scriptPath)` (implicit process.cwd() — same exposure).
- A cd-immune base exists in OCC: `getOriginalCwd()` (`src/context.ts:184`; used e.g. by `ExitWorktreeTool.ts:126-129` with `setOriginalCwd`).

### Implementation note

Swap the resolve base at `scriptLoader.ts:206/:244` (and audit `:146`) from `getCwd()` to the cd-immune session base (`getOriginalCwd()`), matching the permission-check wording "the working directory or a directory you have added" — the working directory in that sentence is the session's, not the post-`cd` one. Add a regression test: Bash `cd /tmp` mid-session → read/edit/re-run a relative-path workflow script → no new permission ask.

---

## Cross-entry observations

1. **One-file wins:** #24 (constants), #13/#14 (argumentSubstitution), #32 (scriptLoader base swap), #27 (attachments + one REPL call) are all S-complexity, disjoint files — ideal for a single parallel subagent batch.
2. **ripgrep.ts taxonomy keeps converging:** #10 is the fourth round touching `handleResult` (2.1.208 #14b, 2.1.275 `o8`, 2.1.277 spawn-resource, 2.1.292 C1 dispatch order). OCC's arm order already mirrors the official; the FU arm slots into the existing `code!==2 && code!=='ABORT_ERR'` block at :912 with zero reordering. The stale comment at :972 ("Glob callers pass none") should be corrected in passing — glob.ts:125 threads `rejectOnInputError:true`.
3. **Vim cluster (#3/#22/#23)** shares `useVimInput`/`parse-keypress` territory with the two staged 2.1.221 vim fixes (gap doc §3d of occ44) — worth one consolidated vim-alignment work item rather than three isolated patches; #23 additionally upgrades the AskUserQuestion free-text field to VimTextInput, which is new UI surface.
4. **Authority-frame family (#11):** official now has a 4-piece prompt-security cluster around workflow tasks (computed-task frame, user-request relay frame, assistant-context frame, `Dn` clarification). OCC has none of it. If a future round ports the frames, port all four together — `Dn` exists precisely because the frame alone caused step-skipping.
5. **#19 is the only CAND** — pure control-flow fix, no string anchor; every probe marker count is identical across versions. Park until a future binary diff exposes it (or runtime A/B against official becomes available).
6. **Reftable creep (#31):** third consecutive round with a reftable blind-spot item (tables.list STAGED, #20 advisory, now #31). OCC's `isReftableGitDir` exists but no consumer adapts behavior. Consider a dedicated reftable-support epic.

## Summary table

| # | Disposition | Complexity | OCC landing point |
|---|---|---|---|
| 3 | PORT | M | `src/vim/motions.ts:31-69,75-77` (+ bracket-pair util, placeholder mask) |
| 7 | PORT | M | `src/components/WorktreeExitDialog.tsx:38-82` (hookBased → always ask) |
| 10 | PORT | S | `src/utils/ripgrep.ts:912-914` + new `RipgrepAbnormalExitError` |
| 11 | N-A | — | none (no workflow harness frame); caveat at `primitives.ts:523-527` |
| 12 | N-A | — | artifact surface absent |
| 13/14 | PORT | S | `src/utils/argumentSubstitution.ts:165-183` (64/64/4M caps) |
| 19 | CAND | — | not recoverable; ref: REPL interrupt × permission-await plumbing |
| 22 | PORT | M (verify-first) | `src/ink/parse-keypress.ts` (flush-timer window) + `src/hooks/useVimInput.ts:415` |
| 23 | PORT | M | `select-input-option.tsx:12` (TextInput→vim-capable) + `use-multi-select-state.ts:279,417` |
| 24 | PORT | S | `src/constants/files.ts:5` (+27 extensions) |
| 27 | PORT | S/M | `src/utils/attachments.ts:3156` (add NXt-style resync) + `REPL.tsx:3933` call |
| 30 | PORT | M | `permissions.ts:314-319`, `toolHooks.ts:634,697`, `PermissionRuleExplanation.tsx:47` |
| 31 | STAGED/N-A | — | fs-only `gitDiff.ts:308`; adopt `Nut` pattern when git-query lane lands |
| 32 | PORT | S | `scriptLoader.ts:206,244` (`getCwd()`→`getOriginalCwd()`) |
