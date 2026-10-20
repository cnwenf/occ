# impl-WP4 — CC 2.1.304 #22 (context_management beta 400 heal) + #58 (tool search default-on behind custom base URL + refuse-recovery)

WP4 cluster: `src/services/api/claude.ts`, `src/services/api/withRetry.ts`, `src/utils/toolSearch.ts`, `src/utils/config.ts` (persisted-config store), `src/utils/betas.ts` (read-only — no edits needed), plus 3 new test files and this doc. No git commands were run (edit-only per brief). No edits to package.json / CHANGELOG.md / docs/upstream-version-gap-*.md / files outside the cluster.

Sources: `docs/gap-research-304/research-R3-session-api.md` "#22" and `docs/gap-research-304/research-R4-skills-hooks.md` "#58" (byte-verified official 2.1.304 code).

---

## Item 1 — #22: `context-management-2025-06-27` beta 400 heal

### Files changed

| File | Change |
|---|---|
| `src/services/api/claude.ts` | `retryContextManagementRefused` + `markContextManagementBetaHealed` + `isContextManagementHealActive` closures (mirroring the 2.1.295 context1m state machine); `retryContextManagementRefused` added to the executeNonStreamingRequest retryOptions type + pass-through; `paramsFromContext` betasParams filter extended to strip `CONTEXT_MANAGEMENT_BETA_HEADER` while the heal latch is active; hook wired into the streaming withRetry options and both non-streaming call sites; `markContextManagementBetaHealed()` called on stream `message_start` and on non-streaming success alongside `markContext1mBetaHealed()` |
| `src/services/api/withRetry.ts` | `retryContextManagementRefused?: (error: APIError) => boolean` in RetryOptions (after `retryContext1mBetaRefused`); fatal-400 chain hook right after the context1m hook: `error instanceof APIError && error.status === 400 && options.retryContextManagementRefused?.(error)` → `attempt--; continue` (no retry budget consumed) |
| `src/utils/betas.ts` | NOT edited (verified read-only): the existing `CONTEXT_MANAGEMENT_BETA_HEADER` push (firstParty + `modelSupportsContextManagement` / ant tool-clearing opt-in) and the field gate in `paramsFromContext` (`contextManagement && useBetas && betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER)`) are exactly the surfaces the official recipe reuses — stripping the header auto-omits the `context_management` field |

### Decisions

- **Bespoke one-shot latch, mirroring retryContext1mBetaRefused's shape** (`idle → retrying → spent`), per the brief ("PORT M"). Classifier: `error.status === 400 && error.message.includes('context_management: Extra inputs are not permitted')` (official `Bgt` arm `dde` in the `M6t` heal map, verdict `retry:beta-rejected:context_management` @246856307). Guard: `lastRequestBetas` carried `CONTEXT_MANAGEMENT_BETA_HEADER`. Second 400 on the stripped resend flips `retrying → spent` and returns false so the error surfaces on the normal non-retryable 400 path.
- **Heal = strip the header from `betasParams`** while the latch is active (same live-binding mechanism as the context1m heal); the `context_management` FIELD auto-omits via the existing beta-presence gate — verified at `claude.ts` paramsFromContext (`...(contextManagement && useBetas && betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && { context_management: contextManagement })`), which is the changelog's "resends the request without that field".
- **Mark-healed sites**: stream `message_start` + both non-streaming success paths, alongside `markContext1mBetaHealed()`. `markContextManagementBetaHealed()` permanently removes the header from the outer `betas` array and fires telemetry once.
- **Chain position in withRetry**: immediately after the context1m hook (same 400-only gate shape, sync), before the toolschema hook.

### Verbatim strings used

