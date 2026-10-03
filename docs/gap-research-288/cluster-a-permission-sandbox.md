# Cluster A — Permission / Sandbox / Auto-mode (2.1.287 → 2.1.288)

Research round: official Claude Code 2.1.287→2.1.288 catch-up (OCC 2.1.368 target).
Method: byte-level forensics on the OFFICIAL linux-x64 binaries at
`/tmp/cc-diff-288/{v287,v288}/package/claude` (NEVER executed — `grep -aobF`
offsets + python `seek/read` byte windows only), A/B against OCC `src/`.
Offsets below are byte offsets into the ELF; the app code lives in the
>150 MB region (two copies exist — all quoted offsets are the code-region copy).
Minified names shift between versions (renames noted per entry).

Entries: #54, #57, #28, #27, #45, #15, #16, #31, #32, #72, #76.

## Verdict summary

| # | Verdict | One-line evidence |
|---|---------|-------------------|
| 54 | **PORT-CANDIDATE** | New v288 inline-shell-rm subsystem recovered in full (@209742531+); OCC probe: `findCatastrophicSubstitutionBlock('bash -c "rm -rf /"')` → null (same bypass as #96300) |
| 57 | **PORT-CANDIDATE** | v288 hook fail-closed set/predicate/builders recovered (@207801396+, generator @209522800); OCC hooks.ts fail-open at 6 sites |
| 28 | **PORT-CANDIDATE** | v288 `qe()` @203549536 adds BASHPID to integer-attr var set `fyt` (41→42); OCC `INTEGER_ATTR_SHELL_VARS` (ast.ts:187-227, 39 members) lacks it |
| 27 | **NO-OP{ALREADY-ALIGNED}** | Official delta recovered (plainUnquotedHeredocs reparse under `tengu_amber_larch`), but it fixes official's AST+sandbox path — dormant in OCC (TREE_SITTER_BASH not allowlisted); OCC live legacy path already auto-allows unquoted heredocs |
| 45 | **NO-OP{NO-SURFACE}** | Delta recovered (`_He`→`p1e` settings-override merge @210245781) but needs `sandbox.credentials.files` + `permissions.blockReadsOutsideWorkingDirectories`; OCC has neither (sandboxTypes.ts:191-200, settings/types.ts:46-88) |
| 15 | **PORT-CANDIDATE** | v288 `bKn`/`dXo` recovered (@211301793/@209972359): hint now names the actual tool and is suppressed when the tool has no allow rule; OCC messages.ts:354-373 hardcodes the Bash hint |
| 16 | **NO-OP{PLATFORM}** | v288 `k5o` bedrock/mantle old-model gate recovered (@202200032); OCC has no server classifier (`isAutoModeServerEnabled()=false`, Status.tsx:43-45) and no dangerous-tool-use beta latch |
| 31 | **PORT-CANDIDATE** | v288 `Aho`/`MIt` recovered (@208819059/@208818518): blocked_on_user span fallbacks `'unknown'` → derived decision/source; OCC sessionTracing.ts:574-578/627-632 still emits `'unknown'` |
| 32 | **PORT-CANDIDATE** | v288 removes the `behavior!=="ask"` gate on tool_decision emit (@208843300 vs v287 @207738136); OCC has the same gate shape (toolExecution.ts:1006-1015) |
| 72 | **PORT-CANDIDATE** | v288 message tables recovered in full (`_()` @203543557 sentence-case map, 11 short wrapper reasons); OCC ast.ts:2712-2765 is a byte-exact v287 port |
| 76 | **PORT-CANDIDATE** | v288 `bI()` @~202157100 adds `yI=["claude-sonnet-5-5","claude-opus-5-5"]` pin-ignore + warn-once; OCC getClassifierModel() (yoloClassifier.ts:1490-1522) honors the pin unconditionally |

PORT-CANDIDATEs ranked by security importance:
**#54 > #57 > #28 > #15 > #76 > #31/#32 > #72**.
(#54 is an actively demonstrated dangerous-rm bypass in OCC — top priority.
#57 is fail-open→fail-closed on security hooks. #28 closes a silent-allow hole.
#15/#76 are correctness of auto-mode messaging/model choice. #31/#32 telemetry.
#72 is prompt-wording only.)

---

## #54 — dangerous `rm` inside `bash -c` / `sh -c` scripts (anthropics/claude-code#96300) 🔒

> Fixed a dangerous `rm` (such as one on `/` or the home directory) inside a
> `bash -c` or `sh -c` script running without a prompt in bypassPermissions
> mode or under a shell allow rule.

### Official forensics — FULLY RECOVERED (new subsystem, v288-only)

Marker counts v287→v288: `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT` 0→4,
`inline_shell_script` 0→2, `inline_shell_unchecked` 0→2,
`__INLINE_SHELL_VALUE__` 0→7. Subsystem lives at @209742531–209770000
(dumps: `/tmp/cc-diff-288/c54_288.txt`, `c54_288b.txt`; v287 counterpart
region `c54_287.txt` has none of it). Six functions, all v288-only:

- **`C4o`** — extractor: walks the parsed AST for a command whose argv0
  matches `/^(?:r?ba)?sh$/` with a `-c` argument; pulls the script string out
  of the quoted argument; recognizes the guard idiom `${__INLINE_SHELL_GUARDED__:?}`.
- **`ZYt`** — value walker over the script's AST with depth cap `P4o=8`;
  marks values only known at runtime with the unsafe sentinel `Kk`, emitting
  `__INLINE_SHELL_VALUE__` / `__CMDSUB__` sentinels in the synthetic rebuild.
- **`DYt`** — synthetic rebuild: rejoins rewritten commands with `" && "` /
  `" ; "`, then re-judges the rebuild through the main AST permission checker
  `o4t` recursively with `{depth:S+1,budget:w}`, memoized in `w.judged`;
  telemetry `uL("inline_shell_script")`.
- **`uue`** — forced-ask builder. Verbatim messages (byte-verified @209744000+):
  - rule-denied inner command: `"A permission rule denies a command inside
    this shell -c script, so Claude Code could not check it for dangerous
    removals. Approving runs the whole script, including that command."`
    (short form: `"A permission rule denies a command in this shell -c script"`)
  - unchecked rm: `"This command passes a shell -c script that runs rm, and
    Claude Code could not check the script for dangerous removals. Approve
    only if you have read the script."`
  - `decisionReason` shape: `{type:"safetyCheck", classifierApprovable:!1,
    circuitBreaker:"dangerousRemoval"}` — same circuit breaker as the 2.1.281
    dangerous-rm family, so auto-mode/bypass cannot override it; telemetry
    `uL("inline_shell_unchecked")` when zero inner commands could be judged.
- **`A4o`** — message rewriter: when an ask's `decisionReason.reason` matches
  `/__INLINE_SHELL_|__CMDSUB/`, replaces it with the runtime-target wording
  (verbatim): `"Dangerous rm operation in a shell -c script: its target is
  built from a variable or command output known only when it runs, and if
  that is empty the rm can reach a directory like / or your home directory.
  This requires explicit approval and cannot be auto-allowed by permission
  rules. Pass a literal path, or guard the value with ${NAME:?}."`
  (short decisionReason variant: `"Dangerous rm operation in a shell -c
  script, on a target built from a value known only when it runs"`).
- **`pue`** — entry gate + budget: returns null when
  `a.CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT||!h4()` (env kill-switch, raw
  truthiness); caches per-command results in `n.budget.asked`.

Three call sites inside the main AST checker `o4t` (@209753000 region); the
v287 checker has no counterpart at any of the three (A/B verified).

### OCC state — SAME BYPASS DEMONSTRATED

- Zero surface: `grep -rn "INLINE_SHELL\|inline_shell\|shell -c"` over
  `src/` → no matches for the subsystem; the `-c` script argument is never
  inspected. bashPermissions.ts:616-617 even documents awareness of the
  `-c` pass-through hazard for wrapper rules, but nothing acts on it.
- The all-mode pre-gate `findCatastrophicSubstitutionBlock`
  (bashPermissions.ts:2465, runs even under bypassPermissions per the comment
  @2445-2462) only scans the raw outer text and `$(…)`/backtick/`<(…)`
  substitution bodies (destructiveCommandWarning.ts:1291-1376). Its rm regex
  arms are segment-anchored (`CATASTROPHIC_RM_COMMAND_RE` must match at
  segment start), so a segment beginning `bash -c "` never arms.
- **Empirical probe (bun, this round)** — all seven shapes return
  `findCatastrophicSubstitutionBlock → null` AND
  `findDestructiveCommandBlock → null`:
  `bash -c "rm -rf /"`, `sh -c 'rm -rf ~'`, `bash -c "rm -rf $UNSET/*"`,
  `bash -c 'D="$HOME"; rm -rf "$D"'`,
  `bash -c 'target=$(cat /tmp/x); rm -rf "$target"'`,
  `bash -lc "rm -rf /tmp/../../etc"`, `env bash -c "rm -rf $HOME"`.
  → Under bypassPermissions or a `Bash(bash:*)` allow rule these run
  unprompted in OCC today — exactly the #96300 report shape.
- OCC-127's subshell-hidden-rm fix (destructiveCommandWarning.ts:1271-1287
  comment; segment loop @1353-1358) covers BARE subshells/groups
  (`echo hi && (rm -rf /)`) — it does **not** cover quoted `-c` script
  arguments, because the quoted text is one argv token, not a split segment.

### Verdict: **PORT-CANDIDATE** (rank 1 — security)

Touch points:
1. New module `src/tools/BashTool/inlineShellRm.ts` porting C4o/ZYt/DYt/uue/A4o/pue
   (extractor for `/^(?:r?ba)?sh$/` + `-c`, depth-8 walker, synthetic rebuild
   re-judged through the existing permission checker, forced-ask with
   `decisionReason {type:'safetyCheck', classifierApprovable:false,
   circuitBreaker:'dangerousRemoval'}`, kill-switch
   `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT`).
2. Wire into the all-mode pre-gate in bashPermissions.ts next to
   `findCatastrophicSubstitutionBlock` @2465 so bypassPermissions and allow
   rules cannot skip it; reuse dangerousRmAutoDeny.ts for the cannot-prompt
   deny branch.
3. Tests: the seven probe shapes above must block/ask (literal forms ask with
   the unchecked-rm message; runtime-target forms ask with the A4o message);
   kill-switch disables.

---

## #57 — PreToolUse/PermissionRequest hooks fail-closed 🔒

> Fixed PreToolUse and PermissionRequest hooks being skipped when matching
> them failed or the tool's input could not be serialized to JSON; the call is
> now blocked.

### Official forensics — FULLY RECOVERED

New v288 strings (0→n): `Hook input is over the size limit` 0→3,
`hook_input_too_large` 0→3, `hook_matching_failed` 0→2. Code @207801396+
(dump verified) and generator @~209522800:

```js
var vz = new Set(["PreToolUse","PermissionRequest"]);          // guarded events
function bq(e){ /* settings opt-out check via kHn payload; catch → true (fail-closed) */ }
function Mlt(){ return Math.floor(_Hn.MAX_STRING_LENGTH/2) }    // size cap
function lee(e,n,r){ return { blockingError:{ blockingError:r, command:n },
  ...(e==="PermissionRequest" && { permissionRequestResult:{ behavior:"deny", message:r } }) } }
// Ilt = JSON-unwritable block message; Olt = matcher-failure block message
function a2t(e,n){ return n.length>Mlt() && bq(e) }             // size check
function d2t(...){ /* telemetry: "Failed to match hooks" / hook_matching_failed */ }
// C0e = script-guard-did-not-run blocking result
```

Matcher loop v288 (generator `Bzo` @~209522800; v287 @208401300 has NO
try/catch):

```js
catch(yo){ if(!V) d2t(Ne,yo);
  let Po=lee(Ne,ze,Olt(Ne,bt?void 0:yo));
  if(Po!==void 0){ yield Po; return }
  if(Wt!==void 0) throw yo;
  Bt=[] }
```

Serialization path @209530200 yields the blocking result via `lee(Ilt)`;
oversized input throws `RangeError("Hook input is over the size limit")` with
telemetry `hook_input_too_large` / `hook_input_stringify_failed`; SDK path
@209553300: `.catch((Qe)=>{ if(d2t(he,Qe), bq(he)) throw Qe; return [] })`.

Semantics: for the two guarded events, a matcher crash, a JSON stringify
failure, or an over-size payload BLOCKS the tool call (deny for
PermissionRequest) instead of silently running with no hooks — unless the
user opts out via settings (`kHn`).

### OCC state — fail-open everywhere

- hooks.ts:2546-2562, 2792, 3096-3098, 3268-3270, 3385-3397, 3500-3517 —
  matcher/serialization errors are caught and swallowed → hook skipped, tool
  call proceeds (fail-open).
- toolHooks.ts:575-592, 753-764 — PreToolUse path returns no decision on
  internal error.
- PermissionContext.ts:222-262 — PermissionRequest hook errors ignored.
- slowOperations.ts:187-191 — stringify without size cap.

### Verdict: **PORT-CANDIDATE** (rank 2 — security)

Touch points: (1) `GUARDED_HOOK_EVENTS = new Set(['PreToolUse',
'PermissionRequest'])` + opt-out settings key; (2) blocking-result builder
mirroring `lee` (blockingError + permissionRequestResult deny); (3) wrap hook
matching in try/catch → yield block; (4) wrap input serialization →
RangeError on > MAX_STRING_LENGTH/2 for guarded events, block on stringify
failure; (5) telemetry `hook_matching_failed` / `hook_input_too_large` /
`hook_input_stringify_failed`; (6) exact Ilt/Olt block-message texts to be
re-dumped from @207801396 window during implementation (offsets recorded
above; both messages fully located, quoting deferred to keep this report
compact — do NOT paraphrase them in code).

---

## #28 — BASHPID arithmetic-eval assignment now prompts

> Fixed Bash tool permission check to prompt before a `BASHPID` assignment
> whose value the shell would evaluate as arithmetic, instead of allowing it
> silently.

### Official forensics — FULLY RECOVERED

v287 `Mgt(e,n)` @202499105 → v288 `qe(e,n)` @203549536, logic identical:

```js
if(!fyt.has(e))return!1;
if(n.includes("[")||n.includes("`")||/\$\(/.test(n)||Pi(n))return!0;
if(!/^(0|[1-9][0-9]{0,17})$/.test(n))return!0;
return!1
```

Delta = the integer-attribute shell-variable set `fyt` grows 41→42 members:
`"BASHPID"` inserted after `"EPOCHREALTIME"` (byte-verified in both dumps).
Rationale: `BASHPID=1/0` etc. — the shell evaluates the RHS as arithmetic
for integer-attributed vars, so a non-numeric/unsafe RHS must prompt.

### OCC state

`src/utils/bash/ast.ts:187-227` — `INTEGER_ATTR_SHELL_VARS` has 39 members;
missing `BASHPID` (this round's delta) and also missing `BASH_MONOSECONDS` /
`BASH_TRAPSIG` (pre-existing gap vs official's 41/42-member set — verify
against the v288 `fyt` dump when porting; the official set at
@203549536-region contains both).

### Verdict: **PORT-CANDIDATE** (rank 3 — small, security-relevant)

Touch point: add `'BASHPID'` (and, after verifying against the v288 `fyt`
window, `BASH_MONOSECONDS`/`BASH_TRAPSIG`) to `INTEGER_ATTR_SHELL_VARS`;
test `BASHPID=1/0` prompts, `BASHPID=5` still silently allowed.

---

## #27 — sandboxed unquoted heredocs auto-allowed when body is plain

> Fixed sandboxed heredocs with an unquoted delimiter (`python3 <<EOF`) asking
> for approval on every run under sandbox auto-allow when the body holds only
> plain text and simple `$VAR` references.

### Official forensics — FULLY RECOVERED

- Parser signature gains an option: `function DSe(e,n,{plainUnquotedHeredocs:r=!1}={})`
  @203483618 (v288-only marker; 4 offsets: 99482008, 100630245, 203483618,
  209763041 — all v288-only).
- Heredoc checker `ae(e,n)` @~203520729: unquoted heredocs are too-complex
  UNLESS the module flag `L` (plainUnquotedHeredocs) is on and the body is
  literal text + only `simple_expansion`/`expansion` nodes whose values
  resolve to strings — implemented with regexes
  `wt=/`|\\[<space>\n]/` (backtick/backslash/newline = dynamic) and a
  generated `Et` matching `$NAME`/`${NAME}` occurrences not followed by
  `[`/`:A-Za-z&`; counts of `$` and expansions must match exactly. When it
  fails, the reject now carries a NEW flag `differential:!0`.
- New call site in the main AST checker `o4t` @~209762993 (v288-only):

```js
if(n.forRemoteExecution!==!0 && w && B.nodeType==="heredoc_redirect" &&
   B.differential===!0 && je.isSandboxingEnabled() &&
   je.isAutoAllowBashIfSandboxedEnabled() && Gh(e) &&
   A("tengu_amber_larch",!0)){
  let Mo=DSe(e.command,w,{plainUnquotedHeredocs:!0}),
      _o=Mo.kind==="simple"&&FJn(Mo.commands).ok
        ? xBe(e,h,Mo.commands,Mo.bareAssignmentNames) : null;
  if(_o!==null) return _o   // sandbox auto-allow
}
```

  i.e. a parser-differential heredoc reject under sandbox auto-allow is
  re-parsed in plain-heredoc mode; if the body is provably plain, the
  sandbox auto-allow builder `xBe` allows it. Statsig gate
  `tengu_amber_larch` (v288-only: 99481184, 209762993).

### OCC state — no symptom surface

- OCC's AST bash path is DORMANT: `TREE_SITTER_BASH` is not in
  `FEATURE_ALLOWLIST` (featureFlags.ts:13-58) → `parseCommandRaw` returns
  null (parser.ts:104-136); permission decisions flow through the legacy
  path.
- The legacy live path (`checkSandboxAutoAllow`, bashPermissions.ts:1813-1901,
  sandbox gate @2837-2851) already auto-allows unquoted heredocs — BROADER
  than official's post-fix behavior (official still requires the body to be
  provably plain; OCC's live path doesn't gate on body content at all).
  The #27 symptom (prompt on every run) does not exist in OCC.
