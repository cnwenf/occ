# OCC gap research — Claude Code 2.1.286 → 2.1.287, Cluster E: Screen-reader / Accessibility / Mouse / Platform

Research-only byte forensics. Official binaries NEVER executed. Repo NOT modified.
Binaries: `/tmp/cc-diff-287/v286/package/claude`, `/tmp/cc-diff-287/v287/package/claude`.
OCC repo: `workdir/occ` @ HEAD 6dcc320. Changelog: `/tmp/cc-CHANGELOG.md` (2.1.287 = lines 3–111).
Method: `LC_ALL=C rg -aob -F -- "needle" <binary>` for offsets, python3 offset slicing for verbatim
extraction, difflib skeleton comparison (identifiers normalized) for structural deltas. Minified
names are chunk-local and NOT comparable across versions — all novelty proven via message strings
and hit counts.

## Disposition summary

| # | Changelog entry | Verdict |
|---|-----------------|---------|
| 1 | SR: cursor away from typed text in search boxes + sign-in code fields | **PORT-CANDIDATE** |
| 2 | SR: Enter refused with nothing typed on /rewind summarize | NO-OP{ALREADY-ALIGNED} |
| 3 | SR: "Tab to amend" hint where Tab does nothing | NO-OP{NO-SURFACE} (official JS delta unrecoverable) |
| 4 | SR: arrow-key / "Select with numbers" hint lies | NO-OP{NO-SURFACE} (delta recovered for future g5 port) |
| 5 | SR: changed lines left out of file edit approval diffs | **PORT-CANDIDATE** |
| 6 | SR: --teleport progress + MCP form re-sent every spinner frame | STAGED (engine work, bundle with 7) |
| 7 | SR: top lines left out when previous screen taller than terminal | STAGED (engine work) |
| 8 | SR: prepark pause removed, CLAUDE_AX_PREPARK_MS=50 restores | NO-OP{ALREADY-ALIGNED} |
| 9 | Mouse: right/middle-click paste on button RELEASE, move-away cancels | NO-OP{NO-SURFACE} (official delta unrecoverable) |
| 10 | Windows: startup warning when denying Bash also disables PowerShell | **PORT-CANDIDATE** |
| 11 | Self-hosted runner built-in `gh api` | NO-OP{NO-SURFACE} |
| 12–24 | [VSCode] × 13 | NO-OP{NO-SURFACE} × 13 |
| 25 | [Cloud sessions] GitHub token retry | NO-OP{NO-SURFACE} |
| 26–28 | [Claude Tag] × 3 | NO-OP{NO-SURFACE} × 3 |
| 29–31 | [Code Review] × 3 | NO-OP{NO-SURFACE} × 3 |

Counts: 3 PORT-CANDIDATE, 2 STAGED, 3 NO-OP{ALREADY-ALIGNED or NO-SURFACE} in PART 1–2 core,
21 NO-SURFACE in the PLATFORM sweep.

---

# PART 1 — Screen-reader cluster (changelog lines 29–36, 86)

## Item 1 — "Fixed screen reader mode leaving the cursor away from the typed text in search boxes (such as /resume and /permissions) and sign-in code fields" — PORT-CANDIDATE

Official architecture: `Fe` CustomSelect dispatcher → SR-enabled (`Ze()`) ? `g5` (flat SR select
with hidden hint prompt carrying the cursor declaration) : `Xi` (rich visual select). The fix has
two independent parts; park math (`computeScreenReaderPark`) is IDENTICAL v286↔v287 (verified at
/tmp/sr286.js @4876 vs /tmp/sr287.js @5757) — the fix is NOT in park math.

### 1a. Sign-in code field (novelty: `showCursor:` count 42 (v286) → 45 (v287); all 3 new sites are this field)

v287 @222279552 (also @236775561, @237159858 — 3 instances):

```js
e(sr,{value:k,onChange:ne,onSubmit:(lt)=>_e(lt,a.url),cursorOffset:le,
      onChangeCursorOffset:de,columns:pe,mask:"*",focus:!0,showCursor:z})
// z = Ze()  (SR-enabled) inside component Dt
```

