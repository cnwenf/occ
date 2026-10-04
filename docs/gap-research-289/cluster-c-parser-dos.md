# Gap Research — Official Claude Code 2.1.289, Cluster C (PARSER DoS)

**Changelog item #2 (2.1.289):**
> Fixed the terminal freezing on short code blocks with many unclosed `<script>` tags or deeply nested `${` substitutions

**Changelog item #26 (2.1.289):**
> Fixed published artifact pages freezing or crashing the reader's browser tab on short code blocks with many unclosed `<script>` tags

**Verdicts:**

| Item | Verdict | One-liner |
|------|---------|-----------|
| #2 terminal freeze | **PORT** | OCC freezes identically: `hljs.highlight` on `html`/`xml` code with ≥20 unclosed `<script>` is exponential (probe: killed at 10 s; n=16 already 1.2 s) through OCC's exact production path (`markdown.ts` → cli-highlight → highlight.js 11.11.1). Official fix = budgeted hljs emitter + depth cap 32 + `lang=null` failure memo. Pure nested-`${` is empirically linear in OCC's stock grammars up to depth 5000, but the official budget mechanism covers it (and plugin grammars) — port the whole mechanism for parity. |
| #26 published-artifact page freeze | **NO-OP** | OCC has no artifact-publishing surface (0 grep hits). The official binary's entire artifact-publish pipeline (browser hljs runtime template, char budgets, bundle validator, embedded hljs bundle) is **byte-identical 288↔289** apart from re-minified identifiers — the reader-browser fix lives on the claude.ai serving side, outside the CLI binary. Nothing to port. |

Forensics: `strings`/`grep -bo`/`dd` only. Binaries never executed.
- v288 ELF: `/tmp/cc-diff-289/v288/package/claude`, v289 ELF: `/tmp/cc-diff-289/v289/package/claude`
- The ELFs store their Bun bundle compressed — `grep -boF '<script' v289/package/claude` returns **0 hits** — so all byte offsets below are into the pre-extracted dumps `/tmp/cc-diff-289/s288.txt` / `s289.txt` (unsorted, file order) with the sorted variants `s288s.txt` / `s289s.txt` for lookup.

---

## 1. Item #2 — what changed in the official binary (byte-level evidence)

### 1a. The terminal highlighter is vendored highlight.js, unchanged 288→289

Both binaries embed the same vendored hljs 11.x core (identical modulo minifier
names), including the stock iteration guard `if(Ge>1e5&&Ge>C.index*3)throw
Error("potential infinite loop, way more iterations than matches")`
(s289.txt:419822 / s288.txt:418737). The vendored `javascript` grammar's
`subst`/template-string recursion has **no** `subLanguage` (dump offsets
@26312362 / @26604113 in s289.txt) — same shape as npm hljs. **The grammars did
not change.** The fix is a work-budget wrapper installed around hljs's emitter.

### 1b. NEW in v289: bounded emitter + budget plugin ("HighlightBoundError")

`s289.txt @17551578` (code region; sorted copy at s289s.txt:215064).
**0 occurrences** of `HighlightBoundError` / `highlighting this text takes` /
`isBounded` anywhere in the v288 dumps:

```js
class C extends Error{constructor(){super("highlighting this text takes more work
  than its length allows");this.name="HighlightBoundError"}}
function b(e,n){if(e.left-=n,e.left<0)throw new C}      // charge budget, throw on exhaust
var he=32;   // MAX emitter stack height (nesting depth cap)
var me=64;   // max subLanguage fanout counted
var pe=4096; // base budget
var we=24;   // per-char charge
var Le=3;    // extra per-char charge per unit of subLanguage fanout
var xe=16;   // emitter construction charge
var te=(e,n)=>class r extends e{                          // wraps hljs TokenTreeEmitter
  static isBounded=!0;held=0;breaks=0;height=0;
  constructor(o){super(o);b(n,xe)}
  openNode(o){this.held+=1,b(n,1),super.openNode(o),this.grownTo(this.stack.length-1)}
  addText(o){let s=ee(o);                                  // ee = newline count
    this.held+=o.length,this.breaks+=s,
    b(n,o.length+s*(this.stack.length-1)**2),               // depth² charge
    super.addText(o)}
  __addSublanguage(o,s){if(o instanceof r){let i=this.stack.length+o.height;
    this.held+=o.held,this.breaks+=o.breaks,this.grownTo(i),
    b(n,o.breaks*i**2)}                                     // sublanguage merge charge
    super.__addSublanguage(o,s)}
  toHTML(){return b(n,this.held),super.toHTML()}
  grownTo(o){if(this.height=Math.max(this.height,o),this.height>he)
    b(n,Number.POSITIVE_INFINITY)}};                        // depth>32 → instant exhaust
```