- The dormant AST port replicates pre-fix official behavior:
  ast.ts:1837-1842 rejects ALL unquoted heredocs, with the deliberate
  rationale comment @1796-1802 ("Keep rejecting all unquoted heredocs").

### Verdict: **NO-OP{ALREADY-ALIGNED}** (live path), with a STAGED note

The official fix repairs official's AST+sandbox-auto-allow interaction, which
OCC cannot reach while TREE_SITTER_BASH is dormant; OCC's live behavior
already matches the FIXED outcome (no repeated prompt). Recorded divergence
for the eventual AST activation: ast.ts must then grow the
`differential:!0` flag on heredoc rejects, the `{plainUnquotedHeredocs:true}`
reparse option, and the `xBe`-equivalent re-allow call site (all recovered
above) before TREE_SITTER_BASH is allowlisted.

---

## #45 — `sandbox.credentials.files` under `blockReadsOutsideWorkingDirectories`

> Fixed `sandbox.credentials.files` entries on git config files not taking
> effect while `permissions.blockReadsOutsideWorkingDirectories` is on.

### Official forensics — delta recovered

v287 `_He(e)` @209094298 → v288 `p1e(e,n)` @210245781 (dumps:
c45_287.txt / c45_288.txt): new settings-override parameter; rule merge