v286 equivalent (@225478015 region):

```js
e(nr,{value:O,onChange:oe,onSubmit:(ct)=>we(ct,o.url),cursorOffset:ce,
      onChangeCursorOffset:ue,columns:me,mask:"*"})
// NO focus, NO showCursor
```

Anchor: TUI string `Paste code here if prompted > ` @222262107 (v287).

**OCC affected**: `src/components/ConsoleOAuthFlow.tsx:528` replicates the v286 form exactly —
`<TextInput value={pastedCode} ... mask="*" />` with NO `focus`/`showCursor`. OCC's
`src/components/BaseTextInput.tsx:38` only declares a cursor when
`props.focus && props.showCursor && terminalFocus` (`:44 active: t1`, `:53 useDeclaredCursor(t2)`),
so under SR the sign-in field declares nothing → cursor lands away from typed text.

**Port (tiny)**: at ConsoleOAuthFlow.tsx:528 add `focus={true} showCursor={isScreenReaderEnabled()}`.

### 1b. SearchBox (official v286 `vy` @~214151000 → v287 `By` @~216280000; extracts /tmp/sb286.js, /tmp/sb287.js)

v286:
```js
let re=F??l.length,ue=v!==void 0,...,Q=b??(ue&&ye),Ie=G?0:2,Ce=G?0:1,
    ...Ee=Mv({line:Ce+ge.line,column:Ie+ge.column,active:Q&&!ue,visible:De})
// render: borderStyle:G?void 0:"round", ..., paddingX:G?0:1
```

v287 (verbatim delta):
```js
let re=F??l.length,ue=C!==void 0,...,J=v??(ue&&ve),
    Me=Ze(),ge=!H&&!Me,q=ge?2:0,ne=ge?1:0,
    ...at=cE({line:ne+we.line,column:q+we.column,active:J&&!ue,visible:je})
// render: borderStyle:ge?"round":void 0, ..., paddingX:ge?1:0
```

Mechanism: under SR (`Me=Ze()`), the border is suppressed (`ge=false` → borderless) and the
cursor-declaration offsets (`q`,`ne`) collapse to 0 so the declared cursor matches the actual
text position. In v286 the declaration added +2/+1 for a border that the SR transcript did not
contain → cursor reported away from typed text.

**OCC affected**: `src/components/SearchBox.tsx` (71 lines) is purely visual — `<Text inverse>`
cursor, `borderStyle: borderless ? undefined : 'round'`, NO `useDeclaredCursor`, NO SR awareness.
Consumers (matches official surfaces): `src/components/LogSelector.tsx:1267` (/resume),
`src/components/permissions/rules/PermissionRuleList.tsx` (/permissions), Settings/Config.tsx,
skills/SkillsMenu.tsx, commands/plugin/{ManagePlugins,DiscoverPlugins}.tsx,
design-system/FuzzyPicker.tsx. Worse: during search, LogSelector.tsx:1343/:1370 sets
`isDisabled={viewMode === "search" || ...}` on the select, and
`src/components/CustomSelect/select.tsx:376` computes `isFocused = !isDisabled && ...` → cursor
declaration `active: isFocused` (~:681) is false. So while typing in an OCC search box NOTHING
declares a cursor at all — the item-1 symptom replicates.

**Port**: add SR gating to SearchBox.tsx — when `isScreenReaderEnabled()`: render borderless and
call `useDeclaredCursor({line: textRow, column: cursorOffset, active: isFocused})` with offsets
matching the borderless text position (official shape above).

## Item 2 — "Fixed screen reader mode refusing Enter with nothing typed on /rewind's summarize options, whose added context is optional" — NO-OP{ALREADY-ALIGNED}

Novelty: `screenReaderEmptySubmit` = 0 (v286) → 3 (v287). Offsets v287: @93819384 (strtab),
@221304762 (g5 SR select submit handler), @227246590 (rewind option config).

v287 g5 submit handler @221304762 (verbatim):
```js
if(C){if(re===""&&!C.screenReaderEmptySubmit){W("Enter some text, or Escape for the list.");return}
      if(i?.(C.value)===!1){return}x(Ku),xe(Hu);return}
```