Plus the per-call budget plugin and one-time installer (same line):

```js
// budget = 4096 + codeLen*(24 + 3*min(grammarFanout, listLanguages().length, 64))
// grammarFanout from grammar walk re(); uncapped array fanout → INFINITY (plugin-grammar guard)
var ie=(e,n)=>({"before:highlight":(r)=>{e.left=n(r.language,r.code.length)},
                "after:highlight":()=>{let r=e.left<0;
                  if(e.left=Number.POSITIVE_INFINITY,r)throw new C}});
function z(e,n){let r=e.highlightAuto("",[])._emitter.constructor;
  if(!ne(r))return;                       // ne = "already bounded?" (static isBounded)
  let o={left:Number.POSITIVE_INFINITY};
  e.configure({__emitter:te(r,o)}),       // swap in the bounded emitter
  e.addPlugin(ie(o,oe(e,n)))}             // budget plugin
var Se=(e)=>z(e,me);
```

### 1c. Install site: hljs manager `core()` — the exact 1-token diff

- **v288** `s288.txt @17497153`:
  `core(e){if(this.hljs)return this.hljs;let n=e.loadCore();for(let[r,i]of Object.entries(V5r))…`
- **v289** `s289.txt @17553789`:
  `core(e){if(this.hljs)return this.hljs;let n=e.loadCore();Se(n);for(let[r,o]of Object.entries(VYr))…`

Every terminal highlight path goes through this singleton (`GXt(){return
ORe.core(Gc)}`), so **all** highlighting became budget-bounded in 289.

### 1d. Call-site hardening: failure memo (new in v289)

Color-diff/code-block highlighter `ee()`:

- **v288** `s288.txt @36964904`: `…highlight(i,{language:e.lang,ignoreIllegals:!0})}catch{return[[D(t),i]]}`
- **v289** `s289.txt @37062551`: `…highlight(i,{language:e.lang,ignoreIllegals:!0})}catch{return e.lang=null,[[D(t),i]]}`

v289 additionally sets `e.lang=null` — a block that blew its budget is rendered
plain **and never re-highlighted on subsequent renders**. Without this memo the
terminal would re-trigger the pathological highlight on every streaming
re-render even after the first bound-throw.

### 1e. Why "short code blocks" freeze: the exponential cascade

Stock hljs `xml` grammar (`node_modules/highlight.js/lib/languages/xml.js:173-182`,
identical rule in the official vendored copy):

```js
{ begin: /<script(?=\s|>)/, …, starts: { end: /<\/script>/, returnEnd: true,
    subLanguage: [ 'javascript', 'handlebars' ] } }   // ARRAY → highlightAuto over candidates
```

and `handlebars.js:189`: `subLanguage: 'xml'`. With N unclosed `<script>` tags,
each level of the cascade re-highlights the remaining buffer through
xml→[javascript,handlebars]→xml…, so work grows ~1.5× **per tag** — exponential
in tag count, independent of block size. Hence "short code block" freezes.
Deep `${` nesting is charged by the same mechanism (depth² `addText`/
`__addSublanguage` charges, hard depth cap 32, fanout→∞ guard for
plugin-registered grammars).

---

## 2. Item #26 — artifact-publish pipeline: byte-identical in 288 and 289

The published-artifact page injects a browser-side hljs runtime. Extracted from
both dumps (s289.txt @27780214 region / s288.txt @27700109 region; also
@8860958 / @8857845):

```js
function ua(){return`(function(){
if(typeof hljs==='undefined')return;
var budget=${ca};                       // ca=250000 total chars
var codes=Array.prototype.slice.call(document.querySelectorAll('pre>code'));
…
if(src.length>${la}||src.length>budget)continue;   // la=50000 per block
budget-=src.length;
el.setAttribute('data-claude-hljs-claimed','1');
var res=hljs.highlight(src,{language:m[1],ignoreIllegals:true});
…
})();`}
```

Diffed 288 vs 289: the runtime template, the constants (`la=50000`,
`ca=250000`, `Xr=4194304`), the `<code`/language prescan `Qr()`, and the
bundle validator (`x7e`/`i7e` — "bundle contains `</script`", "…`<!--` together
with `<script` (double-escaped state)", sentinel checks; both lines exactly
**1691 bytes**) are **identical apart from re-minified identifiers and chunk
hashes** (`chunk-k7xqh0xq`→`chunk-g0febq07`). The second embedded hljs copy's
string table (s289.txt:258925-258941 / s288.txt:258828-258844) is also
identical. Note the char-budget cannot stop this DoS anyway: the killer blocks
are *short* — the blowup is per-work, not per-char, exactly what #2's bounded
emitter fixes.

