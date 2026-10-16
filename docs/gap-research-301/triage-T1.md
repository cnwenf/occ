# Gap research — Claude Code 2.1.301 triage T1

Scope: changelog entries **#1, #2, #5, #6, #8, #9, #17, #18, #20, #21, #26, #40**
(official `2.1.301` vs `2.1.300`), triaged against OCC @ `docs/upstream-version-gap-occ118-2026-10.md`.

Method: static forensics ONLY on the two Bun-compiled linux-x64 ELFs
(`/tmp/cc-diff-301/v300/package/claude`, `/tmp/cc-diff-301/v301/package/claude`).
No official binary was ever executed, chmod'ed, or piped into an interpreter.
Every offset below is a byte offset produced by `grep -aboF "<marker>"`; every
excerpt is a bounded `dd if=<elf> bs=1 skip=<off> count=<n> iflag=skip_bytes | tr -d '\000'`.

Disposition vocabulary: **PORT** (land it), **STAGED** (recovered but not wired),
**N-A** (surface absent/trimmed in OCC by design), **ALREADY-ALIGNED**
(observable behavior already matches), **CAND** (candidate, unevidenced — no
byte-level delta found after an exhaustive search; NOT a guess about behavior).

Summary: 5 PORT · 1 ALREADY-ALIGNED · 2 N-A · 4 CAND.

---

## #1 — `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`

> Added `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` so unattended retry
> mode (`CLAUDE_CODE_RETRY_WATCHDOG`) ends a request at a usage limit that resets
> too far away instead of waiting

**Disposition: PORT (M)**

### Binary evidence

v301 @ **228699313** (retry-watchdog budget block; `So` = watchdog enabled, `V` = capacityWait ledger):

```js
if(So){let Mr=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS??1/0)-V.spentMs;
  if(Mr<=0)throw m("api_request","api_request_capacity_wait_exhausted"),new Rc(cn,y);
  K++;let Zn=null;
  if(cn instanceof Pt&&cn.status===429){
    if(Zn=nKr(cn,h),Zn!==null&&cn.headers?.get?.("anthropic-ratelimit-unified-status")==="rejected"){
      let hr=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS??1/0)-V.usageLimitSpentMs;
      if(Zn>hr){
        let Kr=cn.headers?.get(esn),Us=Kr==="allowed"||Kr==="allowed_warning";
        if(hr<=0||!Us&&cn.headers?.get(g9e)!=="fetch_error")
          throw m("api_request","api_request_usage_limit_wait_too_long"),new Rc(cn,y);
        Zn=Us?Math.min(hr,G$(K,null,pvn,r.random)):hr}
      Vr=cn}}
  ir=Math.min(Zn??G$(K,er,pvn,r.random),mvn),ir=Math.min(ir,Mr)}
```

v300 @ **227784334** — the same block with **no** usage-limit gate at all:

```js
if(ko){let er=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS??1/0)-V.spentMs;
  if(er<=0)throw m("api_request","api_request_capacity_wait_exhausted"),new Rc(Kt,y);
  K++;let ar=null;
  if(Kt instanceof Rt&&Kt.status===429){
    if(ar=j1r(Kt,h),ar!==null&&Kt.headers?.get?.("anthropic-ratelimit-unified-status")==="rejected")Wr=Kt}
  Vo=ar??Math.min(QU(K,No,E1r,r.random),cZe),Vo=Math.min(Vo,er)}
```

Ledger gained a second field — v301 @ **228688688**
`V=r.modelCallRetries?.capacityWait??{spentMs:0,usageLimitSpentMs:0}`;
init @ **228711516** `capacityWait:{spentMs:0,usageLimitSpentMs:0}`;
accounting @ **228701537**:

```js
if(So){let Us=Kr?Math.min(Zn,Math.round(h.monotonicNow()-hr)):Zn;
  if(V.spentMs+=Us,Vr)V.usageLimitSpentMs+=Us}
```

Header constants: `esn = "anthropic-ratelimit-unified-overage-status"`,
`g9e = "anthropic-ratelimit-unified-overage-disabled-reason"`.

Second site — v301 @ **243133750**, the `nN()` rewind gate gained
`&& a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS===void 0` before
returning `"skipped_retry_watchdog"`.

Marker occurrence counts (v300 → v301):
`CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` 0 → 3;
`api_request_usage_limit_wait_too_long` 0 → 2;
`usageLimitSpentMs` 0 → 6;
`anthropic-ratelimit-unified-overage-status` present in both.

### Semantics (from the code, not inferred)

On a 429 whose `anthropic-ratelimit-unified-status` is `rejected`, the retry-after
delay `Zn` is compared against the *remaining* usage-limit budget
`MAX_USAGE_LIMIT_WAIT_MS - usageLimitSpentMs`. If the wait would exceed it:

- budget already exhausted (`hr<=0`), **or**
- overage is not `allowed`/`allowed_warning` **and** the overage-disabled reason
  is not `fetch_error`

→ abort the request with `api_request_usage_limit_wait_too_long` (a
`CannotRetry`-class error, `new Rc(cn,y)`). Otherwise clamp the wait: overage
allowed → `min(remaining, jitteredBackoff)`; not allowed → `remaining`. Time
spent in that clamped wait is charged to `usageLimitSpentMs` **in addition to**
`spentMs`.

### OCC findings

- `src/services/api/withRetry.ts:513` — `const capacityWait = { spentMs: 0 }`
  (single-field ledger; needs `usageLimitSpentMs`).
- `src/services/api/withRetry.ts:1023-1024` — `watchdogRetryable = isRetryWatchdogEnabled() && isWatchdogRetryable(error)`.
- `src/services/api/withRetry.ts:1305-1335` — the watchdog budget block; today it
  only computes `MAX_WAIT_MS - spentMs` and throws `CannotRetryError` with
  `api_request_capacity_wait_exhausted`. This is the exact landing point.
- `src/services/api/withRetry.ts:1387-1413` — the heartbeat-chunked sleep loop
  (`capacityWait.spentMs += chunk`); needs the parallel `usageLimitSpentMs`
  charge when the retry is a usage-limit retry.
- `src/services/api/withRetry.ts:1781` — `isWatchdogRetryable`.
- `src/services/api/withRetry.ts:1573-1575` — existing note that OCC has **no**
  `rewind_limit_question` surface, so the second (rewind-gate) site is N-A for OCC.

### Implementation note

