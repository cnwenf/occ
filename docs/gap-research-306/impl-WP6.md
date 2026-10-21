> **⚠️ SUPERSEDED (OCC-125 reconciliation, 2026-10-22):** the work described in
> this report was implemented in this round but **DROPPED before commit** — the
> parallel OCC-165 round landed its own version of the same upstream item on
> origin/main first, and per the collision precedent main wins every overlapping
> implementation. The file/test names below refer to the pre-reconciliation WIP
> commit `dc40f769`, NOT to the committed tree. See
> `docs/upstream-version-gap-occ125-2026-10.md` §1b for the mapping to main's
> P1–P10 items. "LANDED" statements below are historical to the WIP branch only.

# impl-WP6 — allowedMcpServers trusted-scope exemption + 2.1.305 `${VAR}`-only-in-env marking (R1 ITEM 2)

Status: **LANDED** (no commit, per instructions). Branch `agent/occ/156f5788`.

Scope: `docs/gap-research-306/research-R1-sandbox-mcp-allowlist.md` ITEM 2 only (v306 semantics landed directly, including the v304-era trusted-scope exemption OCC never had), plus the cheap VERIFICATION step of `research-R5-ui-consent-workflow.md` Item 5.

---

## 1. What landed

### 1.1 `expandedFromEnv` type surface — `src/services/mcp/types.ts`
- `ScopedMcpServerConfig` gains `expandedFromEnv?: boolean` with an evidence-commented block (official marking predicate `VVr`/walker `hMn` @250660359/250660759; gate `aB` with `Bj`/`FMn=["enterprise","managed"]` @250689996).
- Hash-exclusion check (plan step 1):
  - `hashMcpConfig` (`src/services/mcp/utils.ts`) — the only config-hash in the MCP stack (used by `excludeStalePluginClients` change detection). Official strips `expandedFromEnv` from the server-config hash `dq`; OCC now destructures `{ scope, expandedFromEnv, ...rest }` before hashing. **Edited.**
  - `redaction.ts` — `authoredMatchesExpanded`/`recordFieldsMatch` compare only specific fields (type, url, command+args, headers, env records); a new top-level flag cannot affect them. No edit needed.
  - `dedupClaudeAiMcpServers` — URL-signature dedup over claudeai-scope servers only. No edit needed.

