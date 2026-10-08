# Cluster C remainder + Cluster H final verdicts (official 2.1.292 carry-over)

Date: 2026-10-09 · Binary: `/tmp/cc-diff-293/vprev/package/claude` (2.1.292, 251,456,696 B) ·
293 cross-check: `/tmp/cc-diff-293/vver/package/claude` · OCC: main @5a3299f, package version 2.1.374,
CHANGELOG tracks 2.1.292 (OCC-149 landed exactly 6 fixes).

Extraction convention: all official code below is verbatim from the 2.1.292 binary's **second embedded
JS region (~203–238 MB)**; byte offsets are `LC_ALL=C /bin/grep -aboF` hits against the raw ELF.
Minified names are chunk-local and DO collide (e.g. `function pH(` ×8, `$s` ×10) — every def below was
disambiguated by its wiring call-site.

**2.1.293 unchanged-area proof** (all phrases re-grepped in the vver binary; every one present in both
embedded regions, string-diff counts equal in `new_strings.txt`/`removed_strings.txt` → region-shift
noise only, no content change):

| Area | Phrase | 292 offset | 293 offset |
|---|---|---|---|
| C1 | `This is not a "no matches" result.` | 208892821 | 209748950 |
| C1 | `/proc/self/fd/3` | 208892228 | 209748357 |
| C1 | `RipgrepTargetUnreadableError` | 208892910 | 209749039 |
| C3 | `Its contents were not attached because the file is too large` | 215812492 | 216788273 |
| C4 | ``system-reminder\b)/gi,"&lt;"`` (ont/Ens escapers) | 207408010 ff | 208247035/208247114 |
| C4 | `hook stopped continuation:` | 215820588 area | 216796101 |
| C5 | `drop_command_create` | 212185901 | 213148165 |
| C5 | `web_fetch_pdf_extract_text` | 213350278 | 214305778 |
| C5 | ``was read as `file_path` `` | 212215598 | 213147760 |
| C6 | `names must be at most` | 213518427/213521927 | 214475839 ff |
| C6 | `Frontmatter "name" of` | 207586013 | 208425506 |
| C10 | `Instruction file not loaded` | 212092739 | 213063318 |
| C10 | `withheld_memory` | 212092433 ff | 213063771 ff |
| C10 | `unjudged` | 212091637/212098608 | 98659712 ff |
| L26 | `Skipping compact-pair upload` | 215949833 area | 216925778 |
| L26 | `foreignToBridgeSession` | 215947xxx | 216922889/216983986 |
| L28 | `deliverWithoutCancel` | 233601440/233752504 | 234772005/234923299 |
| L28 | `tengu_velvet_panda` | 213635246 area | 214600349 |
| L28 | `[low-latency-submit]` | 231505xxx | 232666379 |
| L69 | `continue with alternatives (web search` | 222800189 | 223796630 |

⇒ Every port plan below targets code that is identical in 2.1.293.

---

## C1 — RipgrepTargetUnreadableError (Grep/Glob unreadable target) — **UNLANDED → PORT**

### OCC status (UNLANDED)

- `src/utils/ripgrep.ts:777-781` — exit code 1 → `resolve([])` (silent "no matches").
- `src/utils/ripgrep.ts:901-910` — empty stdout → silent empty resolve (the exact hole zB fills).
- `src/utils/ripgrep.ts:807-820` — only EAGAIN → `-j 1` retry (matches official step 1, but without `inheritFd` pass-through).
- `src/utils/ripgrep.ts:280-328` — `RipgrepSpawnResourceError` exists (EAGAIN/ENOMEM/EMFILE/ENFILE map, spawn-syscall gate) ≈ official `uf`.
- `src/utils/ripgrep.ts:460-466/:484-489` — stderr discarded on exit 0/1 (official keeps stderr `w` for the zB/XB dispatch).
- `src/utils/ripgrep.ts:595-605/:612-621/:650/:700` — spawn has no 4th stdio slot / no `inheritFd` option.
- `src/utils/ripgrep.ts:333-335` — `RipGrepOptions` lacks `inheritFd`.
- `src/tools/GrepTool/GrepTool.ts:610-612` — `rejectOnInputError:true` present (good — official gates zB/XB on this same option).
- `src/tools/GrepTool/GrepTool.ts:292-308` — validateInput only handles ENOENT; `:399-403` 'No files found'; `:360/:376` 'No matches found'.
- `src/utils/glob.ts:119` — no options arg (no rejectOnInputError/inheritFd lane).
- `src/utils/searchTargetGate.ts:26-31/:157-186` — 2.1.251 pre-spawn gate, root-only; header already documents the fd-pinning lane as STAGED (occ109 §4b).
- `src/utils/errors.ts:186-195` — `isFsInaccessible` exists but unused by ripgrep/glob.

### Official verbatim (2.1.292)

**Error class + errno map** @208890800–208893200 (phrase hit 208892821):

```js
var GB="Do not run a recursive search in the shell instead (for example grep -r, find or rg)",oir="/proc/self/fd/3";
class zB extends P{constructor(e){let r=O()==="windows",n=r?e===Ite:e===Tte||e===vte,
 s=n?"permission denied":!r&&e===_te?"input/output error":!r&&e===QB?"the file Claude Code opened was not passed to ripgrep":"an operating system error",
 h=n?`Tell the user that the path could not be read. ${GB}.`
   :`Run the search once more. If it fails again, tell the user that the search is failing. ${GB}: it can also reach other files, which this tool is set to leave out.`;
 super(`Search failed: ripgrep could not read the path it was given (${s}, os error ${e}), so nothing was searched. This is not a "no matches" result. ${h}`,
  "ripgrep could not read its target");
 this.name="RipgrepTargetUnreadableError"}}
var vte=1,QB=2,_te=5,Tte=13,wte=20,Cte=2,Ate=3,Ite=5;
```

errno constants: EPERM=1(`vte`), ENOENT=2(`QB`), EIO=5(`_te`), EACCES=13(`Tte`), ENOTDIR=20(`wte`);
windows: ERROR_FILE_NOT_FOUND=2(`Cte`), ERROR_PATH_NOT_FOUND=3(`Ate`), ERROR_ACCESS_DENIED=5(`Ite`).
"permission denied" class = windows `e===5` or posix `e===13||e===1`. `e===2` on posix renders
"the file Claude Code opened was not passed to ripgrep" (fd-pinning lane failure). Note the
**retry-once is model-level**: the non-permission arm's text instructs `Run the search once more.`

**Throw site** (ripgrep collector error dispatch) @208906460 (context 208905300–208907900):

```js
if(s?.rejectOnInputError&&S.code===2&&ee.every((le)=>le.endsWith('"type":"summary"}'))&&w.startsWith(`rg: ${r}: `)&&!w.trimEnd().includes(`\n`)){
  let le=Number(/\(os error (\d+)\)\s*$/.exec(w)?.[1]),
      he=r!==oir&&(O()==="windows"?[Cte,Ate]:[QB,wte]).includes(le);
  if(!Number.isNaN(le)&&!he){g(new zB(le));return}}
```

