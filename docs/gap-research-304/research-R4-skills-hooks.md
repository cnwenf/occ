# R4 — Skills & Hooks gap research: official 2.1.303 → 2.1.304

Research subagent report. Static byte forensics only (binaries never executed).
Sources: `/tmp/cc-diff-304/{vprev,vver}/package/claude` (official ELFs), `new_strings.txt`,
`removed_strings.txt`, `s303.txt`/`s304.txt` (JS-text extractions). OCC tree at HEAD 87974fd7.

Method per item: (a) grep new/removed strings → (b) raw verify `grep -aboF` counts in both ELFs →
(c) verbatim context via offset + dd → (d) OCC cross-check (file:line) → (e) verdict.

Verdict legend: **PORT** = 304 change applies to OCC, port it. **STAGED/CAND** = candidate, not
fully recoverable or deferred. **N-A** = mechanism absent from OCC. **ALREADY-ALIGNED** = OCC
already matches 304 behavior.

---

## Verdict table

| Item | Subject | Verdict | OCC anchor |
|---|---|---|---|
| #58 | Tool search ON by default behind custom `ANTHROPIC_BASE_URL`; 400/422 retried without it | **PORT** (high value) | `src/utils/toolSearch.ts:286-338` |
| #59 | Compaction re-sends skill list; `/reload-skills` sends only new/changed | **PORT** | `src/utils/attachments.ts:3156-3247` |
| #31 | Resumed/cloud sessions re-sending whole skill list on plugin reload | **PORT** (same patch as #59) | `src/utils/attachments.ts:3158-3164` |
| #60 | Skill hooks bounds: 1,024 hooks + 16,384 matcher chars per source per session | **PORT** (simplified) | `src/utils/hooks/registerSkillHooks.ts` (no bounds) |
| #61 | Plugins-only hooks policy: main-conversation skill whose hooks kept out loses allowed-tools | **PORT** (small) | `src/utils/processUserInput/processSlashCommand.tsx:996-1010,1064,1070` |
| #39 | Skill's `once` hook removing another skill's identical hook | **PORT** (bug present in OCC) | `src/utils/hooks/registerSkillHooks.ts:41`, `src/utils/hooks/sessionHooks.ts:225-243` |
| #12 | Plugin keeping headless run past `--max-turns`/Stop/ended input | **N-A** | no `hostAsked`/`handedOffTurn`/CCR ledger in `src/` |
| #63 | Removed `claude plugin validate` notes predicting where mod hooks run | **N-A** | `src/commands/plugin/ValidatePlugin.tsx` has zero hook/module scanning |
| mods cluster #1,#2,#3,#13,#14,#15,#44,#55,#57 | Mod subsystem changes | **N-A** (whole cluster; #14 code-only even officially) | zero `loadedModules`/`registrationsFor`/`mod_hot_reload`/`plugin_dev_mods` hits in `src/`; occ146 ledger line 188 "mod loader (absent)" |

---

## #58 — Tool search on by default behind custom `ANTHROPIC_BASE_URL` (PORT, high value)

### Official change (vprev → vver)

**vprev (303)** optimistically DISABLED tool search when provider is firstParty but
`ANTHROPIC_BASE_URL` is a custom host. Verbatim, vprev ELF JS region ~239157270 (function `jy()`):

```js
if(!a.ENABLE_TOOL_SEARCH&&!l()&&xe()==="firstParty"&&!xi()){
  if(ea().claim("tool_search_optimistic_decision"))
    t(`[ToolSearch:optimistic] disabled: ANTHROPIC_BASE_URL=${a.ANTHROPIC_BASE_URL} is not a
first-party Anthropic host. Set ENABLE_TOOL_SEARCH=true (or auto / auto:N) if your proxy
forwards tool_reference blocks.`);
  return!1}
```

**vver (304)** removes that branch from the mode decision and adds a refuse-recovery loop.
New module (new_strings ~21956155; verified in vver ELF):

```js
var _="force";
function l(){try{if(qB())return!1;if(Pe()!=="firstParty")return!1;let e=Nze("ENABLE_TOOL_SEARCH");
 if(e===_)return!0;if(iWo()!==_)return!1;
 if(Fe(Nze("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")))return!1;
 return e===void 0||!g(e)}catch(e){...!1}}                     // isToolSearchForceOverride
function jan(){return VB()&&!l()}                                // betas-disabled gate
var h=86400000;                                                  // 1-day TTL
function zOe(){return!a.ENABLE_TOOL_SEARCH&&!l()&&Pe()==="firstParty"&&!Ri()}  // custom base URL, no override
function c(e){return S("sha256").update(`${a.ANTHROPIC_BASE_URL}\x00${Pn(e)}`).digest("hex").slice(0,24)}
function f(e){return typeof e==="number"&&Math.abs(Date.now()-e)<h}
function d(e){return zOe()&&f(ue().toolSearchRefusedAt?.[c(e)])}  // refused within last day
function DUs(e,r){if(d(e))return;
 t(`[ToolSearch] the endpoint set in ANTHROPIC_BASE_URL refused a request for ${e} and answered it
