# R2 — BASH / PERMISSIONS / SANDBOX / READ cluster (official 2.1.303 → 2.1.304)

Research-only report. All official-binary excerpts were recovered by static byte
forensics (`grep -aboF` offsets + `dd` windows) against:

- prev = `/tmp/cc-diff-304/vprev/package/claude` (official 2.1.303)
- ver  = `/tmp/cc-diff-304/vver/package/claude` (official 2.1.304)

OCC baseline: release 2.1.393, aligned to official 2.1.303 (HEAD = origin/main 87974fd7).
No official binary was executed. Every excerpt below was dd-verified at the recorded offset.

| Item | Changelog | Verdict | Effort |
|---|---|---|---|
| #10 | mounted-drive `rm -r` safety prompt | **PORT** | M |
| #9  | sandbox `denyRead` glob `[user-id]` crash on Linux | **PORT** (dep bump or patch backport) | M / S |
| #35 | Bash/PowerShell deleting large output file when copy to tool-results fails | **N-A** (OCC structurally immune) + optional logging enhancement | S (optional) |
| #34 | PreToolUse hook deny reason replaced by timeout error | **PORT** (adapted — different mechanism in OCC) | M |
| #32 | interrupt not ending a Read waiting on idle pipe/device named like an image | **PORT** | S |

---

## Item #10 — mounted-drive `rm -r` safety prompt

Changelog: *"Added a safety prompt when `rm -r` targets a mounted drive (e.g.
`/Volumes/Backup`), the folder holding mounted drives, or a top-level folder of
a drive; cannot be auto-allowed by permission rules. Disable with
`CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT`."*

### String evidence (prev → ver occurrence counts)

| String | prev | ver | ver offsets |
|---|---|---|---|
| `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` | 0 | 5 | incl. env allowlist @240663587 |
| `on mounted drive path` | 0 | 2 | constants region @246327485–246328400 |
| `This command would remove a mounted drive` | 0 | 1+ | analyzer @246328119–246332549 |

### Official 2.1.304 logic (verbatim, ver @246328119–246332549)

The dangerous-rm analyzer `XG` gains a NEW deferred mounted-drive arm. Verbatim
branch (minified names as-is):

```js
if(ke===void 0&&V&&!a.CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT&&e==="rm"&&(_e||Ie)&&Ge.some((Ve)=>{let rt=L$o.normalize(Ve).replace(/(.)\/$/,"$1");return Ve.startsWith("/")&&G$o.test(rt)})){let Ve=rWe(Ee).replaceAll("__CMDSUB__","$(…)");ke=jb(e,`Dangerous ${e} operation detected: '${Ve}'

This command would remove a mounted drive, the folder that holds mounted drives, or a file or folder at the top level of a drive. This requires explicit approval and cannot be auto-allowed by permission rules.

If you meant something deeper inside, name it by its full path.`,`${YWt}${Ve}`)}
```

Semantics:
- `ke` = deferred result variable. The arm only fires if no earlier arm already
  produced a result (`ke===void 0`); it is checked AFTER the critical-path and
  workspace-dir/ancestor arms (which return immediately) and after the
  glob-traversal arm. Final return changed to
  `return ke??{behavior:"passthrough",message:\`No dangerous removals detected for ${e} command\`}`.
- `V` = feature gate `GX()` (`tengu_bright_lake`, ver @246327485):
  `function GX(){let{value:e,source:n}=bn($o,!0);return e!==!1||n!=="payload"}` —
  default-on; off only when payload explicitly sets false.
- Kill-flag: raw env truthiness `!a.CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT`.
- `e==="rm"` — **rm only, not rmdir**.
- `_e` = recursive-flag detector (NEW regex, prev=0/ver=1):
  `(n.includes("--")?n.slice(0,n.indexOf("--")):n).some((be)=>/^--r|^-[a-zA-Z]*[rR]/.test(be)||!be.includes("/")&&(be.includes("__CMDSUB__")||wi(be))&&/^(?:-|__(?:CMDSUB(?:_OUTPUT)?|TRACKED_VAR)__)/.test(be))`
  — flags before `--` only; `-r`/`-R` bundled forms (`-rf`, `-fr`); a bare
  `__CMDSUB__`/tracked-var token that starts like a flag also counts (dynamic
  recursive flag). `Ie` = glob-collapsed flag (target came from a glob fold).
  Condition is `(_e||Ie)`.
- `Ge` = candidate absolute paths: the glob-folded target `xe` plus
  symlink-resolved variants. Each candidate: `path.posix.normalize(p)` then
  strip trailing slash (`.replace(/(.)\/$/,"$1")`), must `startsWith("/")`,
  then tested against `G$o`.

Path regex `G$o` (NEW, ver constants region @246327485–246328400):

```js
G$o=/^\/(?:system\/)?volumes(?:\/[^/]+){0,2}$|^\/mnt\/(?:[^/]+|[a-z]\/[^/]+)$|^\/(?:run\/)?media(?:\/[^/]+){0,3}$/i
```

