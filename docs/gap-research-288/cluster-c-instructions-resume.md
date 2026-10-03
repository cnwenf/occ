# Cluster C — Instruction-file loading + Resume/Compaction (2.1.287 → 2.1.288)

Research round: official Claude Code v2.1.287 → v2.1.288 catch-up.
Binaries: `/tmp/cc-diff-288/v287/package/claude` (244,317,368 B), `/tmp/cc-diff-288/v288/package/claude` (245,734,584 B). Method: strings dumps + `grep -aobF` offsets + `dd` windows only (never executed). OCC source at `src/`. All offsets are byte offsets into the ELF.

**Verdict summary**

| # | Entry (abridged) | Verdict |
|---|---|---|
| 53 | Write/Edit creating a file didn't load path-scoped rules / nested CLAUDE.md (only Read did) | PORT-CANDIDATE |
| 61 | InstructionsLoaded hook omitted agent_id/agent_type on subagent file-access loads; effort now reported | PORT-CANDIDATE |
| 46 | Org design systems left out when starting slides/design with Artifact tool | NO-OP{NO-SURFACE} |
| 49 | Claude 3 Opus/Sonnet sessions failed every turn after a whole PDF entered the conversation | PORT-CANDIDATE |
| 9 | "Prompt is too long" instead of auto-compacting when last reply reported zero token usage | PORT-CANDIDATE |
| 10 | `--resume` sometimes dropped files/context a compaction had just restored | STAGED |
| 11 | Resumed session sometimes didn't save the last response of a turn | PORT-CANDIDATE |
| 12 | Resume loaded a transcript cut short when the same session rewrote the file during the load | PORT-CANDIDATE |
| 13 | Resuming a conversation started on ≤2.1.286 dropped the model's earlier thinking | STAGED |
| 79 | `/autocompact` saves the auto-compact window per model | PORT-CANDIDATE |
| 65 | Auto mode: classifier-transcript overflow now compacts instead of prompting/failing every tool call | PORT-CANDIDATE |
| 70 | "You should know" notes said "we"/"the main agent"/"you" depending on who was responsible | NO-OP{NO-SURFACE} |

---

## Instruction-file loading

### #53 — path-scoped rules / nested CLAUDE.md not loaded when Write/Edit touches a file in scope — **PORT-CANDIDATE**

**Changelog:** Fixed path-scoped `.claude/rules` and nested CLAUDE.md files not loading when Write/Edit creates or changes a file in their scope; previously only Read triggered the load.

**Official forensics (recovered in prior round, re-verified):** the official trigger set for nested-memory attachments (`nestedMemoryAttachmentTriggers`-equivalent) is `.add()`-ed from Read **and** Write **and** Edit success paths; the drain runs once per turn in the attachment pipeline. The dynamic-skill-dir trigger set (same shape) is wired to all three tools in both versions — v288 aligns the nested-memory trigger to it. No new string literals (pure call-site additions), located by comparing the Write/Edit success paths in v287 vs v288 windows.

**OCC state (verified myself this round):**
- Trigger set declared: `src/Tool.ts:227` (`nestedMemoryAttachmentTriggers?: Set<string>`).
- Drain: `src/utils/attachments.ts:2275-2301` (`getNestedMemoryAttachments` — early-returns on empty set, iterates, `clear()`s).
- **Only 3 `.add()` sites, ALL in FileReadTool**: `src/tools/FileReadTool/FileReadTool.ts:1060`, `:1082`, `:1424`. `grep -rn nestedMemoryAttachmentTriggers src/tools/` shows nothing in FileWriteTool/FileEditTool.
- Port pattern already exists in-tree: `dynamicSkillDirTriggers?.add(dir)` is wired to all three tools — `FileReadTool.ts:736`, `FileWriteTool.ts:564`, `FileEditTool.ts:605`.

**PORT details:** add `context.nestedMemoryAttachmentTriggers?.add(fullFilePath)` on the success path of FileWriteTool (next to the `dynamicSkillDirTriggers?.add(discoveredDir)` at :564) and FileEditTool (next to :605), mirroring FileReadTool.ts:1424. Conditional rules (`src/utils/claudemd.ts:890-1122`, `:1861-1906`) and the drain already handle the rest.

### #61 — InstructionsLoaded hook missing agent_id/agent_type on subagent file-access loads; effort reported — **PORT-CANDIDATE**

**Changelog:** Fixed the InstructionsLoaded hook omitting `agent_id`/`agent_type` when a subagent's file access loads a rule or nested CLAUDE.md; file-access loads now also report `effort`.

**Official forensics (recovered prior round):** v288 passes the agent context into the hook-input builder on the file-access load path (base hook input receives `agentInfo`), and the InstructionsLoaded payload on that path carries `effort`. Marker windows: InstructionsLoaded schema/emit region compared v287 vs v288 (`ins287.txt`/`ins288.txt` saved windows).

