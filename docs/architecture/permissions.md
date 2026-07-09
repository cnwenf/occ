# Permission Model

OCC gates every tool call behind a layered permission system: rule matching,
tool-specific checks, safety guards, an AI classifier (auto mode), and a
user-facing prompt. This document covers the modes, the rule pipeline, the
auto-mode classifier, and destructive-pattern blocking.

## Permission modes — `src/types/permissions.ts` + `PermissionMode.ts`

`EXTERNAL_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions',
'default', 'dontAsk', 'plan']`. `auto` is only valid when
`feature('TRANSCRIPT_CLASSIFIER')` is true (live in OCC). `'manual'` is
accepted as an input alias for `'default'` (`PERMISSION_MODE_MANUAL_ALIAS`).

`PERMISSION_MODE_CONFIG` maps each mode to `{ title, shortTitle, symbol,
color, external }`:

| Mode | Title | Symbol | Behavior |
|---|---|---|---|
| `default` | "Manual" | — | Prompts for manual approval |
| `plan` | "Plan Mode" | `PAUSE_ICON` | Read-only; no edits |
| `acceptEdits` | "Accept edits" | `⏵⏵` | Auto-approves edits |
| `bypassPermissions` | "Bypass Permissions" | `⏵⏵` (error color) | Skips all checks (if available) |
| `dontAsk` | "Don't Ask" | — | Converts `ask` to `deny` |
| `auto` | "Auto mode" | — | AI classifier decides (live via `TRANSCRIPT_CLASSIFIER`) |

`bubble` is an internal-only mode. Helpers: `permissionModeFromString`,
`permissionModeTitle`, `isExternalPermissionMode`, `toExternalPermissionMode`,
`getModeColor`, `permissionModeSymbol`.