- Error-message match: `context_management: Extra inputs are not permitted`
- Telemetry `tengu_beta_400_healed` metadata shape: `{beta: CONTEXT_MANAGEMENT_BETA_HEADER, model, provider, status: 400, unnamed: false}` — identical key set to `markContext1mBetaHealed` (values cast via `as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`).
- Warn/error logs use OCC's established `[betas]` prefix style (the official texts here are debug-log prose, not user-facing strings; pattern-matched to the neighboring context1m heal logs, e.g. `[betas] an HTTP 400 reads as the backend rejecting ${CONTEXT_MANAGEMENT_BETA_HEADER}; resending once without it`).

### Tests

`src/services/api/__tests__/contextManagementBetaHeal304.test.ts` (modeled on `context1mBetaHeal295Review.test.ts` — same VCR pass-through flag pattern, fetch-mock wire-byte capture, real attached analytics sink, tmp CLAUDE_CONFIG_DIR). Arrangement notes: model `claude-sonnet-4-6` (modelSupportsContextManagement true on firstParty), thinking ENABLED + `setIsInteractive(false)` so redact-thinking stays off and `getAPIContextManagement()` returns the `clear_thinking_20251015` edits → both the beta header AND the `context_management` field ride along.

Test names:
1. `named 400 → exactly one resend without the beta header and without the context_management field → success`
2. `successful stripped resend → tengu_beta_400_healed fires exactly once with the #22 shape (status:400, unnamed:false)`
3. `named 400 then a second named 400 on the resend → no third send, no telemetry, error surfaces`
4. `classifier gate: an unrelated 400 on an eligible beta-carrying request does not heal`

```
bun test src/services/api/__tests__/contextManagementBetaHeal304.test.ts
 4 pass, 0 fail, 25 expect() calls  [1281.00ms]
```

### Deviations

- Official telemetry for the generic named-beta scanner omits `unnamed`; the #22 recipe in research-R3 pins the `{beta,model,provider,status,unnamed}` shape (same as the context1m heal) — kept `unnamed: false` per the recipe and the brief.
- OCC has no per-model persisted spent registry for this heal (same documented deviation as the 2.1.295 context1m port): the latch is request-scoped.

---

## Item 2 — #58: tool search ON by default behind a custom `ANTHROPIC_BASE_URL` + refuse-recovery

### Files changed

| File | Change |
|---|---|
| `src/utils/toolSearch.ts` | (a) DROPPED the vprev-303 optimistic-disable branch in `isToolSearchEnabledOptimistic` (the `!ENABLE_TOOL_SEARCH && firstParty && !isFirstPartyAnthropicBaseUrl()` → false arm, replaced with a comment documenting the official removal, vprev=2 → vver=0 string hits); (b) new refuse-window block: `TOOL_SEARCH_REFUSED_TTL_MS = 86_400_000` (official `h`), `isToolSearchRefuseRecoveryEnabled()` (official `zOe`), `toolSearchRefusedKey()` (official `c`), `isRefusedAtFresh()` (official `f`), `pruneRefusedEntries()` (official `Cs`), `isToolSearchRefused()` (official `d`), `recordToolSearchRefused()` (official `DUs`); (c) `modelSupportsToolReference` final `return true` → `return !isToolSearchRefused(model)` (official `Zae`) |
| `src/utils/config.ts` | `toolSearchRefusedAt?: Record<string, number>` added to the `GlobalConfig` type (byte-verified official persisted-config key; vprev=0 / vver=2) with a doc comment (key derivation + TTL). `GLOBAL_CONFIG_KEYS` deliberately NOT extended (precedent: `skillUsage`/`clientDataCache` are absent too) |
| `src/services/api/claude.ts` | `retryToolSearchRefused` (async) + `markToolSearchRefusedHealed` closures implementing the official `b6`/`tse`/`mZ`/`ugn` chain; `retryToolSearchRefused?: (error: APIError) => Promise<boolean>` added to the executeNonStreamingRequest retryOptions type + pass-through + streaming withRetry options + both non-streaming call sites; `markToolSearchRefusedHealed()` on stream `message_start` and non-streaming success. New imports: `wrapMessagesInSystemReminder` (messages.js), `isToolSearchRefuseRecoveryEnabled`/`recordToolSearchRefused` (toolSearch.js), `isAPIErrorBodyType` (modelCallRetries.js — no import cycle, verified) |
| `src/services/api/withRetry.ts` | `retryToolSearchRefused` RetryOptions entry (async) + chain hook wired LAST in the fatal-400 chain (after toolschema): `error instanceof APIError && (error.status === 400 || error.status === 422) && (await options.retryToolSearchRefused?.(error))` → `attempt--; continue` |
| `src/utils/betas.ts` | NOT edited: `getToolSearchBetaHeader()` (1P/3P selection by provider) unchanged; recovery strips the header from the per-request `betas` array, not from the beta builder |