```js
g=new Set(s.map(b)),
h=[...s, ...APe(n??null,"userSettings")
      .filter((xe)=>xe.ruleBehavior!=="allow" && !g.has(b(xe)))]
```

plus `K = n===void 0 ? [] : c7t("userSettings",B,{settings:n})` where
`c7t(e,n,r)` reads `(r?.settings??ge(e))?.sandbox`, and reopen-dedupe via a
`V` set. Surrounding subsystem = dir-sync read withholding
(`S1e` withholdFor/neverReadFor, `tengu_dir_sync_*`). The
credentials.files-window mask/JWT/onExtractNoMatch counts are IDENTICAL
across versions (47/14/8/3), confirming the change is in rule/settings
plumbing, not the credentials matcher itself. (No v287 callers of `_He`
recoverable by naive grep — minified aliasing; noted, not invented.)

### OCC state — neither setting exists

- sandboxTypes.ts:191-200: `credentials` = `{enabled}` only — no `.files`.
- settings/types.ts:46-88: no `permissions.blockReadsOutsideWorkingDirectories`.
- trustedTierGrants.ts:44-46 / policyLocks.ts:63-66: no dir-sync withholding.

### Verdict: **NO-OP{NO-SURFACE}**

The bug requires both settings; OCC ships neither. If/when
`sandbox.credentials.files` or `blockReadsOutsideWorkingDirectories` are
ported (future round), port `p1e`'s settings-override merge shape (recovered
above), not the v287 `_He` shape.

