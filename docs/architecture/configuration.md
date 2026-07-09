# Configuration

OCC is configured through a 3-tier settings hierarchy (user → project →
policy), runtime feature flags, environment variables, and provider
selection. This document covers each layer.

## Settings hierarchy — `src/utils/settings/settings.ts`

The merge order (low → high): `userSettings → projectSettings → localSettings
→ policySettings` (policy is "first source wins" internally). The chain
starts from `getPluginSettingsBase()` (lowest), then iterates
`getEnabledSettingSources()`.

| Source | Path | Notes |
|---|---|---|
| `userSettings` | `~/.claude/settings.json` | User-wide |
| `projectSettings` | `.claude/settings.json` | Checked into repo |
| `localSettings` | `.claude/settings.local.json` | Gitignored; auto-added to `.gitignore` |
| `policySettings` | managed (MDM/file/remote) | First source wins; exclusive control |

### Key exports

- `getInitialSettings()` — returns merged `SettingsJson` (always at least
  `{}`). The main entrypoint.
- `getSettingsWithErrors()` — session-cached, returns `{ settings, errors }`.
- `getSettingsForSource(source)` — per-source cached. For `policySettings`:
  remote (`getRemoteManagedSettingsSyncFromCache`) > MDM/HKLM/plist
  (`getMdmSettings`) > file (`loadManagedFileSettings`) > HKCU
  (`getHkcuSettings`).
- `loadManagedFileSettings()` — merges `managed-settings.json` (base) then
  `managed-settings.d/*.json` drop-ins alphabetically (later wins).
- `parseSettingsFile(path)` — cached parse with `SettingsSchema().safeParse`;
  `filterInvalidPermissionRules` runs before schema validation.
- `updateSettingsForSource(source, settings)` — `mergeWith` (lodash) with
  `settingsMergeCustomizer`; arrays are concatenated+deduped (`mergeArrays`);
  `undefined` = delete key. Writes via `writeFileSyncAndFlush_DEPRECATED`
  then `resetSettingsCache()`.
- `getSettingsWithSources()` — resets cache, returns `{ effective, sources[] }`
  ordered low → high.
- `getPolicySettingsOrigin()` — `'remote'|'plist'|'hklm'|'file'|'hkcu'|null`.

### Trusted-source hardening

Project settings are excluded for RCE hardening (untrusted repos). Helpers:
`hasSkipDangerousModePermissionPrompt`, `hasAutoModeOptIn`,
`hasAutoModeOptInDismissed`, `getUseAutoModeDuringPlan`, `getAutoModeConfig`,
`isAutoModeClassifyAllShellEnabled` (all gated on
`feature('TRANSCRIPT_CLASSIFIER')`).

### Version gate

`getRequiredVersionError({currentVersion, topLevelCommand})` — startup
version gate (2.1.163). `VERSION_GATE_SKIP_COMMANDS = {'update','install',
'doctor'}`.

## Managed paths — `src/utils/settings/managedPath.ts`

| Platform | Path |
|---|---|
| macOS | `/Library/Application Support/ClaudeCode` |
| Windows | `C:\Program Files\ClaudeCode` |
| default (Linux) | `/etc/claude-code` |

Ant override via `CLAUDE_CODE_MANAGED_SETTINGS_PATH`. Drop-in dir:
`<managedPath>/managed-settings.d`.

## Settings schema — `src/utils/settings/types.ts`

Zod `SettingsSchema()` fields include:

- `permissions` — `defaultMode`, `disableBypassPermissionsMode`,
  `disableAutoMode` (when `TRANSCRIPT_CLASSIFIER`), `additionalDirectories`.
- `env` — `EnvironmentVariablesSchema`.
- `apiKeyHelper`, `cleanupPeriodDays`, `model`, `availableModels`
  (enterprise allowlist), `modelOverrides`.
- `hooks` — `HooksSchema` (see [hooks.md](./hooks.md)).
- `skillOverrides`, `disableBundledSkills`, `enforceAvailableModels`,
  `disableAgentView`, `requiredMinimumVersion` / `requiredMaximumVersion`.