### Decisions

- **(a) Default mode**: with the branch dropped, `getToolSearchMode()` (unset → `'tst'`) governs behind custom base URLs — tool search ON by default. Explicit `ENABLE_TOOL_SEARCH` semantics preserved per the official recipe: `=false` → `'standard'` (the refused request is skipped entirely; recovery also off because `zOe` requires the env unset), `=true`/`auto` → always send + recovery off (`zOe` false).
- **(b) Persisted window**: key = `sha256(`${ANTHROPIC_BASE_URL}\0${normalizeModelStringForAPI(model)}`).slice(0, 24)` (official `c(e)` with `Pn` = normalizeModelStringForAPI — `[1m]`/`[2m]` suffixes normalize away); TTL `86_400_000` ms (official `h`); expired entries pruned on every write (official `Cs`); read/write through `getGlobalConfig()`/`saveGlobalConfig()` (official `ue()`/`Ae()`, same-reference-skip updater semantics). `recordToolSearchRefused` early-returns while the window is fresh (official `if(d(e))return`).
- **(c) Support predicate**: `modelSupportsToolReference` ends with `return !isToolSearchRefused(model)` (official `Zae`), so `isToolSearchEnabled` surfaces the refused window as its existing `model_unsupported` gate reason — no new gate plumbing.
- **(d) Refuse-recovery** (official `b6` → OCC mapping):
  - `po` (request used tool search) → `toolSearchHeader !== null && lastRequestBetas?.includes(toolSearchHeader)`
  - `zOe()` → `isToolSearchRefuseRecoveryEnabled()`
  - `eo instanceof Ot && (400||422)` → enforced by the withRetry chain gate (the only hook answering 422)
  - `eo.type !== "billing_error"` → `isAPIErrorBodyType(error, 'billing_error')` (modelCallRetries.ts:210 — reads `error.error.type` / `error.error.error.type` / message-substring across SDK versions)
  - `!J.resumeIncompleteThinking` → OCC has no resume-incomplete-thinking surface (trivially true — documented deviation)
  - `im===void 0 && !Pw(Er) && !vF(Er)` ("no other recovery claimed") → **chain position**: the hook is wired LAST in withRetry's fatal-400 chain (media → advisor → context1m → contextManagement → toolschema → **toolSearch**), plus a per-request `toolSearchRecoveryDone` one-shot latch mirroring the official `im` claimed-flag.
  - Rebuild: un-defer every dropped tool in full (`toolToAPISchema` with `deferLoading:false`, ToolSearch itself removed, `extraToolSchemas` suffix preserved), `useToolSearch = false`, strip the tool-search beta from `betas`, prepend the critical_system_reminder as an isMeta user message wrapped via `wrapMessagesInSystemReminder` (same rendering path as the OCC attachment precedent), then retry once. Natural one-shot even without the latch: the header is gone from `betas`, so `requestUsedToolSearch` is false on any second error.
  - Success side (official `ugn`): on the retry's first `message_start` / non-streaming success, `recordToolSearchRefused(options.model)` (official `DUs` — writes the window + official warn text) and `tengu_beta_400_healed {beta, model, provider, unclaimed:true}`.
- **(e) Conversation-scoped held-off (official `vgo`)**: VERIFIED no OCC surface — zero hits for the official log text `Tool search disabled: this conversation has run without ToolSearch, and stays so until it is compacted or cleared.`; OCC's 302 `auto_held` latch matches only `vgo`'s hold-ON arm (`e?.has(Ai) → true`) and is not broader. The persisted refused-window (b/c) is the functional equivalent for the custom-base-URL case. No code change; documented as a deviation.

