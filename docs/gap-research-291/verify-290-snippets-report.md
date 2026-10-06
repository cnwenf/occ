# Verification report — 290 binary forensic snippets (read-only, cc289/cc290/cc291)

Verifier agent output, preserved verbatim (all offsets byte-exact unless noted).
cc291 md5 `82c1f303d0dd7ef19d869f7b3d886043`, 249642168 bytes.

**Headline:** ITEM #3 = MATCH (offsets exact). ITEM #5 = MATCH (one offset mislabeled). ITEM #4 = counts match but **the interpretation of the surviving hit is wrong**. ITEM #2 follow-up = **two separate code paths**.

---

## ITEM #3 — `ps` CommandConfig — MATCH, offsets exact

**(a)** `ps:{respectsDoubleDash:!1` → cc289 = 0, cc290 = 1 @213176201 (exact). cc289's spec @209985176 (exact) begins `ps:{safeFlags:{"-e":"none","-A":"none"…` with no `respectsDoubleDash` key. The `safeFlags` map is byte-identical across versions; the only deltas are the inserted key and the rewritten callback.

**(b)** cc290 callback @213176855, 280 bytes, md5 `c4dfbfd47d2481b0cd9e7651a089058d`:

```
additionalCommandIsDangerousCallback:(e,n)=>{let r=n.some((S)=>!Cze(S)&&/[eE]/.test(S)),s=n.some((S)=>/^-[a-zA-Z]*e/.test(S)),g=n.every((S)=>S==="--forest"||/^-[AacdeFfjlwHLTm]+$/.test(S)),h=n.flatMap((S)=>S==="--forest"?[S]:S.match(/[HLTm]/g)??[]);return r||s&&!(g&&h.length<=1)}
```

Precedence confirmed exactly as written — `return r||s&&!(g&&h.length<=1)`, no parens around `s&&!(…)`, so `||` binds last. Class confirmed `/[HLTm]/g` (uppercase H L T + lowercase m, global). Also confirmed `/^-[AacdeFfjlwHLTm]+$/` (15 letters, mixed case) and `/^-[a-zA-Z]*e/`.

**(c)** `Cze` @206581431 (exact), 65 bytes, md5 `ece2c5b8194de5ad4c98dd643694a74c`:

```
function Cze(e){return e.startsWith("-")&&e.length>1&&rf.test(e)}
```

Correction on `rf`: it is a **`var` declaration with trailing semicolon** @206581406, 25 bytes, md5 `f95f6e801e3d29feabb517785ec53098`:

```
var rf=/^-[a-zA-Z0-9_-]/;
```

**(d)** cc289 callback @209985808, 108 bytes, md5 `791b587863cd6700b77d59af04089086`:

```
additionalCommandIsDangerousCallback:(e,n)=>n.some((r)=>!r.startsWith("-")&&/^[a-zA-Z]*e[a-zA-Z]*$/.test(r))
```

Semantics delta: 289 flagged only bare words matching `^[a-zA-Z]*e[a-zA-Z]*$` (letters-only, must contain `e`). 290 flags any non-flag-ish arg containing `e` **or** `E`, **or** a flag with `e` in its letter run — unless every arg is `--forest` or a `-[AacdeFfjlwHLTm]+` cluster carrying at most one of `H|L|T|m`. Strictly wider, with a narrow carve-out for the format modifiers that suppress `-e`.

---

## ITEM #4 — pyright removal — counts MATCH, "Fig completion spec" claim is WRONG

**(a)** `pyright:{` literal counts — 289 = 2, 290 = 1, 291 = 1. Identities:

| binary | offset | actual content |
|---|---|---|
| cc289 | 204054686 | ✅ real pyright CommandConfig (inside `AVo=` @204054681) |
| cc289 | 218858713 | ❌ **`copyright:{`** — HTML entity table |
| cc290 | 221670108 | ❌ **`copyright:{`** — HTML entity table |
| cc291 | 221623198 | ❌ **`copyright:{`** — HTML entity table |

`co` + `pyright:{` + `regex:/&(copy|#169)…` = the named-HTML-entity decode map, matched spuriously. Identical false positive in all three binaries; not version-sensitive, not a command spec.

**The real Fig completion spec has a different shape** — `{name:"pyright"`, present in all three: cc289 @208364391 (`var Mkt={name:"pyright",description:"Type checker for Python"`), cc290 @213481051 (`var uin=`), cc291 @213438161 (`var rin=`). Correct wording: *289 had two `pyright:{` byte hits — one real (CommandConfig), one false positive (`copyright:{`); 290/291 retain only the false positive, so the real count went 1 → 0.*

**(b)** `pyright:{respectsDoubleDash` → 289 = 1, 290 = 0, 291 = 0. cc289's object verbatim @204054681:

```
AVo={pyright:{respectsDoubleDash:!1,safeFlags:{"--outputjson":"none","--pythonversion":"string","--pythonplatform":"string","--level":"string","--stats":"none","--verbose":"none","--version":"none","--dependencies":"none","--warnings":"none"},additionalCommandIsDangerousCallback:(e,n)=>n.some((r)=>r==="--watch"||r==="-w")}}
```

