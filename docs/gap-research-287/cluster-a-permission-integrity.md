# OCC-105 Cluster A — Permission-Integrity Security (official 2.1.286 → 2.1.287)

RESEARCH ONLY. No repo modification, no binary execution — byte forensics only
(`LC_ALL=C rg -aob -F`, python3 read+slice). Binaries:
`/tmp/cc-diff-287/v286/package/claude`, `/tmp/cc-diff-287/v287/package/claude`.
OCC repo (read-only): `.../workdir/occ`.

**HONESTY NOTE.** Novelty is proved with *message/reason strings*, never minified
identifiers (they are reused across versions — e.g. v286 `function h2(` is a
different function than v287 `h2`). Where a behavioral fix could NOT be isolated
to a changed byte range, that is stated explicitly rather than guessed.

---

## ITEM 1 — Dangerous `rm` losing always-ask when the command also redirects to `~`/wildcard

> changelog: *"Fixed a dangerous `rm` (such as one on `/` or the home directory)
> losing its always-ask safeguard when the same command also redirected output to
> a `~` or wildcard path."*

### Verdict: **NO-OP{ALREADY-ALIGNED}** — OCC **NOT-AFFECTED**

### Official-side forensics

The entire dangerous-removal detector chain is **byte-identical v286↔v287 modulo
minified renames** (proved by structural token-diff; only identifier substitutions):

| role | v287 | v286 |
|---|---|---|
| literal-target detector | `MU` | `Z_` |
| var-path detector | `Fae`/`mFe` @208507319 | `mDe` @206480467 |
| var-path ask builder | `Lae` @208488061 | `Qse` |
| rm operand extractor | `Sc` @208511566 (`ZS` table; `tee:(e)=>tjo(Sc(e))` @208516662) | — |
| integration / parse gate | `x1o`/`Vzt`/`GFe` @208614300-208618200 | `nk`/`Q$o` |
| redirect-target expander | `rzt` @208545966 | `KHt` @206516374 |

`rzt` (v287) vs `KHt` (v286) — **structurally identical**, rename-only
(`Od`↔`Yc`, `$Gt`↔`cHt`, `Lk`↔`nk`):

```js
// v287
function rzt(e,n){let r=[],s=Od(e);if(s!==e)r.push({path:s,cwdIndependent:!0});
  if(!e.startsWith("~"))r.push({path:$Gt(n,e),cwdIndependent:Lk(e)});return r}
// v286
function KHt(e,n){let r=[],s=Yc(e);if(s!==e)r.push({path:s,cwdIndependent:!0});
  if(!e.startsWith("~"))r.push({path:cHt(n,e),cwdIndependent:nk(e)});return r}
```

**The only genuinely NEW artifacts in the whole dangerous-rm cluster** are the
`safety_check` reason-code map + mapper (telemetry surface), byte-verified 0→N:

```js
// v287 @221945929  (v286: 0 hits for every code)
pt={dangerousRemoval:"safety_check_dangerous_removal",
    backgroundOperator:"safety_check_background_operator",
    suspiciousWindowsPath:"safety_check_suspicious_windows_path",
    outsideReadsBlocked:"safety_check_outside_reads_blocked",
    restrictedMode:"safety_check_restricted_mode"}
// v287 @221946246
function gn(e){if(e.classifierApprovable)return"settings_file";
  let n=e.circuitBreaker;return(n===void 0?void 0:pt[n])??"safety_check_other"}
```

Novelty counts (v286 | v287): `safety_check_dangerous_removal` [0|2],
`_background_operator` [0|2], `_suspicious_windows_path` [0|2],
`_outside_reads_blocked` [0|2], `_restricted_mode` [0|2];
`settings_file";let n=e.circuitBreaker` [0|1];
`This computer's own safety check did not answer` [0|2]
(`...did not clear this` is [2|2], pre-existing).

**Could NOT isolate the exact changed line for the redirect bypass.** The rm
detector bodies and the redirect expander are byte-identical; NO new parser
`too-complex` reason strings were added (`Redirect target concatenation
contains $/\``, `Unrecognized redirect shape`, `Redirect target contains $(cmd)
output` are all [1|1]/[2|2] — pre-existing in v286). The most probable fix site
is a **gate/ordering change** in the `h2`-parser → `kind==="simple"` → `MU`
path (`MU` runs only when the parse is `simple`; a redirect that flips the
classification to `too-complex` would drop the always-ask). This is a logic
reordering that leaves no distinct new string, so it is **not conclusively
recoverable from bytes alone** without a full decompilation diff of the parser
gate. Reported honestly as NOT isolated.

