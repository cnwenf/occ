# Permissions

OCC's permission model controls which tool actions require your approval. It supports several modes, rule-based allow/deny lists, destructive-command blocking, and an AI-classified auto mode.

## Permission modes

Set the mode with `--permission-mode <mode>`, the `permissions.defaultMode` setting, or cycle modes in the REPL with `Shift+Tab`.

| Mode | Behavior |
|---|---|
| `default` (alias `manual`) | Prompt for approval on actions that aren't explicitly allowed |
| `acceptEdits` | Auto-approve file edits in the working dir; still prompt for other tools |
| `auto` | AI classifier decides allow/block (requires `TRANSCRIPT_CLASSIFIER`, live in OCC) |
| `plan` | Read-only exploration and design; no edits until you approve the plan |
| `bypassPermissions` | Skip all prompts (use with `--dangerously-skip-permissions`) |
| `dontAsk` | Don't prompt; deny anything not explicitly allowed |

`plan` mode stashes your current mode and restores it after you exit plan mode (via the `ExitPlanMode` tool). `bypassPermissions` still respects deny rules, content-specific ask rules, and safety checks.

## Permission rules

Rules live in the `permissions` object of `settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npm install:*)", "Read(~/.zshrc)"],
    "deny":  ["Bash(rm -rf:*)"],
    "ask":   ["WebFetch(domain:example.com)"],
    "defaultMode": "default",
    "additionalDirectories": ["../other-repo"]
  }
}
```

- `allow` — auto-approve matching actions
- `deny` — always block (cannot be overridden by bypass mode)
- `ask` — always prompt, even in accept-edits/bypass modes
- `defaultMode` — the starting permission mode
- `additionalDirectories` — extra directories tools may access

### Rule syntax

A rule is `ToolName` or `ToolName(content)`:

| Rule | Matches |
|---|---|
| `Bash` | All Bash commands |
| `Bash(npm install)` | The exact command `npm install` |
| `Bash(npm install:*)` | Any `npm install ...` command (legacy wildcard) |
| `Bash(git:*)` | Any `git ...` command |
| `Read(~/.zshrc)` | Reading `~/.zshrc` |
| `Edit(src/**)` | Editing files under `src/` |
| `Agent(model:opus)` | Agent spawns with `model: opus` (`Tool(param:value)` syntax) |
| `WebFetch(domain:example.com)` | Fetches to `example.com` |
| `WebFetch(domain:*.google.com)` | Fetches to `*.google.com` |
| `mcp__server1` | All tools from MCP server `server1` |
| `mcp__server1__tool1` | A specific MCP tool |

Legacy aliases are normalized: `Task` → `Agent`, `KillShell` → `TaskStop`, `BashOutputTool` → `TaskOutput`.

### Rule sources

Rules are loaded from five sources, merged low→high priority (later overrides earlier):

| Source | File | Editable |
|---|---|---|
| `userSettings` | `~/.claude/settings.json` | yes |
| `projectSettings` | `<project>/.claude/settings.json` | yes (shared) |
| `localSettings` | `<project>/.claude/settings.local.json` | yes (gitignored) |
| `flagSettings` | `--settings <file>` | read-only |
| `policySettings` | `managed-settings.json` + MDM | read-only |

Plus runtime sources: `cliArg` (`--allowed-tools`/`--disallowed-tools`), `command`, `session`. Policy and flag sources are read-only — you can't delete rules from them.

Manage rules interactively with `/permissions` (alias `/allowed-tools`), or via CLI flags:

```bash
occ --allowed-tools "Bash(git:*) Edit" --disallowed-tools "Bash(rm:*)"
```

## Destructive operation blocking

OCC has multiple layers of protection against dangerous commands.

### Hard blocks (always denied)

These are hard-denied before any auto-allow or classifier, in all modes except `bypassPermissions`:

- `git push --force` / `git push --delete`
- `git reset --hard`
- `git clean -f` (not `-n`/`--dry-run`)
- `git commit --amend` (auto mode only)
- `terraform destroy` / `tofu destroy` / `pulumi destroy` / `cdk destroy`
- `rm -rf` targeting `/`, `~`, or `$HOME` (not `/tmp/foo` or `~/Documents`)
- `dd ... of=/dev/sd*|nvme|disk|hd|vd|xvd|mmcblk` (writing to raw block devices)
- `mkfs` / `mkfs.ext4` etc.

### Informational warnings

These decorate the permission dialog but don't block: `git_reset_hard`, `git_force_push`, `git_clean_force`, `git_checkout_dot`, `git_stash_drop`, `git_branch_force_delete`, `git_no_verify`, `rm_recursive_force`, `sql_drop_truncate`, `sql_delete_from`, `kubectl_delete`, `terraform_destroy`, and more.