1. Read `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` (number|undefined,
   `?? Infinity`) next to the existing `MAX_WAIT_MS` read.
2. Extend the ledger type to `{ spentMs: number; usageLimitSpentMs: number }`
   (both the local `withRetry.ts:513` and any `modelCallRetries.capacityWait`
   carried across calls).
3. In the 429 branch, when the retry-after delay is non-null **and**
   `anthropic-ratelimit-unified-status === 'rejected'`, apply the gate above;
   throw the existing `CannotRetryError` with reason
   `api_request_usage_limit_wait_too_long`.
4. Track "this retry was a usage-limit retry" in a local and charge the elapsed
   chunk ms to both counters in the heartbeat loop.
5. Tests: (a) delay > remaining budget + overage `allowed` → clamped wait, no
   throw; (b) budget exhausted → throw `api_request_usage_limit_wait_too_long`;
   (c) overage not allowed + disabled-reason ≠ `fetch_error` → throw; (d) env
   unset → behavior byte-identical to today.

---

## #2 — OpenTelemetry tracing guidance in the `claude-api` skill

> Added OpenTelemetry tracing guidance to the `claude-api` skill, including
> setting up trace destinations with the `ant` CLI

**Disposition: N-A**

### Binary evidence

The official ships skill/doc markdown as zstd-packed Bun virtual-FS assets —
`/$bunfs/root/<name>-<hash>.md.zst` — so the bodies are **not** plaintext
searchable. 139 asset names in each version. `comm -13 zst300.txt zst301.txt`
shows the `claude-api` skill's docs all rehashed in v301:

```
ONLY IN v301                                   ONLY IN v300
/$bunfs/root/opentelemetry-f1b2013d.md.zst     /$bunfs/root/opentelemetry-15d274d5.md.zst
/$bunfs/root/reference-cfe6638d.md.zst         /$bunfs/root/reference-6bf44c8c.md.zst
/$bunfs/root/admin-api-787326b9.md.zst         /$bunfs/root/admin-api-9c4787b6.md.zst
/$bunfs/root/causes-dedf5d6e.md.zst            /$bunfs/root/causes-40c743d9.md.zst
/$bunfs/root/error-codes-182fa529.md.zst       /$bunfs/root/error-codes-d8bc7037.md.zst
/$bunfs/root/model-migration-809a9580.md.zst   /$bunfs/root/model-migration-64fbe83d.md.zst
/$bunfs/root/onboarding-9b47fb64.md.zst        /$bunfs/root/onboarding-0bd7ab6c.md.zst
/$bunfs/root/preserved-thinking-migration-84258a5d.md.zst  …-92104460.md.zst
/$bunfs/root/prompt-caching-44ffa968.md.zst    /$bunfs/root/prompt-caching-7e13e9e6.md.zst
/$bunfs/root/SKILL-15dc2cc1.md.zst             /$bunfs/root/SKILL-159ef46e.md.zst
/$bunfs/root/SKILL-4c45cf32.md.zst             /$bunfs/root/SKILL-1bee3906.md.zst
/$bunfs/root/SKILL-5ac63579.md.zst             /$bunfs/root/SKILL-9eb4e8d2.md.zst
```

(`claude-code.d.ts`, `config.mjs`, `ct.mjs`, `allow-tool.mjs`, `drop_block_probe.py`
also rehashed → the suffix behaves like a build-wide salt, so a hash change does
not by itself prove per-file content change.) Corroborating negative markers,
counts v300/v301: `trace destinations` 0/0, `external-key` 0/0, `CMEK` 0/0 —
the doc bodies are genuinely not in the plaintext string table.

### OCC findings

Per OCC-44 the bundled `claude-api` skill's markdown files are **intentional
1-byte stubs**:

- `src/skills/bundled/claude-api/SKILL.md` — 1 byte
- `src/skills/bundled/claude-api/shared/{error-codes,live-sources,models,prompt-caching,tool-use-concepts}.md` — 1 byte each
- No `opentelemetry.md`, `reference.md`, `admin-api.md`, `causes.md`,
  `onboarding.md`, or `model-migration.md` exist at all.

### Verdict

Nothing to port: OCC deliberately does not carry the `claude-api` skill's
reference prose. Re-evaluate only if OCC ever un-stubs those files.

---

## #5 — `classifier_verdict` + `permission_mode` on OTel `tool_decision`

> Added `classifier_verdict` and `permission_mode` to OpenTelemetry
> `tool_decision` events, so auto mode classifier decisions can be told apart
> from permission rules

**Disposition: PORT (S)**

### Binary evidence

New helper `u9e`, v301 @ **227797014**:

```js
function u9e(e,n){
  if(n?.type!=="classifier"||n.classifier!=="auto-mode")return;
  if(e==="accept")return n.classifierAllowed===!0?{classifier_verdict:"allow"}:void 0;
  let r=H3n(n);
  if(r!=="block")return{classifier_verdict:r};
  let s=Zfe(n.category);
  return{classifier_verdict:"block",...s!==void 0&&Tc()&&{classifier_category:s}}}
```

Supporting functions:

- v301 @ **216936555** — `function H3n(e){if(e.reason===WWe||e.reason===I3n)return"unavailable";return e.noVerdict?"no_verdict":"block"}`
- v301 @ **217201653** — `function Fl(e){return Ft(e).external}` (internal permission mode → external name)
- v301 @ **220028587** — `function Tc(){return a.OTEL_LOG_TOOL_DETAILS}`

Emit site A (interactive), v301 @ **227800702**:

```js
let Se=V==="config"?"config":Cir(V),
    be=V==="config"?u9e(K,n.decisionReason):void 0;
… hi("tool_decision",{decision:K,source:Se,...be,
    permission_mode:Fl(n.decision==="accept"&&n.modeAtRecheck||H),
    tool_name:Ln(s.name),tool_use_id:w,...PDr(s.mcpInfo),
    ...Object.keys(Ee).length>0&&{tool_parameters:_(Ee)}},y.agentContext)
```

v300 @ **226891991** — no classifier spread, no `permission_mode`:

```js
pi("tool_decision",{decision:K,source:be,tool_name:…,tool_use_id:w,...WOr(s.mcpInfo),…})
```

Emit site B (headless), v301 @ **228218907**:

```js
hi("tool_decision",{decision:ss,source:Qr,
  ...Qr==="config"&&So.behavior!=="ask"&&u9e(ss,So.decisionReason),
  permission_mode:Fl(no),tool_name:Ln(e.name),tool_use_id:n,...PDr(e.mcpInfo),…})
```

