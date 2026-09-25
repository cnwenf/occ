import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// ---------------------------------------------------------------------------
// Official 2.1.277 env-assignment guard (binary `Avo` + helpers `asn`/`uSt`,
// byte-verified against the v277/v278 linux-x64 ELFs — the two versions are
// structurally identical, only minified symbol names differ).
// ---------------------------------------------------------------------------

/**
 * Official `nz` set (byte-verbatim, 39 entries): variable names that are safe
 * to recognize in a pure `VAR=value` assignment part. Distinct from
 * bashPermissions' SAFE_ENV_VARS (used for prefix stripping) — the official
 * binary keeps these as two separate sets with different membership.
 */
const SAFE_ASSIGNMENT_VAR_NAMES = new Set([
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
  'COLUMNS',
  'LINES',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'CI',
  'DEBIAN_FRONTEND',
  'GIT_TERMINAL_PROMPT',
])

/** Official `GEo` set: locale vars excluded from pure-assignment recognition. */
const LOCALE_ASSIGNMENT_VAR_NAMES = new Set([
  'LC_ALL',
  'LC_CTYPE',
  'LANG',
  'LANGUAGE',
  'CHARSET',
])

/**
 * Official `zEo` regex: a whole part that is ONLY `VAR=value` with a
 * restricted value charset (no `$`, parens, quotes, whitespace, etc.), so
 * command substitutions and option-injection values never qualify.
 */
const PURE_ENV_ASSIGNMENT_PATTERN =
  /^([A-Za-z_][A-Za-z0-9_]*)=(?![-+/])([A-Za-z0-9_.:@,+=/-]*)$/

/** Official `asn`: part is a pure env assignment of a safe (non-locale) var. */
function isPureEnvAssignment(part: string): boolean {
  const m = part.trim().match(PURE_ENV_ASSIGNMENT_PATTERN)
  return (
    m !== null &&
    SAFE_ASSIGNMENT_VAR_NAMES.has(m[1]!) &&
    !LOCALE_ASSIGNMENT_VAR_NAMES.has(m[1]!.toUpperCase())
  )
}

/**
 * Official `uSt`: remove backslash escapes outside single quotes (a backslash
 * before one of `$ ' " ` \` is dropped along with nothing — the pair vanishes;
 * any other `\x` becomes `x`). Byte-faithful port.
 */
function unescapeBackslashesOutsideSingleQuotes(input: string): string {
  let out = ''
  let inSingleQuotes = false
  let inDoubleQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (inSingleQuotes) {
      if (ch === "'") inSingleQuotes = false
      out += ch
      continue
    }
    if (ch === '\\' && !inSingleQuotes) {
      const next = input[i + 1]
      i++
      if (next !== undefined && !"$'\"`\\".includes(next)) out += next
      continue
    }
    if (ch === '"') {
      inDoubleQuotes = !inDoubleQuotes
      out += ch
      continue
    }
    if (ch === "'" && !inDoubleQuotes) {
      inSingleQuotes = true
      out += ch
      continue
    }
    out += ch
  }
  return out
}

/**
 * Official `Avo` (the 2.1.277 security guard): detects env-assignment smuggling
 * across the parts of a compound command — a variable assigned in one part
 * (pure `VAR=value` assignment, or a `${VAR:=…}`/`${VAR=…}` default-assignment
 * expansion) and REFERENCED from a different part. When detected, the compound
 * is never exempted from the sandbox: the real executed command may be built
 * from the assigned value, which per-part pattern matching cannot see through.
 */
function isEnvAssignmentSmuggling(parts: string[]): boolean {
  // var name -> set of part indices that assign it
  const assignedBy = new Map<string, Set<number>>()
  for (const [index, part] of parts.entries()) {
    const assignedNames: string[] = []
    const prefix = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(part.trim())
    if (prefix !== null && isPureEnvAssignment(part.trim())) {
      assignedNames.push(prefix[1]!)
    }
    for (const m of part.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g)) {
      assignedNames.push(m[1]!)
    }
    for (const name of assignedNames) {
      const indices = assignedBy.get(name)
      if (indices === undefined) assignedBy.set(name, new Set([index]))
      else indices.add(index)
    }
  }
  if (assignedBy.size === 0) return false
  return parts.some((part, index) => {
    const unescaped = unescapeBackslashesOutsideSingleQuotes(part)
    for (const [name, indices] of assignedBy) {
      // A var assigned only by THIS part is self-contained, not smuggling.
      if (indices.size === 1 && indices.has(index)) continue
      if (new RegExp(`\\$[=^~]*\\{?${name}\\b`).test(unescaped)) return true
    }
    return false
  })
}

