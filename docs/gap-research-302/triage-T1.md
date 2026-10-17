# Gap research — Claude Code 2.1.302 triage T1

Scope: changelog entries **#01, #04, #05, #07, #08, #14, #19, #28, #29, #36**
(cluster T1: API/model/compaction/telemetry/auth/network), official `2.1.302`
vs `2.1.301`, triaged against OCC @ branch `agent/occ/e7e15363`
(aligned through 2.1.301 honest-partial; entry list `docs/gap-research-302/entries-63.txt`).

Method: static forensics ONLY on the two Bun-compiled linux-x64 ELFs
(`/tmp/cc-diff-302/v301/package/claude` md5 `7f52c3d8eda2796a6002cb7380aabfb9`,
`/tmp/cc-diff-302/v302/package/claude` md5 `39885c1377a0f0d922b73bf8653a6c3f`).
No official binary was ever executed, chmod'ed, or piped into an interpreter.
Every offset below is a byte offset produced by `grep -aboF "<marker>"`; every
excerpt is a bounded `dd if=<elf> bs=1 skip=<off> count=<n> iflag=skip_bytes | tr -d '\000'`.
**Caveat applied throughout:** v302 embeds its changelog text inside the ELF
(~252.0M and ~267–278M regions) — new-string hits there are changelog noise,
not code, and were excluded before counting any delta.

Disposition vocabulary: **PORT** (land it), **STAGED** (recovered but not
wired), **N-A** (surface absent/trimmed in OCC by design), **ALREADY-ALIGNED**
(observable behavior already matches), **CAND** (candidate, unevidenced — no
byte-level delta found after an exhaustive search; NOT a guess about behavior).