`default` ("Manual") historically rendered no footer symbol (its config symbol
is `—`); as of 2.1.203 the footer (`PromptInputFooterLeftSide.tsx`) shows a
grey `⏸` badge for manual mode too, so the mode line is always visible (#21).

## Permission rules

`PermissionRule = { source, ruleBehavior, ruleValue }` (`src/types/permissions.ts`).

- `PermissionBehavior = 'allow' | 'deny' | 'ask'`.
- `PermissionRuleValue = { toolName: string, ruleContent?: string }`.
- `PermissionRuleSource = 'userSettings' | 'projectSettings' | 'localSettings'
  | 'flagSettings' | 'policySettings' | 'cliArg' | 'command' | 'session'`.

### Rule syntax — `permissionRuleParser.ts`

Rule strings use the form `ToolName` or `ToolName(content)`:

- `Bash(npm install)` → `{ toolName: 'Bash', ruleContent: 'npm install' }`.
- `Bash(*)` / `Bash()` → tool-wide.
- Escaped parens: `Bash\(escaped\)`.
- `Tool(param:value)` (2.1.178+) — e.g. `Agent(model:opus)`.
- `normalizeLegacyToolName` maps `Task→Agent`, `KillShell→TaskStop`,
  `AgentOutputTool/BashOutputTool→TaskOutput`.

### Rule loading — `permissionsLoader.ts`

- `loadAllPermissionRulesFromDisk()` — if
  `shouldAllowManagedPermissionRulesOnly()` (policy), only loads policy;
  else iterates `getEnabledSettingSources()`.
- `getPermissionRulesForSource(source)` — reads
  `permissions.allow/deny/ask` arrays from settings JSON.
- Sources: `userSettings` (`~/.claude/settings.json`), `projectSettings`
  (`.claude/settings.json`), `localSettings` (`.claude/settings.local.json`),
  `policySettings` (managed).

`permissionSetup.ts` (~54KB) assembles the `ToolPermissionContext` from these.

## `ToolPermissionContext` — `src/Tool.ts` (line 123)

```ts
type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource  // stripped at auto entry
  shouldAvoidPermissionPrompts?: boolean                 // background agents
  awaitAutomatedChecksBeforeDialog?: boolean             // coordinator workers
  prePlanMode?: PermissionMode
}>
```

## The main pipeline — `hasPermissionsToUseTool` (`permissions.ts` line 482)

The public `CanUseToolFn`. Calls `hasPermissionsToUseToolInner` (line 1190)
then post-processes.

### `hasPermissionsToUseToolInner` (rule-matching pipeline)

1. **Deny rule** (`getDenyRuleForTool`) →
   `{behavior:'deny', decisionReason:{type:'rule', rule}}`.
2. **Ask rule** (`getAskRuleForTool`) → return ask, unless `canSandboxAutoAllow`
   (Bash + sandboxing enabled + `shouldUseSandbox`) falls through.
3. **Tool-specific check** — `tool.checkPermissions(parsedInput, context)`.
4. **Tool denied** → return deny.
5. **`requiresUserInteraction()` + ask** → return ask.
6. **Content-specific ask rule** → return ask (bypass-immune).
7. **Safety checks** (`.git/`, `.claude/`, shell configs) → bypass-immune
   unless `--dangerously-skip-protected-paths`.
8. **Mode bypass** — `bypassPermissions` or `plan` +
   `isBypassPermissionsModeAvailable` → allow.
9. **Always-allow rule** (`toolAlwaysAllowedRule`) → allow.
10. **Convert `passthrough` → `ask`**.

### `hasPermissionsToUseTool` post-processing

- On `allow`: reset consecutive denials in auto mode (`recordSuccess`).
- On `ask` in `dontAsk` mode → convert to `deny`.
- On `ask` in `auto` mode (or plan+auto active):
  - Non-classifier-approvable `safetyCheck` → deny if
    `shouldAvoidPermissionPrompts`, else return as-is.
  - `requiresUserInteraction()` → return as-is.
  - PowerShell without `POWERSHELL_AUTO_MODE` → skip classifier.
  - **acceptEdits fast-path**: re-run `tool.checkPermissions` with mode forced
    to `acceptEdits`; if allow → skip classifier. Skipped for Agent/REPL.
  - **Safe-tool allowlist** (`isAutoModeAllowlistedTool`) → allow.
  - **Run classifier** (`classifyYoloAction`).

`checkRuleBasedPermissions` (line 1098) is a standalone rule-check used by
the SDK `canUseTool`: steps 1a, 1b, 1c, 1d, 1f, 1g — returns `null` if no
objection.

## Auto-mode classifier — `classifierDecision.ts` + `yoloClassifier.ts`

The "YOLO"/auto-mode LLM classifier decides allow/deny for tool calls that
reach `ask` in `auto` mode.

### `classifierDecision.ts`

`isAutoModeAllowlistedTool(toolName)` checks `getSafeYoloAllowlistedTools()`
— read-only/search tools (FileRead, Grep, Glob, LSP, ToolSearch,
ListMcpResources, ReadMcpResource, `get_page_text`, `screenshot`), task
metadata (TodoWrite, TaskCreate/Get/Update/List/Stop/Output), plan/UI
(AskUserQuestion, EnterPlanMode, ExitPlanMode), swarm (TeamCreate/Delete,
SendMessage), Sleep, plus `YOLO_CLASSIFIER_TOOL_NAME`.

### `yoloClassifier.ts`

- `AutoModeRules = { allow, soft_deny, hard_deny, environment }`.
- `getDefaultExternalAutoModeRules()` — parses `<user_*_to_replace>` tags from
  an external permissions template.
- `YOLO_CLASSIFIER_TOOL_NAME = 'classify_result'` — the custom tool the
  classifier LLM calls to return its decision.
- `CLASSIFIER_CATEGORIES = ['behavioral_risk', 'information_exposure',
  'high_impact_operation']` (2.1.200) — the denial taxonomy.
- `buildClassifierDenialReason(category, reason)` — prefixes
  `[category] Blocked by auto-mode classifier: ...`.
- **`classifyYoloAction(messages, action, tools, context, signal)`** — main
  entry. Builds a compact action rep (`formatActionForClassifier`), serializes
  transcript, constructs user content blocks with `cache_control`, dispatches
  to a 2-stage XML classifier (`classifyYoloActionXml`) if
  `isTwoStageClassifierEnabled()`, else single-stage with thinking config.
- `YoloClassifierResult` — `{ shouldBlock, reason, category?, unavailable?,
  transcriptTooLong?, model, usage?, durationMs?, stage? }`.

### `bashClassifier.ts`

A **stub for external builds**. `isClassifierPermissionsEnabled() → false`,
`classifyBashCommand(...) → { matches: false, confidence: 'high', reason:
'This feature is disabled' }`. The real bash-command classifier is ant-only.
Live auto-mode uses the LLM-based `yoloClassifier` instead, gated by
`TRANSCRIPT_CLASSIFIER` + `BASH_CLASSIFIER`.

## Dangerous patterns — `dangerousPatterns.ts`

`DANGEROUS_BASH_PATTERNS` lists allow-rule prefixes that let the model run
arbitrary code. These are **stripped at auto-mode entry** so the classifier
re-evaluates them:

- `CROSS_PLATFORM_CODE_EXEC`: `python`, `python3`, `node`, `deno`, `tsx`,
  `ruby`, `perl`, `php`, `lua`, `npx`, `bunx`, `npm run`, `yarn run`,
  `pnpm run`, `bun run`, `bash`, `sh`, `ssh`.
- Plus: `zsh`, `fish`, `eval`, `exec`, `env`, `xargs`, `sudo`.
- Ant-only additions: `gh`, `curl`, `wget`, `git`, `kubectl`, `aws`, `gcloud`,
  `gsutil`.

`isDangerousBashPermission` / `isDangerousPowerShellPermission` (in
`permissionSetup.ts`) strip such rules at auto-mode entry.

## Other permission modules

| File | Role |
|---|---|
| `permissions.ts` | `hasPermissionsToUseTool`, `checkRuleBasedPermissions`, rule getters |
| `PermissionMode.ts` | Mode config, `PERMISSION_MODE_CONFIG` |
| `permissionRuleParser.ts` | Rule string syntax, `permissionRuleValueFromString` |
| `permissionsLoader.ts` | `loadAllPermissionRulesFromDisk`, per-source loading |
| `classifierDecision.ts` | `isAutoModeAllowlistedTool`, safe-tool allowlist |
| `yoloClassifier.ts` | `classifyYoloAction` — the LLM classifier |
| `bashClassifier.ts` | Bash-command classifier (stub in external builds) |
| `dangerousPatterns.ts` | `DANGEROUS_BASH_PATTERNS` — stripped at auto entry |
| `permissionSetup.ts` | Assembles `ToolPermissionContext`, dangerous-rule stripping |
| `permissionExplainer.ts` | Human-readable rule explanations |
| `pathValidation.ts` | Path validation for filesystem tools |
| `filesystem.ts` | Filesystem permission helpers |
| `getNextPermissionMode.ts` | Mode cycling logic |
| `autoModeState.ts` | Auto-mode runtime state |
| `shadowedRuleDetection.ts` | Detects rules shadowed by higher-priority rules |
| `denialTracking.ts` | Tracks consecutive denials for fallback-to-prompting |
| `subagentSpawnClassifier.ts` | Classifier for subagent spawn permissions |

## How it differs from Claude Code

OCC's permission model is functionally aligned with Claude Code's. The key
difference is runtime gating: Claude Code gates the auto-mode classifier via
Statsig; OCC has no Statsig, so `feature('TRANSCRIPT_CLASSIFIER')` (in the
`FEATURE_ALLOWLIST`) plus `AUTO_MODE_ENABLED_DEFAULT` +
`modelSupportsAutoMode` handle runtime gating. The `bashClassifier` (a
separate heuristic classifier) is a stub in OCC — only the LLM-based
`yoloClassifier` is live.
