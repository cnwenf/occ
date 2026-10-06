# Cluster B — Read Deny / Pasted & Dragged Images / @-Mentions / Memory-File Symlink Escape (2.1.289 → 2.1.291)

Gap research for OCC (tracks official 2.1.289) vs official claude-code 2.1.290 + 2.1.291.
Forensic sources (read-only, **never executed**): `/tmp/cc289/package/claude` (md5 5c920e4c2e6c73c2858cc48e5123582e), `/tmp/cc290/package/claude` (md5 acc2b427816611d7c48666fd4b1cf9b7), `/tmp/cc291/package/claude` (md5 82c1f303d0dd7ef19d869f7b3d886043). Offsets below are `grep -aboF` byte offsets into the raw ELFs; context extracted with bounded python slicing (`/tmp/gap291/ctx.py`).

Verdict legend (same as cluster-f doc): **PORT** = actionable port recommended this round · **STAGED** = real gap, port deferred/gated on an absent surface · **NO-OP** = OCC architecture already produces the fixed behavior · **N-A** = surface absent in OCC (grep-proven).

**291 parity:** every cluster-B-relevant string/function count is identical 290↔291 (verified via `grep -caboF` on both ELFs). 2.1.291's two regression fixes (cloud permission-prompt drop, session-tail loss) do not touch this cluster. All 290 offsets below therefore also describe 291.

## Verdict table

