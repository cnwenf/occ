# R1 — AUTO MODE + BOOT DEFAULT cluster (2.1.303 → 2.1.304)

Research round: official Claude Code 2.1.303 → 2.1.304 alignment for OCC.
Method: static byte forensics only (no binary execution). All excerpts below were
`dd`-verified verbatim at the recorded byte offsets in:

- **vprev** = `/tmp/cc-diff-304/vprev/package/claude` (2.1.303, md5 `c3d55e74e4008ec9cd21ff1991502cda`)
- **vver** = `/tmp/cc-diff-304/vver/package/claude` (2.1.304, md5 `0209fe8a78dc4551b61bffda1978fca9`)

OCC cross-checks: repo `workdir/occ` @ HEAD `87974fd7`.

Verdict vocabulary: **PORT** (should port now) / **STAGED** (defer by leader ruling) /
**N-A** (surface absent from OCC by design) / **ALREADY-ALIGNED** (OCC already matches).

---

## Verdict table (summary)

| # | Item | Verdict | Key evidence (prev/ver counts · offsets) | OCC surface | Effort |
|---|------|---------|------------------------------------------|-------------|--------|
| 1 | changelog #4 `/auto-mode-setup` | **PORT** (folds into occ156-06/03 slice) | 38/38 hits (pre-existing); real change = `envOnboarding:!0` added to frozen fallback defaults: vprev `F_o` @241415481 vs vver `Tvo` @244173946 | NO (`rg auto-mode-setup\|autoModeSetup src/` = 0) | **L** |
| 2 | changelog #48 session file size in auto mode | **N-A** | all client-side classifier-context storage machinery byte-identical (classifierContext 27/28; the +1 = new `throughFamilyOnly` suppression, prev 0/ver 9); change is server-side or that hook flag | NO (no server classifier; explicit comment `src/utils/hooks.ts:4543-4547`) | — |
| 3 | `CLAUDE_CODE_AUTO_MODE_REMOTE_BROWSER` | **N-A** | prev 0/ver 2 (@124719764 strtable, @248241485 code); whole feature gated on `CLAUDE_CODE_REMOTE` + dynamic Chrome-MCP (`cYs` @240013366); rule text server-delivered via GrowthBook payload (`Qpr` @248240772) | NO (`rg REMOTE_BROWSER\|remoteBrowser src/` = 0) | — |
| 4 | changelog #7 Pro/Max resume 5-hour warning | **N-A** (machinery pre-existed in 303; 304 refines) | "Resume this conversation?" prev @267364035 / ver @268852451; `tengu_amber_tally` config both; 304 adds `offersLookUp` (prev 0/ver 9), reset-pending suppression `oK()`, outcome epoch tracking | NO (no cold-resume quota surface; OCC trims usage-credits; only statusline docs + notificationReasons299 mention five_hour) | — |
| 5 | occ156-03 STAGED-trigger forensics | **STAGED — keep MANUAL this round** (see memo §6) | boot resolver byte-identical 303↔304 (vprev `pIr` @238078634 / vver `BDr` @~240595058); migration identical; gate default "enabled" both | PARTIAL (nudge+opt-in+migration ported @7b17869; boot default = MANUAL at `src/utils/permissions/permissionSetup.ts:803`) | M (if leader switches) |

---

## 1. Changelog #4 — `/auto-mode-setup` ("now works on Bedrock, Vertex, Foundry…")

### 1.1 What did NOT change (303 ≡ 304)

- Registration & gates — vprev @244397469 / vver @246949363, structurally identical
  (only minified renames `Gqo/m2e/g2e/bse` → `u3o/aYe/lYe/aie`, `S_`→`M_`, `ut`→`pt`,
  `we`→`Se`, chunk `ksmg0ckr`→`k8w8b3bj`):

```js
// vprev @244397469 (vver @246949363 with renames)
function Gqo(){return!a.CLAUDE_CODE_REMOTE&&yse()}
function m2e(){return Gqo()&&HYe().value!==""}
function g2e(){return m2e()&&S_()?.envOnboarding===!0}
function bse(){return g2e()&&ut().skillOverrides?.["auto-mode-setup"]!=="off"}
var h2e={type:"local",name:"auto-mode-setup",supportsNonInteractive:!0,
 description:"Teach auto mode about your environment, plus optional rule tweaks",
 argumentHint:"[--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose | --expect-sha256 <64-hex> --apply-file <path>)",
 isEnabled:()=>m2e()&&we(),get isHidden(){return!we()},load:()=>import("/$bunfs/root/chunk-ksmg0ckr.js")}
zqo={type:"local-jsx",name:"auto-mode-setup",…,isEnabled:()=>g2e()&&!we(),requires:{workspace:!0,ink:!0}}
```

- `we()` = non-interactive check — vprev @233909989: `function we(){return!n().host.launchOptions.isInteractive()}`.
- Always-true env stubs `yse()/Ozo()` — vprev @244341463 / vver @248251333, identical.
- Classifier-model resolution `HYe` (vprev @244391359) ↔ `u5e` (vver @248301559): identical
  (vver result object additionally carries `remoteBrowserRule:rt` — see §3).