**Conclusion:** nothing in the CLI binary changed for the reader-browser path;
the #26 fix is on the claude.ai artifact-serving side (outside our diffable
surface). OCC has **no** artifact-publishing surface at all:

```
grep -rn 'hljs-runtime|artifact_publish|publishArtifact|mermaid-runtime' src → 0 hits
```

(`src/tools/ReviewArtifactTool/` is the unrelated review-artifact tool.) → **NO-OP**.

---

## 3. OCC exposure

### 3a. Call chains that reach stock hljs

- **Assistant markdown → code fences:** `src/components/Markdown.tsx`
  (`MarkdownWithHighlight`, line ~176) → `getCliHighlightPromise()` →
  `src/utils/markdown.ts` `formatToken` `case 'code'` (lines 87-121):
  `highlight.highlight(token.text, { language })` when
  `highlight.supportsLanguage(token.lang)` — **no try/catch anywhere on the
  path**, synchronous inside Ink render.
- **File previews:** `src/components/HighlightedCode.tsx` →
  `src/components/HighlightedCode/Fallback.tsx` `cachedHighlight()` →
  `hl.highlight(code, { language: extname(filePath).slice(1) })`. The 500-entry
  `hlCache` does not help: the freeze happens *inside* the first call.
- **Permission dialogs:** `src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx` (same `CliHighlight`).
- **The highlighter:** `src/utils/cliHighlight.ts` → npm `cli-highlight@2.1.11`
  → `require("highlight.js")` (full bundle, all ~190 grammars, single shared
  instance — `highlight.js@11.11.1`). cli-highlight's `highlight()` has **no
  try/catch** (`node_modules/cli-highlight/dist/index.js:83-93`).

Stock grammars carry the identical cascade rules (§1e): `xml.js:173-182` +
`handlebars.js:189,204`. Nothing in OCC bounds emitter work or mode depth.

### 3b. Probe results (freeze demonstrated)

Probes: `/tmp/occ-probe/probe.mjs`, `combo.mjs`, `run.sh` (outside the repo).
Each case runs in its own `node --max-old-space-size` process under
`timeout -s KILL 10`. "FREEZE" = SIGKILL at 10 s. Adversarial inputs:
`'<script>'.repeat(n)` and `` '`${'.repeat(n) ``, fed three ways: raw hljs,
cli-highlight, and the **exact OCC markdown path** (marked.lexer of a fenced
block → `supportsLanguage` → `highlight(text,{language})`, replicating
`markdown.ts:102-120`).

