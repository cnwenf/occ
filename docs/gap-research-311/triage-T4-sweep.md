# Triage T4 — Sweep: changelog items 65–92 + new env/settings/hook/command surface (2.1.310 → 2.1.311)

Round: official claude-code **2.1.310 → 2.1.311**.
Method: read-only binary string forensics (`grep -aboF` → byte offset → `dd` context dumps) on
`/tmp/cc-diff-311/v310/package/claude` and `/tmp/cc-diff-311/v311/package/claude` (NEVER executed),
against the `new_strings.txt` comm-diff (18,925 lines) and `env_new.txt` (18 new env names).
OCC side checked in `src/`. All byte offsets below are v311 unless labeled v310.
Nothing here is invented; items that could not be pinned at string level are marked **unpinnable**.

## PART A — summary table (changelog items 65–92)

| # | Item (short) | Verdict | One-line reason |
|---|---|---|---|
| 65 | ultrathink → xhigh effort turn | **PORT** | v311 adds `setTurnEffort("xhigh")` + ultrathink_boost; OCC has keyword detection only |
| 66 | ultrathink rainbow gating (quoted/path) | **PORT** | v311 `da()` skips quoted/path occurrences; OCC `findThinkingTriggerPositions` is naive `matchAll` |
| 67 | Ctrl+D twice exits agent view | **N-A** | string belongs to a v311-new agents-view footer component OCC doesn't have |
| 68 | json/stream-json `\uXXXX` escapes for DEL/C1/Cf | **PORT** | v311 escapes more codepoints; OCC `ndjsonSafeStringify` still v310-level (2028/2029 only) |
| 69 | drop `[1m]` suffix+label where no effect | **PORT** | v311 native-1M models drop suffix AND label; OCC hardcodes `(1M context)` labels incl. sonnet-5-5/haiku-5-5 that official now drops |
| 70 | permission-rule warnings once per user | **PORT** | v311 adds `seenKey` rows + persisted dedup (cap 256); OCC prints string rows every startup |
| 71 | /code-review effort-first + max only when asked | **PORT** | v311 rewords description + adds `whenToUse`; OCC carries pre-311 description, no `whenToUse` |
| 72 | DISABLE_COMPACT one-way off | **PORT** | v311 host-rule filter gains `s==="DISABLE_COMPACT"&&!Le(n)` clause; OCC `filterSettingsEnv` lacks it |
| 73 | signed model catalog on downloads.claude.ai | **N-A** | OCC has no publishedCatalog fetch subsystem at all (doc-comment refs only) |
| 74 | SYNC_SKILLS shared 10-min list reuse | **N-A** | OCC has no syncedSkills subsystem (`src/commands.ts:443-448` documents the omission) |
| 75 | scrollbar click acts on mouse release | **N-A** (official side **unpinnable**) | identical scrollbar identifier counts in both binaries; OCC has no clickable scrollbar UI |
| 76 | purge says "only on this computer" | **PORT** | one-line addition to OCC `printPlan`; v311 also rewords `--all` confirm |
| 77 | [VSCode] syntax coloring | **N-A** | extension-side; no CLI-binary surface |
| 78 | [VSCode] UserPromptSubmit hooks spinner | **N-A** | "Running UserPromptSubmit hooks" 0 hits in BOTH binaries — extension-only string |
| 79 | [VSCode] skills/commands include open file | **N-A** | extension-side (anthropics/claude-code#102799) |
| 80 | [VSCode] extension host freeze on login shell | **N-A** | extension-side |
| 81 | [VSCode] image click opens text tab | **N-A** | extension-side |
| 82 | [VSCode] dictation stops on Send | **N-A** | extension-side |
| 83 | [VSCode] DISABLE_TELEMETRY when VS telemetry off | **N-A** | extension spawns sessions with env set; CLI side unchanged (env pre-exists) |
| 84 | [VSCode] Web sessions lazy load | **N-A** | extension-side |
| 85 | [Cloud] routine lock after rejoin | **N-A** | cloud-service-side |
| 86 | [Cloud] routine token delete/regen toast | **N-A** | cloud-service-side |
| 87 | [Cloud] duplicate env names refused | **N-A** | "duplicate name" 9/9 both binaries (not new); dialog is cloud-side |
| 88 | [Claude Tag] Skills analytics view | **N-A** | OCC has zero Claude Tag surface (grep `claudeTag` → 0 files) |
| 89 | [Claude Tag] no throwaway message | **N-A** | "throwaway message" 0 hits in BOTH binaries — Slack-side |
| 90 | [Claude Tag] lock icon for private channels | **N-A** | Slack-side |
| 91 | [Code Review] "no further automatic review" | **N-A** | string 0 hits in BOTH binaries — GitHub check-run service side |
| 92 | [Code Review] transient-fault retry once | **N-A** | cloud check-run service side |

Items 65/66/68/69/70/71/72 were deep-dived pre-compaction (pins below); 67, 73–76 deep-dived this
session; 77–92 got formal N-A verification (distinctive-string spot checks absent from BOTH CLI
binaries + OCC lacks the surface).

## PART A — evidence

### Item 65 — ultrathink runs turn at xhigh effort (PORT)

- v311 ultrathink handler `ql` @257370026: `setTurnEffort("xhigh")`, telemetry `ultrathink_boost`,
  GB flag `tengu_ultrathink`; helpers `jnr` @243588108, `REt` @243587988.
- v311 `buildUserMessage` gains the fe(ultrathink) effort boost @257664500; v310 equivalent
  @256257400 lacks it.
- Models per changelog: Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 via Anthropic API; typed while
  working → raises rest of that turn.
- OCC: `src/utils/thinking.ts` has `hasUltrathinkKeyword`/`isUltrathinkEnabled` (GB
  `tengu_turtle_carbon`) but NO effort-raising on the keyword anywhere (`setTurnEffort` absent).
  OCC also already carries the `da()`-keyword infrastructure from the ultraplan port
  (`src/utils/ultraplan/keyword.ts`, v311 `da()` @246986898 + `Om` @246986833, `gwr` @251728372).

### Item 66 — rainbow only where keyword can raise effort (PORT)

- v311 gating function `da()` @246986898 (with `Om` @246986833): skips occurrences inside quotes
  and file paths; rainbow rendered only at positions where effort can actually raise.
- OCC: `findThinkingTriggerPositions` (src/utils/thinking.ts:37-59) is naive
  `text.matchAll(/\bultrathink\b/gi)` — highlights quoted/path occurrences. PORT: adopt `da()`-style
  filtering for the highlight positions (keep `hasUltrathinkKeyword` semantics per official).

### Item 67 — Ctrl+D in agent view (N-A)

- "press ctrl+d again to exit": 0 hits v310; v311 @126381768 (bytecode strtab) + @260149974 (JS).
- Context @260149500 — v311-new agents-view footer component:
  `` !v?`Press ${ae} again to exit`:ae==="Ctrl-D"?"press ctrl+d again to exit":"press ctrl+c or q again to exit",Gt>0&&` · ${Gt} ${I(Gt,"agent")} will keep running` ``
  with `focusedRow/focusedIsPending/hasDispatch/hasComposedDispatch/isBashDispatch/enterIsNoop/headerJobs`,
  pending state `justKilled` → "stopped · ctrl+x again to delete · esc to keep",
  `at?.kind==="newsession"?"→ or enter to start":"→ or enter to open"`.
- OCC: no "will keep running"/focusedIsPending/hasComposedDispatch/justKilled/newsession anywhere in
  src. OCC has `src/hooks/useExitOnCtrlCD.ts` (double-press ctrl+c/ctrl+d at the prompt) and generic
  "Press {key} again to exit" in ~10 dialogs — the prompt-side behavior the changelog says agent view
  now *matches* already exists in OCC; the agents-view surface itself does not. → N-A.

### Item 68 — `\uXXXX` escapes in json/stream-json (PORT)

- v311 print-json path `AIe`/`SJ` @238836256: JSON string escaper now also escapes DEL (0x7F), C1
  controls (0x80–0x9F) and Unicode format chars as `\uXXXX`; print json emitter v311 @277422300 vs
  v310 @275732600 (GB `tengu_sober_inkwell`, v311 renames `lne/Pfo→AIe`, v310 `Gpe`).
- Parsed values unchanged — wire-format-only change.
- OCC: `ndjsonSafeStringify` escapes only U+2028/U+2029 (v310-level); `src/cli/print.ts` uses raw
  `jsonStringify` @1127/1133/1136. PORT: extend escaping to `[-]` + Cf category in the
  json/stream-json emit paths.

### Item 69 — `[1m]` suffix and label dropped on native-1M models (PORT)

- v311 `[1m]` normalizer chain `a2/FH/wC/up/EK/Xk/xr` + hardcoded `kK={window:1e6,native_1m:!0}`
  for `p5t="claude-mythos-preview"` — pins: `a2` @242248082, `FH` @242277243, `wC` @242281385,
  `up` @242280891, `EK` @239045033.
- Display-name resolution: v311 `a2(m+"[1m]")` @257589237 vs v310 plain `m+"[1m]"` @256182863 —
  native-1M models drop the suffix AND the `(1M context)` label.
- Label sets `oK/iH` (v311 `xm/CTt/oK` @242276000/@242275194; v310 `Sm/iH` @240815841/@240814926):
  identical membership (opus-4-6/4-7/4-8/5/5-5, sonnet-4-0/4-5/4-6) — but v311 `lT/Gk` @242271504
  vs v310 `Vk/Mk` @240811212 route native-1M models away from the label; `Sq/uSe` @242162342.
- Embedded catalog IDENTICAL (22 models) both versions.
- OCC: `getPublicModelDisplayName` (src/utils/model/model.ts @740-860) hardcodes `(1M context)`
  labels including sonnet-5-5/haiku-5-5 — models the official now treats as native-1M and DROPS the
  label for. `modelSupports1M` in src/context.ts. PORT: mirror the native-1M set (drop suffix +
  label, still accept `[1m]` input via existing `strip1mSuffix`).

### Item 70 — startup permission warnings once per user (PORT)

- v311 rows become `{text, seenKey: fe([source, settingsPath, text])}` — `oe()` seenKey builder
  @256851566; filter/mark-seen `xvs`/`Pvs` chunk @258610842 (global-config array capped at 256,
  `a=256`); emission site @258740951; `bl/RI` @273602551/@273602047.
- OCC: `src/utils/permissions/startupSecurityWarnings.ts` (108 lines) — plain string rows, dedup is
  per-launch `new Set(...)` only; no seenKey, no cross-process persistence. PORT: add
  seenKey = hash([source, settingsPath, text]) + persisted seen-list (cap 256) in global config,
  filter before banner/stderr emission, mark-seen after.

### Item 71 — /code-review effort-first + whenToUse (PORT)

- v311 registration `To()` @258411935 (subcommands `{ultra:"ultrareview"}`) vs v310 `Eo()`
  @256999092 (no whenToUse). v311 description @258404693 — effort level "given first, before any
  target"; v310 description @256992022. `whenToUse: si` @258405300:
  "Use the max or ultra level only when the user, or instructions such as CLAUDE.md or a skill,
  explicitly ask for one, never on your own judgment: they are the costliest reviews and start many
  reviewer subagents." (max-only variant when ultrareview unavailable); argumentHint `ii()`.
  Telemetry `tengu_code_review_routed` @258412600; tip `code-review-low-fast` @278476995.
- OCC: `src/skills/bundled/simplify.ts` `registerCodeReviewSkill()` @~283 carries the CC 2.1.307
  description verbatim and NO whenToUse; menuDescription pinned by
  `src/skills/__tests__/menuDescription307.test.ts:173` (unaffected). OCC skill infra supports
  whenToUse (remember.ts:68, scheduleRemoteAgents.ts:329, claudeInChrome.ts:22, batch.ts:106;
  indexed by searchSkills.ts:31; frontmatter `when_to_use` loadSkillsDir.ts:752/833). OCC has the
  ultrareview subcommand infra (`src/commands/review/` + `src/cli/handlers/ultrareview.ts`) → use the
  ultra-inclusive whenToUse variant.

### Item 72 — DISABLE_COMPACT one-way off (PORT)

- v311 host-rule env filter `K(e,n)`/`zbn` @243147475 gains clause `s==="DISABLE_COMPACT"&&!Le(n)`
  (v310 @241907308 lacks it); callers @243154181/@252104350/@252106994. Settings-file env and mod
  `$.env.set` can only turn compaction OFF, never back ON.
- OCC: `src/utils/settings/managedEnv.ts` — SAFE_ENV_VARS includes DISABLE_COMPACT @362,
  `filterSettingsEnv` exists; no host-rule strings, no mod `$.env.set` (OCC has no mods). PORT:
  add the one-way clause to `filterSettingsEnv` (settings value may only disable).

### Item 73 — signed model catalog / CLAUDE_CODE_MODEL_CATALOG (N-A)

- `CLAUDE_CODE_MODEL_CATALOG` + publishedCatalog infra present in BOTH versions (46→47 string hits).
  v311-new deltas: `primary_fetch` mode case (0→2 hits) in
  `w(r,e){switch(I(r,e)){case"shadow":…case"primary":…case"primary_fetch":return e==="published"?"primary":"off";default:return"off"}}`
  @258565400 (v310 `w` @257152450 has no primary_fetch); trust-origin `{url,publicKey}` with
  "remote, unconfirmed by the server" + loopback/metadata-host rejection @257537000; plugin-source
  enum `["anthropic_catalog","other_catalog","account_uploads","account_marketplace","org_library","org_marketplace"]`
  @244013300 (`anthropic_catalog` 0→2). `_Lt()` gate @258565400:
  `env_off`/`not_first_party`/`policy` (`sn("allow_model_catalog")`). URLs
  `https://downloads.claude.ai/model-catalog/v1/catalog.json` + schema.json in BOTH.
- OCC: only doc-comment references (`src/utils/model/configs.ts:318`, `src/utils/api.ts:238`); no
  fetch subsystem, no `tengu_delegated_quail`. → N-A.

### Item 74 — SYNC_SKILLS shared-round reuse (N-A)

- Reuse function byte-identical logic v311 @257912100 vs v310 @256500280
  (`{list:!0,shared:R}` / `skills_sync_round_reused` telemetry with `age_ms`/`within_ms`).
- v311 REMOVES GB flag `tengu_claudeai_skills_sync_shared_round` (2→0 hits; v310 @256497340 has
  `ht="tengu_claudeai_skills_sync_shared_round"` + `Cn(){return k(ht,!1)===!0}`) → ≤10-min
  cross-session reuse becomes unconditional. TTL consts v311 @257909200:
  `An=10,kt=An*60000,…gt="tengu_claudeai_skills_sync_interval_minutes",…ht="tengu_claudeai_skills_sync_idle_intervals",…`.
- OCC: no syncedSkills subsystem (`src/commands.ts:443-448` documents the omission). → N-A.

### Item 75 — scrollbar click on release (N-A; official side unpinnable)

- String counts identical: scrollbar 38/38, scrollBar 6/6, mousePress 4/4, mouseRelease 4/4,
  isRelease 5/5. No new scrollbar identifiers in ns_short.txt. The change is behavioral inside the
  fullscreen mouse stack — **explicitly unpinnable at string level**.
- OCC: `src/ink/parse-keypress.ts:757` parseMouseEvent (SGR `CSI < b;col;row M/m`, action
  'press'|'release' @739-767), `src/ink/components/App.tsx:588` handleMouseEvent (press/release/
  drag/hover/multi-click, lost-release recovery) — but NO clickable scrollbar component (scroll is
  keyboard `ScrollKeybindingHandler` + wheelup/wheeldown only). → N-A.

### Item 76 — purge wording (PORT)

- v311 plan printer @269428900:
  `function ne(i,a,o){P(`\nPurge plan for ${i}:\n`);for(let c of a)P(`  ${Se(c)}`);if(o.length){P();for(let c of o)pB(c)}P(`\nPurging deletes data only on this computer, not anything stored by Anthropic.`)}`
  — v310 `ne()` @267767524 ends after the warnings loop.
- v311 `--all` confirm: `` `Delete ${p.length} item(s) for ALL projects from this computer? This can't be undone.` ``
  vs v310 `` `Delete ${p.length} item(s) for ALL projects? This cannot be undone.` ``.
- "only on this computer" 0→2 (@128068034/@269429479); "Purging deletes data" 0→2.
- OCC: `src/cli/handlers/projectPurge.ts` `printPlan()` @155-170 prints plan+items+warnings with NO
  trailing sentence → PORT (append the sentence). Note pre-existing divergence: OCC's
  `purgeProjectHandler` has no interactive confirm prompt at all (goes straight to
  `executeDeletion` after the dryRun check), so the `--all` confirm reword has no OCC call site.

### Items 77–92 — formal N-A verification

Distinctive-string spot checks (hits v310/v311): "Running UserPromptSubmit hooks" 0/0 (item 78),
"no further automatic review" 0/0 (item 91), "throwaway message" 0/0 (item 89), "duplicate name"
9/9 — not new (item 87). OCC surface checks: `claudeTag`/`Claude Tag` → 0 files (88–90),
`list_cloud_sessions` → 0 files (85–87, 91–92). Items 77–84 are VSCode-extension-side (no CLI
binary surface; item 83's DISABLE_TELEMETRY env pre-exists in both binaries). → all N-A.

## PART B — new env vars (18; all `CLAUDE_CODE_`-prefixed in the binary, all 0 hits in v310)

| Env var (suffix) | Verdict | One-line reason |
|---|---|---|
| AGENTS_MD_ROWS_EVERY_PROCESS | **N-A** | mod-plugin AGENTS.md usage-rows dedup bypass; OCC has no mods |
| CHROME_LATE_MCP_SERVER | **N-A** | gates Claude-in-Chrome native-host install; OCC has none |
| COUNT_GARBAGE_COLLECTIONS | **N-A** | cloud-worker GC telemetry + env-passthrough allowlist; OCC analytics stubbed |
| DISABLE_EMPTY_CLASSIC_DISPATCH_SKIP | **N-A** | mods classic-dispatch optimization kill-switch |
| DISABLE_LONE_SEC_DEFAULT_SHORTCUT | **N-A** | mods `command.describe`/`env.get` shortcut kill-switch |
| DISABLE_OTEL_EVENT_SKIP | **N-A** | kill-switch for unwatched-road OTEL skip; OCC has no watched-road concept |
| DISABLE_QUIET_BACKGROUND_WAIT | **N-A** | bg-session quiet-wait drain; OCC bg = self-built daemon supervisor |
| DISABLE_WORKING_SYNC_WATCH | **N-A** | Linux inotify for CCR working-sync; OCC has no CCR working sync |
| EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS | **PORT** | OCC hookEvents.ts has allHookEventsEnabled but lacks the userPromptSubmitStartAndEndEnabled sub-flag |
| EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS | **STAGED — security, human decision** | would weaken OCC's bypass-immune dangerous-rm guard; do NOT silently port |
| INCREMENTAL_REQUEST_BODY | **STAGED** | block-store incremental gzip body; OCC has whole-body gzip only — large subsystem |
| MCP_HANDED_LISTINGS | **N-A** | toolbox-MCP handed listings; no OCC surface |
| MCP_REGISTRY_FETCH_AT_STARTUP | **N-A** | would be a no-op in OCC (no listableUrlLookedUp deferral to bypass) |
| PLAIN_DELTA_FAST_PATH | **N-A** | stream-router plain-delta fast path; OCC turn routing differs |
| SDK_HAS_SESSIONS_OAUTH_REFRESH | **N-A** | SDK-host capability probe for cloud sessions OAuth |
| SESSIONS_OAUTH_TOKEN | **N-A** | CCR/cloud-session token env; OCC has OAUTH_TOKEN only |
| SKIP_MCP_DEBUG_LOG_FILES | **N-A** | skip gated on `Dn()` = remote CCR env (`CLAUDE_CODE_REMOTE===!0&&ENVIRONMENT_KIND===void 0`); OCC never runs remote |
| UNWATCHED_REPLY_HOLD_MS | **N-A** | SSE reply-hold for unwatched session kinds (subagent/auxiliary/compaction); OCC lacks reader class |

### PART B evidence (all pins v311, all 0 in v310)

- **AGENTS_MD_ROWS_EVERY_PROCESS** @278243700:
  `async function Me(e,t){try{return I(await e.env.get("CLAUDE_CODE_AGENTS_MD_ROWS_EVERY_PROCESS"))?A:{key:`${await e.session.id()} ${t}`,noted:await e.store.get("usage-rows-queued")}}…}`
  + plugin-manifest env.reads @278236300. Mod-plugin surface; OCC has no mods (CLAUDE.md documents
  plugins/marketplace removed… mods are the v311 `classic.*` dispatch subsystem: hooksRespawns/
  loadedModules/`$.env.set` — all absent from OCC src).
- **CHROME_LATE_MCP_SERVER** @247478100: `if(i.CLAUDE_CODE_CHROME_LATE_MCP_SERVER===!0&&Dn())return;`
  inside `DZe()` native-host install (`--chrome-native-host`). OCC has no native-host install path.
- **COUNT_GARBAGE_COLLECTIONS** @241193700 (SDK result-field describe: gc counts on result_index 0
  within an hour, cloud workers only, telemetry on) + @241693750 env-passthrough allowlist
  `function k(e){let n=e.toUpperCase();return n.startsWith("BUN_JSC_")||Me.has(n)||we.has(n)||n==="CLAUDE_CODE_COUNT_GARBAGE_COLLECTIONS"}`.
  OCC analytics are stubbed (empty implementations per CLAUDE.md).
- **DISABLE_EMPTY_CLASSIC_DISPATCH_SKIP** @246923200:
  `function hpn(o){if(i.CLAUDE_CODE_DISABLE_EMPTY_CLASSIC_DISPATCH_SKIP||Re().hooksRespawns.size>0||kfe())return!1;…}`
  — mods dispatch optimization kill-switch.
- **DISABLE_LONE_SEC_DEFAULT_SHORTCUT** (same chunk):
  `function Gjt(o,e,s){if(!a.has(o)||i.CLAUDE_CODE_DISABLE_LONE_SEC_DEFAULT_SHORTCUT||…)return!1;…}`
  with `a=new Set(["command.describe","env.get"])`; `B2e` session.append/prompt.attachment shortcut.
- **DISABLE_OTEL_EVENT_SKIP** @243324100, in `Ci()` event emitter:
  `if(s.warnedNoEventLogger&&pBe()===null&&!MIe()&&!i.CLAUDE_CODE_DISABLE_OTEL_EVENT_SKIP&&Que.isIdle()&&Que.getRoad()?.isWatched(r)===!1)return;`
  — kill-switch for the unwatched-road OTEL event skip. OCC has
  `src/utils/telemetry/instrumentation.ts` (eventLogger) but no road/watched concept → skip itself
  absent, kill-switch moot.
- **DISABLE_QUIET_BACKGROUND_WAIT** @276929200: bg-session drain loop —
  `if(!(…all local_bash…&&!i.CLAUDE_CODE_DISABLE_QUIET_BACKGROUND_WAIT))return J(fp);return this.keepAlive.countLongSleep(),Qb({…})`.
  OCC has `local_bash` task types (LocalShellTask) but no keepAlive quiet-wait drain — background
  sessions live in OCC's self-built daemon supervisor (`occ daemon`/`occ agents`, per CLAUDE.md
  `--bg` divergence note).
- **DISABLE_WORKING_SYNC_WATCH** @264273000:
  `async function Wki(e,n=O()==="linux"&&!i.CLAUDE_CODE_DISABLE_WORKING_SYNC_WATCH?$e:null)`
  — Linux inotify watcher for CCR working-sync (`ccr_synced_file_push`); sibling
  `sbi()` checks `CLAUDE_CODE_DISABLE_WORKING_SYNC` (chunk @240172300). No OCC CCR working sync.
- **EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS** @249402200:
  `function cFs(e){Jpe().setAllHookEventsEnabled(e)}function uFs(){if(i.CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS)Jpe().userPromptSubmitStartAndEndEnabled=!0;i.unset("CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS")}`
  — one-shot enable of UserPromptSubmit start/end hook events in stream-json, then env unset.
  OCC `src/utils/hooks/hookEvents.ts` (192 lines): ALWAYS_EMITTED_HOOK_EVENTS=['SessionStart','Setup'],
  MAX_PENDING_EVENTS=100, `allHookEventsEnabled` + `shouldEmit(hookEvent)` gate,
  emitHookStarted/emitHookProgress/startHookProgressInterval/emitHookResponse,
  setAllHookEventsEnabled/clearHookEventState; `src/cli/print.ts:770-800` maps started/progress/
  response → `system/hook_progress` + `system/hook_response`. OCC LACKS the
  `userPromptSubmitStartAndEndEnabled` sub-flag → **PORT** (see work package WP-8).
- **EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS** @245128000 (13 hits; pins 116575676/119267476/…/245128354-623):
  `dZs(e){if(!i.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS)return;let n=Jr();n.removalWaiverRulesClear=n.removalWaiverRulesClear!==!1&&!al(e)}`;
  `fKr(e){if(!env||i.CLAUDE_CODE_CHILD_SESSION)return!1;ayn(e);…return n.removalWaiverRulesClear===!0&&(n.settingsChangesUnfinished??0)===0&&sl()}`;
  `sl()` = every() over managed sources {remote,helper,plist,hklm,hkcu,file,parent};
  `al(e)` = `blockReadsOutsideWorkingDirectories===true` || any non-source-rule ask/deny rule for
  the rm rule names (Be/it/qe). Warning strings `pKr(e)`:
  "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS has no effect in this session: dangerous rm
  commands keep their usual checks." / Windows-registry variant / success variant "…is set, so
  dangerous rm commands can run without a prompt in bypass permissions mode once managed settings
  and plugin hooks have loaded. If you didn't set it, check your shell profile."
  (`settingsChangesUnfinished` 0→4, `removalWaiverRulesClear` 0→4 — the ONLY new settings-adjacent
  tokens in the whole diff.)
  OCC: `src/tools/BashTool/dangerousRmAutoDeny.ts` (CC 2.1.281 #137 auto-deny window,
  `tengu_splendid_horizon`, CC 2.1.309 #54) — OCC's live path denies dangerous removals
  immediately and is **bypass-immune** via `bashPermissions.ts` `findCatastrophicSubstitutionBlock`.
  Porting the waiver would WEAKEN that guard → **STAGED, flag for human decision; do not silently
  port a permission-bypass escalation.**
- **INCREMENTAL_REQUEST_BODY** @250994050:
  `function tun(e,n,r=ol){let s=i.CLAUDE_CODE_INCREMENTAL_REQUEST_BODY??0,h=s!==0&&k(qlr,!0)===!0?s:0,…w=h===2&&D2r()!==0&&!S.blocksSwitchedOff;…if(S.bodyBytesSwitchedOff||Te()!=="firstParty"||tKo()||e.output_format!==void 0)return;…Xlr(Q,Se?S.blockStore:void 0)}`
  — incremental gzip request-body block store (shapes/blockDigests/digestedBytes/keptBody, values
  0/1/2, firstParty-only). OCC `src/services/api/gzipRequestBody.ts` = whole-body gzip, no block
  store → **STAGED** (real optimization but a large new subsystem; not a one-file port).
- **MCP_HANDED_LISTINGS** @258940850:
  `function to(e,r,n){…if(Object.keys(e).length===0||i.CLAUDE_CODE_MCP_HANDED_LISTINGS==="0")return s;…mcpServerId===yW(r.sessionSegment,Id)&&r.toolboxMcpServerId===pie…f("mcp_handed_listing","client_module_failed")…}`
  — tools_list handed to the dynamic-http toolbox MCP server; "0" disables. No OCC toolbox surface.
- **MCP_REGISTRY_FETCH_AT_STARTUP** @242613550:
  `async function gfi(){let e=Tt();if(Jfe()!=="none"&&!e.listableUrlLookedUp&&!i.CLAUDE_CODE_MCP_REGISTRY_FETCH_AT_STARTUP){e.officialUrlsFetchAwaitsLookup=!0;return}await t9r()}`
  + `Dz()` registry fetch (`tengu_mcp_directory_bff` bff/legacy, pagination `next_cursor`,
  `type==="remote"` urls). OCC `src/services/mcp/officialRegistry.ts`
  (`prefetchOfficialMcpUrls` → GET `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial`,
  DISABLE_NONESSENTIAL_TRAFFIC early-out) has no `listableUrlLookedUp` deferral — the env would be
  a no-op in OCC. → N-A (document).
- **PLAIN_DELTA_FAST_PATH** @277501350: stream-router option
  `plainDeltasNeedOnlyEmit:i.CLAUDE_CODE_PLAIN_DELTA_FAST_PATH?()=>vn===null&&!Rqt(()=>!0):void 0`
  inside onFrame/teeFrame turn-routing. OCC stream routing differs structurally → N-A.
- **SDK_HAS_SESSIONS_OAUTH_REFRESH** @241694800: host-capability probe block
  `ie=i.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH||i.CLAUDE_CODE_SDK_HAS_SESSIONS_OAUTH_REFRESH,_e=i.CLAUDE_CODE_SDK_READS_SESSION_STATE,…`
  — SDK host feature detection for cloud-sessions OAuth refresh → N-A.
- **SESSIONS_OAUTH_TOKEN** @276527800:
  `H=new Set(["CLAUDE_CODE_SESSION_ACCESS_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_SESSIONS_OAUTH_TOKEN"])`
  in the CCR/stream-json input host (refresh timers Z=30000/ee=30000/se=45000,
  `oauth_token_refresh`/`host_auth_token_refresh`/`remote_control_work_secret`, N=300000,
  268435456 stream-json carryover budget error); @250422950 cloud-session spawn env scrub
  `delete pn.CLAUDE_CODE_OAUTH_TOKEN,delete pn.CLAUDE_CODE_SESSIONS_OAUTH_TOKEN`. OCC honors
  CLAUDE_CODE_OAUTH_TOKEN only; SESSIONS variant is CCR/cloud → N-A.
- **SKIP_MCP_DEBUG_LOG_FILES** @260323850, in the error-log sink chunk:
  `function y(e,r,o){if(t(`MCP server "${r}": ${o}`),i.CLAUDE_CODE_SKIP_MCP_DEBUG_LOG_FILES===!0&&Dn())return;let n=p(r),s={debug:Us(o),timestamp:new Date().toISOString(),sessionId:K(),cwd:Bpr()};e.writerFor(n).write(s)}`
  (error sibling `S()` always writes `{error:…}`). `Dn` imported from chunk-fdxveknh.js, defined
  @240172437: `function Dn(){return i.CLAUDE_CODE_REMOTE===!0&&i.CLAUDE_CODE_ENVIRONMENT_KIND===void 0}`
  — i.e. the skip applies ONLY inside remote (CCR) environments. OCC HAS the surrounding surface
  (`src/utils/errorLogSink.ts` logMCPDebugImpl @200 writing `mcp-logs-<server>/<DATE>.jsonl` via
  `cachePaths.mcpLogs` @31) but has no CLAUDE_CODE_REMOTE remote-env mode, so the official gate can
  never fire → N-A (faithful port = no-op; an unconditional skip would DIVERGE from official).
- **UNWATCHED_REPLY_HOLD_MS** @243930700:
  `var qy=new Set(["subagent","auxiliary","compaction"]),…function Qp(e){return e!==void 0&&qy.has(e)?i.CLAUDE_CODE_UNWATCHED_REPLY_HOLD_MS??0:0}class Zp{reader;holdMs;clock;held=[];heldBytes=0;isBetweenEvents=!1;…}`
  — SSE reply-hold reader for unwatched session kinds. OCC has no such reader class → N-A.

### PART B sweep — settings keys / hook names / slash commands

Swept `ns_short.txt` (short-line extract of new_strings.txt; full-file greps time out on giant
minified lines):

- `grep -iE "setting|permissions\.|sandbox\."` → 142 lines; quoted-identifier histogram yields only
  pre-existing tokens (userSettings/policySettings/projectSettings/localSettings/flagSettings/
  pluginConfigs/pluginSecrets/hooks.json/dangerouslyDisableSandbox/idleCompaction/
  remote_served_settings_freeze/org_pin_mismatch/tengu_cedar_marsh/unknown_removal) — ALL verified
  identical counts v310 vs v311 (dangerouslyDisableSandbox 32/32; tengu_cedar_marsh 2/2;
  remote_served_settings_freeze 5/5; org_pin_mismatch 10/10; unknown_removal 2/2; idleCompaction
  9/9; pluginSecrets 5/5).
- Only genuinely new settings-adjacent tokens: `settingsChangesUnfinished` (0→4) and
  `removalWaiverRulesClear` (0→4) — both internal state fields of the
  EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS subsystem (above), not user-facing settings keys.
- Hook names: only ExitPlanMode/PreToolUse/"User" fragments — no new hook event names.
- Slash commands: only `"/net"` — a macOS autofs mount path in mount-detection code
  (ns_short.txt:9004/12273), not a command.
- **Conclusion: the entire new v311 surface is the 18 env vars + the changelog items themselves.**

## PORT work packages

- **WP-1 (items 65+66)** — ultrathink xhigh + rainbow gating. Files: `src/utils/thinking.ts`
  (adopt `da()`-style position filtering: skip matches inside quotes and file paths),
  ultrathink consumption site in the prompt-submit path (raise turn effort to `xhigh` on
  opus-5-5/sonnet-5-5/haiku-5-5/fable-5-1 firstParty; mid-turn raise for the rest of the turn),
  telemetry `ultrathink_boost`. Verbatim sources: v311 `ql` @257370026, `jnr` @243588108,
  `REt` @243587988, fe-boost @257664500, `da()` @246986898, `Om` @246986833.
- **WP-2 (item 68)** — json/stream-json escaper. Files: the `ndjsonSafeStringify` util +
  `src/cli/print.ts` @1127/1133/1136 emit paths. Change: escape `[-]` + Unicode Cf
  (and keep 2028/2029) as `\uXXXX` inside JSON strings. Source: `AIe/SJ` @238836256.
- **WP-3 (item 69)** — native-1M suffix/label drop. Files: `src/utils/model/model.ts`
  `getPublicModelDisplayName` @740-860 (remove hardcoded `(1M context)` labels for native-1M
  models incl. sonnet-5-5/haiku-5-5), `src/context.ts` modelSupports1M interplay, keep accepting
  `[1m]` input (`strip1mSuffix` already exists in modelDescriptors.ts). Sources: `a2/FH/wC/up/EK`
  @242248082/242277243/242281385/242280891/239045033, `kK={window:1e6,native_1m:!0}`,
  `a2(m+"[1m]")` @257589237, `lT/Gk` @242271504.
- **WP-4 (item 70)** — seenSecurityWarnings persistence. Files:
  `src/utils/permissions/startupSecurityWarnings.ts` (rows → `{text, seenKey}`), global-config
  store for the seen list (cap 256), filter/mark-seen around the emission site. Sources: `oe()`
  @256851566, `xvs/Pvs` @258610842, emission @258740951.
- **WP-5 (item 71)** — /code-review reword + whenToUse. File: `src/skills/bundled/simplify.ts`
  `registerCodeReviewSkill()`: description → v311 effort-first text @258404693; add `whenToUse`
  (ultra-inclusive variant, OCC has ultrareview) @258405300; align argumentHint `ii()`. Keep
  menuDescription (pinned by menuDescription307.test.ts:173).
- **WP-6 (item 72)** — DISABLE_COMPACT one-way. File: `src/utils/settings/managedEnv.ts`
  `filterSettingsEnv`: add `name==="DISABLE_COMPACT" && !isFalsy(value) → drop` clause (settings
  env may only disable compaction). Source: `K/zbn` @243147475 clause `s==="DISABLE_COMPACT"&&!Le(n)`.
- **WP-7 (item 76)** — purge sentence. File: `src/cli/handlers/projectPurge.ts` `printPlan()`
  @155-170: append `\nPurging deletes data only on this computer, not anything stored by Anthropic.`
  after the warnings loop. Source: v311 `ne()` @269428900.
- **WP-8 (env EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS)** — Files: `src/utils/hooks/hookEvents.ts`
  (add `userPromptSubmitStartAndEndEnabled` sub-flag honored by `shouldEmit` for UserPromptSubmit
  start/end events), startup wiring: if env set → enable sub-flag, then `delete
  process.env.CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS` (one-shot), `src/cli/print.ts`
  stream-event mapping already exists. Source: `cFs/uFs` @249402200.
- **STAGED-SEC (env EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS)** — human decision required; porting
  the rm-waiver weakens OCC's bypass-immune `dangerousRmAutoDeny`/`findCatastrophicSubstitutionBlock`
  guard. Evidence @245128000 above.
- **STAGED (env INCREMENTAL_REQUEST_BODY)** — block-store incremental gzip body; revisit only if
  OCC adopts the request-body block-store subsystem. Evidence @250994050 above.