### Verbatim strings used

- critical_system_reminder (prepended retry message, exact official text): `ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.`
- `[ToolSearch]` warn (official `tse`, level warn): `[ToolSearch] HTTP ${status} that no other recovery took, for a request that used tool search (${header}); making the call again without it...`
- `[ToolSearch]` warn (official `DUs`, level warn): `[ToolSearch] the endpoint set in ANTHROPIC_BASE_URL refused a request for ${model} and answered it without tool search; tool search stays off there for a day. ENABLE_TOOL_SEARCH=false skips the refused request; =true always sends tool search and turns this recovery off.`
- Telemetry: `tengu_beta_400_healed` with `{beta, model, provider, unclaimed: true}` (official `ugn` shape).
- Persisted-config key name: `toolSearchRefusedAt` (byte-verified official key).

### Tests

**`src/utils/__tests__/toolSearchRefusedWindow304.test.ts`** (unit — XEe/zOe/c/f/d/DUs/Cs/Zae):
default mode 'tst' behind custom URL + optimistic true; explicit `=false`/`=true` mode semantics; zOe true/false across (custom URL, official host, unset URL, assume-first-party flag, bedrock, `ENABLE_TOOL_SEARCH` set); fresh config → not refused; record writes the independently recomputed sha256 key and flips `isToolSearchRefused`/`modelSupportsToolReference`; idempotent re-record (official `if(d(e))return`); `[1m]` suffix normalization; per-model isolation; per-URL isolation; TTL expiry (`now − 86_400_001` → back on); prune-on-write (official `Cs`); zOe-gated reads (official host / assume flag ignore a planted entry); haiku patterns check still wins.

```
bun test src/utils/__tests__/toolSearchRefusedWindow304.test.ts
 20 pass, 0 fail, 40 expect() calls  [1098.00ms]
```

**`src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts`** (wiring — end-to-end through the real `queryModelWithStreaming` against an HTTP-layer fetch mock, modeled on `toolSearchHoldWiring300.test.ts`; custom `ANTHROPIC_BASE_URL`, no assume-first-party flag):
unclaimed 400 → exactly one retry without the tool-search beta, MCP tool re-declared inline, ToolSearch removed, critical reminder prepended (system-reminder-wrapped, verbatim text asserted on the wire bytes); successful retry → `toolSearchRefusedAt` recorded under the official key + `tengu_beta_400_healed {unclaimed:true}` once; 422 recovers identically; second eligible 400 → no third send, nothing recorded, error surfaces; `billing_error` 400 excluded; `ENABLE_TOOL_SEARCH=false` → standard mode, no tool search sent, no recovery; `ENABLE_TOOL_SEARCH=true` → tool search sent, recovery off, 400 surfaces with no retry; recorded window makes the NEXT query skip tool search outright (`model_unsupported` telemetry reason).

```
bun test src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts
 8 pass, 0 fail, 58 expect() calls  [1239.00ms]
```

### Deviations

