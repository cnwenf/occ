All run-owned background work is resolved (WP-B finished with its deliverable persisted; WP-C is orchestrator-owned). Final deliverable follows.

---

# Gap-round 2.1.304→2.1.306 — Research deliverable (items 1–5)

Research-only: no files edited, no commits, official binary never executed. Evidence = byte offsets into `/tmp/cc-diff-306/v306/package/claude` (290,532,720 B) with v304 comparison; string-count novelty from s304/s305/s306 dumps.

## Item 1 — Screen reader: "Search:" prefix + no spaces inside highlighted words
**Verdict: PORT** (both halves; OCC lacks both v305 fixes)

**Byte evidence (v306, novel vs v304):**
- Search box `MS` (v304: `RS`) @258373884; NEW code @258374354:
  ```
  L=ot(),z=!H&&!L,...,ie=h??"Search\u2026",
  ce=L&&V===A2o?d?"Search:":null:V,
  Oe=ce===null?d:`${ce} ${d}`,Ye=ce===null?0:ce.length+1
  ```
  `ot()` = screen-reader hook (@257603753), `A2o="\u2315"` (v304 `N8s`), `d`=query. Under SR the ⌕ becomes `"Search:"` (or nothing when query empty); caret column adjusts (`Ye`). v304 renders the symbol unconditionally — VoiceOver read it as "telephone recorder".
- Rendered prompt input `o4t` (v304 `XVt`) @257775556; NEW gate @257777212:
  ```
  ne=ot(),...hidePlaceholderText:m||ne...
  if(V&&V.length>0&&!W&&!ne){ ...e(oe,{text:u,highlights:V})... }
  Re=W?...:e(n,{"aria-preserve-whitespace":!0,children:e(Xo,{children:u})})
  ```
  v304 @256385798 has `if(V&&V.length>0&&!W){` — no `!ne`. The segmented highlight renderer `oe` (identical both versions, @257773808; per-char shimmer `f.text.split("").map((X,D)=>e(PTt,{char:X,...}))`) is what produced "spaces inside words" for SR users; v305 bypasses it under SR and renders the plain full value with `aria-preserve-whitespace`. This covers both Ctrl+R search-match highlights and the ultrathink decorations (per-char rainbow `JW`/`M1t`/`Ahe` renderer itself is unchanged v304↔v306; the `$Xe` main-prompt hook already gates decorations via `fr=ot()`).

**OCC current state:**
- `src/components/SearchBox.tsx:30` `prefix = "\u2315"` default; `:37` `srEnabled = isScreenReaderEnabled()` (only used for borderless/caret, v287 generation); `:74` renders `{prefix}{" "}{t9}` unconditionally — **no "Search:" substitution**.
- `src/components/PromptInput/PromptInput.tsx`: highlights built `:613–821`, passed as `combinedHighlights` `:2522`; only SR usage is `pushScreenReaderAnnouncement` (`:84`) — **no `isScreenReaderEnabled()` gate around the highlight render path** (pre-fix `!W` shape).

**Implementation plan:**
1. `SearchBox.tsx`: after `:37` add `const effectivePrefix = srEnabled && prefix === "\u2315" ? (query ? "Search:" : null) : prefix`; caret column at `:54` becomes `effectivePrefix === null ? stringWidth(query.slice(0, offset)) : stringWidth(effectivePrefix) + 1 + stringWidth(query.slice(0, offset))` (official `Ye=ce===null?0:ce.length+1`); render at `:74`: when `effectivePrefix === null` emit `<Text dimColor={t8}>{t9}</Text>` (no prefix, no separator space), else current shape.
2. `PromptInput.tsx`: at the site that switches to the segmented-highlight renderer when `highlights.length > 0` (v304 shape `if(V&&V.length>0&&!W)`), add `&& !isScreenReaderEnabled()`; in the SR fallthrough render the plain full input value inside a Text with `aria-preserve-whitespace` (official `e(n,{"aria-preserve-whitespace":!0,...})`); also gate placeholder text off under SR (`hidePlaceholderText:m||ne`).
3. Tests: extend `src/components/__tests__/searchBoxScreenReader287.test.tsx` — SR on: non-empty query renders `Search: <query>` and no `⌕`; empty query renders no prefix; SR off: `⌕` unchanged; caret column assertions for both. New PromptInput test: SR on + non-empty highlights → single plain Text (no per-segment split), `aria-preserve-whitespace` present; SR off → segmented highlight renderer still used.

## Item 2 — MCP consent dialogs: Enter less likely taken as Accept
**Verdict: NO GAP for this round** (v304↔v306 byte-identical modulo minifier renames; the changelog line has no isolable code delta in the MCP consent stack)