| case | n | result |
|---|---|---|
| hljs `xml`, unclosed `<script>` | 8 | OK 102 ms |
| | 12 | OK 215 ms |
| | 16 | OK **1224 ms** (≈5.7× per +4 tags → ~1.5×/tag, exponential) |
| | 20 | **FREEZE** (killed @10 s) |
| | 24 | **FREEZE** |
| | 200 | **FREEZE** |
| cli-highlight `html` (OCC dep) | 16 | OK 1013 ms |
| | 200 | **FREEZE** |
| **OCC markdown path** (```html fence) | 16 | OK 1097 ms (`lang=html` resolved) |
| | 200 | **FREEZE** — OCC terminal would hang exactly like official 2.1.288 |
| hljs `javascript`, nested `${` | 25–1000 | OK 76–84 ms (linear) |
| | 2000 / 5000 | OK 89 / 99 ms |
| cli-highlight + OCC markdown path, ```javascript nested `${` | 100 / 500 / 2000 | OK 91–124 ms (linear) |
| combo `'`${<script>'.repeat(n)`, entry `xml` | 10 / 14 / 16 | OK 49 / 301 / **1065 ms** (exponential) |
| combo, entry `javascript` | 10 / 14 | OK 8 ms (subst swallows tags as text) |

**Findings:**
- Vector (a) many unclosed `<script>`: **OCC is vulnerable** — reproducible
  freeze through the production call path; a 20-tag html fence (~160 chars!)
  already exceeds 10 s. Reachable from ordinary assistant output and from
  `.html`/`.xml`/`.hbs` file previews.
- Vector (b) deeply nested `${`: **not reproducible in OCC with stock npm
  grammars** (linear to depth 5000). The official freeze likely involves
  grammars/contexts that route substitution through `subLanguage` (their
  plugin-grammar system can register such grammars — the official budget's
  fanout→∞ guard targets exactly that). OCC's exposure here is latent (any
  future bundled/plugin grammar), not current.

---

## 4. Verdicts & port sketch

### #2 — **PORT** (freeze reproduced; official mechanism fully extracted)

Port the bounded-emitter mechanism verbatim (constants included) — it fixes
vector (a) today and vector (b)/plugin-grammar variants structurally:

1. **New file `src/utils/hljsBound.ts`** (~120 lines): port of §1b —
   `HighlightBoundError`, budget constants `MAX_HEIGHT=32`, `MAX_FANOUT=64`,
   `BASE_BUDGET=4096`, `CHAR_COST=24`, `FANOUT_COST=3`, `CTOR_COST=16`
   (UPPER_SNAKE_CASE per OCC style), `boundedEmitter(Base, budget)` wrapper,
   fanout walker (grammar `subLanguage`/`contains`/`variants`/`starts`
   traversal with cycle set; uncapped-array fanout → Infinity), budget plugin
   (`before:highlight` resets `left`, `after:highlight` throws), and
   `installHighlightBounds(hljs)` guarded by a static `isBounded` flag
   (idempotent).
2. **`src/utils/cliHighlight.ts` `loadCliHighlight()`**: after
   `await import('highlight.js')`, call `installHighlightBounds(highlightJs)`.
   cli-highlight `require`s the *same* module instance (single 11.11.1 copy, no
   nested `node_modules/highlight.js`), so `hljs.configure({__emitter})` +
   `addPlugin` bounds cli-highlight's internal `hljs.highlight` call too.
   Then wrap the returned `highlight` in try/catch: on
   `HighlightBoundError` (or any throw) return the raw `code` unchanged —
   mirrors official `catch{return …plain…}`.
3. **Failure memo (official `e.lang=null`, §1d)**: in `markdown.ts`
   `case 'code'`, remember per-token failure so streaming re-renders don't
   re-attempt (simplest OCC-idiomatic form: a module-level `Set` of
   `hashPair(language, text)` bounded like `hlCache`, or catch-and-cache the
   plain result in `Fallback.tsx`'s `hlCache`). Without a memo, each Ink
   re-render of a frozen block pays one bounded-but-wasted pass; with
   budget-throw being fast this is cosmetic, but the official did memo it.
4. **Behavior parity note**: bounded blocks render **plain** (official renders
   plain too). No user-visible setting changes; `syntaxHighlightingDisabled`
   still short-circuits earlier.

**TDD fixtures (RED first):** with the current code, a test that runs
`formatToken` (or cli-highlight directly) on `'```html\n' + '<script>'.repeat(24)`
under a wall-clock bound (e.g. Bun `expect(...).toBe...` inside a 2 s
`Promise.race`/watchdog, or a spawned-probe pattern like `/tmp/occ-probe`)
fails/times out today; after the port it must return plain text in ≲100 ms.
Second test: normal html/js blocks still highlight (snapshot the ANSI output).
Third: nested `${`×2000 output unchanged (already linear — no regression).
E2E per project rules: real REPL (tmux) — paste a 24×`<script>` html fence
into the transcript path (e.g. via a file the assistant reads back or
`--print` markdown render), assert prompt stays responsive < 2 s.

### #26 — **NO-OP**

No OCC artifact-publishing surface exists (§2), and the official CLI-side
artifact pipeline is byte-identical between 288 and 289 — the fix is on
claude.ai's serving side. Nothing to port; record in the 289 tracker as
`not-applicable (no artifact surface)`.

---

## Appendix — evidence index

| Evidence | Location |
|---|---|
| Bounded emitter + budget plugin (NEW) | `s289.txt @17551578` (code), sorted `s289s.txt:215064`; absent in s288 (0 hits `HighlightBoundError`/`isBounded`/`highlighting this text takes`) |
| `core()` unbounded | `s288.txt @17497153` |
| `core()` + `Se(n)` | `s289.txt @17553789` |
| Renderer catch (no memo) | `s288.txt @36964904` |
| Renderer catch + `e.lang=null` memo | `s289.txt @37062551` |
| Artifact browser runtime (identical) | `s289.txt @27780214` / `s288.txt @27700109` |
| Bundle validator (identical, 1691 B) | `s289s.txt:295339` / `s288s.txt:295341` |
| Vendored hljs core (identical) | `s289.txt:419821` / `s288.txt:418736` |
| OCC probes | `/tmp/occ-probe/{probe.mjs,combo.mjs,run.sh}` |