- `dynamicWorkflowSize` — advisory workflow-size hint (`small` | `medium` |
  `large`, default `medium`), surfaced in the WorkflowTool description and
  editable via `/config` (2.1.204). Advisory, not a cap.
- XAA-gated fields (when `CLAUDE_CODE_ENABLE_XAA`).

### Validation

`validation.ts` — `formatZodError`, `validateSettingsFileContent`,
`filterInvalidPermissionRules`. `validationTips.ts` —
`getValidationTip(context)`.

### MDM — `src/utils/settings/mdm/`

`rawRead.ts` fires `plutil` (macOS) / `reg query` (Windows) subprocesses;
`startMdmRawRead` is a top-level side-effect in `main.tsx`. `settings.ts` —
`getMdmSettings`, `getHkcuSettings`, `ensureMdmSettingsLoaded`.

## Feature flags — `src/utils/featureFlags.ts`

```ts
const FEATURE_ALLOWLIST: Set<string> = new Set([
  'TRANSCRIPT_CLASSIFIER',
  'BASH_CLASSIFIER',
  'MONITOR_TOOL',
  'WORKFLOW_SCRIPTS',
  'EXPERIMENTAL_SKILL_SEARCH',
  'MCP_SKILLS',
])
export const feature = (name: string): boolean => FEATURE_ALLOWLIST.has(name)
```

In the official Claude Code build, `feature()` comes from `bun:bundle`
(build-time). In OCC, it's a runtime `Set.has()`. Most flags stay OFF (they
gate subsystems OCC deliberately trims: `PROACTIVE`, `KAIROS`, `UDS_INBOX`,
`COORDINATOR_MODE`, `QUICK_SEARCH`, `TERMINAL_PANEL`, `HISTORY_SNIP`,
`CONTEXT_COLLAPSE`, `REACTIVE_COMPACT`, `TOKEN_BUDGET`, `VOICE_MODE`, etc.).

Two allowlists must stay in sync (see [build-and-runtime.md](./build-and-runtime.md)):

| Location | When | Flags |
|---|---|---|
| `src/utils/featureFlags.ts` | dev (`bun run dev`) | 6 flags (the full live set) |
| `scripts/build.ts` | build (`bun run build`) | 2 flags (classifiers only) |

## Environment variables

Key env vars (sampled across `envUtils.ts`, `auth.ts`, `api.ts`, `model.ts`,
`context.ts`, `settings.ts`):

### Auth & API
- `ANTHROPIC_API_KEY` — primary API key (hermetic in `--bare`).
- `ANTHROPIC_AUTH_TOKEN` — bearer token auth.
- `ANTHROPIC_BASE_URL` — API endpoint override.