Summary: 5 PORT · 4 N-A · 1 CAND (plus one STAGED sibling item under #07).

---

## #01 — `CLAUDE_CODE_AUTO_MODE_MODEL`

> Added `CLAUDE_CODE_AUTO_MODE_MODEL` to choose the model the client-side auto
> mode classifier uses; it does not change the model for server-side auto mode

**Disposition: PORT (M)**

### Binary evidence

v301 has the env-var string but **zero consumers** (matches "Added" in 302).
v302 resolver `HYe` @ **244374771** — full model-resolution ladder for the
client-side auto-mode classifier:

```js
function HYe(e){
  let n=a_e(e);              // org-policy vetting (wte policy, WMo safeguards)
  // 1. server config: GrowthBook tengu_auto_mode_config
  //    → modelByMainModel (wildcard-prefix matcher RYt) → model
  // 2. env CLAUDE_CODE_AUTO_MODE_MODEL — used only if config did not set one;
  //    when shadowed, warn-once "env:shadowed" via loggedPolicySkips Set
  // 3. externalSonnet5Probe
  // 4. built-in default
}
```

Config-wins-over-env precedence is explicit: when the server config supplies a
model, the env value is skipped and a warn-once (`loggedPolicySkips` Set keyed
`env:shadowed`) is logged. Org-policy vetting `a_e` denies models blocked by
policy `wte` / safeguards `WMo`. `RYt` implements wildcard-prefix matching for
`modelByMainModel` keys. The changelog's "does not change the model for
server-side auto mode" is honored structurally: the server-side (arbiter)
classifier path resolves its model server-side and never consults this ladder.

### Semantics (from the code, not inferred)

- Env `CLAUDE_CODE_AUTO_MODE_MODEL` selects the client-side auto-mode
  classifier model.
- Precedence: server config (`modelByMainModel` wildcard match, then `model`)
  > env (warn-once when shadowed) > external Sonnet-5 probe > default.
- Org policy can veto the chosen model.

### OCC findings

- `src/utils/permissions/yoloClassifier.ts:1516-1520` — OCC has an env-based
  classifier-model override but it is (a) gated behind `USER_TYPE === 'ant'`
  and (b) prioritized **over** config — inverted vs official (config wins, env
  shadowed with warn-once, no ant gate).
- Zero `modelByMainModel`, `loggedPolicySkips`, `externalSonnet5Probe`, or
  `arbiter` hits anywhere in OCC `src/`.

### Implementation note

Port the official ladder into `yoloClassifier.ts` model resolution: read
`CLAUDE_CODE_AUTO_MODE_MODEL` unconditionally (drop the ant gate), but rank it
**below** any config-supplied classifier model, with a warn-once log when the
env value is shadowed. Keep the client-side-only scope (OCC has no server-side
classifier). Complexity M: the ladder itself is small; the warn-once Set and
wildcard-prefix matcher are the only new machinery.

---

## #04 — "Prompt is too long" when stopping a turn during compaction

> Fixed a "Prompt is too long" error when stopping a turn while the
> conversation was being compacted

**Disposition: CAND**

### Binary evidence

Exhaustive marker comparison of every compaction/abort/stop region found
**rename-only deltas** (minifier letter shuffles, identical logic):

- Reactive-compact retry loop: v301 `O0n` @ ~228.7M vs v302 `eNn` — dumped
  both (scratch `/tmp/t1_301.txt`, `/tmp/t1_302.txt`); byte-for-byte identical
  modulo renames (`pt`↔`ft`, `Re`↔`Re`, `FJ`↔`qZ`, `VWr`↔`Ezr`, …), including
  the `prompt_too_long` break, `viaCreditsBoundary`, head-truncation ladder,
  `tengu_reactive_compact_triggered` event, and precomputed-swap refuse/reuse
  branches.
- All stop/abort-during-compaction markers balanced v301↔v302
  (`prompt_too_long`, `hasAttempted`, `precomputedSwap`, `spinnerHintText`,
  `onCompactEvent`, `summary` reset events — equal counts, identical contexts).

No isolatable byte-level delta survived the sweep; the fix is either a
rename-masked single-token change inside one of the identical-looking regions
or lives in a chunk whose strings did not move.

### Semantics (from the code, not inferred)

Not recoverable statically — nothing in the diff isolates the change. Per
triage discipline: never invent official behavior.

### OCC findings

- OCC's reactive-compaction/stop paths: `src/services/compact/autoCompact.ts`,
  `src/QueryEngine.ts` (abort handling), `src/query.ts`. No known OCC bug
  report matching "stop during compaction → Prompt is too long".

### Implementation note

No port this round. If OCC ever reproduces the symptom (stop a turn mid
compaction → next request 400s with prompt_too_long), re-triage against a
future official release where the delta may be isolatable. CAND per 301
precedent — recorded, unevidenced, not guessed.

---

## #05 — `diagnostics: Extra inputs are not permitted` after provider switch

> Fixed requests failing with "diagnostics: Extra inputs are not permitted"
> after switching to Vertex or Bedrock mid-session

**Disposition: N-A**

### Binary evidence

Fix isolated cleanly. v301 @ **228774237**:

```js
...Qb(rt,XEe)&&...{diagnostics:{previous_message_id:nt??null}}
```

`XEe = k("cache_diagnosis","cache-diagnosis-2026-04-07")` @ **218546109** — a
**sticky** GrowthBook-gated beta registration: once latched in the session's
beta registry, `Qb(rt,XEe)` stayed true even after a mid-session switch to
Vertex/Bedrock, which reject the `diagnostics` request field → "Extra inputs
are not permitted".

v302 @ **246132679**:

```js
...ej()&&...{diagnostics:{previous_message_id:nt??null}}
```

with fresh per-request gate @ **246113820**:

```js
ej=()=>fRn()&&pE(rt,Vht)
```

`fRn` @ **246085631** ≡ v301 `RKr` @ **228727308** (provider switch:
firstParty→`sge`, anthropicGoogleCloud→`IH`, bedrock/vertex/gateway etc→
`false`) — i.e. v302 re-evaluates provider capability + beta registration at
request time instead of trusting the sticky flag.

### Semantics (from the code, not inferred)

`diagnostics.previous_message_id` (cache-diagnosis beta) is now attached only
when the **current** request's provider supports it, so a mid-session provider
switch can no longer leak the field into a Vertex/Bedrock request.

### OCC findings

- Zero `previous_message_id`, `cache-diagnosis`, `cache_diagnosis`, or
  `diagnostics:` request-field hits in OCC `src/`. OCC never adopted the
  cache-diagnosis beta or the diagnostics request field at all.

### Implementation note

Nothing to port — the fixed surface does not exist in OCC. If OCC ever adopts
cache-diagnosis, adopt the v302 shape (per-request provider gate) directly,
never the v301 sticky-flag shape.

---

## #07 — `/autocompact` + `/effort` saving to the wrong model (gateway prefix)

> Fixed `/autocompact` and `/effort` saving to the wrong model when a gateway
> names Opus 4 or 4.1 with a prefix, such as `anthropic/claude-opus-4-1`

**Disposition: PORT (S)** — plus one STAGED sibling (per-model `/effort`
persistence, below)

### Binary evidence

The settings-key derivation shared by the `/effort` and `/autocompact` tables
changed. v301 @ **220815700** (effort table block):

```js
// v301: vG = Ht ∘ Ke ∘ xt   (unconditional specifier normalization)
function Ne(e,n){return ETo(e,{effortLevel:n},{effortLevel:n})}
function ETo(e,n,r){let s=vG(e);
  return Object.hasOwn(Object.prototype,s)?r:{modelSettings:{[s]:n}}}
```

`xt` (v301 @ **219688663**, recovered verbatim) is the full user-specifier
parser: alias switch (`fable`/`opusplan`/`sonnet`/`haiku`/`opus`/`best`),
legacy-Opus remap `if(du()&&yXe(h)&&_$t())return s?tR(qj(Wg())):Wg()`, 1m
branches. v301's key builder ran that remap **unconditionally**, so a gateway
model named `anthropic/claude-opus-4-1` was remapped to the default Opus
before becoming the settings key → saved under the wrong model.

v302 @ **237166167** replaces the inner stage:

```js
// v302: LG = Pt ∘ Ke ∘ dFt   (alias-conditional normalization)
function dFt(e){return Xge(e.toLowerCase().trim())?Ot(e):e}
```

`Xge` tests membership in the alias list `sU`; `Ot` ≡ v301 `xt`. So specifier
normalization (incl. the legacy-Opus remap) now applies **only when the input
is a bare alias** (`opus`, `sonnet`, …); a concrete model string — prefixed or
not — passes through to `Ke` (override/canonical resolution, v301 @
**219683761**, unchanged) untouched. Same builder feeds both tables:
`/effort` (`kxr`/`Txr`/`ETo` → `_Ir`/`bIr`/`rRo`) and `/autocompact`
(`I8t`/`pmr` → `F9t`/`ehr`).

### Semantics (from the code, not inferred)

- Settings key = canonicalize(specifier) where specifier normalization is
  alias-conditional, not unconditional.
- `anthropic/claude-opus-4-1` → key derives from the gateway name itself
  (canonical `claude-opus-4-1`), never from the remapped default Opus.
- Bare `opus` still normalizes through the alias switch (incl. legacy remap).

### OCC findings

- `src/utils/model/model.ts:917-1000` `parseUserSpecifiedModel` ≡ official
  `xt` (alias switch, legacy remap behind
  `isAnthropicOwnedProvider() && isLegacyOpusFirstParty(modelString) &&
  isLegacyModelRemapEnabled()`; `LEGACY_OPUS_FIRSTPARTY` :1044-1049 ≡ `SU`).
- `src/utils/model/model.ts:617-621` `getCanonicalName` →
  `firstPartyNameToCanonical` (:503+, substring ladder + fallback regex
  `/(claude-(\d+-\d+-)?\w+)/`) — `"anthropic/claude-opus-4-1"` →
  `'claude-opus-4-1'` ✓ (prefix immune, matching the official fix's outcome),
  but bare `"opus"` → `"opus"` ✗ (alias leaks through as a literal key — OCC's
  own comment at :1046 acknowledges this).
- Autocompact table keys use `getCanonicalName(model)` on the **resolved**
  model: `src/commands/autocompact/autocompact-noninteractive.ts:75,118`,
  `src/utils/autoCompactWindow.ts:227,291,624,649-654` (writer with
  `Object.prototype` guard — ≡ official `ETo`). Resolved-input path is already
  immune to the remap leak (equivalent to `LG` for resolved inputs).
- `/effort` side: `src/commands/effort/effort.tsx` `setEffortValue` persists a
  **top-level** `{effortLevel}` via `updateSettingsForSource('userSettings')`
  — the legacy v300-era shape, not official v301/v302's per-model
  `modelSettings[LG(model)].effortLevel` (read path `kxr` returns
  `{default, legacyUserEffort, byModel}`; `Txr` consults legacy top-level only
  when `vTo(r)`). `src/utils/effort/cap.ts:63-93` already canonicalizes
  `modelSettings` keys via `getCanonicalName`.
- Wiring sites where a **raw** user specifier can reach key derivation:
  `src/main.tsx:2487,2506,3428` (`effectiveMainLoopModel` possibly raw),
  vs resolved paths `src/query/QueryEngine.ts:586-588`,
  `src/daemon/workflowWorker.ts:83`, `src/entrypoints/mcp.ts:363`,
  `src/cli/print.ts:3212`.

### Implementation note

PORT (S): add the official alias-conditional normalizer (`dFt` shape:
`isKnownAlias(s.toLowerCase().trim()) ? parseUserSpecifiedModel(s) : s`) and
use it at every settings-key derivation site —
`autoCompactWindow.ts:227,291,624,649` and
`autocompact-noninteractive.ts:75,118` — so a bare alias resolves before
`getCanonicalName` and a concrete (incl. gateway-prefixed) name never passes
through the alias/remap ladder. This closes OCC's remaining leak
(`getCanonicalName("opus") === "opus"` as a literal key).
STAGED sibling: migrating `/effort` persistence from top-level `effortLevel`
to per-model `modelSettings[key].effortLevel` (official `Ne`/`ETo` + `kxr`/
`Txr` read path, both recovered verbatim) is a separate, larger change —
record it with the recovered shapes but do not bundle it into this fix.

---

## #08 — prompt cache miss when an added tool is loaded again

> Fixed a prompt cache miss when a tool added mid-session was loaded again
> through ToolSearch or after compaction

**Disposition: PORT (M)**

### Binary evidence

The ToolSearch cache-invalidation class (`maybeInvalidate`) is **identical** in
both versions (v301 @ ~**224332068** ≡ v302 @ ~**241635610**, refs 4/4) — the
fix is in the tool's `call()`. v302 @ **244203400–244206600** (v301 counter-
part @ **226866600–226868700** lacks both helpers):

```js
Kt=(Un)=>{if(be===void 0||be.size===0)return[];
  let so=LX([],Z5(De),Un);
  return so.length>0&&so.every((Jn)=>be.has(Jn.name))?so.map((Jn)=>Jn.name):[]}
Yt=(Un)=>(so)=>Un.length===0?so:{...so,
  newMessages:[...so.newMessages??[],Ce({content:
    `Already available in this conversation: ${Un.join(", ")}. Call ${Un.length===1?"it":"them"} directly; no search is needed.`,
    isMeta:!0})]}
```

`be` = set of already-loaded tool names; `LX` ≡ resolver (`Rqe`), `Z5(De)` =
searchable pool. Two short-circuits added:

- **select path**: each `select:<name>` splits via `[Go,Kt(Go)]` into loaded
  (`Jn`) / to-search (`no`); if everything requested is loaded →
  `t("ToolSearchTool: select of already-loaded …"), zt([],"select")` and return
  an **empty matches** result (wrapped through `Yt`) — the tools array is not
  touched.
- **keyword path**: exact-name pool hit →
  `Kn=Gn===void 0?[]:Kt(Gn); if(Kn.length>0) return t("ToolSearchTool: keyword query names already-loaded …"), zt([],"keyword"), Yt(Kn)(await ot(MD([],_e,ze.length,[])))`;
  partial overlap wraps the normal result via `dn=Yt(...)`.

Re-loading a previously loaded tool no longer mutates the tools array → the
system-prompt tools block stays byte-stable → prompt cache preserved. The user
sees an `isMeta` message telling the model the tool is already available.

### Semantics (from the code, not inferred)

- "Loaded again" = every requested name already in the loaded set → return
  empty `matches` + isMeta `newMessages`
  `Already available in this conversation: X, Y. Call them directly; no search is needed.`
- Applies to both `select:` and exact-name keyword fast paths; partial overlap
  only appends the isMeta note for the loaded subset.

### OCC findings

- `src/tools/ToolSearchTool/ToolSearchTool.ts` (471 lines):
  `maybeInvalidateCache` :91/:332 already ported (identical class).
  Keyword exact-match fast path :194-204 returns `[exactMatch.name]` from the
  `tools` fallback with comment "selecting an already-loaded tool is a
  harmless no-op that lets the model proceed without retry churn" — this
  re-emission of loaded tools **is** the cache-miss bug the official fixed.
  Select path :358-410: same "harmless no-op" comment (:359-361);
  `findToolByName(deferredTools) ?? findToolByName(tools)` → `found` includes
  already-loaded tools, which get re-added → tools-array mutation → cache miss.
- `buildSearchResult` :110 returns `{data:{matches,query,total_deferred_tools,
  pending_mcp_servers?}}` — no `newMessages` support yet.
- Infra exists: `src/Tool.ts:412` (`newMessages?` on tool results),
  `src/tools/SkillTool/SkillTool.ts:1017-1063` (precedent appending
  `tagMessagesWithToolUseID`-wrapped meta messages), `src/utils/messages.ts:657
  /673/710` (`isMeta`).

### Implementation note

PORT (M): in `ToolSearchTool.ts`, add a loaded-set check (OCC's live tools
array names) mirroring `Kt`; on all-loaded select/keyword hits return empty
`matches` and extend `buildSearchResult` to carry `newMessages` with the
verbatim isMeta text `Already available in this conversation: ${names.join(", ")}. Call ${names.length===1?"it":"them"} directly; no search is needed.`
(Tool.ts:412 already supports the field; follow the SkillTool precedent for
tool-use-ID tagging). Replace both "harmless no-op" code paths (:194-204,
:358-410) — the official v302 evidence shows re-emission is exactly what broke
the cache. Keep the debug log strings (`ToolSearchTool: select of
already-loaded …`, `ToolSearchTool: keyword query names already-loaded …`).

---

## #14 — OTel `tool_decision`: `classifier_category` + attribute eviction

> Fixed `classifier_category` missing from OpenTelemetry `tool_decision`
> events for most auto mode classifier blocks, and new `tool_decision`
> attributes pushing out `tool_use_id`, `tool_source` and `tool_parameters`
> when `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT` is low

**Disposition: part A N-A (server-side classifier absent) + part B PORT (M)**

### Binary evidence

**Part A — classifier_category fallback.** Builder `Zfe` (v301 @
**226411221**) ≡ `Dpe` (v302 @ **243751425**) renamed, but its category
source changed inside caller `RYr`:

```js
// v301: S = Zfe(e.category)
// v302: S = Dpe(e.model===hG && !y ? fLs(e.reason) : e.category)
```

`hG` @ **243738648** = `"The server-side auto mode classifier"` (model-tag for
arbiter decisions; setters @ **243741691/243741968/243742194**), `y =
e.failureMode !== void 0` in both versions, and `fLs` @ **238721880** parses a
bracket prefix out of the reason string:

```js
function fLs(e){let n=/^\[([^[\]]{1,80})\]/.exec(e); … w0t(slug)}
```

with `w0t` @ **238721791** (≡ v301 `zrn`) slugifying against the builtin
category list (`Fko`/`Uko` @ **221513485/221515279** ≡ `_Co`/`bCo` @
**238721966/238723760** — dump-diffed identical after rename). Server-side
classifier blocks carry the category only as a `[category] …` reason prefix,
hence "missing for most auto mode classifier blocks" in v301.

**Part B — attribute reorder.** Emit sites, v301 @ **227800300** vs v302 @
**245156100** (builders `u9e` @ **227797023** ≡ `H8e` @ **245152940**
identical; `PDr` @ **220029703** ≡ `w0r` @ **237506975** =
`{tool_source: c(builtin|sdk_host_builtin_mcp|mcp)}`; `bYn` ≡ `F5n`;
`H3n` @ **216936555** ≡ `g9n` @ **234252498**):

```js
// v301
hi("tool_decision",{decision:K,source:Se,...be,permission_mode:Fl(...),
  tool_name:Ln(s.name),tool_use_id:w,...PDr(s.mcpInfo),
  ...Object.keys(Ee).length>0&&{tool_parameters:_(Ee)}},y.agentContext)
// v302
Si("tool_decision",{decision:K,source:Se,tool_name:In(s.name),tool_use_id:w,
  ...w0r(s.mcpInfo),...Object.keys(Te).length>0&&{tool_parameters:_(Te)},
  ...be,permission_mode:jl(...)},y.agentContext)
```

Core identifiers (`decision`, `source`, `tool_name`, `tool_use_id`,
`tool_source`, `tool_parameters`) now come **first**, so a low
`OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT` truncates the tail — classifier
verdict/category and `permission_mode` — instead of the identifiers. (The
third v302 `classifier_category` hit @ **252048345** is embedded-changelog
text, excluded.)

### Semantics (from the code, not inferred)

- Part A only affects decisions whose `model` is the server-side classifier
  tag; the client-side category production path is unchanged between versions.
- Part B is a pure key-order change in the emitted attribute object.

### OCC findings

- Part A: OCC's auto-mode classifier is client-side only
  (`src/utils/permissions/yoloClassifier.ts`) and already produces a
  structured `category` (JSON schema :274, stage categories :941/:1023,
  `classifierResult` :1355) **and** the `[${category}] Blocked by auto-mode
  classifier: …` reason prefix (:294-306, XML parse fallback :675-681).
  `src/utils/messages.ts:428` `ClassifierDecisionReasonLike {type,
  classifier?, reason?}`. No `arbiter`/server-side classifier anywhere in OCC
  → nothing to fix.
- Part B: `src/hooks/toolPermission/permissionLogging.ts:320-326` emits the
  **v301 order** — and is additionally missing `tool_use_id`, `tool_source`,
  and `tool_parameters` entirely (pre-existing gap vs BOTH official versions;
  `toolUseID` already in scope at :291). `classifierFields` gated on
  `source === 'config'` (:306-309, occ160 WP-C).
  `src/hooks/toolPermission/classifierDecisionTelemetry.ts` —
  `sanitizeClassifierCategory` :204-207, verdict :213-221,
  `buildClassifierToolDecisionFields` :233-268 (reads `decisionReason.category`
  :263, details-gated :267-268).
- Reusable infra for the missing attributes:
  `src/services/tools/toolExecution.ts:1386-1413` (OTEL_LOG_TOOL_DETAILS-gated
  parameter extractor: `bash_command` :1397, `full_command` :1398,
  `mcp_server_name` :1413), `src/services/analytics/metadata.ts:84-87`,
  `src/Tool.ts:553` (`mcpInfo`).

### Implementation note

PORT part B (M): at `permissionLogging.ts:320-326`, emit the full v302
attribute set **in v302 order**: `{decision, source, tool_name, tool_use_id,
...tool_source(mcpInfo → builtin|sdk_host_builtin_mcp|mcp), ...tool_parameters
(details-gated extractor), ...classifierFields, permission_mode}` — reusing
`toolExecution.ts:1386-1413` and `Tool.ts:553`; add a `w0r`-equivalent
`tool_source` helper. This simultaneously lands the eviction fix and closes
the pre-existing missing-attribute gap. Part A: no action (N-A) — OCC has no
server-side classifier; if one is ever added, adopt the `fLs` bracket-prefix
fallback then.

---

## #19 — prompt suggestions skipped after a credits-billed reply

> Fixed prompt suggestions spending usage credits on models your plan pays for
> only with credits: they are now skipped after a reply billed to credits

**Disposition: PORT (M)** (with prerequisite layer; alternatively adjudicable
N-A if the orchestrator deems usage-credits billing out of OCC scope — but OCC
has ported the claude.ai limits surfaces, so treated as in-scope)

### Binary evidence

Gate function, v301 `x(e)` @ ~**233960000** vs v302 `x(e,n)` @
~**251518900**:

```js
// v301
{let{status:n}=ca(),t=n==="allowed_warning"&&a.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION===!0;
 if(n!=="allowed"&&!t)return"rate_limit"}return null
// v302
{let{status:t,overageInUse:o}=ha(),s=…;
 if(t!=="allowed"&&!s)return"rate_limit";
 if((n??o===!0)&&!(N0()||zU()||Cte()&&TLr()===null&&GE()===null))return"usage_credits"}
return null
```

Caller: v301 `zKr` → `f=x(p)`; v302 `j4r` →
`f=x(p,o.toolUseContext.queryTracking?.billedToUsageCredits)` — i.e. the
skip decision prefers the **per-turn recorded** flag and falls back to current
limits state. Skip logger `CH`/`u0` gains the `"usage_credits"` reason; the
rest of the suggestion loop (cache_cold / unused_streak / early_conversation /
last_response_error) is identical.

Producers — response-header parse `ePo(headers,model,bigInputCond,now,_,
storageV5) → {overageInUse}` recorded at both response sites:

```js
// non-streaming @ 246083313
let ft=ePo(Et,n.model,(gf(n.model)||Vk(n.model))&&(input+cache_read+cache_creation>e2),
  w.now(),be,e.storageV5);
if(ft&&e.queryTracking)e.queryTracking.billedToUsageCredits=ft.overageInUse===!0
// streaming @ 246195727 — same, plus pre-existing answeredQuerySource=Q.querySource
```

Override predicates `N0`/`zU`/`Cte`/`TLr`/`GE` were **not** resolvable to
source (minified single-use helpers); per discipline they are not invented —
port conservatively (see note).

### Semantics (from the code, not inferred)

- After any reply whose billing headers indicate usage-credits overage was
  consumed (`overageInUse === true`), prompt suggestions are suppressed for
  the turn with reason `usage_credits`, unless an override predicate applies.
- The flag is recorded per query on `queryTracking.billedToUsageCredits` at
  both streaming and non-streaming response sites.

### OCC findings

- `src/services/PromptSuggestion/promptSuggestion.ts:107-119`
  `getSuggestionSuppressReason` = exact v301 gate (disabled /
  pending_permission / elicitation_active / plan_mode /
  `USER_TYPE==='external' && currentLimits.status!=='allowed'` → `rate_limit`).
- Zero `overageInUse` / `billedToUsageCredits` / `answeredQuerySource` hits in
  OCC `src/` — the whole producer layer is absent.
- Existing infra: `src/services/claudeAiLimits.ts` (QuotaStatus from
  `anthropic-ratelimit-unified-status` header :379-380, `allowed_warning`
  :282/:333, statusListeners :182), `queryTracking` (chainId/depth)
  `src/query.ts:439-450`, `src/services/overageCreditGrant.ts` (grant API),
  `src/utils/errors.ts` already handles
  `anthropic-ratelimit-unified-overage-disabled-reason`.

### Implementation note

PORT (M), three layers, in order:
1. **Prereq** — parse the overage/credits response headers (`ePo` shape; the
   exact header names are visible in the binary's limits code OCC already
   mirrors in `claudeAiLimits.ts`) into `{overageInUse}` on the limits state.
2. Record `queryTracking.billedToUsageCredits = overageInUse === true` at
   OCC's streaming and non-streaming response sites (extend the existing
   `queryTracking` object, `src/query.ts:439-450`).