### Safety checks (bypass-immune)

Writes to protected paths — `.claude/`, `.git/`, `.vscode/`, shell configs — always prompt, **even in `bypassPermissions` mode**. This is because `.claude/settings.json` is attacker-controllable. Use `--dangerously-skip-protected-paths` (or `CLAUDE_CODE_SKIP_PROTECTED_PATHS`) to auto-allow them — only in sandboxes you trust.

### Bash security validators

`src/tools/BashTool/bashSecurity.ts` detects command-substitution injection (`$()`, backticks, `<()`, `${}`), `IFS` injection, `/proc/*/environ` access, obfuscated flags (ANSI-C `$'...'`, locale `$"..."`), backslash-escaped operators, brace expansion obfuscation, Unicode whitespace tricks, comment-quote desync, and Zsh dangerous commands.

### Dangerous allow-rule stripping (auto mode)

On entering `auto` mode, OCC strips allow rules that would bypass the classifier — broad patterns like `Bash(*)`, `Bash(python:*)`, `Bash(node:*)`, interpreter/package-runner/shell rules, `eval`/`exec`/`env`/`xargs`/`sudo`, and any `Agent` allow rule. They're restored on exit.

## Auto mode (AI classifier)

Auto mode (`--permission-mode auto`, or `permissions.defaultMode: 'auto'`, or `CLAUDE_CODE_ENABLE_AUTO_MODE=1`) uses an AI classifier (`yoloClassifier.ts`) to decide allow/block per action. It's feature-flagged via `TRANSCRIPT_CLASSIFIER` (live in OCC).

- Fast-paths: acceptEdits-equivalent check and a safe-tool allowlist.
- Tracks consecutive and total denials (`DENIAL_LIMITS`); falls back to prompting after too many.
- Customizable via the `autoMode` setting: `allow`, `soft_deny`, `hard_deny`, `environment`, `classifyAllShell`.
- Inspect defaults with `occ auto-mode defaults`; inspect effective config with `occ auto-mode config`.

## Plan mode

Plan mode is read-only exploration and design. The model uses `EnterPlanMode` to request entry, then `ExitPlanMode` to present the plan for your approval. On approval, OCC restores your previous mode (or `default`).

- `useAutoModeDuringPlan` (default true) — plan mode uses auto-mode classifier semantics when opted in.
- Env vars: `CLAUDE_CODE_PLAN_MODE_REQUIRED`, `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE`, `CLAUDE_CODE_PLAN_V2_AGENT_COUNT`.

## Sandbox

Sandbox settings live under the `sandbox` key in `settings.json` (`src/entrypoints/sandboxTypes.ts`):

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": false,
    "autoAllowBashIfSandboxed": true,
    "network": { "allowedDomains": ["api.anthropic.com"] },
    "filesystem": { "allowWrite": ["./src"], "denyWrite": [".git"] }
  }
}
```

Key fields: `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `excludedCommands`, `network` (`allowedDomains`, `deniedDomains`, `allowUnixSockets`, `allowLocalBinding`, `httpProxyPort`, `socksProxyPort`), `filesystem` (`allowWrite`, `denyWrite`, `denyRead`, `allowRead` — merged with `Edit(...)`/`Read(...)` permission rules). `CLAUDE_CODE_SANDBOXED` marks a session as sandboxed (skips the trust dialog). Toggle with `/sandbox-toggle`.

## Approval UI

When a tool needs approval, OCC shows a permission dialog (`src/components/permissions/`). You can:

- Press `y`/`Enter` to allow once
- Press `n`/`Esc` to deny
- Choose "allow for this session" or "always allow" (persists a rule to settings)
- Press `Tab` to amend the tool input (e.g., edit a bash command before approving)
- Press `Ctrl+E` to toggle a risk explanation (generated by Haiku when `permissionExplainerEnabled` is on)
- Press `Ctrl+D` to toggle debug info

Per-tool request components exist for Bash, file edits/writes, notebook edits, web fetches, plan mode, skills, and more. File-edit approvals show a diff.

## Disabling bypass mode

`permissions.disableBypassPermissionsMode: 'disable'` in settings disables bypass mode. `skipDangerousModePermissionPrompt` (user/local/flag/policy only, not project — for RCE hardening) records that you accepted the bypass dialog.

## Related

- [Settings](./settings.md) — the `permissions` and `sandbox` config keys
- [CLI Reference](./cli-reference.md) — `--permission-mode`, `--allowed-tools`
- [Troubleshooting](./troubleshooting.md) — reducing permission prompts