- Wizard login gate `bIn` @257709160 ↔ `xOn` @260725570: identical
  (`if(!Sl()||rje())return"ok"` ↔ `if(!ll()||LWe())return"ok"`); pregather
  `Fas` @257667321 ↔ `Fps` @260683731 identical; error strings prev=2/ver=2 (artifacts).
- String counts identical: `auto-mode-setup` 38/38, `"Teach auto mode"` 6/6, `"take arguments"` 6/6.

### 1.2 THE change — `envOnboarding:!0` added to the frozen fallback defaults

The wizard's interactive gate is `g2e() = m2e() && S_()?.envOnboarding===!0`.
`S_()`/`M_()` reads statsig config `tengu_auto_mode_config`; when GrowthBook is
unavailable it returns a **hardcoded frozen fallback object**:

```js
// vprev @241415481
var F_o=Object.freeze({twoStageClassifier:!0,sameTurnSiblingContext:!0,
 editRemovalVisibility:!0,editRemovalCap:3000,outcomeVisibility:!1,repoVisibility:!0,
 gitStatusType:!0,gitStatusUploads:!1,tagConnectorWrites:!1,severityByModel:Object.freeze({…})}),
 Sc=Object.freeze({});
function S_(){let e=k("tengu_auto_mode_config",Sc)??Sc;if(e!==Sc)return e;return Fm()?Sc:F_o}

// vver @244173946 — same but Tvo adds envOnboarding:!0 after tagConnectorWrites
…tagConnectorWrites:!1,envOnboarding:!0,severityByModel:…
function M_(){let e=k("tengu_auto_mode_config",mc)??mc;if(e!==mc)return e;return ng()?mc:Tvo}
```

Fallback predicate (identical shape both versions):

```js
// vprev @237568518
function Fm(){return!a.DISABLE_GROWTHBOOK&&lW()}
// vver @240083899
function ng(){return!a.DISABLE_GROWTHBOOK&&OW()}
```

**Effect:** on first-party deployments GrowthBook is reachable, so `S_()` returns
the empty sentinel and the wizard stays off unless the server config says
`envOnboarding:true`. On Bedrock/Vertex/Foundry/gateway/telemetry-off deployments
(where the fallback object is used), 303 had no `envOnboarding` key → wizard gate
failed → command hidden; **304's fallback defaults `envOnboarding:!0` → the wizard
is enabled**. That is exactly changelog #4 ("now works on Bedrock, Vertex, Foundry…").

Caution (identifier collision): `function ng()` @240884624 in vver is a DIFFERENT
function — the `tengu_saffron_lattice` fableBilling reader (new 304 billing
surface), not the GrowthBook predicate. The real predicate is @240083899.

### 1.3 OCC cross-check

- `rg "auto-mode-setup|autoModeSetup" src/` → **0 hits**. OCC lacks the entire
  command surface (registration, wizard chunk, env-onboarding rules machinery).
- occ156 ledger already lists `/auto-mode-setup` as a真缺失 command (occ156-06),
  folded into the occ156-03 auto-mode slice.

### 1.4 Verdict + recipe

**PORT — effort L.** The 304 delta itself is one key (`envOnboarding:!0` in the
fallback config), but OCC has none of the surrounding surface, so porting means:

1. Config layer: add the frozen auto-mode fallback config object (equivalent of
   `F_o/Tvo`) incl. `envOnboarding:!0`, `twoStageClassifier`, `editRemovalCap:3000`,
   etc., wired to `tengu_auto_mode_config` reads with the same
   `if(e!==sentinel)return e; return growthbookDisabled?sentinel:fallback` shape.
2. Command registration: `auto-mode-setup` local (non-interactive, `--request-id`,
   `--wizard … --propose | --expect-sha256 … --apply-file …`) + local-jsx variant,
   gated on `!CLAUDE_CODE_REMOTE && classifierModel!==" " && envOnboarding && skillOverrides!=="off"`.
3. Wizard chunk body (dynamic import) — largest piece: env-rule proposal/apply flow.
   Depends on OCC first having an auto-mode classifier rule surface (occ156-03).

Recommendation: keep folded into the occ156-03 slice — porting the wizard before
OCC decides its auto-mode boot posture risks building on sand.

---

## 2. Changelog #48 — session file size in auto mode (classifier context no longer stored per request)

Changelog (line 52): "Improved session file size in auto mode: the safety
classifier's context is no longer stored with every request."

### 2.1 Forensic result: NO locatable client-side storage change

Every client-side component of the classifier-context storage pipeline is
byte-identical 303↔304 (renames only). Verified regions (vprev ↔ vver offsets):