3. Extend `getSuggestionSuppressReason` with the second arg
   (`billedToUsageCredits ?? overageInUse === true`) returning
   `"usage_credits"`. The unresolved override predicates (`N0()||zU()||
   Cte()&&TLr()===null&&GE()===null`) must be ported **conservatively**: the
   safe reading from evidence is that they exempt internal/first-party-entitled
   contexts; absent resolution, gate the exemption behind OCC's existing
   internal-user checks rather than guessing five predicates.

---

## #28 — server-side classifier: too-long conversation compacts instead of denying

> Improved auto mode with the server-side classifier: a conversation too long
> for the safety check is now compacted, instead of every checked tool call
> being denied

**Disposition: N-A**

### Binary evidence

Delta isolated. Unavailable-result constructor, v301 `r0t` @ **226401400** vs
v302 `cHt` @ **243741300** — v302 adds one spread:

```js
...w===WWe&&X0t()&&{transcriptTooLong:!0}
```

`WWe = "server_call_unavailable_input_too_long"` @ **243738909** (string
existed in v301 ×3; v302 ×4 — the +1 is this new binding), `X0t` @
**243729209** = `function X0t(){return k("tengu_vivid_crayon",!0)}`
(GrowthBook, default **true**; neighbors `Y0t`=tengu_tranquil_summit,
`Q0t`=tengu_merry_popcorn, `J0t`=thirdPartyServerClassifierEnabled). The
overflow→compaction consumer is pre-existing and unchanged: `h0t`/`yHt` @
**226405300**/**243745500**:

```js
if(e.unavailable||e.transcriptTooLong||e.failureMode==="unparseable"||e.errorKind!==void 0)
  return{kind:"unavailable",...}
```

Client-side constructors (@ **227024000**/@ **244363900**) are identical in
both versions, incl. `transcriptTooLong:Boolean(io)&&!Go` — the client-side
overflow→compaction path already existed pre-302; the fix only extends it to
the **server-side** classifier's too-long error.

