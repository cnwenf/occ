# OCC Cluster E — UI / Features / Commands (official 2.1.287 → 2.1.288)

RESEARCH ONLY. No repo modification, no binary execution — byte forensics only
(`grep -aobF -e`, `tail -c | head -c | tr -d '\000'`, python3 read+slice).
Binaries: `/tmp/cc-diff-288/v287/package/claude`, `/tmp/cc-diff-288/v288/package/claude`.
OCC repo (read-only): `.../workdir/occ`.

**HONESTY NOTE.** Novelty is proved with *message/reason strings* and hit-count
deltas on the same needle, never with minified identifiers — those are
chunk-local and reused across versions (e.g. `RW=`, `TL(`, `eu(` each resolve to
several unrelated definitions). Where a behavioral fix could NOT be isolated to
a changed byte range, that is stated explicitly instead of guessed.

**Verdict vocabulary.** `PORT-CANDIDATE` = delta recovered byte-level (official
snippets + offsets + OCC touch points). `STAGED` = real OCC surface, delta
partially recovered or too large to port faithfully this round.
`NO-OP{NO-SURFACE|PLATFORM|ALREADY-ALIGNED}`.

## Verdict summary

| # | Entry (abridged) | Verdict |
|---|---|---|
| 1 | `$.ui.selection()` for mods | NO-OP{NO-SURFACE} |
| 2 | built-in `gh api` in cloud sessions + control-char fix | NO-OP{NO-SURFACE} |
| 3 | Up restores a Ctrl+C-cleared prompt draft | **PORT-CANDIDATE** |
| 5 | `--max-findings <n>\|all` for /code-review | **PORT-CANDIDATE** (explicit half) |
| 6 | Ctrl+F find + Alt+↑/↓ group jump in agents view | STAGED |
| 7 | SR announcement of permission mode on plan approval | **PORT-CANDIDATE** |
| 20 | mod button runs wrong action after restart | NO-OP{NO-SURFACE} |
| 21 | plugin pane `Code` unparseable diff → plain code | NO-OP{NO-SURFACE} |
| 29 | fullscreen "unrecoverable interface error" on bg-tasks dialog | NO-OP{NO-SURFACE} |
| 47 | Windows keyboard dead after self-restart | NO-OP{NO-SURFACE}+{PLATFORM} |
| 59 | "What should Claude do instead?" after ctrl+enter | **PORT-CANDIDATE** |
| 63 | cursor not following typed text (transcript / theme search) | STAGED |
| 64 | `/permissions` SR digit picks rule, not search | **PORT-CANDIDATE** |
| 66 | SR short announcements persist until keypress | **PORT-CANDIDATE** |
| 67 | SR question dialogs say "answered" | **PORT-CANDIDATE** |
| 68 | `/usage-credits` when credit requests are off | **PORT-CANDIDATE** |
| 71 | artifact DB size-limit write refusal message | NO-OP{NO-SURFACE} |
| 73 | self-hosted runner `gh api` improvements | NO-OP{NO-SURFACE} |
| 74 | Remote Control recovery from expired server credential | STAGED |
| 77 | `claude project purge` → `claude purge` + notice | **PORT-CANDIDATE** |
| 78 | agents view `n:` filter Enter → best name match | STAGED |

9 PORT-CANDIDATE · 4 STAGED · 8 NO-OP.

---

# PORT-CANDIDATEs (delta recovered byte-level)

## #64 — `/permissions` SR mode: a digit picks the rule, not the search box

> *"Fixed `/permissions` in screen reader mode: typing a rule's number now picks
> it instead of opening the search box."*

**Forensics.** Anchor `!=="j"` occurs exactly once per binary (v287
`@236593701`, v288 `@238030944`) — the permission-rule-list keydown router.

```js
// v287
if(De.key==="/")De.preventDefault(),_e(!0),It("");
else if(De.key.length===1&&De.key!=="j"&&De.key!=="k"&&De.key!=="m"
        &&De.key!=="i"&&De.key!=="r"&&De.key!==" ")De.preventDefault(),_e(!0),It(De.key)
// v288 — the ONLY change is the added guard:
else if(!De.defaultPrevented&&De.key.length===1&&De.key!=="j"&&De.key!=="k"
        &&De.key!=="m"&&De.key!=="i"&&De.key!=="r"&&De.key!==" ")De.preventDefault(),_e(!0),Vt(De.key)
```

The whole delta is the `!De.defaultPrevented` conjunct. The exclusion list
(`j k m i r space`) is unchanged — digits were never in it; the fix is
*precedence*, not the character set. When the row-select handler already
consumed the key, the search-seeding router now stands down.

**OCC state — AFFECTED, byte-identical to v287.**
`src/components/permissions/rules/PermissionRuleList.tsx:679-701`:

```ts
if (e.key === "/") { e.preventDefault(); setIsSearchMode(true); setSearchQuery(""); }
else { if (e.key.length === 1 && e.key !== "j" && … && e.key !== " ") {
  e.preventDefault(); setIsSearchMode(true); setSearchQuery(e.key); } }
```

No `defaultPrevented` guard. Digit selection lives in
`src/components/CustomSelect/use-select-input.ts:254-259` (index prefix rendered
at `select.tsx:524`), and the list is disabled while searching
(`PermissionRuleList.tsx:341 const t7 = isSearchMode || headerFocused`,
`:344 <Select isDisabled={t7}>`) — so a hijacked digit both opens search *and*
kills the numbered pick. Substring filter `:628`, footer hint `:1136`, wrapper
`onKeyDown` `:1157`.

**Port.** One token: add `!e.defaultPrevented &&` to the `else` condition at
`PermissionRuleList.tsx:~695`. Highest value/risk ratio in this cluster.

---

## #67 — SR question dialogs say "answered" beside the box

> *"Improved screen reader mode: answered questions in question dialogs now say
> 'answered' beside their box."*

**Forensics.** Anchor `` `question-${ `` — one site per binary (v287
`@227965672`, v288 `@229289888`). New constant v288 `@229288327`:
`var iXe="answered ";` (trailing space).

```js
// v287 tab renderer
let Wo=co?.key&&!!H[co.key]?X.checkboxOn:X.checkboxOff;
let Do=vo[Ho]||co?.displayHeader||`Q${Ho+1}`;
… children:[Wo," ",Do]
// v288
let bo=Qo?.key&&!!H[Qo.key];                        // isAnswered, now a named binding
let vo=bo?Z.checkboxOn:Z.checkboxOff;
let un=lo[mo]||Qo?.displayHeader||`Q${mo+1}`;
… children:[vo," ",Pe&&bo?iXe:"",un]                // Pe=Ye() = screen-reader enabled
```

The label is a *sibling text node between checkbox and display text* — invisible
in the box layout, spoken by the SR flat renderer. The memo dependency array
grows `w(38)`→`w(41)` with `Pe` added (`Ne[23..26]`) so the bar re-renders when
SR mode flips.

**OCC state — AFFECTED.**
`src/components/permissions/AskUserQuestionPermissionRequest/QuestionNavigationBar.tsx:113-119`:

```tsx
const isAnswered = q_1?.question && !!answers[q_1.question];
const checkbox = isAnswered ? figures.checkboxOn : figures.checkboxOff;
const displayText = tabDisplayTexts[index_2] || q_1?.header || `Q${index_2 + 1}`;
return <Box key={q_1?.question || `question-${index_2}`}>
  {isSelected ? <Text backgroundColor="permission" color="inverseText">{" "}{checkbox} {displayText}{" "}</Text>
              : <Text>{" "}{checkbox} {displayText}{" "}</Text>}</Box>;