Covers: macOS `/Volumes` + `/System/Volumes` (mount root, one child, or top-level
folder of a drive — ≤2 levels); Linux `/mnt/<name>` and WSL `/mnt/<letter>/<name>`
(exactly); `/media`, `/run/media` and children ≤3 levels. Case-insensitive.

Result builder `jb` (ver @246322984, pre-existing):

```js
function jb(e,n,r){return{behavior:"ask",message:n,decisionReason:{type:"safetyCheck",reason:`Dangerous ${e} operation ${r}`,classifierApprovable:!1,circuitBreaker:"dangerousRemoval"},suggestions:[]}}
```

So decisionReason.reason = `Dangerous rm operation on mounted drive path: <display>`;
`classifierApprovable:false` (cannot be auto-allowed); circuitBreaker
`"dangerousRemoval"`.

Supporting constants (same region):
- `YWt="on mounted drive path: "` (NEW; siblings `KWt="use a literal path: when the expansion is empty this removes /"`, `VWt="on drive root: "` pre-existing)
- `U$o=new RegExp(\`^Dangerous rm(?:dir)? operation ${YWt}/\`)` (NEW — classifier helper)
- Shape classifier `yze(e)` returns `"placeholder_root_child"` / `"backslash_only"` / **`"mounted_drive_path"`** (NEW third value); telemetry `U0(e){OD("tengu_bash_dangerous_rm_shape",{shape:c(e)})}`.
- Import line ver @246314518: `import{basename as BWt,isAbsolute as av,normalize as D$o,posix as L$o,resolve as jWt,sep as N$o}from"path"` — `L$o` = `path.posix` (NEW import member vs prev).
- Env allowlist ver @240663587: `..."CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT","CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT","CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT","CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY",...`

prev confirmed lacking the arm: prev `XG` @243542787 ends after the workspace-dir
check → glob-traversal → `return{behavior:"passthrough",...}` — no `ke`, no
mounted-drive branch.

### OCC surface

- `src/tools/BashTool/pathValidation.ts:131` `checkDangerousRemovalPaths` — the
  critical-path arm only (`isDangerousRemovalPathWindowsAware` @:154 → ask with
  `on critical path:` reason + circuitBreaker @:155–173; passthrough
  `No dangerous removals detected for ${command} command` @:178–181). No
  workspace-dir, glob-traversal, or mounted-drive arms.
- `src/tools/BashTool/destructiveCommandWarning.ts:1629` `analyzeRmArgsV281` —
  tracked-var top-level arm (`rm_placeholder_root_child`, reason
  `on possibly-empty variable path: … (use a literal path…)`) and backslash-only
  drive-root arm (`rm_backslash_only_drive_root`, `on drive root: ${token}`);
  `findDangerousRmV281Block` @:1686; `buildPossiblyEmptyVarBlock` @:1595;
  `tengu_bright_lake` always-on note @:1416; CMDSUB placeholder constants @:600.
- Kill-switch registry: `src/tools/BashTool/dangerousRmAutoDeny.ts:56`
  (`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT`, raw-truthiness note @:171),
  `src/tools/BashTool/inlineShellRm.ts:318/:331`; env allowlist surface
  `src/utils/managedEnv.ts` (already carries
  `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT` / `…INLINE_SHELL_RM_PROMPT`).

### Verdict: PORT. Effort M.

Recipe:
1. Add the mounted-drive arm to the dangerous-rm pipeline. Best landing site is
   `checkDangerousRemovalPaths` (pathValidation.ts:131) — it already iterates
   extracted absolute paths and builds `safetyCheck` ask verdicts with
   `circuitBreaker:'dangerousRemoval'` — or `analyzeRmArgsV281` if flag/token
   context is needed there. The official arm needs: (a) command === `rm` only;
   (b) recursive-flag detection over the pre-`--` args with the NEW regex above
   (OCC has the CMDSUB/tracked-var token vocabulary in
   destructiveCommandWarning.ts:600); (c) candidate = posix-normalized,
   trailing-slash-stripped absolute path (plus symlink-resolved variants);
   (d) `G$o` regex verbatim.
2. Message verbatim (3 paragraphs above), decisionReason
   `{type:'safetyCheck', reason: \`Dangerous rm operation on mounted drive path: ${display}\`, classifierApprovable:false, circuitBreaker:'dangerousRemoval'}`.
   `display` = the user-visible target with `__CMDSUB__` rendered as `$(…)`.
3. Priority: deferred — only when no earlier arm produced a result (matches
   official `ke===void 0` + `return ke??passthrough`).
4. Kill-flag `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` with raw truthiness
   (mirror dangerousRmAutoDeny.ts:171 note) + add to `managedEnv.ts` allowlist.
5. Optional: extend the OCC shape classifier/telemetry analog with
   `mounted_drive_path`.