**OCC state (verified myself this round):**
- `src/utils/hooks.ts:6147-6181` `executeInstructionsLoadedHooks(...)` builds `hookInput` with `...createBaseHookInput(undefined)` — **agentInfo not passed** (:6166), and no `effort` field in the payload.
- `createBaseHookInput` (`src/utils/hooks.ts:448-481`) **already supports an `agentInfo` argument** — the plumbing exists.
- Emit sites: `claudemd.ts:1404-1421`, `:1579-1594`, `:1610-1625`; `attachments.ts:1838-1855`.
- Schema: `src/schemas/coreSchemas.ts:710-722` — `effort` not in the InstructionsLoaded schema.
- Subagent context available at: `src/Tool.ts:257/:260`, `src/utils/runAgent.ts:906-910`, `src/utils/forkedAgent.ts:470-471/:535-537`.

**PORT details:** thread the calling agent's `{agentId, agentType}` from the tool/subagent context into `executeInstructionsLoadedHooks` → `createBaseHookInput(agentInfo)`; add `effort` to the payload + schema for file-access load reasons.

### #46 — org design systems omitted when starting slides/design with Artifact tool — **NO-OP{NO-SURFACE}**

**Changelog:** Fixed Claude leaving out your organization's design systems when starting slides or a design with the Artifact tool on Team/Enterprise plans or machines with managed settings.

**Forensics (minimal, this round):** `design system` 212=212, `designSystem` 38=38, `design_system` 122=122 occurrences v287=v288 — the fix changed no strings; it lives entirely in the Artifact/org-design-system module.

**OCC state:** no Artifact design surface — OCC has only a dead 3-line `ReviewArtifactTool` stub; org design systems (Team/Enterprise managed-settings feature) are not implemented.

**Verdict:** NO-OP{NO-SURFACE}. Revisit when the Artifact tool is ported.

### #70 — "You should know" note pronouns — **NO-OP{NO-SURFACE}**

**Changelog:** Fixed "You should know" notes saying "we"/"the main agent"/"you" depending on who was responsible.

**Forensics (this round):** `You should know` 27→28 (+1). The feature is the builtin mod `cc-plugin-you-should-know@builtin` added in 2.1.287 (v288 window: `var Ye={"You should know":"you_should_know","Heads up":"heads_up"}`; mod description "a side agent watches your back while Claude works on longer tasks"). The fix is pronoun wording in that mod's note-composition prompt.

**OCC state:** zero `You should know` hits in `src/` — OCC has no mods ecosystem and no such builtin mod.

**Verdict:** NO-OP{NO-SURFACE}.

---

## Resume / compaction

### #9 — zero token usage → "Prompt is too long" instead of auto-compacting — **PORT-CANDIDATE**

**Changelog:** Fixed long conversations failing with "Prompt is too long" instead of auto-compacting when the last reply reported zero token usage.

**Official forensics (delta fully recovered):**
- v287 walk-back (`b$` @~207131000): `...let g=Pue(s);if(g.input_tokens+g.cache_creation_input_tokens+g.cache_read_input_tokens===0)return 0;...` — a zero-usage assistant message **returns 0** → token count undercounts → `shouldAutoCompact` sees a tiny window → skips compaction → next request hits PTL.
- v288 walk-back (`HO` @~208245900, window `w288_ho.txt`): `function Nwt(e){return s7n(Dpe(e))===0}function HO(e){...if(Nwt(s))continue;...}` — zero usage → **continue walking back** to the last message with real usage.
- v288 anchor finder `Fwt` requires `!Nwt(s)`, adds a compact-boundary case `if(r&&ii(r))return{tokens:0,anchorIndex:n}`, returns precomputed `{tokens:Ax(s),anchorIndex:n}`; consumers v287 `Bm` → v288 `Am` (`r.tokens+Vm(...)`).
- Helpers @203209569: `Dpe` (usage normalization with iterations fallback; skips `advisor_message`/`compaction` iteration types), `Ax(e){let n=Dpe(e);return s7n(n)+n.output_tokens}`, `s7n(e){return e.input_tokens+e.cache_creation_input_tokens+e.cache_read_input_tokens}`.

**OCC state (verified myself):** `src/utils/tokens.ts:7-22` `getTokenUsage` is **presence-only** (returns the usage object if present, no non-zero guard); walk-back at `tokens.ts:269-304` stops at the first message that merely *has* usage — a zero-usage reply yields 0 tokens, exactly the v287 bug. Autocompact arithmetic: `src/utils/autoCompact.ts:266-279` (tokenCountWithEstimation − snipTokensFreed vs effectiveWindow − 13000 @:75/:85-89). PTL handling: `src/utils/errors.ts:69/:593-607/:1084-1091`.

**PORT details:** in the walk-back, skip assistant messages whose `input+cache_creation+cache_read === 0` (keep walking); make the anchor/estimation path require non-zero usage and handle the compact-boundary row (tokens 0). Mirrors v288 `Nwt`/`HO`/`Fwt`.

### #10 — `--resume` dropping files/context a compaction had just restored — **STAGED**

**Changelog:** Fixed `--resume` sometimes dropping files and other context that a compaction had just restored.