---

## #15 — auto-mode denial hint names the actual tool

> Fixed auto mode denials pointing Claude at a Bash permission rule when the
> blocked tool was not Bash.

### Official forensics — FULLY RECOVERED

v287 `D2n(e,n)` @210140145:

```js
if(n?.omitSettingsRuleHint===!0||!Q9o()||Wh())return g;
return `${g} ${"To allow this type of action in the future, the user can add a Bash permission rule to their settings."}`
```

v288 `bKn(e,n)` @211301793:

```js
if(n?.allowRuleToolName===void 0||!WZo()||Xh())return g;
let h=`To allow this type of action in the future, the user can add a permission rule for ${n.allowRuleToolName} to their settings.`;
return `${g} ${h}`
```

Caller v287 `nVt(e,n)` @208828626 → v288 `dXo(e,n,r,s,g)` @209972359 — the
new suppression predicate (verbatim):

```js
let h=e.failureMode!==void 0,
S=!eY(g)&&g.decisionReason?.type!=="sandboxOverride"&&mu(g.decisionReason)===void 0
  &&r.requiresUserInteraction?.()!==!0&&g.suppressAlwaysAllowRule!==!0
  &&r.suppressesAlwaysAllowRule?.(s)!==!0&&r.suppressesAllPermissionUpdates?.(s)!==!0
  &&r.ignoresWholeToolAllowRule?.(s)!==!0;
return {behavior:"deny",
  decisionReason:{type:"classifier",classifier:"auto-mode",reason:e.reason,...h&&{noVerdict:h}},
  message:h?cNt(e.reason,{refused:!1})
           :bKn(e.reason,{autoModeConsentFlow:xDt(n),
                          allowRuleToolName:S?v2o(Qf(r)):void 0})}
```