| Component | vprev | vver | Result |
|---|---|---|---|
| `serverClassifierContext` store class (`pkt`↔`Cbt`: inFlight/judged/recordRequest/settleRequest/forgetRequest/historyFor/reset) | @242863455 | @245478855 | identical |
| zod schema `RNe`↔`XNe` (`{git_state?,chrome_navigation?,live_cwd?,platform?}`, caps 64/200) | @242854595 | @245469995 | identical (0 big diffs) |
| Message factory writing `serverClassifierContext`/`hostClassifierContext`/`classifierMetaLines` (`Ce`↔`Re`) | @247541485 | @250226236 | identical |
| Session-file strip lists `WNe=["toolUseResult","tool_use_result","mcpMeta","remoteToolResult"]`, `hit=["hostClassifierContext","classifierMetaLines","serverClassifierContext","summarizeMetadata"]` | chunk-dda2hwvy @251471272 | chunk-vmxya22s @254166xxx | identical |
| Request builder `safeguards:[{type:Cfe,classifier_context:oc}]` + `recordRequest` call | @246148597 | @248077243 | identical |
| Projection `Jvn`↔`Wcn` (git_state/chrome_navigation/live_cwd/platform) | @245989026 | @247914366 | identical |
| Per-request builder caller (`oc=…serverClassifier===!0…`, shedding gate) | @246143055 | @248071707 | opcode diff = identifier renames ONLY |
| Context-shedding loop `Zvn`↔`Gcn` (prior_turn halving → chrome tabs → git caches; `tengu_auto_mode_context_withheld`) | (same region) | (same region) | identical |
| Prior-turn rebuild `_kt`↔`Dbt` from stored serverClassifierContext | — | — | identical |
| Flag `K0t`↔`Jzt` (`autoModeContextEnabled ??= RPo() ?? k("tengu_smooth_chipmunk",!0)`) + arbiter routing `CE`↔`BE` ("arbiter"/"arbiterWithLocalFallback"/"off"; thirdParty = bedrock/mantle/vertex/foundry/anthropicAws/anthropicGoogleCloud/gateway) | @243745150 / @243755010 | @246532197 / @246541996 | identical |
| Hook PostToolUse `classifierContext` passthrough (2000 UTF-16 cap, hostPrincipal discipline) | @246310336, schema @236096793, sanitizer @241423496 | @248847201, @238586016, @244109280 | identical |
| Post-turn summary classifier ("classifier write timed out" 3/3, "[classifier] error" 3/3) | @251625235 | @254320293 | identical |

String counts: classifierContext 27/28, contextOnly regions 11/11 identical,
autoModeContext 4/4, classifierInput 3/3, classifierContexts 5/5,
serverClassifierRequest 8/8, serverClassifierResults 10/10.

### 2.2 The ONLY genuinely-new classifier code in the 304 client

1. **`throughFamilyOnly` hook-level classifierContext suppression** (prev 0/ver 9:
   @125835832 strtable, 248893237, 248893303, 248893413, 248893489, 248895988,
   248896021, **248928999**, 248932031). At ver @248928999 region:

```js
if(Hr.get(vr.hook)?.throughFamilyOnly===!0)vr.classifierContext=void 0;
```

   i.e. a hook family flagged `throughFamilyOnly` no longer contributes
   host-asserted `classifierContext` — which does reduce what gets stored/sent.

2. `classifierRemoteBrowserRule` telemetry (ver @248343010 region, see §3).

### 2.3 Conclusion

The changelog's "no longer stored with every request" is **not implementable as a
locatable client storage change** — the session-write strip lists, store class, and
message factory are unchanged. The improvement is either (a) server-side (the
arbiter classifier no longer echoing context back into responses that get
persisted), or (b) the `throughFamilyOnly` suppression above. **Nothing to port.**

OCC cross-check: `src/utils/hooks.ts:4543-4547` explicitly documents "OCC has no
classifierContext hook surface". No `serverClassifier` anywhere.

**Verdict: N-A** (no OCC surface; no portable client-side delta).

---

## 3. `CLAUDE_CODE_AUTO_MODE_REMOTE_BROWSER` (prev 0 / ver 2)

### 3.1 The code site — dd-verified vver @248241485

```js
function fhn(e,n){
  if(!LC())return;
  let r=!1;
  for(let s of e)
    if(s.name.startsWith(lEe)){                       // any Chrome-MCP-prefixed tool
      if(s.mcpInfo?.serverName!==O3||s.mcpInfo.scope!=="dynamic")return;
      r=!0;
    }
  if(!r)return;
  for(let s of e){                                    // bail on conflicting non-Chrome MCP tools
    if(s.name.startsWith(lEe))continue;
    let h=s.name.split("__"),y=h.map((S,w)=>h.slice(w).join("__"));
    if(iEe(`${s.name}_`,lEe)||!Kpr(s.name)&&h.some((S)=>VL(S).includes(chn))
      ||V8n.some((S)=>y.some((w)=>iEe(`${w}_`,`${S}_`))))return;
  }
  if(!cYs(n??y_())||!(nr.CLAUDE_CODE_AUTO_MODE_REMOTE_BROWSER??Xpr()))return;
  return Qpr();                                       // inject rule text
}
var cZe=`\n- **Chrome-MCP**:`;
function phn(e,n){…indexOf(cZe)…}                     // locate heading in classifier rule doc
function mhn(e,n){…insert after Chrome-MCP heading…}
```