---

## Item #9 — sandbox `denyRead` glob with non-char-class brackets fails on Linux

Changelog: *"Fixed sandbox `denyRead` rules whose glob contains brackets that are
not a character class (e.g. `[user-id]`) failing on Linux."*

### Root cause (proven from prev binary)

prev (2.1.303) bundles the OLD sandbox-runtime glob engine — a regex-replace
chain, verbatim @239471657:

```js
"^"+e.replace(/[.^$+{}()|\\]/g,"\\$&").replace(/\[([^\]]*?)$/g,"\\[$1").replace(/\*\*\//g,"__GLOBSTAR_SLASH__").replace(/\*\*/g,"__GLOBSTAR__").replace(/\*/g,"[^/]*").replace(/\?/g,"[^/]").replace(/__GLOBSTAR_SLASH__/g,"(.*/)?").replace(/__GLOBSTAR__/g,".*")+"$"
```

`[user-id]` passes through untouched (the `\[([^\]]*?)$` escape only handles an
UNCLOSED bracket) → `new RegExp("…[user-id]…")` → **SyntaxError: Range out of
order in character class** (`r`=114 > `i`=105). The matcher `le(e,t)` builds the
RegExp on its first line OUTSIDE the try/catch → the throw escapes → Linux
sandbox startup fails for the whole denyRead rule set.

ver (2.1.304) bundles a NEW AST-based glob engine (srt chunk right after the
`// Version: 2.1.304` banner, ~@241900000–241907000):
- TokenKind enum `O`: `e.Text="text",e.Separator="separator",e.AnyChar="anyChar",e.Star="star",e.Globstar="globstar",e.GlobstarSlash="globstarSlash",e.Set="set"` (`globstarSlash` prev=0/ver=2 @126811308/@241904827).
- `ge(e)` setRanges validator: empty set or backwards range (`c<s`) → `undefined`.
- `U(e)` tokenizer: unclosed `[` or invalid set → brackets demoted to literal
  Text (`a.push(...)`, `c=f+1`), warns
  `[Sandbox] The brackets in ${a.join(", ")} spell no set of characters, so they are read as text: ${e}`
  (`spell no set of characters` prev=0/ver=2 @126808745/@241906046).
- Set token: `{kind:O.Set,members:i,matchesSeparator:p.some(([m,g])=>m<=ie&&ie<=g)}` (`ie=47`).
- Compiler `H(e)`: Text→`R0t` (escapes `[.*+?^${}()|[\]\\]`), Separator→`/`, AnyChar→`[^/]`, Star→`[^/]*`, Globstar→`.*`, GlobstarSlash→`(.*/)?`, Set→`[${e.members.replace(/[.^$+{}()|\\]/g,"\\$&")}]`; `qft(e)=\`^${U(e).map(H).join("")}$\``; `xsn(e)=qft(e).slice(0,-1)+"(/.*)?$"`; NFA matcher `Re(e,t)`; `dd(e)=e.includes("*")||e.includes("?")||e.includes("[")||e.includes("]")`.
- The legacy replace-chain (`pF`) survives only for the macOS seatbelt path, now
  wrapped in `mF` try/catch → `{kind:"unreadable",error:s}` (@242793981 region);
  `aae=/\[[^\]]*\*/`, cost cap `dF=4096`.
- The Linux denyRead expansion logs (`[Sandbox Linux] Expanded denyRead glob …`)
  are unchanged — present in BOTH binaries (prev @240248901/240249635, ver
  @242720685–242721629); the fix is entirely inside the glob engine.

### Where the fix lives: the dependency, not app code

npm-pack probe: the new engine ships as
`@anthropic-ai/sandbox-runtime@0.0.80` → `dist/sandbox/glob-pattern.js`
(`/tmp/srt-probe/x0.0.80/package/dist/sandbox/glob-pattern.js`, 229 lines:
`GlobTokenKind`, `setRanges` — docblock: *"Undefined where they spell no set:
there are none, or a range runs backwards (`[user-id]`: `r-i`)"* — `parseGlob`,
`escapeRegexLiteral`, `globTokenToRegex`; `sandbox-utils.js:7` imports it,
`expandGlobPattern` @:1100). Official 2.1.304 bundles ≥0.0.80; 2.1.303 bundles
the pre-AST engine.

### OCC surface — AFFECTED

- `occ/package.json:45` + `bun.lock`: `@anthropic-ai/sandbox-runtime@^0.0.44`
  (resolved 0.0.44), plus
  `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch` (13 lines — only the
  socat EXIT-trap rc-preservation fix in `linux-sandbox-utils.js`
  `buildSandboxCommand`; nothing glob-related).
- `occ/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js`:
  old `globToRegex` @:365–382 (same replace-chain), `expandGlobPattern` @:392
  with **unguarded `const regex = new RegExp(globToRegex(normalizedPattern));`
  @:409** — the try/catch starts after it and wraps only `readdirSync`. Same
  crash path as official 2.1.303 → OCC has the bug.
