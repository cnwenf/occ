# Cluster E — Parser DoS / Paste Handling / Performance Robustness (2.1.289 → 2.1.290/291)

> Gap research against official claude-code binaries (forensics only — binaries never executed).
> Sources: `/tmp/cc289/package/claude`, `/tmp/cc290/package/claude`, `/tmp/cc291/package/claude`;
> diff corpus `/tmp/gap291/{new-in-290.txt,gone-from-289.txt,s289.sorted,s290.sorted}`.
> OCC baseline: this repo @ 2.1.289 alignment. All byte offsets are decimal ELF offsets.
> Verdicts: **PORTED** (already in OCC) / **STAGED** (port needed, plan below) / **NO-OP** (OCC immune, proven) / **N-A** (surface absent, proven by grep).

## Verdict table

| # | Changelog entry (2.1.290) | Verdict | OCC target |
|---|---|---|---|
| 1 | Crash "Maximum call stack size exceeded" on deeply nested lists/quotes | **STAGED** | `src/utils/markdown.ts`, `src/components/Markdown.tsx` |
| 2 | Compaction failing with "null is not an object" | **NO-OP** | — (crash surface absent) |
| 3 | Freeze after sending some very long messages | **N-A** | — (skill-mentions scanner absent) |
| 4 | Slowdown expanding transcript (ctrl+o) over non-ASCII tool output | **NO-OP** | — (no JS slow-wrap path) |
| 5 | Freeze when secret scan / permission prompt met long token-like text | **STAGED** | `src/services/mcp/displaySanitize.ts` + new chunked-normalize util |
| 6 | Stall when MCP tool listing has long combining-character runs | **STAGED** | same port as #5 |
| 7 | Freeze when secret masking met very long unbroken text | **NO-OP** (engine byte-aligned; OCC masking does not normalize) | — |
| 8 | Long sessions with hundreds of images stuck on "Request rejected as unprocessable" | **STAGED** | `src/services/api/withRetry.ts` + request builder |
| 9 | Output content filter stopped reply while thinking → now retried once | **STAGED** | `src/query.ts`, `src/services/api/withRetry.ts`, `src/services/api/errorUtils.ts` |
| 10 | Rewind menu (Esc Esc / `/rewind`) freezing hundreds of ms per keypress | **NO-OP** | — (bounded preview truncation) |
| 11 | Two overlapping pastes partly sent as typed text | **NO-OP** | — (placeholder-ID architecture) |
| 12 | Large paste sent as typed after keystroke with NFD accents (macOS) | **NO-OP** | — (placeholder-ID architecture) |

---

## Item 1 — Deeply nested lists/quotes crash the renderer ("Maximum call stack size exceeded")

### 官方机制
2.1.290 adds a **lexer depth guard** to the marked tokenizer-extension layer. New in 290 (0 hits in 289 strings; JS hits @216036381, 216038583, 216038679, 216038794):

```js
var Y=/^[ \t>]+/gm,J=/[ \t]+/g,ee=/\n{3,}/g;function te(){let e=new WeakMap,
t=(n)=>(e.get(n)??0)>=100;return{isAtMaxNesting:t,lexLevel:(n,r)=>{if(t(n))return;
let l=e.get(n)??0;e.set(n,l+1);try{return r()}finally{e.set(n,l)}}}}var w=te(),
H=(e)=>e.replace(Y,(t)=>t.replace(J," ").trimStart()).replace(ee,`\n\n`).trimEnd();
```
(@216036381, verbatim; `w` = guard factory, cap **100**, WeakMap keyed by lexer.)

At @216038583 the marked `extensions` wrapper runs the **blockquote / list / emStrong tokenizers** inside `w.lexLevel(this.lexer, …)`. At cap, fallback `B(e,t)` flattens the list/blockquote input to plain text (strip `[ \t>]+` line prefixes via `H`, collapse `\n{3,}`, then `lexer.inline(n)`) instead of recursing. 289's extension object `U` @213291638 wrapped only `{tokenizer:{del,def,table}}` — no depth guard at all.

Additionally, **all versions** (incl. 289) carry a render-level catch: `"markdown rendering exceeded the stack — input is too deeply nested"` (string present in s289/s290).

### OCC 现状
- `src/components/Markdown.tsx:131,312` call `marked.lexer(content)` **directly**, no depth guard, no try/catch around lexing/rendering (grep `exceeded the stack` → **0 hits** in `src/`).
- `src/utils/markdown.ts` `configureMarked()` only disables the `del` tokenizer (lines 27–33); no blockquote/list/emStrong wrapper.
- marked v17's lexer recurses on nested lists/blockquotes → a response with ~1000-deep nesting throws `RangeError: Maximum call stack size exceeded` inside `marked.lexer`, same as official 289. The pre-existing render-level catch was never ported either.

### 判定
**STAGED** — OCC is vulnerable to the exact 289 crash (both the lexer recursion and the missing render catch).