```

Structurally identical to official v287 — no SR branch. `isAnswered` is already
computed. Sibling: `SubmitQuestionsView.tsx:58`. OCC's SR predicate is
`isScreenReaderEnabled()` (`src/utils/screenReader.ts:89`).

**Port.** Insert `{isScreenReaderEnabled() && isAnswered ? 'answered ' : ''}`
between checkbox and `displayText` in both branches; add the SR flag to the memo
deps.

---

## #68 — `/usage-credits` message when credit requests are off

> *"Improved the `/usage-credits` message shown to Team and Enterprise members
> whose organization has turned off usage credit requests."*

**Forensics.** v288 `@219946788`, function `ple(r,s)`. The `is_allowed===false`
branch's message changes and nothing else:

- v287: `"Contact your admin to manage usage credit settings."`
- v288: `"Usage credit requests are turned off for your organization."`

New string **0 → 2**; every sibling string in the same function (Team/Enterprise
gating, contact-admin variants) is **2 → 2**. `usage credit` overall 242 → 240
(the two removed hits are the retired v287 sentence). Copy-only change.

**OCC state — AFFECTED.** `src/commands/usage-credits/usage-credits-core.ts:53-58`
emits the *v287-era* generic text `'Please contact your admin to manage extra
usage settings.'`. Context: `:28-32` (Team/Enterprise branch), `:47-48`,
`:73-74`, `:89-91`, `:115`; render paths
`usage-credits-noninteractive.ts:13-14`, `usage-credits.tsx:12,14`.

**Port.** Single message swap at `usage-credits-core.ts:53-58`. Recommend the
official sentence verbatim — it names the *cause* (the org setting) instead of
deflecting to an admin.

---

## #77 — `claude project purge` → `claude purge`, old name prints a notice

> *"Changed `claude project purge` to `claude purge`; the old name still works
> and prints a notice."*

**Forensics.** v288 `@216868818` vs v287 `@215706833` (CLI command-registration
chunk). v288 adds a top-level `purge` command whose action reuses the same
handler binding (`dn`/`Mn`/`xn`/`In` map onto the v287 `project purge`
handler), plus:

```js
Zv(`${dn}. The old name still works for now.`)      // emitted on the legacy path
```

and telemetry `tengu_dead_probe_project_purge_alias`. Both novel (0 → N).

**OCC state.** `src/main.tsx:4870-4881` registers **only** `project purge [path]`
— no top-level `purge`, no alias, no notice. `src/cli/handlers/projectPurge.ts`
(238 lines) prints only `Purge plan for …`, `Dry run: N item(s) would be
deleted.`, `Deleted N item(s).`, `Cannot use -i/--interactive with --all.`.
Also `src/main.tsx:4857` (agents), `:4939-4942`, `:1414`;
`src/cli/handlers/agents.ts:85,209`. Adjacent gap noticed while reading: OCC's
`project purge` also lacks the official `-y/--yes`, so non-interactive purge is
not scriptable.

**Port.** Register top-level `purge` in `src/main.tsx` sharing
`projectPurge.ts`'s action; keep `project purge` as an alias that first emits
`The old name still works for now.` Skip the internal `tengu_dead_probe_*` event
(OCC analytics are stubbed). `-y/--yes` is an independent improvement — flag it,
don't bundle it.

---

## #59 — "What should Claude do instead?" hint after ctrl+enter

> *"Fixed the 'What should Claude do instead?' hint showing on the Interrupted
> row after sending queued messages with ctrl+enter."*

**Forensics.** Recovered chain across `@229515877`, `@229522066`, `@211321347`,
`@227398532`, `@227595016`, `@227597624`, `@200609235`:

1. `_sendNowCutSignal` / `_stampSendNowCut` — ctrl+enter ("send now") stamps the
   abort it causes so it is distinguishable from a user Esc interrupt.
2. `interruptedBySendNow` propagates on the abort metadata.
3. `Xs({isBySendNow})` → the Interrupted-row renderer takes the flag; `Ia()` /
   `Lt.Provider` thread it to the row.
4. The hint is emitted **only when `isBySendNow` is false**; the user-rejection
   case keeps `cZe="User rejected tool use"`.

**OCC state — AFFECTED.** `src/components/InterruptedByUser.tsx:8` renders
`<Text dimColor>Interrupted </Text>` + `· What should Claude do instead?`
**unconditionally** (the `ANT_ONLY` ternary compiles to `false ? …`). The
ctrl+enter path already exists: `src/utils/sendNow.ts:59
SEND_NOW_ABORT_REASON='user-cancel'`, `:154 sendQueuedNow`;
`src/screens/REPL.tsx:4146-4152 interruptRunningTurn`;
`src/hooks/useQueueProcessor.ts:29-50`; binding
`src/keybindings/defaultBindings.ts:84` → `chat:sendNow` (`schema.ts:98`).
OCC distinguishes the two aborts at the *reason* level but the row renderer
never reads it.

**Port.** Thread `isBySendNow` from `interruptRunningTurn` (where
`SEND_NOW_ABORT_REASON` is known) into the row's props and gate the hint suffix
in `InterruptedByUser.tsx:8` on `!isBySendNow`.

---

## #7 — SR announcement of the permission mode on plan approval

> *"Added a screen reader mode announcement of the new permission mode when you
> approve a plan, including with Shift+Tab."*

