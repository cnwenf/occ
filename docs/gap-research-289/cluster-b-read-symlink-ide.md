# Gap Research — Official Claude Code 2.1.289, Cluster B (SECURITY)

**Changelog item #3 (2.1.289):**
> Fixed `Read` deny rules not applying to files @-mentioned, changed, or selected in the IDE through a symlink

**Verdict: PORT** — OCC has the identical auto-read IDE-context path and the identical
vulnerability (surface-path-only deny matching). The Read *tool* is already symlink-safe, but
the *attachment* pipeline that auto-reads IDE-context files bypasses the tool's permission
check and gates only on the surface path. Fix is a clean single-site hardening of
`isFileReadDenied` in `src/utils/attachments.ts`, reusing OCC's existing
`getPathsForPermissionCheck` spelling resolver.

Forensics: `strings`/`grep -bo`/`dd` only. Binaries never executed.
- v288 ELF: `/tmp/cc-diff-289/v288/package/claude`
- v289 ELF: `/tmp/cc-diff-289/v289/package/claude`

---

## 1. Official 2.1.289 logic (byte-level evidence)

### 1a. The attachment pipeline (three IDE-context surfaces)

The official `getAttachments` builder registers exactly the surfaces the changelog names.
v289 offsets **@210931695** (`at_mentioned_files`) and **@210935969** (`ide_selection` /
`ide_opened_file`):

```js
// @210931695  — @-mentioned files
Rl("at_mentioned_files",()=>Ce)   // Ce = ... mmr(e,be,n.abortController) ...
// @210935969  — IDE selection + IDE opened/changed file
Rl("ide_selection",async()=>Htn(r,n))
Rl("ide_opened_file",async()=>Gtn(r,n,g))
Rl("queued_ide_selections",async()=>(await Promise.all(s.filter(Rpt)
    .flatMap(({ideSelection:bt})=>bt?[Htn(bt,n),Gtn(bt,n,g)]:[]))).flat())
```

Changelog wording maps 1:1 onto these builders:
- **@-mentioned** → `gmr`/`mmr` (at_mentioned_files)
- **selected in the IDE** → `Htn` (ide_selection → `selected_lines_in_ide`)
- **changed** / opened in the IDE → `Gtn` (ide_opened_file → `opened_file_in_ide`)

### 1b. `ide_selection` (`Htn`) — v289 @210956577

```js
function Htn(e,n){
  if(e?.source==="diff"&&e.text)return[{type:"selected_lines_in_diff",...}];
  let r=p2n(n.options.mcpClients);
  if(!r||e?.lineStart===void 0||!e.text||!e.filePath)return[];
  if(w2(e.filePath,de(n))                                    // surface deny check
     || aje(de(n)) && await wge(e.filePath,de(n))===void 0)  // NEW: symlink-landing deny
    return[];
  return[{type:"selected_lines_in_ide",ideName:r,...,content:e.text,...}]
}
```

The IDE supplies `e.text` (the selected content) directly — it is **never re-read through the
Read tool**, so `w2 || (aje && wge)===undefined` is the *only* deny gate. v288 had just `w2`
(surface). v289 adds the `aje && wge` landing gate.

### 1c. `ide_opened_file` / changed (`Gtn`) — v289 @210959766

```js
async function Gtn(e,n,r){
  if(!e?.filePath||e.text)return[];
  let s=de(n);
  if(w2(e.filePath,s)                                        // surface deny check
     || aje(s) && await wge(e.filePath,s,n.abortController.signal)===void 0)  // NEW
    return[];
  return[...await dnn(e.filePath,n,{toolPermissionContext:s},r&&await lnn(n,r)),
          {type:"opened_file_in_ide",filename:e.filePath}]
}
```

Same new `aje && wge` landing gate.

### 1d. `at_mentioned_files` (`gmr`) — v289 @210960213

```js
async function gmr(e,n,r){let s=de(n);return Promise.all(e.map(async(g)=>{try{
  let{filename:h,lineStart:S,lineEnd:w}=Mmr(g);
  if(VQ(h,s.trustedNetworkDirectories))return m("input_file_at_mention","denied"),null;
  let B=st(h);
  if(w2(B,s)){ ... m("input_file_at_mention","denied"); return null }   // surface deny
  let H=aje(s),                                                         // NEW gate
      K=H?await Sge(B,n.abortController.signal):[B];                    // NEW: resolve spellings
  if(H&&K!==void 0&&bge(K,s))                                           // NEW: deny AT LANDING
    return m("input_file_at_mention","denied_at_landing"),null;
  let V=K,he=V===void 0&&n.abortController.signal.aborted;
  if(V===void 0&&!he)                                                   // NEW: fail-closed
    return m("input_file_at_mention","landing_unsettled"),
           {type:"at_mention_reference",mentions:[h],unread:"unexamined"};
  ...
  // directory branch: hpr(V,s) → "input_dir_at_mention","denied"; route-moved guard
  // file read via h$t(B,...,{landing:V,sizeProbe:ye,onRefusedAtOpen:()=>{be=!0}})
  //   → on refuse: "refused_at_open"; through-open size probe
```