Callers/inserters `phn`/`mhn` splice the returned text into the auto-mode
classifier rule document right after the `- **Chrome-MCP**:` heading.

### 3.2 Gating helpers (dd-verified)

```js
// vver @248240669 region
function Xpr(){if(!q8n())return!1;
  let{value:e,source:n}=bn(xFo,!1);
  return e===!0&&n==="payload"&&!sL()}                 // default: GrowthBook payload flag, default false

function Qpr(){let{value:e,source:n}=bn(U4s,"");
  if(n!=="payload"||sL())return;
  let r=typeof e==="string"?e.trimEnd():e;
  return typeof r==="string"&&r.startsWith("- **")&&r.length<=qpr
    &&/^[\x20-\x7e]*$/.test(r)&&!/[<\\]/.test(r)&&!r.includes("cc_automode")&&Ypr(r)
    ?`\n${r}`:void 0}                                  // rule TEXT is server-delivered, sanitized

// vver @240013366
function cYs(e){let n=e??[];
  return a.CLAUDE_CODE_REMOTE
    &&n.some((r)=>r.name===O3)
    &&n.every((r)=>r.name!==O3||r.config.scope==="dynamic"&&fpn(r.config))}
// fpn(e){return e.type==="http"&&W5s(e.url)}
```

(Offset @259626180 `var Qpr="cc-ce-migrate"` is a cross-chunk name collision — not
this function.)

### 3.3 Behavior + telemetry

- Feature = in **remote (CCR) sessions only**, when the tool list is exactly
  Chrome-MCP dynamic-http tools (no conflicting MCP namespaces), and
  `CLAUDE_CODE_AUTO_MODE_REMOTE_BROWSER` env (or GrowthBook payload flag `xFo`,
  default **false**, suppressed under taint `sL()`) is truthy → a **server-delivered
  rule paragraph** (`U4s` payload, strict ASCII/markdown sanitization) is injected
  after the `- **Chrome-MCP**:` heading of the auto-mode classifier rules.
- Classifier model config carries the decision: vver adds `remoteBrowserRule:rt`
  to the `u5e()` result object (vprev `HYe()` had only `artifactConsentRule:H`);
  telemetry spread `…Fr.remoteBrowserRule!==void 0&&{classifierRemoteBrowserRule:!0}`
  (vver @248343010 region). Counts: remoteBrowserRule prev 0/ver 5;
  artifactConsentRule 4/4.
- Sibling env readers in the same region (both pre-existing shape):
  `omr()` = `CLAUDE_CODE_AUTO_MODE_PRIOR_ASSISTANT_CONTEXT` → gb `priorAssistantContext` → false;
  `rmr()` = `CLAUDE_CODE_AUTO_MODE_ARTIFACT_CONSENT_RULE` → `tengu_umber_sluice` → true.

### 3.4 OCC cross-check + verdict

`rg "REMOTE_BROWSER|remoteBrowser" src/` → 0. OCC has no CLAUDE_CODE_REMOTE
Chrome-MCP dynamic surface and no auto-mode classifier rule doc. Rule text is
server-delivered anyway (nothing to hardcode).

**Verdict: N-A.**

---

## 4. Changelog #7 — Pro/Max resume 5-hour-limit warning

Changelog (line 11): "Added a warning on Pro and Max plans when resuming an
inactive conversation would use a noticeable share of your 5-hour usage limit:
resume anyway, or start a new conversation and Claude can look up the previous one
if you refer to it."

### 4.1 The warning machinery PRE-EXISTED in 303

- `"Resume this conversation?"` — prev @118412216/@267364035, ver @119438964/@268852451 (2/2 both).
- `"look up the previous"` prev 2 (@118448941, @266615278) / ver 2 (@119533157, @268065075).
- Config keys identical (vprev @266306117 ↔ vver @267751367):

```js
var LMe="tengu_amber_tally", lkt="tengu_drifting_nova", dkt="tengu_stateful_mitten";
function FMe(){return k(lkt,!1)===!0}  var ckt=5, BMe=1500
// vver: var rDe="tengu_amber_tally",ITt="tengu_drifting_nova",OTt="tengu_stateful_mitten";
//       function sDe(){return k(ITt,!1)===!0}  var NTt=5,iDe=1500
```

- Evaluator (vprev `tte` @266307094) ≡ (vver `Roe` @267752900 region) modulo
  renames: percent-of-5h-limit computed from `contextTokens × creditsPerMillionTokens[model]
  ÷ fiveHourCredits[rateLimitTier]`; tier from `userRateLimitTier||organizationRateLimitTier`
  when `servedTier!==!1`; below `minPercent??5` → suppress w/ `tengu_cold_resume_quota_suppressed`.
  `fiveHourCredits` 3/3 both — the Pro/Max gating is entirely inside the
  server-config tier map + rate-limit-tier presence (no plan string in client).
- Telemetry names identical: `cli_cold_resume_quota_warning` / `cli_idle_cold_cache_quota_warning`
  (`N0()` ver @267751700 region ≡ prev `PF()`), `tengu_cold_resume_quota_shown/_action/_suppressed`.