The call site precomputes `let qr=dXo(sr,B.agentId,e,n,ye)`, feeds
`{...qr,decideLocation:"pre-ask"}` into the denial-limit fallback `pXo`, and
returns `qr`. String counts: `"add a permission rule"` 0→2; `"Bash(prompt"` =
0 in BOTH versions.

### OCC state

- messages.ts:354-373 `buildYoloRejectionMessage` hardcodes the Bash hint in
  both branches; permissions.ts:1048 same shape.
- Note: OCC's hint text uses a `Bash(prompt: …)` phrasing that matches
  NEITHER official version (0 hits in both binaries) — pre-existing
  OCC-original divergence; align while porting.

### Verdict: **PORT-CANDIDATE** (rank 4)

Touch points: (1) `buildYoloRejectionMessage` gains
`allowRuleToolName?: string`; hint appended only when defined; text →
`…add a permission rule for ${toolName} to their settings.`; (2) yolo
denial builder computes the `S` predicate (tool supports allow rules, not
sandboxOverride, no requiresUserInteraction, no suppress flags) and passes
`v2o(Qf(tool))`-equivalent display name; (3) update tests asserting the
hardcoded Bash hint.

---

## #16 — auto mode on Bedrock/Mantle no longer latches to local classifier

> Fixed auto mode on Bedrock and Mantle switching to the local classifier for
> the rest of the session after a request to an older model.