v300 @ **227307284** — neither addition.

Note the gating asymmetry: `classifier_*` is only spread when the decision
`source` is `"config"` (site A) / `source==="config" && behavior!=="ask"`
(site B) — i.e. auto-decided calls, exactly where a classifier verdict is
indistinguishable from a permission rule today. `permission_mode` is
unconditional. On `accept`, the mode **at recheck** (`n.modeAtRecheck`) wins.

Marker counts: `classifier_verdict` 0 → 3; `permission_mode` present in both
(existing SDK/CCR surface) but new on this event.

### OCC findings

Two `tool_decision` emit sites, both currently 3 fields:

- `src/hooks/toolPermission/permissionLogging.ts:246-250`

  ```ts
  void logOTelEvent('tool_decision', {
    decision,
    source: sourceString,
    tool_name: sanitizeToolNameForAnalytics(tool.name),
  })
  ```

- `src/services/tools/toolExecution.ts:1095-1099` (inside
  `if (!toolUseContext.toolDecisions?.has(toolUseID))`) — same three fields,
  from `mapPermissionDecisionToTelemetry(...)`.

All the inputs already exist OCC-side:

- `decisionReason` discriminated union with the `classifier` arm:
  `src/types/permissions.ts:329-347` (`classifier: string`, `reason: string`,
  `category?: string`, `noVerdict?: boolean`).
- `noVerdict` producer: `src/utils/permissions/permissions.ts:1039`.
- `category` producer: `src/utils/permissions/permissions.ts:1137` and `:1196`.
- External-mode mapper (≡ official `Fl`): `toExternalPermissionMode` +
  the `external` field of the mode metadata table,
  `src/utils/permissions/PermissionMode.ts:49,69-111`.
- `OTEL_LOG_TOOL_DETAILS` gate (≡ official `Tc`):
  `src/services/analytics/metadata.ts:84-87` (`isToolDetailsLoggingEnabled`).

Gap: `PermissionDecisionArgs`
(`src/hooks/toolPermission/permissionLogging.ts:28-31`) carries only
`{decision, source}` — no `decisionReason`, no mode. That is the plumbing work.

### Implementation note

1. Add a `classifierVerdictAttributes(decision, decisionReason)` helper next to
   `sourceToString` in `permissionLogging.ts`, mirroring `u9e` exactly:
   non-classifier / non-`auto-mode` → `{}`; `accept` → `{classifier_verdict:'allow'}`
   only when the classifier explicitly allowed; else map `reason` →
   `'unavailable'` for the two overflow/parse-error reason constants and
   `noVerdict` → `'no_verdict'`, otherwise `'block'`.
2. Extend `PermissionDecisionArgs` with optional `decisionReason` and `mode`
   (and `modeAtRecheck` for the accept path), and pass them at both emit sites.
   `toolExecution.ts` already holds `permissionDecision` and a `permissionMode`
   local in scope at :1060-1099.
3. Add `permission_mode: toExternalPermissionMode(mode)` to both events,
   unconditionally.
4. `classifier_category` is #6 — same helper, gated on
   `isToolDetailsLoggingEnabled()`.

---

## #6 — `classifier_category` on OTel `tool_decision`

> Added `classifier_category` to OpenTelemetry `tool_decision` events, naming the
> built-in rule a classifier block matched, when `OTEL_LOG_TOOL_DETAILS=1`

**Disposition: PORT (M)** — same two emit sites as #5; the extra work is the
category vocabulary.

### Binary evidence

The last line of `u9e` (above) is the whole feature:
`{classifier_verdict:"block", ...s!==void 0 && Tc() && {classifier_category:s}}`
where `s = Zfe(n.category)`.

Filter/normalizer, v301 @ **226411221**:

```js
function Zfe(e){return e!==void 0&&xAo.has(e)?Pn(e):void 0}
```

Allowlist, v301 @ **226411192**: `xAo=new Set([...Fko,...Uko])`.

- `Fko` @ **221513485** — ~60 built-in rule categories, including
  `account_standing_rule_changes`, `auto_mode_bypass`, `blind_apply`,
  `browser_*_exfil`, `ci_bypass`, `credential_exploration`,
  `credential_leakage`, `credential_materialization`, `data_exfiltration`,
  `git_destructive`, `instruction_poisoning`, `irreversible_deletion_general`,
  `merge_without_review`, `permission_grant`, `production_deploy`,
  `self_approval`, `self_modification`, `security_weaken`, `tmux_self_drive`,
  `traffic_redirection`, `unauthorized_persistence`, …
- `Uko` @ **221515279** — 6 `cowork_*` categories.