- `"noticeable share"` / `"resume anyway"` — 0 hits in BOTH binaries (changelog prose only).

### 4.2 Genuine 304 deltas (dd-verified)

1. **`offersLookUp` plumbing** (prev 0 / ver 9: @119439440, 267751989, 267753757,
   267753830, 268061992, 268062783, 268851757, 269067790, 269067805):

```js
// vver @267752xxx — dialog payload schema adds offersLookUp:O() (optional bool)
payload:p(()=>u({inactiveSince:v(),contextTokens:v(),percentOfFiveHourLimit:v(),
  trigger:N(["resume","idle"]),focusedAction:N(["resume","new_conversation","none"]),
  offersLookUp:O()}))

// vver @268096981
function NBe(h,R){return R!==null&&FBe(h,La(q()))&&Moe()}
function FBe(h,R){return!BBe(R)&&!h.some(JDt)}
function BBe(h){return BA(h)||RMt(h)!==void 0}          // pointer target is bridge/foreign
function JDt(h){return"foreignToBridgeSession"in h&&typeof h.foreignToBridgeSession==="string"}
function Moe(){if(!rn("allow_previous_conversation_pointer"))return!1;
  let h=aDe().safeParse(k(rDe,{}));
  return!(h.success&&h.data.newConversationPointer===!1)}

// vver dialog fn Poe (@267753xxx): passes offersLookUp into payload, RETURNS the
// outcome (Ge) instead of undefined; askIdleCacheQuota tracks epochs:
//   let R=this.#t; … this.#n(R,L) ; #n(h,R){if(R==="resume"||R==="dismiss")this.#o=h}
//   markConversationRemote=()=>{this.conversationOrigin="remote",this.#t++}
```

2. **UI**: 303 showed the "Start a new conversation" description
   `"Claude can look this one up if you refer to it later"` **unconditionally**
   (prev @267364035 region); 304 makes it conditional:
   `{value:"new_conversation",label:"Start a new conversation",...te&&{description:"Claude can look this one up if you refer to it later"}}`
   (ver @268852900 region, `te`=offersLookUp) — no longer promises lookup for
   bridge/foreign sessions. Also inputGuide Esc description became
   trigger-dependent (`$e?"dismiss":"resume"` vs fixed `"resume"`).

3. **Reset-pending suppression** — ver `Roe` adds `if(oK()!==null)return null;`
   with (ver @267752100 region):

```js
function oK(){let h=SBe();if(h!==null)return h.resetsAt===void 0?1/0:h.resetsAt*1000;
  let{status:R,isUsingOverage:L,resetsAt:H}=Ki();
  if(R!=="rejected"&&L!==!0)return null;
  if(H===void 0||!Number.isFinite(H))return 1/0;
  return H*1000>Date.now()?H*1000:null}
```

   i.e. when the account is already rejected/overage with a known future reset,
   skip the quota warning.

