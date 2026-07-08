# Settings

OCC is configured through `settings.json` files, environment variables, and CLI flags. Settings are merged from multiple sources with a defined precedence.

## Settings files

Settings are loaded from five sources, merged low→high priority (later overrides earlier):

| Source | File | Editable | Purpose |
|---|---|---|---|
| `userSettings` | `~/.claude/settings.json` | yes | Your personal defaults |
| `projectSettings` | `<project>/.claude/settings.json` | yes | Shared, checked into VCS |
| `localSettings` | `<project>/.claude/settings.local.json` | yes | Private, gitignored |
| `flagSettings` | `--settings <file>` / inline | read-only | Per-session override |
| `policySettings` | `managed-settings.json` + MDM | read-only | Enterprise policy |

Policy source precedence ("first source wins"): remote > HKLM/macOS plist > `managed-settings.json` + drop-ins > HKCU. Override the managed path with `CLAUDE_CODE_MANAGED_SETTINGS_PATH`.

Use `--setting-sources user,project,local` to restrict which sources load. `localSettings` is automatically added to `.gitignore`.

A separate runtime/UI-state file, `~/.claude.json` (`GlobalConfig`), holds UI preferences like `theme`, `verbose`, `editorMode`, `autoCompactEnabled`, `diffTool`, and per-project `allowedTools`/`hasTrustDialogAccepted`.

## settings.json schema

The schema is at `https://json.schemastore.org/claude-code-settings.json`. Key fields grouped by domain:

### Model

| Key | Type | Description |
|---|---|---|
| `model` | string | Default model (alias or full ID) |
| `availableModels` | string[] | Enterprise allowlist (accepts family aliases, version prefixes, full IDs) |
| `enforceAvailableModels` | boolean | Constrain default model to `availableModels` |
| `modelOverrides` | Record<string,string> | Anthropic model ID → provider-specific ID (e.g. Bedrock ARN) |
| `fallbackModel` | string \| string[] | Tried in order when primary is overloaded (max 3) |
| `effortLevel` | `low` \| `medium` \| `high` \| `max` | Reasoning effort |
| `alwaysThinkingEnabled` | boolean | `false` disables thinking |
| `showThinkingSummaries` | boolean | Show thinking summaries (default false) |
| `fastMode` | boolean | Enable fast mode |

### Permissions

```json
{
  "permissions": {
    "allow": ["Bash(npm install:*)"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["WebFetch(domain:example.com)"],
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable",
    "additionalDirectories": ["../other-repo"]
  }
}
```

See [Permissions](./permissions.md) for rule syntax and modes.

### Hooks

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }]
  },
  "disableAllHooks": false,
  "allowManagedHooksOnly": false
}
```

See [Hooks](./hooks.md) for the full hook system.

### Environment

```json
{
  "env": { "MY_VAR": "value" },
  "cleanupPeriodDays": 30,
  "respectGitignore": true
}
```

`env` sets environment variables for all OCC sessions.

### UI / display

| Key | Description |
|---|---|
| `outputStyle` | Output style string |
| `language` | UI language |
| `syntaxHighlightingDisabled` | Disable syntax highlighting |
| `autoScrollEnabled` | Auto-scroll to bottom |
| `tui` | `default` \| `fullscreen` |
| `viewMode` | `default` \| `verbose` \| `focus` |
| `wheelScrollAccelerationEnabled` | Mouse wheel scroll acceleration |
| `spinnerTipsEnabled` / `spinnerVerbs` | Spinner configuration |

### Status line

```json
{
  "statusLine": {
    "type": "command",
    "command": "echo 'OCC'",
    "padding": 0,
    "refreshInterval": 100
  }
}
```

### Worktree

```json
{
  "worktree": {
    "baseRef": "fresh",
    "bgIsolation": "worktree",
    "symlinkDirectories": ["node_modules"]
  }
}
```

### Memory

| Key | Description |
|---|---|
| `autoMemoryEnabled` | Enable auto-memory (default true) |
| `autoMemoryDirectory` | Override the memory directory (trusted sources only) |
| `claudeMdExcludes` | Glob patterns to exclude CLAUDE.md files |

See [Memory](./memory.md).

### MCP

| Key | Description |
|---|---|
| `enableAllProjectMcpServers` | Auto-approve all `.mcp.json` servers |
| `enabledMcpjsonServers` / `disabledMcpjsonServers` | Per-server enable/disable |
| `allowedMcpServers` / `deniedMcpServers` | Server allow/deny lists |
| `allowManagedMcpServersOnly` | Only managed MCP servers |

### Skills

| Key | Description |
|---|---|
| `skillOverrides` | Per-skill `on` / `name-only` / `user-invocable-only` / `off` |
| `disableBundledSkills` | Disable bundled skills |
| `disableSkillShellExecution` | Disable `!` shell blocks in skills |

### Attribution

| Key | Description |
|---|---|
| `attribution` | `{ commit?, pr?, sessionUrl? }` |
| `includeCoAuthoredBy` | (deprecated) Add Co-Authored-By to commits |
| `includeGitInstructions` | Include git instructions (default true) |

### Version gating

| Key | Description |
|---|---|
| `requiredMinimumVersion` / `requiredMaximumVersion` | Enforce version bounds |
| `autoUpdatesChannel` | `latest` \| `stable` |

## Environment variables

OCC reads many environment variables. The most important:

### API keys & auth

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic direct API key |
| `ANTHROPIC_AUTH_TOKEN` | Alternate auth token |
| `ANTHROPIC_BASE_URL` | Override the API base URL |
| `ANTHROPIC_CUSTOM_HEADERS` | Custom headers for API requests |
| `ANTHROPIC_BETAS` | Beta headers (API key users) |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (subscription auth) |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | OAuth refresh token |

### Provider selection

| Variable | Provider |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | Google Vertex |
| `CLAUDE_CODE_USE_FOUNDRY` | Azure Foundry |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | Claude Platform on AWS |
| `CLAUDE_CODE_USE_MANTLE` | Bedrock Mantle |

Skip-auth vars (`CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `CLAUDE_CODE_SKIP_VERTEX_AUTH`, `CLAUDE_CODE_SKIP_FOUNDRY_AUTH`, `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH`, `CLAUDE_CODE_SKIP_MANTLE_AUTH`) bypass credential checks when using a proxy.