**Forensics.** Novelty: `{hold:!0}` **0 → 2** (the `hold` option does not exist
in v287 at all — see #66).

```js
// v288 @229358293 — new reusable announcer
function HE(h){QW(`[${TL(h)} on]`,{hold:!0})}
// v288 @229541912 — plan-approval resolution, after the permission context swap
let xt=N.getState().toolPermissionContext.mode;
if(Ct.mode&&xt===Ct.mode)QW(`[${TL(xt)} on]`,{hold:!0});   // only if the mode actually landed
```

`TL(mode)` is the permission-mode display label (v288 `@199918517` /
`@206406523`); `QW(text,opts)` is `queueAnnouncement` (#66). The pre-existing
Shift+Tab cycle site is unchanged in shape — v287 `aZ(\`[${lV(Ny)} on]\`)`
@227025099-region → v288 `QW(\`[${TL(Ny)} on]\`)` @229035709 — still *without*
`hold`; the auto-nudge site @228344030 likewise. So #7 is purely the two new
plan-approval sites; "including with Shift+Tab" refers to approving a plan
*via* the Shift+Tab row, which routes through the same resolution path.

**OCC state.** `src/components/PromptInput/PromptInput.tsx:1712` already does
`pushScreenReaderAnnouncement(\`[${permissionModeIndicator(nextMode)} on]\`)` on
the Shift+Tab cycle (2.1.210 #30 port) — byte-aligned with official. OCC has
**no** announcement on plan approval. `permissionModeIndicator` is the OCC
analogue of `TL`. `src/utils/screenReader.ts:180,197` — OCC's announce API takes
only a string today (no options object).

**Port.** Announce at the point OCC applies an approved plan's permission mode,
guarded by "only if the resulting mode equals the requested mode" (mirrors
`if(Ct.mode&&xt===Ct.mode)`). Pair with #66's `{hold:true}` once that lands; the
announcement is correct without it.

---

## #3 — Up on an empty prompt restores a Ctrl+C-cleared draft

> *"Added recovery for a prompt cleared with Ctrl+C: pressing Up on the empty
> prompt brings the draft back, including pasted text and images."*

**Forensics.** Novelty: `holdCleared` **0 → 3**, `restoreCleared` **0 → 3**.

Store methods — v288 `@228665940` (prompt-draft store class, the one that
already owns `stash`/`popStash`):

```js
holdCleared=()=>{let{value:h,mode:E,pastedContents:N}=this.#i;
  if(h.trim()!==""){let H=this.#e.getState().launchWarning;
    this.#S={text:h,mode:E,pastedContents:N,launchWarning:H??void 0}}};
restoreCleared=()=>{let h=this.#S;
  if(h===null||this.#i.value!=="")return!1;                  // only on an EMPTY prompt
  if(this.#S=null,this.#y(h.text,h.text.length,"input"),     // value + cursor at end
     this.#f({pastedContents:h.pastedContents,mode:h.mode}),
     h.launchWarning)VDn(this.#e,h.launchWarning);
  return!0};
```

`#S` is a **separate slot from the Ctrl+S `stash` slot** (`popStash` 5 → 5,
unchanged), so hold-cleared and stash never clobber each other. `pastedContents`
is restored wholesale — that is the "including pasted text and images" half.
Single-shot (`this.#S=null`), skipped for whitespace-only drafts.

Arming site — v288 `@228993610`, the Ctrl+C branch, *before* the clear runs:

```js
if(Ad.ctrl&&Ad.key==="c"&&(X_===0||eT))N.holdCleared();
```

Restore site — v288 `@228991419`, at the TOP of history-up (minified `Iy`):

```js
function Iy(){
  if(pg.length>1){return}                                   // suggestions open → bail
  let Xv=N.value.indexOf(`\n`);
  if(Xv!==-1&&N.cursorOffset>Xv){return}                    // multi-line, cursor past line 1 → bail
  if(N.restoreCleared()){wn(Py(N.value));return}            // ← NEW: draft first
  … ph()                                                     // fall through to real history
}
```

History-DOWN is unchanged — the restore is Up-only, matching the changelog.

**OCC state.** `src/hooks/useTextInput.ts:123-135` — Ctrl+C via `useDoublePress`;
first press does `if (originalValue) { onChange(''); setOffset(0);
onHistoryReset?.() }`. **No snapshot.** (Contrast: the Esc double-press at
`:141-170` *does* `addToHistory(originalValue)` — Esc already preserves, Ctrl+C
does not.) `:303` registers `['c', handleCtrlC]`; `:309` binds Up/Ctrl+P →
`upOrHistoryUp()` (`:351-374`). `src/hooks/useArrowKeyHistory.tsx:135-193
onHistoryUp`, `:145-152` draft save, `:204-211` draft restore — OCC already has
a *history-navigation* draft slot; it is not fed by Ctrl+C. Pasted-content
carrier exists: `src/utils/config.ts:55-63 PastedContent`, `:70-73
HistoryEntry{display,pastedContents}`, `src/history.ts:270-284`.
`PromptInput.tsx:1020-1039 handleHistoryUp`, `:1468-1473 handleClearInput`
(Ctrl+L, already pushes an undo buffer), `:1543-1569 handleStash` (Ctrl+S — the
direct analogue of official `stash`/`popStash`).

**Port.** Add a `heldCleared` slot written in the Ctrl+C first-press branch of
`useTextInput.ts:123-135` *before* `onChange('')`, holding
`{ text, pastedContents }`; consume it at the top of `upOrHistoryUp()` /
`PromptInput.tsx:1020-1039` with the official guards (empty value only,
single-shot, skip whitespace-only, bail when suggestions are open). Restore
`pastedContents` through the existing `updateInput` path
(`useArrowKeyHistory.tsx:119-124` already re-applies it). Do **not** reuse the
Ctrl+S stash slot.

---

## #5 — `--max-findings <n>|all` for /code-review (explicit-flag half)

> *"Added `--max-findings <n>|all` to /code-review to report more or fewer
> findings than the usual limit; the choice is reused until you pass
> `--max-findings default`."*

**Forensics.** Novelty: `--max-findings` **0 → 27**, `codeReviewLastMaxFindings`
**0 → 4**, `maxFindingsIgnored` **0 → 6**.

Flag regex + parser — v288 `@216200378`:

```js
Qo=/(^|\s)--max-findings(?:(?:\s*=\s*|\s+)(?!--)(\S+)|\s*=\S*)?(?=\s|$)/g
// He(e) → { …, maxFindings:k, maxFindingsIgnored:x }
//   k = C==="all"||C==="default" ? C
//     : (Number.isSafeInteger(S)&&S>0 ? S : void 0)
```

Hard cap + resolution (same site) — `var We=32;`:

```js
function on({maxFindings:e},o,n,s){
  let r=le().codeReviewLastMaxFindings,                          // sticky value from storageV5
      h=e===void 0&&o!=="low-sonnet5"&&!s?.options?.isSkillPreload
        &&(r==="all"||typeof r==="number"&&Number.isSafeInteger(r)&&r>0),
      g=h?r:e==="default"?void 0:e,                              // `default` clears
      C=o==="low-sonnet5"?void 0
        :(n||o==="o5-bmin")&&(g==="all"||g!==void 0&&g>We)?We:g; // clamp to 32
  return{asked:g,stated:C,reused:h}}
```

User-facing notes — `nn({asked,stated,reused,ignored},r)`:

- `` `--max-findings` was ignored: type a whole number above zero, `all`, or `default` after it.` ``
- `` `This review reports at most ${We} findings, so the limit is ${We} here.` ``
- `` `Reporting every finding, as ${r} chose last time with `--max-findings all`.` ``

Persistence writer — v288 `@216211405`, a NEW skill hook
`onUserTypedArgs(e,o)`: parses with `He`, writes `xa(n,o.storageV5)` when the
flag was explicit, and merges `codeReviewLastMaxFindings` (`"default"` →
`undefined`) into `storageV5` otherwise. Help text: `Pass --max-findings <n> to
report up to n findings, or --max-findings all for every finding. The choice
stays until you pass --max-findings default.` Remote/PR parser `@220268590`
(`Nxt(o)`) accepts `--fix|--comment|--post|--no-post|--max-findings(?:…)`.

**OCC state.** `src/skills/bundled/simplify.ts:35-44 EFFORT_CONFIG` already
carries a per-tier `maxFindings` (low 3 / medium 6 / high 10 / xhigh 15 /
max 15) and `:112` already interpolates `cap the report at ${cfg.maxFindings}
findings` — the concept exists, it is just not user-overridable.
`:143-173 parseCodeReviewArgs` handles only `--fix` / `--comment` / effort /
target / PR number. `:13-14 CODE_REVIEW_ARGUMENT_HINT` and `:19-31
CODE_REVIEW_USAGE` need the flag documented. `src/skills/bundledSkills.ts` —
`BundledSkillDefinition` has **no `onUserTypedArgs` hook**, and OCC has no
`codeReviewLast*` persistence key.

**Port / honest limit.** Directly portable: the `Qo` regex, the
`all|default|positive-safe-integer` validation, the `We=32` cap, the three note
strings, the hint/usage text, and threading `maxFindings` into the cap at
`simplify.ts:112`. **Not** portable without new infrastructure: the
`onUserTypedArgs`-driven cross-session reuse. Land the explicit-flag half + the
ignored/cap notes now; keep reuse staged until `BundledSkillDefinition` grows a
typed-args hook.

---

## #66 — SR short announcements stay until the next keypress

> *"Improved screen reader mode: short announcements, such as a deleted word, now
> stay on screen until your next key press or until something above them on
> screen changes."*

**Forensics.** Novelty: `srAnnounce` **0 → 11**, `srHeldAnnouncements` **0 → 8**,
`srAnnouncementHoldTimer` **0 → 11**, `srRewriteHeldAnnouncement` **0 → 3**.
(`srStartupQuietTimer` 8 → 8 and `srPreParkTimer` 10 → 10 are pre-existing.)

Announcement-queue module — v288 `@201612200`–`@201613724`, recovered whole
(chunk ends `// @bun @bytecode`):

```js
class E{#n;#s;#r;#o=null;#i=null;#u=!1;#e=[];#t=!1;#a=0;   // #t=holdRequested, #a=holdUntilMs
  queueAnnouncement(e,n=!1){if(this.#e.push(e),n)this.#t=!0;
    if(this.#e.length>m)this.#e.splice(0,this.#e.length-m)}   // m=16
  drainAnnouncements(){return this.#e.splice(0)}
  takeHoldRequest(){let e=this.#t;return this.#t=!1,e}
  startHold(e){this.#a=e}   endHold(){this.#a=0,this.#t=!1}
  holdActive(e){return e<this.#a}   reset(){…;this.#t=!1,this.#a=0}}
var m=16;
function QW(e,n){r().queueAnnouncement(e,n?.hold===!0)}        // push(text,{hold:true})
function t9o(){if(r().takeHoldRequest())
  return Math.min(a.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS??1000,1e4);  // default 1000 ms, cap 10 s
  return 0}
function n9o(e){r().startHold(Date.now()+e)}   function zWe(){r().endHold()}
function r9o(){return r().holdActive(Date.now())}
function o9o(){return r().drainAnnouncements()}
var Z8o=()=>a.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT??!1
```

New env knobs: `CLAUDE_AX_ANNOUNCEMENT_HOLD_MS` (default 1000, clamped 10000),
`CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT` (default false).

Renderer integration — v288 `@213429200` (`onRenderScreenReader`):

```js
if(this.srAnnouncementHoldTimer!==null){
  if(r9o()&&!this.isExiting)return;                    // hold armed → skip re-render entirely
  clearTimeout(this.srAnnouncementHoldTimer),this.srAnnouncementHoldTimer=null}
let F=o9o().map((se)=>Us(se)).filter((se)=>se!=="");
if(F.length>0||this.isExiting)this.srHeldAnnouncements=F;   // announcements become held lines
… append held lines below the transcript, park cursor at the first held line (H) …
// "or until something above them on screen changes":
let j=x.length-k, Q=j>Math.min(FC,Math.floor(this.terminalRows/4));
if(Q)this.srHeldAnnouncements=[];                            // too many new lines → drop
if(F.length===0&&j>0&&(Q||!this.srRewriteHeldAnnouncement
    &&(B.length!==x.length||x.some((se,le)=>le<k&&se!==B[le]))))
  this.srHeldAnnouncements=[],x.length=k;                    // lines above changed → drop
if(H!==-1&&L>0&&!this.isExiting)                             // L=t9o()
  n9o(L),this.srAnnouncementHoldTimer=setTimeout(()=>{this.srAnnouncementHoldTimer=null,this.onRender()},L);
```

Keypress release — v288 `@213420431`, `requestInputPriorityFrame()`: bumps
`inputPriorityUntil`, then `if(this.srAnnouncementHoldTimer!==null)zWe(),n=!0;`
and `if(this.isScreenReaderEnabled&&this.srHeldAnnouncements.length>0)
this.srHeldAnnouncements=[],n=!0; if(n)this.onRender()`. `unmount()` also
clears `srAnnouncementHoldTimer` (`@213455349` region).

**OCC state.** `src/utils/screenReader.ts:180,197 pushScreenReaderAnnouncement(text)`
— fire-and-forget queue; `:210 drainScreenReaderAnnouncements`. No `hold`
option, no hold timer, no held-line concept. `src/ink/screen-reader-render.ts:112,408,444`
emits announcements but never keeps them across frames. Frame pipeline:
`src/ink/ink.tsx:889-925,1218-1221,1266,1340,1425,1494-1507` — OCC has no
`requestInputPriorityFrame` equivalent. Plumbing: `src/utils/srA11y.ts:33,39-42,63,80,96`,
`src/ink/components/ScreenReaderContext.ts:11`.

**Port.** Three coordinated pieces: (a) `pushScreenReaderAnnouncement(text,{hold})`
+ `takeHoldRequest/startHold/endHold/holdActive` on the OCC queue; (b)
held-announcement lines appended by `screen-reader-render.ts` with the
"lines above changed" invalidation; (c) an input-priority frame hook calling
`endHold()` + clearing held lines on any keypress. Largest SR change in the
release — its own task, and it upgrades #7.

---

# STAGED (real OCC surface; delta not fully portable this round)

## #6 — Ctrl+F find + Alt+↑/↓ group jump in the agents view

> *"Added Ctrl+F to find a session by name and Alt+↑/↓ to jump between groups in
> the agents view; both, and rename, can be rebound in keybindings.json."*

**Forensics (substantially recovered).** New actions (v287 → v288):
`agents:find` **0 → 7**, `agents:nextGroup` **0 → 8**, `agents:previousGroup`
**0 → 8**, `agents:rename` **0 → 8**, `agents:setGroup` **0 → 9**. New defaults:

```js
{context:"Agents",bindings:{"ctrl+s":…,"ctrl+t":…,
  "ctrl+f":"agents:find","ctrl+r":"agents:rename",
  "ctrl+up":"agents:previousGroup","meta+up":"agents:previousGroup",
  "ctrl+down":"agents:nextGroup","meta+down":"agents:nextGroup"}}
```

Group-jump helper `ef(o,u,f)`; find-query→`n:` transformer `xr(o)`; filter-token
regex `ba=/(?:^|\s)(?:[aso]:|n:(?!\\))/gi`; telemetry `fleet_view_find`
**0 → 3**, `fleet_view_group_jump` **0 → 3**. FleetView chunk ≈217.6–217.8 M in
v288 (≈216.4 M in v287). The group *data model* the jump walks was not fully
isolated.

**OCC state.** `src/components/FleetView/FleetViewScreen.tsx:97 groupMode` is
**write-only** — no group navigation; `:219-222` renders a flat daemon list;
`rowHelpers.ts:43-44` only has running/done buckets. `:119-197` uses raw
`useInput` bypassing the keybinding subsystem entirely (`:145-154` arrows,
`:155-159` Enter toggles preview, `:183-186` Ctrl+g). No `Agents` keybinding
context: `src/keybindings/schema.ts:12 KEYBINDING_CONTEXTS`, `:68
KEYBINDING_ACTIONS` is a **closed array** (~100 entries) validated by
`z.enum(KEYBINDING_ACTIONS)` at `:231` (`:234` has only a `command:` escape
hatch); `defaultBindings.ts:32`, `loadUserBindings.ts:127`. Ctrl+F is already
taken in Transcript context (`defaultBindings.ts:251 → scroll:fullPageDown`) —
no conflict with a new `Agents` context, but check the reservation table.

**Why STAGED.** Requires (a) five new entries in the closed enum + a new
`Agents` context, (b) a group data model OCC does not have, (c) converting
FleetViewScreen off raw `useInput` onto `useKeybinding`. A feature build, not a
delta port — same agents-view family prior rounds staged. Evidence above is
sufficient to scope it.

## #78 — agents view `n:` filter Enter opens the best name match

> *"Changed the agents view `n:` filter (and Ctrl+F search) so Enter opens the
> session whose name matches best instead of the top row."*

**Forensics (recovered, one gap).** v287 `@216438530`:

```js
let Ie=pe?0:Be?Math.max(0,we.findIndex((ge)=>ge.kind==="job"||ge.kind==="earlier")):Kd(we,ke)
```

v288 `@217678518`: `let We=ie?0:Ve?eu(Lt,qe):Zd(Lt,Pe)` with the NEW scorer at
v288 `@217622180` (pattern has 0 hits in v287):

```js
function eu(o,u){let f=0,h=-1;
  for(let[k,b]of o.entries()){
    if(b.kind!=="job"&&b.kind!=="earlier")continue;
    let v=u?Ii(b.kind==="job"?b.job.state:{name:b.entry.title,intent:""},u):0;
    if(v>h)h=v,f=k}
  return f}
```

v287 took `findIndex` — the **first** job/earlier row — while a filter was
active; v288 takes the row with the **highest name-match score**. The row filter
uses the same scorer (`if(qe&&Ii(he.state,qe)===0)return!1`). The `n:` regex,
the parser `wu()`, and the `ec(...)` filter/sort pipeline are **rename-only
identical v287↔v288**.

**Unrecovered (honest gap):** `Ii`, the name-scorer, is imported from another
chunk; its definition was not isolated. Its contract is clear from both call
sites (0 = no match, higher = better, accepts a job-state object or
`{name,intent}`), but the exact algorithm is not recovered — do not invent it.

**OCC state / why STAGED.** Same as #6: OCC's FleetView has no `n:` filter, no
name-query, no Ctrl+F, no home-index computation to change. Blocked on the #6
build. The delta itself is tiny and fully recovered except the scorer — record
it so the #6 implementer lands best-match Enter semantics from the start rather
than `findIndex`.

## #74 — Remote Control recovery from an expired server credential

> *"Improved Remote Control's recovery from an expired server credential:
> sessions stay connected during renewal and are kept if it gives up after a
> server outage."*

**Forensics.** Novelty: `environmentSecretExpiresIn` **0 → 5**,
`Could not renew the Remote Control credential` **0 → 6**, `Renewing this
computer` **0 → 2**, `secret_renewal_due` **0 → 2**, `Giving up the planned
renewal` **0 → 2**, `poll-401 lane` **0 → 2**, `server kept returning a
different environment id` **0 → 2**. Pre-existing in v287 (so NOT new):
`tengu_bridge_env_reregister` 7 → 8, `register_rejected` 7 → 11, `reregistered`
8 → 10, `renewalsNotYetReported` 5 → 5 — v287 had *reactive* re-registration
only; v288 adds the **proactive expiry-driven** lane.

v288 `@222979800`, poll loop:

```js
function Nt(){return !le && z!==void 0 && Date.now()>=z && Vhn() && dzr()}   // renewal due?
async function tr(){
  k++; s.logVerbose("Renewing this computer's Remote Control credential before it expires");
  let r=await gLn({api:a,config:e,environmentId:n,activeSessions:R,attempt:k,
                   trigger:"proactive",signal:E});
  if(r.outcome==="reregistered"){                       // success
    de=r.environmentSecret; z=mLn(r.environmentSecretExpiresIn);
    Z=d("proactive"); Ge=!0; ct=k; s.logVerbose("Remote Control credential renewed."); return}
  if(E.aborted)return;
  if(r.outcome==="transient"||r.reason==="replaced"&&k<Eyo){   // retry w/ jitter
    let b=Math.max(wyo,Math.min(r.outcome==="transient"?r.retryAfterMs??0:0,vyo));
    z=Date.now()+b*(1+0.25*Math.random());
    s.logVerbose(`Could not renew the Remote Control credential yet. The current one still works; trying again in about ${Math.ceil((z-Date.now())/60000)} minutes.`);
    return}
  z=void 0;                                             // give up: clear the PLAN, keep sessions
  s.logVerbose(r.reason==="register_rejected"&&r.status===401
    ? "Could not renew the Remote Control credential because your claude.ai login is no longer valid. Run `claude /login`. The current credential keeps working until it expires."
    : "Could not renew the Remote Control credential. It keeps working until it expires, and Remote Control will try again then.");
  t(`[bridge:poll] Giving up the planned renewal of the environment secret (${
      r.reason==="replaced"?"server kept returning a different environment id"
        :`register refused with ${r.status}`
    }); the current secret works until it expires, then the poll-401 lane handles it`,{level:"warn"})}
```

**(a) "sessions stay connected during renewal"** — the at-capacity heartbeat
loop now wakes on the renewal deadline instead of sleeping past it:

```js
while(!E.aborted && R.size>=e.maxSessions && (g===null||Date.now()<g) && !Nt()){…
  let Te=Math.min(wt, g??1/0, z!==void 0&&z>Date.now()?z:1/0);              // sleep capped at deadline
  await ee(Math.max(0,Te-Date.now()),C.signal); …}
let N = … : Nt()?"secret_renewal_due" : "config_disabled";                  // ← NEW exit reason
i("tengu_bridge_heartbeat_mode_exited",{reason:d(N),heartbeat_cycles:D,active_sessions:R.size});
```

and the top of the poll loop drains renewal first:
`while(!E.aborted){et();let r=s5();if(Nt()){await tr();continue} …}`.

**(b) "are kept if it gives up after a server outage"** — on terminal failure
`tr()` only clears `z` and logs; it does **not** tear down `R` (active sessions)
or exit the loop. Recovery is deferred to the existing poll-401 lane. Success
telemetry `tengu_bridge_env_reregister{attempt:ct,outcome:"recovered",trigger:Z}`
with `k=0` reset.

**Unrecovered (honest gap):** `gLn` (re-register attempt), `mLn`
(expiry→deadline), `Vhn`/`dzr` (gates) and pacing constants `wyo`/`vyo`/`Eyo`
(`Eyo` = max attempts for the `replaced` retry path) live in another chunk.

**OCC state.** OCC **does** have the environment-secret poll bridge:
`src/bridge/bridgeMain.ts` (heartbeat loop `:727-790`, incl.
`tengu_bridge_heartbeat_mode_entered` `:728` / `_exited` `:777`; also
`:804,844-847,892-895,1299-1302,1411,1472,2686`),
`src/bridge/pollConfig.ts:43 non_exclusive_heartbeat_interval_ms`,
`:47-65 multisession_poll_interval_ms_*`, `src/bridge/bridgeDebug.ts:24,114-117
pollForWork`, `src/bridge/bridgeApi.ts:106-138,473-474,503-507`. OCC has **no
renewal lane at all**: `grep -n renew src/bridge/bridgeMain.ts` → 0 hits; no
`environmentSecretExpiresIn` tracking, no `secret_renewal_due` exit reason.
OCC's `renew`/`proactive` hits are the *separate* JWT-based REPL bridge
(`remoteBridgeCore.ts:79,330-365,468,692`, `jwtUtils.ts:64`,
`envLessBridgeConfig.ts:21`, `initReplBridge.ts:387`) — different credential,
different transport; do not conflate. `src/commands/remoteControlServer/index.js`
is `export default {}`.

**Why STAGED.** The poll-loop integration is fully recovered and maps onto
`bridgeMain.ts:727-790`, but the renewal *engine* is not — porting it would mean
inventing the re-register retry/backoff contract. Needs a dedicated
decompilation pass on the register/renew helper chunk.

## #63 — terminal cursor not following typed text

> *"Fixed the terminal cursor not following the typed text in the fullscreen
> transcript viewer's search and in `/theme`'s custom color search."*

**Forensics — delta NOT byte-isolated (honest gap).** The mechanism is almost
certainly the declared-cursor path: `declareCursor` **8 → 9** and exactly one
site is new — v288 `@228779798`, inside the **Ctrl+R history-search** component
(`function Kte({initialQuery,onSelect,onCancel})` → `ga("history-search")`,
telemetry `history_search_open`), in VirtualList `$te`'s renderItem:
`e(Rk,{isFocused:Gt,declareCursor:Ge,…})` with `Ge=Ye()`. That is *not* the
fullscreen transcript viewer's search nor `/theme`'s color search. Supporting
counts are flat: `CursorDeclaration` 6 → 6, `relativeX` 4 → 4,
`backspaceExitsOnEmpty` 8 → 8, `showCursor` 52 → 52, and `transcript_search` /
`searchTranscript` / `TranscriptSearch` / `custom color` / `customColor` /
`colorSearch` / `Search colors` are 0 in **both** binaries. A sibling 2.1.288
entry (*"Fixed screen reader mode leaving the cursor away from the typed text in
search boxes (such as /resume and /permissions) and sign-in code fields"*)
suggests a family of call-site fixes; I could not attribute byte ranges to the
two surfaces #63 names. **Not guessed.**

**OCC state — plausibly affected, not proven equivalent.** OCC *has* the
machinery: `src/ink/hooks/use-declared-cursor.ts:25
useDeclaredCursor({line,column,active})` + `CursorDeclarationContext` (full
node-identity clobber guard, `relativeX/relativeY/node`), used by
`src/components/SearchBox.tsx:36-40,57`. OCC's fullscreen transcript search does
**not** use it: `src/screens/REPL.tsx:383 TranscriptSearchBar`, inverse-video
pseudo-caret at `≈:466-471`. That component is **OCC-authored** ("less-style `/`
bar"), not a decompilation of the official transcript viewer — so OCC's caret bug
and the official one are analogous, not identical. `/theme` color search
likewise: `src/components/CustomThemeCreator.tsx:105,156-159,196-201,215-220,226`
draws a fake `▏` caret; `src/commands/theme/theme.tsx:52`,
`src/commands/theme/customThemes.ts:89-97`. Fullscreen machinery exists
(`src/ink/ink.tsx:504-652,889-925` alt-screen, `src/utils/fullscreen.ts:113,117-133`,
`src/components/FullscreenLayout.tsx`, `src/ink/components/AlternateScreen.tsx:17,55`),
so this is not an automatic NO-SURFACE.

**Why STAGED.** The fix OCC would want (wire `useDeclaredCursor` into
`TranscriptSearchBar` and `CustomThemeCreator`) is clear and low-risk, but it is
an **OCC-side improvement inspired by the entry, not a byte-level port of it**.
STAGED keeps the "PORT-CANDIDATE requires recovered bytes" discipline intact.

---

# NO-OP{NO-SURFACE} / {PLATFORM}

## #1 — `$.ui.selection()` for mods (delta fully recovered)

> *"Added `$.ui.selection()` for mods: returns the text you last selected in
> fullscreen mode and, when the selection lies within one transcript row, that row."*

`ui.selection` **0 → 4**, all four sites recovered: bytecode symbol table
`@99177132`; host capability list `Xe` `@202721197`
(`…"ui.panes","ui.selection","ui.copy","ui.blit","fs.read"…`); plugin SDK `$.ui`
surface `@202953736` (`selection:()=>t("ui.selection",{})`); host dispatch table
`@208909174` (`"ui.selection":{run:Vxt}`). Implementation `@208518749`:

```js
var Vxt=()=>Promise.resolve(ax()?.selection?.read());
```

The whole capability is a thin read of the ink instance's selection engine, and
it has **no `check`** (unlike `ui.scroll`/`ui.focus`/`ui.copy`), so it is
unconditional for any mod holding `ui.*`.

**OCC state.** No mods subsystem: no plugin-RPC host, no `ui.*` capability
table, no `$.ui` SDK surface. The underlying selection engine *does* exist
(`src/ink/selection.ts:19-30,33-50,773 getSelectedText`,
`src/hooks/useCopyOnSelect.ts`, `src/ink/parse-keypress.ts:64 SGR_MOUSE_RE`) but
has no consumer to expose it to. → **NO-OP{NO-SURFACE}**.

## #2 — built-in `gh api` in cloud sessions + control-character fix

> *"Added a built-in `gh api` to cloud sessions whose image has no GitHub CLI,
> and fixed the built-in sending control characters from file names, jq filters
> or GitHub errors to the terminal."*

`gh api` **34 → 118**. The built-in already existed in v287 (`not supported for
non-GET` 4 → 4, `no GitHub CLI was found on this machine` 2 → 2, `rel="next"`
4 → 4). New in v288: ``Instead of `gh `` **0 → 1**; `Claude Code's built-in
GitHub client, not the GitHub CLI` **0 → 4** (`var me=…`); `takes this one`
**0 → 2** (help: *"A GitHub CLI installed during the session takes this one's
place once it is on PATH. On a self-hosted runner that one has only the GitHub
credentials the runner's operator provides and does not go through this
session's GitHub proxy."*); `per_page` **11 → 19**.

**Control-character fix (recovered — the transferable part).** v288
`@202763709`:

```js
var SV={escape:String.raw`\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f`,
        placeholder:String.raw`\u{10eeee}`,loneSurrogate:String.raw`\ud800-\udfff`};
var RW=new RegExp(`[${String.raw`\t\n\r`}${SV.escape}${SV.loneSurrogate}${SV.placeholder}]`,"gu");
var W5n=(e)=>e.replace(RW,"?");
function AD(e){let n=String(e).replace(RW,"?");return n.length<=C5n?n:`${re(n,C5n)}...`}  // C5n=40
```

`replace(RW,"?")` **0 → 5**; the validator `lx(` **7 → 23** (new messages: "a
text child holds a control character (an escape sequence)", "Link label holds a
control character (an escape sequence)"). The five sinks: Box-key validation
text (`AD`) `@206034034`, the plugin-pane `Code` message (#21) `@206075184`, the
terminal-image capability probe log `@223376087`, and the image-source refusal
log `@223376730`. `SV` pre-existed in v287 (`loneSurrogate:String.raw` 1 → 1);
the *combined output sanitizer* `RW` and its call sites are new.

**OCC state.** No cloud sessions, no self-hosted runner
(`src/self-hosted-runner/main.ts` = 3-line stub; `src/entrypoints/cli.tsx:293
feature("SELF_HOSTED_RUNNER")`; `src/utils/featureFlags.ts:13,59` — not in the
6-flag allowlist), and `src/utils/permissions/dangerousPatterns.ts:63-68`
actively **deny-lists `'gh api'`**. No built-in gh to sanitize. →
**NO-OP{NO-SURFACE}**.

*Carry-forward note (not a port recommendation):* `RW` is a clean recipe for
"replace C0+C1 controls, lone surrogates and U+10EEEE with `?` before writing
untrusted text to the terminal". If OCC ever wants terminal-injection hardening
for tool-output error messages, this is the byte-verified pattern.

## #73 — self-hosted runner `gh api` improvements

> *"Self-hosted runner: Improved the built-in `gh api`: a refused gh command now
> prints its `gh api` equivalent, `--paginate` follows every page of a
> repository's lists, and a nested `claude` no longer removes it."*

All three bullets recovered under #2. Flag/alias tables verbatim at v288
`@218279000` (value-taking `Ze`, boolean `et`, explicitly-unsupported `tt`):

```js
var Ze={"-X":"--method","-f":"--raw-field","-F":"--field","-H":"--header","-q":"--jq",
        "-t":"--template","-p":"--preview","--input":"--input","--hostname":"--hostname",
        "--cache":"--cache", …long forms map to themselves…},
    et={"-i":"--include","-h":"--help","--paginate":"--paginate","--silent":"--silent",
        "--slurp":"--slurp","--verbose":"--verbose"},
    tt=new Set(["--template","--preview","--slurp","--verbose"]);
```

Plus `--paginate  Follow the response's rel="next" links (GET only)`, the parser
`ye(e,t,r,s)`, the repo/URL shape guards `Ye=/^(-R|--repo)(=|$)|^-R[^-]/`,
`Qe=/^https?:\/\/[^/]+\/[^/]+\/[^/]+/`, `Ke=/^[^-/][^/]*(\/[^/]+){1,2}$/`, and
the GraphQL refusal `fe`. OCC surface: none (runner stubbed, flag off, `gh api`
deny-listed). → **NO-OP{NO-SURFACE}**.

## #20 — mod button runs a different button's action after restart

> *"Fixed a mod's button sometimes running a different button's action when
> pressed on a view drawn before Claude Code restarted."*

**Delta NOT isolated (honest gap).** No distinguishing needle moved:
`"ui.press"` 10 → 10, `ui.resolve` 38 → 38, `actionId` 8 → 8, `pressId` 7 → 7,
`instanceId` 149 → 149; `buttonId`/`pressToken`/`staleView`/`viewEpoch`/
`hostGeneration`/`bootId`/`beforeRestart` are 0 in both. The fix is presumably
an identity/generation guard on the press-target lookup inside the mod pane
mount registry (same chunk family as #1/#21 — note the `GFt=LUr()` WeakMap of
mounts at v288 `@206034034`), but no changed byte range could be pinned.

**OCC state.** No mods, no plugin panes, no `ui.press` RPC, no cross-restart
view persistence. The bug's precondition (a view drawn *before* the process
restarted, still pressable afterwards) needs both the mod surface and in-process
self-restart — OCC has neither (see #47). → **NO-OP{NO-SURFACE}**.

## #21 — plugin pane `Code` with an unparseable diff draws as plain code (delta fully recovered)

> *"Fixed a plugin's pane showing nothing when one `Code` element held a diff
> that does not parse; it now draws as plain code."*

`plain code` **1 → 3** (v287's single hit is embedded changelog text; v288 adds
a bytecode-blob hit + one real code hit). `drawn plain` **0 → 2**.
`kind:"refused"` 104 → 115. v288 `@206062250`:

```js
var $5n=(e)=>`Code ${e.ordinal} drawn plain`;
var F5n=200;
function U5n({ordinal:e,path:n,problem:r}){
  let s=n===void 0?"":` (path "${n}")`,
      g=r.length>F5n?`${re(r,F5n)}...`:r;                 // truncate the complaint to 200 chars
  return `Code ${e}${s} is drawn as plain code, its source not a unified diff: ${g}`
           .replace(RW,"?")}                               // ← the #2 sanitizer
```

and the row measurer immediately before it (`iBr(e)`) shows the fallback
semantics — a refused parse yields **zero gutter** and no hunk expansion, so the
element measures as ordinary code instead of throwing the pane away:

```js
let S=tBe(n,s), w=S?.kind==="hunks"?S.hunks:[],            // refused → no hunks
    x=g+Math.max(0,w.length-1);
let D=r===void 0||S?.kind==="refused"?0:r+g-1,              // refused → no line-number gutter
    H=D===0?0:String(D).length+2, K=Math.max(H,...w.map(YYe));
return x+Math.floor(ae(qFt(n))/(Mwn-K))
```

**OCC state.** No plugin panes, no plugin `Code` element
(`src/components/design-system/Pane.tsx:7-19` is OCC's unrelated design-system
pane). OCC's diff renderer `src/components/StructuredDiff.tsx:100-105,111-114,136,151-154`
already has `src/components/StructuredDiff/Fallback.tsx`, so the analogous OCC
behaviour is fine. → **NO-OP{NO-SURFACE}**.

## #29 — fullscreen exit with "unrecoverable interface error" on the bg-tasks dialog

> *"Fixed fullscreen sessions exiting with 'unrecoverable interface error' when
> opening the background tasks dialog while a plugin or mod showed rows above
> the prompt."*

**Specific fix NOT isolated (honest gap).** `unrecoverable interface error`
**2 → 3**, but the third hit `@216686754` is the embedded CHANGELOG text, not
code (proved by extraction). v287 `@221435933` ↔ v288 `@222729204` is the single
pre-existing code site (renamed identifiers only); `@93272896`/`@93278408` are
bytecode symbol blobs. Layout-fault machinery is byte-stable:
`reportLayoutFaultPersisting` 3 → 3, `layoutFaultDebugLines` 5 → 5,
`ink layout pass` 10 → 10, `logLayoutFaultForDebugging` 3 → 3. Pre-existing
top-level catch @21865173: `` `Claude Code exited after an unrecoverable
interface error (${P.message}).${O}` `` + `h8t()`. So the fix is **upstream of
the fault** — almost certainly in plugin/mod row measurement above the prompt
(the `iBr`/pane-sizing family of #21, where a refused `Code` parse used to
poison the measure pass). Not pinned; not guessed.

**OCC state.** OCC has fullscreen (`src/ink/ink.tsx:504-652` DEC 1049,
`src/ink/components/AlternateScreen.tsx:17,55`, `src/utils/fullscreen.ts:113,117-133`,
`src/components/FullscreenLayout.tsx`) and a background-tasks dialog
(`src/components/tasks/BackgroundTasksDialog.tsx:131,178`, opened from
`PromptInput.tsx:2393-2395` early-return / `:2556` fullscreen-gated
`onOpenTasksDialog`, `src/hooks/useBackgroundTaskNavigation.ts:184-187`,
`src/context/overlayContext.tsx`, `src/commands/tasks/{index.ts,tasks.tsx:6}`).
But the changelog's **precondition** — "while a plugin or mod showed rows above
the prompt" — is a surface OCC lacks: no plugin/mod row injection above
PromptInput. → **NO-OP{NO-SURFACE}**.

## #47 — Windows keyboard dead after Claude Code restarts itself

> *"Fixed the keyboard not working on Windows after Claude Code restarts itself
> (first sign-in to a Claude apps gateway, provider setup, `/tui`)."*

**Delta NOT isolated (honest gap).** Every Windows-console needle is absent from
both binaries (`SetConsoleMode` 0/0, `GetConsoleMode` 0/0, `SetStdHandle` 0/0,
`CONIN$`/`conin$` 0/0, `conhost` 0/0, `legacyWindows` 0/0) and the restart
plumbing is flat: `reExec` 18 → 18, `win32` 293 → 293, `rawMode` 28 → 28,
`windowsHide` 104 → 104, `detached:!0` 19 → 19. Only `spawnSync` 36 → 37 and
`stdio:"inherit"` 13 → 14 moved (+1 each); proximity searches (`relaunch`/
`reExec`/`spawnSync` within 800–1500 chars of `win32`) found no new
Windows-adjacent restart site. The fix is real but indistinguishable from rename
noise.

**OCC state — no self-restart surface at all.**
`grep -rn "restartProcess|execPath|relaunch|process.execArgv" src` shows OCC
never re-execs itself. `/tui` (`src/commands/tui/tui.ts:41-43,81-100`,
`src/commands/tui/index.ts:16-20`) only saves the setting via
`updateSettingsForSource('userSettings',{tui})`, logs `tengu_tui_command`, and
prints `Renderer set to ${target}. The setting was saved; restart Claude Code to
apply it.` — its own header comment records that "the live renderer switch
(restart-and-resume) is not wired here". Provider setup and gateway sign-in
likewise only print restart strings (`src/commands/setup-vertex.ts:82`,
`src/commands/setup-bedrock.ts:65`, `src/components/ConsoleOAuthFlow.tsx:464`).
OCC's `process.execPath` uses are child spawns
(`src/tools/shared/spawnMultiAgent.ts:191,198`, `src/daemon/workerRegistry.ts:251`,
`src/daemon/supervisor.ts:89-96`, `src/bridge/sessionRunner.ts:335`), not
self-replacement. Stdin safety is `src/utils/stdinGuard.ts:17-21,145`.
→ **NO-OP{NO-SURFACE}** (no in-process self-restart to fix) **+
NO-OP{PLATFORM}** (Windows console only). Double no-op.

## #71 — artifact DB size-limit write refusal message

> *"Improved the error for an artifact database write refused at the database's
> size limit: it now states the limit and what frees space."*

**New message NOT isolated (honest gap).** `artifact database` 28 → 28 (flat);
`artifactDatabase` / `Artifact DB` / `database is full` / `frees space` all 0 in
both. `size limit` 69 → 73 (+4), but a context-diff of all 73 v288 sites
surfaced only pre-existing families (settings text, `.mcp.json`, hook input,
peer file transfer, ripgrep, image upload, gateway host check, import) plus one
artifact-*import* string (`Artifact content from this point on was not imported
(size limit).`) that is not the write-refusal message. The new sentence is
likely composed from interpolated numbers (limit + "what frees space") rather
than stored as one literal, which is why no needle caught it.

**OCC state.** No artifact database:
`src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:3` is `{}`, and there is no
`bun:sqlite` / `new Database(` anywhere in `src`. → **NO-OP{NO-SURFACE}**. This
also caps #5: the official "report findings as a typed list so the host UI can
render them" landing zone is OCC's stubbed ReviewArtifactTool — `simplify.ts:112`
already only *asks* for a typed list.

---

## Ranked PORT-CANDIDATEs

By (value ÷ risk); all deltas byte-recovered above.

| Rank | # | Change | Size | Risk |
|---|---|---|---|---|
| 1 | **64** | `!e.defaultPrevented &&` guard, `PermissionRuleList.tsx:~695` | 1 token | none — v287-identical code, proven one-token delta |
| 2 | **67** | `'answered '` label, `QuestionNavigationBar.tsx:113-119` | ~3 lines + memo dep | none — `isAnswered` already computed |
| 3 | **68** | message swap, `usage-credits-core.ts:53-58` | 1 string | none |
| 4 | **77** | top-level `purge` + alias notice, `main.tsx:4870-4881` | ~15 lines | low — pure CLI registration |
| 5 | **59** | gate hint on `!isBySendNow` (`InterruptedByUser.tsx:8`, `REPL.tsx:4146-4152`, `sendNow.ts:59`) | ~10 lines | low — reason already exists |
| 6 | **7** | permission-mode SR announce on plan approval | ~3 lines | low — pattern already at `PromptInput.tsx:1712` |
| 7 | **3** | Ctrl+C draft hold/restore (`useTextInput.ts:123-135`,`:351-374`; `PromptInput.tsx:1020-1039`) | ~30 lines | medium — must not collide with the Ctrl+S stash or history-draft slots |
| 8 | **5** | `--max-findings <n>\|all` explicit half (`simplify.ts:13-31,112,143-173`) | ~40 lines | medium — reuse/`onUserTypedArgs` half must stay staged |
| 9 | **66** | SR hold-until-keypress subsystem (`screenReader.ts`, `screen-reader-render.ts`, `ink.tsx`) | ~120 lines | high — touches the frame pipeline; land last, and it upgrades #7 |

**Suggested batching.** SR batch = 64 + 67 (+ 66 if the frame work is
scheduled, then 7 with `{hold:true}`) · quick wins = 68 + 77 + 59 · input batch
= 3 + 5. #66 must not block the others — #7 and #67 are correct without it.

## STAGED backlog (scope recorded, not portable this round)

- **#6 + #78** — one agents-view build: add `Agents` to `KEYBINDING_CONTEXTS`
  (`schema.ts:12`) and `agents:find|nextGroup|previousGroup|rename|setGroup` to
  `KEYBINDING_ACTIONS` (`schema.ts:68`, closed `z.enum` at `:231`), defaults in
  `defaultBindings.ts:32`, move `FleetViewScreen.tsx:119-197` off raw `useInput`
  onto `useKeybinding`, add a group model, then land #78's `eu()` best-match
  Enter instead of `findIndex`. Blocked on the unrecovered `Ii` name-scorer.
- **#74** — proactive environment-secret renewal in `bridgeMain.ts:727-790`.
  Poll-loop integration recovered; the renewal engine (`gLn`, `mLn`, gates,
  pacing constants) was not. Needs a dedicated decompilation pass.
- **#63** — wire `useDeclaredCursor` into `REPL.tsx:383 TranscriptSearchBar` and
  `CustomThemeCreator.tsx`. An OCC-side improvement *inspired by* the entry, not
  a port of it.

## Unrecovered deltas — explicit list

| # | What is missing | Why |
|---|---|---|
| 2 | the specific jq-filter/file-name/GitHub-error sanitize sites beyond the 5 `replace(RW,"?")` sinks | `lx(` 7 → 23 not all attributable |
| 20 | the identity/generation guard on mod button press | no distinguishing needle moved; mod surface absent from OCC anyway |
| 29 | the actual fix (only the pre-existing error site is present) | 3rd `unrecoverable interface error` hit is changelog text; layout-fault machinery byte-stable |
| 47 | the Windows re-init change | no Windows-console needles in either binary; +1 `spawnSync`/`stdio:"inherit"` not attributable |
| 63 | the two named call sites | `declareCursor` +1 lands in history-search, not the transcript viewer or `/theme` |
| 71 | the new size-limit sentence | likely interpolated, not a stored literal |
| 74 | `gLn`, `mLn`, `Vhn`, `dzr`, `wyo`/`vyo`/`Eyo` | defined in another chunk |
| 78 | `Ii` (the name-match scorer) | imported from another chunk |

Everything else in this cluster is recovered to byte level with the offsets above.