4. Adjacent NEW 304 surface (same changelog family, ver only): reset vocabulary
   chunk @266063600 (`["session","weekly","fable","full"]`, `five_hour→"session"` /
   `seven_day→"weekly"` / `seven_day_overage_included→"fable"` mapping, "5-hour reset" /
   "Fable reset" labels) and reset command chunk @279681690
   (`/… 5-hour|5h|five-hour → session`; error text "That isn't a reset name · try /…
   fable, full, 5-hour or weekly…"), plus `tengu_saffron_lattice` fableBilling gate
   (ver @240884624). "5-hour" prev 13/ver 21; "five-hour" prev 0/ver 4.

### 4.3 OCC cross-check

- `rg "tengu_amber_tally|drifting_nova|cold_resume|percentOfFiveHour|resumeReturnDismissed" src/` → 0.
- five_hour mentions only in `src/tools/AgentTool/built-in/statuslineSetup.ts:67-111`
  (statusline docs) and `src/tasks/LocalAgentTask/__tests__/notificationReasons299.test.ts`
  (usage-limit notification reasons — different feature).
- OCC trims the usage-credits/rate-limit-tier data this dialog consumes; there is
  no `Ki()`-equivalent rate-limit status store feeding a resume dialog.

**Verdict: N-A** for this round. If OCC ever restores the usage-limit surface, the
304 target state = §4.1 machinery + §4.2 deltas (offersLookUp conditioning, oK()
suppression, outcome tracking) — recipe recorded here for that eventuality.

---

## 5. occ156-03 STAGED-trigger forensics (stable dist-tag → 2.1.304, trigger ≥ 2.1.296 fired)

### 5(a) Boot permission-mode default logic — IDENTICAL 303↔304; official boots AUTO

vprev `pIr` @238078634 (full 12KB region dumped: `/tmp/cc-diff-304/prev_resolver.txt`)
↔ vver `BDr` @~240595058 (`ver_resolver.txt`). Structurally identical. The
auto-default branch, verbatim (vprev naming):

```js
if(!M){
  let g=C&&(!Ne(r.CLAUDE_CODE_REMOTE)&&MVn()&&(!n.isNonInteractiveSession||vy()
        ||k("tengu_moss_anchor",!1))||Ne(r.CLAUDE_CODE_BRIDGE_CHILD_AUTO_DEFAULT)),
      _="default";
  if(g){
    let w=fIr(),D=Ne(r.CLAUDE_CODE_BRIDGE_CHILD_AUTO_DEFAULT);
    if(w===void 0||w==="pending"&&D)_="auto",L=!0;         // ← AUTO is the boot default
    else if(w==="taint")h??=ve,T=!0;                       // HIPAA taint → withheld
    else if(w==="pending")P=!0;                            // verdict pending → provisional
  }
  M={mode:_,notification:h}
}
// C=!y&&!J(s);  y=re()=auto killswitch;  J(s)=disableAutoMode settings check
```

Gate `MVn()` (vprev @238088152) ≡ `wYn()` (vver @240604025), dd-verified identical:

```js
function MVn(){return k("tengu_harbor_willow",!0)||ZDo()?.meadow_lantern===!0}   // vprev
function wYn(){return k("tengu_harbor_willow",!0)||BUo()?.meadow_lantern===!0}   // vver
```

HIPAA taint `fIr()`↔`jDr()`: `if(Li("hipaa")||e==="unobtainable_seen_hipaa")return"taint";
return e==="pending"?"pending":void 0`. Notifications (both versions, byte-identical
strings): `` `${ie[e]} isn't the default for your organization · Shift+Tab to switch` `` /
`` `${ie[e]} didn't start: your organization's policy hasn't loaded · Shift+Tab to switch` ``.

Caller: vprev `bZr` @251157331 region
(`T=pIr(m);X0r(T.fromAutoFallback);J0r(T.autoStartWithheldForHipaaTaint);…`);
`verifyAutoModeGateAccess` (`cNe` @251165968) logs
`[auto-mode] verifyAutoModeGateAccess: enabledState=… canEnterAuto=…`.
Note: the earlier-recorded "extra vver `gBr` call site @249071312" is a **name
collision** — that `gBr` is a Worker/SAB spawner (`function gBr(e=YRn()){let n=new
SharedArrayBuffer(…)…}`), not the boot resolver. Boot-resolver call sites are
equivalent in both versions.

**Conclusion:** official 2.1.303 AND 2.1.304 both boot **AUTO** for interactive
sessions when no explicit mode is given, auto isn't disabled by settings/killswitch,
`tengu_harbor_willow` (default **true**) is on, and there's no HIPAA taint. Nothing
in 304 changes this logic.

OCC: `initialPermissionModeFromCLI` — `src/utils/permissions/permissionSetup.ts:803`,
called from `src/main.tsx:1708-1713`. Builds `orderedModes` only from
`--dangerously-skip-permissions`, `--permission-mode` CLI, and
`settings.permissions.defaultMode` (auto accepted from CLI/settings subject to a
cached circuit-breaker check), then falls through to:

```ts
if (!result) { result = { mode: 'default', notification } }   // ~line 911 — OCC boots MANUAL
```

There is **no auto-default branch** (no `harbor_willow`, no HIPAA-taint/pending
states, no `fromAutoFallback`/`provisionalStartupMode`/`autoDefaultWithheldForPendingVerdict`
— `rg` for all three: 0 hits outside tests).

### 5(b) `tengu_migrate_reset_auto_opt_in_for_default_offer` migration — IDENTICAL 303↔304

vprev `Gt` @253209836 region ↔ vver `_t` @255944019 region (renames `EZr`→`Kro`,
`On`→`Ln`, `ue`→config reader):

```js
async function Gt(e){
  if(ue().hasResetAutoModeOptInForDefaultOffer)return!0;
  if(EZr()!=="enabled")return!0;
  try{
    let n=me("userSettings");
    if(n?.skipAutoPermissionPrompt&&n?.permissions?.defaultMode!=="auto"){
      let{error:s}=await On("userSettings",{skipAutoPermissionPrompt:void 0},void 0,e);
      if(s)throw s;
      i("tengu_migrate_reset_auto_opt_in_for_default_offer",{}),g("migration_reset_auto_mode_opt_in")}
    Ae((s)=>{if(s.hasResetAutoModeOptInForDefaultOffer)return s;
      return{...s,hasResetAutoModeOptInForDefaultOffer:!0}},e)
  }catch(n){…}
  return!0}
```

Migration version `De=14`(prev)/`ke=14`(ver). Fresh-migration skip
`Io()/so() = a.CLAUDE_CODE_CCR_SKIP_FRESH_MIGRATIONS&&fd()&&Do()` where `Do()`
requires `!r?.skipAutoPermissionPrompt`.

OCC: **ALREADY-ALIGNED** — `src/migrations/resetAutoModeOptInForDefaultOffer.ts`
(lines 12-45 mirror the official logic incl. the `tengu_migrate_reset_auto_opt_in_for_default_offer`
event and the `enabled`-only condition, documented at line 18).

### 5(c) `skipAutoPermissionPrompt` escape hatch — SINGULAR spelling, IDENTICAL counts

- `skipAutoPermissionPrompt` — 7 hits each version
  (vprev @117844820, 234621406, 234659602, 253209893, 253209995, 253211249, 265442120;
  vver @118999100, 237099731, 237138003, 255944076, 255944178, 255945432, 266540430).
- `skipAutoPermissionPrompts` (plural, as once spelled in the occ156 doc) — **0 in both**.

OCC: **ALREADY-ALIGNED** — key used in
`src/migrations/resetAutoModeOptInForDefaultOffer.ts:12,19,34,38` and
`src/components/AutoModeOptInDialog.tsx:56,68`; `hasAutoModeOptInAnySource()`
(`permissionSetup.ts` ~1620) treats it as persistent opt-in.

### 5(d) `o2r()==="enabled"` successor — `EZr()`(303) / `Kro()`(304), default **"enabled"**

The occ156 doc's `o2r` identifier is stale (in 303 that name belongs elsewhere).
Real gate, dd-verified vprev @251169230 / vver @253857395:

```js
var $e="enabled";function ge(e){if(e==="enabled"||e==="disabled"||e==="opt-in")return e;return $e}
function EZr(){return wis().value}
function wis(){let s=k("tengu_auto_mode_config",{})?.enabled,o=ge(s);
  return{value:o,src:s===o?"gb":"default"}}
// vver identical: Ge="enabled"; Pe(e); Kro(){return _us().value}; _us() same shape
```

**Official default (unset gate) = `"enabled"` in BOTH 303 and 304.**

304 refactors the availability chain around it (vprev @246758002 ↔ vver @248655517):

```js
// vprev: l0n(){return!1}  WXt(e){return e.disableAutoMode==="disable"||e.permissions?.disableAutoMode==="disable"}
//        d0n(){return WXt(nr()||{})}
//        ey(){if(l0n())return!1;if(CMe())return!1;if(d0n())return!1;if(!OD(et()))return!1;return!0}
//        xcr(){return ey()&&Oun()}        // Oun()=G3n("useAutoModeDuringPlan") @235373128
// vver split:
function CFn(){return!1}
function sOt(e){…disableAutoMode…}  function RFn(){return sOt(dr()||{})}
function ggo(){return!CFn()&&!PHe()&&ZD(et())}          // base availability
function x_(){return ggo()&&!RFn()}                       // + settings check
function Kfr(){return x_()&&Ybt()}
function ye(){return hp()&&ggo()&&!git()&&!sOt(me("flagSettings")||{})}   // NEW fallback
function Vfr(e){return x_()||e==="auto"&&ye()}
function he(){return(x_()||ye())&&(!sBo()||Ybt())&&!OWo("useAutoModeDuringPlan")}
function OWo(e){return[...kjt(),me("flagSettings")].some((n)=>n?.[e]===!1)} // trusted-layers variant
// git()=autoModeDisabledByTrustedPolicy: sOt(me("policySettings")||{})&&kjt().some(sOt)
// hp() (vver @238538048 region) = EF().active
```

OCC divergence: `src/utils/permissions/permissionSetup.ts` ~1568:

```ts
const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'opt-in'
```

with the comment claiming "official 2.1.200 default is 'opt-in'". **Byte evidence
says the official 303/304 parse-default is `"enabled"`** (`$e="enabled"` /
`Ge="enabled"`). OCC's choice is a deliberate conservative divergence (GrowthBook
stubbed → gate always empty → 'opt-in' means auto requires
`CLAUDE_CODE_ENABLE_AUTO_MODE=1` or the dialog). This comment should be corrected
in the ledger regardless of the boot-default decision.