- `occ/src/utils/sandbox/sandbox-adapter.ts` imports the dep @:17,:22; denyRead
  rules built @:534,:743,:751–752,:827 — any user denyRead glob containing a
  literal `[a-z]`-style invalid range (e.g. `[user-id]`, very common in
  Windows-style paths or bracketed tags) breaks Linux sandbox start.

### Verdict: PORT. Effort M (dep bump) / S (patch backport).

Two options:
1. **Dep bump** `0.0.44 → ^0.0.80`: gets `glob-pattern.js` as shipped; requires
   re-applying/reworking the 13-line socat patch (verify whether ≥0.0.80
   already contains it) and an API-drift pass over `sandbox-adapter.ts`
   (0.0.44→0.0.80 spans 36 patch releases; check exported surface used at
   :17/:22).
2. **Minimal patch backport** (lowest risk): extend the existing bun patch —
   port `setRanges`-style validation into 0.0.44's `globToRegex`/
   `expandGlobPattern`: escape any bracket group that does not parse as a valid
   set (empty or backwards range → treat `[`/`]` as literals), and move the
   `new RegExp(...)` at sandbox-utils.js:409 inside the try/catch so an invalid
   pattern degrades to "unreadable/skip + warn" instead of throwing at sandbox
   start. Mirrors official semantics (brackets-are-text + SRT_DEBUG warn).

---

## Item #35 — Bash/PowerShell deleting large output file when copy to tool-results fails

Changelog: *"Fixed Bash and PowerShell deleting a large output file when copying
it to the tool-results folder fails, unless the disk or quota is full."*

### String evidence

| String | prev | ver |
|---|---|---|
| `copyFailed` | 0 | 4 |
| `Could not copy ` | 0 | 2 |
| `to the session's tool-results folder` | 0 | 2 |
| `Deleting it because the disk or quota is full` | 0 | 2 |
| `Could not delete the output file` | 2 | 2 (pre-existing) |

### Official mechanism

prev tracker `hyr` @246617539 — `track` + `Symbol.asyncDispose` (unconditional
delete of the tracked temp output file) only; prev Bash call site @247497930
`await using Xe=hyr(s.taskRegistry)`; prev copy block @247502891
`if(ze.outputFilePath&&ze.outputTaskId)try{...}catch{}` — **copy failure silently
swallowed, dispose deletes anyway → the large output is lost**.

ver tracker `Cwr` @248509996/248510135 (verbatim):

```js
function Cwr(e){let n;return{track(r){let s=r.outputTaskId,h=s!==void 0&&e.get(s)!==void 0;if(r.backgroundTaskId===void 0&&(r.outputFileSize??0)>0&&!h)n=r.outputFilePath},copyFailed(r,s){let h=E(r)==="ENOENT"&&s!==void 0?s:r,y=E(h),S=y==="ENOSPC"||y==="EDQUOT";if(h!==void 0&&n!==void 0)t(`Could not copy ${n} to the session's tool-results folder (${d(h)}). ${S?"Deleting it because the disk or quota is full.":"Keeping it."}`);if(!S)n=void 0},async[Symbol.asyncDispose](){if(n===void 0)return;try{await Rin(n)}catch(r){if(E(r)!=="ENOENT")t(`Could not delete the output file ${n}: ${d(r)}`,{level:"error"})}}}}
```

- `copyFailed(err, altErr)`: if the copy error is ENOENT and an alt error exists
  (from the tool-results dir-ensure `TN`), report the alt error instead.
  ENOSPC/EDQUOT → log "Deleting it because the disk or quota is full." and KEEP
  `n` (dispose will delete — no point keeping data on a full disk). Any other
  failure → log "Keeping it." and `n=void 0` (dispose skips deletion).
- Bash call site ver @250182398 `await using Ve=Cwr(s.taskRegistry)`; copy block
  @250187893 ends with `if(To===void 0)Ve.copyFailed(Br,Ur)` (`To`=persisted
  dest, `Br`=copy error, `Ur`=dir-ensure error).
- PowerShell call sites ver @261214540/261218273 — same pattern,
  `if(oe===void 0)D.copyFailed(L,k)`.

### OCC surface — structurally immune to the data-loss bug

OCC has no `await using` dispose-deletes tracker at all:
- `src/utils/ShellCommand.ts:332–339`: after exec, if
  `taskOutput.outputFileRedundant` (output fully captured inline) →
  `deleteOutputFile()` immediately; otherwise the temp file is KEPT and
  `result.outputFilePath`/`outputFileSize` are set. There is no post-tool
  disposal that deletes the non-redundant temp file (cleanup happens via
  cross-session startup cleanup — see `src/utils/task/TaskOutput.ts:319–329`
  comment; `deleteOutputFile` @:378–383 only invoked from ShellCommand.ts:335).
- Copy-to-tool-results: `src/tools/BashTool/BashTool.tsx:925–943` —
  stat → `ensureToolResultsDir()` → `getToolResultPath(outputTaskId,false)` →
  truncate >64MB → `link()` falling back to `copyFile()`; outer
  `catch { /* File may already be gone — stdout preview is sufficient */ }`
  (:940–942). PowerShell mirror:
  `src/tools/PowerShellTool/PowerShellTool.tsx:628–646` (same shape, same
  silent catch).

Because OCC never deletes the temp output file after a failed copy, the 2.1.303
data-loss behavior cannot occur. What OCC DOES share with official-303 is the
**silent swallow**: a copy failure (e.g. EACCES on the tool-results dir) leaves
`persistedOutputPath` undefined with zero diagnostics.

### Verdict: N-A (data-loss bug structurally absent). Optional enhancement, effort S.

Optional recipe (diagnostics parity, not behavior-critical):
- In BashTool.tsx:940 and PowerShellTool.tsx:643, replace the bare `catch {}`
  with `catch (err)` + debug log mirroring the official text
  `Could not copy <file> to the session's tool-results folder (<err>). Keeping it.`
  (OCC always keeps it — no dispose delete — so no ENOSPC carve-out is needed;
  if a future OCC adds temp-file disposal, port the full `Cwr` semantics:
  ENOSPC/EDQUOT → still delete, otherwise keep).