Marker counts: `classifier_category` 0 → 3; `auto_mode_bypass` 0 → N (new in
v301's string table).

### OCC findings

- `src/types/permissions.ts:330-340` documents OCC's `category` as the
  **2.1.200 three-value taxonomy** (`behavioral_risk`, `information_exposure`,
  `high_impact_operation`), not the v301 ~66-name rule vocabulary.
- `grep -rn 'auto_mode_bypass\|data_exfiltration\|git_destructive' src` → **0 hits**.
  OCC's classifier does not produce rule-level categories.
- Producers that do exist: `src/utils/permissions/permissions.ts:1134,1137,1196`.
- Gate: `src/services/analytics/metadata.ts:84-87`.

### Implementation note

Two honest options — do **not** invent a mapping between the two taxonomies:

- **(a) Faithful, preferred:** port `xAo` verbatim (the `Fko` + `Uko` arrays are
  fully recoverable from the string table at the offsets above) and implement
  `Zfe` as an allowlist filter. Until OCC's classifier emits rule-level
  categories the attribute simply never fires — which is byte-equivalent to the
  official for every decision OCC can currently make, and forward-compatible.
- **(b) Minimal:** emit `classifier_category` only when
  `decisionReason.category` is present, gated on `isToolDetailsLoggingEnabled()`,
  and document the taxonomy divergence in the file header (as
  `src/types/permissions.ts:331-338` already does).

Either way the code change is ~10 lines inside the #5 helper. Option (a) also
needs a `src/utils/permissions/classifierCategories.ts` holding the ported list.

---

## #8 — `fable` / `best` alias retry on the previous Fable model

> Fixed the `fable` (and `best`) model alias erroring on the Anthropic API when
> the newest Fable model is not available to your organization: Claude Code now
> retries once on the previous Fable model

**Disposition: CAND (candidate, unevidenced)**

### Negative search (documented so the next round does not repeat it)

Every region that could host this fix was A/B-extracted from both ELFs and
compared; all are **identical modulo minifier renames**:

| Region | v301 offset | v300 offset | Result |
|---|---|---|---|
| Alias resolver (`case"best"` / `Fa` table / `bv()` / `WL()`) | 219659270 | 218990185 | identical |
| `$c()` / `fje()` / `Fae()` / `TOe()` fable availability | 219664739 | 218990185 region | identical |
| Ladder store (`ian`/`Qr`/`FL`/`oIo`/`sIo`/`FX`) | 219649970 | 218980885 | identical |
| Tier-move machinery (`Xqn`,`pUs`,`GS`,`av`,`lv`,`iIo`,`BL`,`fUs`,`mUs`,`dv`,`Ha`) | 219654901 | 218985xxx | identical |
| `accessFallbackModel` / `crossTier` / `rungIndex` / `rungs` | — | — | offsets identical |
| `afterShrinkingFallback` notice group | 234102869 | 233315245 | rename noise only |

Occurrence counts, v300 → v301 (all **equal**): `model_not_found` 25/25,
`claude-fable-5` 80/80, `claude-fable-5-1` 37/37, `is not available to this
account` 6/6, `retry once` 18/18, `FABLE_MODEL` 36/36,
`tengu_api_model_not_found_fallback_triggered` 5/5, `fableBilling` 6/6.
New-marker probes all zero in **both**: `previousFable`, `previous Fable`,
`fablePrevious`, `not available to your organization`.

The v301 alias-resolution chain recovered verbatim (identical in v300):

```js
var Fa={fable:{available:TOe,defaultModel:()=>fje(),builtinDefault:(e)=>$c(e)}};
function bv(){let e=e4().best;if(e!==void 0&&Object.hasOwn(Fa,e)&&Fa[e]?.available())return e;return"opus"}
var uan="fable51";
function Fae(e){return e.includes("claude-fable-")}
$c(e=yw()){let n=$a("fable",e)??e.fable51;return kv(n)}
fje(){let e=a.ANTHROPIC_DEFAULT_FABLE_MODEL;return tR(e!==void 0?kv(e):$c())}
```

### Verdict

The fix is a **pure logic** change that reuses existing strings, and it did not
produce a detectable byte-level delta in any region examined. Per the
no-invention rule this is recorded as CAND, not as a guessed mechanism. To close
it, the next round should diff the *request-level* error handler that maps
`model_not_found`/403 to a retry (candidate: the same generator that hosts #1's
watchdog block, ~228.6-228.8 MB) statement-by-statement rather than by string
marker.

### OCC relevance (for when it is evidenced)

OCC's fable alias path is `src/utils/model/` (`getCanonicalName`,
`firstPartyNameToCanonical`) plus `KNOWN_CANONICAL_MODELS` in
`src/utils/model/unrecognizedModelSignal.ts:62-102`, which already registers
both `claude-fable-5-1` and `claude-fable-5`. No OCC retry-on-previous-model
logic exists.

---

## #9 — Full-disk OAuth refresh no longer says "Please run /login"

> Fixed a misleading "Please run /login" error when a full disk keeps the login
> from being refreshed; the error now names the disk and says to delete files

**Disposition: PORT (M)** — user-facing correctness fix, all pieces recoverable.

### Binary evidence

New error class (v301, ~@ **226804001** region):

```js
class wG extends Error{
  constructor(){super("OAuth access token could not be refreshed: the disk that holds the Claude Code config directory, or the disk quota on it, is full; delete files you no longer need on that disk and try again");
  this.name="OAuthRefreshDiskFullError"}}
```

New user-facing message, v301 @ **226810835** (v300 count 0 → v301 count 2):

```
Could not refresh your login: the disk that holds the Claude Code config
directory (~/.claude by default), or your disk quota on it, is full · Delete
files you no longer need on that disk, then try again · Signing in again won't help
```

(variant `OUo`, gated by `we()` ≡ non-interactive check — the interactive arm
gets the `·`-separated 3-part text, the headless arm gets
`Failed to refresh OAuth token: …`, mirroring the 2.1.287 `Q3n` split OCC
already ported.)

Error mapping, v301 @ **226834409**:

```js
if(e instanceof wG)return{...Ms({error:"invalid_request",
  content:we()?"Failed to refresh OAuth token: …":OUo}),oauthRefreshDiskFull:!0}
```

Throw site, v301 @ **228690135**:

```js
await zb(mt,r.credentials,r.storageV5,{onForcedRefreshOutcome:(to)=>{yo=to}});
… if(yo==="lock_disk_full"&&Bqr(H))
  throw m("api_request","api_request_oauth_refresh_disk_full"),new Rc(…)
```

Classification, v301 @ **234066853**:
`switch(e.oauthRefreshDiskFull?"authentication_failed":e.errorKind)`;
propagated through the query loop @ **234173289**.

Marker counts v300 → v301: `lock_disk_full` 0 → 4,
`api_request_oauth_refresh_disk_full` 0 → 2, `oauth_refresh_disk_full` 0 → 5,
`OAuthRefreshDiskFullError` 0 → 2, `cleared_disk_full` 0 → new,
`disk_unavailable1` 0 → new.

### OCC findings

- `src/services/api/errors.ts:170-173` — OCC ships the exact misleading constant
  the fix replaces:

  ```ts
  // 2.1.287 `Elt` … byte-verified identical to the official v287 constant
  export const TOKEN_REVOKED_ERROR_MESSAGE = 'OAuth token revoked · Please run /login'
  ```

  plus `INVALID_API_KEY_ERROR_MESSAGE = 'Not logged in · Please run /login'`
  (`:162`) and `getTokenRevokedErrorMessage()` (`:243+`, the 2.1.287 `Q3n`
  interactive/headless split OCC already mirrors — the natural place to add a
  disk-full arm).
- `src/utils/auth.ts:1568` — `saveOAuthTokensIfNeeded(tokens)` is where an
  ENOSPC/quota write failure surfaces.