**Byte evidence:** every layer verified identical (normalized-token diffs clean):
- Opening-grace hook `wCe`@276787362 ≡ `JCe`@278277025 — full mechanism: `s=!o||R` arm flag via grace timer `R=$r(o?to:null)`, `take()` returns false while unarmed, `refuseInput=g()` = mount-window `Ga(to)` OR `refusedWithin(250ms)` → `noteRefused()` (stamps `Date.now()`, bumps epoch), `choicesDisabled:!s&&!E` with screen-reader bypass `E=rt()?!0:!1`.
- Constants: `jH=150,Lr=250,Urt=600`@256250780 ≡ `eD=150,to=250,ENe=600`@257650428; `isr=500/zVe` ≡ `Iar=500/Lqe`; window check `Ui`≡`la`; key tracker `C7o`≡`wTn`.
- `ConfirmDialog sr`@256587298 ≡ `ir`@257887549 (props incl. `refuseInput,openedAt,windowMs,armAfterMs`).
- `DeviceMcpConsentDialog` chunks identical (v304 276829132–276850381 ≡ v306 278299946–278321702); `DeviceMcpReconsentDialog` identical; in-session approval `lEn`@256527481 ≡ `Rkn`@257977327 (both 3125 B); mount harness `QAe/crt` ≡ `RCe/eot`; launch `K(n,o)` identical.
- **Only guard-family deltas found** belong to the separate `/artifacts` changelog line: delete-confirm GAINED `refuseInput` + options `"Yes, delete it"`/`"No, keep it"`, `"This cannot be undone."`, values `delete`/`keep` (refuseInput literal count 67→68); rename flow REMOVED `refusedWithin` (26→25).

**OCC current state:** OCC's consent dialogs lack the whole guard mechanism (pre-existing divergence, older than v304): `src/components/AutoDefaultNudgeDialog.tsx:27` — "the official dialog has a refusedWithin/noteRefused cooldown"; `src/utils/permissions/autoDefaultNudge.ts:40` — "No refusedWithin cooldown". Zero hits for `refusedWithin|selfOpened|refuseInput|choicesDisabled|armAfter` in `src/components|utils|hooks`.

**Notes for orchestrator:** (a) no action needed for this round's MCP-consent line; (b) if desired as separate backlog: port the fully-documented grace-guard spec above into `TrustDialog`/`Fable5ConsentDialog`/MCP-approval UI — it's a pre-304 gap, mechanism extracted verbatim in my evidence; (c) the `/artifacts` delete-confirm key change (1/Enter=keep, 2=delete, Esc=cancel, y/n dead) is a distinct v305 item — OCC artifacts surface not surveyed.

## Item 3 — Workflow resume re-running completed pipeline()/parallel() agents
**Verdict: NO GAP (structurally immune) + one optional micro-hardening PORT**

**Byte evidence:** novel v305 string (s304: 0 hits → s305/s306: 2): 
```
workflow journal: did not save an agent() result, so a resumed run will re-run from this call: ${msg}
```
surrounding new code (new305): `z!==null){let $e=z;if(Ee)try{$e=YFr(p(z))}catch(He){return t(...,{level:"warn"}),await St(),z}else...` — v305 hardens result serialization: when a result can't be journaled, warn + detach the journal writer (`St`) instead of silently continuing. Journal-line count 108→113 s304→s305. The official v304 bug: pipeline()/parallel() results bypassed journal persistence → resume re-ran them.

**OCC current state:** the resume cache check lives inside `agent()` itself — `src/tools/WorkflowTool/primitives.ts:472–478` (`computeAgentKey(prompt, opts)` → `ctx.cachedResults?.has(key)` → return cached + `tengu_workflow_journal_started_hit_respawn` telemetry `:475`). OCC's `parallel()` (`:830`) and `pipeline()` (`:883`) execute thunks that call the same `agent()`, so every pipeline/parallel agent passes through the journal cache — the official bypass cannot occur in OCC's structure. Journal layer: `src/tools/WorkflowTool/journal.ts` (append-only JSONL, started/result markers, prefix-replay resume). **One matching weakness:** `primitives.ts:755–760` result append is `await ctx.journal.appendResult(...).catch(() => {})` — silently swallows save failures, exactly the failure mode v305 made noisy.