1. `!J.resumeIncompleteThinking` — no OCC surface; trivially satisfied, documented above.
2. `im===void 0 && !Pw(Er) && !vF(Er)` — expressed as withRetry chain position (LAST) + the `toolSearchRecoveryDone` latch, not as a shared claimed-flag object (OCC's chain hooks are independent closures).
3. `vgo` conversation-scoped held-off — no OCC equivalent surface; persisted refused-window is the functional equivalent (see decision (e)).
4. Official `zOe()`'s `!l()` (force override consulting `ENABLE_TOOL_SEARCH` + a settings-level `iWo()` override) collapses to `!process.env.ENABLE_TOOL_SEARCH` — OCC has no `force` value and no settings-level tool-search override.
5. `GLOBAL_CONFIG_KEYS` not extended with `toolSearchRefusedAt` (precedent: `skillUsage`/`clientDataCache` absent); the type field + same-reference-skip updater are sufficient under both prod and NODE_ENV='test' config paths.
6. The 303 optimistic-disable branch drop is test-safe: zero existing tests asserted its log text ("is not a first-party Anthropic host" has no test hits).

### Integration notes

- `src/utils/attachments.ts` and other callers of `modelSupportsToolReference` inherit the refused-window semantics automatically (the predicate is the single choke point). attachments.ts itself is owned by another WP and was NOT touched.
- The tool-search recovery hook is the only async hook in withRetry's fatal-400 chain (awaited inside the existing async catch, after the pre-existing `await sleep(...)` — no structural change to the loop).
- Test-hygiene note (this round): `toolSearchRefusedWindow304.test.ts` polyfills `MACRO = { VERSION: '2.1.304' }` (a VALID semver) instead of the usual `'test'` — `ideExtensionSingleLaunch300.test.ts` reads `MACRO.VERSION` as its `BUNDLED_VERSION` and parses it as semver, and load-order races in shared-process directory runs otherwise fail it with "Invalid SemVer: test". (Pre-existing interference: the same race is demonstrably triggered by the untouched `toolSearchDeclaredLatch300.test.ts`.) The two api-dir test files keep the `'test'` polyfill per the `context1mBetaHeal295Review` template (api-dir full run is green).

---

## Verification summary

| Run | Result |
|---|---|
| `bun test src/services/api/__tests__/contextManagementBetaHeal304.test.ts` | 4 pass / 0 fail |
| `bun test src/utils/__tests__/toolSearchRefusedWindow304.test.ts` | 20 pass / 0 fail |
| `bun test src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts` | 8 pass / 0 fail |
| Related existing suites (context1mBetaHeal295Review, toolSearchHoldWiring300, toolSchemaRefused300, mcpHealWiring300, toolSearchAutoHold300, toolSearchDeclaredLatch300, toolSearchCompactBoundary302, toolSearchAllMatch302) | 61 pass / 0 fail |
| Retry/advisor suites (advisorEntryRefusedRetry276, advisorHostGate032, advisorInputTagRetry280, advisorRetryWiring276, modelCallRetries286, withRetryIntegration286, retryWatchdog295Review, retryTimeoutEngine288, retryWatchdogUsageLimit301, retryWatchdogRetryAfter281, advisorAws300, advisorGate276, advisorNoCheckmark295) | 214 pass / 0 fail |
| `bun test src/services/api/__tests__/` (full api dir, incl. both new api files) | 653 pass / 0 fail |
| `bun test src/services/mcp/__tests__/toolSearchDescCap295.test.ts src/tools/ToolSearchTool/__tests__/` | 40 pass / 0 fail |
| `bun test src/utils/__tests__/` (full utils dir) | 3186 pass / 12 fail — ALL 12 pre-existing cross-file interference in files outside this WP (drainStdout ×3, ideExtension ×3, large-memory ×4, invisibleUnicode ×1, substituteArguments ×1): each passes in isolation; ideExtension interference reproduced WITHOUT any WP4 file via the untouched toolSearchDeclaredLatch300 pairing; caps301 fails even in a 6-file run with zero WP4 files present |
| `bunx biome lint` on all 7 changed/new files | 0 errors (3 pre-existing `suppressions/unused` warnings on old biome-ignore comments in claude.ts, untouched by this WP) |
| `bunx tsc --noEmit` (once, per brief) | 967 total errors repo-wide (baseline ~1341 tolerated; tsc not a CI gate). ZERO errors in toolSearch.ts, config.ts, and the 3 new test files. claude.ts errors (1741, 3156, 3187-3189) and withRetry.ts errors (684, 696, 1139-1253) all sit on pre-existing lines (`filterMcpToolsForApi` assignment, SDK `.create` overload, `stripLastImageBlock`, the recurring `logEvent('api_request', {reason: string})` pattern) — none in WP4-added code |