---

## Item #34 — PreToolUse hook deny reason replaced by timeout error (SDK callback hook)

Changelog: *"Fixed a PreToolUse hook's deny reason being replaced by a timeout
error when an Agent SDK callback hook on the same tool call timed out."*

### String evidence

| String | prev | ver |
|---|---|---|
| `deniedBefore` | **0** | **6** (@124951040, 246047351, 248822742, 248822875, 249269381, 249269400) |
| `PreToolUse hook timed out (per-hook abort)` | 2 | 2 (pre-existing) |
| `PreToolUse hook cancelled (control stream closed)` | 2 | 2 (pre-existing) |
| `tengu_sdk_hook_callback_timeout` | 6 | 6 (pre-existing) |
| stop-reason constants (`PreToolUse hook did not respond before its timeout …` / `PreToolUse hook failed with an unexpected error. …`) | prev `NTr`/`Ugn` @245535736 | ver `zVr`/`IMn` @249256277/249256447 — **texts identical** |

### Official 2.1.303 (prev) failure mode

prev aggregator `j7(e,n)` (@244957950–244958300, anchor `soleAsk` @244958249), verbatim:

```js
async function j7(e,n){let r=[],s=[],h=await Wtn(async function*(){for await(let S of e){if(S.permissionBehavior==="ask")s.push(S);yield S}}(),n,(S)=>{r.push(S)}),y=s.length===1?s[0]:void 0;return{result:h,yields:r,...y&&{soleAsk:y}}}
```

No try/catch: when the SDK callback hook on the same stream throws (per-hook
abort timeout), the throw propagates through the `Wtn` fold mid-iteration — the
partially aggregated `deny` reason is discarded. prev core chain member `Gtn`
takes no recorder; prev pipeline `Gdn` (@245183100–245183600) does
`{core:Q,runs:_e}=xQo(s,V)` then a bare `ke=await SOo(...)` with no catch; prev
outer generator catch (@245548600–245550200) yields
`{type:"stop",stopReason:Te??NTr}` (timeout) / `Te??Ugn` (generic) — the bare
constant, deny reason gone. (`Q`-re-yield protection existed but only covers
denies that had already been YIELDED as hookPermissionResult, not denies folded
inside the aborted aggregation.)

### Official 2.1.304 (ver) fix — `deniedBefore` tracker, 5 change sites

1. **Aggregator `j8(e,n,r)`** (ver @246045850–246046250) — NEW 3rd param
   (recorder) + in-generator catch so the fold completes:
   ```js
   async function j8(e,n,r){let s=[],h=[],y=[],S=await YLt(async function*(){try{for await(let H of e){if(H.permissionBehavior==="ask")h.push(H);yield H}}catch(H){y.push(H)}}(),n,(H)=>{s.push(H)});if(y.length>0){if(typeof S.deny==="string")r?.({thrown:y[0],deny:S.deny});throw y[0]}let w=h.length===1?h[0]:void 0;return{result:S,yields:s,...w&&{soleAsk:w}}}
   ```
2. **Core chain member `XLt(e,n,r,s)`** (ver @246046190) — NEW 4th param;
   resets the recorder each run and threads it into `j8`:
   ```js
   var XLt=(e,n,r,s)=>({name:"core",isCore:!0,budgetMs:0,async run(h){let y=Lle(h);s(void 0);let S=await j8(e(y,{managedHooksExcluded:n(y)}),h.tool,s);return r.keep(y,S),S.result}})
   ```