### 5(e) Auto-mode opt-in/consent dialog + announcement strings — IDENTICAL 303↔304

All counts prev/ver equal: `Auto mode is now Claude Code` 2/2,
`hasSeenAutoDefaultNotice` 4/4, `hasSeenAutoDefaultNudge` 7/7,
`hasSeenAutoModeEntryWarning` 4/4, `autoModeOptInDismissed` 3/3,
`tengu_auto_default_notice_shown` 2/2, `"auto-mode-default"` 2/2,
`tengu_auto_default_nudge` 6/6, `startupModeDecidedByProactivityLevel` 24/24,
`proactivity` 270/270. Env-onboarding eligibility `CI()` @266399372 ↔ `AE()`
@267845130 identical (env rules>0 → no; numStartups<5 → no; denials<5 → no;
dismissed <604800000ms → no). Startup class `mV` @266422092 ↔ `LK` @267868066
identical incl. nudge dynamic import (`chunk-d8y8ka73.js`↔`chunk-h6jkkqcj.js`,
`.shouldShowAutoDefaultNudge(…)`) and onboarding dialog copy ("Auto mode works
better when it knows your environment. Takes about a minute.", Yes/Not now/Don't
show again, `tengu_auto_mode_env_onboarding_shown/accept/later/dismiss`).

OCC: **ALREADY-ALIGNED** (commit `7b17869`): `src/utils/permissions/autoDefaultNudge.ts`
(`shouldShowAutoDefaultNudge` @70 = official `aMr` incl. `hasSeenAutoDefaultNudge`,
`tengu_maple_pier` feature gate, user-layer-pin conditions; `resolveAutoDefaultNudge`
@141 = official `Ckt`), `src/components/AutoDefaultNudgeDialog.tsx` (= official
`qhe`), `src/components/AutoModeOptInDialog.tsx`, startup block
`src/main.tsx:2658-2701` (= official `Tkt` live-context transition).