### OCC-side analysis — why NOT-AFFECTED

OCC does not use the official's parse-gated `MU` detector for the always-ask
safeguard. OCC's guard is a **raw-command regex** that never strips redirects:

- `src/tools/BashTool/destructiveCommandWarning.ts` — `RM_ROOT_HOME_PATTERN`
  matches `rm -rf` (all flag spellings) against `/`, `/*`, `~`, `~/`, `~/*`,
  `$HOME`, `$HOME/`, `$HOME/*`. `truncateForMatch` (L119-121) only truncates
  >10k chars — **it never removes redirect tokens**, so a trailing `> ~/x` does
  not hide the `rm -rf /` head.
- `src/tools/BashTool/bashPermissions.ts` — G3 `findDestructiveCommandBlock`
  (@2541-2562) runs on the RAW `input.command`, `mode!=='bypassPermissions'`,
  returning a hard deny **before** any auto-allow / allow-rule / classifier.
  `extractOutputRedirections(command).commandWithoutRedirections` (@1217) is used
  ONLY for allow-rule matching — **not** for the dangerous-rm guard.
- Second layer: `src/utils/bash/commands.ts` `hasDangerousExpansion` (L830)
  flags `~`-prefixed and glob (`*`,`?`,`[`,`{`) redirect targets → dangerous →
  ask (bug_007/bug_022 closed the tilde carve-out).

**Empirical proof** (`/tmp/cc-diff-287/rmtest.mjs`, run against OCC's own
`RM_ROOT_HOME_PATTERN`): all 11 bypass forms MATCH —
`rm -rf / > ~/x`, `rm -rf / >~/x`, `rm -rf / >> ~/out.log`,
`rm -rf ~ 2>&1 | tee glob*`, `rm -rf ~ > *.log`, `rm -rf /* > ~/x`,
`rm -rf $HOME > ~/*`, `rm -rf / 2>~/err`, `rm -rf ~ | tee ~/log`,
`rm -rf / &> ~/x`, `rm -rf /`.

### Port instruction

**None required.** OCC's raw-command regex is redirect-agnostic and already
fail-closed against the exact bypass the official fixed. OPTIONAL telemetry
parity only: if OCC ever mirrors official analytics, add the `pt`/`gn`
reason-code map (`safety_check_*`) — this is telemetry surface, not a guard, and
OCC's analytics are stubbed, so it is a NO-OP for behavior.

---

## ITEM 2 — Shell write through a repo-committed symlink names its landing & waits for a person (`~` targets too)

> changelog: *"Changed a shell write through a repo-committed symlink onto a
> sensitive file or out of the working tree to name where it lands and wait for a
> person, on lines with a `~` target too."*

### Verdict: **STAGED** (OCC largely ALIGNED behaviorally; residual person-only gap) — OCC **NOT-AFFECTED** for the core case

### Official-side forensics

The symlink-landing **wording pre-existed** in v286 (used by the FILE tools):
`resolves through a symlink to` [2|2], `which is outside the allowed working
directories` [2|2]. The v287 delta is a **new call-site wiring the landing
resolver into the shell-redirect permission loop** — byte-proved by
`carriedOut` **9 → 13** (+4), the new cluster at v287 **208540466 / 208540656 /
208541714** sitting between the two `denyCheckOutputRedirections` refs
(@208539885, @208547072).

Recovered landing resolver + sentence builder (v287):

```js
// Eue @202775224 — landing resolver (returns carriedOut)
function Eue(e,n,r){let s=hgt(e);if(s===null)return null;
  let g=(S)=>K_(S,n,[S],r),h=!g(s),w=g(e.requested);
  return{landing:s,landingOutside:h,spellingInside:w,carriedOut:w&&h}}
function hgt(e){if(e.unresolved)return null;
  return yl(e.landing)===yl(e.requested)?null:e.landing}
// xbe @202775852 / Yl — the landing sentence
function xbe(e,n){return`${Yl(e,n.landing)}${n.landingOutside?", which is outside the allowed working directories":""}`}
function Yl(e,n){return`${RO(e)} resolves through a symlink to ${RO(n)}`}
```

v286 redirect loop (`KHt`/`l6` only — sensitive-file check, NO landing):

```js
for(let Ft of At)for(let Ct of KHt(Ft.target,n)){let $t=ko(Ct.path);
  for(let Vt of $t){let en=ha(Vt,r,"edit","deny");if(en!==null){...return deny}}
  if(...){let Vt=l6(Ct.path,$t);              // ← l6 returns {safe,...}
    if(!Vt.safe&&...)Qe={behavior:"ask",message:Vt.message,...}}}
```