3. **`UEo(e,n)`** (ver @246047250–246047450) — exposes the lookup keyed on
   error identity:
   ```js
   function UEo(e,n){let r=oGe(),s;return{core:XLt(e,n,r,(y)=>{s=y}),runs:r,deniedBefore:(y)=>s!==void 0&&typeof y==="object"&&y!==null&&s.thrown===y?s.deny:void 0}}
   ```
4. **Pipeline `jTn({...,failure:S})`** (ver @248822400–248823100; caller passes
   `failure:H` @248826333 region) — records on the shared failure tracker and
   rethrows:
   ```js
   {core:_e,runs:ke,deniedBefore:be}=UEo(s,J),we=await sNo(w,[K,...ED("classic.PreToolUse",h),_e],{signal:r,origin:xee(h)}).catch((lt)=>{if(S!==void 0)S.deniedBefore=be(lt);throw lt})
   ```
5. **Outer PreToolUse generator catch** (ver @249269330–249269950, anchors
   `deniedBefore` @249269381/249269400):
   ```js
   }catch(Ie){let $e=xe.deniedBefore?`${xe.deniedBefore}\n\n`:"";if(Ke(Ie))if(e.abortController.signal.aborted)t("PreToolUse hook cancelled (parent abort)");else if(Ie instanceof Cd)t("PreToolUse hook cancelled (control stream closed)");else{if(t("PreToolUse hook timed out (per-hook abort)"),i("tengu_sdk_hook_callback_timeout",{hookEvent:b("PreToolUse"),toolName:Hn(n.name)}),J)yield{type:"hookPermissionResult",hookPermissionResult:J};else{if(V)yield{type:"defer",hookName:V};yield{type:"stop",stopReason:Ee??$e+zVr}}return}else{...yield{type:"stop",stopReason:Ee??$e+IMn}}...
   ```
   i.e. the previously-issued deny reason is PREPENDED (`\n\n`-joined) to the
   timeout/generic stopReason instead of being replaced by it. If a full deny
   result `J` exists, it is re-yielded unchanged (deny wins outright).

### OCC surface — same symptom, different mechanism

- OCC already swallows per-hook callback timeouts (2.1.210 #9 port,
  `src/utils/hooks.ts:3672–3727`): the timeout never throws through aggregation;
  it is converted to a `blockingError` HookResult
  (`${hookName} callback hook timed out; swallowed rejection: …` via
  `hookCallbackTimeoutMessage`, + `tengu_sdk_hook_callback_timeout` @:3707).
  So OCC does NOT have the official fold-abort loss path.
- BUT the user-visible symptom still occurs by last-wins overwrite:
  - `src/utils/hooks.ts:3441` `executeHooks` merges per-hook generators
    (`mergeHookGeneratorsWithPromptAgentCap` @~:4571) and yields each result
    separately — a fast deny (reason R) is yielded early; the callback-timeout
    `blockingError` is yielded ~60 s later.
  - `src/services/tools/toolHooks.ts:668–681`: every `result.blockingError`
    becomes a `hookPermissionResult` **deny** whose message is the timeout text
    (`getPreToolHookBlockingMessage`); the hook's own deny is yielded separately
    at :709–731.
  - `src/services/tools/toolExecution.ts:954–955`: consumer is last-wins —
    `case 'hookPermissionResult': hookPermissionResult = result.hookPermissionResult`
    with no early break on deny; final decision uses
    `hookPermissionResult?.behavior==='deny'` (toolHooks.ts:413–415).
    → the timeout deny **overwrites reason R**: exactly the changelog symptom.
  - Outer dispatch-failure catch `toolHooks.ts:849–863` yields the bare
    `PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE` (`src/utils/hooks.ts:209–210`, text
    byte-identical to official `NTr`/`zVr`) with no deny preservation — the
    prev-style bare-constant path.

### Verdict: PORT (adapted). Effort M.

Recipe (OCC-shaped equivalent of the official `deniedBefore` mechanism):
1. In `runPreToolUseHooks` (toolHooks.ts:572+), track the last deny-reason
   produced in this run (both from `permissionBehavior==='deny'` results and
   from yielded `hookPermissionResult` denies) — the `J`/`deniedBefore` analog.
2. Mark callback-timeout blockingErrors at the source: in hooks.ts:3712–3725
   add e.g. `callbackTimeout: true` to the yielded `blockingError` result (or a
   sibling field on AggregatedHookResult, hooks.ts:673).
3. In toolHooks.ts's `result.blockingError` branch (:668–681): when
   `callbackTimeout` and a prior deny reason R exists → do not overwrite; either
   skip the second deny yield (official `J`-re-yield semantics: deny wins
   outright) or yield message `` `${R}\n\n${timeoutText}` `` (official
   `$e+zVr` prepend semantics). Prefer the prepend form for parity.
4. In the outer catch (:849–863): prepend the tracked deny reason to
   `PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE` the same way (covers the throw path).