The reader `h$t` (v289 @210978684) also gained the landing gate:
```js
let B=aje(de(n)), H=!B?[e]:h?.landing??await wge(e,de(n),n.abortController.signal);
if(H===void 0)return null;
if(B&&h?.landing!==void 0&&bge(h.landing,de(n)))return null;
```

### 1e. The new landing primitives (all NEW in v289)

| v289 symbol | Offset | Body | Role |
|---|---|---|---|
| `aje(ctx)` | @204108371 | `return Ul(ctx)\|\|Kn(ctx,"read","deny").size>0` | gate: any bare-Read deny OR ≥1 read-deny rule exists → do landing resolution |
| `Sge(path,sig)` | @210918122 | builds spelling set: `let s=new Set([r]); for(...) {let h=await Kxn(g,n); ...h.spellings.forEach(H=>s.add(H)); s.add(h.unresolved?g:h.landing); ...}` | resolve original + every symlink target + canonical landing |
| `bge(spellings,ctx)` | @210919225 | `e.some(r=>zJe(r,n,"read")!==null)\|\|USe(e.at(0)??"",n,e)` | deny if ANY spelling matches a read-deny rule |
| `hpr(spellings,ctx)` | @210919225 | `e.some(r=>Ca(r,n,"read","deny",{isDirectory:!0})!==null)` | directory-landing deny |
| `wge(path,ctx,sig)` | @210920221 | `if(!aje(n))return[e]; let g=await Sge(e,r??AbortSignal.timeout(Qqe)); return g===void 0\|\|bge(g,n)?void 0:g` | resolve+deny; `undefined` ⇒ drop attachment (fail-closed) |

`w2`/`p2` is the **surface-only** deny check (unchanged across versions):
`USe(e,n,[e])` (v289) / `Aa(e,n,"read","deny")!==null` (v288) — matches only the requested
spelling, never the symlink target.

### 1f. Markers that appear ONLY in v289 (0 hits in v288)

```
denied_at_landing   v288=0  v289=2
landing_unsettled   v288=0  v289=2
route_moved         v288=0  v289=2
refused_at_open     v288=0  v289=2
through-open        v288=0  v289=2
sizeProbe           v288=0  v289=3
at_mention_reference v288=6 v289=7   (new "unread:unexamined" fail-closed variant)
```

The `aje`/`wge`/`Sge`/`bge`/`hpr` minified names DO occur in v288 but resolve to **unrelated
functions** (verified by dumping each: v288 `aje`@203238140 = a session-key classifier,
v288 `wge`@210699605 = plugin-enablement, v288 `bge`@210702354 = marketplace path check).
The landing subsystem is genuinely new in v289.

---

## 2. Official 2.1.288 (pre-fix) logic — the vulnerability

The three builders gate on the surface path ONLY:

- `ide_selection` (`qen`) — v288 **@210644791**:
  `if(p2(e.filePath,de(n)))return[];` — no landing check; then attaches `content:e.text`.
- `ide_opened_file` (`Yen`) — v288 **@210647930**:
  `if(p2(e.filePath,s))return[];` — no landing check.
- `at_mentioned_files` (`Sfr`, reached via `kfr`@210648310) — v288 **@210648310**:
  `if(p2(B,s)){...return null}` then readdir/read directly — no landing check.
- `p2` — v288 **@210674630**: `...if(Aa(e,n,"read","deny")!==null)return!0;...` — surface only.

**Exploit:** deny rule `Read(./secret/**)` + symlink `./link -> ./secret/x`. Surface path
`./link` does not match `./secret/**` → `p2` returns false → the IDE-supplied selection text
(or the @-mentioned/changed file content) is attached to the model context. The deny rule is
silently bypassed. v289 closes this by resolving the symlink landing (`Sge`) and re-running the
deny match against every spelling (`bge`), dropping the attachment (`wge → undefined`) when the
landing is denied.

---

## 3. OCC analysis

OCC reproduces the official attachment pipeline 1:1 in `src/utils/attachments.ts`
(`getAttachments`, line 821). All three changelog surfaces exist and all content-bearing gates
funnel through one helper.