- `src/utils/auth.ts:2007-2126` — `checkAndRefreshOAuthTokenIfNeededImpl`: the
  `catch` block at `:2107-2121` does `logError(error)` → re-read tokens →
  `return false`. **Every failure mode collapses to a silent `false`**, which
  downstream becomes the "revoked / please run /login" message. There is no
  `onForcedRefreshOutcome`-style callback and no disk-full classification
  (`grep -rn 'onForcedRefreshOutcome\|lock_disk_full\|OAuthRefreshDiskFull' src`
  → 0 hits).
- Precedent for ENOSPC detection already in the tree:
  `src/components/NativeAutoUpdater.tsx:33-34`
  (`errorMessage.includes('ENOSPC') → 'disk_full'`).

### Implementation note

1. Add `OAuthRefreshDiskFullError` (name + the byte-verbatim message) in
   `src/utils/auth.ts` or `src/services/oauth/client.ts`.
2. Classify write failures in `saveOAuthTokensIfNeeded` /
   `checkAndRefreshOAuthTokenIfNeededImpl`'s catch: `code === 'ENOSPC'` or
   `EDQUOT` (and the keychain equivalents) → throw/return the new error instead
   of `false`.
3. Add an outcome channel: `checkAndRefreshOAuthTokenIfNeeded(..., {
   onForcedRefreshOutcome })` reporting `'lock_disk_full'`, so the retry layer
   can throw `CannotRetryError('api_request_oauth_refresh_disk_full')`.
4. `src/services/api/errors.ts`: add the disk-full arm to
   `getTokenRevokedErrorMessage()` (interactive vs
   `getIsNonInteractiveSession()`), using the byte-verbatim `OUo` string; make
   sure it wins over `TOKEN_REVOKED_ERROR_MESSAGE`.
5. Tests: mocked secure-storage write throwing `ENOSPC` → assert the surfaced
   message names the disk and says "Signing in again won't help", and that
   `/login` is **not** suggested.

---

## #17 — `application-inference-profile` model switch on non-Bedrock providers

> Fixed switching to a model whose name contains `application-inference-profile`
> running your `awsAuthRefresh` command and delaying model-switch hooks when the
> provider is not Bedrock

**Disposition: ALREADY-ALIGNED** (optional S defensive gate)

### Binary evidence — the entire fix is one added provider guard

v300 @ **218791278**:

```js
function TIe(e){let n=On(e),r=Br().providerCache.inferenceProfileBackingModels,
  s=r.get(n);if(s===void 0)s=IO(n),r.set(n,s);return s}
```

v301 @ **219458892**:

```js
function cOe(e){if(xe()!=="bedrock")return Promise.resolve(null);
  let n=Mn(e),r=Wr().providerCache.inferenceProfileBackingModels,
  s=r.get(n);if(s===void 0)s=sx(n),r.set(n,s);return s}
```

`xe()` is the provider accessor. Everything downstream is unchanged — the call
sites are byte-identical between versions:

- PreModelSwitch hook, v301 @ **228906516** / v300 @ **227991685**:
  `if(J1e(n.toModel))await cOe(n.toModel)`
- PostModelSwitch hook, v301 @ **228908369** / v300 @ **227993538**
- request path, v301 @ **228737788**:
  `xe()==="bedrock"&&Q.model.includes("application-inference-profile")?await cOe(Mn(Q.model))??Q.model:Q.model`
- Bedrock token count @ **226090756**; model-picker effect @ **249285422**
- Predicates: `CPo(e){return e.includes("application-inference-profile")}`,
  `J1e(e){return CPo(e)&&typeof bTe(Mn(e))!=="string"}`
- New debug string `Running AWS auth refresh command!` (v300 0 → v301 1, @ **109871148**)

The bug was that `IO(n)`/`sx(n)` → `createBedrockClient()` → `awsAuthRefresh`
ran for **any** provider whenever the model name contained the substring, and
the `await` delayed the model-switch hooks.

### OCC findings

- `src/utils/model/bedrock.ts:154-189` — `getInferenceProfileBackingModel`
  (memoized) → `createBedrockClient()` → `refreshAndGetAwsCredentials()`
  (`src/utils/model/bedrock.ts:96`). **No provider gate** — this is the exact
  unguarded shape the official just fixed.
- Every OCC caller is already Bedrock-gated, so the observable bug cannot fire:
  - `src/services/api/claude.ts:1695-1700` — gated on
    `getAPIProvider() === 'bedrock'`.
  - `src/services/tokenEstimation.ts:152-156` and `:503-521` — Bedrock branches.
  - `src/utils/model/unrecognizedModelSignal.ts:126-134` — skips all
    inference-profile models (documented divergence at `:41-44`); never calls AWS.
- **OCC has no `PreModelSwitch` / `PostModelSwitch` hook surface at all** —
  `grep -rn "PostModelSwitch" src` yields only the name string at
  `src/utils/hooks/execMcpToolHook.ts:86`. The actual bug locus (the awaited
  hook-delaying call) does not exist in OCC.

### Verdict + optional hardening

No behavioral gap. Recommended anyway as an S-sized defensive port, because
`getInferenceProfileBackingModel` is exported and a future caller could reach it
ungated:

```ts
// src/utils/model/bedrock.ts:154
export const getInferenceProfileBackingModel = memoize(async function (profileId: string) {
  if (getAPIProvider() !== 'bedrock') return null   // ← official v301 `cOe` gate
  try { … }
})
```

---

## #18 — Short commands exiting mid token-refresh

> Fixed sign-in refresh timeouts and unexpected sign-outs after a short command
> such as `claude auth status` or `claude plugin list` exited in the middle of a
token refresh

**Disposition: PORT (S)**

### Binary evidence

Pre-exit flush helper, v301 @ **220443690**:

```js
async function MU({waitForOAuthRefresh:r=!0}={}){
  if(r)await e6n();
  try{let{flushAnalyticsSinks:e}=await import("/$bunfs/root/chunk-h5datbs6.js");await e()}catch{}}
async function Lo(r){await MU(),process.exit(r);return}
```

v300 @ **220318300** — no refresh wait:

```js
async function yU(){try{let{flushAnalyticsSinks:r}=await import("/$bunfs/root/chunk-05zppbb8.js");await r()}catch{}}
async function Mo(r){await yU(),process.exit(r);return}
```

New singleton module, v301 @ **219144207**:

```js
class e{wait=null}var t=new e;
function hjs(i){let r=t.wait;return t.wait=i,r}
async function e6n(){try{await t.wait?.()}catch{}}
export{hjs,e6n};
```