Flag keys are dehyphenated (`--outputjson`, `--pythonversion`, `--pythonplatform`).

**(c)** Assembly spread offsets (corrected): cc289 `...AVo` @209993049 (not 209993069); cc290 `...CTn` @213184268 (not 213184281). 289 spreads **two** symbols (`...AVo,...gbn,`); 290 spreads **one** (`...CTn,`). `CTn` is `gbn` renamed, content unchanged.

Rename map (content-identical apart from inner minified names):

| 289 | 290 | content |
|---|---|---|
| `gbn=` @204053169 | `CTn=` @206578819 | `{"docker logs":{…},"docker inspect":{…}}` |
| `TVo=` @204053609 | `nXo=` @206579259 | `{rg:{safeFlags:{…}}}` |
| `AVo=` @204054681 | **— deleted —** | `{pyright:{…}}` |
| `qYt` | `knn` | fd/fdfind safeFlags |

⚠️ Trap: identifier `AVo` still occurs 15× in cc290 as an unrelated symbol (e.g. @242110651 hook-analytics serializer). Don't write "290 has no `AVo`" — write "no `AVo` in the read-only table assembly."

**Motive (290 adds pyright guidance prose absent from 289):** @219331639 / @219346683: "no tools that start an interpreter in the working directory (`pyright` in any form — it runs `python3` there, which imports from that directory first)". pyright spawns `python3` in cwd → never read-only → dropped from the auto-allow table AND written into allowlist-authoring guidance as a named anti-pattern.

---

## ITEM #5 — declare/typeset prefix readings — MATCH

**(a)** `function Ior(e,t){` @206276467 (exact), 350 bytes, md5 `864e651bec46d2a94aa02394f18d52ce`:

```
function Ior(e,t){let r=(o)=>Array.from({length:e},(n,l)=>o(l));if(e<=3)return{readings:Array.from({length:2**e},(o,n)=>r((l)=>Math.floor(n/2**l)%2===1)),exhaustive:!0};let s=[r(()=>!1),r(()=>!0)];for(let o=0;e<=8&&o<e;o++)s.push(r((n)=>n===o));if(t?.length===e&&!s.some((o)=>o.every((n,l)=>n===t[l])))s.push([...t]);return{readings:s,exhaustive:!1}}
```

Logic confirmed: `e<=3` → all `2**e` bitmask vectors, `exhaustive:!0`. Else seed `[all-false, all-true]`, append one-hot per `o` while `e<=8&&o<e`, then append observed reading `t` iff `t?.length===e` and not already present; `exhaustive:!1`.

**(b)** `declarationPrefix` → cc289 = 0, cc290 = 16. Offsets: 93093452, 99495404, 99495464, 99495524, 206276861, 206279410, 206279439, 213255257, 213265034, 213265394, 213265484, 213265525, 213265559, 213265582, 213265937, 225588679. The 93.x / 99.4M hits are Bun's UTF-16 string-atom tables, not JS source.

**(d)** `Az` @206276817 head verified (destructured `{plainUnquotedHeredocs:r=!1,declarationPrefix:s}={}`; early too-complex regex guards all set `differential:!0`). cc289's counterpart `zSe` has `plainUnquotedHeredocs` but zero `declarationPrefix`.

**(c)** Both reason strings verbatim in cc290, each twice (JS source + UTF-16 atom table), zero in cc289:
- `"A variable set in front of a declaration inside a branch or loop can't be checked before it runs"` — JS @206279266, atom @100783416
- `"The variables set in front of declarations in this command can't be checked before it runs"` — JS @206279549, atom @100783520

Gates verbatim (tail of `Az`, 206279050..206279790):
- **String #1 gate** = `B&&x.kind==="simple"` (@206279215), right after `x=Dt(t)`. `B` is module-scope mutable state snapshot/restored around the parse (`let c=D,d=P,f=L,g=H,u=B,m=M;` … `finally{D=c,P=d,L=f,H=g,B=u,M=m}`), initialised `B=!1` next to `D=r`, `P=s`.
- **String #2 gate** = `s!==void 0&&x.kind==="simple"&&Gt()!==s.length` (@206279503) — reading-mismatch gate: parser counted a different number of prefix assignments than the caller's reading predicted.
- Reporting direction between them: `let y=Zt();if(s===void 0&&y!==void 0)x={...x,declarationPrefixes:y.length,declarationPrefixBashKeeps:y};`
- Neither emitted object carries `differential` or `nodeType` — just `{kind:"too-complex",reason:"…"}`.
- `declarationPrefixes` / `declarationPrefixBashKeeps` / `afterHeredocDelimiter` / `sourceGlobRecord`: 0 in cc289; 6 / 3 / 3 / 4 in cc290.