### Official forensics — delta recovered

New v288 `k5o(provider,model)` @202200032:

```js
function k5o(e,n){ if(e!=="bedrock"&&e!=="mantle")return!0; return !rc(Be(n)) }
```

with the old-model predicate `rc(e)` @202192751 (`claude-3-*`, opus-4-0/1/5/6,
sonnet-4-0/5/6, haiku-4-5) and normalizer `Be` @202179265. Request-builder
call site v288 @209323489 vs v287 @208207178: v288 adds `let td=k5o(ss,Ye)`
and gates BOTH the dangerous-tool-use beta attach (`Lh=…&&td&&…`) and the
session-latch re-push (`if(td&&Vy(qe,pT)&&!ir.includes(pT))ir.push(pT)`) on
`td`, so an old-model request on bedrock/mantle no longer 400s and no longer
sticks the session into local-classifier mode.

### OCC state — platform surface absent

- `isAutoModeServerEnabled()` returns false unconditionally (Status.tsx:43-45);
  OCC auto mode is client-side `yoloClassifier` via sideQuery only.
- No server classifier beta header, no dangerous-tool-use beta latch, no
  Mantle provider; bedrock path has no auto-mode integration. Subagent
  verification found no sticky session-latch shape anywhere in OCC.

### Verdict: **NO-OP{PLATFORM}**

The bug is in official's server-classifier beta negotiation on
Bedrock/Mantle — subsystems OCC does not ship. Nothing to port; if OCC ever
adds a server classifier, the `k5o` gate (recovered above) must come with it.

---

## #31 — blocked_on_user spans no longer report `unknown`

> Fixed OpenTelemetry `claude_code.tool.blocked_on_user` spans reporting
> `unknown` source or decision in `-p` and SDK sessions and for PreToolUse
> hook approvals.

## #32 — unanswered asks now emit `tool_decision`

> Fixed permission asks that ended unanswered, in `-p` or on an interrupted
> turn, emitting no `tool_decision` event.

(Handled together — one code region, both fully recovered except noted.)

### Official forensics — RECOVERED

Span helpers: v287 `MNo/Upn` @203905123 ≡ v288 `QBo/Ymn` @204972745
(identical logic; renamed). The fix is at the tool-execution decision site:

v287 @207738136 (BUGGY — both issues):

```js
if(vn.behavior!=="ask" && !s.toolDecisions.has(n)){
  let gr=vn.behavior==="allow"?"accept":"reject",
      _o=fco(vn.decisionReason,vn.behavior), …
  ys("tool_decision",{decision:gr,source:_o,…},s.agentContext) …
}
…
Upn("reject",gr?.source||"unknown")                      // deny span  @207738674
Upn(ao?.decision||"unknown",ao?.source||"unknown")       // allow span @207742808
```

v288 @~208843300 (FIXED):

```js
let mo=Aho(zn,s.abortController.signal.aborted);
if(!s.toolDecisions.has(n)){
  let {decision:er,source:Uo}=mo, yr=ikn(e.name,Ze,e.mcpInfo);
  Ss("tool_decision",{decision:er,source:Uo,tool_name:Dn(e.name),
      tool_use_id:n,...ynr(e.mcpInfo),
      ...Object.keys(yr).length>0&&{tool_parameters:b(yr)}},s.agentContext);
  if(UOe(e.name)) jOe(e,Ze,er,Uo).then((rr)=>OYn()?.add(1,rr))
}
…
Ymn("reject",er?.source||mo.source)                      // deny span  @208844295
Ymn(wo?.decision||mo.decision,wo?.source||mo.source)     // allow span @208848422
```