`hjs(...)` is called at **219144163** and **219771819** (registering the
in-flight refresh promise); `waitForOAuthRefresh:!1` at **244274727** (an exit
path that deliberately skips the wait). Marker `waitForOAuthRefresh` 2 → 5.

So the fix is: whoever starts a token refresh registers the promise in a
module-level singleton; the pre-exit flush awaits it (swallowing errors) before
flushing analytics and calling `process.exit`.

### OCC findings — the singleton already exists, the await does not

- `src/utils/auth.ts:1985` — `let pendingRefreshCheck: Promise<boolean> | null = null`
- `src/utils/auth.ts:1987-2005` — `checkAndRefreshOAuthTokenIfNeeded` dedupes
  concurrent calls through it:

  ```ts
  if (retryCount === 0 && !force) {
    if (pendingRefreshCheck) return pendingRefreshCheck
    const promise = checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
    pendingRefreshCheck = promise.finally(() => { pendingRefreshCheck = null })
    return pendingRefreshCheck
  }
  ```

  This is the exact analogue of official `t.wait` + `hjs`.
- `src/utils/gracefulShutdown.ts:409-556` — `gracefulShutdown()`, OCC's pre-exit
  flush (≡ official `MU`). Sequence: `commitExit()` → failsafe timer →
  `cleanupTerminalModes()`/`printResumeHint()` → `runCleanupFunctions()` (2 s
  race) → SessionEnd hooks → `profileReport()` → `tengu_cache_eviction_hint` →
  **analytics flush at `:534-540`** (`Promise.race([Promise.all([shutdown1PEventLogging(), shutdownDatadog()]), sleep(500)])`
  ≡ official `flushAnalyticsSinks`) → `drainStdoutBeforeExit()` → `forceExit()`.
  **It never awaits `pendingRefreshCheck`** — `grep -n "pendingRefreshCheck"
  src/utils/gracefulShutdown.ts` → 0 hits.
- `src/interactiveHelpers.tsx:52-79` — `exitWithError`/`exitWithMessage` take a
  `beforeExit?: () => Promise<void>` and then `process.exit(exitCode)`; short
  commands route through here (e.g. `src/main.tsx:3822`).
- Short-command surface exists in OCC: `src/cli/handlers/auth.ts:333`
  (`refreshOAuthToken` for `auth status`), plugin list, etc.

### Implementation note

1. Export from `src/utils/auth.ts`:

   ```ts
   /** Official v301 `e6n` — await an in-flight refresh before exiting. */
   export async function waitForInFlightOAuthRefresh(): Promise<void> {
     try { await pendingRefreshCheck } catch { /* official swallows */ }
   }
   ```

2. Await it in `gracefulShutdown` **before** the analytics flush
   (`src/utils/gracefulShutdown.ts`, immediately before `:534`) — matching the
   official ordering `if(r)await e6n(); …flushAnalyticsSinks()`. Keep it inside
   the existing failsafe budget (`:443-455`, `max(5000, sessionEndBudgetMs+3500)`),
   or add a short `Promise.race` cap so a hung refresh cannot eat the failsafe.
3. For the `exitWithMessage`/`beforeExit` paths that do not go through
   `gracefulShutdown`, pass `waitForInFlightOAuthRefresh` as `beforeExit`
   (or call it inside `exitWithMessage` before `process.exit`), with an
   opt-out flag mirroring official `waitForOAuthRefresh:!1` for paths that must
   not block.
4. Tests: start a refresh whose promise resolves after ~200 ms, call
   `gracefulShutdown(0)`, assert the storage write completed before exit and
   that a rejecting refresh does not change the exit code.

---

## #20 — Model switch to a smaller window spending credits without asking

> Fixed a case where switching to a model with a smaller context window could
> spend usage credits on a summary by the previous model without asking first

**Disposition: CAND (candidate, unevidenced)**

### Negative search

- The v301 model-switch subsystem cluster (v301 @ **228906123–228955711**,
  49 588 B) vs v300 ( @ **227991292–228040531**, 49 239 B), net **+349 B**,
  was extracted in full. Keyword occurrence counts are **identical** on both
  sides: `compact` 5/5, `summar` 11/11, `window` 6/6, `confirm` 2/2, `ask`
  28/28, `shrink` 0/0, `credit` 0/0. The +349 B is rename-length drift, not new
  logic in this cluster.