### Bedrock / Vertex / Foundry specifics

| Variable | Purpose |
|---|---|
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Bedrock region |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock bearer token |
| `ANTHROPIC_VERTEX_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` | Vertex project |
| `CLOUD_ML_REGION` | Vertex region |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API key |
| `ANTHROPIC_FOUNDRY_BASE_URL` / `ANTHROPIC_FOUNDRY_RESOURCE` | Foundry config |
| `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_BASE_URL` | Anthropic-on-AWS config |

### Model selection

| Variable | Purpose |
|---|---|
| `ANTHROPIC_MODEL` | Override the default model |
| `ANTHROPIC_SMALL_FAST_MODEL` | Override the small/fast model |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Subagent model |
| `CLAUDE_CODE_AUTO_MODE_MODEL` | Auto-mode classifier model |
| `MAX_THINKING_TOKENS` | Max thinking tokens |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Max output tokens |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Max context tokens |
| `CLAUDE_CODE_DISABLE_THINKING` | Disable thinking |
| `CLAUDE_CODE_EFFORT_LEVEL` | Effort level override |

### Config & paths

| Variable | Purpose |
|---|---|
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` |
| `CLAUDE_CODE_TMPDIR` | Temp directory |
| `CLAUDE_CODE_DEBUG_LOGS_DIR` | Debug log directory |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH` | Managed settings path |

### Disable features

| Variable | Disables |
|---|---|
| `DISABLE_AUTOUPDATER` / `DISABLE_UPDATES` | Auto-updater / all updates |
| `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT` | Auto-compaction / `/compact` |
| `DISABLE_COST_WARNINGS` | Cost warnings |
| `DISABLE_ERROR_REPORTING` | Error reporting |
| `DISABLE_TELEMETRY` | Telemetry |
| `DISABLE_BUG_COMMAND` / `DISABLE_DOCTOR_COMMAND` | `/feedback` / `/doctor` |
| `DISABLE_LOGIN_COMMAND` / `DISABLE_LOGOUT_COMMAND` | `/login` / `/logout` |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | CLAUDE.md auto-discovery |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | Bundled skills |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Background tasks |
| `CLAUDE_CODE_WORKFLOWS_DISABLED` | Workflows |

### Enable features

| Variable | Enables |
|---|---|
| `CLAUDE_CODE_ENABLE_AUTO_MODE` | Auto (AI-classified) permission mode |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Telemetry |
| `CLAUDE_CODE_ENABLE_TASKS` | Task list (TodoWrite v2) |
| `ENABLE_LSP_TOOL` | LSP tool |

### Permission & safety

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_SANDBOXED` | Mark session as sandboxed (skips trust dialog) |
| `CLAUDE_CODE_SKIP_PROTECTED_PATHS` | Skip protected-path prompts |
| `CLAUDE_CODE_SAFE_MODE` | Safe mode (disable plugins/skills/hooks) |
| `CLAUDE_CODE_SIMPLE` | Bare/minimal mode |

### Bash & shell

| Variable | Purpose |
|---|---|
| `BASH_MAX_OUTPUT_LENGTH` | Max bash output length |
| `CLAUDE_CODE_SHELL` | Shell (`bash` / `powershell`) |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | Use PowerShell tool on Windows |

## Related

- [Permissions](./permissions.md) — the `permissions` and `sandbox` keys
- [Memory](./memory.md) — `autoMemoryEnabled`, `claudeMdExcludes`
- [Hooks](./hooks.md) — the `hooks` key
- [CLI Reference](./cli-reference.md) — `--settings`, `--setting-sources`