v287 redirect loop (adds `Exe` hard-deny + `HU` + `Eue` landing + `xbe` sentence,
producing a **person-only** ask — `classifierApprovable:!1` — when carried out):

```js
let Fn=Exe(Qt.path,{},Pn,{permissionMode:r.mode,restricted:r.restricted}),
    qn=Fn.behavior==="deny"&&!0, ...
    xn=HU(Qt.path,Pn), Jn=Eue(nn,r), wn;               // ← Eue = landing resolver
...
let eo=xn.safe||Jn===null?null:{sentence:xbe(Qt.path,Jn),
        personOnly:Jn.carriedOut||HU(Qt.path,[Qt.path]).safe}, ...
// NEW: sensitive-check passed & not denied, but carried out via symlink → person-only
if(xn.safe&&!qn&&Jn?.carriedOut===!0){Ft=!0;
  let ao=xbe(Qt.path,Jn),
      mo={behavior:"ask",message:ao,
          decisionReason:{type:"safetyCheck",reason:ao,classifierApprovable:!1}};
  if(et===void 0)ht??=mo;else if(...)et=mo}
```

The `~`-target coverage comes from the expander's **unconditional** first push
(`Od(e)` normalized, `cwdIndependent:!0`) — the `if(!e.startsWith("~"))` guard
only skips the *second* (cwd-join) push, so `~`-target lines still flow through
the landing check.

### OCC-side analysis