v287 rewind config @227246590 (verbatim):
```js
Zo={type:"input",placeholder:"add context (optional)",initialValue:"",
    allowEmptySubmitToCancel:!0,screenReaderEmptySubmit:!0,
    showLabelWithValue:!0,labelValueSeparator:": "}
```

**OCC NOT affected**: OCC has no g5/SR-select split — one select path for all modes.
`src/components/MessageSelector.tsx:107–114` `summarizeInputProps` already carries
`placeholder: 'add context (optional)'`, `allowEmptySubmitToCancel: true`,
`showLabelWithValue: true`, `labelValueSeparator: ': '` — field-for-field identical to official
`Zo` minus `screenReaderEmptySubmit`, and `src/components/CustomSelect/select.tsx:389/:438/:557`
accepts empty submit via `option.allowEmptySubmitToCancel` in ALL modes. Behavior already matches
v287. Note for future: if OCC ever ports the official g5 SR select, carry
`screenReaderEmptySubmit` in the option schema.

## Item 3 — "Fixed screen reader mode showing a 'Tab to amend' hint on approval prompts, where Tab does nothing" — NO-OP{NO-SURFACE}

Official JS delta UNRECOVERABLE: the Tab-to-amend hint render path lives in bytecode-only regions;
string probes for the hint text found strtab entries but the surrounding logic is not in readable
JS chunks (honest gap — not invented).

**OCC NOT affected**: `rg -n "Tab to amend" src/` → 0 hits; OCC has no SR hint-prompt subsystem
(no g5). In OCC, Tab-to-amend works in the visual approval prompt for all users (SR or not), so
there is no lying hint to suppress.

## Item 4 — "Fixed screen reader mode listing arrow keys that do nothing in /permissions and /mcp, and saying 'Select with numbers' in empty menus or while a search box has the keys" — NO-OP{NO-SURFACE}

Novelty: `hidePromptWhileDisabled` = 0 (v286) → 12 (v287). Official g5 deltas recovered
(/tmp/an286.js, /tmp/an287.js):

Hidden hint prompt (carries the SR cursor declaration):
```js
// v286: ct=!y&&e(s,{ref:Ye,children:e(n,{children:_e})})
// v287: xt=!O&&!(I&&q)&&e(s,{ref:Je,children:e(n,{children:Ke})})
//   I = isDisabled, q = hidePromptWhileDisabled (q=k===void 0?!1:k)
```
→ while the select is disabled (search box has the keys), the hidden prompt (and its stale
"Select with numbers…" announcement + cursor declaration) is suppressed entirely.

Empty-menu branch, v287 only (verbatim, /tmp/an287.js):
```js
ct=C?`Enter text for option ${oe} (${TR(C.label)}), or Escape for the list: ${b}`
   :t.length===0?`Nothing to select${l?". Escape to cancel":""}: ${b}`
   :`Select with numbers [1-${t.length}]${A?" or up / down arrow keys":""}. Then ${yo(["Enter to submit",...l?["Escape to cancel"]:[]])}: ${b}`
```
(v286 had no `t.length===0` branch — it announced "Select with numbers [1-0]" on empty menus.)
The arrow-key suffix stays predicate-gated (`A`/`_` chunk-local); the /permissions and /mcp
arrow-key lie is fixed by the same `hidePromptWhileDisabled` + disabled-state plumbing (predicate
values not fully disambiguatable through minification — noted honestly).

**OCC NOT affected**: `rg -n "Select with numbers|Nothing to select|arrow keys" src/components/CustomSelect/` → 0 hits;
`rg -n "isScreenReaderEnabled|screenReader" src/components/CustomSelect/select.tsx` → 0 hits.
OCC has no SR hint prompts at all; the whole g5 subsystem is absent (larger gap, out of 287 scope).
Recovered verbatim above is staged material for a future g5 port.

## Item 5 — "Fixed screen reader mode leaving out the changed lines in file edit approval prompts and other diffs" — PORT-CANDIDATE