**`wVe` offset correction:** @213265034 is not the function start; it's the `declarationPrefix` token inside `Az(e.command,W,{declarationPrefix:h})` which starts @213265018. The definition is @213264822: `async function wVe(e,n,r,s,g,h,S){let w=de(n),H={input:e,c` (58-byte head, md5 `b83b6092d3a9a8587fa5f37f992b3160`). cc289's counterpart `async function e6t(e,n,r,s,g)` @210070255 — 5 params → 7, so "gains a reading param + callback" is CONFIRMED.

Three further 289→290 deltas in `wVe`:
1. Sandbox-retry predicate hoisted to named boolean `Y` and **widened**: 289 inline was only `B.nodeType==="heredoc_redirect"&&B.differential===!0`; 290 adds `||q.nodeType==="pipeline"&&q.afterHeredocDelimiter===!0` (also gated on `We.isSandboxingEnabled()&&We.isAutoAllowBashIfSandboxedEnabled()&&ly(e)&&T("tengu_amber_larch",!0)`).
2. Callback path is new: `if(S!==void 0){…S(no.declarationPrefixes,no.declarationPrefixBashKeeps)}`, re-parsing with `{plainUnquotedHeredocs:!0}` only when `q.declarationPrefixes===void 0&&W&&Y`.
3. Glob validator gained options arg: 289 `N7n(Po.commands).ok` → 290 `Hor(Do.commands,{sourceGlobRecord:oye()}).ok`; retry parse 289 `zSe(…,{plainUnquotedHeredocs:!0})` → 290 `Az(…,{plainUnquotedHeredocs:!0,declarationPrefix:h})`.

`Lor` @206215067, 103 bytes, md5 `2ad9f7b77a09eaf0ee4d577771603094`:

```
function Lor(e){return/\$(?:\{(?:\([^)}]{0,32}\))?)?[#^=~+!]*(?:[A-Za-z_]\w*)?[-￿]/.test(e)}
```

---

## ITEM #2 FOLLOW-UP — two separate code paths

**Escalation call site @206279674** (final statement of `Az`, before `function Be(e` @206279777), md5 `fdb725b8fe845db69857df9119c452ef`:

```
if(x.kind==="too-complex"&&x.nodeType!=="ERROR"&&(Be(t)||Ue(t)))return{...x,nodeType:"ERROR"};return x}
```

It does NOT build a too-complex object — it spreads the already-computed result and overrides `nodeType` only. Inherits `x.reason`, `x.kind`, any `x.differential` verbatim. Role: nodeType escalation, not reason authoring. Argument is `t` (the tree), not `x`. cc289 counterpart @203775406 — same shape, one detector (`$e(n)`); 290 delta is purely `&&$e(n)` → `&&(Be(t)||Ue(t))`.

**The `b(e)` builder is a separate path.** Verbatim @206342289, 385 bytes, md5 `3410801d77d487bf719b0f63bc7e7792`:

```
function b(e){if(e.type==="ERROR")return{kind:"too-complex",reason:We(e.text)||e.text.startsWith("${")&&Lor(e.text)?"A $ followed by non-ASCII text in this command can't be checked before it runs":"Parse error",nodeType:e.type};let t=tn.get(e.type);return{kind:"too-complex",reason:`${t===void 0?"This command":`${t} in this command`} can't be checked before it runs`,nodeType:e.type}}
```

Reason string `"A $ followed by non-ASCII text in this command can't be checked before it runs"` → cc290 = 2 (JS @206342406, atom @100798180), cc289 = 0. cc289's counterpart @203832952 has **no ternary at all** (`reason:"Parse error"` bare; `_`→`b`, `Pt`→`tn`).

**Two paths, complementary:**
- `b(e)` = *reason authoring*. Per-AST-node translation; fires on `e.type==="ERROR"`; only emitter of the `$`+non-ASCII message; sets `nodeType:e.type` from the start.
- `Az` tail / `Be`+`Ue` = *nodeType escalation*. Once after the whole parse; fires only when already too-complex with `nodeType!=="ERROR"`; changes nothing but `nodeType`; never emits a reason. Downstream `kgr(e,w,q.nodeType)` routes as parse failure rather than generic too-complex.

Precision notes:
1. The `We` called by `b(e)` type-resolves to `We` @206280333 (`/^\$[#^=~+]*[\w-￿]+$/.test(e)&&/[-￿]/.test(e)`) because `b` passes a **string** (`e.text`). The other candidate @206214798 is the tree-sitter budget guard and cannot be it. Cite the offset, not the name.
2. Caveat not closable by grep alone: cc290 has 20 `function We(e){` and no module wrappers in the 206.15–206.40 MB window, so module-scope membership is not provable by byte inspection. The `b`↔`We`@206280333 link rests on the argument-type argument. Also `Lor` @206215067 physically sits 269 bytes after the *budget* `We`.
3. `e.text.startsWith("${")` occurs twice in cc290 (@206279814 in `Be`, @206342368 in `b`) but once in cc289 (@203775536 in `$e`) — operand order **swapped** between the two cc290 sites: `Be` is `(e.text.startsWith("${")||We(e.text))`, `b` is `We(e.text)||e.text.startsWith("${")&&Lor(e.text)`.