- No new user-facing prose exists for this fix. `new_prose.txt` (679 new
  strings) contains no switch/summary/window text beyond the autocompact-offer
  experiment (a separate server-driven A/B — see below) and the compaction-error
  renderer (see #21).
- `usage credits` count 219 → 220: the single net-new hit was traced to
  `Buy usage credits for` (@ **249712324**), whose own count is 2 → 2 — a chunk
  relocation artifact, not a new string. `amountCents` 8/8,
  `requires usage credits` 20/20, `spend usage` 2/2, `before asking` 1/1.
- Ruled out as the mechanism: the new v301 autocompact-offer A/B experiment
  (@ **249675406–249688113**: `tengu_binary_music`, `arm:["control","offer"]`,
  `tengu_autocompact_offer_shown`/`_resolved`, `will_compact_next_turn`,
  `window_not_above_default`, `Want to autocompact at ${Sr} tokens instead?`,
  `so it will be summarized on your next message`, `Keep ${us}`,
  `Autocompact at ‹ ${Sr} › tokens`, `We recommend compacting earlier`). That is
  a server-configured experiment about the autocompact **threshold**, not about
  model switching, and is not one of the assigned entries.

### OCC findings (landing points for when it is evidenced)

- `src/utils/model/contextDropNotice.ts` — OCC's recovered 2.1.286 cluster for
  exactly this shape: `fallbackContextWindows()` (`:134-141`,
  `{fromWindow, toWindow}`), `buildFallbackNoticeSuffix()` (`:191-212`, the
  `· context window 1M → 200K tokens` suffix), `composeThrashingMessage()`
  (`:230-266`, `afterShrinkingFallback`). Header note at `:18-24` records that
  the notice call site and the two thrashing-breaker sites are **STAGED, not
  wired**. Note this file models overload-driven **fallback**, not a user
  `/model` **switch**.
- `src/utils/autoCompactWindow.ts:537-627` — `resolveModelAutoWindow`,
  `chosenWindowExceedsAutoWindow` (the 2.1.300 #10 gate).
- `src/services/compact/autoCompact.ts`, `src/services/compact/compact.ts`.

### Verdict

CAND. The fix is logic-only (a confirmation gate added before the
summarize-with-previous-model call) with no new strings, and no byte delta was
located. Do not implement from the changelog text alone.

---

## #21 — Repeated compaction behind an LLM gateway naming a different model

> Fixed conversations being compacted over and over, on a model you didn't pick,
> behind an LLM gateway whose responses name a different model than the one
> requested

**Disposition: CAND (candidate, unevidenced)** — with one real adjacent find.

### Adjacent find: new compaction-error constants module + renderer (v301)

Shared constants module, v301 @ **239992961**:

```js
var UYt="No messages to compact",
    uxn="Compaction failed \xB7 conversation could not be reduced below the context limit",
    pxn="Compaction failed \xB7 attached media exceeds size limits",
    BYt="Error during compaction: ";
export{z_e,UYt,uxn,pxn,BYt};
```

v300 @ **239108360** had the same three strings **module-local**
(`var P=…,v=…,A=…`) and inlined ``Error(`Error during compaction: ${…}`)``
inside the compaction driver's catch. New v301 UI renderer:

```js
var UT="/clear to start fresh",AT="Error: ";
function IT(m){let d=m.startsWith(AT)?m.slice(AT.length):m;switch(d){
  case uxn:return zm(`conversation too long \xB7 ${UT}`);
  case pxn:return zm(`attached media too large \xB7 ${UT}`);
  case UYt:return{tone:"dim",text:UYt};
  default:break}
  let g=BYt.trimEnd();if(d.startsWith(g))return zm(d.slice(g.length).trim());
  … return null}
function zm(m){return{tone:"red",text:"Could not compact",detail:m||void 0}}
```

Marker counts v300 → v301: `Could not compact` 0 → 2,
`attached media too large` 0 → 2, `conversation too long ` 0 → 2,
`Error during compaction: ` 3 → 2. This is the **"compaction failed" surfacing**
change (and overlaps entry #28/#35 territory). It is *consistent with* #21
(a loop that could not reduce below the limit now says so once, in red, instead
of retrying silently) but it is **not** evidence of the gateway/model-name
mechanism, and must not be presented as such.

### Negative search for the gateway mechanism

- Probe markers, v300/v301 counts: `reportedModel` 0/0, `responseModel` 0/0,
  `modelMismatch` 0/0, `model_mismatch` 6/6, `requestedModel` 13/13,
  `namesake` 0/0, `compactionLoop` 0/0, `repeatedCompaction` 0/0,
  `gateway_model` 0/0, `response_model` 0/0, `reported_model` 0/0,
  `actual_model` 0/0, `modelChanged` 12/12, `renamedModel` 0/0,
  `windowOverride` 0/0, `context_window_override` 0/0, `modelWindow` 0/0,
  `unknown_model_window` 0/0,
  `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` 6/6.
- `non_first_party_base_url` (@ **224354961**) — **false positive**: 2 hits in
  v300 too, and the context shows it belongs to the ultrareview eligibility
  gate `aks()` (`"third_party_provider"`, `"remote_environment"`,
  `"entitlement"`, `"kill_switch"`, `"config_unavailable"`), not to compaction.
- `refreshedBehindModel` (v301 @ **228158379**/`228158403`/`229939679` vs v300 @
  **227247036**/`227247060`/`229020723`) — extracted ±1.5 KB around each; the
  file-read/memory-seed refresh logic is **identical modulo renames**.
- `isGatewaysOwnNow` (v301 @ **219466579**/`219468203` vs v300 @
  **218798883**/`218800507`) — extracted 3.2 KB; the gateway host-check
  (`x-cc-gateway-version`, `no-store`, proxy-407 retry) is **identical modulo
  renames**.

### OCC findings

- Carried **STAGED E-cluster #019** in
  `docs/upstream-version-gap-occ118-2026-10.md` §7 is the gateway compaction
  limit — this entry is the same neighborhood and should be triaged together
  with it rather than separately.
- `src/services/compact/compact.ts:20` already imports from
  `../api/gatewayHints.js` — OCC has a gateway-hint surface to hang a
  requested-vs-reported model check on.
- `src/utils/autoCompactWindow.ts` (window resolution) and
  `src/utils/model/contextDropNotice.ts:36-42`
  (`AUTOCOMPACT_THRASHING_MESSAGE`, "the context refilled to the limit within 3
  turns of the previous compact, 3 times in a row") — OCC has the thrashing
  *message* but, per that file's header (`:18-24`), **no rapid-refill breaker
  wired**.

### Verdict

CAND. Recommended next-round approach: diff the compaction driver `b()` around
the new constants module (v301 @ ~239992961 vs v300 @ ~239108360) statement by
statement, and separately locate where the **response** `model` field is read
back into the window computation. Do not implement the gateway model-name guard
from the changelog text alone.

---

## #26 — `/claude-api` skill CMEK external-key availability

> Fixed the /claude-api skill saying CMEK external-key endpoints aren't
> available on Claude Platform on AWS

**Disposition: N-A**

### Binary evidence

`CMEK` — **0 occurrences in both** v300 and v301 ELFs; `external-key` 0/0.
The text lives only inside the zstd-packed `/$bunfs/root/*.md.zst` skill assets
(see #2 for the full rehash table, which includes `admin-api`, `reference`,
`SKILL-*`). `prompt-audit` is 20/20 (plaintext) and unrelated.

### OCC findings

- `src/skills/bundled/claude-api/SKILL.md` and every file under
  `src/skills/bundled/claude-api/shared/` are 1-byte stubs (OCC-44).
- `grep -rn CMEK src` → **0 hits**.

### Verdict

Nothing to port — OCC does not carry the skill's reference prose, so it cannot
carry the wrong statement either.

---

## #40 — Summarize with the previous model before switching to a smaller window

> Improved switching to a model with a smaller context window: a conversation too
> long for the new model is now summarized by the previous model first

**Disposition: CAND (candidate, unevidenced)**

### Negative search

Same searches as #20 (they are the two halves of one change): the model-switch
cluster keyword counts are identical v300/v301 (`compact` 5/5, `summar` 11/11,
`window` 6/6); no new prose in `new_prose.txt`; the `for the summary` string
(1 → 5 occurrences) was traced and is **entirely** inside the new "Compacted"
row renderer, v301 @ **247543685**:

```js
function Zm(m,d,g){
  let f=m.messagesSummarized!==void 0&&m.messagesSummarized>0
        ?`${m.messagesSummarized} ${m.messagesSummarized===1?"message":"messages"} summarized`
        :m.preTokens>0?`${dr(m.preTokens)} tokens summarized`:null,
      h=g===null?f?"to see them":"for history":g.leadsToSummary?"for the summary":null;
  return{tone:"dim",text:"Compacted",detail:h===null?f??void 0:f?`${f} (${d} ${h})`:`${d} ${h}`,
    ...g?.savedIn!==void 0&&{subLines:[`Earlier messages are saved in ${g.savedIn}`]},linkify:!1}}
```

That is entry **#28** ("the compaction row in a resumed session offering ctrl+o
for history that is not loaded; it now says where the earlier messages are
saved"), not #40. String-table hits at **102555356** / **102556297** confirm the
surrounding literals (`messagesSummarized`, `preTokens`, `leadsToSummary`,
`savedIn`, `Earlier messages are saved in `, ` for history)`, ` for the summary)`)
all belong to that renderer.

### OCC findings

- `src/utils/model/contextDropNotice.ts` — see #20; the shrinking-window notice
  builders are recovered but **STAGED/unwired** (`:18-24`).
- `src/services/compact/autoCompact.ts` + `src/services/compact/compact.ts` —
  where a pre-switch summarization would have to be invoked.
- OCC has no Pre/PostModelSwitch hook surface
  (`src/utils/hooks/execMcpToolHook.ts:86` holds only the `PostModelSwitch` name
  string), so the official's model-switch orchestration point does not exist in
  OCC and a port would need a new seam.

### Verdict

CAND. #20 and #40 should be triaged as a single unit once a byte-level delta is
found; both need the same missing evidence (where the switch path decides to
compact, with which model, and what it asks first).

---

## Cross-entry observations

1. **Two of the twelve entries are pure doc/skill content (#2, #26) and are
   structurally N-A for OCC** — the official ships them as zstd `/$bunfs` assets
   whose hashes all rehash every build (including non-skill assets like
   `config.mjs` and `claude-code.d.ts`), so asset-hash diffing cannot
   distinguish a content change from a build salt. OCC's 1-byte stubs (OCC-44)
   make both moot. Any future round should record this once and stop re-triaging
   `claude-api`-skill changelog entries.
2. **#17 is a one-line provider guard, and OCC is already safe by call-site
   gating** — but `src/utils/model/bedrock.ts:154`
   `getInferenceProfileBackingModel` is exported and unguarded, so the S-sized
   defensive gate is worth taking. Note the official's actual bug locus (the
   awaited `PreModelSwitch`/`PostModelSwitch` hooks) does not exist in OCC.
3. **#18 is nearly free for OCC**: the in-flight-refresh singleton already
   exists (`src/utils/auth.ts:1985` `pendingRefreshCheck`); only the pre-exit
   await is missing (`src/utils/gracefulShutdown.ts` before `:534`). Highest
   value/effort ratio in this batch.
4. **#5 and #6 are one change**, not two — a single `u9e`-equivalent helper
   feeding both `tool_decision` emit sites
   (`src/hooks/toolPermission/permissionLogging.ts:246`,
   `src/services/tools/toolExecution.ts:1095`). #6 additionally needs a
   decision about the category taxonomy: OCC carries the 2.1.200 three-value
   taxonomy (`src/types/permissions.ts:331-338`) while v301 filters against a
   ~66-name rule vocabulary (`xAo` @ 226411192). Port the vocabulary verbatim
   rather than inventing a mapping.
5. **#1 and #9 are the two substantive ports.** Both are error-path correctness
   fixes with fully recovered byte-level evidence and both land in code OCC
   already has (`withRetry.ts` watchdog block; `auth.ts` refresh +
   `errors.ts` message split). #9 in particular fixes a message OCC ships
   verbatim today (`src/services/api/errors.ts:173`).
6. **The four CANDs (#8, #20, #21, #40) share a failure mode**: they are
   logic-only changes that reuse existing strings, so marker/offset forensics
   cannot see them. The 301 diff tooling (string set-difference, anchor deltas,
   in-place edit list) is exhausted for these. Closing them needs a different
   tool: statement-level normalized diffing of the specific subsystem chunk
   (retry/request-error handler for #8; model-switch orchestration for #20/#40;
   compaction driver for #21), or a behavioral A/B against a mock gateway.
   Recommended: do not schedule them as ports; schedule them as a *tooling*
   task first.
7. **#21 should be merged with carried STAGED E-cluster #019** (gateway
   compaction limit) — same subsystem, same gateway-vs-first-party model
   question, and OCC already has `src/services/api/gatewayHints.js` as a seam.
8. **Beware two live false positives** when re-running this triage:
   `non_first_party_base_url` (ultrareview gate, 2 hits in both versions) and
   `for the summary` (the #28 "Compacted" row renderer). Neither belongs to
   #21 or #20/#40.
9. **Minifier identifiers are not stable and do collide** — `ian(`/`wsn(` match
   both the ladder registrar and the audio `say` helper. Every call-site claim
   in this document was confirmed by first locating the *definition* pattern
   (`grep -aboE 'function NAME\('`), not by counting call sites.
10. **Unrelated-but-notable v301 addition** (not an assigned entry, do not port
    blindly): a server-driven autocompact-threshold A/B experiment
    (`tengu_binary_music`, arms `control`/`offer`) at @ 249675406–249688113,
    with new UI copy about compacting earlier to save usage. If a future round
    sees "autocompact offer" strings, that is where they come from.

## Recommended PORT order

| Priority | Entry | Complexity | Landing points |
|---|---|---|---|
| 1 | #18 | **S** | `src/utils/auth.ts:1985-2005` (export waiter) + `src/utils/gracefulShutdown.ts` before `:534` |
| 2 | #17 (defensive) | **S** | `src/utils/model/bedrock.ts:154` |
| 3 | #5 | **S** | `src/hooks/toolPermission/permissionLogging.ts:28-31,246-250` + `src/services/tools/toolExecution.ts:1095-1099` |
| 4 | #6 | **M** | same two sites + new `classifierCategories.ts` (port `xAo` verbatim) |
| 5 | #9 | **M** | `src/utils/auth.ts:1568,2107-2121` + `src/services/api/errors.ts:162-173,243+` |
| 6 | #1 | **M** | `src/services/api/withRetry.ts:513,1305-1335,1387-1413` |
