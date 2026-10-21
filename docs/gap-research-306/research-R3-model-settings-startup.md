# Research R3 — model settings + startup warnings (official 2.1.305)

Method note: all byte evidence read-only from `/tmp/cc-diff-306/v304|v305|v306/package/claude` via `grep -aboF` offsets + targeted dumps. Novelty proved via s304/s305/s306 string counts. Offsets are absolute decimal bytes. Minified names are version-local; equivalences byte-verified.

---

## ITEM 1 — (2.1.305) `/effort` + `/autocompact` not applying when model name differs from a `modelOverrides` value by case or `[1m]` tag

**Verdict: PORT** (one-line compare change in OCC + tests)

### Byte evidence

Alias/normalizer chunk — v304 @237017700, v306 @238261300 (`CA` @238261966). v306 verbatim:

```js
function E_(e){return TY.includes(e)}
function gye(e){if(E_(e))return!0;let n=Mt(e);return n!==e&&Mt(n)===n&&E_(n)}
function Mt(e){return e.replace(/\[1m\]$/i,"")}
function CA(e,n){return Mt(e).toLowerCase()===Mt(n).toLowerCase()}
function Ln(e){return e.replace(/\[(1|2)m\]/gi,"")}
// TY=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"]
```

These primitives are **identical in v304** — the 2.1.305 fix changed the modelOverrides **value→canonical-key comparisons** at both lookup sites from strict to fuzzy:

**Forward identity resolver** — v304 `fi`/`Tv` (`Tv` @239679031), strict for the settings-configured map:

```js
function fi(e,n,r){if(e===void 0)return;for(let[s,h]of Object.entries(e)){
  if(!(r?_L(h,n):h===n))continue;           // r=false → STRICT h===n
  let S=QS(s);if(Wge(S,S))return S}return}
```

v306 `Ja`/`Iv` — **always fuzzy**:

```js
function Ja(e,n){if(e===void 0)return;for(let[r,s]of Object.entries(e)){
  if(!CA(s,n))continue;                      // strip trailing [1m] + casefold compare
  let h=sw(r);if(The(h,h))return h}return}
```