i.e. exit 2 + all stdout lines are `--json` summary lines + single-line stderr starting `rg: <target>: `
+ trailing `(os error N)` → `new zB(N)`, EXCEPT bare ENOENT/ENOTDIR when the target is not the fd-3
pin (those stay "no matches"/existence-check territory). Full dispatch order in the same callback:
EAGAIN→`-j 1` retry (passes `s?.inheritFd` again) → `XB` RipgrepUsageError (code 2, no stdout,
`xte=/^rg: (?:regex parse error|error parsing glob|unrecognized file type|error parsing flag|compiled regex exceeds size limit)/m`)
→ `zB` → stdinSourceFailed → `uf.from(S,rejectOnInputError,"emitted")` → MAXBUFFER→`JB`
RipgrepOutputTooLargeError(stdout|stderr) → SIGTERM/SIGKILL→`rir` RipgrepTimeoutError
(`Ripgrep search timed out after ${wsl?60:20} seconds. ...`) or abort → else resolve collected lines
(`ee.slice(0,-1)` drops a torn last line when killed/maxbuffered).

**fd-3 pinning lane**: resolver @208898000 area (in c1-wide extract, file offsets 10100–10900):

```js
return{lexical:e,canonical:M,spawnCwd:Pl(M,mX().rgPath),target:G?oir:M,inheritFd:G?H.fd:void 0,
       relativeOutput:!1,isDirectory:!1,recheckBeforeSpawn:ee,recheckByPath:J,close:()=>H.close()}
```

`G` = pin decision (file target, linux/wsl lane; the `rbt` /proc/self/fd opener uses
`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`), `H` = the held-open handle. Spawn side @208901200 area:

```js
let te=wS(S,G,{...w&&{argv0:w},...E!==void 0&&{stdio:["pipe","pipe","pipe",E]},cwd:I,signal:n,windowsHide:!0,...cl("helper")});
```

Timeout `O()==="wsl"?60000:20000`, env override `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS`, SIGTERM→5 s→SIGKILL.
`AQo` maps `/proc/self/fd/3`-prefixed output paths back to the lexical target. Glob shares the same
spawn/collector (same region), so zB covers Grep **and** Glob.

### TDD port plan

1. **RED** `src/utils/__tests__/ripgrepUnreadable292.test.ts`: fake rg exit-2 fixture with summary-only
   stdout + `rg: /x: /x: Permission denied (os error 13)` stderr and `rejectOnInputError:true` → expect
   `RipgrepTargetUnreadableError` whose message contains, verbatim: `(permission denied, os error 13)`,
   `This is not a "no matches" result.`, `Tell the user that the path could not be read. Do not run a
   recursive search in the shell instead (for example grep -r, find or rg).`; errno 5 → `input/output
   error` + the "Run the search once more…" arm; ENOENT(2)/ENOTDIR(20) without fd-pin → NOT zB;
   windows errno 5/2/3 mapping per constants above.
2. **GREEN** ripgrep.ts: keep stderr on exit 1/2 (extend :460-489 collectors), add the zB class +
   errno constants + the exact dispatch branch into `safeHandleResult` (:901-910 replaces the silent
   empty resolve; keep the existing EAGAIN retry and add the XB/JB/rir order as extracted).
3. GrepTool: surface zB through `rejectOnInputError` path unchanged (option already true at :610);
   Glob: thread an options arg through `glob.ts:119` so glob gets the same dispatch.
4. **fd-3 lane (STAGED, separate PR)**: `inheritFd` in `RipGrepOptions` + `stdio:["pipe","pipe","pipe",fd]`
   spawn + resolver pin + `AQo` path unmapping + `searchTargetGate` integration. zB's `e===2` message
   arm and the `r!==oir` exemption only make sense once this lane exists — land error taxonomy first,
   pinning second (matches official gating: `G` is flag/platform-conditional).
5. E2E: `occ -p` with a `chmod 000` dir target → assistant must report failure (not "no matches");
   transcript shows the error text.

---

## C3 — 256KB attachment too-large (@-mention) — **PARTIAL (landed: producer pre-check + both render arms; unlanded: onTooLarge plumbing, guard trio, displayPath, unexamined producers) → PORT (residual)**

### OCC status (PARTIAL — this is the OCC-149 landed item, verify result)

LANDED:
- Type: `src/utils/attachments.ts:344-358` `AtMentionReferenceAttachment` with `unread?:'too_large'|'unexamined'`, `fileSize?`.
- Producer: `attachments.ts:3350-3380` — `mode==='at-mention' && !isFileWithinReadSizeLimit` → stat →
  `tengu_attachment_file_too_large` → too_large arm (pre-check style; official detects via `onTooLarge`
  callback fired from inside the file resolver).
- Model arm: `src/utils/messages.ts:4238-4271` — three-way `switch (attachment.unread)` texts match official.
- UI arm: `src/components/AttachmentMessage.tsx:161-176`.
- Test: `src/utils/__tests__/atMentionReference292.test.ts`.

UNLANDED residuals:
- `onTooLarge` callback plumbing — 0 hits in src/.
- Official producer guard trio `ext!=="" && !aHe(path) && !v$(path)` — OCC only excludes PDF
  (`isPDFExtension`); no extensionless exclusion, no image exclusion (`aHe` = image-extension set),
  no plan-file exclusion (`v$`).
- `displayPath` field on the attachment (official `displayPath:Yk(oe(),ln.path)`).
- `'unexamined'` arm has **zero producers** in OCC (official: `landing_unsettled` / `listing_unsettled`
  case-sensitivity probes).
- sizeProbe lane (official `H` branch, `BMe` handle-based probe) — absent in OCC.

### Official verbatim (2.1.292)

**Resolver-side onTooLarge** @215067400–215069200 (hits 215067796/215068427):

```js
if(!H&&g==="at-mention"&&!await NNn(e,kj().maxSizeBytes)){let ke=AI(e).ext.toLowerCase();
 if(!B2e(ke))try{let be=await se().stat(e);
  return i("tengu_attachment_file_too_large",{size_bytes:be.size,mode:d(g)}),h?.onTooLarge?.(be.size),null}catch{}}
...
if(Y=ke?.modified,ke!==void 0&&ke.size>kj().maxSizeBytes&&!B2e(AI(e).ext.toLowerCase()))
 return i("tengu_attachment_file_too_large",{size_bytes:ke.size,mode:d(g)}),h?.onTooLarge?.(ke.size),null;
```

(`B2e` = PDF ext; `kj().maxSizeBytes` = the 256KB read-size cap; resolver returns null and records the size.)

**Consumer-side attachment build** @215048836 (in c3-attachments extract):

```js
onTooLarge:(zn)=>{Ht.push({path:In,fileSize:zn})}
...
let ln=Ht.at(-1);
if(!nn&&!Nt&&ln!==void 0&&AI(ln.path).ext!==""&&!aHe(ln.path)&&!v$(ln.path))
 return p("input_file_at_mention","too_large"),
  {type:"at_mention_reference",mentions:[ln.path],unread:"too_large",fileSize:ln.fileSize,displayPath:Yk(oe(),ln.path)};
```