§7.4 residuals re-verified this round:
- **LOW-1 confirmed**: the nudge block `src/main.tsx:2666-2701` has NO try/catch —
  a failure of the dynamic `import('./utils/permissions/autoDefaultNudge.js')` or
  the dialog crashes startup.
- **LOW-2**: `shouldShowAutoDefaultNudge()` is called with no args at
  `main.tsx:2671` and the gate does not consult `permissionModeCli` — an explicit
  `--permission-mode default` launch can still show the nudge when USER settings
  pin a non-auto defaultMode. Official behavior at the byte level for
  CLI-mode suppression was NOT re-verified this round → keep as verify-first item.

---

## 6. Recommendation memo for the Leader (occ156-03)

**Trigger status:** fired — stable dist-tag = 2.1.304 ≥ 2.1.296.

**Forensic bottom line:** the 2.1.303 → 2.1.304 diff contains **zero changes** to
the official boot-default logic (resolver `pIr`≡`BDr` byte-identical; migration
identical; gate default `"enabled"` in both; consent/nudge strings identical). The
trigger therefore surfaces no NEW official behavior to catch up on — the decision
remains exactly the policy question STAGED at ruling `b16f18f6`: OCC boots MANUAL
(`permissionSetup.ts:803` → `{mode:'default'}` fallthrough) while official boots
AUTO interactively (harbor_willow default true, no HIPAA taint).

**Recommendation: KEEP STAGED (stay MANUAL) this round.** Rationale:
1. No upstream movement — switching now gains alignment credit only, nothing new.
2. OCC's GrowthBook is stubbed, so porting the official branch faithfully means
   `k("tengu_harbor_willow",!0)` → always true and the HIPAA-taint probe →
   `undefined` ⇒ **unconditional AUTO boot** for every interactive OCC user, with
   no server-side kill switch. The official's safety valves (killswitch `re()`,
   harbor_willow remote flip, taint/pending states, circuit breaker) are all
   server-fed; OCC would be hardcoding the aggressive path.
3. OCC's `'opt-in'` default (§5d) plus the ported nudge/opt-in dialog already give
   users the official consent UX opt-in-ward; the residual gap is a default
   posture, which is a product decision, not a drift bug.

**If the Leader decides to switch** (port surface estimate, scale **M**, ~2-4 files):
- `src/utils/permissions/permissionSetup.ts` — add the auto-default branch to
  `initialPermissionModeFromCLI` mirroring `pIr/BDr`: interactive-only,
  `!CLAUDE_CODE_REMOTE`, no killswitch/settings disable, harbor_willow-equivalent
  constant (recommend a OCC config/env kill switch to replace the server gate),
  taint/pending → withheld-notification paths; return
  `{mode:'auto', fromAutoFallback, notification}`; ~60-120 lines.
- `src/utils/permissions/autoModeState.ts` — add `provisionalStartupMode` /
  `autoDefaultWithheldForPendingVerdict` atoms (official store class vver
  @238538048) if the pending-verdict UX is wanted; can be omitted for a first cut.
- `src/main.tsx` — consume `notification` (surface at ~line 3379 already exists);
  wire `X0r/J0r` equivalents (fromAutoFallback / withheld telemetry).
- Flip `AUTO_MODE_ENABLED_DEFAULT` 'opt-in' → 'enabled' ONLY with a local kill
  switch; fix the stale "official default is opt-in" comment either way.
- Notification strings to copy verbatim: §5(a). Tests: extend
  `autoDefaultNudge296.test.ts` family.

**Regardless of the switch decision (small, do now):** correct the
`AUTO_MODE_ENABLED_DEFAULT` comment in `permissionSetup.ts` (official 303/304
parse-default is `"enabled"`, byte-verified @251169230/@253857395), and add the
LOW-1 try/catch around `main.tsx:2666-2701`.

---

## Appendix — helper artifacts

Dumps in `/tmp/cc-diff-304/`: `prev_resolver.txt` (12KB @238076634),
`ver_resolver.txt` (14KB @240588058), `ams_prev/ver.txt`, `ctx_/cw_/cm_/scc_/rc_/st_/san_/cb_/res_`
pairs, `q_prev.txt` (@266303000+9500), `q_ver.txt` (@268092500+9500 — note: the
blind window diff of these two misaligns; use the targeted function extractions in
§4 instead).

Collision register (do not trust these names without offsets): vver `ng()`
@240884624 = fableBilling reader (real GrowthBook predicate @240083899); vver
`gBr` @249071312 = Worker spawner (boot resolver is `BDr`); vver `Qpr=` @259626180
= "cc-ce-migrate" const (real rule fn @248240772); `RNe`/`XNe` have remote-transport
and design-consent namesakes (@266553910/@259881548) vs the zod schemas
(@242854595/@245469995).