without tool search; tool search stays off there for a day. ENABLE_TOOL_SEARCH=false skips the
refused request; =true always sends tool search and turns this recovery off.`,{level:"warn"}),
 Ae((o)=>f(o.toolSearchRefusedAt?.[c(e)])?o:{...o,toolSearchRefusedAt:{...Cs(o.toolSearchRefusedAt,f),[c(e)]:Date.now()}},r)}
function XEe(){if(jan())return"standard";if(l())return"tst";
 let e=process.env.ENABLE_TOOL_SEARCH,r=e?xOo(e):null;
 if(r===0)return"tst";if(r===100)return"standard";
 if(E(e))return"tst-auto";if(Fe(e))return"tst";if(Rs(e))return"standard";return"tst"}  // default "tst" — no base-URL branch
function Zae(e){let r=e.toLowerCase(),o=b();for(let n of o)if(r.includes(n.toLowerCase()))return!1;
 return!d(e)}                                                     // vprev iae(e) ended `return!0`
```

Retry-without mechanism (new_strings 8014488 / 7992024):

```js
b6=(eo)=>{let Er=OVe(eo);return po&&zOe()&&im===void 0&&eo instanceof Ot&&
 (eo.status===400||eo.status===422)&&eo.type!=="billing_error"&&!J.resumeIncompleteThinking&&
 !Pw(Er)&&!vF(Er)},                                               // eligible refusal
tse=(eo)=>{if(b6(eo)){t(`[ToolSearch] HTTP ${eo.status} that no other recovery took, for a request
 that used tool search (${f1t.header}); making the call again without it...`,{level:"warn"});
 for(let Er of HO)uer(lt,Er);                                     // un-defer dropped tools
 if(WDe)$5o();throw new mZ("tool search refused",{cause:eo})}return}
class mZ extends Error{}
async function*ugn(...e){try{return yield*qmn(...e)}catch(V){if(!(V instanceof mZ))throw V}
 // re-run with withoutToolSearch:!0, prepending a critical_system_reminder:
 w=en({type:"critical_system_reminder",content:`${Ai} is no longer available. Tools listed earlier
 as deferred that are still available are declared in full: call them directly.`})
 K=qmn([...n,w],r,s,h,y,{...S,withoutToolSearch:!0});
 // on first assistant/message_start: DUs(S.model,S.storageV5) — records toolSearchRefusedAt,
 // and i("tengu_beta_400_healed",{beta:...,model:...,provider:gA(),unclaimed:!0})}
```

Gate-chain note (new_strings 11651861, `avr`): `H8e` yields `model_unsupported` (via `Zae`→`!d`)
for a refused endpoint+model; conversation-scoped held-off (`vgo`) now also conditioned on
`zOe()`: `function vgo(e){if(e?.has(Ai))return!0;return e?.size&&zOe()?!1:void 0}` with log
"Tool search disabled: this conversation has run without ToolSearch, and stays so until it is
compacted or cleared."

Raw verify: `toolSearchRefusedAt` vprev=0 / vver=2 (persisted-config key, NEW);
`tengu_beta_400_healed` vprev=0 / vver≥1; `is not a first-party Anthropic host` vprev=2 / vver=0 (branch REMOVED).

### OCC status

`src/utils/toolSearch.ts:286-338` — `isToolSearchEnabledOptimistic()` contains the **exact vprev
(303) behavior**, including the identical log line (toolSearch.ts:323). OCC comment block
(toolSearch.ts:299-315) already discusses the proxy trade-off (gh-30912 / gh-31936 / CC-457).
Callers: `src/tools.ts:254` (tool pool), `src/tools/ToolSearchTool/ToolSearchTool.ts:398`,
`src/services/tools/toolExecution.ts:661`, `src/utils/messages.ts:2248,2395,2507`.
No `toolSearchRefusedAt` / retry-without anywhere in `src/` (rg verified: only hits are the
optimistic gate). Note `refusedToolSchemas` (toolSearch.ts:532 comment) is the unrelated 302 #36 port.

**Verdict: PORT.** Official 304 resolves exactly the tension OCC's comment describes: default ON
behind custom base URL, self-heal on the first 400/422, then stay off for that endpoint+model for
a day. Huge relevance for OCC users behind LiteLLM/corp gateways.

### Recipe

1. In `getToolSearchMode()`/`isToolSearchEnabledOptimistic()`: drop the
   `!ENABLE_TOOL_SEARCH && firstParty && !isFirstPartyAnthropicBaseUrl()` disable branch
   (toolSearch.ts:315-328). Default mode becomes tool-search-on ("tst").
2. Add persisted config key `toolSearchRefusedAt: Record<string, number>`; entry key
   `sha256(\`${ANTHROPIC_BASE_URL}\0${normalizedModel}\`).slice(0,24)`; TTL 86_400_000 ms.
