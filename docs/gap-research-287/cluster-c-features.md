# Cluster C — Features · OCC catch-up 2.1.286 → 2.1.287

RESEARCH-ONLY. No repo files modified. Official binaries NEVER executed — byte
forensics only (`rg -aob -F` offsets + python3 byte-slicing on
`/tmp/cc-diff-287/v28{6,7}/package/claude`). Novelty = occurrence count of a
needle in the v286 ELF (0 or unchanged ⇒ pre-existing; ↑ ⇒ v287 delta).
HONESTY: nothing invented — every verdict cites a needle + offset + v286/v287
count, or an OCC `file:line`. Where a delta is logic-only (no new string) and
could not be isolated byte-exactly, the item is STAGED, not guessed.

16 assigned changelog items. Verdicts: **2 PORT-CANDIDATE** (#7, #4),
**9 STAGED** (#1, #2, #3, #5, #6, #8, #11, #12, #14, #15, #16 — see note),
**3 NO-OP** (#9, #10, #13).

> Correction vs. pre-compaction notes: items #1/#2 strings
> (`claude-code-mods`, `cc-plugin-you-should-know`) are **NOT new in v287** —
> both pre-exist in v286 (counts unchanged). The Mods subsystem was dark-shipped
> earlier; v287 only *announces* it and adds the `you-should-know-plugin` **tip
> id** (v286=0 → v287=3). Reported honestly below.

---

## Verdict summary

| # | Changelog item | Verdict | Key evidence |
|---|----------------|---------|--------------|
| 7 | MCP server `alwaysLoad:false` defers all its tools | **PORT-CANDIDATE** | `serverDefersAllTools` v286=0→v287 new; `!g&&` prefix on gate |
| 4 | OTEL `user_prompt` gains `prompt_text` | **PORT-CANDIDATE** | `G$t(e){…{prompt:o,prompt_text:o}}` new; builder `prompt:gDt(B)`→`...G$t(L)` |
| 9 | Permission prompts oldest-first | NO-OP | OCC already appends tail + renders `[0]` |
| 10 | Effort kept on auto model-switch | NO-OP | OCC has no auto-model-switch-after-flag path |
| 13 | `/memory` arrow keys flip on/off | NO-OP | OCC `/memory` is a file-selector, no on/off rows |
| 1 | Claude Mods | STAGED | `claude-code-mods` v286=2=v287 (dark-shipped); big subsystem |
| 2 | You-should-know built-in mod | STAGED | plugin id v286=6=v287; tip id 0→3; depends on #1 |
| 3 | agents view `n:<text>` filter | STAGED | feature add on `occ agents` dashboard |
| 5 | MCP URL prompts / 2025-11-25 / `bareElicitationCapability` | STAGED | legacy-elicitation flag default `!1`→`!0`; OCC bare `{}` is deliberate |
| 6 | Opus 4.7+/Fable 1M default | STAGED | `native_1m_3p` v286=5→v287=0 (catalog refactor); OCC substring-based |
| 8 | `claude agents` queued replies / slash cmds | STAGED | behavior change, daemon dashboard |
| 11 | SDK priority "now" keeps web fetch alive | STAGED | `'now'` v286=7→v287=11; preempt-path logic |
| 12 | `/config` UI improvements | STAGED | chevrons 5=5, PgUp/PgDn 8→6; render-only |
| 14 | `/skill` names mid-message | STAGED | `disable-model-invocation` 18=18; behavior |
| 15 | Permission-prompt dashed lines | STAGED | `"dashed"` 3=3; cosmetic, delta not isolable |
| 16 | stream-json `context:fork` skill streaming | STAGED | `invocation_trigger` 7=7; fork-path logic fix |

## PORT-CANDIDATE ranking (value / size)

1. **#7 MCP `alwaysLoad:false` defers tools** — smallest, cleanest, byte-exact.
   2-line change in one live function (`fetchToolsForClient`); the consumer
   (`isDeferredTool`) and the config key (`alwaysLoad` in the MCP schema) both
   already exist in OCC; an existing test file extends directly. High value:
   it makes a documented server-config key actually defer tools behind search.
2. **#4 OTEL `prompt_text`** — trivial (emit one extra field, mirroring the
   official `G$t` "compute redacted once, spread both keys"). Live surface
   (`processTextPrompt.ts`). Lower value (telemetry parity for backends that
   nest dotted keys) but zero-risk and byte-verified.

---

## #7 — MCP server `alwaysLoad:false` defers all its tools → PORT-CANDIDATE

**Changelog:** "Changed MCP server `alwaysLoad: false` to defer all of that
server's tools behind tool search."

**Byte evidence.** New field `serverDefersAllTools:e.config.alwaysLoad===!1`
added to BOTH MCP tool factories:
- v287 `On()` factory @ **232967426**; second factory `La()` @ **233273756**.
- v287 gate @ **232962174**:
  `alwaysLoad:!g&&(h&&!(r==="dynamic"&&U._meta?.["anthropic/alwaysLoad"]===!1)||U._meta?.["anthropic/alwaysLoad"]===!0)`
  where `g = serverDefersAllTools`, `h = serverAlwaysLoad`, `r = config.scope`.
- v286 gate (same site, no `!g&&` prefix, no `serverDefersAllTools`):
  `alwaysLoad:h&&!(r==="dynamic"&&D._meta?.["anthropic/alwaysLoad"]===!1)||D._meta?.["anthropic/alwaysLoad"]===!0`
- Novelty: `serverDefersAllTools` **v286 = 0 → v287 new**; `alwaysLoad` raw
  count v286=50 → v287=52.

**Semantics.** Precedence: `!g && ((h && !(dynamic && meta===false)) || meta===true)`.
When a server sets `alwaysLoad:false`, `g=true` ⇒ the whole expression is
`false` for **every** tool of that server (the `!g&&` even overrides a
tool-level `_meta['anthropic/alwaysLoad']===true`), so all its tools defer
behind tool search. `alwaysLoad:true` (`h=true,g=false`) and `undefined`
(`h=false,g=false` ⇒ tool-level meta only) are unchanged from the v285 formula.

**OCC surface (live).**
- `src/services/mcp/client.ts:2189-2191` — already computes
  `serverAlwaysLoad = 'alwaysLoad' in client.config && client.config.alwaysLoad === true`
  and `isDynamicScope = client.config.scope === 'dynamic'` (v285 port).
- `src/services/mcp/client.ts:2249-2252` — the current v285 formula:
  `alwaysLoad: (serverAlwaysLoad && !(isDynamicScope && toolAlwaysLoadMeta === false)) || toolAlwaysLoadMeta === true`.
- `src/services/mcp/types.ts:39,75,117,133` — `alwaysLoad: z.boolean().optional()`
  already in the server-config schemas (so `false` parses).
- Consumer already honors it: `src/tools/ToolSearchTool/prompt.ts:59-65`
  `isDeferredTool` ⇒ `if (tool.alwaysLoad === true) return false`.
- Existing test to extend: `src/services/mcp/__tests__/alwaysLoad285.test.ts`.

**Port instructions (verbatim target).**
1. After `client.ts:2191` add:
   ```ts
   // CC 2.1.287 (#7) — binary factories On()@232967426 / La()@233273756:
   //   serverDefersAllTools:e.config.alwaysLoad===!1
   const serverDefersAllTools =
     'alwaysLoad' in client.config && client.config.alwaysLoad === false
   ```
2. Change `client.ts:2249-2252` to prefix the v285 formula (mirror `!g&&(...)`):
   ```ts
   alwaysLoad:
     !serverDefersAllTools &&
     ((serverAlwaysLoad &&
       !(isDynamicScope && toolAlwaysLoadMeta === false)) ||
       toolAlwaysLoadMeta === true),
   ```
3. Extend `alwaysLoad285.test.ts` with `alwaysLoad:false` cases: (a) server
   `alwaysLoad:false` + tool meta `true` ⇒ deferred (`alwaysLoad` false);
   (b) server `alwaysLoad:false` + no meta ⇒ deferred; (c) server
   `alwaysLoad:true` unchanged (regression guard).

---

## #4 — OTEL `user_prompt` gains `prompt_text` → PORT-CANDIDATE

**Changelog:** "Added `prompt_text` to the OpenTelemetry `user_prompt` event, a
copy of `prompt` for backends that nest dotted keys; drop or mask it wherever
you drop or mask `prompt` (#70763)."

**Byte evidence.**
- v287 new helper @ **203885633** (`prompt_text` literal @ **203885703**):
  `function G$t(e){let o=me(e);return{prompt:o,prompt_text:o}}`
  where `me(e)` is the redactor (`…return pe()?e:"<REDACTED>"`, `pe()` =
  OTEL_LOG_USER_PROMPTS gate). It computes the redacted value **once** and
  emits both keys.
- v287 builder (2 call sites): `ys("user_prompt",{prompt_length:String(L.length),...G$t(L),...X&&{"prompt.id":X},"message.uuid":D})`
  and `…{prompt_length:String(V.length),...G$t(V),...oe&&{"prompt.id":oe},"message.uuid":le})`.
- v286 builder (2 call sites): `gs("user_prompt",{prompt_length:String(B.length),prompt:gDt(B),...ee&&{"prompt.id":ee},"message.uuid":D})`
  and `…{prompt_length:String(G.length),prompt:gDt(G),...se&&{"prompt.id":se},"message.uuid":ie})`.
- Delta: `prompt:gDt(B)` (single field) → `...G$t(L)` (spreads `prompt`+`prompt_text`).
- Novelty: `prompt_text` **v286=2 → v287=3** (+1 = the `G$t` helper). The 2
  pre-existing v286 hits are unrelated (`stop_hook_summary` hook-info schema
  `prompt_text:o().optional()` @200445647 region, and @101307368). `"message.uuid"`
  is present in **both** v286 and v287 builders ⇒ NOT part of this delta.

**OCC surface (live).** `src/utils/processUserInput/processTextPrompt.ts:67-73`:
```ts
if (otelPromptText) {
  void logOTelEvent('user_prompt', {
    prompt_length: String(otelPromptText.length),
    prompt: redactIfDisabled(otelPromptText),
    'prompt.id': promptId,
  })
}
```
`redactIfDisabled` is at `src/utils/telemetry/events.ts:17`, gated on
`OTEL_LOG_USER_PROMPTS` — the exact analogue of official `me`/`pe`.

**Port instructions (mirror `G$t`: redact once, emit both keys).**
```ts
if (otelPromptText) {
  // CC 2.1.287 (#4) — binary G$t(e){let o=me(e);return{prompt:o,prompt_text:o}}
  // @203885633: prompt_text is a copy of prompt (same redaction) for backends
  // that nest dotted keys. Compute the redacted value once.
  const redactedPrompt = redactIfDisabled(otelPromptText)
  void logOTelEvent('user_prompt', {
    prompt_length: String(otelPromptText.length),
    prompt: redactedPrompt,
    prompt_text: redactedPrompt,
    'prompt.id': promptId,
  })
}
```
Scope note (honest): official also carries `"message.uuid"` on this event, but
that field pre-exists in v286 and OCC already omits it — a separate pre-existing
divergence, **not** part of the #4 v287 delta. Keep this port to `prompt_text`.

---

## #9 — Permission prompts oldest-first → NO-OP

**Changelog:** "Changed waiting permission prompts to show oldest first, so a
new prompt no longer covers the one you're reading (prompts with a countdown
still open on top)."

**Finding: OCC already behaves oldest-first.** New requests append to the
**tail** and the REPL renders the **head**:
- `src/hooks/toolPermission/PermissionContext.ts:363-364`
  `push(item){ setToolUseConfirmQueue(queue => [...queue, item]) }` (tail append).
- `src/screens/REPL.tsx:4801` renders `toolUseConfirm={toolUseConfirmQueue[0]!}`
  (head = oldest), and `onDone` drops the head: `([_, ...tail]) => tail`.
So a newly-arriving prompt queues behind the one on screen — it never covers it.
OCC never had the newest-on-top bug the official fix corrects.

**Byte evidence (delta is logic-only, not a new string):** needle `oldest`
v286=57 = v287=57, all unrelated (`drop-oldest` backpressure, word lists) — no
new "oldest-first" string. The official "countdown prompts still open on top"
exception has **no OCC analogue** (OCC has no countdown-style permission
prompts), so there is nothing to add and no regression. **NO-OP.**

---

## #10 — Effort kept on automatic model switch → NO-OP

**Changelog:** "Changed automatic model switches after a flagged message to keep
your current effort level instead of the new model's default."

**Finding: OCC has no automatic-model-switch-after-flagged-message path.**
Greps for `autoSwitch|automaticModelSwitch|switchModelAfter|flaggedMessage|onMessageFlagged`
and for effort-reset-on-model-change (`setEffort|resetEffort|effort.*default` in
`src/commands/model/model.tsx`, `src/utils/effort.ts`) return **no such surface**.
OCC's effort is set explicitly (`/effort`, ultracode keyword) and model is set
explicitly (`/model`, opusplan); there is no code path that auto-switches the
model because a message was flagged and then re-derives effort. With no auto
switch, there is no effort to preserve. `keep your current effort` is changelog
prose, not a binary string. **NO-OP** for OCC (revisit only if OCC later adds an
auto-model-switch-on-flag feature).

---

## #13 — `/memory` arrow keys flip on/off → NO-OP (surface divergence)

**Changelog:** "Improved `/memory`: the left and right arrow keys now flip its
on/off settings, such as Auto-memory."

**Finding: OCC's `/memory` is a different UI.** `src/commands/memory/memory.tsx`
(102 lines) renders a `<Dialog title="Memory">` containing only
`<MemoryFileSelector>` — a **file picker** that opens a memory file
(CLAUDE.md-style) in an external/terminal editor (`editFileInEditor` /
`openFileInExternalEditor`). It has **no on/off settings rows** (no Auto-memory
toggle row) for arrow keys to flip. OCC does have an Auto-memory *concept*
(`src/utils/memory/autoMemorySessionGate.ts`, `Auto-memory` state text) but it is
not surfaced as a toggleable row inside `/memory`.

**Byte evidence:** `Auto-memory` v286=7 = v287=7 (not new); the official change
is a keybinding on a settings-row list OCC's memory dialog does not render. No
OCC surface to attach arrow-key flipping to ⇒ **NO-OP** (would first require
porting the official `/memory` settings-row dialog, a larger divergence).

---

## #1 — Claude Mods → STAGED (large subsystem, dark-shipped pre-v287)

**Changelog:** "Added Claude Mods: plugins may now modify deeper behavior."

**Byte evidence.** `claude-code-mods` **v286=2 = v287=2** (@100951951) — the
subsystem strings are **identical across versions**; no new `tengu_*mods*`
enablement flag found. The Mods machinery was **dark-shipped before v287**; the
changelog "Added" is a product announcement (server-flag/enablement), not new
bundle code. Recovered machinery (from prior forensics): `hooks/register.ts`
entry; `vendor/claude-code-mods/mods` dir; `builtin-hooks-module:` esbuild
resolver; scan hooks (`prompt.submit`, `command.run`, `turn.step`, `ui.render`,
`session.detach`, `session.end`); mod calls (`clock.after`, `env.get`,
`model.fork`, `prompt.fill/read/submit`, `session.id/surfaces/version`,
`state.get/set`, `store.get/set`, `telemetry.log/mark`, `ui.invalidate/resolve/toast`).

**OCC surface.** `src/plugins/builtinPlugins.ts` (`registerBuiltinPlugin`,
`BUILTIN_PLUGINS` Map, `{name}@builtin`, `BUILTIN_MARKETPLACE_NAME='builtin'`) +
`src/plugins/bundled/index.ts` `initBuiltinPlugins()` — **registers NOTHING
today** ("scaffolding"). OCC has no `vendor/claude-code-mods`, no
`builtin-hooks-module:` resolver, no scan-hook/call surface.

**Verdict: STAGED.** Whole subsystem port (hooks runtime + vendor bundle +
resolver + mod API). Already pre-flagged in ledger §8 as a "likely large
surface." Not a byte-verifiable small delta.

## #2 — You-should-know built-in mod → STAGED (depends on #1)

**Changelog:** "Added You should know, a built-in mod where a side agent watches
your back… `/plugin enable cc-plugin-you-should-know@builtin` (first-party
sessions with telemetry on)."

**Byte evidence.** Plugin id `cc-plugin-you-should-know` **v286=6 = v287=6**
(@94525524) — the plugin bundle pre-exists. The **tip id** `you-should-know-plugin`
**v286=0 → v287=3 (NEW)** — v287 registers the user-facing tip. The mod uses
`model.fork` for a side agent, gated first-party + telemetry-on.

**OCC surface / verdict: STAGED.** Requires the #1 Mods subsystem (absent in
OCC) plus a first-party/telemetry gate OCC does not model and a `model.fork`
side-agent. The only genuinely-new v287 byte is a tip-id string, which is inert
without the subsystem. Not portable standalone.

## #3 — agents view `n:<text>` filter → STAGED

**Changelog:** "Added an `n:<text>` filter to the agents view that matches
session names and tasks; a filter now shows matches in collapsed sections and
Enter opens the first match."

**Surface disambiguation (honest).** The "agents view" is the **`occ agents`
background-sessions dashboard** — registered in `src/main.tsx` ("Show background
sessions dashboard", `--definitions/--json`), backed by `src/daemon/*`
(`workerRegistry.ts`, `main.ts`, `process.ts`). It is **NOT**
`src/commands/agents/index.ts`, which is the *removed* `/agents`
subagent-management slash command (18 lines, `isHidden:true`, "(removed)").

**Byte evidence.** `n:` is untraceable as a novelty needle (raw v286=44769 →
v287=45396 — a generic substring across minified tokens); the filter is
logic + dashboard-render work, no isolable new string.

**Verdict: STAGED.** Feature addition (filter-token parsing + collapsed-section
rendering + Enter-opens-first-match) on the daemon dashboard. Medium UI surface,
not a small byte-verifiable delta.

## #5 — MCP URL prompts / 2025-11-25 / `bareElicitationCapability` → STAGED

**Changelog:** "Added URL prompts from MCP servers on the 2025-11-25 protocol…
If a server no longer connects after this update, add `bareElicitationCapability`:
true to its MCP config entry."

**Byte evidence.** The gate default **flipped false→true**:
- v286 `FJe(){return R("tengu_mcp_legacy_url_elicitation",!1)===!0}` (default `!1`).
- v287 `tnt(){return C("tengu_mcp_legacy_url_elicitation",!0)===!0}` (default `!0`).
  Flag string @98970516 (v287) / @98851344 (v286).
- v287 `hsn(){let e=GMt();if(!ent())return e;return{...e,elicitation:{form:{},url:{}}}}`,
  `ent(){return C("tengu_mcp_url_elicitation",!0)}`.
- Selector `hlt(e,{denylisted})` returns rich `{form,url}` when legacy-flag-on
  AND not denylisted AND type∈{stdio,sse,http,ws} AND NOT `bareElicitationCapability===true`;
  else bare `GMt()`.
- `bareElicitationCapability` **v286=9 = v287=9** (config key pre-exists as the opt-out).

**OCC surface.** `src/services/mcp/client.ts:1376` declares **bare**
`elicitation: {}` with the explicit comment "Sending `{form:{},url:{}}` breaks
Java MCP SDK servers (Spring AI)". `src/services/mcp/elicitationHandler.ts`
(`getElicitationMode()` → 'url'|'form'); URL elicitation handled via the `-32042`
error path (`client.ts:3522+`). MCP SDK `^1.29.0`.

**Verdict: STAGED — and porting the default flip is NOT recommended.** OCC's
bare `elicitation:{}` is a **deliberate divergence** for Java-SDK compatibility;
official v287 makes rich `{form,url}` the default with `bareElicitationCapability`
as the opt-out — i.e. OCC's current behavior now equals the official *opt-out*
path. The real dependency is MCP protocol **2025-11-25** + URL-elicitation
handling, already tracked in ledger §4 ("#24 MCP protocol 2025-11-25 + connector
stale-tools cache"). Large MCP surface; not a small port.

## #6 — Opus 4.7+/Fable 1M context default → STAGED

**Changelog:** "Changed Opus 4.7+ and Fable to use a 1M context window by
default on Bedrock, Vertex, Foundry and the Claude apps gateway, with no `[1m]`
suffix (`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` keeps 200K)."

**Byte evidence — provider-aware → provider-independent refactor.**
- v287: `qS(e){return!KP()&&EKr(e)}`, `EKr(e){return YI(e)!==void 0}`,
  `rv(e){let n=kt(e);return xa(n)?.context?.native_1m===!0||n===wbt}`,
  `wbt="claude-mythos-preview"`, `KP(){return a.CLAUDE_CODE_DISABLE_1M_CONTEXT}`.
- v286: `A_(e){if(Zx())return!1;…if(s==="firstParty"||fH(s)||s==="mantle")return!0;return YI(s,r)}`,
  `YI(e,n){let r=n?.native_1m_3p;switch(e){case bedrock/vertex/foundry:return r?.[e]===!0;case gateway:return r?.bedrock===!0&&r?.vertex===!0&&r?.foundry===!0;default:return!1}}`.
- Novelty: `native_1m_3p` **v286=5 → v287=0 (removed)**; catalog flag
  `native_1m` @101101404. 10 native_1m models: sonnet-5, sonnet-5-5, opus-4-7,
  opus-4-8, opus-5, opus-5-5, fable-5, fable-5-1, mythos-5, mythos-5-1.

**OCC surface (structurally divergent).** `src/utils/context.ts:64-77`
`modelSupports1M()` is **substring-based** (`claude-sonnet-4/5`, `opus-4-6/4-7/4-8`,
`opus-5`) — **no catalog**, and **no `fable`** (the changelog's Fable-1M is a
real OCC gap). Also `has1mContext()` (`/\[1m\]/i`), `is1mContextDisabled()`
(`CLAUDE_CODE_DISABLE_1M_CONTEXT`), `getContextWindowForModel()`. Betas:
`src/utils/betas.ts:273` `getAllModelBetas` pushes `CONTEXT_1M_BETA_HEADER` via
`has1mContext`. `src/services/api/claude.ts:2126` dynamic 1M beta append.
`src/utils/model/model.ts:173` `getDefaultOpusModel()` (per-provider); `:920`
fable arm notes the 1P strip path is dead under OCC's `modelSupports1M`.

**Verdict: STAGED.** Official moved to a **catalog-driven, provider-independent**
`context.native_1m` flag; OCC uses substring matching with no catalog and a
per-provider default table. Faithful parity = a model-registry refactor (add a
`native_1m` catalog + rewire `modelSupports1M`/betas/context-window), not a
small delta. The **fable-1M gap** is real but subsumed by that refactor; do not
patch fable alone (it would diverge from OCC's own substring scheme).

## #8 — `claude agents` queued replies / slash commands → STAGED

**Changelog:** "Changed replies from `claude agents` to arrive as queued
messages; slash commands other than `/stop` sent while a turn is running now run
when it ends."

**OCC surface.** `occ agents` daemon dashboard (`src/main.tsx` action +
`src/daemon/*`) and the message queue (`src/utils/messageQueueManager.ts`,
`src/bridge/replBridge.ts`). This is a behavior change to how dashboard replies
are delivered (queued vs. immediate) and how slash commands are deferred during
a running turn (all but `/stop`).

**Byte evidence.** No isolable new string (`when it ends` / `queued message` are
prose); the delta is in the daemon reply-dispatch + command-queue logic.

**Verdict: STAGED.** Behavior change across the daemon dashboard + queue;
medium surface, needs per-site decompilation of the reply-dispatch path.

## #11 — SDK priority "now" no longer cancels web fetch/search → STAGED

**Changelog:** "Improved SDK sessions so a message sent with priority 'now' no
longer cancels a running web fetch or web search; it keeps loading in the
background."

**Byte evidence.** Preempt machinery pre-exists: `this.preempt(` @224765333
(v287) / @222423274 (v286). Priority-now logic grew: `'now'` **v286=7 →
v287=11 (+4)**. Recovered v287 queue/preempt fragments reference
`priority==="now"` in the command-queue snapshot + `Ra(()=>this.preempt(n))` +
`this.turnRunning`. The specific change (detach in-flight web fetch/search
instead of aborting on a priority-now preempt) is **logic inside the preempt
path** — not isolable as a small byte-exact snippet.

**OCC surface.** `src/entrypoints/sdk/coreSchemas.ts:1435`
`priority: z.enum(['now','next','later']).optional()`; `src/utils/messageQueueManager.ts`;
`src/tools/WebFetchTool/WebFetchTool.ts:247,311` (`abortController`/`signal`);
`src/tools/WebSearchTool/WebSearchTool.ts`; `src/screens/REPL.tsx` (preempt).

**Verdict: STAGED.** Real delta (confirmed by +4 `'now'`), but the
preempt→abort→web-tool-detach interaction needs dedicated decompilation to port
faithfully. Not a small verifiable change.

## #12 — `/config` UI improvements → STAGED

**Changelog:** "Improved `/config`: settings that cycle show ‹ › and step both
ways with ←/→, narrow terminals stack each value under its label, and PgUp/PgDn
page the list."

**Byte evidence — render/logic only, no new strings.** Chevron `‹` (U+2039)
**v286=5 = v287=5**; `PgUp`/`PgDn` counts **dropped** (8→6); `step both ways`
is prose, not a binary string. So the improvement reuses existing glyphs and
changes the config-list render + key handling (bidirectional stepping, narrow-
terminal stacking, paging).

**OCC surface.** `src/commands/config/config.tsx`, `config-noninteractive.ts`,
`src/tools/ConfigTool/supportedSettings.ts`.

**Verdict: STAGED.** UI-render + keybinding rework of the config list; no small
byte delta to lift, and OCC's config render would need per-site work to match.

## #14 — `/skill` names typed mid-message → STAGED

**Changelog:** "Improved `/skill` names typed mid-message: Claude is now told
they are skills, including `disable-model-invocation` ones."

**Byte evidence.** `disable-model-invocation` **v286=18 = v287=18** (not new);
`typed mid-message` is prose. The delta is behavioral: when a `/skill` name
appears mid-message (not as the leading token), the harness now annotates it to
the model as a skill (incl. `disable-model-invocation` skills that can't be
model-invoked directly). No isolable new string.

**OCC surface.** `src/utils/processUserInput/processUserInput.ts`,
`processSlashCommand.tsx` (skill/slash detection); skill frontmatter list
includes `disable-model-invocation`.

**Verdict: STAGED.** Behavioral change in prompt/input processing; needs
per-site decompilation of the mid-message skill-annotation path.

## #15 — Permission-prompt dashed lines → STAGED

**Changelog:** "Improved the prompt for a held message from another session to
show the message between dashed lines…" + "Improved MCP and other tool
permission prompts to show the tool call between dashed lines, matching file
edit prompts."

**Byte evidence — cosmetic; delta not isolable.** `"dashed"` **v286=3 = v287=3**
(unchanged) and `borderStyle:"dashed"` = 0 in both (official Ink uses a different
minified representation). No new string marks the change; it reuses an existing
dashed style and applies it to the MCP/tool + held-message prompt renderers.

**OCC surface.** OCC already uses `borderStyle="dashed"` for file-edit prompts
(`src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx:78`)
and ExitPlanMode (`.../ExitPlanModePermissionRequest.tsx:632`). The generic
tool/MCP prompt renderers are `FallbackPermissionRequest.tsx`,
`PermissionRequest.tsx`, `PermissionDialog.tsx` — these would be the port target
to add the dashed border. OCC has no distinct "held message from another
session" prompt (remote/inbox bridging differs).

**Verdict: STAGED.** Cosmetic parity; the official delta is not byte-verifiable
(no string novelty), so per discipline it is not a PORT-CANDIDATE. A low-risk
follow-up would be wrapping OCC's fallback/tool permission body in
`borderStyle="dashed"` to match file-edit prompts — but that is an OCC-side
design choice, not a byte-verified official lift.

## #16 — stream-json `context:fork` skill streaming → STAGED

**Changelog:** "Fixed `--output-format stream-json` and the SDK not streaming
the turns of a `context: fork` skill run by typing `/<skill>` as the prompt, as
they do for the Skill tool's fork."

**Byte evidence.** Fork analytics field `invocation_trigger` **v286=7 = v287=7**
(not new); recovered fork builder `execution_context:b("fork"),invocation_trigger:c(N)`
with trigger values `user-slash`, `agent-preload`, `custom_skill`. The fix is in
the fork-execution/stream-json-emission path (a `/<skill>`-prompt-triggered fork
now streams its turns like a Skill-tool fork) — **logic only**, no isolable new
string.

**OCC surface.** `src/tools/SkillTool/SkillTool.ts` (imports
`../../utils/forkedAgent.js`, `prepareForkedCommandContext`, sets
`execution_context:'fork'`, collects forked-agent messages),
`src/tools/SkillTool/UI.tsx`, test `forkedSkillNestedProgress276.test.ts`.
stream-json emission lives in the print/SDK path (`src/cli/print.ts`).

**Verdict: STAGED.** Real bug fix, but verifying/porting requires
decompiling how the official distinguishes `/<skill>`-prompt vs Skill-tool fork
invocation and wires fork turns into stream-json — not a small byte-exact delta.
OCC has the fork infra, so a follow-up should first reproduce whether OCC's
`/<skill>`-as-prompt fork already streams or has the same gap.

---

## Method / reproducibility notes

- Offsets are absolute byte positions in the respective `package/claude` ELF
  (v287 ≈ 244 MB). Recovered code is quoted verbatim from byte slices; minified
  names drift between versions (e.g. redactor `gDt`(v286)→`me`(v287), builder
  `gs`→`ys`), so **structural** comparison, not names, establishes the delta.
- Novelty counts use `rg -ao -F "<needle>" <bin> | wc -l` (occurrences, not
  lines). A count of 0 or unchanged in v287 ⇒ pre-existing/dark-shipped; the
  changelog "Added" then reflects an announcement/enablement, not new bytes
  (true for #1, #2 plugin-id, #5 `bareElicitationCapability`, #13 `Auto-memory`).
- Items whose delta is logic-only with no new string (#3, #8, #9, #10, #11, #12,
  #14, #15, #16) cannot be lifted byte-exact; per the "never invent" discipline
  they are STAGED/NO-OP with OCC-surface mapping, not guessed ports.
- The two PORT-CANDIDATES (#7, #4) are each a single-site change on a live OCC
  code path with an exact official snippet, offset, and novelty count.
