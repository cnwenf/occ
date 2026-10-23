/**
 * Shared utilities for spawning teammates across different backends.
 */

import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { parseToolListFromCLI } from '../permissions/permissionSetup.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * Gets the command to use for spawning teammate processes.
 * Uses TEAMMATE_COMMAND_ENV_VAR if set, otherwise falls back to the
 * current process executable path.
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * claude-code 2.1.309 (item 21): split-pane/separate-window agent teammates
 * did not inherit the tool-deny rules and `--tools` narrowing given on the
 * leader's command line (the in-process spawn path already inherits them).
 * The official fix lives in the teammate flag builder `te()`
 * (BIN309 @273,053,200), which replays:
 *   - each `alwaysDenyRules.cliArg` rule as `O("--disallowed-tools", rule)`,
 *     guarded by an `fu([rule])` round-trip check (unreplayable rule → throw
 *     "A command-line deny rule cannot be handed to a teammate intact, so the
 *     teammate would not enforce it — spawn aborted"),
 *   - each `typedToolFlags.tools` value as `O("--tools", aMn([r]) ? Cio(r) : r)`
 *     (`self_hosted_runner_*` entries are stripped from the replayed value).
 * Helper offsets: `O` @273,051,048 (space form when `dne(value)`, else `=`
 * form; both shell-quoted), `dne` @248,817,523
 * (`!/^-|^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(v) && !v.includes("\0")`),
 * `fu` @239,835,387 (≡ OCC `parseToolListFromCLI`), `aMn`/`Cio`/`e9t`
 * @254,394,700, `Nqt` (flag-token test) = `e.length>1&&e.startsWith("-")`.
 *
 * Declared structural deviations (official symbol → OCC name):
 *   - `y.alwaysDenyRules.cliArg` / `bLt().typedToolFlags.tools` (parsed CLI
 *     state) → derived from `process.argv` at spawn time. bootstrap/state.ts
 *     carries no tool-flag getters and is outside this work package's file
 *     budget; argv is the literal "leader's command line" the changelog names.
 *     The teammate's own initializeToolPermissionContext recomputes the
 *     `--tools`-complement and PowerShell deny additions, so the effective
 *     deny set converges with the official.
 *   - Official `R(long, short)` two-message error → plain `Error(long)`;
 *     the `m("subagent_launch","subagent_teammate_deny_unreplayable")`
 *     telemetry call has no OCC surface (analytics is an empty impl).
 *   - Official dedupe set `new Set(d3())` is empty in the shipped binary
 *     (`d3(){return[]}` @250,218,430) → OCC replays every rule (identical).
 */

/** Official `Nqt`: an argv token that starts a new flag. */
function isFlagToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-')
}

/** Official `dne` (BIN309 @248,817,523): value safe to replay in space form. */
function isSpaceFormFlagValue(value: string): boolean {
  return (
    !/^-|^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(value) && !value.includes('\0')
  )
}

/** Official `O` (BIN309 @273,051,048): `name value` or `name=value`, quoted. */
function emitInheritedFlag(name: string, value: string): string {
  return isSpaceFormFlagValue(value)
    ? `${name} ${quote([value])}`
    : `${name}=${quote([value])}`
}

/** Official `e9t` prefix (BIN309 @254,394,700). */
const SELF_HOSTED_RUNNER_PREFIX = 'self_hosted_runner_'

/**
 * Collects the raw values of variadic CLI flags from argv (commander
 * `<tools...>` semantics: space-separated values until the next flag token;
 * `--flag=value` form supported; a bare `--` ends flag parsing).
 */
function collectFlagValues(
  argv: readonly string[],
  names: readonly string[],
): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      break
    }
    for (const name of names) {
      if (token === name) {
        for (let j = i + 1; j < argv.length; j++) {
          const next = argv[j]!
          if (next === '--' || isFlagToken(next)) {
            break
          }
          values.push(next)
        }
      } else if (token.startsWith(`${name}=`)) {
        values.push(token.slice(name.length + 1))
      }
    }
  }
  return values
}

/**
 * Builds the inherited tool-deny / `--tools` flags for a spawned teammate
 * (official `te()` fragment, BIN309 @273,053,200). Deny rules first, then
 * `--tools` values — the official emission order.
 */
export function buildInheritedToolFlags(
  argv: readonly string[] = process.argv,
): string[] {
  const flags: string[] = []

  // Replay each command-line deny rule (official: `y.alwaysDenyRules.cliArg`).
  const denyValues = collectFlagValues(argv, [
    '--disallowedTools',
    '--disallowed-tools',
  ])
  for (const rule of parseToolListFromCLI(denyValues)) {
    // Official replay guard: the rule must survive an argv round-trip through
    // the same parser the teammate will run, or it would not be enforced.
    const replayed = parseToolListFromCLI([rule])
    if (replayed.length !== 1 || replayed[0] !== rule) {
      throw new Error(
        'A command-line deny rule cannot be handed to a teammate intact, so the teammate would not enforce it — spawn aborted',
      )
    }
    flags.push(emitInheritedFlag('--disallowed-tools', rule))
  }

  // Replay each --tools value, stripping self_hosted_runner_ entries
  // (official: `aMn([r]) ? Cio(r) : r`).
  for (const value of collectFlagValues(argv, ['--tools'])) {
    const parsed = parseToolListFromCLI([value])
    const replayed = parsed.some((tool) =>
      tool.startsWith(SELF_HOSTED_RUNNER_PREFIX),
    )
      ? parsed
          .filter((tool) => !tool.startsWith(SELF_HOSTED_RUNNER_PREFIX))
          .join(',')
      : value
    flags.push(emitInheritedFlag('--tools', replayed))
  }

  return flags
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  }

  // claude-code 2.1.309 (item 21): replay the leader's command-line tool deny
  // rules and --tools narrowing (official te() order: permission flags →
  // deny rules → --tools → --model).
  flags.push(...buildInheritedToolFlags())

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // API provider selection — without these, teammates default to firstParty
  // and send requests to the wrong endpoint (GitHub issue #23561)
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // CC 2.1.285 (item-B1): WebFetch kill-switch — forwarded to teammates so a
  // host that disables WebFetch keeps it disabled inside tmux-spawned
  // teammates. Official `re[]` list (@226996976) inserts it immediately before
  // ANTHROPIC_BASE_URL: `...[],"CLAUDE_CODE_DISABLE_WEB_FETCH","ANTHROPIC_BASE_URL",...`.
  'CLAUDE_CODE_DISABLE_WEB_FETCH',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  // Config directory override
  'CLAUDE_CONFIG_DIR',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.claude/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'CLAUDE_CODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any provider/config env vars that are set in the current process.
 */
export function buildInheritedEnvVars(): string {
  const envVars = ['CLAUDECODE=1', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1']

  for (const key of TEAMMATE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  return envVars.join(' ')
}