Forensic chain (all v286↔v287 verified):
- Approval dialog data prep ("make this edit" regions, /tmp/fpd286.js//tmp/fpd287.js): identical
  modulo 130-char edge noise.
- `case"file-edit-diff":return e(Ihe,{...})` (v286) ↔ `e(khe,{...})` (v287): identical
  (/tmp/fed286.js//tmp/fed287.js).
- FileEditToolDiff component `function Ihe` v286@225656305 / `function khe` v287@228043585,
  9000 bytes each: ZERO skeleton diff blocks (/tmp/fe286.js//tmp/fe287.js). Both render
  `e(CW|Cz,{hunks:H,dim:!1,width:_e,filePath,firstLine,fileContent})`.
- Official SR serializer (v286 `Vr` / v287 `Wr`, /tmp/srs286.js @210314000–210370000 /
  /tmp/srs287.js @212417000–212473000): structurally identical (3 edge-noise blocks); handles
  `#text`, `ink-text`, `ink-virtual-text`, `ink-link`, `ink-box`, `ink-root` +
  `accessibility.label/hidden/state/role`; does NOT handle `ink-raw-ansi` in EITHER version.
- Official StructuredDiff chunk fully extracted both versions (/tmp/sdc286.js = v286
  219769301–219799400, /tmp/sdc287.js = v287 222024487–222054900; 30099 vs 30413 bytes):
  ONLY behavioral delta = `"aria-hidden":!0` added to the two trailing background-padding Text
  spans (v287 binary @222027241 and @222028386; `aria-hidden` count in region: v286=0, v287=2):

```js
// v287 (both diff-line renderers, verbatim tail):
B?e(n,{dimColor:!0,children:B}):null,
e(n,{"aria-hidden":!0,color:a?"text":void 0,backgroundColor:O,dimColor:o,children:" ".repeat(re)})
```
- Native highlight component `ot` (`codeWithSpaces`, local @18787 in both): ZERO diff blocks.
  Official diff lines are real Text nodes (text+markers), i.e. SR-visible in both versions.
- New v287 `rawText:` site @222578638 is the /settings-review staged-changes UI (`dn` wording
  object, `yt()` marker rows) — NOT this item.

Honest note: the exact restorative mechanism for the changelog wording ("leaving out the changed
lines") is only partially recoverable — the sole JS delta in the whole diff-render chain is the
`aria-hidden` padding tag; any remainder (e.g. serializer-side behavior) is bytecode or shared
with the item-7 engine delta. State of evidence recorded as-is.

**OCC AFFECTED (worse than official)**: OCC's diff pipeline is StructuredDiff →
color-diff-napi `ColorDiff.render()` → `<RawAnsi>` (custom `ink-raw-ansi` leaf):
- `src/components/StructuredDiff.tsx:151/:161/:181` — all diff content rendered via `<RawAnsi lines=...>`.
- `src/ink/screen-reader-render.ts:209/:222–224/:229` — nodeName handling covers
  `#text`/`ink-text`/`ink-virtual-text`/`ink-link`/`ink-box`/`ink-root` only; ZERO
  `ink-raw-ansi` handling (`rg -n "ink-raw-ansi" src/ink/screen-reader-render.ts` → 0; the string
  exists only in render-node-to-output.ts, dom.ts, components/RawAnsi.tsx).
→ When the color-diff path is active (env gate `CLAUDE_CODE_SYNTAX_HIGHLIGHT`,
`src/components/StructuredDiff/colorDiff.ts`), OCC's SR output omits the ENTIRE color diff —
every changed line. The v286 official symptom replicates by construction.

**Port options** (smallest first):
1. SR-gate the color path: in `renderColorDiff` (StructuredDiff.tsx), when
   `isScreenReaderEnabled()` fall through to `<StructuredDiffFallback>` (plain Text lines) —
   mirrors official Text-based rendering.
2. Or teach `src/ink/screen-reader-render.ts` an `ink-raw-ansi` case: strip ANSI escapes from
   `rawText` and emit as text (helps every RawAnsi consumer, not just diffs).

## Item 6 — "Fixed screen reader mode sending the `claude --teleport` progress screen, and an MCP form field while it is being checked, to the screen reader again on every spinner frame" — STAGED

Official delta lives in the SR engine (`onRenderScreenReader`, /tmp/sr287.js): v287 adds the
`lastRowAnchored` prefix-append logic — when the previous SR screen matches the new one except
for a suffix on the anchored last row, only the changed suffix is emitted instead of re-sending
the whole screen (verbatim block in item 7 below; the `R[B].startsWith(L[B])&&!R[B].includes("\t")`
+ per-row equality loop + `le=pe?L[B].slice(R[B].length):""` delta-append IS the per-spinner-frame
re-announce fix). `teleportWithProgress` exists in both versions (v286 @219625636 / v287
@221866031 strtab+JS; string set identical — teleport component itself unchanged apart from
import noise).

**OCC**: `rg -c "teleportWithProgress" src/` → 0 (OCC has src/utils/teleport/{api,environments,
gitBundle}.ts plumbing but no progress screen); MCP elicitation surface exists
(`src/Tool.ts`, `src/cli/print.ts`) but OCC's SR renderer
(`src/ink/screen-reader-render.ts`) has no transcript/anchor/dedupe machinery at all — it is the
2.1.206-era full re-serialize design. Verdict STAGED: bundle with the item-7 engine upgrade;
porting piecemeal is not possible.

## Item 7 — "Fixed screen reader mode leaving out the top lines of a second approval prompt, a changed /config row or the rejected-plan line when the previous screen was taller than the terminal window" — STAGED

Official delta recovered verbatim (from /tmp/sr286.js vs /tmp/sr287.js skeleton diff, 2 insert
blocks, +1000 bytes total):

v287 serializer helpers (NEW, /tmp/srs287.js):
```js
function Hpr(n){let u=n;while(u.parentNode!==void 0)u=u.parentNode;
  if(u.nodeName==="ink-root")u.transcriptFrontCutRows=n}
function Mv(n){let u=n.transcriptFrontCutRows??null;
  return n.transcriptFrontCutRows=void 0,u}
```
v287 engine hook: `let k=Mv(this.rootNode);if(k!==null)this.applyTranscriptFrontCut(k,n,T,R);`

v287 engine anchor logic (insert block @2443→2584):
```js
if(!X&&H===-1&&!this.srPreParked&&(this.prevScreenReaderAnchor==="clean"||
   this.prevScreenReaderAnchor==="lastRowAnchored"&&B===L.length-1&&I.row===B&&G.row===B)
   &&L.length===R.length&&B>=L.length-this.terminalRows
   &&L[B].startsWith(R[B])&&!L[B].includes("\t")){
  let pe=!0;for(let ye=B+1;ye<L.length;ye++)if(L[ye]!==R[ye]){pe=!1;break}
  let le=pe?L[B].slice(R[B].length):"",ce=le===""?0:ie(R[B]);
  if(le!==""&&ie(String.fr... /* suffix append path */
```

**OCC NOT portable yet**: OCC's `screen-reader-render.ts` lacks `prevScreenReaderAnchor`,
`terminalRows`, park, and the transcript front-cut concept entirely (2.1.206-era design).
Verdict STAGED — requires the full official SR engine generation bump, tracked as its own epic.

## Item 8 — "Changed screen reader mode to write new or changed lines without first pausing with the cursor at the start of the line; set `CLAUDE_AX_PREPARK_MS=50` to restore the pause" — NO-OP{ALREADY-ALIGNED}

HONESTY CORRECTION: the task brief claimed `CLAUDE_AX_PREPARK_MS` is NEW in v287 — DISPROVED.
Hit count: `CLAUDE_AX_PREPARK_MS` = 4 in BOTH binaries (v286 & v287), including the env schema
export (`CLAUDE_AX_PREPARK_MS:()=>Q_` v287 / `()=>J_` v286) and the parser function. The real
delta is the DEFAULT 50→0 (verbatim):

```js
// v286: }return 0}var v=50,M=5000;function NWo(){return Math.min(a.CLAUDE_AX_PREPARK_MS??v,M)}
// v287: }return 0}var v=0, M=5000;function u3o(){return Math.min(a.CLAUDE_AX_PREPARK_MS??v,M)}
```

**OCC NOT affected**: `rg -n "CLAUDE_AX_PREPARK_MS|prepark|prePark" src/` → 0 hits. OCC's SR
renderer has no prepark pause at all — behaviorally identical to v287's new default (0). No env
var to add unless the engine generation bump (items 6/7 STAGED) lands.

---

# PART 2 — Mouse & Windows shell

## Item 9 — "Changed right-click paste on Windows and Linux, and middle-click paste on Linux, to happen when the button is released; moving the pointer away before releasing cancels it" — NO-OP{NO-SURFACE}

Official delta UNRECOVERABLE by cheap anchors (honest): every mouse/clipboard identifier count is
identical v286↔v287 — `"release"` 13=13, `isRelease` 6=6, `200~` 6=6, `pbpaste` 7=7,
`Get-Clipboard` 4=4, `xclip` 22=22, `wl-paste` 10=10; the SGR mouse parse region
(v286 @210256985 ↔ v287 @212359786 ±6KB) has ZERO structural diff; the clipboard module
(v286 @209923495 ↔ v287 @212027455 region, 18KB windows) is identical modulo import/name noise.
The press→release move is a pure logic reorder inside minified/bytecode dispatcher code with no
string-count signature.

**OCC NOT affected**: OCC does not implement mouse-button clipboard paste at all —
`rg -n "\.button\b" src/ --type ts -g '!*test*'` outside parse-keypress → 0 consumers; SGR button
codes are parsed (`src/ink/parse-keypress.ts:64 SGR_MOUSE_RE`, `:634–638 button/action
press|release`, `:656–665`) but nothing binds button 2 (right) or button 1 (middle) to a paste.
Mouse tracking is fullscreen-only (`src/ink/parse-keypress.ts:327` comment "Orphaned SGR/X10 mouse
tail (fullscreen only — mouse tracking is off…)"; `src/ink/termio/dec.ts:17–20` DEC 1000/1002/
1003/1006 definitions), so in the normal REPL the terminal's native right-click paste still works
and there is no press-vs-release semantics to change. Left-click already fires on release
(`src/ink/events/click-event.ts:4` "Fired on left-button release without drag").
Latent separate gap (not a 287 item): if OCC ever enables tracking in the REPL, right/middle-click
paste would need building from scratch.

## Item 10 — "Windows: Added a startup warning when denying the Bash tool also turns off the PowerShell tool, so Claude has no shell tool" — PORT-CANDIDATE

Novelty: `also turns off` 1 (v286, docs text only) → 3 (v287). New sites: strtab @97252105
(fragment `Denying \0 also turns off the %\0 tool, so Claude has neither. To use \0), set
CLAUDE_CODE_USE_POWERSHELL_TOOL=1.`) and JS @213518738.

v286 (baseline, @211391795 region, verbatim):
```js
Fe=q.some((r)=>r.toolName===Be&&r.ruleContent===void 0),
pe=q.some((r)=>r.toolName===Be)||L.some((r)=>r.ruleBehavior==="deny"&&r.ruleValue.toolName===Be),
fe=a.CLAUDE_CODE_USE_POWERSHELL_TOOL||sp(o??[]).map(Ul).includes(vt)
   ||A.some((r)=>jn(r).toolName===vt)||q.some((r)=>r.toolName===vt)
   ||L.some((r)=>r.ruleValue.toolName===vt);
if(M()==="windows"&&Ra()&&pe&&!fe)v=[...v,vt];
```

v287 (@213518738, verbatim — THE delta):
```js
fe=q.some(ne),   // ne = bash-family predicate (replaces the Be-toolName-only check)
Pe=q.some((r)=>r.toolName===Ue)||B.some((r)=>r.ruleBehavior==="deny"&&r.ruleValue.toolName===Ue),
ye=a.CLAUDE_CODE_USE_POWERSHELL_TOOL||Op(s??[]).map(Ql).includes(St)
   ||S.some((r)=>jn(r).toolName===St)||q.some((r)=>r.toolName===St)
   ||B.some((r)=>r.ruleValue.toolName===St);
if(O()==="windows"&&Fa()&&Pe&&!ye){
  v=[...v,St];
  let r=B.filter((p)=>p.ruleBehavior==="deny"&&ne(p.ruleValue));
  if(vb()&&(fe||r.length>0)&&!r.some((p)=>p.source==="policySettings"))
    h.push(`Denying ${Ue} also turns off the ${St} tool, so Claude has neither. To use ${St}, set CLAUDE_CODE_USE_POWERSHELL_TOOL=1.`)
}
```
(`Ue`=Bash, `St`=PowerShell, `O()`=platform, `Fa()`=Git-Bash-missing, `vb()`=interactive startup,
`h`=startup warnings array, `v`=toolsToDisallow. Related pre-existing fatal: "Claude Code on
Windows requires a shell tool. Git Bash was not found and the PowerShell tool is disabled
(CLAUDE_CODE_USE_POWERSHELL_TOOL=0)." @214573694 — present in BOTH versions, `requires a shell
tool` 2=2.)

**OCC AFFECTED (missing feature)**: OCC has the PowerShellTool + env gate
(`src/utils/shell/shellToolUtils.ts:17–22 isPowerShellToolEnabled()` — Windows-only, USER_TYPE
ant default-on / external opt-in; consumed at `src/tools.ts:142,:152` visibility,
`src/utils/processUserInput/processBashCommand.tsx:27`, `src/utils/promptShellExecution.ts:155`)
but NO Bash-deny→PowerShell strip and NO warning: `rg -n "has neither|also turns off" src/` → 0;
`rg -n "POWERSHELL_TOOL_NAME" src/ -g '!*test*'` shows permission-rule plumbing only
(`src/utils/permissions/permissionSetup.ts:164,:468–542`, `src/utils/permissions/permissions.ts:703`
interactive-approval deny). Git-Bash-missing detection exists (`src/utils/shell/bashProvider.ts`).

**Port**: in OCC's startup tool-visibility computation (tools.ts path), on Windows with Git Bash
missing: if Bash is disallowed (CLI --disallowedTools or a deny rule not sourced from managed
policy) and `!isPowerShellToolEnabled()` and no rule/allowlist names PowerShell → exclude
PowerShellTool and push the verbatim warning string into startup warnings.

---

# PART 3 — PLATFORM sweep (items 11–31), one rg each, all NO-OP{NO-SURFACE}

| # | Entry (abridged) | OCC evidence | Disposition |
|---|------------------|--------------|-------------|
| 11 | Self-hosted runner: built-in `gh api` (REST only) for Anthropic-managed git where GitHub CLI absent | `src/self-hosted-runner/main.ts` is a 3-line stub (`wc -l` = 3); `rg -n "gh api\|ghApi\|GH_TOKEN" src/self-hosted-runner/` → 0 | NO-SURFACE — no runner runtime to host the shim |
| 12 | [VSCode] "Run in background" on running command/sub-agent | no extension in repo (`ls -d vscode* extensions` → absent); `rg -lic vscode src/` hits only terminal-detection (src/ink/terminal.ts, src/cli/print.ts) | NO-SURFACE |
| 13 | [VSCode] background shell/Monitor output on agent-map cards | same — extension-side UI | NO-SURFACE |
| 14 | [VSCode] settings dialog false timeout blame on large save reply | extension-side | NO-SURFACE |
| 15 | [VSCode] reopening cloud session already on this machine opens side bar | extension-side | NO-SURFACE |
| 16 | [VSCode] side bar Web tab not listing new cloud sessions; "Remote server is not connected" | extension-side; `rg "Remote server is not connected" src/` → 0 | NO-SURFACE |
| 17 | [VSCode] restored tab starting second Claude process | extension-side | NO-SURFACE |
| 18 | [VSCode] tool-row file links / session-list links / two hints in plain text | extension-side | NO-SURFACE |
| 19 | [VSCode] background agent's still-running command shown failed after main turn | extension-side | NO-SURFACE |
| 20 | [VSCode] own /usage or /context opening extension dialog from command menu | extension-side | NO-SURFACE |
| 21 | [VSCode] plan preview tab file links doing nothing | extension-side | NO-SURFACE |
| 22 | [VSCode] tool input/output editor tab "Timeout waiting after 1000ms" on WSL | extension-side; `rg "Timeout waiting after" src/` → 0 | NO-SURFACE |
| 23 | [VSCode] Manage plugins dialog error detail on marketplace add/remove/refresh | extension-side (OCC has CLI ManagePlugins only) | NO-SURFACE |
| 24 | [VSCode] Claude in Chrome "Enabled by default" switch also connects editor sessions | extension-side | NO-SURFACE |
| 25 | [Cloud sessions] GitHub briefly refusing newly issued access token → retry | `rg -in "newly issued\|token retry\|access token.*retry" src/ -g '!*test*'` → 0; cloud-session git runs server-side (OCC gitBundle retry logic is bundle-size only, src/utils/teleport/gitBundle.ts:97/:117) | NO-SURFACE |
| 26 | [Claude Tag] failure warning posted in Slack thread on background wake with nobody waiting | `rg -in "nobody was waiting\|failure warning" src/` → 0; OCC has only RC client surface (SlackChannelHeader REPL.tsx:4852, /status poll REPL.tsx:645, install-slack-app command) — posting logic is Claude Tag service-side | NO-SURFACE |
| 27 | [Claude Tag] spend limits page missing recent/private channels | `rg -in "spend limit" src/ -g '!*test*'` → 0; admin-settings web page, server-side | NO-SURFACE |
| 28 | [Claude Tag] task list reposting as new message in long Slack threads | server-side (same evidence as 26) | NO-SURFACE |
| 29 | [Code Review] finding comments + "Why this was flagged" stopping mid-sentence | `rg -in "Why this was flagged\|finding comment" src/` → 0 | NO-SURFACE |
| 30 | [Code Review] PR skipped after new push when review failed twice on previous commit | `rg -in "failed twice\|review card" src/` → 0 | NO-SURFACE |
| 31 | [Code Review] failed-review card wording on locked conversation | same → 0 | NO-SURFACE |

---

# Honesty ledger (unrecoverable / corrected claims)

1. **Item 3**: official "Tab to amend" JS delta unrecoverable — logic sits in bytecode regions;
   only strtab hint strings are readable. NO-OP for OCC regardless (no hint surface, Tab works).
2. **Item 8 brief claim corrected**: `CLAUDE_AX_PREPARK_MS` is NOT new in v287 (4 hits in both
   binaries, incl. env schema). Real delta = default `var v=50` → `var v=0`.
3. **Item 5**: sole recoverable delta in the entire official diff-render chain = `aria-hidden:!0`
   on 2 padding spans; the full mechanism behind the changelog wording is not visible in JS
   (bytecode remainder possible). OCC-side bug is independently proven (RawAnsi invisible to OCC
   serializer) so the PORT-CANDIDATE verdict does not depend on the unrecovered remainder.
4. **Item 9**: official press→release delta has no string-count signature (all identifiers
   1:1 across versions; parse + clipboard regions structurally identical) — unrecoverable by
   byte forensics without executing (forbidden). Verdict rests on the OCC no-surface proof.
5. Minified-name comparisons were never used as novelty evidence anywhere in this report;
   all novelty claims cite message strings + `rg -aoc` counts.

# Port priority recommendation

1. **Item 1a** (one-line ConsoleOAuthFlow fix) + **Item 10** (self-contained startup warning).
2. **Item 5** option 1 (SR-gate colorDiff → StructuredDiffFallback) — small, removes a total
   SR blackout on every edit approval.
3. **Item 1b** (SearchBox SR borderless + useDeclaredCursor) — medium.
4. Items 6/7 STAGED behind the SR engine generation bump; items 2/3/4/8/9/11–31 need nothing.