**Reverse lookup** (override value → canonical ID, i.e. OCC's `resolveOverriddenModel`): v304 `Qcn` `...for(let[r,s]of Object.entries(n))if(s===e)return r;return e` (strict) → v305/v306 `yfn` `...if(CA(s,e))return r;return e` (fuzzy). Present in s305 → fix landed in 2.1.305.

**Why this hits /effort and /autocompact**: modelSettings bucket-key normalizer is unchanged in shape (v304 `u2` ≡ v306 `D2`), but its inner identity resolution (`qe`≡`Tv`/`Iv`) now fuzzy-matches modelOverrides, so a settings key written under the canonical name resolves for a launched model given as an override ARN differing by case/`[1m]`.

### OCC current state

- `src/utils/model/modelStrings.ts:155-171` `resolveOverriddenModel` — **strict** `if (override === modelId)` = v304 `Qcn` behavior. **This is the gap.**
- `src/utils/model/modelDescriptors.ts:95-108` — OCC already owns the `CA` equivalent: `strip1mSuffix` (`replace(/\[1m\]$/i,'')`) and `modelIdsEqualAnyContext(a,b)` = `strip1mSuffix(a).toLowerCase() === strip1mSuffix(b).toLowerCase()`.
- `src/utils/model/modelGovernance.ts:167-173` `resolveWithOverrideMap` — already fuzzy (matches official explicit-`overridesMap` path, fuzzy even in v304).
- Consumer chain: `src/utils/model/model.ts:617` `getCanonicalName` = `firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))`; effort: `src/utils/effort/cap.ts:75,93`; autocompact: `src/utils/autoCompactWindow.ts:497,566,934`.

### Implementation plan

1. **`src/utils/model/modelStrings.ts`** — in `resolveOverriddenModel`, replace `if (override === modelId)` with `if (modelIdsEqualAnyContext(override, modelId))` (import from `./modelDescriptors.js`). Exactly the `Qcn`→`yfn` delta. Comment `// CC 2.1.305 (binary yfn, byte-verified)`.
2. Sweep for other strict value-comparisons against modelOverrides in `src/utils/model/` — confirm `resolveOverriddenModel` is the only site.
3. Tests: case-differs ARN override → canonical; `[1m]` suffix both directions; `getCanonicalName` integration; regression: non-matching returns input unchanged; exact match still works; per-model autoCompactWindow applies under case-shifted override ARN.

---

## ITEM 2 — (2.1.305) startup warnings → debug log; "restricts nothing" permission rules → warning rows under banner

**Verdict: PORT** (multi-file: validator + permissionSetup + main.tsx routing + REPL banner rows)

### Byte evidence

**(a) New `securityWarnings` channel in the permission-setup loop** — v306 region @255200695 (v304 counterpart @253850369 has no `S` array):

```js
S.push(`${Da(l.ruleBehavior)} rule ${yn(l.ruleValue)} never matches${P===Ir?"":
  ` · use ${P===uo?Qe:P===Yt||P===sa?ct:P}(${"…"})`}`)
S.push(`${Da(l.ruleBehavior)} rule ${yn(l.ruleValue)} matches no tool · check for typos`)
if(A.push(`Permission ${l.ruleBehavior} rule (${R}): ${T.warning}`),T.securityNotice!==void 0)
  S.push(`${Da(l.ruleBehavior)} rule ${T.securityNotice}`)
function Da(t){return t.charAt(0).toUpperCase()+t.slice(1)}
```

Return shape — v306 @~255203353: `return{toolPermissionContext:v,warnings:A,securityWarnings:S,dangerousPermissions:le,overlyBroadBashPermissions:ae,...}`.

**(b) Startup emission rerouted** — v306 @257152404 (v304 @255771104):

```js
// v306
(!_e()||L!=="json"&&L!=="stream-json"&&a.CLAUDE_CODE_SESSION_KIND!=="bg")
  ? (hs.forEach((s)=>cz(s)), rs.push(...D(Lo.securityWarnings.map(Zo))))
  : hs.forEach((s)=>t(`[permissions] ${fd(s)}`,{level:"warn"}))
// v304:  ps.forEach(_v)   ← _v ≡ UB: raw yellow process.stderr.write (the above-logo bug)
```

Helpers — v306 @257109508:

```js
function Zo(e){return vn(fd(e)).trim()}
function cz(e,{stderrPrefix:o="",items:n=[]}={}){
  let r=[Zo(e),...n.map((u)=>`  - ${Zo(u)}`)].join(`\n`);
  if(_e()){UB(o+r);return}          // non-interactive/print-text → stderr (kept)
  t(r,{level:"warn"})}               // interactive → DEBUG LOG (the fix)
```

Net: interactive TTY startup warnings move from raw yellow stderr (above the logo) to the debug log; headless print-text keeps stderr; json/stream-json/bg keeps `[permissions]`-prefixed debug-log lines.

**(c) Banner warning row (new registry entry)** — v306:

```js
X_={id:"security-warnings",tier:"warning",type:"warning",
    isActive:(m)=>m.securityWarnings.length>0,
    render:(m)=>e(Q,{children:m.securityWarnings.map((h)=>e(Nc,{status:"warning",children:h},h))})}
```

Plumbing: `rs` → prepared state `securityWarnings:rs` → REPL props → rows render via StatusMessage-like `Nc` with `status:"warning"`. The /permissions-dialog rows are byte-identical v304↔v306 — not the mechanism.

**(d) Validator `securityNotice` strings (new in 305, gated to `behavior!=="allow"`):**

```js
`${yn(s)} allows any option at its * · use an exact value`
`${yn(s)} reads its * literally${S.endsWith(":*")?"":` · use ${yn({toolName:s.toolName,ruleContent:S})}`}`
`${yn(s)} never matches · use ${yn({toolName:f,ruleContent:s.ruleContent})}`   // file-path rules matched only by Edit(path)
```

**Novelty counts (s304→s305→s306):** `securityWarnings` 0→10→10; `securityNotice` 0→3→3; `"security-warnings"` 0→2→2; `"never matches"` absent from v304. Landed in 2.1.305, unchanged in 2.1.306.

### OCC current state

- `src/main.tsx:2139-2143` — raw `warnings.forEach(warning => console.error(warning))` above the logo (= v304 bug); initResult destructures `{warnings, dangerousPermissions, overlyBroadBashPermissions}` (~:2121).
- `src/utils/permissions/permissionSetup.ts` — `shouldSkipPermissionRuleStartupWarning` (281), `formatPermissionRuleWarningLabel` (317), `collectPermissionRuleStartupWarnings` (342), return type `warnings: string[]` (1002), pushes @1179/1227/1242-1253, return @1275.
- **Zero** `securityNotice`/`securityWarnings` hits in `src/`; no banner warning-row registry. Nearest under-banner warning surface: `createSystemMessage(text, 'warning')` in `src/screens/REPL.tsx:1786,1921` rendered via `src/components/messages/SystemTextMessage.tsx`.

### Implementation plan

1. **Validator** (`validatePermissionRule` site under `src/utils/permissions/`): add optional `securityNotice?: string`; implement the three notice builders only for `behavior !== "allow"`, byte-verbatim strings from (d).
2. **`permissionSetup.ts`**: add `securityWarnings: string[]` to setup return; in the rule loop add never-matches row, matches-no-tool row (`... matches no tool · check for typos`), and `${capitalize(ruleBehavior)} rule ${result.securityNotice}` when defined; local `capitalize` (≡ `Da`).
3. **`main.tsx`**: destructure `securityWarnings`; replace the console.error loop with a `cz`-equivalent: interactive TTY → `logForDebugging(msg,{level:'warn'})`; print-text non-JSON → existing yellow stderr writer; json/stream-json/bg → `logForDebugging(`[permissions] ${msg}`,{level:'warn'})`. Format rows via `Zo`-equivalent (stripAnsi+trim); dedupe. Thread `securityWarnings` into REPL/App props.
4. **Banner rows**: render `securityWarnings` as `status:"warning"` system-message rows immediately under the banner using the existing `createSystemMessage(text,'warning')` + `SystemTextMessage.tsx` surface, gated on `securityWarnings.length > 0`. No invented registry (YAGNI); note structural divergence in ledger.
5. Tests: unit — validator notices for deny/ask only; setup loop capitalized rows; dedupe. e2e — restricts-nothing deny rule: nothing raw above logo; warning row under banner; `-p` → stderr; json → clean stderr + `[permissions]` debug line.

---

## ITEM 3 — (2.1.305) subagent fallback-model misnaming

**Verdict: SKIP-no-OCC-surface**

- No fallbackModel surface in `src/tools/AgentTool/` — model handled only at launch (`runAgent.ts:526-528,973,1069-1071`); OCC's fallback machinery lives solely in `src/query.ts:112,248,335,713-720,843,1077-1086`.
- Result assembly `AgentTool.tsx:1347-1380` returns text-only tool_result; no model metadata travels back. `UI.tsx:438-441` renders only the requested model at spawn.
- Official fix is string-less internal dataflow (candidate-phrase counts identical 304/305/306: `fallback model` 27/27/27, `Falling back to` 21/21/21, `fell back` 22/22/22). No portable string delta, no OCC counterpart surface.