5. Tests: hook A deny + hook B callback timeout (fake timers) → final
   `PermissionResult.message` contains A's reason (and, for the prepend form,
   the timeout text after a blank line); assert
   `tengu_sdk_hook_callback_timeout` still fires once.

---

## Item #32 — interrupt not ending a Read waiting on an idle pipe/device named like an image

Changelog: *"Fixed an interrupt not ending a Read waiting on an idle pipe or
device named like an image."*

### String evidence

`is a pipe or a device`: prev=2 (@124469533, @246703214), ver=2 (@125533553,
@248596271) — the message pre-exists (2.1.302 chunked reader); the fix is the
signal threading, verified structurally:
- `pdfRenderSignal??`: prev=2 (PDF render paths only, @246693575/@246696671),
  **ver=3** — the NEW third occurrence @248585955 is the image-branch call site.

### prev (2.1.303) — no abort plumbing (@246701900–246703600, verbatim)

```js
var cB=S_o,zXr=65536;async function qXr(e,n){if(typeof e!=="string"){if(n===void 0)return oOn(e.handle,e.ioPath);let s=await e.handle.stat();return s.isFile()?(await ik(e.handle,n,s.size)).bytes:Buffer.alloc(0)}if(n!==void 0)return se().readFileBytes(e,n);await using r=await SXr(e,kXr.O_RDONLY|Es);return await oOn(r,e)}async function oOn(e,n){let r=await e.stat();if(r.isFile()){...}let s=[],h=Buffer.alloc(0),y=0,S=0;while(S<=cB){if(y===h.length)h=Buffer.allocUnsafe(Math.min(Math.max(S,zXr),cB+1-S)),s.push(h),y=0;let{bytesRead:w}=await e.read(h,y,h.length-y,null);if(w===0)break;y+=w,S+=w}if(S>cB)throw new x(`Cannot read this as an image: ${n} is a pipe or a device, ...`,"Image stream over the read limit");return Buffer.concat(s,S)}
```

and the Read-tool image branch call site (prev @246692838): `Mfo(await Se(),K,void 0,Re,…,…)` — 6 args, no signal; `Mfo` signature `async function Mfo(e,n=…,r,s,h=…,y=!0)` — 6 params. `await e.read(...)` on an idle FIFO blocks forever; Esc has no way in.

### ver (2.1.304) — signal threaded (@248595300–248596600, verbatim)

```js
var JB=$wo,gAr=65536;async function kAr(e,n,r){if(typeof e!=="string"){if(n===void 0)return Mbn(e.handle,e.ioPath,r);let h=await e.handle.stat();return h.isFile()?(await Sk(e.handle,n,h.size)).bytes:Buffer.alloc(0)}if(n!==void 0)return ie().readFileBytes(e,n);await using s=await Ixr(e,wxr.O_RDONLY|Is);return await Mbn(s,e,void 0)}async function Mbn(e,n,r){let s=await e.stat();if(s.isFile()){...}let h=[],y=Buffer.alloc(0),S=0,w=0;while(w<=JB){if(r?.aborted)throw new Ye;if(S===y.length)y=Buffer.allocUnsafe(Math.min(Math.max(w,gAr),JB+1-w)),h.push(y),S=0;let H=e.read(y,S,y.length-S,null),{bytesRead:K}=await(r===void 0?H:$i(H,r,()=>new Ye));if(K===0)break;S+=K,w+=K}if(w>JB)throw new x(...);return Buffer.concat(h,w)}
```

- Two abort paths: (a) between chunks — `if(r?.aborted)throw new Ye`; (b) DURING
  a pending read — `$i(H,r,()=>new Ye)` promise-race. `Ye` = official
  AbortError; `$i` is the pre-existing abort-race helper (structural string
  `if(r.aborted)throw o(),e()`: prev=1 @233788165, ver=1 @236274896; ver def
  @236274849):
  ```js
  function $i(t,r,e){let o=()=>{t.catch(()=>{})};if(r.aborted)throw o(),e();let n=()=>{};try{return await Promise.race([t,new Promise((m,i)=>{n=()=>i(e()),r.addEventListener("abort",n,{once:!0})})])}catch(m){throw o(),m}finally{r.removeEventListener("abort",n)}}
  ```
- `q_o` (ver @248596440) gains the 7th param `S`: `async function q_o(e,n=…,r,s,h=…,y=!0,S){…H=await kAr(e,r,S)…}`.
- Read-tool image branch call site (ver @248585789, signal @248585955):
  `q_o(await be(),K,void 0,xe, …, _e.pdfRenderSignal??_e.signal)` — passes the
  tool-context abort signal (PDF-render child signal takes precedence).
- The file-watch compression call site (ver @248745435) still passes 4 args
  (no signal) — background path intentionally unthreaded.