### Semantics (from the code, not inferred)

When the server-side (arbiter) classifier call fails with
`server_call_unavailable_input_too_long` and `tengu_vivid_crayon` is on, the
result is tagged `transcriptTooLong:true`, which routes into the existing
overflow→compaction consumer instead of the deny-everything unavailable path.

### OCC findings

- OCC has only the client-side overflow path (unchanged across official
versions): `src/services/compact/autoCompact.ts`,
  `src/utils/permissions/permissions.ts`,
  `src/utils/permissions/yoloClassifier.ts`, `src/types/permissions.ts`.
- Zero server-side-classifier surface in OCC (no `arbiter`, no
  `server_call_unavailable_*` handling).

### Implementation note

Nothing to port — the changed branch exists only for the server-side
classifier, which OCC does not have. OCC's client-side `transcriptTooLong` →
compaction behavior already matches the official client-side path.

---

## #29 — background session gateway message

> Improved the message when a background session reopened from another folder
> has no LLM gateway: it now says why, instead of "Not logged in"

**Disposition: N-A**

### Binary evidence

Full producer/consumer mechanism recovered (new-code region @
**244127500–244128900**):

```js
var dms="CLAUDE_BG_GATEWAY_WITHHELD";
function kDn(){return $t()&&Boolean(a.CLAUDE_BG_GATEWAY_WITHHELD)&&!a.ANTHROPIC_BASE_URL}
```