### 3a. The single gate — `isFileReadDenied` (surface-only)

`src/utils/attachments.ts:4314`
```ts
function isFileReadDenied(filePath, toolPermissionContext): boolean {
  const denyRule = matchingRuleForInput(filePath, toolPermissionContext, 'read', 'deny')
  return denyRule !== null
}
```
`matchingRuleForInput` (`src/utils/permissions/filesystem.ts:1388`) matches `expandPath(path)`
— **surface normalization only (~ expansion, trim, Windows POSIX-ify), NO realpath / symlink
resolution.** This is the exact analogue of official `w2`/`p2`.

### 3b. Call sites — all six are IDE-context auto-read gates

| Line | Function | Changelog surface |
|---|---|---|
| `attachments.ts:1714` | `getSelectedLinesFromIDE` → `selected_lines_in_ide` | **selected** (attaches `ideSelection.text`; never re-read) |
| `attachments.ts:1964` | `getOpenedFileFromIDE` → `opened_file_in_ide` | **opened/changed in IDE** |
| `attachments.ts:2013` | `processAtMentionedFiles` | **@-mentioned** |
| `attachments.ts:2197` | `getChangedFiles` (re-reads changed files from `readFileState`) | **changed** |
| `attachments.ts:3155` | `generateFileAttachment` (the @-mention read) | **@-mentioned** |
| `attachments.ts:3259` | `readTruncatedFile` (inner, large-file path) | **@-mentioned** |

`useIdeAtMentioned.ts` only receives the `{filePath,lineStart,lineEnd}` notification payload and
emits it (analogue of official `HTt`/`DTt`) — it does not read or gate; not a fix site.

### 3c. The Read TOOL is already symlink-safe (but the attachment path bypasses it)

`checkReadPermissionForTool` (`filesystem.ts:1837`) DOES resolve spellings and deny-check each:
```ts
const pathsToCheck = getPathsForPermissionCheck(path)          // :1855  (all spellings)
for (const pathToCheck of pathsToCheck) {                       // :1891
  const denyRule = matchingRuleForInput(pathToCheck, ctx, 'read', 'deny')
  if (denyRule) return { behavior:'deny', ... }                 // :1898
}
```
`getPathsForPermissionCheck` (`src/utils/fsOperations.ts:291`) is OCC's `Sge`/`ao` analogue —
it walks the symlink chain and returns original + every intermediate target + canonical path.

**But the attachment pipeline never calls `checkReadPermissionForTool`.** `generateFileAttachment`
calls `FileReadTool.validateInput` (surface deny only, `FileReadTool.ts:567`) then
`FileReadTool.call` **directly** (`attachments.ts:3270`/`3295`), skipping `checkPermissions`.
`FileReadTool.call`'s only symlink guard is `assertSymlinkResolutionsUnchangedForRead` (the
2.1.251 TOCTOU stash gate) — and with no `checkPermissions` stash (`toolUseId` undefined on the
attachment path) `takeApprovedPathsForRead` falls back to a fresh resolution and **trivially
passes**. `getSelectedLinesFromIDE`/`getOpenedFileFromIDE`/`getChangedFiles` don't touch the
Read tool at all (IDE supplies the text / re-reads via `getFileModificationTimeAsync`).

⇒ **OCC is structurally VULNERABLE, identical to official v288.** Not immune.

---

## 4. PORT — exact fix

**Change site (single function):** `src/utils/attachments.ts:4314` `isFileReadDenied`.

Harden it to check the read-deny rule against **every symlink spelling**, mirroring official
`bge(spellings,ctx) = spellings.some(sp => deny(sp))`. This is byte-semantically what
`checkReadPermissionForTool` already does (`filesystem.ts:1891-1908`) — reuse the same
`getPathsForPermissionCheck` primitive. Fixing the one helper closes all six gates at once and
cannot regress the Read tool (which has its own separate resolution-aware check).

### Sketch

```ts
import { getPathsForPermissionCheck } from './fsOperations.js'   // already the Sge/ao analogue

function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  // CC 2.1.289 (SECURITY, changelog #3): Read deny rules must apply to
  // @-mentioned / changed / IDE-selected files reached THROUGH A SYMLINK.
  // Official gate: aje(ctx) && bge(Sge(path,ctx)) — resolve every spelling
  // (original + each symlink target + canonical landing) and deny if ANY
  // spelling matches a read-deny rule. Mirrors checkReadPermissionForTool's
  // deny loop (filesystem.ts:1891-1908); surface-only match was the vuln.
  for (const spelling of getPathsForPermissionCheck(filePath)) {
    if (
      matchingRuleForInput(spelling, toolPermissionContext, 'read', 'deny') !==
      null
    ) {
      return true
    }
  }
  return false
}
```