**Optional micro-port:** replace the silent catch at `primitives.ts:757–760` with the official warn: `workflow journal: did not save an agent() result, so a resumed run will re-run from this call: ${msg}` (level warn, via OCC's logger). Test: mock journal whose `appendResult` rejects → assert warn logged and the agent result still returned.

## Item 4 — /usage narrow-terminal rows + one-line fixes with `f`
**Verdict: PORT (real v305 delta; OCC surface exists but is v299-generation; needs implementation-round per-site extraction — wrap-up cut deep extraction)**

**Byte evidence:** `usage_fix` string count s304: 14 → s305: 21 (+7 new lines, stable in s306) — the fix-apply telemetry event is genuinely new in v305 (appears in the event-name table beside `usage_limit_checkpoint_commit`, `upgrade_teleport_cache`, etc.). New305 code site: `iso(h,X),g("usage_fix"),u(void 0,{display:"skip"})` (apply-fix + log + dismiss). No literal "press f" string (hint composed via the keybinding-hint component). `usageWarn`-matching lines 78→79.

**OCC current state:** /usage surface EXISTS: `src/commands/usage/` (`index.ts` 26 L, `usage.tsx` 6 L, `usageScan.ts` 632 L, `usageWarnings.ts` 146 L, `usage-noninteractive.ts` 57 L) + `usage-credits/`, `extra-usage/`. `usageWarnings.ts` is a byte-exact port of the **v2.1.299 (#017)** behavior-warning catalog (9 `BEHAVIOR_KEYS`, `AKr=10` threshold, `formatTopList` g=8, `formatWindow`/`formatBehaviors`) — no fixable warnings, no `f` apply action, no /doctor fix integration; `usageScan.ts` shows no width/truncate handling for rows.

**Assessment / plan:** the CLI half is portable; "the same fixes appear in VS Code" is IDE-gated (OCC has no VS Code extension → skip that half). Implementation round must extract the v306 fix catalog + row-wrap change: `grep -aboF "usage_fix" /tmp/cc-diff-306/v306/package/claude` → dd ±9 KB windows around each of the 21 hits; identify (a) the warning→one-line-fix catalog entries (each names its source), (b) the `f` key handler in the /usage view, (c) the fix appliers shared with `/doctor`, (d) the narrow-terminal row renderer wrap fix. Then extend `usageWarnings.ts`/`usageScan.ts` accordingly. This is the largest of the five items.

## Item 5 — SDK/cloud-session MCP server replaced by same-named user-settings server
**Verdict: cloud-session half SKIP-backend-gated; SDK half NO GAP (probable) — one verification step recommended**

**Byte evidence:** the allowlist/sideload filter machinery is NOT the delta — `keptDespiteAllowlist` counts identical (s304: 3 = s305: 3 = s306: 3); `ta(oi,{dropForEnterpriseMcpConfig:id,dropForSideloadPolicy:Re&&B,keptDespiteAllowlist:jbo(yo)})` present in both. SDK control delegate (new305): `setMcpServers:async(y)=>{if(!w)throw Error(\`setMcpServers: no mcpDelegate wired (${Object.keys(y).length} server(s))\`);return w.setServers(y)}`. No new precedence string isolable in bounded scans (`replaced by a same-named`: 0/0; `pinned server`: 0/0) — the v305 fix sits inside the `setServers`/mid-session config-reload merge path, not byte-isolated before wrap-up.

**OCC current state:** `src/services/mcp/config.ts` `getClaudeCodeMcpConfigs(dynamicServers, ...)` merges `{...userServers, ...approvedProjectServers, ...localServers, ...dynamicServers, ...extraTargets}` (`:1284–1290`) — dynamic/SDK servers (see `:535` "control message (print.ts, SDK V2 Query.setMcpServers())") spread **last**, so a same-named dynamic server already beats user config in the static merge; `type:'sdk'` is exempt from policy filtering (`:562`) and reserved-name skip (`:1900–1902`). OCC has no cloud-session concept (backend-gated half N/A).

**Verification step for implementation round (cheap):** grep all `getClaudeCodeMcpConfigs(` call sites (`MCPConnectionManager.tsx`, `print.ts`, reload paths) and confirm the mid-session reload passes the current `dynamicServers` — if any reload path omits them, a user-settings server could resurface over an SDK-provided one (the official pre-fix bug). If confirmed threaded, close as NO GAP.

---

**Background-agent status:** WP-B (`a402aa1fe6cfc6475`, API-layer 305/306) completed — its final deliverable (verdicts PORT×3: `withRetry` usage-limit-lift polling `CLAUDE_CODE_USAGE_LIMIT_RECHECK_MS` port for `src/query.ts` + `src/services/api/claude.ts`, with full test plan) is persisted at `/tmp/multica-task-1666585335/.../tasks/a402aa1fe6cfc6475.output`. WP-C (`aece20ea61b134687`) is self/orchestrator-owned (TaskStop refused: not mine) and was actively collecting agent outputs at handoff. No run-owned tasks of mine remain active.