`aHe` @211428380: `function aHe(e){let r=e.slice(e.lastIndexOf(".")).toLowerCase();return Y.has(r)}`
(image-ext set `Y`; sits beside the Bun.Image helpers). `v$` = plan-file predicate (same fn used by
Write's `RTt(e){return v$(e.replace(/[. ]+$/,""))}` "Updated plan" check @212185428 region).

**unexamined producers** @215046940/215047358:

```js
if(Ue===void 0&&!Ne)return m("input_file_at_mention","landing_unsettled"),{type:"at_mention_reference",mentions:[he],unread:"unexamined"};
...
if(Yn===void 0)return m("input_dir_at_mention","listing_unsettled"),{type:"at_mention_reference",mentions:[he],unread:"unexamined"};
```

**Model renderer** (three-way arm) @215809500 region — too_large text:

```
`${n} (${en(e.fileSize)}). Its contents were not attached because the file is too large to read all at once, and a ${ct} call with no limit parameter will fail. Read it in portions with the offset and limit parameters, starting with a few hundred lines, or search for specific content instead of reading the whole file.`
```

(OCC messages.ts:4238-4271 already matches this text; 293 phrase check ✓.)

### TDD port plan (residual only)

1. **RED**: producer test — extensionless >256KB file @-mentioned → NO too_large reference (official
   `ext!==""` guard); image ext >256KB → no reference; plan file → no reference; attachment carries
   `displayPath`.
2. **GREEN** attachments.ts: add the three guards + `displayPath` to the :3350-3380 arm. Keep OCC's
   pre-check producer shape (functionally equivalent to onTooLarge for the non-sizeProbe lane);
   adopting the literal `onTooLarge` callback is OPTIONAL — only needed if/when the sizeProbe lane is ported.
3. `unexamined` producers depend on the case-spelling probe (`Mun`/landing logic) which OCC lacks —
   mark as STAGED with the rest of the case-insensitive-FS landing work; do not fake producers.
4. E2E: 300KB `.txt` @-mention → notice rendered; 300KB extensionless file → normal (skipped) behavior.

---

## C4 — hook-output system-reminder escaping — **UNLANDED → PORT**

### OCC status (UNLANDED)

- `src/utils/messages.ts:3712-3714` — `wrapInSystemReminder` = bare `` `<system-reminder>\n${content}\n</system-reminder>` `` (no escaper).
- Injection points (all bare interpolation): `messages.ts:4764-4772` hook_blocking_error, `:4773-4790`
  hook_success, `:4791-4803` hook_additional_context, `:4804-4812` hook_stopped_continuation,
  `:4696-4729` async_hook_response (systemMessage :4705-4712, additionalContext :4715-4726, wrapped :4728);
  `src/query.ts:1595-1604` stop-hook additional context; `src/hooks.ts:1242-1247` asyncRewake exit-2,
  `:1261-1266` missing-script; `messages.ts:2019-2038` ensureSystemReminderWrap (applied :2590);
  `hooks.ts:3290-3348` six raw builders consumed at `query/stopHooks.ts:267/452/494`,
  `TaskCreateTool.ts:296`, `TaskUpdateTool.ts:252`.
- Escaper greps all negative: `escapeSystemReminder`, `<`, `endsWith('<')` — 0 hits.

### Official verbatim (2.1.292)

**Escaper family** @207407893–207408400:

```js
function x3t(e){return e.replaceAll(/<\s*\/\s*system-reminder\s*>/gi,"&lt;/system-reminder&gt;")}
function ont(e){return e.replaceAll(/<(?=\s*(?:\/\s*)?system-reminder\b)/gi,"&lt;")}
function Ens(e){return e.replaceAll(/<(?=\s*\/\s*system-reminder\b)/gi,"&lt;")}
function Seo(e){if(e.startsWith(Va)&&e.endsWith(Bs))return e;return`<system-reminder>\n${rnt(x3t(e))}${Bs}`}
```

**AT (two-stage)** @212080879:

```js
function AT(e){return ont(e).replace(/<(?=\s*(?:\/\s*)?$)/,"&lt;")}
```

Stage 1 `ont`: any `<` that could open/close a `system-reminder` tag → `&lt;`. Stage 2: a trailing bare
`<` (followed only by whitespace/`/` at end-of-string) → `&lt;` — it could fuse with the wrapper's
`\n</system-reminder>` into a forged close.

**Ol / Bbe** @215793338/215793388:

```js
function Ol(e){return`${gI}\n${e}\n${MNe}`}   // gI='<system-reminder>', MNe='</system-reminder>'
function Bbe(e){return Ol(AT(e))}
```

**Application sites** (model renderer map `cer` @215809500–215846000):

```js
hook_blocking_error:(e)=>[Re({content:Bbe(`${e.hookName} hook blocking error from command: "${e.blockingError.command}": ${e.blockingError.blockingError}`),isMeta:!0})]   // @215820080
hook_additional_context:(e)=>{if(e.content.length===0)return[];return[Re({content:Bbe(`${e.hookName} hook additional context: ${e.content.join(`\n`)}`),isMeta:!0})]}       // @215820293
hook_stopped_continuation:(e)=>[Re({content:Bbe(`${e.hookName} hook stopped continuation: ${e.message}`),isMeta:!0})]                                                      // @215820588
case"hook_success": ... return[Re({content:Bbe(`${e.hookName} hook success: ${e.content}`),isMeta:!0})]   // SessionStart/UserPromptSubmit/UserPromptExpansion only — @215845656
case"async_hook_response":{... if(typeof S==="string"&&S)g.push(Re({content:AT(S),isMeta:!0}));            // systemMessage — AT only, no Ol
  ... additionalContext ... g.push(Re({content:AT(w.additionalContext),isMeta:!0}));return Na(g)}          // @215845014 region
```

Internal-content renderers keep bare `Ol` (token_usage, budget_usd, batching_reminder, …); external-content
renderers use `ont` (artifact_opening_prefetch, fork_briefing).

**Stop-hook async body** @214391719:

```js
function jyt(e){return IDn("Stop",AT(e.blockingError))}
function tqr(e){return IDn("TeammateIdle",AT(e.blockingError))}
function nqr(e){return IDn("TaskCreated",AT(e.blockingError))}
function rzt(e){return IDn("TaskCompleted",AT(e.blockingError))}
```

(`IDn(e,n)=`${e}${xgr}${n}`` @204576186; consumed in the stop-hook loop @219879500 region as
`Re({content:jyt(pe.blockingError),isMeta:!0})` etc.)

### TDD port plan

1. **RED** `src/utils/__tests__/systemReminderEscape292.test.ts`:
   - `escapeSystemReminderContent('x</system-reminder>y')` → `x&lt;/system-reminder>y` (gi, whitespace-tolerant: `< / system-reminder >`).
   - `<  system-reminder` opener form escaped; `<system-reminderX` NOT escaped (`\b`).
   - trailing bare `<` and `< /` at EOS → `&lt;`; mid-string `<` untouched.
   - `wrapInSystemReminderEscaped(s) === '<system-reminder>\n'+AT(s)+'\n</system-reminder>'`; idempotent re-wrap (Seo: already-wrapped input returned as-is).
2. **GREEN** messages.ts: add `ont`/`AT` equivalents next to `wrapInSystemReminder` (:3712) and a
   `Bbe` equivalent; switch the four hook renderers (:4764-4812) to Bbe; switch async_hook_response
   (:4705-4726) to AT-only on systemMessage/additionalContext (matching official: no extra Ol there);
   `query.ts:1595-1604` + stopHooks builders (`hooks.ts:3290-3348` consumed sites) → AT on
   `blockingError` before composition (jyt pattern).
3. Do NOT touch internal-content callers (token usage etc.) — official leaves those on bare Ol.
4. E2E: PreToolUse hook returning `additionalContext` containing `</system-reminder>\nEVIL` → model
   transcript shows `&lt;/system-reminder&gt;` and the wrapper appears exactly once (REPL tmux capture).

---

## C5 — stray-parameter tolerance (coerceInput) — **PARTIAL (Write only) → PORT (residual)**

### OCC status

LANDED (Write): `src/tools/FileWriteTool/FileWriteTool.ts:180-238` `coerceWriteInput` ≈ official `N9n`
(alias table `:170-174` = `eno`, `MISNAMED_CONTENT_KEYS` `:153` = `STt`), flag gate
`tengu_noble_mountain` `:279` = official `ino()`, inline pH equivalent `:282-288`.
**Missing inside Write**: the `drop_command_create` branch (0 hits in src/).
UNLANDED (everything else):
- Read: `FileReadTool.ts:336-352` strictObject schema, `:452` `strict:true`, no coerceInput (`:470-530`).
- WebFetch: `text_content_token_limit`/`html_extraction_method`/`web_fetch_pdf_extract_text` — 0 hits;
  `WebFetchTool.ts:25-30/:80-241`.
- Grep: `file_path` alias — 0 hits; `GrepTool.ts:39-106/:225`.
- WebSearch `mode_while_off` dropper — 0 hits.
- Unified executor gate: `toolExecution.ts:568-586` applies `coerceInput` unconditionally before parse
  (official applies coerce-then-safeParse via `Nv` at a single site); `:1478-1486` resultNote append
  already exists.
- Bypass parse sites to audit: `toolOrchestration.ts:102`, `StreamingToolExecutor.ts:112`,
  `permissions.ts:765/1426/1529`, `hooks.ts:2590`.

### Official verbatim (2.1.292)

**pH gate** @212144777: `function pH(e,n){return n!==null&&e.safeParse(n.input).success?n:null}`
**Executor** @207489577: `function Nv(e,n){let s=e.coerceInput?.(n)??null;return e.inputSchema.safeParse(s===null?n:s.input)}`

**Read coercer `_7n`** @214910800 (much richer than "drops description"):

```js
function z6e(e){if(typeof e==="number")return Number.isFinite(e)?e:void 0;if(typeof e==="string"&&/^[-+]?\d+$/.test(e.trim()))return Number(e);return}
function _7n(e){if(!L(e))return null;let n={...e},r=[];
 if(Array.isArray(n.offset)&&n.offset.length===1)n.offset=n.offset[0],r.push("offset_array");
 if(Array.isArray(n.limit)&&n.limit.length===1)n.limit=n.limit[0],r.push("limit_array");
 let s=z6e(n.offset);if(s!==void 0&&s<0)delete n.offset,r.push("offset_neg");
 let g=z6e(n.limit);if(g!==void 0&&g<=0)delete n.limit,r.push("limit_dropped");
 if("length"in n){let h=z6e(n.length);if(!("limit"in n)&&h!==void 0&&h>0)n.limit=h;delete n.length,r.push("length")}
 if(Object.hasOwn(n,"description"))delete n.description,r.push("drop_description");
 return r.length?{input:n,shapeClass:r.join(",")}:null}
```

Read wiring @214918706: `coerceInput:_7n` — **direct, no pH, no flag** (silent coercion, shapeClass telemetry only, no resultNote).

**WebFetch dropper `zKt`** @213351378:

```js
var tLo=["text_content_token_limit","html_extraction_method","web_fetch_pdf_extract_text"];
function zKt(e){if(!L(e))return null;let n=tLo.filter((s)=>Object.hasOwn(e,s));if(n.length===0)return null;
 let r={...e};for(let s of n)delete r[s];return{input:r,shapeClass:n.map((s)=>`drop_${s}`).join(",")}}
```

WebFetch wiring @213376925: `coerceInput(e){return pH(T2t(),zKt(e))}`.

**Grep coercer `cEt`** @212215273 (file_path→path + verbatim resultNote):

```js
function cEt(e){if(!L(e)||typeof e.file_path!=="string"||e.file_path==="")return null;
 let{file_path:n,...r}=e,s=!Object.hasOwn(r,"path");
 if(!s&&r.path!==n)return null;
 return{input:s?{...r,path:n}:r,shapeClass:s?"file_path":"repeated_file_path",
  resultNote:`Note: ${qr}'s parameter for where to search is named \`path\`. ${s?"`file_path` was read as `path`.":"`file_path` repeated `path` and was ignored."}`}}
```

Grep wiring @212219127: `coerceInput(e){return pH(fEt(),cEt(e))}`.

**Write `N9n`** @212185428 — OCC-matched except this branch:
`if(n.command==="create")delete n.command,r.push("drop_command_create"),s.push("\`command\` was ignored.");`
Write wiring @212188851: `coerceInput(e){let n=N9n(e);return n!==null&&ino()?pH(wTt(),n):null}` (`ino()`=`T("tengu_noble_mountain",!0)`).

**WebSearch** @219612391: `coerceInput(e){if(Dtt()||!L(e)||!("mode"in e))return null;let{mode:r,...n}=e;return{input:n,shapeClass:"mode_while_off"}}`.

### TDD port plan

1. **RED** per-tool coercion tests (AAA): Read — `{offset:["5"]}`→offset 5 (`offset_array`),
   `{offset:-1}`→dropped (`offset_neg`), `{limit:0}`→dropped (`limit_dropped`), `{length:"10"}`→limit 10
   (`length`), `{description:"x"}`→dropped (`drop_description`), numeric-string coercion via `z6e`
   (`/^[-+]?\d+$/` after trim); Grep — `{file_path:"/x"}`→`{path:"/x"}` + resultNote verbatim above;
   `{file_path:"/x",path:"/x"}`→repeated_file_path note; `{file_path:"/x",path:"/y"}`→null (no coercion,
   normal validation error); WebFetch — each of the 3 stray params dropped with `drop_*` shapeClass;
   WebSearch — `mode` dropped only while feature off (`Dtt()`); Write — add `command:"create"` drop.
2. **GREEN**: add `coerceInput:_7n`-equivalent to FileReadTool (no gate), `pH(schema,zKt)` to WebFetch,
   `pH(schema,cEt)` to Grep, `mode_while_off` dropper to WebSearch, `drop_command_create` branch to
   `coerceWriteInput`. Keep OCC's existing per-tool inline pH (FileWriteTool.ts:282-288) — official pH
   lives inside each tool's coerceInput, NOT in the executor; `toolExecution.ts:568-586` unconditional
   application is fine ONLY because each coercer is self-gated — align by making every new coercer
   return `null` unless the coerced input strict-parses (pH semantics).
3. resultNote: Grep/Write notes append to successful tool results via the existing
   `toolExecution.ts:1478-1486` machinery — assert the note text byte-for-byte.
4. E2E: `occ -p` prompting the model to Read with `description` (or hand-fed tool_use JSON in a
   scripted SDK session) → no validation steer, note appears where official has one.

---

## C6 — 256-char name limits (agent reject / skill+plugin frontmatter ignore) — **UNLANDED (all 3 sites) → PORT**

### OCC status (UNLANDED)

- Loader `src/tools/AgentTool/loadAgentsDir.ts:728` — byte-identical to pre-292 state; only `:` reject
  at `:740-746` (+ `getParseError` mirror `:563-565`). No length branch.
- Schema: no `AgentSchema` (0 hits); `AgentJsonSchema` `:80-110` has no `name` field; record key is
  bare `z.string()` (`AgentsJsonSchema` `:115-117`) — no `.max(256)`.
- Plugin agents `src/utils/plugins/loadPluginAgents.ts:88-89` — filename fallback fires only on falsy
  name, never on over-long; no warning.
- Skills `src/skills/loadSkillsDir.ts:434-435` — frontmatter `name` only as displayName fallback; no
  length ignore/warn. `validatePlugin.ts:678-687` — type check only.
- Negative greps: `256` in AgentTool 0 hits; `names must be at most` 0; `Frontmatter "name"` 0;
  `ignoring it` 4 (all `src/utils/effort.ts:237`, unrelated). Near-miss NOT to confuse:
  `src/commands.ts:418 MAX_SAFE_SKILL_NAME_LENGTH=256` = 2.1.269 E52 display-safety render guard.
- OCC ledger already staged it: `docs/upstream-version-gap-occ149-2026-10.md:210`.

### Official verbatim (2.1.292)

**Shared constant** @207344922: `var n=/[\x00-\x1f\x7f-\x9f  ]/g,iY=256,SPn=/[\x00-\x1f\x7f-\x9f  <>]/;`

**Frontmatter ignorer `M4t`** @207586013:

```js
function M4t(e,n){if(e==null)return;let r=String(e);if(r.length<=iY)return r;
 t(`Frontmatter "name" of ${n} is over ${iY} characters - ignoring it`,{level:"warn"});return}
```

Callers: plugin command @212406681 (`Je=M4t(H.name,\`plugin command ${e}\`)` + namespace-prefix
preservation + filename fallback), plugin agent `eYt` @213476707:
`he=M4t(G.name,\`plugin agent ${e}\`)||vFo(e).replace(/\.md$/,"")`, skill loader `Z_e` @214756471:
`displayName:M4t(e.name,\`skill ${r}\`)`. Also used by output_style renderer @215810xxx
(`Output style name exceeds ${iY} characters ...; suppressing its per-turn reminder`).

**Agent rejection site 1 `BFo`** (frontmatter parse error) @213518427:

```js
if(n.length>iY)return b(`Invalid "name": names must be at most ${iY} characters`);
```

(full order: missing name → starts-with-"-" → length → NFKC ":" → missing description.)

**Agent rejection site 2 `EXn`** (loader) @213521927:

```js
t(`Agent file ${Kh(e)} has invalid name '${Kh(h)}': names must be at most ${iY} characters`,{level:"error"}),null
```

(returns null = file skipped; same file also validates background/memory/effort; JSON-schema variant
`djt`: 'agent names must not start with \'-\'\'.)

### TDD port plan

1. **RED** `loadAgentsDir` tests: agent md with 257-char `name` → loader returns null + error log
   `Agent file <path> has invalid name '<name>': names must be at most 256 characters`; 256-char → accepted;
   getParseError path → `Invalid "name": names must be at most 256 characters`.
2. **RED** plugin/skill tests: plugin agent with over-long name → warn
   ``Frontmatter "name" of plugin agent <x> is over 256 characters - ignoring it`` + name falls back to
   `basename(file).replace(/\.md$/,'')`; skill with over-long name → displayName undefined (caller-supplied
   name kept); plugin command → namespace prefix preserved when falling back.
3. **GREEN**: add shared `NAME_MAX_LENGTH=256` const; length branch after the existing `:` reject in
   loadAgentsDir (:740) + getParseError (:563); `validateFrontmatterName(value, label)` M4t-equivalent
   used by loadPluginAgents.ts:88 (change `||` fallback to also trigger on over-long) and
   loadSkillsDir.ts:434.
4. E2E: fixture agent dir with a 300-char name → `occ agents` list omits it; debug log shows the error line.

---

## C10 — instruction-file freshness (session-scoped withheld store) — **UNLANDED (all 5 parts) → PORT**

### OCC status (UNLANDED)

- `src/utils/claudemd.ts:538-561` — 3 reasons only (denied/outside/unsettled) + `logForDebugging`; no store.
- Root-keyed staleness: `agentsMdNoticeRoot` `:118/:1599/:1601/:1668`; `getMemoryFiles` memoize(boolean)
  `:1174-1175`; `src/utils/cdLogic.ts:53-64 applyDirectoryChange` performs no cache resets (stale after /cd).
- `withheld_memory` / `unjudged` — 0 hits repo-wide.
- Nested-memory withholding silently skipped: `claudemd.ts:580-593`, `attachments.ts:1837-1844/:1926-1928/:1948-1977`.
- No shown-cap/overflow row: UI `AttachmentMessage.tsx:184-187` renders unbounded; model
  `messages.ts:4359-4366`.

### Official verbatim (2.1.292) @212089000–212100500

**Reasons + caps**:

```js
var XR=200;
var XB={denied:"a Read deny rule covers it",
 outside:"it's read from outside your working directories, where reads are blocked",
 unjudged:"a Read deny rule couldn't be checked without a working directory",
 unsettled:"where it leads couldn't be worked out"};
var Soe=20; var vMe="path:";
```

**Session-scoped store** (replaces root-keyed map — survives /cd):

```js
var F_=new gt(()=>({owed:new Map,logged:new Set,token:E3n(),seen:new Set}));
function QB(e,n){let{logged:r}=F_.of(e);for(let{path:s,why:g}of n)if(!r.has(s)&&r.size<XR)r.add(s),t(`Instruction file not loaded: ${s} (${XB[g]})`)}
function kMe(e,n){let{owed:r}=F_.of(e);QB(e,n);for(let s of ve()?[]:n)if(!r.has(s.path)&&r.size<XR)r.set(s.path,s)}
function bMe(e,n){...r.delete(s)...}                       // owedNoMore
function wMe(e,n){...delete...;return Array.from(r.values())}  // owedWithheld
var TMe=(e,n)=>new Set(e.flatMap(...type==="attachment"...type==="withheld_memory"...r.by===n?[r.entries]:[]...));  // toldIn
function EMe(e,n){let{seen:r,token:s}=F_.of(e.session),g=TMe(n,s);for(let h of g)if(r.size<XR)r.add(h);return new Set([...r,...g])}  // toldBy
var F1t=(e,n)=>({lead:`Instruction file not loaded (${XB[e]}):`,mark:vMe,path:AX(n.replace(/\s+/g," ")).replace(/\s+/g," ")});  // withheldLine
var U1t=(e)=>`and ${e.more} more instruction ${I(e.more,"file")} not loaded`;   // withheldMore
var Zgt=(e)=>({shown:e.slice(0,Soe),more:Math.max(e.length-Soe,0)});           // withheldShown (cap 20 + overflow)
```

Reason producers: `kbt=(e)=>WRn(e)&&"denied"||Vge(e,ct,"deny").length>0&&"unjudged"||void 0`
(**unjudged** = deny rules exist but no working directory to evaluate them); `bbt` @212099xxx:
`e===void 0&&"unsettled"||r&&"denied"||s&&"outside"||void 0`.

**Attachment producer `Kun`** @215044478:

```js
function Kun(e,n){let r=new Set(Zgt(cJe(e)).shown.map(({path:g})=>g));wMe(e,r);
 let s=n.filter(({path:g})=>!r.has(g));if(s.length===0||ve())return[];
 return[{type:"withheld_memory",entries:s.map((g)=>({...g,displayPath:Yk(oe(),g.path)})),by:F_.of(e).token}]}
```

Nested-memory integration (`Vun`, same extract): inside an agent (`agentId!==void 0`) → `kMe` only
(owe, no attachment); main thread → `QB` + filter against `s?.withheld` + already-told set, slice(0,XR),
push `Kun(...)`.

**Model renderer**: `withheld_memory:()=>[]` (@215816658, inside `cer`) — model sees NOTHING; UI/transcript
renders the `withheldLine` rows (`Instruction file not loaded (<reason>): path:<path>`) + `withheldMore`
overflow (`and N more instruction files not loaded`), cap `SHOWN_MOST=20`. Also listed in the patch-turn
attachment allowlist `bd` @219822xxx.

### TDD port plan

1. **RED** `src/utils/__tests__/withheldMemory292.test.ts`:
   - store: session-scoped (two sessions don't share owed/logged/seen); KEPT cap 200; `unjudged` reason text.
   - `/cd` staleness: owe under root A → change dir → store still keyed by session (token), notice not duplicated (logged set).
   - producer: main-thread nested memory withheld → one `withheld_memory` attachment with `by:token` +
     `displayPath`; inside agent → owed only, no attachment; second turn with same entries already told → no attachment.
   - UI: 25 entries → 20 shown + `and 5 more instruction files not loaded`; singular `file` when more===1.
   - model renderer returns [] (nothing sent to the model).
2. **GREEN**: new `src/utils/withheldMemory.ts` (store + REASONS + line/overflow/shown helpers, exported
   names per official: KEPT_MOST/PATH_MARK/REASONS/SHOWN_MOST/noteWithheld/oweWithheld/owedNoMore/
   owedWithheld/toldBy/toldIn/withheldLine/withheldMore/withheldShown); rewire `claudemd.ts:538-593`
   (add `unjudged` via the deny-rules-without-cwd check; replace root-keyed `agentsMdNoticeRoot` map with
   the session store; nested-skip sites become `kMe`); attachments.ts gains the `withheld_memory`
   producer (Kun) in the memory pipeline (:1837-1977); messages.ts model map gains `withheld_memory:()=>[]`;
   AttachmentMessage.tsx caps at 20 + overflow row.
3. E2E (tmux REPL): deny-rule CLAUDE.md import → transcript shows `Instruction file not loaded (a Read
   deny rule covers it): path:...`; `/cd` elsewhere and back → no duplicate/stale notice.

---

## L26 — Remote-Control session persist guards — **PORT (partial; bridge/teleport-only guards N/A)**

### OCC status (UNLANDED, zero line drift)

`src/utils/sessionStorage.ts:1421-1458` — persist block at the identical line range as the prior
forensics; `:1456` is the ONLY `persistToRemote` call site; sidechain entries skip remote entirely
(`!isAgentSidechain` gate :1444). `persistToRemote` :1499-1540 guards: isShuttingDown (:1500-1502),
CCR v2 internalEventWriter branch with early return (:1505-1520), `ENABLE_SESSION_PERSISTENCE` +
`remoteIngressUrl` (:1523-1528), failure escalation `tengu_session_persistence_failed` +
`gracefulShutdownSync(1,'other')` (:1536-1539). v1 ingress `src/services/api/sessionIngress.ts:71-141`
(Last-Uuid header + 409 recovery) ≈ official `tDn` @211482xxx (verified same protocol).
`src/remote/` = 1132 lines, 0 sidechain/persist/dedupe hits.
**Triage error to correct**: `docs/upstream-version-gap-occ149-2026-10.md:179-180` disposed
[Remote Control] (2) as "no OCC surface" — wrong; the RC host and persist seam are real.

### Official verbatim (2.1.292) @215946500–215953500

appendEntry head + dedup-transcript case + persistToRemote (minified names decoded:
`jM`=**isTranscriptMessage** — proven by export rename `jM as isTranscriptMessage` @226525391;
`$s()`=**isShuttingDown** — proven by `function $s(){return hS().isShuttingDown()}` @211575768 in the
graceful-shutdown module (claimShutdown/releaseShutdownClaim neighbors); `Tve(e)=Ts(e)||e.type==="user"&&e.isCompactSummary===!0`
(compact-pair) @215859123; `yk(e)=PSn(e)||c6()||YZ(e)||Qfe(e)` (history-suppression/bridge taint) @216008803):

```js
async appendEntry(e,n=this.store.getSessionId(),r,s,g,h){
 if("agentId"in e&&e.agentId)this.noteAgentWrittenLocally(e.agentId);
 if(this.shouldSkipPersistence())return;
 if(jM(e)&&Tve(e)&&(r===!0||PSn(la(n))))this.foreignWithheldEntryUuids.add(e.uuid);
 if(jM(e)&&!e.isSidechain){let G=r1r((h??Qbe())?.get(e.uuid))??(Tve(e)?g===void 0?c_t(la(n)):g:void 0);
   if(G!==void 0&&G!==null)e.foreignToBridgeSession=G}
 if(this.relocationBuffer){this.relocationBuffer.push({...});return}
 ...
 case"dedup-transcript":{
   if(e.type!=="progress"&&!jM(e)){c(Error(`appendEntry invariant: dedup-transcript policy on non-transcript type '${e.type}'`));return}
   let G=await this.store.sessionMessages(n,s),z=e.isSidechain&&e.agentId!==void 0,Y=z?Hm(vo(e.agentId)):H,...;
   let _e=!G.has(e.uuid);
   if(z||_e){this.enqueueWrite(Y,e,s);...
     if(!z){if(G.add(e.uuid),jM(e))
        if(this.internalEventWriter&&$s())this.persistToRemote(n,e);       // fire-and-forget while shutting down IF CCR writer exists
        else await this.persistToRemote(n,e)}
     else if(this.internalEventWriter&&jM(e))this.persistToRemote(n,e)}    // ★ sidechain entries DO go remote via CCR v2 writer
   return}}
```

```js
async persistToRemote(e,n){
 if(this.appendsSealedForShutdown)return;
 if($s()&&!this.internalEventWriter)return;                                 // ★ shutdown + no writer → skip
 if(jZn(n,this.internalEventWriterSessionId)){t("[persist-remote] Skipping upload: the row is the /teleport-pulled conversation's");return}
 if(Tve(n)&&(this.foreignWithheldEntryUuids.delete(n.uuid)||yk(la(e)))){t("[persist-remote] Skipping compact-pair upload: conversation carries a history-suppression taint");return}
 if(this.internalEventWriter){try{await this.internalEventWriter("transcript",n,{...Ts(n)&&{isCompaction:!0,preservedEventIds:n.compactMetadata?.preservedMessages?.uuids},...n.agentId&&{agentId:n.agentId}})}
   catch{i("tengu_session_persistence_failed",{}),t("Failed to write transcript as internal event")}return}
 if(!De("true")||!this.remoteIngressUrl)return;
 if(!await Stt(e,n,this.remoteIngressUrl))i("tengu_session_persistence_failed",{}),ks(1,"other")}
```

### Verdict + port plan

- ★-marked deltas are the real 292 change and ARE portable to OCC:
  1. **sidechain → remote via internalEventWriter** (`else if(this.internalEventWriter&&jM(e))`): OCC's
     ccrClient already stamps `agent_id` (ccrClient.ts:793-814) but never receives sidechain rows.
     TDD: appendEntry with `isSidechain+agentId` entry while an internalEventWriter is registered →
     writer called once with `{agentId}`; no v1 ingress call; without a writer → still skipped (v1
     Last-Uuid chain invariant preserved, inc-4718 comment stays true).
  2. **shutdown nuance**: replace OCC's unconditional `isShuttingDown()` return with the official pair —
     `appendsSealedForShutdown` (append-side seal) + `isShuttingDown()&&!internalEventWriter` (remote-side skip);
     main-thread append uses fire-and-forget (no await) when writer && shutting down.
- N/A for OCC (no surface, 0 hits): `jZn` teleport-pulled skip, `foreignWithheldEntryUuids` /
  `foreignToBridgeSession` / `PSn` bridge-taint stamping, `relocationBuffer` (transcript relocation),
  replayIndex (`J7()`) — all /teleport + session-bridge machinery absent from OCC.
- 293: chunk present verbatim (`Skipping compact-pair upload` @216925778, `foreignToBridgeSession` @216922889).

---

## L28 — Send-now flush ("don't end the waited-on thing") — **PORT (subsystem-scale; phased)**

### OCC status (guard UNLANDED; seam real)

TUI path intact: `defaultBindings.ts:83-84` (`ctrl+enter`/`ctrl+x ctrl+s` → `chat:sendNow`) →
`PromptInput.tsx:1931-1958 handleSendNow` → `sendNow.ts:205-213 resolveSendNowKeyAction` →
`REPL.tsx:4191-4194 handleSendQueuedNow` → `sendNow.ts:134-151 flushQueuedMessagesCore` →
`REPL.tsx:4167-4182 interruptRunningTurn` (always aborts). sendNowCut 2.1.288#59 port intact
(`query.ts:1220/:1831`). Machinery greps all **0 hits**: `deliverWithoutCancel`, `lowLatency`,
`tengu_velvet_panda`, `tengu_bubbly_meteor`, `backgroundNow`, `foreground-tool-calls`,
`pendingDispatchUuids`, `prewaitLatch`, `frameIntake`, `isFoldInFlight`, `promoteToNow`/`demoteFromNow`
(OCC queue has `priority: 'next'|'later'` only — messageQueueManager.ts:133-172).
**Triage error to correct**: gap doc :180 called Send-now "desktop-app only" — the key is bound in
OCC's TUI and the official fix targets exactly this key.

### Official verbatim (2.1.292)

**Key handler** @233601200–233602600:

```js
function Irt(h){let k=ibn();
 if(k&&Ert(h)&&h.deliverWithoutCancel())return y("input_send_now_key"),!0;
 switch(Drt(h)){case"cancelled":if(k)p("input_send_now_key","fell_back_to_cancel");else y("input_send_now_key");return!0;
  case"no_live_controller":return p("input_send_now_key","no_live_controller"),!1;
  case"nothing_to_send":return!1}}
function Ert(h){return(h.mode??"prompt")==="prompt"&&h.turn.guard.isActive&&ger(h.queue)}
function Drt(h){if(!Ert(h))return"nothing_to_send";if(!h.interruptRunningTurn())return"no_live_controller";return iho(b("queued_send_now"),h),"cancelled"}
```

(`Drt` ≡ OCC's `flushQueuedMessagesCore` — the official kept it as the FALLBACK.)

**Flags + REPL wiring** @213635246 / @233752100:

```js
function ibn(){return T("tengu_velvet_panda",!0)}
function U2r(){return ibn()&&T("tengu_bubbly_meteor",!0)}
...
sendQueuedNow=(h,k)=>{let L=()=>this.#e.lowLatency.sendQueuedNow(k);
 if(k===void 0)return Irt({...this.#a(h),deliverWithoutCancel:L});
 return h==="prompt"&&ibn()&&L()};
#a(h){...return{mode:h,turn:H,queue:Q,interruptRunningTurn:H.interruptForSubmit,...}}
```

**Low-latency engine `EIt`** @231504000–231511000 (full class extracted to
`/tmp/carryover-extract/l28-lowlat-231504000.txt`): `sendQueuedNow()` registers eligible queued prompts
(`mode==="prompt"&&Hf(h)`, per-agent via `$o`), subscribes queue+turn guard, polls `#v()`; head-state
`Fo` ∈ {deliverable, behind_earlier, not_ready, ended_by_hook}; decision `ta(ee)` over an evidence
snapshot (holderCount, unmovableHolderCount, isExecuting, isHeldByDialog, isCompacting,
isMainRequestInFlight, isAwaitingMovedResult, isBackgroundingDisabled, isUnmovableGraceOver…) →
`stand_by|wait(reason)|background|interrupt|cancel`; **case "background"** moves what the turn waits on:
`Bo(W,Z,g)` backgrounds running subagent tasks, `FVo(x)` calls `backgroundNow()` on registered
foreground tool calls, then `promoteToNow(uuid)` (`#k`, outcome `delivered_early`) — the turn is NEVER
aborted if a move succeeds; only after unmovable-grace expiry → `#w` `fell_back_to_cancel` →
`interruptForSubmit()`. Log: `[low-latency-submit] ${action} ${reason} head=… holders=… executing=…`.

**Foreground-call detach registry** @213635530 (FVo) + @213635800 (D6t):

```js
function FVo(e){let n=0;for(let r of e)try{if(r.backgroundNow())n++}catch(s){t(`[foreground-tool-calls] moving ${r.toolUseId…
be=Hse.of(s.session).add({toolUseId:r,backgroundNow:()=>{
  if(!H||s.abortController.signal.aborted||s.toolState.get(q6).count>0||!sGe(e,n,s))return!1;
  return H=!1,Y.letGo(r),_e(),!0}})
```

(detach gate: not inner call, no remoteCall, interactive or `u7n`, no PostToolUse/PostToolUseFailure/
PostToolBatch hooks matched, `tengu_tool_detach` default true.)

**Sibling surface (CCR remote client)** @237378000: control-request handler `IS` returning
`{still_queued,send_now:"delivering"|"nothing_waiting"|"stopped"}`, capability `interrupt_send_now_v1`,
predicate `tat(e){return e.send_now===!0&&e.cancel_queued!==!0}` @209544634, `message_uuid` matcher
`bys` (max 8, case-insensitive) — OCC has plain `interrupt` (controlSchemas.ts:100) but zero hits for
send_now/capabilities/receipts. This half stays N/A until OCC grows the CCR frame-intake queue
(prewaitLatch/frameIntake/fold — all 0 hits).

### Verdict + phased port plan

**PORT** for the TUI key path (real seam, flag default-true in official):
- Phase 1 (RED/GREEN-able now): `Irt/Ert/Drt` shape — add `deliverWithoutCancel?` to `SendNowFlushDeps`,
  gate on a `tengu_velvet_panda`-equivalent flag (default true), keep OCC's flush core as `Drt`
  fallback, telemetry names `input_send_now_key` + `fell_back_to_cancel` verbatim. Tests: flag on +
  deliver succeeds → no interrupt; deliver fails → interrupt (fell_back_to_cancel); flag off → legacy path.
- Phase 2: queue `promoteToNow`/`demoteFromNow` + `'now'` priority (messageQueueManager) and the `Fo`
  head-state machine.
- Phase 3: tool-detach registry (`backgroundNow` on foreground tool calls; `tengu_tool_detach` gate +
  PostToolUse-hook exclusion) and task backgrounding (`Bo` equivalent over OCC task registry) — this is
  the piece that literally "doesn't end the waited-on subagent".
- Phase 4 (optional, separate): CCR control-request `send_now` — blocked on frame-intake subsystem (N/A today).

---

## L69 — Chrome pairing disconnected message — **N/A for the landed text; PORT-optional for the paired-device variant**

### OCC status

`src/utils/claudeInChrome/mcpServer.ts:115-117` — single `onToolCallDisconnected` closure returning the
plain message; 0 hits for `continue with alternatives` / `unreachable` / cloud / paired variants;
`getPersistedDeviceId` `:136-138` exists (config only, no env fallback);
`CLAUDE_CHROME_PAIRED_DEVICE_ID` not read anywhere. Runtime caveat: consumer
`packages/@ant/claude-for-chrome-mcp/src/index.ts` is an inert 11-line stub
(`createClaudeForChromeMcpServer(...) → null`) — nothing here is observable at runtime in OCC builds.

### Official verbatim (2.1.292) @222798300–222803200

4-branch `onToolCallDisconnected:$Mo(()=>{...})`:

1. `if(C)` OAuth-account-mismatch → long CLAUDE_CODE_OAUTH_TOKEN guidance. **No x-sentence.**
2. `if(Boolean(I)&&!ce().chromeExtension?.pairedDeviceId)` → env-pinned paired device unreachable →
   "The browser chosen for this session could not be reached…" **+ x unconditionally**.
3. `if(Gs())` cloud session → "Chrome on the user's computer could not be reached from this session…"
   → `return PB()?`${s} ${x}`:s` — **x only iff `PB()`**.
4. plain → `Browser extension is not connected. Please ensure the Claude browser extension is installed
   and running (${oN}), and that you are logged into claude.ai with the same account as Claude Code. If
   this is your first time connecting to Chrome, you may need to restart Chrome for the installation to
   take effect. If you continue to experience issues, please report a bug: ${U}` — **No x-sentence.**

with `x="If the user prefers, continue with alternatives (web search, or ask them to do the browser step themselves)."`,
`U="https://github.com/anthropics/claude-code/issues/new?labels=bug,claude-in-chrome"`,
`I` = validated `CLAUDE_CHROME_PAIRED_DEVICE_ID` env (`V=/^[A-Za-z0-9_-]{1,128}$/`, else
`Ignoring CLAUDE_CHROME_PAIRED_DEVICE_ID: not a browser extension device id`),
`getPersistedDeviceId:()=>nMr(()=>ce().chromeExtension?.pairedDeviceId||I)`,
browser_batch timeout `G=90000`.

### Verdict

- The new-in-292 x-sentence attaches **only** to branch 2 (env-paired-device) and branch 3-iff-PB()
  (cloud) — **NOT** to the plain disconnected message and NOT to the OAuth-mismatch message.
- OCC's `mcpServer.ts:116` is a **word-for-word match of official branch 4** (plain), with
  `EXTENSION_DOWNLOAD_URL` ≡ `oN` and `BUG_REPORT_URL` ≡ `U`. ⇒ **the landed text needs no change.**
- Branches 1–3 require surfaces OCC lacks: OAuth-mismatch state `C`, `CLAUDE_CHROME_PAIRED_DEVICE_ID`
  env lane `I`, cloud predicates `Gs()/PB()` (minified, cross-chunk; cloud-session concept absent), and
  the consumer package is a stub — nothing is runtime-observable. ⇒ **N/A** for branches 1/3;
  branch 2 is PORT-optional source-parity only (add env read + `V` regex + `Boolean(I)&&!pairedDeviceId`
  branch + x-sentence + `getPersistedDeviceId` env fallback) — recommend deferring until the
  claude-for-chrome package is unstubbed; a test today could only assert the returned string of a
  closure that never runs.
- 293: sentence present verbatim (@223796630).

---

## Carry-over status matrix

| Item | Status | Evidence anchor |
|---|---|---|
| C1 ripgrep unreadable target | **UNLANDED → PORT** | ripgrep.ts:901-910 silent resolve vs zB @208906460 |
| C3 @-mention too-large | **PARTIAL (OCC-149 landed core)** → residual PORT (guards/displayPath) | attachments.ts:3350-3380 vs guard trio @215048836 |
| C4 hook-output escaping | **UNLANDED → PORT** | messages.ts:3712 bare wrap vs ont/AT/Bbe @207408010/212080879/215793388 |
| C5 stray-param tolerance | **PARTIAL (Write only)** → PORT residual (Read/Grep/WebFetch/WebSearch/drop_command_create) | FileWriteTool.ts:180-238 vs _7n/cEt/zKt @214910800/212215273/213351378 |
| C6 name 256 limits | **UNLANDED (3/3 sites) → PORT** | loadAgentsDir.ts:728 vs M4t/BFo/EXn @207586013/213518427/213521927 |
| C10 instruction-file freshness | **UNLANDED (5/5 parts) → PORT** | claudemd.ts:538-561 vs store @212089000 + Kun @215044478 |
| L26 RC session persist | **PORT partial** (sidechain-via-writer + shutdown nuance); bridge/teleport guards N/A | sessionStorage.ts:1421-1458 vs @215946500 |
| L28 send-now flush | **PORT phased** (TUI key path real; CCR send_now control N/A) | sendNow.ts:134-151 vs Irt/EIt @233601200/231504000 |
| L69 chrome alternatives | **N/A** (landed text ≡ official plain branch; new sentence lives on paired-device/cloud branches OCC lacks; consumer stubbed) | mcpServer.ts:115-117 vs @222798300 |

Raw extracts preserved under `/tmp/carryover-extract/` (c1-wide-208888000, c4-ol-bbe-215792900,
c4-u003c-211656300, c4-at-212080879, c5-*, c6-*, c10-*, c3-*, l26-decision-215946500,
l26-ingress-211480500, l28-lowlat-231504000, l28-handler-237378000, l28-deliver-233751500,
l69-alternatives-222798300).