**Fidelity notes (optional, not required for the security fix):**
- Official gates the resolution behind `aje(ctx)` (skip realpath syscalls when no read-deny rule
  could match). OCC may add the same short-circuit for perf: if there are zero read-deny rules in
  `toolPermissionContext.alwaysDenyRules`, return the surface match directly. Correctness is
  identical without it (`getPathsForPermissionCheck` is memoizable and the deny set is small).
- Official `bge` also folds in `USe` (bare-Read-deny / trustedNetworkDirectories) and `hpr`
  (directory-landing deny for the @-mention directory branch). OCC's `processAtMentionedFiles`
  directory branch (`attachments.ts:2019-2047`) should get the same treatment: gate the readdir on
  the resolved landing too. Minimum viable port = the `isFileReadDenied` hardening above (covers
  the file/content surfaces the changelog names); the directory-branch parity is a follow-up.
- For exact official parity the fix could instead introduce named `wge`/`bge` equivalents, but the
  single-helper hardening is the KISS port and is behaviorally equivalent for the deny decision.

---

## 5. A/B test case

**Setup**
```
mkdir -p ./secret && echo "TOP-SECRET-KEY" > ./secret/x
ln -s ./secret/x ./link
# settings deny rule:  Read(./secret/**)
```

**A — IDE selection through the symlink (the exact changelog surface).**
Simulate an `ide_selection` attachment with `filePath = <abs>/link` and `text = "TOP-SECRET-KEY"`
(IDE supplies content directly; no Read tool call).
- **Before fix (v288-equivalent / current OCC):** `isFileReadDenied("<abs>/link")` → surface
  `./link` does not match `./secret/**` → returns false → `getSelectedLinesFromIDE` emits a
  `selected_lines_in_ide` attachment carrying `TOP-SECRET-KEY`. **DENY BYPASSED (fail-open).**
- **After fix:** `getPathsForPermissionCheck("<abs>/link")` = `["<abs>/link","<abs>/secret/x"]`;
  `matchingRuleForInput("<abs>/secret/x", …,'read','deny')` matches `./secret/**` → returns true →
  attachment dropped (`[]`). **DENIED (fail-closed).**

**Assert:** `getSelectedLinesFromIDE({filePath:'<abs>/link', text:'TOP-SECRET-KEY', lineStart:1,
lineCount:1}, ctxWithDenySecret)` returns `[]`.

**B — @-mentioned file through the symlink.** Prompt containing `@link` with the same deny rule.
- Before: `processAtMentionedFiles`/`generateFileAttachment` gate passes (surface `./link`),
  `FileReadTool.call` reads `./secret/x` → secret content attached. **BYPASSED.**
- After: landing spelling `./secret/x` denied → `null`. **DENIED.**

**Control (no regression):** a NON-symlinked file outside the deny area (e.g. `./ok.txt`) still
attaches normally in both A and B; and the Read *tool* path (`checkReadPermissionForTool`) is
untouched (already resolved spellings), so `Read(./link)` behavior is unchanged.

**Test home:** `src/utils/__tests__/` (unit over `getSelectedLinesFromIDE` /
`processAtMentionedFiles` / `isFileReadDenied` with a symlink fixture + a `Read(./secret/**)`
deny context), plus a behavioral e2e per `behavior-driven-done`.

---

## 6. Summary

| | Official v288 | Official v289 | OCC (current) |
|---|---|---|---|
| IDE-context auto-read deny gate | surface only (`p2`) | + symlink landing (`aje && wge/bge`) | surface only (`isFileReadDenied`) |
| Read **tool** deny | resolves spellings | resolves spellings | resolves spellings (`checkReadPermissionForTool`) |
| Vulnerable to `./link -> ./secret/x` bypass | YES | NO (fixed) | **YES** |

OCC tracks v288 on this path. **PORT**: harden `isFileReadDenied`
(`src/utils/attachments.ts:4314`) to deny-check every spelling from
`getPathsForPermissionCheck`. Files implicated: `src/utils/attachments.ts`
(`isFileReadDenied` + gates 1714/1964/2013/2197/3155/3259); reuses
`src/utils/fsOperations.ts:291` (`getPathsForPermissionCheck`) and
`src/utils/permissions/filesystem.ts:1388` (`matchingRuleForInput`). Read-tool files
(`FileReadTool.ts`, `symlinkResolutionStash.ts`, `symlinkEquivalences.ts`, `pathValidation.ts`)
need no change — they are already resolution-aware.