The `behavior!=="ask"` gate is GONE (#32: unanswered/aborted asks now emit
tool_decision), and the span `'unknown'` fallbacks are replaced by the
derived `mo.decision`/`mo.source` (#31). New derivation helper `Aho`
@208819059 (verbatim, full body):

```js
function Aho(e,n){ switch(e.behavior){
  case "allow": return {decision:"accept",source:MIt(e.decisionReason,"allow")};
  case "deny":  return {decision:"reject",source:MIt(e.decisionReason,"deny")};
  case "ask":   return {decision:"reject",source:n?"user_abort":"config"} } }
```

(`n` = `signal.aborted`.) `MIt` @208818518 is logic-identical to v287's
`fco` @207713308 (permissionPromptTool decisionClassification passthrough;
rule→`xho`/`uco` session/localSettings/userSettings → user_temporary/
user_permanent/user_reject; hook→"hook"; mode/classifier/subcommandResults/
asyncAgent/sandboxOverride/workingDir/safetyCheck→"config"; other→
user_abort if reason===abort-marker else "config") — pure rename, no delta.

### OCC state — both bug shapes present

- toolExecution.ts:1006-1015 — tool_decision emit gated on an answered
  decision (same `!=="ask"`-style gate; unanswered asks emit nothing).
- sessionTracing.ts:542-591, span-end fallbacks `'unknown'` @574-578 and
  @627-632 — blocked_on_user spans report unknown decision/source in `-p`/SDK.
- `toolDecisions` map is populated only by interactive
  `logPermissionDecision` (permissionLogging.ts:237-250;
  sdkPermissionTelemetry.ts:55-146), so headless sessions always fall to the
  unknown branch. PermissionContext.ts:154-173: `cancelAndAbort` produces
  `behavior:'ask'` @172 — the exact unanswered-ask shape official now maps to
  `{reject, user_abort}`. PreToolUse hook approvals: toolHooks.ts:395-432,
  468-478 — same gap.

### Verdict: **PORT-CANDIDATE ×2** (#31 rank 6a, #32 rank 6b)

Touch points: (1) add an `Aho`-equivalent pure mapper (behavior + aborted →
{decision, source}) next to permissionLogging.ts; (2) toolExecution.ts:
drop the ask-gate on the tool_decision emit, derive via the mapper;
(3) sessionTracing.ts: replace the three `'unknown'` fallbacks with the
mapper's decision/source; (4) tests: `-p`-mode unanswered ask emits
`tool_decision {decision:'reject', source:'user_abort'|'config'}`; hook
approval span carries source `'hook'`.

---

## #72 — shorter "can't be checked before it runs" prompt reasons

> Improved Bash permission prompts to give a shorter reason when part of a
> command can't be checked before it runs.

### Official forensics — FULLY RECOVERED (both tables)

String counts v287→v288: `"cannot be checked in advance"` 24→0,
`"can't be checked before it runs"` 0→19, `"Part of this command"` 4→0.

v287 too-complex builder `_()` @202492999:

```js
reason: t===void 0 ? "Part of this command cannot be checked in advance"
                   : `Part of this command (${t}) cannot be checked in advance`
```

with a lowercase node-type map `Rt`. v288 `_()` @203543557:

```js
reason: `${n===void 0 ? "This command" : `${n} in this command`} can't be checked before it runs`
```

with sentence-case map `vt` (27 entries, verbatim): simple_expansion→"A
variable", expansion→"A variable in braces", command_substitution→"A nested
command", process_substitution→"A command used as a file",
brace_expression→"A brace pattern", ansi_c_string→"Text with escape codes",
translated_string→"Translatable text", test_command→"A test in brackets",
herestring_redirect→"A here-string", heredoc_redirect→"A here-document",
subshell→"A group in parentheses", compound_statement→"A group in braces or
double parentheses", for_statement→"A for or select loop",
c_style_for_statement→"A counting for loop", while_statement→"A while or
until loop", until_statement→"An until loop", if_statement→"An if statement",
case_statement→"A case statement", function_definition→"A function
definition", array→"A list of values", string→"Quoted text",
file_redirect→"A file redirect", pipeline→"A pipeline",
concatenation→"Joined pieces of text", variable_assignment→"A variable
assignment", variable_assignments→"Variable assignments".

Wrapper reasons — 11 pairs recovered (v287 long → v288 short, all
`can't be checked before it runs`): timeout option→`'timeout ${u}' …`;
timeout duration→`timeout duration '${t[c]}' …`; env→`'env ${u}' …`;
stdbuf→`'stdbuf ${u}' …`; command→`'command ${p}' …`; jobs -x→`What 'jobs -x'
starts …`; xargs adds→`What xargs adds to ${a} …`; xargs gives→`The program
xargs gives ${a} …`; awk text→`awk is given text that …`; awk option→`awk has
an option that …`; generic→`What '${a}' starts …`. The v288 wrapper checker
`FJn` region @203551221 also shows the full timeout flag parser
(`--foreground|--preserve-status|--verbose`, `--kill-after|--signal=X`, `-v`,
`-k/-s X`, `-[ks]X`, duration `/^\d+(?:\.\d+)?[smhd]?$/`).

### OCC state — byte-exact v287 port

- ast.ts:2712-2739 `NODE_TYPE_EXPLANATIONS` = v287 lowercase `Rt` map;
  tooComplex @2753-2765 = v287 `_()` text verbatim ("Part of this command …
  cannot be checked in advance").
- Wrapper reasons @2980/2997 (`timeout with ${arg} flag cannot be statically
  analyzed`), @3016 (timeout duration), @3036 (nice), @3061 (env), @3094
  (stdbuf). OCC has NO jobs/xargs/awk wrapper reasons (pre-existing gap —
  official v287 already had them; the v288 forms are recovered above, so the
  port closes both gaps at once).
- Tests: `src/tools/BashTool/__tests__/bashPromptPlainLanguage287.test.ts`
  asserts the v287 long messages — must be updated in the same change.

### Verdict: **PORT-CANDIDATE** (rank 7 — wording only, no behavior change)

Touch points: replace NODE_TYPE_EXPLANATIONS with the `vt` table, tooComplex
template with the v288 form, wrapper reason strings with the 11 short forms,
rename/refresh the 287 test file.

---

## #76 — classifier ignores a Sonnet 5.5 / Opus 5.5 pin

> Changed the client-side auto mode classifier to ignore an
> `ANTHROPIC_DEFAULT_SONNET_MODEL` pin that names Claude Sonnet 5.5 or Opus
> 5.5 and use Claude Sonnet 5 instead.

### Official forensics — FULLY RECOVERED

v288-only string: `"cannot serve as the classifier"` (v287: 0 hits; v288:
@101198985 + @202157616). Classifier-model function v287 `hI(e)` @201348803
→ v288 `bI(e)` @~202157300. v287 (verbatim):

```js
function hI(e){ let n=Xm(e);
  if(n==="claude-sonnet-4-6"||n==="claude-sonnet-4-5"||n.startsWith("claude-haiku-"))return;
  let r=a.ANTHROPIC_DEFAULT_SONNET_MODEL,
      g=r!==void 0&&r===a.CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT?void 0:r;
  if(g!==void 0&&!((LC(g)??Fr(g))&&!eB(g,tB())))return;
  if(g===void 0){let h=Cb().sonnet5;if(!Fr(h))return;g=h}
  return Kb(QT(g),e) }
```

v288 inserts after the probe-default normalization (verbatim):

```js
var yI=["claude-sonnet-5-5","claude-opus-5-5"],Lb=!1;
…
if(g!==void 0&&yI.includes(Nm(iT(g)))){
  if(!Lb) Lb=!0, t(`Auto mode classifier: ANTHROPIC_DEFAULT_SONNET_MODEL=${g} cannot serve as the classifier; using the Sonnet 5 default instead`);
  g=void 0 }
```

(renames: Xm→Nm normalizer, QT→iT trim, Kb→Jb `[1m]` variant, LC/Ur
availability, eB/tB→CB/RB, Cb→Ub model table, hI→bI, pKr→G6r memo wrapper.)
A pin normalizing to claude-sonnet-5-5 or claude-opus-5-5 is discarded
(warn-once via latch `Lb`) and the `sonnet5` default is used instead.

### OCC state

yoloClassifier.ts:1490-1522 `getClassifierModel()` honors an
`ANTHROPIC_DEFAULT_SONNET_MODEL` pin unconditionally @1508-1515 (only the
3P-probe marker is excluded — matching official's pre-fix shape). A
5.5-model pin currently becomes the classifier model in OCC.

### Verdict: **PORT-CANDIDATE** (rank 5)

Touch point: in getClassifierModel(), after the probe-marker exclusion, add
the ignore list `['claude-sonnet-5-5','claude-opus-5-5']` (compare on the
normalized model name), warn-once with the exact official message, and fall
through to the sonnet5 default; test pin→5.5 ignored, pin→other honored.

---

## Cross-entry notes for implementation

- Shared decisionReason vocabulary: #54 uses
  `{type:'safetyCheck', classifierApprovable:false,
  circuitBreaker:'dangerousRemoval'}` — OCC already has this shape from the
  2.1.281 dangerous-rm port (dangerousRmAutoDeny.ts), reuse it.
- #15's `S` predicate references tool capabilities
  (`suppressesAlwaysAllowRule` / `ignoresWholeToolAllowRule` /
  `requiresUserInteraction`) — map onto OCC's tool interface; where OCC
  lacks a hook, treat as false (do not invent suppressions).
- #31/#32's mapper `MIt`/`fco` bodies are identical across versions — port
  once; OCC's nearest existing helper is permissionLogging.ts's source
  derivation (237-250).
- Sequencing suggestion: #54 (new module, independent) ∥ #57 (hooks,
  independent) ∥ #28+#72 (ast.ts, same file — do together) ∥ #15 (messages)
  ∥ #76 (yoloClassifier) ∥ #31/#32 (telemetry, same region — do together).
  No file overlaps between the groups except ast.ts (#28/#72).