### 移植方案
1. New util (e.g. `src/utils/markdownLexLevel.ts`): byte-faithful port of `te()`/`w`/`H`/`B` — WeakMap per-lexer depth counter, cap 100, `finally` restore.
2. In `src/utils/markdown.ts` `configureMarked()`: add a marked extension wrapping the `blockquote`, `list`, `emStrong` tokenizers in `lexLevel(this.lexer, …)`; at cap, run the flattening fallback `B` (prefix strip + `\n{3,}` collapse + `lexer.inline`).
3. In `src/components/Markdown.tsx` (and `applyMarkdown` in `src/utils/markdown.ts`): wrap lex+render in try/catch for `RangeError`; on catch emit the official text `markdown rendering exceeded the stack — input is too deeply nested` as a plain-text paragraph fallback (matches the all-versions official catch).

### 测试计划
- Unit: feed `'>' + '> '.repeat(5000) + 'deep'` and 5000-deep `- ` nested list into `applyMarkdown` → no throw; output contains flattened text (blockquote case) or the fallback message (catch case).
- Unit: depth ≤100 renders normally (guard invisible below cap); cap restores via `finally` across sibling subtrees (two 99-deep lists in one message both render).
- E2E (REPL): stub API response containing 2000-deep list → message renders (flattened/fallback), app does not crash, subsequent messages still render.

---

## Item 2 — Compaction failing with "null is not an object"

### 官方机制
290's compaction module (live region 289 ~209330000–209412000 / 290 ~212518000–212604000, normalized diff ratio 0.9541) gained **null-safety plumbing around the fork/snapshot transcript path**:

```js
function Vme(e){if(_t()||Ha()||e.compactTranscriptUnavailable)return;
return e.agentId!==void 0?$g(e.agentId):vp()}
```
(new in 290 — 289 has no function at this slot between the `Gjt`/`dKn` equivalents.)

`compactTranscriptUnavailable`: 0 hits in `s289.sorted` → 6 hits in `s290.sorted`. It is set at two fork sites (@289:215169618 / @290:217940190, `preserveToolUseResults` anchors):
```js
if(go)je.compactTranscriptUnavailable=!0;
else if(A!==void 0&&A===n.messages&&n.agentId===void 0){
  let x=pt.findLast((I)=>Jb(I)&&!lD(I.uuid))?.uuid;
  if(x!==void 0)Et=_e.slice(pt.length),je.compactTranscriptUnavailable=!0,
  szr({agentId:se,parentSessionId:K(),parentLastUuid:x,contextLength:pt.length},
      n.storageV5).catch(Dl)}
```
Call site change: 289 `qe=kle(h)` → 290 `Xe=$me(),ot=Vme(n),Ye=Nme(h,Xe,ot!==void 0)` — the new summary prompt's transcript-path section is conditional: `${r?` - the path to the full transcript on disk...`:""}`. Also new: `tengu_curried_trinket` A/B arms (`["control","lean","short","capped"]`), `compactionKind` (`"manual"|"auto"|"reactive"`), telemetry `promptArm`/`scopeWarned`.