Login flow (2.1.204 catchup): the printed sign-in URL is wrapped in an OSC-8
terminal hyperlink (clickable in supporting terminals; gated by
`src/ink/supports-hyperlinks.ts`), and `--no-browser` skips auto-opening the
browser (#9). OAuth login expiry is surfaced proactively —
`src/components/PromptInput/OAuthExpiryNotice.tsx` posts a high-priority
`oauth-expiry` notification before the refresh token expires; the refresh-token
expiry is captured at login time in `src/services/oauth` (#20).

### Provider selection (`getAPIProvider()`)
- `CLAUDE_CODE_USE_BEDROCK` → Bedrock.
- `CLAUDE_CODE_USE_VERTEX` → Vertex.
- `CLAUDE_CODE_USE_FOUNDRY` → Azure Foundry.
- `CLAUDE_CODE_USE_ANTHROPIC_AWS` → Anthropic-on-AWS.
- `CLAUDE_CODE_USE_MANTLE` → Bedrock Mantle.

### Model
- `ANTHROPIC_MODEL` — model override (priority 3).
- `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` /
  `ANTHROPIC_DEFAULT_FABLE_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

### Behavior toggles
- `CLAUDE_CODE_SIMPLE` / `--bare` — lean system prompt.
- `CLAUDE_CODE_SAFE_MODE` / `--safe-mode` — disables bundled skills, etc.
- `CLAUDE_CODE_REMOTE` — CCR/remote mode (skips git status, raises heap).
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS` — hard-off CLAUDE.md loading.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.
- `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`.
- `CLAUDE_CODE_DISABLE_AGENT_VIEW`.
- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` — `--add-dir` CLAUDE.md.
- `CLAUDE_CODE_MANAGED_SETTINGS_PATH` — managed settings override.
- `CLAUDE_CODE_ENABLE_XAA`.
- `USER_TYPE` — `'ant'` gates ant-only branches (DCE'd in external builds).

### Tuning
- `MCP_TIMEOUT` — MCP connection timeout (default 30000ms).
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — shrink the effective context window.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — testing.
- `API_FORCE_IDLE_TIMEOUT` — Vertex/Foundry stalled-stream workaround.

## Model configuration — `src/utils/model/model.ts` (762 lines)

Model resolution priority (`getUserSpecifiedModelSetting` docstring):

1. `/model` session override (`getMainLoopModelOverride`).
2. `--model` flag.
3. `ANTHROPIC_MODEL` env.
4. `settings.model`.
5. Built-in default.

Key exports: `getMainLoopModel`, `getBestModel`, `getDefaultOpusModel` /
`getDefaultSonnetModel` / `getDefaultFableModel` / `getDefaultHaikuModel`
(3P lags firstParty — opus48/sonnet5/fable5 first-party, opus46/sonnet45/
haiku45 on 3P), `getRuntimeMainLoopModel`, `parseUserSpecifiedModel`,
`normalizeModelStringForAPI`, `getCanonicalName`,
`getMarketingNameForModel`. `FRONTIER_MODEL_NAME = 'Claude Opus 4.6'`.
`availableModels` allowlist filter via `isModelAllowed`.

## Provider selection — `src/utils/model/providers.ts`

`APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' |
'anthropic_aws' | 'mantle' | 'gateway'`. `getAPIProvider()` env-var priority
chain (see [streaming.md](./streaming.md) for the client factory).

## Effort levels

`/effort` sets the reasoning effort: `low` / `medium` / `high` / `max` /
`auto` / `ultracode`. `ultracode` is the max-reasoning level with a badge +
keyword trigger (`src/utils/effort/ultracode.ts`). Effort maps to the API
`output_config.effort` param via `configureEffortParams` in `claude.ts`.

## Key files

| File | Role |
|---|---|
| `src/utils/settings/settings.ts` | `getInitialSettings`, 3-tier merge, `updateSettingsForSource` |
| `src/utils/settings/types.ts` | `SettingsSchema()` (Zod) |
| `src/utils/settings/managedPath.ts` | Managed settings paths per platform |
| `src/utils/settings/validation.ts` | `validateSettingsFileContent`, `filterInvalidPermissionRules` |
| `src/utils/settings/validationTips.ts` | `getValidationTip` |
| `src/utils/settings/mdm/` | MDM/HKLM/plist raw read |
| `src/utils/featureFlags.ts` | `FEATURE_ALLOWLIST`, `feature()` |
| `src/utils/model/model.ts` | Model resolution, defaults |
| `src/utils/model/providers.ts` | `getAPIProvider()` |
| `src/utils/effort/` | Effort levels (leanPrompt, ultracode) |
| `src/utils/env.ts` (envUtils) | Env var helpers |

## How it differs from Claude Code

OCC's configuration is functionally aligned with Claude Code's. The key
differences:

1. **No Statsig** — feature gating that Claude Code routes through Statsig is
   handled by `feature()` against the `FEATURE_ALLOWLIST` + env vars
   (`AUTO_MODE_ENABLED_DEFAULT`, `modelSupportsAutoMode`).
2. **Azure Foundry** — OCC adds `foundry` as a first-class provider.
3. **Analytics stubbed** — GrowthBook/Sentry/analytics are empty
   implementations; feature gates that would use them are inert.
4. **Build allowlist is minimal** — the bundle keeps only the two classifier
   flags; the dev allowlist has six. This mirrors the official external build
   which includes auto-mode code and gates it at runtime.