3. In the API error path (where 400/422 responses surface): if the request used tool search
   (beta header present) AND custom-base-URL-with-no-explicit-override AND status 400/422 AND
   `type !== "billing_error"` AND no other recovery claimed the error → re-issue the same request
   once with tool search off, un-defer any deferred tools, prepend the critical system reminder
   ("ToolSearch is no longer available. Tools listed earlier as deferred that are still available
   are declared in full: call them directly."), and on first assistant chunk record
   `toolSearchRefusedAt[key] = Date.now()` + warn log.
4. Model-support predicate (`isToolSearchSupported` equivalent of `Zae`): return false when the
   endpoint+model is in the refused window → downstream treats it as `model_unsupported`.
5. `ENABLE_TOOL_SEARCH=false` → mode standard (skips the refused request entirely);
   `=true`/`force` → always send, recovery off.

---

## #59 + #31 — Skill listing: history-scan digest dedupe replaces session state (PORT)

### Official change

**vprev** generator `hJr(e)` (vprev ELF ~246848401): session-state dedupe —
`sentSkillNames` Set per agentId, `resumeSeedNames` seeding on resume,
`gJr`/`replacedSkillNamesRead` for plugin-replace, `spo`/`x_s` (`suppressNext`).
Attachment shape: `{type:"skill_listing",content,skillCount,isInitial,names:K.map((ke)=>ke.name)}` —
**no digests**.

**vver** generator `EDr(e,n)` (new_strings 41431028; alias `vUn`; s304 41175439 for the digest):

```js
let K=new Map;
for(let be of n)                                   // n = actual message history
  if(be.type==="attachment"&&be.attachment.type==="skill_listing"){
    let{names:we=[],digests:Ee}=be.attachment;
    for(let[xe,Ie]of we.entries())K.set(Ie,(K.get(Ie)??new Set).add(Ee?.[xe]))}
let V=w.filter((be)=>{let we=K.get(be.name);
  return!we?.has(void 0)&&!we?.has(C8e(be))});     // not yet sent, or sent with older digest
if(V.length===0)return[];
let J=K.size===0;                                  // no prior listing in history → initial
t(`Sending ${V.length} skills via attachment (${J?"initial":"dynamic"})`);
return[{type:"skill_listing",content:uin(V,...),skillCount:V.length,isInitial:J,
  names:V.map((be)=>be.name),digests:V.map(C8e)}]
```

Digest (s304 41175439):

```js
function C8e(e){return nt(JSON.stringify([Ho(e),Ldt(e)])).slice(0,16)}
function Ldt(e){return e.whenToUse?`${e.description} - ${e.whenToUse}`:e.description}
```

(`nt` = sha hash, `Ho` = skill name key.) Agent-spawn caller wraps it:
`for(let R of await vUn(nt,Ls(he)).catch((P)=>(t(\`[Agent: ${e.agentType}] Failed to compute skill
listing attachment: ${P}\`,{level:"error"}),[])))`.

Consequences (matches changelog #59/#31 exactly):
- **Compaction** drops prior `skill_listing` attachments from context → history scan finds none →
  `K.size===0` → `isInitial` full re-send happens automatically.
- **/reload-skills / plugin reload**: only skills whose name is new OR whose digest changed pass
  the filter → delta send, not full re-send. Resumed/cloud sessions dedupe against the real
  transcript, so startup plugin reloads no longer re-send unchanged skills (#31).

Raw verify: `digests:` in skill_listing writer — vprev=0 / vver=2 (NEW); `Sending ${...} skills via
attachment` both versions (log line retained, semantics changed); `sentSkillNames`/`resumeSeedNames`
machinery gone from vver's generator region.

### OCC status

`src/utils/attachments.ts:3156-3247` — OCC uses the **vprev-style session-state** approach:
module-scope `sentSkillNames = new Map<string, Set<string>>()` keyed by agentId (3156),
`suppressNext` for --resume (3182-3185), `resyncSentSkillNamesAfterRewind` (2.1.301 #27 port,
3216-3247). Two OCC-specific divergences documented in-place:
- attachments.ts:3158-3160 comment: `resetSentSkillNames` is "Called when the skill set genuinely
  changes (plugin reload, skill file change on disk)... **NOT called on compact** — post-compact
  re-injection costs ~4K tokens/event for marginal benefit." → OCC deliberately skips the #59
  compaction re-send; official 304 now does re-send (isInitial path).
- attachments.ts:3211-3213 comment: "OCC's own skill_listing attachments never carry `names`
  (they hold {type, content, skillCount, isInitial})" — writer shape at attachments.ts:645.
- Plugin reload → `resetSentSkillNames()` clears everything → **full re-send even when nothing
  changed** = exactly the #31 bug, on every reload including startup reloads in resumed sessions.

**Verdict: PORT (one patch fixes #59 and #31).** Replace session-state dedupe with history scan +
digests.

### Recipe

1. Extend the skill_listing attachment writer (attachments.ts ~645) to emit
   `names: string[]` and `digests: string[]` (parallel arrays; digest =
   `sha256(JSON.stringify([name, whenToUse ? description + " - " + whenToUse : description])).slice(0,16)`).
2. Rewrite `getSkillListingAttachments(context)` to scan `context.messages` (the actual history
   the next request will carry) for prior `skill_listing` attachments, build
   `Map<name, Set<digest|undefined>>`, filter current skills to those not present with the same
   digest, `isInitial = (map.size === 0)`, return `[]` when nothing new.
3. Delete `sentSkillNames`/`suppressNext`/`suppressNextSkillListing`/`resetSentSkillNames`/
   `resyncSentSkillNamesAfterRewind` and their callers (conversationRecovery resume suppression,
   rewind resync in REPL, plugin-reload reset) — the history scan subsumes all three:
   resume sees the transcript's listings; rewind removes them from history naturally; compaction
   dropping them triggers the intended full re-send.
4. Keep the per-agent scoping by scanning only the messages of the agent's own thread (official
   passes `Ls(he)` = agent-local history).

---

## #60 — Skill hooks bounds: 1,024 hooks + 16,384 matcher chars per source per session (PORT, simplified)

### Official change (all NEW in vver)

Module (new_strings 19240584; s304 24873529; constants at new_strings 31464425,
chunk-9cvav3vj.js: `var K=2048,D=512,uIr=1024,pIr=16384`):

```js
var Kt=64,kt="This skill declares hooks, and they were not registered in this session: a limit on
hooks, a matcher that cannot be tested here, or the organization's policy kept them out. The tools
that its allowed-tools would grant were not granted either. If the skill relies on its hooks to
check or block tool calls, nothing checks them now: tell the user.";
function yt(e,n,o,u,s,T){                          // registry, sessionId, sourceKind, plugin?, skillName, hooks
  let h=e.skillDraws(n);if(h===void 0)return;      // per-source draw ledger from host
  let y=h.get(u??o)??{hooks:0,characters:0,texts:new Map,unfitTexts:0};h.set(u??o,y);
  let C=_([s,nt(_(T))]);if(y.texts.has(C))return y.texts.get(C);   // memo per (skill, hooks-hash)
  let I=0,v=0;
  for(let D of Object.values(T).flatMap((E)=>E??[])){
    let E=Math.max(1,D.hooks.length);I+=E,v+=(D.matcher?.length??0)*E}
  let H;
  if(y.characters+v>pIr)H="characters";
  else if(y.hooks+I>uIr)H="count";
  else if(ox()?.testsSkillMatchers(T)===!1)H="matcher";   // cloud host can't test matchers
  if(H!==void 0){if(y.unfitTexts===Kt)return H;y.unfitTexts++}    // warn-text cap 64/source
  if(y.texts.set(C,H),i("tengu_skill_hooks_bounds_checked",{outcome:c(H??"fits"),source_kind:c(o),
    hooks_asked:I,characters_asked:v,hooks_drawn_before:y.hooks,characters_drawn_before:y.characters,
    hooks_bound:uIr,characters_bound:pIr}),H===void 0){y.hooks+=I,y.characters+=v;return}
  t(`Skill '${s}' registers none of its hooks and grants no tools (${H}): the skills of one source
hold at most ${uIr} hooks and ${pIr} characters of matchers in a session, and a cloud session tests
some matchers only`,{level:"warn"}),X("warn","skill_hooks_do_not_fit",{reason:H});
  try{ox()?.skillHooksDoNotFit(o)}catch(D){t(`Hooks: the plugin hook runner threw when told of a
skill whose hooks do not fit (${d(D)}): the host's log line is lost`,{level:"warn"})}
  return H}
```

Registration also gained the host callback (s304 24874527):
`if(C>0){if(s!==void 0)ox()?.skillHooksRegistered(s,o);t(\`Registered ${C} hooks from skill '${u}'\`)}`.

Caller = the skill-launch path shared with #61 (below): `w=yt(...)`; unfit → `St(...)` not called
→ no hooks; `w!==void 0` → allowedTools stripped + `kt` appended.

Raw verify: `were not registered in this session` vprev=0 / vver=2 (kt NEW);
`tengu_skill_hooks_bounds_checked` vprev=0 / vver≥1; `skillDraws` vprev=0 / vver≥1.

### OCC status

`src/utils/hooks/registerSkillHooks.ts` — registers every hook unconditionally; no counts, no
matcher-character accounting, no per-source ledger (rg `skillDraws|16384|skill_hooks_do_not_fit`
→ zero hits). OCC has no plugin-host callback API (`ox()` equivalent), so the host notifications
(`skillDraws`, `skillHooksDoNotFit`, `skillHooksRegistered`, `testsSkillMatchers`) are N-A; the
bounds ledger itself ports cleanly as a module-local Map.

**Verdict: PORT (simplified).** Malicious/runaway skills can currently register unbounded hooks
in OCC sessions.

### Recipe

1. Module-local ledger in `registerSkillHooks.ts`:
   `Map<sourceKey, {hooks: number; characters: number; texts: Map<string, string|undefined>; unfitTexts: number}>`
   keyed by plugin id ?? source kind; `sourceKey` from `command.source`/`command.pluginInfo`.
2. Before registering: compute `hooksAsked = Σ max(1, matcher.hooks.length)` and
   `charsAsked = Σ (matcher.matcher?.length ?? 0) × max(1, matcher.hooks.length)`; refuse with
   reason `"characters"` (> 16_384 cumulative) / `"count"` (> 1_024 cumulative); memo the verdict
   per `sha256([skillName, hooksJson])`; cap warn logs at 64 per source.
3. On refuse: register nothing, return the reason to the caller (see #61 recipe step 2 — caller
   strips allowed-tools and appends the `kt` notice verbatim).
4. Skip the `matcher` reason (no cloud host in OCC) and the host callbacks.
5. Constants: `SKILL_HOOKS_BOUND = 1024`, `SKILL_MATCHER_CHARS_BOUND = 16384`.

---

## #61 — Plugins-only hooks policy now strips allowed-tools (PORT, small)

### Official change

Skill-launch caller, **vver** (vver ELF 267260072; s304 46784128) vs **vprev** (vprev ELF
266128400; s303 46013975). Verbatim vver:

```js
let r=v?[]:await _Xe(e),                                   // r = parsed allowed-tools (v when preload)
ge=!v&&(e.hooks!==void 0||r.length>0)?await Wpe(e):void 0,  // MCP-skill verification path
N=(!yd("hooks")||Yq(e.source))&&!v,                         // hooks allowed by plugins-only policy
ae=e.hooks!==void 0&&!N,                                    // NEW: hooks declared but kept out by policy
w;                                                          // NEW: bounds-unfit reason (#60)
if(ge!==void 0){let j={hooks:e.hooks!==void 0&&N,grant:r.length>0};
  if(j.hooks||j.grant)XLs(Jt(e.name),ge,j)}
else if(e.hooks&&N){let j=q();
  if(w=yt(o.sessionHooksRegistry,j,e.source,VVn(e),e.name,e.hooks),w===void 0)   // NEW yt gate
    St(o.sessionHooksRegistry,j,e.hooks,e.name,e.type==="prompt"?e.skillRoot:void 0,AFs(e),Vst(e.source),VVn(e))}
...
let O=ge!==void 0||w!==void 0||ae?[]:Hu(r);                 // NEW: strip allowed-tools on unfit/policy-kept-out
return{messages:[...,...w!==void 0||ae&&!v?[Re({content:Ol(kt),isMeta:!0})]:[],...],  // NEW kt notice
  en({type:"command_permissions",allowedTools:O,model:qke(e.model)})],
  shouldQuery:!0,allowedTools:O,...}
```

vprev at the same site: `U=J!==void 0?[]:Eu(ce)` — allowed-tools stripped ONLY on the MCP
verification path; `pt(...)` registered hooks with no bounds gate; no `ae`, no `w`, no kt notice.
So in 303 a main-conversation skill whose hooks were kept out by `strictPluginOnlyCustomization`
(`yd("hooks")`, surfaces `Wjt=["skills","agents","hooks","mcp"]`) still got its allowed-tools;
in 304 it gets `[]` plus the kt meta message telling the model the hooks aren't checking anything.

Note: the separate `getAllowedTools` factory gate (`gXe(rt)?[]:...` in the skill factory, new_strings
1066568) and the parse-time unloadableGuard (`FCr`: "the skill loads with no hooks and no
allowed-tools") are **identical in both versions** (raw verify: `the skill loads with no hooks and
no allowed-tools` 4/4; `unloadableGuards` 27/27) — #61 is purely the new `ae`/`w` interlock above.

### OCC status

`src/utils/processUserInput/processSlashCommand.tsx:996-1001`:

```ts
const hooksAllowedForThisSkill = !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source);
if (command.hooks && hooksAllowedForThisSkill) {
  registerSkillHooks(context.setAppState, sessionId, command.hooks, command.name, ...)
}
```

then line 1010: `const additionalAllowedTools = parseToolListFromCLI(command.allowedTools ?? [])` —
**unconditional**; flows into results at lines 1064 and 1070. This is exactly vprev behavior:
hooks kept out by policy, tools still granted. OCC's `getAllowedToolsGated`
(src/utils/permissions/frontmatterGrants.ts:142-156) gates on source trust
(`isAllowedToolsSourceTrusted`), not on hooks-kept-out.

**Verdict: PORT** — small, and closes a real policy hole (a skill relying on its PreToolUse hooks
to gate tools gets its allowed-tools granted with none of the hooks running).

### Recipe

1. processSlashCommand.tsx: hoist
   `const hooksKeptOutByPolicy = command.hooks !== undefined && !hooksAllowedForThisSkill`
   (plus, if #60 is ported, `const hooksUnfitReason = registerSkillHooks(...)` returning the
   bounds reason).
2. Line 1010: `const additionalAllowedTools = (hooksKeptOutByPolicy || hooksUnfitReason) ? [] : parseToolListFromCLI(command.allowedTools ?? [])`.
3. When either flag is set, append the official `kt` notice verbatim as an `isMeta: true` user
   message alongside the skill body: "This skill declares hooks, and they were not registered in
   this session: a limit on hooks, a matcher that cannot be tested here, or the organization's
   policy kept them out. The tools that its allowed-tools would grant were not granted either. If
   the skill relies on its hooks to check or block tool calls, nothing checks them now: tell the user."
   (OCC wording may drop the cloud-matcher clause if #60 ports without it.)
4. Mirror in the worker-summary branch only if it ever registers hooks (it doesn't today —
   processSlashCommand.tsx:960-990 lists tools textually; official does the same).

---

## #39 — Skill `once` hook removing another skill's identical hook (PORT; bug live in OCC)

### Official change

vprev registration (s303 24433654, function `pt`):

```js
let D=L.once?()=>{t(`Removing one-shot hook for event ${A} in skill '${u}'`),e.remove(n,A,L)}:void 0;
```

vver (s304 24874527, function `St`):

```js
let E=D.once?()=>{t(`Removing one-shot hook for event ${I} in skill '${u}'`),
  e.remove(n,I,D,{skillRoot:s})}:void 0;
e.add(n,I,H.matcher||"",D,{onHookSuccess:E,skillRoot:s,personal:T,checkout:h})
```

The removal call gained the 4th identity argument `{skillRoot:s}`, so the registry only removes
the hook belonging to THAT skill. In vprev, two skills declaring byte-identical hooks (same
matcher + command) shared one removal: skill A's once-hook firing also unregistered skill B's copy.

Raw verify: `Removing one-shot hook for event` 2/2 (string kept, call signature changed — the diff
is in the JS region, quoted above from both ELFs).

### OCC status — same bug as vprev

`src/utils/hooks/registerSkillHooks.ts:36-44`: `onHookSuccess` →
`removeSessionHook(setAppState, sessionId, eventName, hook)` — no skillRoot passed.
`src/utils/hooks/sessionHooks.ts:225-243`: `removeSessionHook` filters
`matcher.hooks.filter(h => !isHookEqual(h.hook, hook))` across ALL matchers of the event —
skill-identity-blind. OCC already threads `skillRoot` through `addSessionHook` (7th param,
sessionHooks.ts:68; stored on the matcher — see "Extended hook matcher that includes optional
skillRoot" at sessionHooks.ts ~270 and hooks.ts:2664,2682,3123-3127), so the fix is localized.

**Verdict: PORT.**

### Recipe

1. `registerSkillHooks.ts`: pass `skillRoot` into the removal:
   `removeSessionHook(setAppState, sessionId, eventName, hook, skillRoot)`.
2. `sessionHooks.ts removeSessionHook`: accept optional `skillRoot?: string`; when provided,
   filter with `!(isHookEqual(h.hook, hook) && (matcher.skillRoot ?? undefined) === skillRoot)`
   (matchers store skillRoot already via addSessionHook); when absent, keep current behavior for
   other callers (goal command uses prompt-hook removal without skillRoot — commands/goal/index.tsx:109).
3. Test: two skills, identical `once: true` PreToolUse hook, different skillRoots; fire one;
   assert the other's hook still registered.

---

## #12 — Plugin keeping headless run past limits (N-A)

### Official change

Run-limits ledger module (dumped from both ELFs: vprev 261143562, vver 273313910; diffed).
vver adds:

```js
// registration: ato.set(()=>this.spawnedTurnTaken()),Pen.set(wqr),Ien.set(U_r)
spawnedTurnTaken(){Bf(()=>{let e=wf()===this.seatedIn;
  if(this.turns+=e?1:0,this.spent()!==void 0)ISn({turnGoesOn:!0})})}   // NEW: spawned turns count
turnStarted(e){Bf(()=>{this.isHostsOwnTurn=e.some(Hu),this.tally(e);
  let n=this.limits.drain.abortController?.signal.aborted===!0;
  e.filter(dm).forEach((r)=>{let s=r.handedOffTurn?.messages[0]?.uuid;   // NEW: handed-off turns recorded
    xnr({uuid:s,origin:void 0,isHidden:!1,isStopped:n,isRelayed:!1,foreignWord:void 0,
         ownWordUuids:[s],input:""})})})}
// tally: if(e.some(nh)||e.some(dm))this.turns=0        (vprev: only own-word)
// taken(): adds drainingHandoff uuids:
//   {drainingHandoff:S}=e, y=S?.running===!1?S.command.handedOffTurn?.messages[0]?.uuid??[]:[]
//   return [...parked,...heldBack,...[y].flat()]
```

with `dm(e)`: `e.handedOffTurn?.kind==="run" ? e.handedOffTurn.messages[0] : void 0` is a
host-word user message (s304 11571944), and `ISn({turnGoesOn})` (s304 43078087) settles held
commands on the stop path. Net effect: a plugin/mod that spawns subagents or re-runs a finished
turn ("hands off" a turn) now has those turns counted against `--max-turns`
(`spent()` → "the run reached its --max-turns limit") and the run stops instead of continuing.

### OCC status

The whole mechanism is the cloud/remote-control (CCR) host ledger: `hostAsked`, `ownWord`,
`handedOffTurn`, `drainingHandoff`, `seatedIn`, `spawnedTurnTaken` — **zero hits in `src/`**
(rg verified). OCC's headless `maxTurns` lives in `src/QueryEngine.ts:202,512,1045,1690-1722`
and counts real model turns; there is no plugin surface that can hand off or re-run turns
(no mods subsystem — see below).

**Verdict: N-A.**

---

## #63 — Removed `claude plugin validate` notes about where mod hooks run (N-A)

### Official change

vprev validate note generator `pir` (s303 23951066, exported beside `dqt`/`lqt`):

```js
function pir(e,o){let t=D([...dqt(o.map((n)=>n.pattern)),...o.flatMap((n)=>lqt(n.doors))]),
  r=t.length>0,s=o.some((n)=>n.isDoorUnread);
return[...r?[`${e} hooks on ${t.join(", ")} do not run in a plugin a person installs where an
organization manages Claude Code: there, these events pass over the plugins you install, and only
a plugin the organization lists in managed settings runs them`]:[],
...s?[`${e} holds a session.append hook to a door its source does not spell: whether it runs where
an organization manages Claude Code cannot be told from the source`]:[]]}
```

Called in vprev's validate loop (s303 13478281): `C.push(\`${k} hooks: ${q}\`,...pir(k,V),...)`.
vver's same loop (s304 13677011) drops `...pir(k,V)` entirely — and adds a different new warning:
`"/${Gg(Y,200)}" is a name Claude Code ships: $.command.register refuses it and the hook that
calls it is skipped`.

Raw verify: `do not run in a plugin a person installs` vprev=2 / vver=0 (REMOVED);
`isDoorUnread` vprev=3 / vver=0; `is a name Claude Code ships` vprev=0 / vver=2 (NEW).

### OCC status

`src/commands/plugin/ValidatePlugin.tsx` — zero `hook` matches (rg). OCC's plugin validate never
scanned hooks modules or emitted these notes (the whole mod-hooks scanning pipeline
`cQs`/`Boi` — registrations, doors, renderMatchers, catchReads — is absent from OCC).

**Verdict: N-A** (nothing to remove). The new shipped-name warning is also N-A (no `$.command.register`).

---

## Mods cluster — #1, #2, #3, #13, #14, #15, #44, #55, #57 (N-A, one section)

### What "mods" are in official 2.1.304

Session-scoped **JS hook modules** shipped inside plugins (manifest `modules` map; validated by
`claude plugin validate` scanning each module's source). A mod registers hooks on *doors*
through a `$` API and a typed `contract.ts` ("the contract holds code that would run — a contract
is types only", removed_strings 9270063). Doors observed verbatim in the policy-registration
module (vver ELF 274382589 region): `classic.*`, `prompt.section|context|attachment|compose`,
`skill.prompt`, `attribution.text`, `session.append` (doors: attachment/hook-context/compaction/
tool-message/note/queue), `session.compact`, `settings.read`, `tool.describe`, `command.describe`,
`agent.offer`, `agent.spawn`, `tool.register`, `tool.list`, `tool.check`, `engine.create`, plus
`$.command.run` / `$.command.register` / `$.prompt.submit` (removed_strings 7923594) and
`$.ui.render|status|log|open|close`, `$.session.messages|id|usage`, `$.clock`, `$.process.run`,
`$.fs.*`, `$.store.*` (new_strings 10385176). Runtime: `Oe().loadedModules` with
`registrationsFor("command.run")` (s304 24874527 region); hot-reload ask source
`"mod_hot_reload"`, header `"Mods"`; policy keys `allowManagedModsOnly`,
`allowModsToOverrideDenyRules`; refusals list `diskless|hooks_modules_off|all_hooks_disabled|
sideload_disabled|local_dirs_blocked|managed_hooks_only|hooks_disabled_in_settings|safe_mode|
bare_mode|untrusted` (vver ELF 267682811). Mods can draw UI ("mod drawing in the chat panel" —
VSCode changelog line 67) and Claude can write them in-session behind the #57 question.

### OCC surface check

- rg `loadedModules|registrationsFor|mod_hot_reload|plugin_dev_mods|session.append|hooksModule`
  in `src/` → **zero hits**.
- `src/commands/plugin/ValidatePlugin.tsx` has no module/hooks scanning (see #63).
- Docs ledger already ruled: `docs/upstream-version-gap-occ146-2026-10.md:188` — "**#7** installed
  mods not loading in first session after upgrade — mod loader (absent)."

**Verdict: N-A for the entire cluster.** Per-item official evidence (for future reference if OCC
ever ports the mod subsystem):

- **#1** transcript line when a plugin that runs first skips your mod's hook — NEW (vprev=0/vver=2):
  ```js
  var XDn=(e,n)=>`its ${e} hook was skipped. "${n}" runs first and sent the event on past it.`;
  function QDn(e,n,r){...if(y?.isPersons!==!0||S===void 0)return;let w=re(XDn(s,n4(Tm(S))),rA);
    h5(n,w),pG({name:n4(n),source:y.pluginStorageId},w)...}   // new_strings 44816120
  ```
- **#2** `decider:"person"` on `tool.check` — arbitration module (vver ELF 274382589; `decider`
  raw count 23→32):
  ```js
  function ie(e,t){let s=t.decider;return e.decision==="ask"&&e.decider==="host"&&s==="person"&&
    f({...e,decider:void 0},{...t,decider:void 0})}
  var de=(e,t)=>!A(e,t)&&!f(e,t)&&!ie(e,t)&&(e.decision==="deny"||e.rule!==void 0||...)
  ```
  vprev's `ae=(e,t)=>!R(e,t)&&!l(e,t)&&(...)` lacked the `ie` term — a mod answering
  `ask`/`decider:"person"` matching the final outcome no longer counts as an override violation;
  only the permission dialog or host callback can approve, else refused with the mod's reason.
- **#3** `e.isReadOnly` on the `tool.check` event — new_strings 1845978:
  `let G=!1;try{G=e.isReadOnly(ne)}catch{}...let Q=await k4r({host:o,readOnly:G,...})`
  (`isReadOnly` raw count 115→121).
- **#13** failed mod reload messages — vprev `function R_r(e,n){return\`reload failed, the
  previous version stays loaded: ${rRe(e,n)}\`}` (unconditional claim) → vver
  `function evr(e,n){let r=LN(e,n);return n instanceof RU?\`reload failed, the previous version
  stays loaded: ${r}\`:\`reload failed: ${r}\`}` (vver ELF ~249483756 region).
- **#44** load/reload/fail lines — vver adds `ses(e)` (filter before/after/present by
  `e.before.has(r)||!e.unserved.has(r)`), `bgo` (adds `("new","not-loaded")` lines for unserved
  after-only plugins), `hes` (try/catch: "plugin-dir watch: the plain words for ${n.root} threw,
  so its own lines are told").
- **#15** mod sharing secret scan — new_strings 41154707 (plugin-authoring skill guidance):
  "The secret scan tool is not available in this session: ... So the scan in the share steps
  cannot run here, and a mod cannot be shared until it can: do not open, print or search any file
  in the folder of a mod to be shared, and tell the person why it can't be shared."
- **#55** `settings.read` layers — new_strings 1956923/2244072:
  `Qp={event:"settings.read",pinnedKeys:["source"],restoreArgument:(e,o)=>({...e,layers:o.layers}),
  checkArgument:..."a changed source (pinned: the layers are that read's)"}`; dispatcher
  `ori()` sends `args:{layers:[{source,settings},...]}` and merges the rewritten answer per key
  with fit-checks (`QEo`/`BRr`) and layer attribution (`e.findLast(P=>Object.hasOwn(P.settings,s))?.source`);
  refusal log "settings.read: refused to the engine (...); the settings' own values stand".
- **#57** mods-enable question — vprev (ELF 260875310):
  `var W="Enable hot reloading for this session?";var de=(o,e)=>\`${W}\n\n${po(o,e)}\`;...
  n=e===0?de(o.folder,r):fe(o.folder,r)` (folder + when rendered; explain-retry loop ≤3).
  vver (ELF 267682811): `var F="Turn on the mods Claude writes in this session?";
  var te=(o)=>\`${F}\n\n${go(o)}\`;...n=e===0?te(r):ne(r)` — folder/session-id argument dropped,
  suffix takes only "turn-end"/"now". Choice label "Turn them on" (new_strings 42205712).
  Raw verify: `mods Claude` vprev=0 / vver=2.
- **#14** button click lost when same-label keyless buttons redrawn unchanged — **CAND/unrecoverable**:
  the button components are byte-identical between versions (new_strings 3871722 ≡ s303 3957049,
  React-compiler memoized `re(o)`/`G(o)` keyed on children/disabled only); the fix is in
  minified reconciliation code with no string footprint. Moot for OCC (N-A) anyway.

---

## Cross-cluster notes

1. **#60 and #61 share one call site** (skill launch, vver ELF 267260072). One OCC patch in
   `processSlashCommand.tsx` can land both: `registerSkillHooks` returns an unfit reason (or
   undefined), caller strips allowed-tools and appends the `kt` notice for either
   policy-kept-out (`ae`) or bounds-unfit (`w`).
2. **#59/#31 subsumes two prior OCC ports**: `resyncSentSkillNamesAfterRewind` (301 #27 port,
   attachments.ts:3216) and `suppressNextSkillListing` (resume suppression) both become dead code
   under history-scan dedupe — history is the single source of truth for what the model has seen.
   The rewind port's own comment says the official delta writer shape carries `names` — 304 adds
   `digests` alongside, completing that shape.
3. **#58 interacts with OCC's conversation-scoped auto-hold** (302 port, `auto_held` in the mode
   gate): official vver conditions held-off on `zOe()` (custom base URL) — `vgo(e)`: conversation
   ran without ToolSearch → held off until compact/clear, but only behind a custom base URL.
   Check OCC's hold isn't broader when porting.
4. **The `kt` notice is model-facing text** — it instructs the model to tell the user that nothing
   is checking the skill's tool calls. Keep it verbatim if ported; it's the safety half of #60/#61.
5. **Mods cluster is a hard N-A** and should be recorded in the gap ledger as such (occ146 line
   188 precedent), so future rounds skip the 9 changelog lines quickly. The official decider-count
   rise 23→32 is entirely inside mod arbitration.
6. **#12 is N-A but adjacent to OCC's headless path**: if OCC ever ports remote-control or the
   mod hand-off (`handedOffTurn`) machinery, the `spawnedTurnTaken` ledger hook (vver ELF
   273313910 region) must come with it — that's the fix.

## Offset index (for re-verification)

| Evidence | Location |
|---|---|
| vver #58 module (XEe/zOe/DUs/Zae/l/jan) | new_strings ~21956155 |
| vprev #58 disable branch (jy) | vprev ELF ~239157270 |
| #58 retry (b6/tse/mZ/ugn) | new_strings 8014488 / 7992024 |
| #58 gate chain (avr/H8e/vgo) | new_strings 11651861 |
| vver #59 generator (EDr/C8e/Ldt) | new_strings 41431028; s304 41175439 |
| vprev #59 generator (hJr) | vprev ELF ~246848401 |
| #60 bounds (yt/kt + constants) | new_strings 19240584; s304 24873529/24872751; constants new_strings 31464425 |
| #61/#60 caller vver | vver ELF 267260072 (s304 46784128) |
| #61 caller vprev | vprev ELF 266128400 (s303 46013975) |
| #39 St vver / pt vprev | s304 24874527 / s303 24433654 |
| #12 ledger vprev / vver | vprev ELF 261143562 / vver ELF 273313910; dm s304 11571944; ISn s304 43078087 |
| #63 pir vprev / validate loops | s303 23951066 / s303 13478281 vs s304 13677011 |
| mods arbitration vprev / vver | vprev ELF 271349757 / vver ELF 274382589 |
| #57 question vprev / vver | vprev ELF 260875310 / vver ELF 267682811 |
| #1 XDn/QDn | new_strings 44816120 |
| #13/#44 reload lines | new_strings 44849203 region (rl-vprev/rl-vver diff) |
| #15 secret scan text | new_strings 41154707 |
| #55 settings.read layers | new_strings 1956923 / 2244072 |