OCC ALREADY has the full landing subsystem for **file tools** (OCC-134 #005):
- `src/utils/permissions/filesystem.ts:1670-1745` — `resolvesThroughSymlinkSentence`
  (`Or` port), `carriedOutSentence` (`F9t` port, private), `WriteCarriedOut` type,
  `computeWriteCarriedOut` (`r2e` port, **exported** @1730).
- `checkWritePermissionForTool` (filesystem.ts:2038) consumes it with the
  person-only carried-out gate (L2228-2240) + SEC-1 gate (L2317-2338).

Crucially, OCC's **bash-redirect path also resolves the landing** — via
`validatePath`'s 2.1.280 #005 write tail (`Rxn` port):

- `src/tools/BashTool/pathValidation.ts:1119` `validateOutputRedirections` →
  per-target `validatePath(target,cwd,ctx,'create')` (L1277 call).
- `src/utils/permissions/pathValidation.ts:511-528` — for `operationType!=='read'`:
  `descriptor=resolveWritePathDescriptor(absolutePath)`; `checkPath=descriptor.landing`;
  `isPathAllowed(checkPath,...,descriptor.spellings)`; on `!allowed`,
  `carried=computeWriteCarriedOut(...)` and `resolvedPath=carried?.carriedOut?carried.landing:absolutePath`.
- `validateOutputRedirections` then emits `behavior:'ask'` naming the landing:
  `Output redirection to '${resolvedPath}' was blocked...` (resolvedPath = landing).
- `~`-targets: `validatePath` runs `expandTilde` (L396) and `hasDangerousExpansion`
  flags `~`/glob targets → ask (bug_007/bug_022). So `~`-target lines are covered.

So OCC's shell write through a symlink onto outside/sensitive **already prompts,
waits for a person, and names the landing** — behaviorally aligned with v287.

**Residual delta (why STAGED, not fully ALIGNED):** the official makes the
carried-out case explicitly **person-only** (`classifierApprovable:!1`) via the
`xn.safe&&!qn&&carriedOut` branch, i.e. it fires *even when the sensitive-file
check passes and no deny rule matches*, and it is not classifier-approvable.
OCC's `validatePath` computes `carriedOut` **only when `!result.allowed`**
(L522) and returns a `workingDir`/`safetyCheck` decisionReason whose
`classifierApprovable` flag is NOT forced to `false` for the carried-out case.
Whether an OCC auto-mode classifier could approve a symlink-carry-out redirect
ask (that the official would force to person-only) is **not verified** — needs a
targeted test.

### Port instruction (STAGED — low severity)

1. Export `carriedOutSentence` from `src/utils/permissions/filesystem.ts` (currently private @1680).
2. In `validateOutputRedirections` (pathValidation.ts:1119), after `validatePath`
   returns for a redirect target, additionally call `computeWriteCarriedOut` on
   the resolved descriptor **even when `allowed`**, and if `carriedOut===true`
   emit `{behavior:'ask', message: carriedOutSentence(target, carried),
   decisionReason:{type:'safetyCheck', reason: <sentence>, classifierApprovable:false}}`
   — mirroring official's `xn.safe&&!qn&&Jn?.carriedOut===!0` person-only branch.
3. Add a test: a repo-committed symlink `link -> /outside/secret`, redirect
   `echo x > link` under an auto-mode/allow-rule context must PROMPT person-only
   (classifier cannot approve), for both a plain and a `~/`-relative target line.

Given OCC already prompts + names the landing, treat this as a hardening/parity
task, not an active bypass.

---

## ITEM 3 — Whole-tool `Bash` allow rules & allowing hooks now PROMPT (not run) shell writes to file-tools-refuse-outright files

> changelog: *"Changed whole-tool `Bash` allow rules and allowing hooks to prompt
> for, not run, shell writes to files Claude Code's file tools refuse outright
> (the Anthropic profile store, the host credentials file)."*

### Verdict: **NO-OP{NO-SURFACE}** — OCC **NOT-AFFECTED**

### Official-side forensics

The refuse-outright trio **pre-exists in v286** (all messages [2|2], env var
[35|35]) — the FILE tools already denied these:

```js
// v287 @202745300-202746000 (identical text in v286)
function zo(e){let n=a.CLAUDE_CODE_HOST_CREDS_FILE;...}          // host-creds detector
function Ho(e){let n=sEn();...n.dirs.some(...)||n.files.some(...)} // profile-store detector
function Vo(e){...settings-review.json...}                        // settings-review detector
Yo={behavior:"deny",message:"The Anthropic profile store holds the sign-in that decides which organization policy applies; it cannot be written directly",
    decisionReason:{type:"safetyCheck",reason:"profile store write substitutes the credential and organization behind managed settings",classifierApprovable:!1}}
Zo={behavior:"deny",message:"The host credentials file is managed by the host process; it cannot be written directly",
    decisionReason:{type:"safetyCheck",reason:"host-creds file rewrite redirects the bearer token",classifierApprovable:!1}}
Ko={behavior:"deny",message:"Staged Claude Code settings changes are the owner's to review in /settings-review; the review store cannot be written directly",
    decisionReason:{type:"safetyCheck",reason:"settings review store write substitutes a proposal the owner is about to accept",classifierApprovable:!1,circuitBreaker:"claudeSettingsFile"}}
```

The v287 delta is **routing**: the shared refuse-outright-aware checker `Exe`
(@202778056) is now invoked from the **bash-redirect / shell-write** path, where
v286 used `l6` (@200786350) which returns only `{safe,...}` and does NOT check
the trio:

```js
// Exe @202778056 (v287) — used by redirect loop AND file tools
function Exe(e,n,r,s){if(r&&r.length>0){let S=r.map(ul);
  if(S.some(zo))return Zo; if(S.some(Bo))return Jo;
  if(S.some(Ho))return Yo; if(S.some(Vo))return Ko; ...} ...}
// l6 @200786350 (v286) — NO zo/Ho/Vo; only Windows-pattern / claude-config / dangerous
function l6(e,n,r,s,g){...TJ(C,g)...suspicious Windows path...;
  if(S)return{safe:!1,...circuitBreaker:"claudeSettingsFile"};...Gf(C)...}
```

The changelog's "whole-tool allow rules and allowing hooks prompt, not run" = the
refuse-outright check now sits in the shell-write resolution such that a bare
`Bash` allow rule or a PreToolUse allow hook can no longer short-circuit past it;
`Exe` returns `{behavior:"deny"}` (`qn`) which the redirect loop turns into a
person-only ask (`internalHardDeny` → `classifierApprovable:!1`). No NEW message
string — the change is call-graph only (consistent with `l6`→`Exe` swap).

### OCC-side analysis — NO SURFACE

The three refuse-outright targets are **Anthropic enterprise / gateway /
managed-settings infrastructure that OCC does not implement**. Zero-hit proofs
(`LC_ALL=C rg -l -- "<pat>" src | wc -l`):

| needle | OCC files |
|---|---|
| `profile store` | **0** |
| `host credentials file` | **0** |
| `cannot be written directly` | **0** |
| `CLAUDE_CODE_HOST_CREDS_FILE` | **0** |
| `settings-review` / `settingsReview` | **0** |
| `substitutes the credential` | **0** |
| `host-creds` / `hostCreds` / `HOST_CREDS` | **0** |
| `workload identity` / `WorkloadIdentity` | **0** |

OCC's own source confirms the profile-store/WIF feature is deliberately absent:
`src/utils/settings/allowedProvidersEnforcement.ts:54` — *"WIF arm STAGED:
`Gr.wifProfileBaseUrlInUse` stays undefined (**OCC has no WIF profiles**); the
`zf` setter is ported for structural parity."*

OCC DOES have the two *mechanisms* the changelog names:
- (b) whole-tool `Bash` allow rules — `src/utils/permissions/shellRuleMatching.ts`,
  `PermissionRule.ts`, `permissions.ts`.
- (c) allowing hooks (PreToolUse) — `src/utils/hooks.ts`.

…but there is **no refuse-outright file for them to bypass**, because (a) the
profile store / host-creds file / settings-review store do not exist in OCC.
OCC's sensitive-file guard `checkPathSafetyForAutoEdit`
(`src/utils/permissions/filesystem.ts:649`) mirrors v286's `l6` exactly
(suspicious-Windows-pattern → `isClaudeConfigFilePath` → `isDangerousFilePathToAutoEdit`),
and does NOT contain the refuse-outright trio — matching the fact that OCC has
none of those files. OCC's own OAuth store `.claude/.credentials.json` is covered
separately as a Claude-config file (`isClaudeConfigFilePath` → classifierApprovable
ask), which is a pre-existing protection, not this v287 change.

### Port instruction

**None.** NO-SURFACE: the protected files (Anthropic profile store / host
credentials file / settings-review store) are absent from OCC by design. IF OCC
ever lands WIF profiles, host-creds injection, or a `/settings-review` store, it
must port the refuse-outright trio (`zo`/`Ho`/`Vo` detectors + `Zo`/`Yo`/`Ko`
denies) AND route them through the bash-redirect path (the `l6`→`Exe` swap) so a
whole-tool `Bash` allow rule / allowing hook prompts rather than runs — at that
point this becomes a PORT-CANDIDATE.

---

## APPENDIX — Byte-verified NEW strings in v287 (all three items)

| needle | v286 | v287 | item | notes |
|---|---|---|---|---|
| `safety_check_dangerous_removal` | 0 | 2 | 1 | `pt` reason-code map @221945929 |
| `safety_check_background_operator` | 0 | 2 | 1 | `pt` map |
| `safety_check_suspicious_windows_path` | 0 | 2 | 1 | `pt` map |
| `safety_check_outside_reads_blocked` | 0 | 2 | 1 | `pt` map |
| `safety_check_restricted_mode` | 0 | 2 | 1 | `pt` map |
| `settings_file";let n=e.circuitBreaker` | 0 | 1 | 1 | `gn()` mapper @221946246 |
| `This computer's own safety check did not answer` | 0 | 2 | 1 | safety-check msg (`...did not clear this` is [2|2] pre-existing) |
| `carriedOut` (identifier, call-sites) | 9 | 13 | 2 | +4: new redirect-loop landing call-site @208540466/656/208541714 |
| `resolves through a symlink to` | 2 | 2 | 2 | PRE-EXISTING (file-tool wording reused) |
| `The Anthropic profile store holds the sign-in` | 2 | 2 | 3 | PRE-EXISTING (refuse-outright deny) |
| `The host credentials file is managed by the host process` | 2 | 2 | 3 | PRE-EXISTING |
| `CLAUDE_CODE_HOST_CREDS_FILE` | 35 | 35 | 3 | PRE-EXISTING |

**No new user-facing prompt/reason strings for items 2 & 3** — both v287 changes
are call-graph/wiring deltas (item 2: landing resolver wired into the redirect
loop; item 3: `l6`→`Exe` routing the refuse-outright check through shell writes).

### Summary of verdicts

| item | official v287 change | OCC verdict | OCC status |
|---|---|---|---|
| 1 dangerous-rm redirect bypass | detector byte-identical; only `pt`/`gn` telemetry map new; exact fix line NOT isolated (probable h2 parse-gate reordering) | **NOT-AFFECTED** | NO-OP{ALREADY-ALIGNED} — raw-command `RM_ROOT_HOME_PATTERN` never strips redirects; 11/11 bypass forms match |
| 2 shell-write symlink landing | landing resolver (`Eue`/`xbe`/`carriedOut`) wired into redirect loop → person-only ask, `~` lines too | **NOT-AFFECTED** (core) | STAGED — OCC `validatePath` write-tail already resolves landing + prompts + names it; residual: carried-out not forced `classifierApprovable:!1` (unverified) |
| 3 refuse-outright + Bash allow/hooks | `l6`→`Exe` routes profile-store/host-creds/settings-review deny through shell writes | **NOT-AFFECTED** | NO-OP{NO-SURFACE} — OCC has no WIF profile store / host-creds file / settings-review store (0 hits; `allowedProvidersEnforcement.ts:54` confirms WIF staged/absent) |