**Forensics (extensive, delta NOT recovered):** no new string literals attributable to this entry. Searches performed and results:
- `post_compact` 28=28, `file_restore` 4=4, `post_compact_file` 4=4, `preCompactDiscoveredTools` 9=9, `preservedMessages` 33=33, `preservedSegment` 30=30, `preserved_dispatch` 3=3, `restoredCount` 2=2, `compact_boundary` 64=64.
- Post-compact file-restore builder: v287 `Rvo` ≡ v288 `ZNo` (window around `tengu_post_compact_file_restore_success`, saved `fr287.txt`/`fr288.txt`) — identical modulo renames (same filter chain, same `$No`/`kvo` byte budget, same telemetry names).
- `precompact.json` sidecar module (writer `cjt`/`XLt`, readers `ujt`/`QLt`, `BFo`/`Gvo`, 8 MB cap `ZU`/`fU`, version `PNe=3`/`IDe=3`): byte-compared v287@208019200 vs v288@209131100 — identical modulo renames (`pj287.txt`/`pj288.txt`).
- Preserved-segment scanner (`remoteSourced!==!0`, `lastKeptSeen`, `summarySeen`, `allUuids`): counts equal (12/13 remoteSourced — the +1 is the unrelated cache-warmth `Fke` registration in the `NLo` idle-hint module @209028131, a different entry); scanner cluster v287@209056285-209065907 ≡ v288@210200382-210210004 matched 1:1.
- Resume deserialize call (`replyOnResume, rewindAnchorUuid, resumeInterruptedTurn, hostAnswerableToolUseIds, restoredCardToolUseId`): same 8-arg shape both versions (`I6t`≡`sXt`).
- `tengu_resume_first_turn_announcement_census` 2=2.
- readFileState offset alignment: all resume-region clusters matched 1:1; the +5 v288 hits are in the deferred-write/permission-stash module @235878062 (cluster A territory) and the memory_update attachment module @210672247 — unrelated.

**Assessment:** the fix is a pure conditional/ordering change with no string footprint inside regions that compare identical after rename normalization; recovering it needs a full normalized AST diff of the resume pipeline beyond strings/grep/dd reach.

**OCC state (surface is real, mapped):** compaction restores files via `createPostCompactFileAttachments` (`src/utils/compact.ts:583`, builder :1501-1550, `POST_COMPACT_MAX_FILES_TO_RESTORE=5` :133, readFileState snapshot+clear :568-579, plan/plan-mode/skill attachments :595/:602/:608, delta re-announce :617-635); restorations persist post-boundary so resume sees them; resume-side guards `applyPreservedSegmentRelinks` (`sessionStorage.ts:2032-2149`), `applySnipRemovals` :2175, preservedSegment tail flush before boundary (`QueryEngine.ts:851-866`). **Verdict: STAGED** — re-attempt when a later official patch adds a string/telemetry anchor, or via behavioral e2e (compact → exit → `--resume` → check restored-file attachments survive).

### #11 — resumed session not saving the last response of a turn — **PORT-CANDIDATE**

**Changelog:** Fixed a resumed session sometimes not saving the last response of a turn, so the next `--resume` showed the prompt unanswered.