| # | Changelog entry (2.1.290, verbatim) | Verdict | OCC target |
|---|--------------------------------------|---------|-----------|
| B1 | Fixed Read deny rules not applying to image paths pasted or dragged into the prompt, or to file names listed for an @-mentioned folder | **PORT** (both halves) | `src/utils/imagePaste.ts`, `src/hooks/usePasteHandler.ts`, `src/utils/attachments.ts` (directory branch) |
| B2 | Fixed an image read on macOS and Windows being able to return a file outside what was approved, through a link swapped in mid-read | **PORT** (subsumed by B1's guarded-read port) | same as B1 + `src/utils/permissions/symlinkResolutionStash.ts` (new call site) |
| B3 | Fixed an `@`-mention under the read block or `--restricted` being able to read a file outside the working directories through a link changed mid-read | **PORT** (stash wiring) / **N-A** (`--restricted` + `prompt.mention` halves) | `src/utils/attachments.ts` `generateFileAttachment` |
| B4 | Fixed a project `CLAUDE.md`, rule or `AGENTS.md` symlinked outside the working directories loading under `permissions.blockReadsOutsideWorkingDirectories` or a `Read` deny rule | **PORT** (deny arm) / **N-A** (blockReads arm) / **NO-OP** (unsettled arm) | `src/utils/claudemd.ts` |
| B5 | Fixed a subdirectory's AGENTS.md not being attached when a file under it is @-mentioned | **N-A** (feature absent — regression cannot occur) | `src/utils/agentsMd.ts` (unwired) |

> **Every PORT arm in this table LANDED 2026-10-07.** See
> [LANDED (2026-10-07)](#landed-2026-10-07--port-record-deviations-verification)
> at the bottom of this file for the port record, the byte-evidence correction
> to B1's `yr`=`isAbsolute` gate, the documented deviations, and the test /
> live-REPL verification.

## Minified-name mapping 289 → 290 (this cluster's modules)

| 289 | 290 | Role |
|---|---|---|
| `tAo` | `iLo` | paste/drag image reader (290: gains guarded-read callback param) |
| `gmr` | `BTr` | @-mention pipeline |
| `mmr` | `$Tr` | mention helper |
| `dnn` | `zln` | memory-file walk (290: gains `held` param) |
| `fmr` | `LTr` | memory-file loader (290: gains `held` param) |
| `QGn` | `U6n` | project/user memory collector (290: `{skipProject, held}`) |
| `Agt` | `OSt` | memory helper |
| `Gtn` | `Eln` | memory helper |
| `w2` | `UB` | mention deny predicate |
| `aje` | `sy` | isReadBlocked(ctx) |
| `ppr` | `MMe` | verified-open read (stat-identity re-check) |
| `upr` | `l3n` | verified-open helper |
| `nKe` | `PMe` | open w/ platform identity (macOS `VOe`) |
| `oKe` | `LMe` | `attached-read-${uuid}` stash toolUseId |
| `hpr` | `Akt` | directory-listing helper |
| `bge`/`wge` | `Fne`/`TB` | verified-read helpers |
| `h$t` | `A1t` | mention chunk reader |
| `gjt` | `Cqt` | symlink-resolution stash module |
| `sXn` | `Vtr` | search target gate (unchanged — see NO-OP note) |

## String-novelty evidence (counts = `grep -caboF` on raw ELFs)

| String | 289 | 290 | 291 |
|---|---|---|---|
| `read_withheld` | 0 | 2 | 2 |
| `prompt.mention` | 0 | 22 | 22 |
| `readThroughMention` | 0 | 5 | 5 |
| `Instruction file not loaded` | 0 | 4 | 4 |
| `a Read deny rule covers it` | 0 | 2 | 2 |
| `it's read from outside your working directories, where reads are blocked` | 0 | 2 | 2 |
| `where it leads couldn't be worked out` | 0 | 2 | 2 |
| `not read where it lands` | 0 | 2 | 2 |
| `Pasted path is not read` | 0 | 4 | 4 |
| `denied_at_landing` / `landing_unsettled` / `through-open` / `route_moved` | 2 each | 2 each | 2 each (pre-existing) |
| `attached-read-` | 2 (@99551416 data, @210919886 JS) | 2 (@99555672, @210753688) | 2 (pre-existing) |
| `could not be examined and were not attached` / `unexamined` / resolution-changed errors | present | present, identical contexts | identical |

Key structural fact: **the symlink-TOCTOU primitives (stash module, verified-open read, `attached-read-` stash id, landing telemetry) all pre-exist in 2.1.289.** 289 stash module `gjt` @204173650 ≡ 290 `Cqt` @206688446 (identical modulo names); 289 verified-read helpers `ppr/upr/nKe/oKe/hpr/bge/wge` @210919225 ≡ 290 `MMe/l3n/PMe/LMe/Akt/Fne/TB` @210752500–210757400. The 290 fixes are **new call sites + new guards wired onto the paste/drag, mention, and memory-file paths** — not new primitives. Search-gate region (`Refusing to search`) is byte-identical 289→290 (`sXn` @205001403 ≡ `Vtr` @207516755) → adjacent Grep/Glob surface is a **NO-OP** for this round (OCC already ported it as `src/utils/permissions/searchTargetGate.ts`).

---

## B1. Read deny rules not applying to pasted/dragged image paths or @-mentioned folder file listings

### 官方机制 (byte forensics)

**289 (vulnerable):** the drag/paste handler `Kqe` @217756679 reads every dropped image path with `tAo(e,o)` @214030139 — a raw `se().readFileBytes(s)` with **no permission argument at all**:

```js
// cc289 @214030139
async function tAo(e,o){ ... let a=await se().readFileBytes(s) ... }
// handler @217756679: Promise.all(I.map((ue)=>tAo(ue,pe)))  — only telemetry: "read_failed"
```

289's mention pipeline `gmr` @210960118 lists an @-mentioned folder's entries unfiltered: `Ae.slice(0,Pe).map((qe)=>qe.name)` — denied file names appear in the listing (and the listing feeds subsequent reads).

**290 (fixed):** a guarded paste-image read pipeline appears in the read-guard module @210757291–210758104:

```js
// cc290 @~210758040
async function sgs(e,n,r){let s=await Ykt(e,n,r).catch(()=>"refused");
 if(s==="refused")return t("Pasted path is not read: the read is refused",{level:"warn"}),"refused";
 return s==="unexamined"?oe().readFileBytes(Gne(e)):Vkt(e,s).catch(()=>"refused")}
```

- `Ykt(e,n,r)` — pre/post deny check over **all spellings** of the path (`getPathsForPermissionCheck` equivalent) via callback `r`; returns the landing spelling set, or `"unexamined"` when the context blocks nothing (no deny rules ∧ no blockReads — perf bypass to the raw read), or `"refused"`.
- `Vkt(e,s)` — verified read **"where it lands"** (the resolved spelling `s`, not the typed path), returning `"absent"`/`"refused"` sentinels; internally uses the `MMe` verified-open read (see B2).
- Handler wiring @220574143 (290):

```js
iLo(me,Oe,(we)=>sgs(we,()=>{let he=o?.getState().toolPermissionContext;
  return he?[he,igs(he)]:[]},(he,xe)=>Jhn(he,xe,"person")))
// ... we=me.includes("refused"); p("input_image_drag",we?"read_withheld":"read_failed");
// fallback branch now gated: else if(Q&&H&&!we&&he)z()
```

- `Jhn(path,ctx,"person"|"hook")` @213698535 — unified lexical pre-classifier → `"network"` | `"denied"` | `undefined`. Context extension via `N2` @210758348 (see B4) and `igs`.
- New telemetry outcome `read_withheld` (289:0→290:2); refused images are withheld from the prompt and the drag-fallback path is disabled when any read was refused.

**Folder listing (290):** new directory-entry deny filter `d7n` @210756965 (with `Gkt` collector, caps `zkt=1e4` scanned / `Kkt=1000` collected, overflow message `"… and N more entries"`), called from the mention pipeline with the full guard bundle:

```js
// cc290 @~213668754 (BTr mention pipeline)
d7n(Zt,{spellings:Ce,context:g,isDenied:UB,isHeldOutside:vS},signal)
```

Denied names are removed from the listing before it is attached; `UB` (= 289 `w2`) is the deny predicate, `vS` the held-outside check.

### OCC 现状

- `src/utils/imagePaste.ts` — `tryReadImageFromPath` :535; raw reads :550/:557 (`getFsImplementation().readFileBytesSync`); **no permission imports in the whole file** (verified). Other unguarded reads: :235 (screenshot temp), :356 (`$OCC_CLIPBOARD_IMAGE_SRC`), :392 (`$OCC_CLIPBOARD_WATCH_PATH`) — the latter two are OCC-specific env surfaces with no official counterpart.
- `src/hooks/usePasteHandler.ts:154-175` — drag detection (`isTempScreenshot` regex), then `Promise.all(imagePaths.map(tryReadImageFromPath))` — structurally identical to official **289** (`Kqe`+`tAo`), i.e. OCC is exactly at the vulnerable baseline.
- `src/utils/attachments.ts` — `processAtMentionedFiles` :2004; directory branch :2026-2049 does `readdir` then lists names **unfiltered** (MAX_DIR_ENTRIES=1000, "… and N more entries") — identical to official 289 `gmr`. The parity gap is already flagged staged in `src/utils/__tests__/attachmentsSymlinkDenyLanding289.test.ts:26-31`.
- OCC already has the deny predicate needed: `isFileReadDenied` :4362-4394 (surface match + `hasReadDenyRules` short-circuit + `getPathsForPermissionCheck` spelling expansion) — the OCC analog of `UB`/`Jhn(…,"person")==="denied"`.

### 判定

**PORT** (both halves). OCC sits at the official-289 vulnerable baseline on both surfaces.

### 移植方案 + 测试计划

Port (official semantics, no invention):
1. `src/utils/imagePaste.ts`: add a guarded-read path mirroring `sgs/Ykt/Vkt` — deny-check all spellings (`isFileReadDenied`) before reading; when denied return a `"refused"` sentinel (never bytes); when the context blocks nothing, keep the fast raw read (`"unexamined"` bypass); when denied-check passes, read the **resolved landing** path.
2. `src/hooks/usePasteHandler.ts:154-175`: thread the tool-permission context into `tryReadImageFromPath`; treat any `"refused"` like official (`we=me.includes("refused")`) — withhold the image, emit `read_withheld` telemetry, disable the drag-fallback branch.
3. `src/utils/attachments.ts` directory branch :2026-2049: filter entries through `isFileReadDenied` (per-entry, spelling-expanded) before listing — `d7n/Gkt` analog keeping the 1000-entry cap and "… and N more entries" message.

Tests (bun test unit + REPL e2e):
- unit: deny rule `Read(//tmp/secret/**)` + simulated paste of `/tmp/secret/a.png` → sentinel `"refused"`, no bytes read (spy fs), telemetry `read_withheld`; symlink `paste.png -> /tmp/secret/a.png` → refused at landing; no-deny context → raw fast path still taken (no extra stats).
- unit: @-mention a folder containing `denied.md` (deny rule) + `ok.md` → listing contains only `ok.md`; >1000 entries → cap + "… and N more entries" preserved.
- e2e (tmux REPL): project `.claude/settings.json` with a Read deny rule; drag/paste an image path under the deny rule → image not attached, warning surfaces; @-mention the folder → denied names absent.

---

## B2. Image read TOCTOU (macOS/Windows) — link swapped mid-read returns file outside approval

### 官方机制 (byte forensics)

The 290 fix routes the paste/drag read through `Vkt` → `MMe` **verified-open read** (@210752500–210757400 region), which pre-existed in 289 (`ppr` @210919225) but was never called from the paste path:

```js
// cc290 MMe (≡ 289 ppr), condensed
open via PMe (macOS: extra identity VOe), then handle.stat({bigint}) identity
re-check AFTER read; linux/wsl: xkt = /proc/self/fd O_NOFOLLOW readdir check;
mac/win fallback: kMe pre/post existence double-check
```

**Platform gating analysis (required by the brief):** the guard itself is **not** platform-gated — `sgs`/`Ykt`/`Jhn` run on every platform in the handler @220574143. The changelog names macOS/Windows because (a) 289's raw `tAo` read bypassed *all* guards on every platform (linux included — linux just additionally had `/proc/self/fd` coverage on the *tool* read path, not the paste path), and (b) the platform-specific identity machinery inside the shared verified-open helper differs: macOS `VOe` identity, linux/wsl `xkt` `/proc/self/fd`, mac/win `kMe` double-check. **Linux behavior of the official fix: identical guard applies** (landing-verified read + `MMe` with the linux `/proc/self/fd` branch). So OCC on linux must port the same guard, not a weaker one.

### OCC 现状

- Stash infrastructure **already ported** (289-era `Cqt` module): `src/utils/permissions/symlinkResolutionStash.ts` — `stash` :90, `consume` :128, `SymlinkReadRefusedError` :151, `stashCheckTimeResolutions` :259, `assertSymlinkResolutionsUnchangedForRead/Write` :290/:307. Wired into `FileReadTool.ts:674` (+84 import), FileWriteTool :73, FileEditTool :82, NotebookEditTool :36, GrepTool :25, GlobTool :23, `searchTargetGate.ts` :49.
- **But** the paste/drag path (`imagePaste.ts:550/:557`) does raw synchronous reads — no stash, no verified open, nothing. Mid-read symlink swap trivially succeeds.
- `takeApprovedPaths` :196-235 falls back to a **fresh** `getPathsForPermissionCheck(path)` when no stash entry exists — so even where FileReadTool is reached without a prior `checkPermissions` (mention/attachment reads, see B3), the assert no-ops ("the gate below then trivially passes").

### 判定

**PORT** — subsumed by B1's guarded-read port: OCC's `Vkt` analog must (1) resolve the landing spellings, (2) stash them under a synthetic toolUseId, and (3) read via the FileReadTool stash-assert path (or an equivalent verified reader), so a mid-read swap hits `SymlinkReadRefusedError` ("its symlink resolution changed after permission was checked").

### 移植方案 + 测试计划

- Implement in `src/utils/imagePaste.ts` (guarded read from B1): after deny-check passes on the landing spellings, `stash(toolUseId, spellings)` then read through `FileReadTool`-style assert; on refusal return `"refused"` sentinel → `read_withheld`.
- Tests: unit — harness stashes landing spellings, swaps symlink target between stash and read → expect `SymlinkReadRefusedError`, no bytes returned; swap back before read → succeeds (no false positive). e2e (tmux): paste path whose symlink flips mid-read is impractical to time in REPL — cover via unit + a scripted integration test with an fs hook, matching how OCC tested the 289-era stash port.

---

## B3. @-mention under read-block / `--restricted` — link changed mid-read escapes working directories

### 官方机制 (byte forensics)

289 **already had** the mention landing checks (`denied_at_landing`, `landing_unsettled`, `through-open`, `route_moved` — all counts 2→2, pre-existing) via `w2`-predicate + verified open. What 290 adds (@213667997–213669xxx `BTr` pipeline, @213698535):

1. `Jhn(q,g,"person")` unified lexical **pre-check** before any IO (network/denied short-circuit).
2. `readThroughMention` chunk wrapper (**289:0 → 290:5**, JS @213669938) — coordinates the new `prompt.mention` hook event (289:0→290:22; data @93950132, hook-surface list @205485899, default result `"{ deny }"`) with a **refusal re-check on hook-redirected paths**:

```js
refusal:(Wt)=>Wt.path!==ke&&Jhn(Wt.path,de(n),"hook")!==void 0
  ?"the path may not be read here":void 0
```

3. The read itself goes through `A1t(...)` (289 `h$t`) with `landing:Ce,sizeProbe:Me` — i.e. the verified-open landing read — plus a `forget:` step restoring `readFileState` and `nestedMemoryAttachmentTriggers`.
4. Read-block/`--restricted` awareness comes from `sy` @210756551 and `vS`:

```js
var sy=(e)=>Drr(e)||e.restricted===!0||e.blockReadsOutsideWorkingDirectories===!0;
// Drr @206623282: function Drr(e){return xl(e)||Un(e,"read","deny").size>0}
function vS(e,n){let r=n.restricted&&Co(e);return r&&!qh(e,n,r)&&die(e,{},r,{restricted:!0}).behavior!=="allow"||Uve(e,n)}
```

### OCC 现状

- `src/utils/attachments.ts` `processAtMentionedFiles` :2004 — check-time `isFileReadDenied` :2019 (289-equivalent lexical deny); `pathInAllowedWorkingPath` gate :1898; file reads via `generateFileAttachment` :3140 → deny :3161 → `FileReadTool.validateInput` + `.call` :3295-3301; `readTruncatedFile` deny :3265.
- **Gap:** mention reads invoke `FileReadTool.call` **without** `checkPermissions`, so no stash entry is created → `assertSymlinkResolutionsUnchangedForRead` at FileReadTool.ts:674 falls back to fresh resolution and **no-ops** (symlinkResolutionStash.ts:196-235). A link swapped between :2019's deny check and :3295's read escapes — the exact 289-shaped hole official 290 closes. OCC has **no** `attached-read-` string (grep 0 hits), while official uses `attached-read-${uuid}` stash ids in **both** 289 and 290 (`LMe`/`oKe`) — this is the missing call site.
- **Absent surfaces (grep-proven):** `--restricted` — 0 code hits (docs-staged since OCC-107/108, `docs/upstream-version-gap-occ107.md:120`); `blockReadsOutsideWorkingDirectories` — only a comment in `src/tools/BashTool/__tests__/subshellRm273.test.ts:18`; `ToolPermissionContext` (`src/Tool.ts:133-148`) has neither field nor `trustedNetworkDirectories`; `prompt.mention` absent from `HOOK_EVENTS` (`src/entrypoints/sdk/coreTypes.ts:25-69`).

### 判定

- **PORT** — stash wiring: before `FileReadTool.call` in `generateFileAttachment`, stash the check-time landing spellings under a synthetic `attached-read-<uuid>` toolUseId (official `LMe` pattern, which exists since 289), so the :674 assert actually gates mid-read swaps. This makes mention reads TOCTOU-safe **without** needing the restricted/blockReads surfaces.
- **N-A** — the `--restricted`/`blockReadsOutsideWorkingDirectories` half (settings/CLI surfaces absent; already staged in OCC-107/108 ledger) and the `prompt.mention` hook-event half (new official hook API; record as a feature gap for the hooks roadmap, semantics: default `"{ deny }"`, refusal re-check on redirected paths).

### 移植方案 + 测试计划

- `src/utils/attachments.ts` `generateFileAttachment` :3140: generate `attached-read-${randomUUID()}`; call `stashCheckTimeResolutions(toolUseId, path)` (or `stash`) with the spellings computed at deny-check time (:3161/:3265); pass the id through to the FileReadTool call so `assertSymlinkResolutionsUnchangedForRead(context, fullFilePath, toolUseId)` consumes it; on `SymlinkReadRefusedError` produce the official-style "could not be examined and were not attached" outcome.
- Tests: unit — mention a symlink whose target flips between deny-check and read → refused + not attached; stable symlink → attaches with landing content; non-mention FileReadTool paths unaffected (fresh-resolution fallback preserved). Regression: existing `attachmentsSymlinkDenyLanding289.test.ts` suite stays green.

---

## B4. Project CLAUDE.md / rule / AGENTS.md symlinked outside working directories loading under blockReads or a Read deny rule

### 官方机制 (byte forensics)

290 introduces an entire **instruction-file held/withheld subsystem** (all reason strings 289:0→290:2, log string 289:0→290:4), region @210755400–210760000 + threading @210764358/@210767127/@210780206:

```js
// context extender N2 @210758348 — persisted deny rules + forced blockReads
var N2=(e)=>f1({strictPersistedTrust:!0}).filter((n)=>n.ruleBehavior==="deny")
 .map((n)=>[n.source,xn(n.ruleValue)]).reduce((n,[r,s])=>n.alwaysDenyRules[r]?.includes(s)?n:
 {...n,alwaysDenyRules:{...n.alwaysDenyRules[r]??[],s: [...]}},{...e,...Tze()&&{blockReadsOutsideWorkingDirectories:!0}});

// classifier Bkt @210755603 → "unsettled" | "denied" | "outside"
// reader L2 @210755782 — size-capped verified read, returns {text} or {text:undefined, why}
var L2=(e,n)=>async function(s,g){let h=AbortSignal.timeout(n),S=await ID(s,h),w=Bkt(S,e),
 ...W=...&&await MMe(s,S,h)(async(Y,he)=>he.size>g?void 0:Y.handle.readFile()),
 ...return W?{text:W.toString("utf8"),why:void 0}:{text:void 0,why:q?"unsettled":w}};
// judges S3n @210756289 = {within: FMe(L2(judge,OD=30000),n), above: r=>FMe(L2(Une(e,r,$kt),OD),n)}
// $kt @210755477 = [CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/CLAUDE.md, .claude/AGENTS.md, .claude/rules]
// Une = ancestor relaxation for $kt names; FMe/NMe = lstat-existence suppressor
```

Threading: `U6n(e,n,r,{skipProject,held:g})` @210780206 (289 `QGn` @208194896 has **no** held param) → `U$` @210767127 (`let be=H&&await zMe(e,n,he,S,H); if(be&&!be.info)return[]`) → `zMe` @210764358:

```js
if(g){let w=await g(e,RB);return w===void 0?{info:null,includePaths:[]}:GMe(w,e,n,r)}  // RB=4194304 size cap
```

Withheld bookkeeping @210758400–210759800: state `withheld:{own,ownRoot,walk,walkRoot,ends,moves,at}` (cap `YMe=20`), reason table:

```js
dSt={denied:"a Read deny rule covers it",
     outside:"it's read from outside your working directories, where reads are blocked",
     unsettled:"where it leads couldn't be worked out"}
// log lSt: "Instruction file not loaded: {path} ({reason})"
```

`vS` (isHeldOutside, restricted-aware) and `sy` (isReadBlocked, quoted in B3) decide the `outside` arm; `MD` @210750713 (`Gf(e.replace(/^\/{2,}/,"/"))||O()==="windows"&&as(e)`) flags network/UNC shapes.

### OCC 现状

- `src/utils/claudemd.ts` — `getMemoryFiles` :1124, `processMemoryFile` :749-830, `processMdRules` :890 (rules-dir walker), `applyAgentsMdInstructionMode` :1451-1561, `getMemoryFilesForNestedDirectory` :1747. **No `alwaysDenyRules` consult anywhere in the file** (grep 0).
- Chokepoint `safelyReadMemoryFileAsync` :540-560 already gates with `isDeniedMemoryPath` (`src/utils/macosKernelPaths.ts:401-414`) + `shouldRefuseMemorySymlink` (:442-470, **fail-closed** on dangling/ELOOP/EACCES) — 2.1.282/284 ports. This already delivers the official `"unsettled"` arm's outcome (unresolvable → not loaded), though without the official log wording.
- `processMemoryFile` :772-821: literal-path deny, `safeResolvePath` :778, resolved-path gate :788, User-scope depth-0 symlink + `nlink>1` hardlink reject :804-821.
- `blockReadsOutsideWorkingDirectories` / `restricted`: **absent** (see B3 grep proof) → the `outside` arm has no OCC trigger surface.

### 判定

- **PORT** — deny arm: consult Read deny rules (with `getPathsForPermissionCheck` spelling expansion) inside `safelyReadMemoryFileAsync` (single chokepoint covering CLAUDE.md/CLAUDE.local.md/AGENTS.md/.claude/rules via `processMemoryFile`/`processMdRules`/nested loaders), refusing the load and logging the official message `Instruction file not loaded: <path> (a Read deny rule covers it)`.
- **NO-OP** — unsettled arm: OCC's fail-closed `shouldRefuseMemorySymlink` already refuses unresolvable links (2.1.282 port); align the log wording only (`where it leads couldn't be worked out`).
- **N-A** — outside arm (`blockReadsOutsideWorkingDirectories` / `--restricted`): setting absent in OCC; staged since OCC-107/108. When that surface lands, the official judge pair `S3n={within,above}` + `Une` ancestor relaxation over `$kt` + withheld-state machine (cap 20) is the target semantics recorded here.

### 移植方案 + 测试计划

- `src/utils/claudemd.ts` `safelyReadMemoryFileAsync` :540-560: add a deny-rule consult (reuse `isFileReadDenied` from attachments.ts — extract to a shared util to avoid a cycle, e.g. `src/utils/permissions/readDeny.ts`) before the existing symlink gates; on deny return the existing "not loaded" shape and log `Instruction file not loaded: {path} (a Read deny rule covers it)`; keep fail-closed unsettled log aligned to `(where it leads couldn't be worked out)`.
- Cover all four loader entry points: project CLAUDE.md walk (`getMemoryFiles`), `.claude/rules` (`processMdRules`), AGENTS.md mode (`applyAgentsMdInstructionMode`), nested-dir memory (`getMemoryFilesForNestedDirectory`).
- Tests: unit — project `CLAUDE.md` → symlink to `/etc/passwd`-style outside file + deny rule `Read(CLAUDE.md)` (and separately a deny rule matching the *landing*) → not loaded + exact log line; `.claude/rules/x.md` denied → walker skips it, others still load; dangling symlink → existing fail-closed preserved (regression). e2e (REPL tmux): project with denied symlinked CLAUDE.md → system prompt does not contain its content; startup log shows the not-loaded line.

---

## B5. Subdirectory AGENTS.md not attached when a file under it is @-mentioned

### 官方机制 (byte forensics)

290 **rewrites the bundled agents_md plugin** (@236499800–236506200; 289 module @233188800–233194600 only had a `tool.call{tool:"Read"}` hook):

- New `prompt.mention` hook event (default result `"{ deny }"`), consumed by the mention pipeline's `readThroughMention` (B3).
- Shared nested collector `Le` @236506109:

```js
async function Le(e,t,o){if(!await nt(e))return[]; ... fs.ancestors({names:["AGENTS.md",".claude/AGENTS.md"],of,below}) ...}
```

  with dedup against already-given files; lifecycle `G=["read","submitted","riding"]`; pending/given maps; `ae=(e,t,o)=>({path:e,road:o,loop:t.agentId??E,isWhole:t.offset===void 0&&t.limit===void 0})` — a directory's own AGENTS.md attaches only for **whole-file** reads; hooks: `command.run{clear,compact,resume}`, `session.compact`, `prompt.submit`, `turn.start`, `turn.complete`, `agent.spawn fork` (pending restore across compaction/fork).
- The changelog fix = the mention path now runs the same `Le` collector, so @-mentioning `sub/file.ts` attaches `sub/AGENTS.md` (previously only Read-tool calls triggered it).

### OCC 现状 (absence proof)

- `src/utils/agentsMd.ts` (473 lines) is a **v277-era pure-logic port**: `NESTED_EVENT` :96, `nestedFrame` :375, `outsideClaudeDirs` :384, `absoluteOf` :396. `grep -l` proof: referenced **only** by itself and `src/utils/__tests__/agentsMd.test.ts` — no Read-hook consumer, no mention consumer, not wired into any pipeline.
- `prompt.mention` absent from `HOOK_EVENTS` (`src/entrypoints/sdk/coreTypes.ts:25-69`).
- OCC's nested memory attachment (`getNestedMemoryAttachments`, attachments.ts:2287-2314) covers CLAUDE-named files only; AGENTS.md nested attachment does not exist at all.

### 判定

**N-A** — OCC never attaches nested AGENTS.md on any path, so the fixed regression (mention path missing the collector the Read path had) cannot occur. The underlying **feature** (nested AGENTS.md attachment + `prompt.mention` hook) is a genuine feature gap, recorded here as the target semantics for when `agentsMd.ts` gets wired: `Le`-collector over `["AGENTS.md",".claude/AGENTS.md"]` ancestors below the mentioned/read path, whole-file-read condition for the directory's own AGENTS.md, pending/given/riding lifecycle with compaction/fork restore, and `prompt.mention` hook with default `"{ deny }"`.

### 移植方案 + 测试计划

None this round (N-A). When wiring agentsMd.ts in a future round: unit tests for `Le`-equivalent collection (ancestor walk, dedup, below-cap), whole-vs-partial read distinction, pending restore across compact/fork; e2e: @-mention `sub/file.ts` in a project with `sub/AGENTS.md` → content appears in the attached context exactly once.

---

## Cross-item port notes

- B1+B2+B3 share one primitive: a **guarded landing read** (`sgs/Ykt/Vkt` analog) + the pre-existing stash. Implement once (suggest `src/utils/permissions/guardedRead.ts`) and call from imagePaste, usePasteHandler, and generateFileAttachment — matches official, where one read-guard module (@210752500–210758104) serves all three paths.
- B4 reuses the same deny predicate (`isFileReadDenied`) at the memory-file chokepoint; extracting it to a shared util serves B1/B3/B4 (official likewise shares `UB`/`Jhn`).
- Sequencing suggestion: B4 (smallest, pure-deny consult) → B1 folder-listing filter → B1/B2 guarded image read → B3 stash wiring (largest blast radius; regression suite `attachmentsSymlinkDenyLanding289.test.ts` guards it).

---

## LANDED (2026-10-07) — port record, deviations, verification

All four actionable items (B1 both halves, B2, B3 stash arm, B4 deny arm) are
implemented, TDD-driven, byte-verified against `/tmp/cc290/package/claude`
(strings/`dd`/`grep -aboF` only — never executed) and e2e-verified in the
production build. B5 stays N-A; B3's `--restricted`/`prompt.mention` halves and
B4's `blockReadsOutsideWorkingDirectories` arm stay N-A (grep-proven absent).

### Shared primitive — `src/utils/permissions/guardedRead.ts`

One module serves all three paths, as official's single read-guard module
(@210752500–210758104) does:

| OCC export | Official | Role |
|---|---|---|
| `resolveGuardedRead` | `Vkt`/`Nkt` | deny check over EVERY spelling (surface → each link target → canonical landing), both contexts, fail-closed on an empty context list |
| `readGuardedAtLanding` | `sgs`/`Ykt` | guarded read returning `Buffer \| 'refused' \| 'absent'` |
| `readPastedFileGuarded` | `sgs(path, getCtxs, judge)` | paste/drag entry point |
| `checkTimeReadResolutions` | `W=!H?[e]:h?.landing??await TB(e,…)` | check-time spelling list, only resolved when reads are blocked |
| `guardedAttachedReadContext` | `H ? await LMe(e,q,r) : r` | attach the stash to the `ToolUseContext` for the attachment reads |
| `assertGuardedReadUnchanged` | `h?await PMe(he,be,…)` | post-read re-assert for the changed-file IMAGE read |
| `dotdotNormalizedReadPath`, `isNetworkShapedPath`, `resolutionsUnchangedAndAbsent`, `attachedReadContext`, `nextAttachedReadToolUseId` | `Gne`/`PNr`/`MMe`-subset | helpers |

### B1 — paste/drag image paths

- `src/utils/imagePaste.ts`: `tryReadImageFromPath(text, readPastedFile)` — the
  reader is a **required** parameter (official `iLo`'s third argument), so an
  unguarded call site is a compile error. Returns
  `ImageWithDimensions & {path} | 'refused' | null`, with the `'refused'` arm
  checked **before** the falsy check (official v290 order).
- `src/hooks/usePasteHandler.ts`: `getPermissionContexts()` is official
  `()=>{let he=o?.getState().toolPermissionContext; return he?[he,igs(he)]:[]}`
  — the live store context **plus** the persisted-deny-only view
  (`getPersistedReadDenyContext()` = official `igs`/`N2`), read as a live
  closure on both sides of the symlink resolution. Missing store ⇒ `[]` ⇒
  `resolveGuardedRead` fails closed. `anyRefused` (`me.includes("refused")`)
  withholds that image, disables the temp-screenshot clipboard fallback for the
  whole gesture, and reports `read_withheld`; the new `.catch` arm reports
  `read_threw` (289 had only `read_failed`).
- **CORRECTION to the research note above.** The doc's earlier reading of
  official `he=K.every((be)=>yr(PNr(be)??""))` as the temp-screenshot regex was
  wrong. The chunk's import header @220572106 is
  `import{basename as wr,isAbsolute as yr}from"path"` ⇒ `yr` **is `isAbsolute`**.
  Ported as `allPastedImagePathsAbsolute(imagePaths)` — the clipboard fallback
  needs every cleaned path absolute (a VSCode-terminal bare filename must not
  trigger a clipboard read). Also byte-confirmed at that offset:
  `o=Te(EC)`=`useContext(AppStoreContext)`, `z=qj(U,xr)` with `xr=50` (the
  debounced clipboard check), `p(...)`/`m(...)` = the two `input_image_drag`
  telemetry emitters.
- Folder-listing half (`listMentionedDirectoryEntries` /
  `isMentionedDirEntryReadDenied`, official `d7n`/`Gkt` @210756965) landed
  earlier in this round.

### B2 — image-read TOCTOU

Guarded landing read + `assertSymlinkResolutionsUnchangedForRead`. **Not**
platform-gated: official's guard isn't either (the changelog names
macOS/Windows only because that is where a mid-read link swap was reachable).

### B3 — @-mention under read-block, link changed mid-read

`src/utils/attachments.ts`: `hasReadDenyRules(appState.toolPermissionContext)`
computed once per sweep (official `h=sy(r)`), then per file
`checkTimeReadResolutions` → `FileReadTool.call(input, guardedAttachedReadContext(...))`
at all three sites (`getChangedFiles` text read, `generateFileAttachment`
truncated read + main read), with `assertGuardedReadUnchanged` placed **before**
the inner `try` of the `result.data.type === 'image'` branch so a
`SymlinkReadRefusedError` lands in the sweep's outer catch (`return null`)
rather than the compression-error handler.

### B4 — instruction files

Already landed pre-round: `src/utils/claudemd.ts:580`
`isFileReadDenied(filePath, getPersistedReadDenyContext())`.

### Documented deviations (never invented; each has a byte-level reason)

1. Official `MMe` **verified-open** (fd re-check at open time) is replaced by
   OCC's 2.1.251 `SymlinkResolutionStash` gate
   (`stashCheckTimeResolutions` + `assertSymlinkResolutionsUnchangedForRead`,
   one-shot consume). Same observable contract for the mid-read swap; the
   fd-level guarantee is not reproducible on OCC's `getFsImplementation()` seam.
2. The UNC `MD`/`Gf` bypass stays dropped (Windows-only surface).
3. `--restricted`, `blockReadsOutsideWorkingDirectories`,
   `trustedNetworkDirectories`, the `prompt.mention` hook event and the macOS
   `stashIdentity`/`VOe` lane are all grep-proven absent in OCC (N-A).
4. Pre-existing OCC divergences inside `imagePaste.ts` were **not** rewritten
   (out of the 289→291 delta): `logError(e)` instead of official's
   `Failed to read pasted image file ${s}: …` at level error; mediaType from
   `detectImageFormatFromBase64` after resize instead of official's buffer-side
   `fy(i)` + "not a supported image" warn; no WSL `toLocalPath` arm.

### Tests

| Suite | Result |
|---|---|
| `guardedRead291.test.ts` | 23 pass |
| `imagePasteDeny291.test.ts` | 8 pass |
| `usePasteHandlerDeny291.test.tsx` | 4 pass / 17 expect() — drives the REAL hook through a REAL ink mount (PassThrough stdout/stdin), telemetry asserted via `CLAUDE_CODE_DIAGNOSTICS_FILE` |
| `attachmentsAttachedReadStash291.test.ts` | 6 pass / 19 expect() |
| `readDeny291.test.ts` | 18 pass / 28 expect() — dedicated unit suite for the shared primitives (added pre-commit, see hygiene note below) |
| 40-file cluster sweep | **476 pass / 1 skip / 0 fail / 1120 expect()** |

Teardown note: OCC's ink fork does **not** resolve `waitUntilExit()` on an
explicit `unmount()` (verified with a standalone probe: `render` 83 ms,
`unmount` fine, the promise hangs) — hook tests must unmount and return.

Full-suite A/B (regression proof): baseline = HEAD `5ab0d1e` in a clean
detached worktree, `bun test src` → **7736 pass / 2 skip / 105 fail / 1 error**;
this round's tree → **7999 pass / 1 skip / 105 fail / 1 error**. `diff` of the
sorted `(fail)` name lists is **empty** — identical 105 pre-existing failures,
+263 new passing tests, zero regressions. All 29 failing files are tracked and
unmodified this round; run in isolation both trees give 339 pass / 18 fail with
the same failing set.

### Live e2e (production `dist/cli.js`, tmux, real bracketed paste)

Built `dist/cli.js` 29.89 MB (31,337,280 B), `MACRO.VERSION=2.1.370`.

1. `occ --version` → `OCC 2.1.370`; `echo "say PONG" | occ -p` → `PONG`, exit 0.
2. REPL boot in 2 s; `say PONG` → `● PONG` (58,451 tokens); `/status` renders
   Version 2.1.370 / Session ID / cwd / Model / MCP servers.
3. Real bracketed paste (`printf '\033[200~<png>\033[201~'` via
   `tmux send-keys -l`) of an **allowed** PNG → `❯ [Image #1]` chip in ~1 s, no
   telemetry. Regression control for the rewritten paste path.
4. Same paste of a **denied** PNG (project `.claude/settings.json` deny rule) →
   **no chip**, the path lands as plain text (official fallback
   `onPaste(pastedText)`), and diagnostics carry
   `{"event":"input_image_drag","data":{"reason":"read_withheld"}}`.
5. `@`-mention of the denied image → not auto-attached; the model replied
   `NOTATTACHED`, and its follow-up `Read` was blocked with
   `File is in a directory that is denied by your permission settings`.

**Trap worth recording:** absolute-path `Read` deny rules need the doubled
slash — `Read(//tmp/x/secret/**)`. A single leading slash is
settings-dir-relative, so `Read(/tmp/x/secret/**)` silently matches nothing.
First e2e attempt hit this: `loadPersistedReadDenyRules()` loaded the rule and
`hasReadDenyRules` was true, yet `isFileReadDenied('/tmp/x/secret/s.png', ctx)`
returned `false`; re-running with `//tmp/...` returned `true`. This is official
CC rule syntax (gitignore-style anchoring), not an OCC defect.

### Pre-commit hygiene (2026-10-07, same round)

Two findings from the commit-prep pass, both recorded because they are
traps rather than one-off typos:

1. **`readDeny.ts` was a git-binary file.** `rulesFingerprint` used literal
   NUL / SOH control bytes as separators (`` `${rule.source}<NUL>${value}` ``
   `.join(<SOH>)`), so git classified the new source file as binary
   (`Bin 0 -> 7953 bytes` in `--stat`, `file(1)` → `data`): no diff, no
   review, and the pre-commit biome hook cannot see it. Replaced with the
   `\u0000` / `\u0001` escapes — byte-identical runtime strings, ASCII-clean
   source (`file(1)` → `JavaScript source, UTF-8 text`). The separators stay
   control characters on purpose: they cannot appear in a settings-sourced
   rule value, so no two distinct rule sets can share a fingerprint.
2. **`mock.module` + a self-calling wrapper = infinite recursion.** The new
   `readDeny291.test.ts` counts `getPathsForPermissionCheck` calls to pin the
   official `aje` short-circuit. The first version delegated to
   `actualFsOperations.getPathsForPermissionCheck(...)` — but the awaited
   namespace object is the *same* one `mock.module` rebinds, so the wrapper
   called itself and the file hung (600 s timeout, no output). Fix: capture
   the function reference *before* mocking
   (`const actualGetPaths = actualFsOperations.getPathsForPermissionCheck`)
   and call that. Applies to any spy-wrapper over a module you also mock.

`readDeny291.test.ts` (18 tests) covers what the surface suites only touch
indirectly: `hasReadDenyRules` (empty / other-tool-only / Read-deny),
`isFileReadDenied` (surface deny, symlink-landing deny, allow, and **both**
short-circuits asserted by call count — no-rule ⇒ 0 resolutions, surface-match
⇒ 0 resolutions, non-matching surface with a rule ⇒ >0), `loadPersistedReadDenyRules`
(deny-only filter + source), `extendContextWithPersistedReadDenyRules`
(input not mutated, per-source keying, dedup), `getPersistedReadDenyContext`
(persisted-only deny enforced, memo **identity** while rules are unchanged,
invalidation on a settings change, `resetPersistedReadDenyContextForTesting`).
The identity assertion is the one that guards the documented reason the memo
exists — `matchingRuleForInput` caches compiled gitignore matchers by
rules-object identity, so a fresh object per probe would rebuild them.