// ---------------------------------------------------------------------------

/**
 * Whether a single subcommand matches the user-configured excluded patterns.
 *
 * Also tries matching with env var prefixes and wrapper commands stripped, so
 * that `FOO=bar bazel ...` and `timeout 30 bazel ...` match `bazel:*`.
 * BINARY_HIJACK_VARS kept as a heuristic (PATH=/evil prefixes are NOT
 * stripped, so they cannot be laundered into a match).
 *
 * We iteratively apply both stripping operations until no new candidates are
 * produced (fixed-point), matching the approach in filterRulesByContentsMatchingInput.
 * This handles interleaved patterns like `timeout 300 FOO=bar bazel run`
 * where single-pass composition would fail.
 */
function isSubcommandExcluded(
  subcommand: string,
  userExcludedCommands: string[],
): boolean {
  const trimmed = subcommand.trim()
  const candidates = [trimmed]
  const seen = new Set(candidates)
  let startIdx = 0
  while (startIdx < candidates.length) {
    const endIdx = candidates.length
    for (let i = startIdx; i < endIdx; i++) {
      const cmd = candidates[i]!
      const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
      if (!seen.has(envStripped)) {
        candidates.push(envStripped)
        seen.add(envStripped)
      }
      const wrapperStripped = stripSafeWrappers(cmd)
      if (!seen.has(wrapperStripped)) {
        candidates.push(wrapperStripped)
        seen.add(wrapperStripped)
      }
    }
    startIdx = endIdx
  }

  for (const pattern of userExcludedCommands) {
    const rule = bashPermissionRule(pattern)
    for (const cand of candidates) {
      switch (rule.type) {
        case 'prefix':
          if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
            return true
          }
          break
        case 'exact':
          if (cand === rule.command) {
            return true
          }
          break
        case 'wildcard':
          if (matchWildcardPattern(rule.pattern, cand)) {
            return true
          }
          break
      }
    }
  }
  return false
}

// NOTE: excludedCommands is a user-facing convenience feature, not a security boundary.
// It is not a security bug to be able to bypass excludedCommands — the sandbox permission
// system (which prompts users) is the actual security control.
function containsExcludedCommand(command: string): boolean {
  // Check dynamic config for disabled commands and substrings (only for ants)
  if (process.env.USER_TYPE === 'ant') {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('tengu_sandbox_disabled_commands', { commands: [], substrings: [] })

    // Check if command contains any disabled substrings
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // Check if command starts with any disabled commands
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // If we can't parse the command (e.g., malformed bash syntax),
      // treat it as not excluded to allow other validation checks to handle it
      // This prevents crashes when rendering tool use messages
    }
  }

  // Check user-configured excluded commands.
  // CC 2.1.282 (P1): read through SandboxManager.getExcludedCommands() —
  // the trusted-tier filtered getter (binary `IJ`). Reading the raw merged
  // settings here would bypass the restriction gate: a repo-committed
  // .claude/settings.json excludedCommands entry could exempt commands from
  // the sandbox even when managed/--settings configuration forbids
  // unsandboxed commands.
  const userExcludedCommands = SandboxManager.getExcludedCommands()

  if (userExcludedCommands.length === 0) {
    return false
  }

  // Split compound commands (e.g. "docker ps && curl evil.com") into individual
  // subcommands. Official 2.1.277 fix (changelog: "Fixed a
  // sandbox.excludedCommands glob exempting an entire compound Bash command
  // from the sandbox when only one part matched; every part must now match"):
  // the compound is exempted ONLY when EVERY subcommand matches an excluded
  // pattern. The pre-2.1.277 behavior returned true on the FIRST matching
  // subcommand, so `git status; rm -rf /` escaped the sandbox entirely under
  // excludedCommands:['git'].
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  if (subcommands.length === 0) {
    return false
  }

  // Official 2.1.277 `Avo` guard: env-assignment smuggling (a var assigned in
  // one part and referenced from another) forces the compound to stay
  // sandboxed regardless of per-part matches.
  if (isEnvAssignmentSmuggling(subcommands)) {
    return false
  }

  return subcommands.every(subcommand =>
    isSubcommandExcluded(subcommand, userExcludedCommands),
  )
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // Don't sandbox if explicitly overridden AND unsandboxed commands are allowed by policy
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }

  // Don't sandbox if EVERY part of the command matches user-configured
  // excluded commands (official 2.1.277 every-part semantics)
  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