**Official forensics (delta fully recovered via telemetry count-diff):** `tengu_transcript_parent_wait` **0 hits v287 → 2 hits v288** (all other `tengu_transcript_*` counts identical: accessed 2, compact 3, compact_failed 7, exit 2, id_scan_fallback 2, parent_cycle 3, phantom_parent 2, preserved_dispatch 3, write_failed 3, writer_recovered 3).
- v288 recorder class `pSe` @~229547500 (window `w288_pw.txt`): new `parentWait=void 0` field; record→write split; on write():
  - head-pending reset also clears parentWait + telemetry `{cut_short:!0,replayed:!1}`;
  - compact-boundary-tail skip: `if(Xuo(h))return;` where `Xuo(h){let E=h.findLast((N)=>N.type==="user"||N.type==="assistant"||ii(N));return E!==void 0&&ii(E)}` (don't write when the tail is a bare compact boundary);
  - **overtaken hold**: `if(this.parentWait!==void 0){this.parentWait.overtaken+=...;this.parentWait.next={messages:h,options:E,sessionId:q()};return}` — a newer snapshot arriving while a write is in flight is *held*, not raced;
  - continuation detection (`Ge||qe||pt`) → no wait state; else `Kt={startedAt:Date.now(),overtaken:0,next:void 0,exitWaited:!1}`;
  - write promise settles → `endParentWait(Kt,...)` **replays** the held snapshot (`replay({messages,options})→this.write(...)` returning `{isReplayed,settled}`);
  - exit-wait registration `Zuo(Lt,Kt)` = `FLt(()=>(E.exitWaited=!0,h));h.finally(N)` — process exit waits for the replayed write;
  - telemetry `XZe`: `i("tengu_transcript_parent_wait",{write_ms, snapshots_overtaken, exit_waited, ...cut_short/replayed/write_rejected})`; `.then((io)=>{if(Xt===this.callSequence&&io&&!Ge)this.lastParentUuid=io;...})`.
- v287 recorder `SSe` @~228223400 (window `w287_rec.txt`): fire-and-forget `wv(...).then((_t)=>{if(Ut!==this.callSequence)return;if(_t&&!qe)this.lastParentUuid=_t})` — concurrent writes race; an overtaken write drops its parentUuid result; no exit-wait; no boundary-tail skip. `parentWait`: 0 hits in v287.

**OCC state (verified myself):** `src/screens/REPL/hooks/useLogMessages.ts:69` — `void recordTranscript(slice, ...)` fire-and-forget with `const seq = ++callSeqRef.current` guard (:85: `if (seq !== callSeqRef.current) return` — **the overtaken write's `lastRecordedUuid` is dropped**, v287 shape exactly); parent hint :110-113. Turn-end `flushSessionStorage` only under EAGER_FLUSH/IS_COWORK (`QueryEngine.ts:1274-1284`); graceful-exit flush exists (`sessionStorage.ts:602-626` via `gracefulShutdown.ts:476`) but nothing waits for an *overtaken in-flight* write; `process.on('exit')` covers costs only (`print.ts:5064`).

**PORT details:** give the recorder a parentWait state machine — hold the newest snapshot when a write is in flight, replay it after the in-flight write settles, register the replay with the exit-wait set, skip writes whose tail is a bare compact boundary, and emit the `tengu_transcript_parent_wait` telemetry shape. Touch points: `useLogMessages.ts:60-113`, `sessionStorage.ts` recordTranscript (:1596-1637) / flush (:1019) / drain (:823), `gracefulShutdown.ts` cleanup registration.

### #12 — resume loading a transcript cut short by a concurrent same-session rewrite — **PORT-CANDIDATE**

**Changelog:** Fixed resume occasionally loading a transcript cut short when the same session rewrote the file during the load.

**Official forensics (delta fully recovered — brand-new module in v288):** marker `Transcript rewrite stopped waiting` **0 hits v287 → 2 hits v288** (@99524452 schema-ish, @211467560 code). Module @211467183 (window `w288_rwcoord.txt`):

```js
import{resolve as Wyn}from"path";
var yCr=5000;
class Gyn{loads=new Map;rewrites=new Map;abandonedLoads=new WeakSet;loadWaitMs=yCr}
var qyn=new G(()=>new Gyn);                      // per-host singleton
async function wM(e){                             // REWRITE side
  let n=Wyn(e),r=qyn.of(U().host),
      s=[...r.loads.get(n)??[]].filter((h)=>!r.abandonedLoads.has(h)),
      g=Vyn(r.rewrites,n);                        // register rewrite
  if(s.length>0){
    if(await lt(Promise.all(s).then(()=>!0),r.loadWaitMs)===void 0){   // wait ≤5s for loads
      for(let S of s)r.abandonedLoads.add(S);
      t(`Transcript rewrite stopped waiting after ${r.loadWaitMs}ms for ${s.length} load(s) of file ${on(n)}`,{level:"warn"})
    }
  }
  return g
}
async function Kyn(e){                            // LOAD side
  let n=Wyn(e),r=qyn.of(U().host);
  for(let s=r.rewrites.get(n);s!==void 0;s=r.rewrites.get(n))await Promise.all(s); // chain-wait rewrites
  return Vyn(r.loads,n)                           // register load
}
function Vyn(e,n){                                // deferred-set registry, Symbol.dispose handle
  let r=e.get(n)??new Set;e.set(n,r);
  let{promise:s,resolve:g}=Promise.withResolvers();
  return r.add(s),{[Symbol.dispose]:()=>{if(r.delete(s),r.size===0&&e.get(n)===r)e.delete(n);g()}}
}
```

Call sites (v288, all `using X=await wM(path)` before touching the file):
- `performRemoveByUuid(e,n,r){using s=await wM(e);...}` @211508839 — tombstone removal;
- `performCompactTranscript(e,n,r,s){using g=await wM(e);...}` @211512069 — whole-file compaction rewrite (`${e}.compact.tmp.<hex>` + rename);
- CCR v2 subagent hydrate, CCR v2 foreground hydrate (`using an=await wM(w)`), remote hydration `_0r` (`using w=await wM(S)`), session-file move (dev/ino compare then `using H=await wM(S);...using Ae=await wM(h)`).

Load side (v288 `loadTranscriptFile`): `try{using w=await Kyn(e);if(!S){let{size:K}=await G_(e);if(K>xme){let V=MRr(e,K,s,r.dropPreBoundaryEntries,...)` @211629358.

v287 counterparts have **no coordination**: `performCompactTranscript(e,n,r,s){let g=s!==void 0?By(e):void 0;...}` @210346089 goes straight into the rewrite; `performRemoveByUuid(e,n,r){let s=...}` likewise; the loader reads size directly (window `n287.txt`). Adjacent v5-storage note: `performCompactTranscriptV5` finally block changed `if(!S)await y2e(h)` (h=size) → `if(!w)await V4e(S)` (S=tornTailBytes) — minor, storageV5-only.

**OCC state (verified myself):** no cross-process or in-process load/rewrite coordination exists. Rewrite surfaces: tombstone slow path read+`writeFile` (`src/utils/sessionStorage.ts:1105-1124`, skipped when `fileSize > MAX_TOMBSTONE_REWRITE_BYTES`), `hydrateRemoteSession` :1775, CCR v2 :1848/:1881, progressBridge rewrite inside `loadTranscriptFile` :4104-4501 (single whole-file read <5 MB at :4198; chunked reader `sessionStoragePortable.ts:915-990`). A load racing any rewrite can observe a truncated file. No flock/lockfile anywhere.

**PORT details:** port the registry verbatim in shape: per-resolved-path `loads`/`rewrites` promise sets + `abandonedLoads` WeakSet + 5000 ms `loadWaitMs`; wrap every whole-file rewrite (tombstone slow path, remote hydrate, CCR v2) with the rewrite-side waiter, and `loadTranscriptFile` with the load-side waiter; add the warn log with the official message text. Disposable pattern → try/finally in OCC's TS style.

### #13 — resuming a ≤2.1.286 conversation dropping earlier thinking — **STAGED**

**Changelog:** Fixed resuming a conversation started on 2.1.286 or earlier dropping the model's earlier thinking.

**Forensics (extensive, delta NOT recovered — every candidate region is rename-identical):**
- `thinking_drop` 11→12, `thinking_stripped` 16→17: the extra v288 hits are an artifact-patch attachment-type allowlist Set `Cd` @215379315/215379331 (`thinking_stripped:()=>[],advisor_stripped:()=>[],thinking_drop:()=>[],credential_org:()=>[]`) — render allowlist, not behavior.
- `filterOrphanedThinkingOnlyMessages` region v287@210277800 vs v288@211438000: identical modulo renames (Kcn≡Eyn, Tye≡C_e, dkr≡QTr, ckr≡JTr, ukr≡ZTr, model-differs Aye≡R_e, scope FLe≡u0e, ZUt≡yqt).
- Strip decision: v287 `C_t` ≡ v288 `svt` — full 1.4 KB bodies byte-compared (`f287_ct2.txt`/`f288_svt.txt`): `CLAUDE_CODE_WISE_COMET` env → `"thinking_type"` → `tengu_wise_comet` flag, identical.
- Compact "kept tail" module `bDe`≡`kNe` ("kept tail holds N thinking block(s); strip=on/off") 2=2.
- `resumedFromIncompleteThinking` grouper: v287 `Qpn` ≡ v288 `dgn` (verified side-by-side contexts; the new288.txt line was rename noise).
- Org-preserved-thinking notice (`$a`≡`cl`, "Claude can't use thinking from another organization…preserved-thinking" @214255160/@215459037): identical.
- Count-equal: `advisor_stripped` 11=11, `advisor_message` 3=3, `signature` 549=549, `IncompleteThinking` 27=27, `narration_hint` 3=3, `thinkingDisplay` 50=50, `thinkingMode` 25=25, `cacheDiagnosis` 20=20, `redacted_thinking` 65→66 (+1 = the `w8t`≡`H4t` predicate rename artifact), `lastAssistant` 52=52, `thinking blocks` 17=17, `earlier thinking` 2=2, `[Thinking removed]` 2=2, `WISE_COMET` 3=3. No new version-gate strings (`versionAtLeast`/`semverGte`/`startedBefore`/`legacyTranscript` all 0=0); signature-envelope schema docs ("treat unlisted thinking blocks as ordinary thinking") present 1=1 in **both**.

**Assessment:** the fix is a conditional change with zero string footprint; all thinking-handling regions I could locate compare identical after rename normalization.

**OCC state (surface real, mapped):** thinking persisted verbatim (`cleanMessagesForLogging` sessionStorage.ts:5256-5267; `transformMessagesForExternalTranscript` :5202-5254 strips only REPL tool pairs for non-ant users); resume-side `filterOrphanedThinkingOnlyMessages` (`src/utils/messages.ts:5838-5905`, telemetry :5894), `stripSignatureBlocks` :5907-5946 (credential-change only). **Verdict: STAGED** — needs behavioral e2e against official (write a transcript with pre-286-shaped thinking rows, resume on 288, observe) rather than more statics.

### #79 — `/autocompact` saves the auto-compact window per model — **PORT-CANDIDATE**

**Changelog:** `/autocompact` now saves the auto-compact window per model.

**Official forensics (delta fully recovered):**
- v288 aggregator `WIt` @216490426: `function WIt(){let t={default:void 0,byModel:{}};for(let{settings:o}of YWt()){let e={};for(let[d,u]of Object.entries(o.modelSettings??{})){let i=u?.autoCompactWindow;if(i===void 0)continue;let n=iV(d);if(d===n||!Object.hasOwn(e,n))e[n]=i}t=o.autoCompactWindow===void 0?{default:t.default,byModel:{...t.byModel,...e}}:{default:o.autoCompactWindow,byModel:e}}return t}` — per settings file, a top-level `autoCompactWindow` **replaces that file's whole contribution**; `XEo(t)` maps session override (`"auto"`→undefined).
- Canonical-key writer `Mqr` @203106890: `function Mqr(e,n,r){let s=iV(e);return Object.hasOwn(Object.prototype,s)?r:{modelSettings:{[s]:n}}}` — prototype-pollution guard with top-level fallback; key normalizer `iV(e)=Ct(Be(Rt(e),{deterministic:!0,identity:!0}))` (dated/`[1m]`/Bedrock/Vertex spellings collapse).
- v288 setter `nPt` @220565339: env-precedence message ("CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence…"), `reset|unset|default`→`"auto"`, saves via `_n("userSettings",Mqr(o.model,{autoCompactWindow:t},{autoCompactWindow:r}),void 0,n.storageV5)`, then re-reads `Dw(o,WIt())` and reports `Auto-compact window for ${No(o.settingsKey)}`; `onQueryEvent` sends `{autoCompactWindow:null}` (always clears session override). Model info via `ju` @208248029 (returns `{model, contextWindow, settingsKey:iV(e), clientDataAutoCompactWindow, ...}`).
- v288 resolver `Dw` @208253889 settings branch: `let H=typeof n!=="object"?n:Object.hasOwn(n.byModel,e.settingsKey)?n.byModel[e.settingsKey]:n.default;if(H!==void 0&&H!=="auto")return{window:Math.min(g,H),configured:H,source:"settings"}`. Priority chain: env → settings(byModel→default, skip "auto") → clientdata → experiment → model-default → unknown-model → auto.
- v287 setter `dRt` @219310599: saves **top-level scalar** `{autoCompactWindow:u}`; reads `tt().autoCompactWindow` + `bv(Vu(e),m)`; message "Auto-compact window set to…" (no model); resolver `bv` @207138951 settings branch scalar-only: `if(n!==void 0)return{window:Math.min(g,n),configured:n,source:"settings"}`.
- Schema description (v288 @102081332/@200106159): "Auto-compact window for this model, in tokens (100000 to 1000000), or \"auto\"… Within one settings file it replaces the top-level autoCompactWindow for the model. /autocompact saves here. The canonical model name as key also matches its dated, [1m], Bedrock and Vertex spellings." `modelSettings` bag existed in v287 (7 strings: effortLevel/maxEffortLevel) → v288 (8, +autoCompactWindow).

**OCC state (verified myself):** `src/commands/autocompact/autocompact-noninteractive.ts:101-125` `setWindow` saves **global scalar** `updateSettingsForSource('userSettings',{autoCompactWindow:valueToSave})`; read path `src/utils/autoCompact.ts:35-61` (env shrinks :48-53), config read :160-171; settings key type `src/utils/types.ts:407-415` (100_000–1_000_000); parser `src/utils/autoCompactWindow.ts:29-121`; interactive UI `Config.tsx:269-286`; CLI flag `main.tsx:1141-1152`. Per-model precedents in OCC: `modelOverrides` (`types.ts:509-516`, `modelStrings.ts:134-170`).

**PORT details:** add `modelSettings[canonicalKey].autoCompactWindow` to settings schema; port the canonical-key normalizer + prototype-pollution-guarded writer (`Mqr` shape); port the `{default,byModel}` aggregator with per-file replacement semantics (`WIt`); resolver consults `byModel[settingsKey]`→`default`, skipping `"auto"` (`Dw` branch); command messages name the model settingsKey; session override always cleared to null on save.

### #65 — auto mode classifier overflow now compacts — **PORT-CANDIDATE**

**Changelog:** Auto mode: when the conversation is too long for the client-side safety classifier, it's compacted instead of prompting (or failing every tool call in headless).

**Official forensics (delta fully recovered):**
- New reason constant `jor="Auto mode classifier transcript exceeded context window; will try to compact the conversation before the next request"` @199851183 (v287 has only `LQe`≡v288 `Ret` = "…falling back to manual approval (try /compact to reduce conversation size)"). Reason mapper `gme` widened: `e.noVerdict===!0&&(e.reason===Ret||e.reason===jor)`.
- Permission consumer @209966504 (v288; v287 @208822300 has no compaction arm): in `sr.shouldBlock&&sr.transcriptTooLong`: arms `Dr=Ei?"classifier_only_deny":mi?"allow":Un?"question_dialog":"deny"`; then `ri=$At()?zEt(B,B.messages,{toolName:e.name,denied:(Dr==="deny"||Dr==="classifier_only_deny")&&B.permissionRound!==void 0,mode:Ee.mode}):void 0;Xr=ri!==void 0`; telemetry `tengu_auto_mode_classifier_overflow_compact {stage:"requested",arm,toolName,isMcp,isSubagent,headless,serverPath}`; classifierOnly-deny message now varies on `Xr` ("…Claude Code will try to compact the conversation before the next request; if this action is still needed after that, issue it again." vs the old "…the same call will hit the same limit until the conversation is shorter."); new deny+compact arm returns `{behavior:"deny",decisionReason:{type:"classifier",classifier:"auto-mode",reason:jor,noVerdict:!0},message:"…did not run. Claude Code will try to compact…issue it again and it will be reviewed normally."}`; then headless throw; then the unchanged manual-permission fallback.
- Pending-request mechanism `zEt` @208315746: `var NMe=new kt(()=>new Map);function $Me(e){return e??"main"}function WEt(e){return e[0]?.uuid}function zEt(e,n,r){let s=WEt(n);if(s===void 0)return;let g=NMe.of(e.session),h=$Me(e.agentId),S=g.get(h);if(S?.canCompact!==!0||S.spentEpoch===s)return;let w=S.pending?.epoch===s?S.pending:void 0,B=w??{epoch:s,mode:r.mode,toolName:r.toolName,deniedToolNames:[]};return g.set(h,{...S,pending:r.denied?{...B,deniedToolNames:[...B.deniedToolNames,r.toolName]}:B}),w?"joined":"requested"}` — keyed by (session scope, agentId, epoch=first-message uuid); `qEt(e,n,r,s)` sets `canCompact` and consumes pending (stale reasons `"epoch"|"mode"`); `KEt(e,n)` clears pending + sets spentEpoch.
- Gate `$At` @208550061: `function $At(){return A("tengu_merry_popcorn",!0)}` (growthbook, default **true**).
- Autocompact consumer `LFo` @209130334 (dumped again this round at 209129800): `{pending:h,stale:S}=qEt(...)`; stale `epoch` or left-auto-mode (`S==="mode"&&!qi(s,g===!0)&&s!=="dontAsk"`) → telemetry `stage:"dropped"` + OTEL `p("compact_classifier_overflow",B)`, return; compaction unavailable → `TY(e,h,{kind:"skipped",reason:"unavailable"})`; else return pending → generator yields `gqn(...isAutoCompact:!0...)` and returns `{kind:"compacted",result:V?ojt(n,V,Fe):Fe,...,routedThroughReactive:!1}`.
- `ojt`: log "autocompact: compacted after the auto mode classifier overflowed"; telemetry `stage:"compacted"` `{deniedCalls,isSubagent,preCompactTokenCount,postCompactTokenCount,truePostCompactTokenCount}`; OTEL `y("compact_classifier_overflow")`; appends `VHt(n.deniedToolNames.length,L(n.deniedToolNames))` to result attachments.
- Post-compact reminder `VHt` @209096408: 0 denied → `critical_system_reminder` "The conversation was compacted because it had become too long for auto mode's classifier."; else "Auto mode could not review {an earlier tool call (X)|N earlier tool calls (X,…)} because the conversation was too long for its classifier, so {that call|those calls} did not run. The conversation has now been compacted. If still needed, issue {it|them} again and {it|they} will be reviewed normally."
- `compact_classifier_overflow`: 0 hits v287 → 6 hits v288 (new OTEL metric).

**OCC state (subagent-mapped, key lines consistent with my permissions.ts read this round):** TRANSCRIPT_CLASSIFIER live (`featureFlags.ts:13-14`); classifier invoked `src/utils/permissions/…/yoloClassifier.ts` from `permissions.ts:590-597`; no client-side length cap (`buildTranscriptEntries` :360-420); `transcriptTooLong` results :1061-1090/:1394-1426; **verified myself**: `src/utils/permissions/permissions.ts:948-970` — on `classifierResult.shouldBlock && transcriptTooLong`: headless (`shouldAvoidPermissionPrompts`) → `throw new AbortError('Agent aborted: auto mode classifier transcript exceeded context window in headless mode')`; interactive → fall back to normal prompting with `decisionReason:{type:'other',reason:CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON}` (`messages.ts:331-333`). That is exactly the v287 shape — no compaction request anywhere. Autocompact entry `autoCompact.ts:282 autoCompactIfNeeded`; REACTIVE_COMPACT dormant (not in FEATURE_ALLOWLIST).

**PORT details:** (1) add the pending-registry (session-scoped Map keyed by agentId, epoch = first message uuid, `deniedToolNames` accumulation, `canCompact`/`spentEpoch`); (2) at the classifier-overflow branch, register the pending request behind a `tengu_merry_popcorn`-equivalent flag (default true) and switch the deny message/reason to the `jor` text; (3) consume the pending at the next autocompact check with stale-epoch/left-auto-mode drop telemetry; (4) after compaction, attach the `VHt` critical_system_reminder; (5) telemetry `tengu_auto_mode_classifier_overflow_compact` stages requested/joined/dropped/compacted/skipped/failed + OTEL `compact_classifier_overflow`. Note: REACTIVE_COMPACT stays off — the official routes this through the *auto*compact check (`routedThroughReactive:!1`), which OCC has live.

### #49 — Claude 3 Opus/Sonnet failing every turn after a whole PDF entered — **PORT-CANDIDATE**

**Changelog:** Fixed sessions on Claude 3 Opus and Claude 3 Sonnet failing on every turn after a whole PDF entered the conversation.

**Official forensics (delta fully recovered this round):**
- New markers: `does not support pdf input` **0→3**, `does not support pdfs` **0→3**, `unsupported_by_model` **0→4**, `media_removed` **0→6** (@98622440/@200910278-200915719 SDK schema, @207352018 code); `media_budget` 8→12, `unprocessable` 7→11, `claude-3-opus` 8→9, `claude-3-sonnet` 7→8.
- v287 error-signature list: `["could not process pdf","pdf pages","the pdf specified was not valid","the pdf specified is password protected","pdf cannot be empty","too much media"]` — **missing the two "does not support pdf(s)" signatures the API returns for Claude 3 Opus/Sonnet**, so the strip sanitizer never fired and every subsequent turn re-sent the PDF and failed again.
- v288 list `gie`: `["could not process pdf","pdf pages","the pdf specified was not valid","the pdf specified is password protected","pdf cannot be empty",...kF,"too much media"]` with `kF=["does not support pdf input","does not support pdfs"]` and new predicate `function t6n(e){let n=e.toLowerCase();return kF.some((r)=>n.includes(r))}` (module @207348500-207356500, window `mc288.txt`; v287 counterpart @206263500 window `mc287.txt`).
- New model-specific message `TSe()`: `` `${Ua}: this model does not accept PDF documents, so a PDF in the conversation was removed. Ask Claude to read specific pages of the file instead (they are sent as images), or switch to a model that reads PDFs.` `` with `Ua="API Error"`.
- v287 had only the generic `CM(e)`: "`API Error: {a document|an image} in the conversation could not be processed and was removed. …"`. v288 replaces the construction with `z8(e,n)`: `function z8(e,n){let r=e==="document"&&t6n(n);return{content:r?TSe():K8(e),apiError:"media_removed",apiErrorParams:rJe(n)?{media_reason:"media_budget"}:{media:e,media_reason:r?"unsupported_by_model":"unprocessable"}}}` (K8≡CM unchanged; `rJe(e)=e.toLowerCase().includes("too much media")||ux(e,"media_budget")` extracted from the unchanged detector `Q9e`≡`oJe`).
- SDK schema (v288 @200910278 region): `api_error` enum gains `"media_removed"`; `api_error_params` gains `media:j(["image","document"])`, `media_reason:j(["unprocessable","unsupported_by_model","media_budget"])`; doc: "media_removed: the API refused an image or a document in the conversation, so Claude Code leaves it out of the requests that follow… Other kinds (pdf_too_large, pdf_password_protected) and some untyped errors also leave the block out, so the absence of this value does not mean that nothing was left out."
- Detection regex fallback `k$r`≡`P0r` (locates `messages[i].content[j]…(image|document|pdf)`) unchanged.

**OCC state (verified myself):** `src/utils/messages.ts:2240-2246` — `errorToBlockTypes` keyed on exact strings from `getPdfTooLargeErrorMessage()/getPdfPasswordProtectedErrorMessage()/getPdfInvalidErrorMessage()/getImageTooLargeErrorMessage()/getRequestTooLargeErrorMessage()`; applied :2250-2290 by walking back from the synthetic API-error message to the preceding isMeta user message. **No "does not support pdf input"/"does not support pdfs" signatures, no model-unsupported message, no typed media_removed** → OCC has exactly the v287 bug on Claude 3 Opus/Sonnet (document block FileReadTool.ts:1368-1371; claude-3 model lists `context-noninteractive.ts:30-35`, `context.ts:283-289`, `betas.ts:107/132/210`; no per-model PDF sanitizer anywhere).

**PORT details:** (1) add the two `kF` signatures to OCC's PDF-error recognition (both the strip-map keying and the isPdfError classifier `gie`-equivalent); (2) add the `t6n` predicate and the `TSe` message text verbatim; (3) emit the typed `apiError:"media_removed"` + `apiErrorParams:{media,media_reason}` (`unsupported_by_model` when t6n matches on a document, `media_budget` when the "too much media" signature matches, else `unprocessable`); (4) extend the SDK-message schema enum + params if OCC surfaces `api_error`.

---

## Method notes

- Region comparisons used `dd` windows + python string-literal set diffs (tr-based diffs are useless on minified single-line code).
- Occurrence-count diffing of telemetry/marker strings between the two strings-dumps was the highest-yield delta finder: it pinpointed #11 (`tengu_transcript_parent_wait` 0→2), #12 (`Transcript rewrite stopped waiting` 0→2), #65 (`compact_classifier_overflow` 0→6), #49 (`media_removed` 0→6, `unsupported_by_model` 0→4).
- Minified-name collisions were resolved by module-neighborhood anchoring (e.g. `z8` matched unrelated fast-mode helpers; `C_t` matched a cache predicate before the real strip decision).
- Saved windows referenced above live in `/tmp/cc-diff-288/` (`w288_rwcoord.txt`, `mc287.txt`, `mc288.txt`, `mr288.txt`, `pj287.txt`, `pj288.txt`, `fr287.txt`, `fr288.txt`, `f287_ct2.txt`, `f288_svt.txt`, `n287.txt`, `n288.txt`, `ld287.txt`, `ld288.txt`, `id287.txt`, `id288.txt`, `c287.txt`, `c288.txt`, `e287.txt`, `e288.txt`, plus prior-round files).