- Note: the plain string-path branch (`Mbn(s,e,void 0)`) is NOT threaded — the
  fix targets the handle-based path used by the Read tool.

### OCC surface — AFFECTED

OCC ported the 2.1.302 chunked reader (CC 2.1.302 #06) without the 2.1.304
signal fix:
- `src/tools/FileReadTool/imageRead.ts:117–151` `readNonRegularCapped` — loop
  `while (total <= maxBytes) { … await handle.read(current, currentOffset, …) }`
  with **no abort check and no race** (:126–143);
  `readImageBytesFromHandle` :158–174 and `readImageBytesCapped` :207–220 take
  no signal param.
- `src/tools/FileReadTool/FileReadTool.ts:1873–1885`
  `readImageWithTokenBudget(filePath, maxTokens, maxBytes?)` — no signal param;
  image-branch call site :1329 `await readImageWithTokenBudget(resolvedFilePath, maxTokens)`
  with `context` in scope (:1330 uses it) — `context.abortController.signal` is
  available; the PDF branch already derives per-read child signals
  (`createCombinedAbortSignal` :1365–1371, :1514–1518).
- Second caller: `src/utils/attachments.ts:2676`
  `readImageWithTokenBudget(normalizedPath)` (attachment path — no tool
  context; keep unthreaded like the official watch-compression site).
- Available primitives: `AbortError` class + `isAbortError`
  (`src/utils/errors.ts:12,:27`), `createCombinedAbortSignal`
  (`src/utils/combinedAbortSignal.ts:15`).

An idle FIFO named `foo.png` read via OCC Read blocks in `handle.read` forever;
Esc/interrupt cannot break it — same bug as official 2.1.303.

### Verdict: PORT. Effort S.

Recipe:
1. `imageRead.ts`: add optional `signal?: AbortSignal` to
   `readNonRegularCapped`, `readImageBytesFromHandle`, `readImageBytesCapped`.
   In the chunk loop: top-of-iteration `if (signal?.aborted) throw new AbortError()`;
   wrap each read in an abort race mirroring official `$i` — either add a small
   local `raceAbort(promise, signal, makeError)` helper (faithful port of
   `$i` @236274849: pre-aborted → throw + swallow source rejection; listener
   `{once:true}`; `finally` removeEventListener; attach a no-op `.catch` to the
   losing read promise to avoid unhandled rejection) or reuse an existing util
   if one lands. `signal === undefined` → plain await (official
   `r===void 0?H:$i(...)` shape), preserving the attachments/watch path.
2. `FileReadTool.ts`: thread the signal —
   `readImageWithTokenBudget(filePath, maxTokens, maxBytes?, signal?)` →
   `readImageBytesCapped(filePath, cap, signal)`; at :1329 pass
   `context.abortController.signal` (official passes
   `pdfRenderSignal ?? signal`; OCC's image branch has no pdfRenderSignal —
   plain `context.abortController.signal` is the faithful equivalent).
   Leave `attachments.ts:2676` unthreaded (matches official background path).
3. Tests (extend `__tests__/imageReadCap302.test.ts`): fake idle handle whose
   `read` never resolves → pre-aborted signal throws immediately; abort
   mid-read rejects with AbortError and the pending read's later rejection is
   swallowed; no-signal path unchanged.

---

## Cross-cluster notes

1. **Env allowlist** (relates to R6 env-var cluster): ver @240663587 adds
   `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` to the same allowlist block
   that already holds the other dangerous-rm kill-flags — OCC's counterpart
   surface is `src/utils/managedEnv.ts`.
2. **`await using` / explicit-resource-management**: official #35 machinery
   relies on `Symbol.asyncDispose` trackers around shell exec. OCC's
   ShellCommand/TaskOutput lifecycle diverges (delete-only-when-redundant +
   startup cleanup). Any future OCC work that adds dispose-time deletion of
   temp output files must port the full `Cwr` semantics (copyFailed +
   ENOSPC/EDQUOT carve-out), not the 2.1.303 `hyr` semantics.
3. **srt dep bump coordination** (with R6/R4): bumping
   `@anthropic-ai/sandbox-runtime` 0.0.44→0.0.80 for #9 may also deliver other
   sandbox fixes bundled in 2.1.304; check the R1/R6 reports for overlapping
   sandbox-runtime surface before choosing bump-vs-patch.
4. **deniedBefore pattern**: the official fix pattern (identity-keyed
   `{thrown, deny}` recorder threaded aggregator → chain member → pipeline →
   outer catch) is reusable for any OCC aggregator that folds streamed results
   while a participant can still throw; if OCC ever reverts the 2.1.210
   timeout-swallow, this is the structure to adopt.
5. **Abort-race helper**: official `$i` (pre-existing in both binaries) is the
   canonical shape for racing a pending I/O promise against an AbortSignal with
   rejection-swallowing; worth extracting as a shared OCC util when porting #32
   (candidate consumers: image read, any future pipe/device reads).
