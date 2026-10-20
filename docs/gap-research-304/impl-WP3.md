# impl-WP3 — skills/hooks ports (#59+#31, #60, #61, #39)

Branch: `agent/occ-leader/3bdf2d90`. All work confined to the WP3 file cluster
(no git commands run; no package.json/CHANGELOG/gap-ledger edits; `src/utils/hooks.ts`
and `src/services/tools/toolHooks.ts` untouched — other WP's cluster).

Sources: `docs/gap-research-304/research-R4-skills-hooks.md` sections "#59 + #31",
"#60", "#61", "#39" (byte-verified official 2.1.304 code). Official technical
strings kept verbatim: `tengu_skill_hooks_bounds_checked` + field names, the `kt`
notice text, the warn sentence, the digest format.

---

## Item 1 — #59 + #31: skill-listing history-scan digest dedupe

### Files changed

- `src/utils/attachments.ts`
  - Import: added `createHash` to the `crypto` import.
  - `skill_listing` attachment type (~line 646): added optional parallel arrays
    `names?: string[]` and `digests?: string[]` (CC 2.1.304 writer shape).
  - Caller in `getAttachments` (~line 1049): `maybe('skill_listing', () =>
    getSkillListingAttachments(context, messages))` — the writer now receives the
    message history.
  - Machinery block (~line 3162): the pre-304 session-state dedupe was replaced
    with three exported pure functions + a doc comment carrying the official refs:
    - `computeSkillListingDigest(cmd)` — official `C8e`/`Ldt`:
      `sha256(JSON.stringify([name, whenToUse ? `${description} - ${whenToUse}` : description]))`
      hex, `.slice(0, 16)`. Uses `createHash('sha256')` from `crypto` (NOT
      `src/utils/hash.ts` — that is wyhash/Bun.hash; digests persist in transcripts
      and must be stable across processes/versions).
    - `collectSentSkillListings(messages)` — official `EDr` scan: walks
      `type === 'attachment'` messages whose `attachment.type === 'skill_listing'`,
      builds `Map<name, Set<digest | undefined>>` via the official
      `K.set(name, (K.get(name) ?? new Set()).add(digests?.[i]))` merge. Hardened
      against transcript garbage (non-array `names` ignored; missing `digests`
      records `undefined`, matching official `Ee?.[xe]`).
    - `filterUnsentSkills(commands, sent)` — official filter:
      `!knownDigests?.has(undefined) && !knownDigests?.has(computeSkillListingDigest(cmd))`.
      A listing row with an unknown digest (legacy pre-304 transcript) suppresses
      re-send, exactly like official `!we?.has(void 0)`.
  - `getSkillListingAttachments(toolUseContext, messages)` rewritten (~line 3340):
    NODE_ENV=test guard, Skill-tool-invocation skip, command gathering and the
    EXPERIMENTAL_SKILL_SEARCH branch unchanged; then history scan →
    `filterUnsentSkills` → return `[]` when nothing new →
    `isInitial = (sent.size === 0)` → log line kept verbatim:
    `Sending ${n} skills via attachment (initial|dynamic)` → attachment now
    carries `names: newSkills.map(c => c.name)` and
    `digests: newSkills.map(computeSkillListingDigest)`.
  - `isValidAttachmentPayload` doc comment updated (logic unchanged): pre-304
    rows pass via the absent-`names` branch; post-304 writers emit
    Array-bounded `names`/`digests`.

### Deleted machinery (complete list, with all call sites)

- `sentSkillNames` (module state), `suppressNextSkillListing` /
  `suppressNext()` latch, `resetSentSkillNames()`,
  `resyncSentSkillNamesAfterRewind()` — all removed from `attachments.ts`.
- Call sites cleaned (each left with an explanatory comment pointing at the
  history-scan replacement):
  - `src/screens/REPL.tsx` — `rewindConversationTo` no longer resyncs; the scan
    naturally re-sends listings removed by the rewind slice (subsumes official
    2.1.301 #27). Import trimmed.
  - `src/utils/conversationRecovery.ts` — `restoreSkillStateFromMessages` no
    longer suppresses the next listing; resumed transcripts already contain the
    listing rows, so the scan suppresses re-send by construction. Import trimmed.
  - `src/commands/clear/caches.ts` — `/clear` wipes messages → scan finds
    nothing → full listing re-sends naturally (cache reset call removed).
  - `src/utils/plugins/cacheUtils.ts` — `clearAllCaches` no longer resets the
    sent-names set; plugin reloads are delta-sent precisely via digests (#31).
  - `src/utils/skills/skillChangeDetector.ts` — comment updated: changed skills
    re-send because their digest changed; unchanged ones stay silent.
- `test/utils/skillListingRewindResync301.test.ts` — DELETED (covered only the
  removed machinery); replaced by `test/utils/skillListingHistoryDedupe304.test.ts`.
  Verified zero dangling references to any deleted symbol.

### Decisions

- **REVERSAL documented in-code**: OCC's old comment claimed re-sending after
  compaction was wasteful and skipped it; official 2.1.304 intentionally RE-SENDS
  the full listing after compaction (compaction drops the listing rows from
  history, so the model loses the catalog unless re-sent). The new code follows
  official behavior; `compact.ts` (`stripReinjectedAttachments` docstring + the
  old skip-rationale block ~576 + note ~1005) and `postCompactCleanup.ts` (~79)
  got comment-only updates recording the reversal.
- Per-agent scoping preserved for free: the scan sees only the agent-local
  `messages` array passed through `getAttachments`.
- Digest = sha256 hex prefix 16 chars over `[name, description (+ " - " + whenToUse)]`
  — byte-identical formula to official `C8e`∘`Ldt`.

### Tests — `test/utils/skillListingHistoryDedupe304.test.ts` (18 tests)

digest format vs inline sha256 / Ldt join / digest sensitivity per field;
empty-listing-free history, legacy row without names, names-without-digests,
length-mismatch tail, non-array names hardening; multi-listing merge accumulating
digest sets; filter keep/drop/changed-digest/legacy-undefined; lifecycle:
isInitial semantics, resume suppression (subsumes `suppressNextSkillListing`),
rewind re-send (subsumes `resyncSentSkillNamesAfterRewind`).

`bun test test/utils/skillListingHistoryDedupe304.test.ts` → **18 pass, 0 fail, 29 expect()**.

---

## Item 2 — #60: skill hooks bounds (simplified port)

### Files changed

- `src/utils/hooks/registerSkillHooks.ts` (rewritten around the official `yt`):
  - `export type SkillHooksUnfitReason = 'characters' | 'count'`
  - `export const SKILL_HOOKS_BOUND = 1024` (official `uIr`),
    `export const SKILL_MATCHER_CHARS_BOUND = 16384` (official `pIr`),
    private `SKILL_HOOKS_UNFIT_TEXT_CAP = 64` (official `Kt`).
  - `export const SKILL_HOOKS_KEPT_OUT_NOTICE` — the official `kt` text VERBATIM.
  - Module-local ledger `Map<sourceKey, {hooks, characters, texts, unfitTexts}>`;
    `sourceKey = pluginId ?? sourceKind` (official `u??o`).
    `resetSkillHooksLedgerForTesting()` exported (official ledger is per-session
    on the host registry; OCC's is per-process — one CLI process = one foreground
    session lifecycle).
  - `checkSkillHooksBounds(skillName, hooks, boundsInfo)` (official `yt`):
    memo per `sha256(JSON.stringify([skillName, JSON.stringify(hooks)]))`
    (official `C=_([s,nt(_(T))])`); ask = Σ over
    `Object.values(hooks).flatMap(m => m ?? [])` of
    `max(1, matcher.hooks.length)` hooks and
    `(matcher.matcher?.length ?? 0) × max(1, matcher.hooks.length)` chars;
    **characters bound checked BEFORE count** (official order); at the 64-warn
    cap, early return with the reason and NO memo write / telemetry / warn
    (official `if(y.unfitTexts===Kt)return H`); telemetry
    `tengu_skill_hooks_bounds_checked` fired BEFORE the draw increment with the
    official field shape (`outcome` `'fits'|'characters'|'count'`, `source_kind`,
    `hooks_asked`, `characters_asked`, `hooks_drawn_before`,
    `characters_drawn_before`, `hooks_bound`, `characters_bound`); fits → draw
    `entry.hooks += asked; entry.characters += asked`; unfit → official warn
    sentence VERBATIM via `logForDebugging(..., { level: 'warn' })`.
  - `registerSkillHooks(...)` signature gained optional
    `boundsInfo?: SkillHooksBoundsInfo` and now RETURNS
    `SkillHooksUnfitReason | undefined`; on refusal NOTHING is registered.

### Decisions / deviations

- Official reasons include `'matcher'` (cloud host can't test matchers) and host
  callbacks `skillHooksDoNotFit` / `skillHooksRegistered` — SKIPPED per the port
  recipe (OCC has no cloud/plugin-host callback API). Documented in-file.
- Official memo key hashes `sha256(JSON.stringify(hooks))` inside the pair; task
  spec said `sha256([skillName, JSON.stringify(hooks)])` — followed the task
  (functionally identical: injective Map key over the same inputs).
- Telemetry string values go through the
  `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` branded cast
  (OCC analytics metadata type forbids raw strings).

### Tests — `src/utils/hooks/__tests__/skillHooksBounds304.test.ts` (15 tests)

fits-registers with full official telemetry field-shape assertion; count refusal
(1025 hooks) registering NOTHING + verbatim warn text assertion; characters
refusal (16385-char matcher); characters-checked-before-count ordering; chars ×
hook-count multiplication + cumulative draws across skills (`characters_drawn_before`
/ `hooks_drawn_before` verified); empty `hooks: []` counts as 1; cumulative count
boundary (1000+30 refused, 1000+24 = exactly 1024 fits); ledger isolation by
plugin id (`plugin-one` spent ≠ `plugin-two` fresh) with `source_kind` telemetry
assertion; memo on refusal (replay: same verdict, ONE telemetry event, ONE warn);
memo on fits (replay does not double-draw: 1000 + replay + 24 still fits); warn
cap (65 distinct unfit skills → 65 refusals but exactly 64 warns + 64 telemetry
events); `kt` notice constant byte-equality.

**Cross-file hygiene** (found by suite runs): Bun executes all test files in one
process and `spyOn` returns the SAME accumulating mock when a later file re-spies
an export — `agentHookTrust.test.ts` picked up this file's stale
`logForDebugging` calls. Fixed with `mockClear()` in `beforeEach` and
`mockRestore()` in `afterAll`.

---

## Item 3 — #61: allowed-tools stripped when hooks kept out

### Files changed

- `src/utils/processUserInput/processSlashCommand.tsx`
  (`getMessagesForPromptSlashCommand`):
  - Import: `registerSkillHooks`, `SKILL_HOOKS_KEPT_OUT_NOTICE`,
    `type SkillHooksUnfitReason` from `../hooks/registerSkillHooks.js`.
  - Hoisted `const hooksKeptOutByPolicy = command.hooks !== undefined &&
    !hooksAllowedForThisSkill` (official `ae = e.hooks!==void 0 && !N`).
  - `let hooksUnfitReason: SkillHooksUnfitReason | undefined` captured from
    `registerSkillHooks(...)`, now called with boundsInfo
    `{ sourceKind: command.source, pluginId: command.pluginInfo?.pluginManifest.name }`
    (official `yt` inputs `o`/`u`).
  - `const additionalAllowedTools = hooksUnfitReason !== undefined ||
    hooksKeptOutByPolicy ? [] : parseToolListFromCLI(command.allowedTools ?? [])`
    (official `O = ge!==void 0 || w!==void 0 || ae ? [] : Hu(r)`).
  - `hooksNoticeMessage` — the official `kt` notice appended VERBATIM as
    `createUserMessage({ content: SKILL_HOOKS_KEPT_OUT_NOTICE, isMeta: true })`
    right after the skill instruction message (official
    `...w!==void 0||ae&&!v ? [Re({content:Ol(kt),isMeta:!0})] : []`; the `v`
    preload flag has no OCC analogue on this path).

### Decisions

- Official's MCP-skill verification strip (`ge`) has no OCC path — skipped,
  documented in-code.
- The coordinator branch (dead: `feature('COORDINATOR_MODE')` off) needs no
  kt-notice mirror.
- `SkillTool.ts` routes through `processPromptSlashCommand`, so model-invoked
  skills inherit the stripping via `processedCommand.allowedTools` — no separate
  edit needed there.

### Tests — `src/utils/processUserInput/__tests__/allowedToolsStripped304.test.ts` (6 tests)

policy-kept-out → `allowedTools: []` + kt notice + nothing registered;
bounds-unfit (16385-char matcher) → same triple; fitting hooks under allowed
policy → `allowedTools === parseToolListFromCLI(['Bash'])`, no notice, hook in
session state; no-hooks skill keeps its grant, no notice; trusted admin source
under the plugins-only policy keeps hooks AND tools; the notice message is a
`user` message with `isMeta: true` and the byte-exact official text.

**Cross-file hygiene** (found by suite runs): Bun's `mock.module` restore does
NOT rebind importers cached while the mock was active — a stale
`isRestrictedToPluginOnly() === true` closure leaked into
`hooksBeforeExpansion299.test.ts` and silently blocked its skill-hook
registration (#168 test). Fixed by resetting the mutable closure variables to
production defaults (`false`/`false`) in `afterAll` alongside the module
restores, with an explanatory comment.

---

## Item 4 — #39: once-hook removal scoped to skillRoot

### Files changed

- `src/utils/hooks/sessionHooks.ts` — `removeSessionHook` gained an optional
  skill-identity parameter via a rest tuple
  (`...skillRootScope: [skillRoot?: string]`): when the argument is PROVIDED
  (even as `undefined`), removal is scoped to matchers whose stored
  `matcher.skillRoot ?? undefined === skillRoot` AND the hook is equal; when
  ABSENT, the pre-304 behavior (remove from ALL matchers of the event) is kept
  for legacy callers. Official: `e.remove(n,I,D,{skillRoot:s})`.
- `src/utils/hooks/registerSkillHooks.ts` — the `once: true` `onHookSuccess`
  callback now passes `skillRoot` into `removeSessionHook`, so skill A's
  once-hook firing no longer removes skill B's byte-identical hook.

### Decisions

- Rest-tuple instead of a plain optional param: distinguishes "provided as
  undefined" (a skill without a skillRoot — scoped removal against unscoped
  matchers only) from "absent" (legacy 4-arg callers keep cross-matcher removal).
- Legacy callers verified unaffected: the goal command's prompt-hook removals at
  `src/commands/goal/index.tsx` (lines 109/155/194/201) pass 4 args.
- `addSessionHook` already stored `skillRoot` on matchers and matched on
  `(matcher, skillRoot)` pairs, so identical hooks from different skills already
  occupied separate matcher entries — removal scoping was the only missing half.

### Tests (in `skillHooksBounds304.test.ts`, describe #39, 3 tests)

two skills with byte-identical `once: true` PreToolUse hooks and different
skillRoots — firing A's `onHookSuccess` removes A's matcher and leaves B's
registered; legacy 4-arg `removeSessionHook` removes from ALL matchers;
explicit-`undefined` 5th arg removes only unscoped matchers.

---

## Verification summary

- `bun test src/utils/hooks/__tests__/ src/utils/processUserInput/__tests__/
  test/utils/skillListingHistoryDedupe304.test.ts` + conversationRecovery /
  commandsCacheInvalidation / clear-cost-reset / transcriptLoad276 /
  reloadPluginsInstalledCache299 / loadedSkillsDedup (34 files) →
  **364 pass, 0 fail, 871 expect()**
- attachments/consumer suites (26 files: attachments*, atMention*, resume*,
  compact-adjacent, permissions, queuedCommandDrain, …) → **251 pass, 0 fail**
- compact suites (12 files incl. `src/services/compact/__tests__/`) →
  **149 pass, 0 fail**
- New-file totals: 18 (#59/#31) + 15 (#60/#39) + 6 (#61) = 39 tests →
  **39 pass, 0 fail, 102 expect()**
- `bunx biome lint` on all 14 changed/new files → **clean**.
- `bunx tsc --noEmit` (full, once): **zero errors in WP3-owned files**
  (registerSkillHooks.ts, sessionHooks.ts, the new tests, and all
  attachments/processSlashCommand hunks). Remaining filtered hits are
  pre-existing repo debt verified NOT from this WP: `attachments.ts:2002`
  (withheld-memory region, byte-identical to HEAD), `processSlashCommand.tsx`
  813–843 (fork-dispatch region, outside this WP's hunks), `REPL.tsx:2169`
  (outside this WP's hunks), and two untouched test files.

## Integration notes for the orchestrator / verifier

- `registerSkillHooks` return type changed (`void` →
  `SkillHooksUnfitReason | undefined`) — the only live caller
  (`processSlashCommand.tsx`) is updated; any future caller should propagate the
  reason to the #61 strip + notice logic.
- The #60 ledger is module-local and per-process (documented simplification vs
  the official per-session host ledger). If OCC ever runs multiple foreground
  sessions in one process, the ledger needs a sessionId key.
- Skill-listing attachments written by this build carry `names`/`digests`;
  older transcripts without them are handled (legacy rows suppress by name with
  unknown digest; listing-free history re-sends everything).
- WP-boundary compliance: `src/utils/hooks.ts`, `src/services/tools/toolHooks.ts`,
  and the `attachments.ts` image caller (~2676) were NOT touched; all
  `attachments.ts` edits are inside the skill-listing regions (~646 type, ~1049
  caller, ~3162 machinery, ~3340 writer) plus the `crypto` import line.