### 1.2 Marking predicate — `src/services/mcp/config.ts`
- New exported helper `usesVarOutsideEnv(config)` mirroring official `VVr` exactly:
  - `stdio`/`undefined`: tests `command` + `args` — **NOT `env` values** (that exclusion, `s!=="env"&&Wet(r)`, is the actual 2.1.305 code delta; v304's `iVr` also tested `Object.values(env??{})`).
  - `sse`/`http`/`ws`: tests `url` + `headers` values.
  - `sse-ide`/`ws-ide`/`sdk`/`claudeai-proxy`: `false`.
  - Regex: reuses `hasEnvVarRefs` from `./redaction.js`, which is verbatim `new RegExp(ENV_VAR_PATTERN).test(value)` = official `Wet`/`q2e` @237824349 (incl. `${VAR:-default}` form). DRY deviation from the plan's "reuse ENV_VAR_PATTERN" wording — identical semantics, no duplicated regex construction site.
- Marking site inside `parseMcpConfig`'s per-server loop (the shared parse used by every scope — matches the official, which marks in the config parse `vHt` keyed on the scope param):
  ```ts
  if (scope === 'enterprise' && usesVarOutsideEnv(config)) {
    configToCheck = { ...configToCheck, expandedFromEnv: true }
  }
  ```
  `config` is the schema-parsed **RAW pre-expansion** config (official `Pe`), so placeholders are still visible; the flag lands on the (possibly expanded) result. Loop var widened to `McpServerConfig & { expandedFromEnv?: boolean }`.

### 1.3 Trusted-scope bypass — `isMcpServerAllowedByPolicy` (config.ts)
Immediately after the `isMcpServerDenied` early-return (deny precedence preserved), inserted the official line (`if(n?.scope!==void 0&&Bj(n.scope)&&!n.expandedFromEnv&&!n.pluginSource)return!0;`, byte-identical v304 `GU` @249214861 = v306 `aB`):
```ts
if (
  config?.scope !== undefined &&
  (config.scope === 'enterprise' || config.scope === 'managed') &&
  !config.expandedFromEnv &&
  !config.pluginSource
) {
  return true
}
```
Param type widened to `McpServerConfig & { scope?: ConfigScope; expandedFromEnv?: boolean; pluginSource?: string }` — backward-compatible for all callers (enterprise loop passes `ScopedMcpServerConfig`; `filterMcpServersByPolicy`/`McpAuthTool` pass plain configs → no `scope` → fall through unchanged). OCC's `ConfigScope` enum already contains `'managed'`.

Net effect: with any `allowedMcpServers` set, org-delivered managed-mcp.json entries with no `${VAR}` outside `env` now load without being listed (v304 exemption, new for OCC), and env-only-`${VAR}` entries also load (the 305 regression target). `${VAR}` in command/args/url/header values → still checked. Denylist still wins over everything.

### 1.4 Describe text — `src/utils/settings/types.ts` (surgical edit only)
Replaced the `allowedMcpServers` `.describe(...)` with the VERBATIM v306 text (extracted via `dd` @238434112 region; `grep -aboF 'entries with no ${VAR} in their command'` → 129072705, 238434112). **Byte-verified at runtime**: extracted the built schema's `.description` via `bun -e` and byte-compared against the dd'd binary span → `BYTE-EQUAL: True`. No other line of the file touched (concurrent-agent safe).

## 2. Tests

New file `src/services/mcp/__tests__/mcpAllowlistTrustedScope306.test.ts` — **27 tests / 36 expects, all pass**. Covers the research plan's full list:
- `usesVarOutsideEnv` unit matrix: env-only → false (305 target); command/args/url/headers → true; `${VAR:-default}` → true; implicit-stdio; sdk/claudeai-proxy → false.
- `parseMcpConfig` marking: enterprise+command-`${VAR}` → marked; enterprise+env-only → unmarked; user scope → unmarked; marking reads the RAW config even with `expandVars:false`.
- Gate: no-`${VAR}` enterprise entry + non-matching allowlist → **loads** (v304 exemption, new for OCC); `managed` scope same; `expandedFromEnv` → still checked → blocked, and allowed with a matching `serverCommand` entry; `deniedMcpServers` precedence over the bypass; `pluginSource` blocks the bypass; user/project/local/dynamic and scope-less configs unaffected; empty allowlist (`[]`) still bypassed by trusted entries but blocks marked ones; undefined allowlist baseline.
- Integration through the real `getClaudeCodeMcpConfigs` enterprise-exclusive branch with an on-disk managed-mcp.json (mocked managed path): env-only-`${VAR}` + plain entries load under a non-matching allowlist, command-`${VAR}` entry filtered, env values expanded, denylist blocks end-to-end.

Suite results:
- `bun test src/services/mcp` → **498 pass / 0 fail** (41 files, incl. the new one).
- `bun test` on `mcpPolicyBlockedSubagent299`, `mcpPolicyBlockedHealth299`, `mcpGetDynamicScope285` → 15 pass / 0 fail.
- `bun test src/tools/McpAuthTool` (the only external `isMcpServerAllowedByPolicy` consumer) → 44 pass / 0 fail.
- `bunx biome lint` on all 5 touched files → **exit 0, 0 errors** (31 warnings, all `lint/suspicious/noTemplateCurlyInString` on the intentional literal `${VAR}` text in test names/fixtures and the verbatim describe — unavoidable while matching official bytes).
- No repo-wide `bun test` run, per instructions. No commit, no `bun install`.

## 3. R5 Item-5 verification — SDK `setMcpServers` same-name replacement

**Result: NO GAP** — every mid-session reload path threads the current dynamic servers; no fix was needed.

`getClaudeCodeMcpConfigs(` call sites (non-test):
1. `src/main.tsx:2176` — startup; passes `dynamicMcpConfig` (`--mcp-config`).
2. `src/cli/handlers/mcp.tsx:335` — one-shot CLI `mcp` subcommand (separate short-lived process; no live SDK servers exist there by construction — the file's own comment documents the hardcoded `{}`). Not a reload path.
3. `src/services/mcp/useManageMCPConnections.ts:812` — `initializeServersAsPending` (re-runs on `/clear` session change and `/reload-plugins`): passes the current `dynamicMcpConfig` prop AND re-spreads `{ ...existingConfigs, ...dynamicMcpConfig }` after.
4. `src/services/mcp/useManageMCPConnections.ts:917` — `loadAndConnectMcpConfigs`: passes `dynamicMcpConfig` (+ claudeai promise) and spreads it last into `configs`.

Supporting facts: both hook effects list `dynamicMcpConfig` in their dependency arrays, so a changed dynamic set re-triggers them with the current value; inside `getClaudeCodeMcpConfigs` the static merge spreads `...dynamicServers` AFTER user/project/local, so a same-named dynamic server already beats a user-settings server. The print/SDK path (`mcp_set_servers`, `src/cli/print.ts:5699 handleMcpSetServers`) does a full same-name replacement against the desired set (explicit remove/add diff of `dynamicMcpState`/`sdkMcpConfigs`) and never re-reads user settings over it. The official pre-fix bug (a user-settings server resurfacing over an SDK-provided one on reload) cannot occur in OCC's structure.

## 4. Deviations / notes

- **Reused `hasEnvVarRefs`** (redaction.ts:98, already the verbatim official `Wet`) instead of re-deriving `new RegExp(ENV_VAR_PATTERN)` in config.ts — plan-equivalent, DRY.
- **`hashMcpConfig` strip added** in `src/services/mcp/utils.ts` (inside the allowed `src/services/mcp/**` touch scope) — official `dq` strips `expandedFromEnv`; without it the derived flag would participate in stale-client change detection.
- **Pre-existing unrelated failure observed in the shared tree**: `src/utils/settings/__tests__/policyStrictParse282.test.ts` → "non-object sandbox synthesizes the restrictive skeleton WITHOUT enabled/failIfUnavailable" fails because the concurrent WP5 sandbox agent's in-flight `policyLocks.ts` edit adds `{path:['sandbox','allowNestedUserNamespaces'],restrictive:!1}` to `RESTRICTIVE_ENTRIES`, which changes the synthesized skeleton the test pins. Not caused by WP6 (none of WP6's files participate in sandbox strict-parse); left untouched per the disjoint-file rule — WP5 owns that test update.
- Research-plan e2e REPL check (managed-mcp.json + `allowedMcpServers: []` → `/mcp` shows the server) was not run here (no repo-wide/e2e mandate in this WP); the integration test exercises the same contract through the real `getClaudeCodeMcpConfigs` enterprise branch with an on-disk file. Orchestrator task #3 (real e2e incl. REPL) can pick up the live check.

## 5. Files touched

| File | Change |
|---|---|
| `src/services/mcp/types.ts` | `expandedFromEnv?: boolean` on `ScopedMcpServerConfig` (+evidence comment) |
| `src/services/mcp/config.ts` | `usesVarOutsideEnv` helper; enterprise marking in `parseMcpConfig`; trusted-scope bypass in `isMcpServerAllowedByPolicy` (+widened param type); `hasEnvVarRefs` import |
| `src/services/mcp/utils.ts` | `hashMcpConfig` strips `expandedFromEnv` (official `dq` parity) |
| `src/utils/settings/types.ts` | surgical describe replacement — byte-verified verbatim v306 |
| `src/services/mcp/__tests__/mcpAllowlistTrustedScope306.test.ts` | new — 27 tests |