plus path validator `xKt` (≤1024, `isAbsolute`,
`/^[\p{L}\p{M}\p{N}/\\._~+@,:=-]+$/u`), respawn-command builder `Sjo`
(`claude respawn ${basename(CLAUDE_JOB_DIR)}` behind
`/^[A-Za-z0-9_-]{1,64}$/`), short form `Zao` ("…opened from another folder ·
respawn from …"), prefix predicate `Qao`, `AKt` = "No LLM gateway: a gateway
set in your shell isn't passed to a session opened from another folder.", and
full message `PKt` (explains the withholding + the `ANTHROPIC_BASE_URL`
settings-env alternative).

Consumer — auth-failure chain, v301 @ **226833300**
(`Vqt`→`xqt` disk-full→gateway `rHn`→fallback `Cqt()`) vs v302 @
**244169900**, which inserts before the generic "Not logged in" fallback:

```js
if(kDn())return Os({error:"invalid_request",content:PKt()})
```

Producer — bg-session spawn @ **249987438**:

```js
me=!r?.exec&&(n==="repl"||!r?.providerEnv&&!o||o===ce()),
de=!r?.exec&&!me&&o?jv(()=>$t(se)).ANTHROPIC_BASE_URL:void 0,
xe=de!==void 0&&!_f(de)?o:void 0;
if(xe)t("bg: this session's ANTHROPIC_BASE_URL is not passed to a session in another folder")
// env spread: ...xe&&{[dms]:xe}   (o = new session cwd, `cwd:o??ce()`)
```

(`_f` unresolved — nearest `function _f(` @ **249516335** is a React-internals
name collision; does not affect disposition.) Scrubber @ **249157236** deletes
the var; env registry @ **234180797**, allowlists @ **236665957**/
**238136075**, passthrough `QKr`/`H3o` @ **248507366/248509883**.

### Semantics (from the code, not inferred)

When a REPL spawns a background session whose cwd differs and the parent's
`ANTHROPIC_BASE_URL` would not be passed to it, the parent records
`CLAUDE_BG_GATEWAY_WITHHELD=<folder>` in the child env; if the child then
fails auth with no base URL of its own, it reports the gateway-withholding
explanation (with a `claude respawn <job-dir>` remedy) instead of
"Not logged in".

### OCC findings

- OCC has no bg-spawn provider-env withholding subsystem: only
  `CLAUDE_BG_DISPATCHER_*` vars exist (`src/utils/managedEnv.ts:345-346`);
  zero `CLAUDE_BG_GATEWAY_WITHHELD` / bg-isolation env hits.
- `isBackgroundSessionKind` (`src/utils/envUtils.ts:151`) exists but OCC's
  background sessions run through the self-built daemon supervisor
  (`occ daemon start` / `occ attach`), not the official bg-session UI;
  `src/daemon/respawn.ts` is the supervisor ERESPAWN retry loop — a different
  feature than official `claude respawn <job-dir>`.
- Generic auth-fail message parity: `INVALID_API_KEY_ERROR_MESSAGE = 'Not
  logged in · Please run /login'` (`src/utils/errors.ts:162`, used by
  `AssistantTextMessage.tsx:43,119`) — the v301 behavior the official improved.

### Implementation note

N-A: the entire producer/consumer surface (folder-scoped gateway withholding
at bg spawn) is absent in OCC by design (daemon-supervisor architecture).
Recovered logic documented here so that if OCC ever aligns bg sessions with
the official gateway-inheritance model, the v302 message + `kDn()` gate shape
is on file. No OCC change this round.

---

## #36 — `/feedback` org-policy message now points to GitHub issues

> Changed the message shown when your organization's policy turns off
> `/feedback`: it now points to GitHub issues instead of an organization admin

**Disposition: N-A** (gate surface absent in OCC's `/feedback`; v302 wording
recovered verbatim for any future alignment)

### Binary evidence

Marker sweep: `github.com/anthropics/claude-code/issues` 607/607 balanced;
`feedback is disabled` 4/4; `disabled by your organization` 50→52 and
`disabled by your organization's policy` 33→35 — every extra v302 offset
(**277905371/278150101/274443282/278150110**, all >252M) dumps as embedded
changelog text, not code. The real delta is two v302-only strings (string
table @ **125958836** + code @ **238402142**), and the gate call site:

```js
// v301 @ 221087728:
function Mee(e="/feedback"){return Sc(e)??Pf("allow_product_feedback",e,"is")}
// v302 @ 238401500 region:
function ete(e="/feedback"){return Ec(e)??Mf("allow_product_feedback",e,"is",Eb(e))}
function HKn(){return"https://github.com/anthropics/claude-code/issues"}
function Eb(e){return`${`${e} is disabled by your organization's policy. To report a bug, open an issue at ${HKn()}.`} Issues are public, so leave out anything confidential.`}
```

The shared policy-gate helper is unchanged (`Pf` @ **220547134** ≡ `Mf` @
**238019907**, both 4-arg); its default org-denied builder (v301 `DFt` @
**218155604**):

```js
function DFt(e,n,o,r){if(dke(o).length>0)return`${e} ${n} ${p}.`;
  if(r!==void 0)return r;
  return`${e} ${n} ${p}. Contact your organization admin to enable ${n==="are"?"them":"it"}.`}
```

already supported a custom 4th-arg message — v301's feedback call passed only
3 args, so it fell through to "…Contact your organization admin to enable
it."; v302 passes `Eb(e)`, swapping in the GitHub-issues wording. Env
kill-switch branch (`Ec`/`Sc`: `DISABLE_FEEDBACK_COMMAND`,
`DISABLE_BUG_COMMAND`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) is
identical in both.

### Semantics (from the code, not inferred)

- Old message: `/feedback is disabled by your organization's policy. Contact
  your organization admin to enable it.`
- New message: `/feedback is disabled by your organization's policy. To report
  a bug, open an issue at https://github.com/anthropics/claude-code/issues.
  Issues are public, so leave out anything confidential.`
- Change is confined to the `allow_product_feedback` org-policy denial path;
  env kill-switch messages untouched.

### OCC findings

- `src/commands/feedback/index.ts:259-288` — OCC's `/feedback` is a
  prompt-type command that files issues via `gh` on `cnwenf/occ` (already
  GitHub-issues-oriented by design). Its `isEnabled` (:268-270) checks only
  the env kill-switches (`DISABLE_FEEDBACK_COMMAND`, `DISABLE_BUG_COMMAND`) —
  the `Ec(e)` half of the official gate — and has **no**
  `allow_product_feedback` org-policy gate or unavailable-reason message at
  all (`getFeedbackUnavailableReason` absent; zero "disabled by your
  organization" text in the feedback command).
- OCC does have the policy primitive: `isPolicyAllowed`
  (`src/services/policyLimits/index.ts:631`, with
  `ESSENTIAL_TRAFFIC_DENY_ON_MISS` including `allow_product_feedback` :623),
  used by `useFeedbackSurvey.tsx:136,237` / `useMemorySurvey.tsx:99,178` —
  i.e. OCC gates feedback **surveys** on the policy but not the `/feedback`
  command.

### Implementation note

N-A this round: the changed surface (org-policy denial message for
`/feedback`) does not exist in OCC — there is no message to change, and OCC's
`/feedback` already routes to GitHub issues by design (the v302 message's
intent is structurally satisfied). Optional future alignment (not part of the
302 catch-up): add `isPolicyAllowed('allow_product_feedback')` to
`feedback.isEnabled` with the recovered v302 wording (adapted repo:
`cnwenf/occ`). Recorded here verbatim so no re-forensics is needed.

---

## Cross-entry notes

- **Embedded-changelog discipline**: three entries (#14, #28, #36) produced
  false "new string" hits in v302's ~252M/~267–278M changelog regions; all
  were dump-verified as changelog text and excluded before adjudication.
- **Reusable recovered shapes** for future rounds: official per-model effort
  persistence (`Ne`/`ETo`/`kxr`/`Txr`, #07 STAGED sibling), `w0r` tool_source
  helper (#14), `ePo` overage-header parse (#19), bg-gateway withholding
  mechanism (#29), feedback policy gate wording (#36).