The exact 289 null-deref line is **not isolatable from strings alone** ("null is not an object" is JSC's generic TypeError text; the 289 string region near the fork/snapshot strings also carries `Cannot destructure property 'result' from null or undefined value`). What is provable: 290's fix direction is guarding the transcript/fork lookups (`Vme` + `compactTranscriptUnavailable`) so compaction never dereferences a missing fork/snapshot transcript. Ruled out as the crash site (byte-identical 289↔290): summary extractors (`yle/_le` = `Rme/Cme`: `findLast` assistant → `?.message.content.find(...)?.text.trim()||null`), message-level `_D`(289@211678668)=`kL`(290@214402081), the `empty_summary` guard, and the compactMetadata repair normalizer (@289:210484344 / @290:211369687).

### OCC 现状
- `src/services/compact/compact.ts:509-556`: `summary = getAssistantMessageText(summaryResponse)`; explicit `if (!summary)` → logged `no_summary` error with message text; `startsWithApiErrorPrefix` branch. `getAssistantMessageText` (`src/utils/messages.ts:3452`) returns `null` for non-assistant / non-array content, `|| null` for empty text — fully guarded.
- `compactMetadata` derefs: constructed-nonnull (`compact.ts:385` builds the literal) or optional-chained on loaded messages (`sessionStorage.ts:2065` `entry.compactMetadata?.preservedSegment`; `toolSearch.ts:554` `(msg as any).compactMetadata?.…`).
- The official crash surface — fork-point snapshot writes (`szr`), `fork point could not be written to snapshot` / `snapshot trailer append failed` / `fork briefing written to snapshot` — has **no OCC counterpart** (grep `fork point|snapshot trailer|fork briefing` → only git `--fork-point` and review-command hits, nothing in compaction).
- OCC's compact prompt (`src/services/compact/prompt.ts:344-354`) is the 289-era prompt with its own conditional transcript-path line (`if (transcriptPath)`), fed by `getTranscriptPath()` (`sessionStorage.ts:289`) which **always returns a string** (`join(...)`, never null).

### 判定
**NO-OP** — OCC's compaction has no unguarded dereference on this path and does not replicate the fork/snapshot machinery whose null transcript caused the official crash.

### 移植方案 + 测试计划
None required for the crash. Follow-up (out of cluster-E scope, feature-side): 290's `tengu_curried_trinket` prompt-arm rework (`Nme` builder, `<analysis>`+`<summary>` reply shapes, `compactionKind` plumbing, `Vme` gating) is a separate alignment item — track in the prompt/compaction feature cluster, not as a robustness port. Regression test to keep: `compact.test.ts` asserting `no_summary` path yields a user-visible error, never a TypeError.

---

## Item 3 — Freeze after sending some very long messages

### 官方机制
Root cause was the **skill-mentions embedded slash-command scanner** (`tengu_humble_emerson` attachment, runs synchronously at turn start — the surrounding 1000ms AbortController cannot interrupt sync regex). 289 @210894208:

```js
function bRe(e){let n=[],r=/(^|[\s。、？！])(\/[a-zA-Z][a-zA-Z0-9.:\-_]*)/g,
s=null;while((s=r.exec(e))!==null){let g=s[1]??"",h=(s[2]??"").replace(/\.+$/,""),
S=s.index+g.length;n.push({start:S,end:S+h.length})}return n}
```

`.replace(/\.+$/,"")` backtracks **O(k²)** on JSC when a long mid-token run of dots fails the end anchor. 290 @213603302 replaces it with a linear trailing-dot walk:

```js
function kPe(e){let n=[],r=/(^|[\s。、？！])(\/[a-zA-Z][a-zA-Z0-9.:\-_]*)/g,
s=null;while((s=r.exec(e))!==null){let g=s[1]??"",h=s[2]??"",S=h.length;
while(h[S-1]===".")S--;let w=s.index+g.length;n.push({start:w,end:w+S})}return n}
```
Call site (290, verbatim): `Rl("skill_mentions",()=>Promise.resolve(S?.isHumanTypedPrompt&&…sln(S.preExpansionInput??e,n.options.commands,{typed:…,pastedContents:…,…}):[]))`; the enclosing `sln`(290)/`ytn`(289) are otherwise identical.

### OCC 现状
OCC has **no skill-mentions scanner**: `rg -n 'skill_mentions|skillMention|u3002|FF1F' src/` → 0 relevant hits (only `isHumanTypedPrompt`/`preExpansionInput` plumbing in `src/utils/effort/ultracode.ts` and `src/utils/handlePromptSubmit.ts`, no embedded-command regex scan). No quadratic trailing-dots regex anywhere: `rg '\\\.+\$' src/` → only single-dot `/\.$/` hostname trims (`McpAuthTool.ts:83`, `allowedProvidersEnforcement.ts:223,316`, `desktopDeepLink.ts:348`) which are linear and length-bounded.

### 判定
**N-A** — the vulnerable surface (skill-mentions embedded slash-command scan at turn start) does not exist in OCC; the specific quadratic `.replace(/\.+$/,"")` pattern is absent.

### 移植方案 + 测试计划
None now. **Constraint for the future skill-mentions port**: implement the scanner with 290's linear trailing-dot while-loop (`kPe` form), never `/\.+$/` replace; test with a 100KB single-token message containing a 50K-char mid-token dot run completing <50ms.

---

## Item 4 — Slowdown expanding transcript (ctrl+o) / resizing over large tool output with non-ASCII (arrows, dashes, box-drawing)

### 官方机制
Official's word-wrap helper (`Z` 289 @~200685198 → `re` 290 @~203148918) wraps `Bun.wrapAnsi` with a JS correction path. 289 fast-path test was `/[^\x00-\x7f]/` — **any** non-ASCII (including harmless arrows `→`, em-dashes `—`, box-drawing `│─`) dropped into the slow JS segmentation path per line. 290 extends the fast path to a problematic-range regex (verbatim):

```js
h=/[^\x00-˿Ͱ-҂Ҋ-ԯ -​‐- ⁰-⃏℀-⯿⺀-〩〰-゘゛-꓏가-힣豈-﫿！-ﾝ￠-￮\u{1f000}-\u{1f1e5}\u{1f200}-\u{1f3fa}\u{1f400}-\u{1faff}]/gu
```
Arrows (U+2190–21FF ⊂ 2100–2BFF), em-dash (U+2014 ⊂ 2010–205F), box-drawing (U+2500–257F ⊂ 2100–2BFF) are all **excluded** from `h` → text containing only these goes straight to native `Bun.wrapAnsi`. The slow path now segments only the individual word around each `h` hit (lastIndexOf space → next space).

### OCC 现状
OCC has **no JS segmentation path at all**: `src/ink/wrapAnsi.ts` is `wrapAnsiBun ?? wrapAnsiNpm` (Bun-native first, 20 lines); `src/ink/wrap-text.ts` calls `wrapAnsi(text, maxWidth, {trim, hard})` directly for wrap modes. Grep for the problematic-range regex (`u02FF|2E80|AC00|x00-\x7f`) in `src/ink/` → 0 hits. `src/ink/screen-reader-render.ts:162-175` documents the delegation ("same primitive as the official"; only the SGR-state fixup `Ayh/Qgc` is deferred). Transcript expansion (`CtrlOToExpand.tsx`) renders through the same ink wrap path → native `Bun.wrapAnsi`, linear, no per-line JS re-segmentation.

### 判定
**NO-OP** — the 289 slowdown lived in official's own JS slow path, which OCC never had; OCC's all-native wrapping is already at 290's fast-path behavior for every input class.

### 移植方案 + 测试计划
None for performance. Note (correctness, out of cluster scope): official's slow path exists to correct `Bun.wrapAnsi` width handling for genuinely problematic code points (combining marks etc., the `h` ranges). If OCC ever shows mis-wraps on combining-character text, port 290's `re` (extended fast path + per-word segmentation) — do **not** port 289's version. Perf guard test to add with that port: 5000-line tool output of `→ ─ │ —` box-drawing text wraps in <200ms.

---

## Items 5 + 6 (+7 input side) — Secret scan / permission prompt / MCP tool listing stalls on long token-like text & combining-character runs

### 官方机制
290 introduces a **chunked normalization engine** (new module `chunk-z6am4wsr.js`, JS @202016511) replacing direct `String.prototype.normalize` on hot sanitization paths:
- `zTe` = windowed **NFKC**, `lps` = windowed **NFKD**, window `E=128` chars.
- Combining runs ≥32 (`/[\p{M}ﾞﾟ]{32,}/`, **0 hits in 289**) get canonical combining-order reordering done manually: cached per-codepoint NFKD, combining-class binary insertion, counting sort into `Int32Array`, re-encode in 4096-chunks — avoiding JSC's pathological `.normalize()` behavior on long runs.

Substitutions (289 → 290, verbatim):
```js
// MCP name/description sanitizer (tool listing + permission prompts):
qr(e,n=64){return Ua(e.normalize("NFKC").replace(/['`]/g," "),n,"none")}   // 289 @~206612100
Zr(e,n=64){return Da(zTe(e).replace(/['`]/g," "),n,"none")}                // 290 @~209751800
```
- Confusables module `xve/du` → `LX/du` now routes through `zTe`/`lps` (secret-scan/permission-prompt token-like text path).
- MCP error decoder `_3o`: 289 had `pg=2000, oD=512` with an O(n²) percent-decode loop `for(let i=0;i<e.length+2;i++)`; 290 adds budgets `Xe=32` (decode depth), `Je=262144` (total), `en=8192`, loop `for(let A=0;A<=Xe;A++){if(x+=S.length,x>Je)break;…}`, and throws `"MCP error text or config too long or too deeply encoded"` / `"MCP error text too long once decoded"` (both 0 hits in 289, 2 in 290).
- Secret-mask **regexes themselves are byte-identical** 289↔290; ruled out as changed: credential-header module, dangerous-command classifiers (`e.length>1e4` cap in both), invisible-char sanitizer (4096/64/16384/8192 caps in both), secretRedaction ruleset.

### OCC 现状
- `src/services/mcp/displaySanitize.ts:194` — `stripInvisibleForDisplay(input.normalize('NFKC'))` and `:225` — `name.normalize('NFKC').replace(/['`]/g,' ')`: **direct 289-style `.normalize('NFKC')`** on exactly the MCP tool-listing / server-name / permission-prompt display path. OCC runs on Bun (JSC) → same pathology on long combining runs / very long token-like strings.
- No confusables module (`rg -l confusable src/` → 0) — the official `xve/du` surface is absent (feature gap noted; its 290 fix rides the same chunked engine).
- MCP error redaction `src/services/mcp/redaction.ts`: normalizer `D` is documented identity in OCC ("the NFKC / percent-decode / invisible-char normalizer `D` is the identity here", line ~805); OCC has the 289-era `JGo` guards (`MAX_RECOVER_EXPANDED_LENGTH = 2000`, >9-segment bail) but no percent-decode loop at all → no O(n²) decoder stall; also no 290 budget throws.
- `src/utils/secretRedaction/engine.ts` is a byte-faithful port of the official masking engine (identical 289↔290) and contains **no `.normalize()` calls** → the item-7 masking freeze mechanism (normalize preprocessing on long unbroken text) cannot fire in OCC.

### 判定
- **Item 5: STAGED** — OCC's permission-prompt/display sanitizer uses direct `.normalize('NFKC')` (289-equivalent) on JSC.
- **Item 6: STAGED** — same call sites are the MCP tool-listing path; long combining runs in tool names/descriptions stall exactly as official 289.
- **Item 7: NO-OP** — masking engine byte-aligned and normalize-free in OCC.
- (MCP error decoder budgets: fold into this port as a secondary diff — OCC lacks the decoder entirely, so the stall is absent; adopt 290's budget constants + throws when the `D` normalizer is eventually ported, per the existing STAGED note in `redaction.ts:23-27`.)

### 移植方案
1. New `src/utils/chunkedNormalize.ts`: port `zTe` (NFKC) / `lps` (NFKD) — 128-char windows; for runs matching `/[\p{M}ﾞﾟ]{32,}/` do per-codepoint cached NFKD + combining-class binary insertion + counting sort (Int32Array) + 4096-chunk re-encode. Match official semantics exactly (windowing must not change results for well-formed input — normalization is stable across window boundaries placed at non-combining chars; follow the binary's boundary rule).
2. `src/services/mcp/displaySanitize.ts`: replace `input.normalize('NFKC')` (line 194) and `name.normalize('NFKC')` (line 225) with `chunkedNFKC(…)` (= official `Zr`/`Da(zTe(e)…)`, `Ua→Da` truncator unchanged).
3. Keep `loadAgentsDir.ts:563,740` and path-normalization `.normalize('NFC'/'NFKC')` calls as-is — official did not substitute those (not hot sanitization paths).

### 测试计划
- Unit: `chunkedNFKC(s) === s.normalize('NFKC')` for randomized NFC/NFD/mixed strings (incl. Hangul jamo U+1161–1175, U+11A8–11C2, halfwidth katakana voiced marks U+FF9E/FF9F).
- Perf unit: 1MB string of 200K combining acute accents (U+0301) → `chunkedNFKC` completes <500ms; assert direct `.normalize('NFKC')` on same input is dramatically slower (documents why).
- E2E: MCP stub server exposing a tool whose description is a 500K-char combining run → `occ` lists tools without UI stall (REPL stays responsive to keystrokes during listing); permission prompt for that tool renders sanitized ≤64-char name.

---

## Item 7 — Freeze of several seconds when secret masking met very long unbroken text

### 官方机制
See item 5/6: the masking **ruleset and engine are byte-identical 289↔290**; the freeze was fixed by the shared chunked-normalization engine feeding the masking/scan preprocessing (confusables `LX/du` via `zTe`/`lps`) and by the same windowing discipline — not by engine changes.

### OCC 现状
`src/utils/secretRedaction/engine.ts` — byte-faithful port (header documents `mZn` capped redaction doubling windows against `wPe=16384` budget, `Nn=512/Hn=512` result cache, tracked-redaction `se/ie` range splicing). No `.normalize()` anywhere in `src/utils/secretRedaction/` (grep → 0). All rule scans are regex `.test/.replace` passes with the ported caps; long unbroken text hits the same capped `mZn/Bn` budget loops the official has.

### 判定
**NO-OP** — OCC's masker has the identical (289≡290) engine and never calls the pathological normalize; the seconds-long freeze mechanism is absent.

### 移植方案 + 测试计划
None. Guard test (cheap, keep): masking a 1MB unbroken alphanumeric token-like string completes <1s and yields `[REDACTED]` per rules — already covered by engine port tests; add perf assertion if not present.

---

## Item 8 — Long sessions with hundreds of images stuck on "Request rejected as unprocessable by the model"

### 官方机制
290 adds a complete **`[media-item-limit]` subsystem** (0 hits in 289). Constants @204095421 (verbatim):
```js
lds=100,cds=3145728,mDn=104857600,gle=20,gDn=10,dds=100,uds=600,Eco=20,
pds=[510,255,127],fds=78643200,mds=25165824,gds=10485760,kmr=64000
```
- **Remover** `gZt(e,n,r=0,s=1/0,g=0)` @212781525: sliding-window keep-newest `n−r` media items, total-byte cap `s` with `g` grace, inserts placeholder block `sZt()`, immutable message rebuild.
- **Gate** `vRt`: error text includes `dro="Request rejected as unprocessable by the model (too many or oversized images, or unsupported parameters)"` && status 400/undefined && not persisted-gaveUp.
- **Retry handler** `yve` @~212833916: ladder step `Ai=pds.find((nc)=>nc<Math.min(Jo,gv?.limit??1/0))` (`Jo` = current media count); no step → persist gaveUp + log `"[media-item-limit] The model still refuses...Not removing any more."` + `api_request_media_limit_gave_up`; else rewrap request `ta=Eg(Ka(ta),"error_recovery")` with `Ka=(nc)=>gZt(nc,Ai,Eco)`, state `gv={limit:Ai,steps:gv?.steps+1,refusedAt}`, return `retry:media-item-limit:${Ai}`.
- **Success handler** `_ve` persists the lowered limit for the session.
- **Builder wiring** (proactive, before the request): `Xe=gZt(Xe,Math.min(w?uds:dds,n.mediaItemLimit??1/0),Eco,Har(),gds)` — cap 100 images (voice mode: 600), keep 20 newest-slack, byte cap `Har()=T("tengu_media_byte_cap",i2e()?mds:fds)` (24MB Bedrock-ish / 75MB), per-item 10MB (`gds`).
- 289 baseline (kept): per-block strip retry `tengu_media_block_strip_retry` / `retry:media-strip:` for corrupt/oversized single blocks.

### OCC 现状
OCC has only the 289 baseline: `src/services/api/withRetry.ts:867-883` (corrupt image block strip + `tengu_media_block_strip_retry`), `errorUtils.ts:312` doc. **Zero** hits for `media-item-limit|unprocessable by the model|mediaItemLimit|media_byte_cap|too many or oversized images` in `src/`. A session with hundreds of pasted images therefore loops on the 400 "unprocessable" rejection with no ladder — exactly the 289 stuck-state the changelog describes.

### 判定
**STAGED** — port the whole subsystem.

### 移植方案
1. New `src/services/api/mediaItemLimit.ts`: constants (verbatim values above), `countMediaItems`, remover `gZt` (keep-newest window + byte cap + grace + placeholder `sZt` + immutable rebuild), gate `vRt` (match official error text + status 400/undefined), session-persisted gaveUp/limit state, telemetry names `api_request_media_limit_gave_up` and the `[media-item-limit]` log lines verbatim.
2. `src/services/api/withRetry.ts`: in the catch chain (before/after media-strip branch per official ordering), add the `vRt` gate → ladder step → `retry:media-item-limit:${Ai}` decision; on exhaustion persist gaveUp.
3. Request builder (where image blocks are assembled — `src/utils/messages.ts` / attachments path): apply proactive `gZt(messages, min(voice?600:100, mediaItemLimit), 20, byteCap, 10MB)` with `tengu_media_byte_cap` feature read.
4. Success path: persist lowered limit (`_ve` equivalent).

### 测试计划
- Unit: `gZt` on synthetic 600-image history with limit 255 → keeps newest 235 + placeholder, byte cap honored with grace, input not mutated (immutability per coding-style).
- Unit: gate accepts only the exact `dro` text with status 400/undefined; rejects 400 with other text.
- Integration: mock API returning the unprocessable rejection twice then success → assert ladder 510→255→127 steps, `retry:media-item-limit:*` values, telemetry sequence, and that a third refusal persists gaveUp and surfaces the "still refuses" message.
- E2E (REPL, `-p` mode): session file with 300 image blocks + stub API rejecting → request eventually succeeds with ≤127 images; no infinite loop.

---

## Item 9 — Turn ended at once when API output content filter stopped reply while still thinking; now retried once

### 官方机制
290 adds `outputFiltered` to the streaming retry state machine (0 hits in 289). Constants @~212761117 (verbatim):
```js
var jJt={retries:0,sleptThrough:0,overloaded:0,stalls:0,truncations:0,
afterThinkingOnly:0,outputFiltered:0,triedWithoutStreaming:!1},pKe=1;
var gKe=2,WJt=1,Gge=1,GJt=10;
```
Decision fn `car`: `if(e==="outputFiltered")return(n==="nothing"||n==="started")&&!r?QN("outputFiltered",h.maxOutputFiltered,g,h,w):w;` — retry **only** when stream progress is `nothing`/`started` (i.e. filter hit while still thinking, no visible answer) **and** no `stop_reason`; budget `Gge=1`. Loop site @~212893045: warn `"Output content filter stopped the response before any of the answer was shown: retrying streaming (${Ym.outputFiltered}/${Gge})"`, telemetry `tengu_streaming_output_filter_retry` with `first_stop_progress`, state `SE={firstStopProgress:ru.progress,msToFirstStop:…,startedAt:…,ended:void 0}`, then `yield*Wh(),Ji=null;continue e` (resume streaming). On budget exhaustion: throw with `error:_("output_content_filtered")…fallback_disabled:!0` — **no** non-streaming fallback. Detector `ZD(e)`: message includes `lro="Output blocked by content filtering policy"` (present in both versions) && (status 400 or undefined).

### OCC 现状
- `src/services/api/errorUtils.ts:512` has `OUTPUT_CONTENT_FILTER_MESSAGE = 'Output blocked by content filtering policy'` + `isOutputContentFilteredError` (the 285-era `g0`/`QYn` port, with the same status gate).
- `src/services/api/withRetry.ts:580-586`: on filter error → `logEvent('api_request',{reason:'api_request_output_content_filtered'})` + `throw new CannotRetryError(...)` — i.e. the **2.1.285 immediate-fatal behavior**, pre-290.
- `src/query.ts`: no progress-tracking / outputFiltered budget (`rg 'firstStopProgress|outputFiltered|sleptThrough' src/` → 0). A filter hit while the model is still thinking ends the turn at once — exactly the 289 symptom.

### 判定
**STAGED** — port the one-shot streaming retry ahead of the fatal surface.

### 移植方案
1. `src/query.ts` streaming loop: track first-stop progress (`nothing|started|…` from accumulated visible text/thinking state) and `stop_reason` presence; add per-turn counter `outputFiltered` with budget 1 (`Gge=1`).
2. On filter-classified error with progress `nothing|started` && no stop_reason && budget left: log the official warn text verbatim, emit `tengu_streaming_output_filter_retry` with `first_stop_progress`, record `{firstStopProgress, msToFirstStop, startedAt, ended:undefined}`, reset partial assistant state and re-enter streaming (official `yield*Wh(); continue`).
3. Exhausted / progress beyond `started`: keep current fatal path but extend the surfaced error payload with `fallback_disabled: true` per official.
4. `withRetry.ts`: keep `CannotRetryError` classification (official also does not do transport-level retries here — the single retry lives in the streaming loop, not withRetry).

### 测试计划
- Unit (decision fn): table-driven — (`outputFiltered`, progress, stop_reason, budget) → retry vs fatal, matching `car` semantics incl. budget=1 exhaustion.
- Integration: stub stream that emits thinking-only then the filter error → assert exactly one re-stream, telemetry order (`tengu_streaming_output_filter_retry` then success), and that visible-text-then-filter (progress `partial`) does **not** retry.
- E2E (`occ -p`): stub API filtering first response mid-thinking, second succeeds → user sees the answer, not the error; filter-twice → error `output_content_filtered` with `fallback_disabled`.
- Regression: existing `outputContentFiltered285.test.ts` classification tests must stay green (classifier unchanged; only loop behavior added).

---

## Item 10 — Rewind menu (Esc Esc / `/rewind`) freezing hundreds of ms per keypress with very large pasted stack trace/source file

### 官方机制
Forensics: the rewind UI itself **did not change** — normalized diff of the ±6KB window around the `MessageSelector:` log (289 @205393387 / 290 @207898981) gives ratio **0.9998**; the virtualized-list/search/measure module (`promptText:new WeakMap` + `extractSearchText:` @289:228118417 / @290:231318766, sourcemap region) diffs to 26 opcodes, **all 1–2-char identifier renames** — structurally byte-identical. The per-keypress freeze was fixed through the **shared word-wrap rewrite (item 4)**: rewind rows re-wrap/re-measure the huge pasted message text on every render, and 289's slow JS wrap path fired on the non-ASCII (box-drawing/arrows) common in stack traces and source files; 290's extended fast path sends that text straight to native `Bun.wrapAnsi`.

### OCC 现状
- `src/components/MessageSelector.tsx`: options `useMemo` (line 61); render maps only the visible window `messageOptions.slice(firstVisibleIndex, firstVisibleIndex + MAX_VISIBLE_MESSAGES)` (line 359); preview text is **bounded before wrap**: line 665 `truncate(messageText, columns - paddingRight, true)` else `messageText.slice(0, 500).split("\n").slice(0, 4).join("\n")` — a 500KB paste never reaches the wrapper whole.
- Wrapping itself is native `Bun.wrapAnsi` (item 4) — no JS slow path to stall.
- `src/components/VirtualMessageList.tsx` carries the WeakMap memo caches (`fallbackLowerCache`, `promptTextCache`, lines 24/132).

### 判定
**NO-OP** — OCC's rewind preview is truncate-then-wrap over a visible-window slice on a memoized option list; the official freeze mechanism (full-text JS re-wrap per keypress) cannot occur.

### 移植方案 + 测试计划
None. Cheap guard test: render `MessageSelector` over a session containing a 500KB single-line paste; assert 20 simulated keystrokes complete <200ms total (vitest + ink testing library), preview ≤ columns wide.

---

## Item 11 — Two overlapping pastes in one prompt sent partly as typed text

### 官方机制
Official 290's paste pipeline keeps two representations: `[Pasted text #N]` placeholders (`pZ` formatter, `P0` placeholder regex over `Hw=String.raw\`Pasted text|Image|\\.\\.\\.Truncated text|…\``) **and** an inline-content occurrence scanner `RVr/V$r` + content list `Mje(pastedContents)` with overlap-merge (binary-search + `0&&h.from<g.to){if(h.to>g.to)g.to=h.to,g.bodyTo=h.bodyTo}else s.push({...h})`) used to classify typed vs pasted regions. Forensics found **no distinct 289→290 change** in the overlap-merge logic itself (normalized-identical) nor in the PromptInput cluster (289:207722893–207727357 / 290:210343187–210347686, only a new `shell-checkin` origin source); `200~` bracketed-paste deltas were unrelated modules (ANSI cursor @289:200687303/290:203151023 rename-only; supervisor @289:214119020/290:216875462). The fix is most consistent with the item-12 variant-matching change: when overlapping paste occurrences failed content matching, regions weren't marked as pasted and were sent as typed text.

### OCC 现状
OCC has **no content-occurrence scanner**: paste expansion is placeholder-ID splice — `src/history.ts:86-105` `expandPastedTextRefs` parses `[Pasted text #N]` refs (`parseReferences`) and splices `pastedContents[ref.id].content` at recorded match offsets in reverse order ("placeholder-like strings inside pasted content are never confused for real refs"). Two overlapping pastes are two independent placeholders with distinct IDs; both splice unconditionally. `src/utils/invisibleUnicode.ts:896-897` documents: "the entry branch (`I.inline`) has no OCC equivalent — OCC's `PastedContent` type has no `inline` field — so that branch is absent by construction." No typed-vs-pasted region classification exists (no skill-mentions consumer — item 3).

### 判定
**NO-OP** — OCC's ID-based splice architecture is immune by construction: there is no content matching to miss, hence no region can degrade to "typed".

### 移植方案 + 测试计划
None. Regression test (may already exist under `src/components/PromptInput/__tests__/`): paste A (2KB), type text, paste B (2KB) overlapping content with A, submit → expanded prompt contains both full contents exactly once each, in order; placeholder strings inside pasted content are not re-expanded.

---

## Item 12 — Large paste expanded in place sent as typed text after next keystroke when accents are stored decomposed (macOS NFD)

### 官方机制
290 registers **Unicode variants** of inline paste content for the occurrence matcher (verbatim @~209029906):
```js
var NZ=/^[\p{M}ᅡ-ᅵᆨ-ᇂ\u{16D67}\u{16D68}]+/u;
function zyt(e){let n=e.normalize("NFC"),r=n.replace(NZ,"").trimStart();
return D([e,n,r]).filter((s)=>s!=="")}
function Mje(e,n=!1){let r=new Set;for(let s of Object.values(e))
if(s.type==="text"&&s.inline&&s.content!==""&&(n||!s.slashNameOnly))
for(let h of zyt(s.content))r.add(h);return[...r].sort((s,h)=>h.length-s.length)}
```
289's `bUe` did plain `r.add(s.content)`. Mechanism: `RVr` finds paste occurrences via indexOf on the raw input; when the terminal/filesystem supplies NFD-decomposed text (macOS), the NFC-stored content no longer matched → region unmarked → sent as typed. Registering raw+NFC+leading-combining-stripped variants (longest-first) restores matching. Rest of the paste-expansion module is byte-identical 289↔290 (anchors `unshift({text:x.match,typed:!0})` 289:206419686 / 290:209031525; the merge fn present in both).

### OCC 现状
Same structural immunity as item 11: OCC matches placeholders by **ID**, never by content (`expandPastedTextRefs`, `src/history.ts:86-105`); `PastedContent` has no `inline` field (`src/utils/invisibleUnicode.ts:896-897`); intake placeholder creation is in `PromptInput.tsx:1400-1402` (`text.length > PASTE_THRESHOLD(800) || numLines > maxLines` → placeholder) and `maybeTruncateInput` (`inputPaste.ts`, `[...Truncated text #N +M lines...]` placeholder + stored content). NFD/NFC state of the pasted bytes is irrelevant to expansion. Only NFC-sensitivity in the codebase is path handling (`bootstrap/state.ts` cwd `.normalize('NFC')`, memdir paths) — unrelated to paste classification.

### 判定
**NO-OP** — the official failure mode (content-match miss under NFD → typed classification) requires the content-scanning surface OCC does not have.

### 移植方案 + 测试计划
None. Regression test: paste a 2KB NFD-decomposed string (e.g. `'é'.repeat(500)` from a macOS-style filename dump), keystroke after it, submit → expanded prompt contains the NFD content verbatim (byte-equal), placeholder fully replaced.

---

## Cross-item notes

- **One shared port covers items 5+6**: the chunked NFKC/NFKD engine (`zTe`/`lps`) — biggest new-code item in this cluster besides item 8's media ladder.
- **STAGED items by size**: #8 (new subsystem, ~1 file + 2 wiring points) > #9 (loop state machine in query.ts) > #5/#6 (one util + 2 call-site swaps) > #1 (guard wrapper + catch).
- **290 prompt-arm rework (`tengu_curried_trinket`) and `compactionKind`** surfaced during item-2 forensics are feature-side compaction changes, deliberately excluded from this robustness cluster — hand to the compaction/prompt alignment cluster.
- Byte-faithfulness discipline per `aligning-with-official-binary`: every STAGED port above lists the verbatim official snippet to port; do not invent caps/constants — use the extracted values (`pds=[510,255,127]`, `Gge=1`, cap 100, window 128, etc.).
