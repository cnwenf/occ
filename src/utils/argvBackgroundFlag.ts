/**
 * Position-aware argv flag scanner — verbatim port of the official Claude
 * Code 2.1.299 argv scanner (minified `p$t` / `Mgt` / `Hgt` / `Fw` / `Q8s`
 * plus the flag sets `l` / `ZMr` / `d`, recovered from the 2.1.299 linux-x64
 * ELF). Official changelog 2.1.299:
 *   - "Fixed `claude mcp add <name> -- <command> --background` being started
 *      as a background session"
 *   - "Fixed a prompt or reply of `--bg` or `--background` to a background
 *      session being taken for the flag, which could start new sessions over
 *      and over instead of delivering it"
 *
 * A flag only counts when it appears in COMMAND position: scanning stops at
 * `--`, and tokens consumed as values of value-taking flags are skipped.
 * Message content (a reply passed as a value, or anything after `--`) is
 * therefore never mistaken for the flag.
 */

/** Official `l` — flags that take a value (their next token is skipped). */
const VALUE_FLAGS = new Set([
  '--prefill',
  '--prefill-b64',
  '--deep-link-repo',
  '--deep-link-last-fetch',
  '--deep-link-cwd-b64',
  '--handle-uri',
  '--settings',
  '--managed-settings',
  '--setting-sources',
  '--client-data-url',
  '--watch-artifact',
  '--watch-artifact-no-autoreact',
  '--team-name',
  '--agent-id',
  '--agent-name',
  '--agent-color',
  '--parent-session-id',
  '--agent-type',
  '--model',
  '--agent',
  '--routine',
  '--effort',
  '--fast-mode',
  '--permission-mode',
  '--inherit-permission-mode',
  '--proactivity',
  '--debug-file',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-snapshot',
  '--append-subagent-system-prompt',
  '--append-subagent-system-prompt-file',
  '--plan-mode-instructions',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--json-schema',
  '--fallback-model',
  '--advisor',
  '--agents',
  '--name',
  '-n',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--file',
  '--channels',
  '--dangerously-load-development-channels',
  '--plugin-dir',
  '--plugin-dir-no-mcp',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--exec',
  '-m',
  '--sdk-url',
  '--thinking',
  '--thinking-display',
  '--max-thinking-tokens',
  '--max-turns',
  '--max-budget-usd',
  '--task-budget',
  '--autocompact',
  '--rewind-files',
  '--resume-session-at',
  '--resume-drops-turn',
  '--workload',
  '--output-format',
  '--input-format',
  '--teammate-mode',
  '--messaging-socket-path',
  '--session-id',
  '--environment',
  '--pool',
  '--ref',
  '--on-branch',
  '--correlation-id',
  '--forward-home-settings',
  '--project-config-root',
  '--attach-serve',
])

/** Official `ZMr` — subset of VALUE_FLAGS that consume multiple values. */
const MULTI_VALUE_FLAGS = new Set([
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--file',
  '--channels',
  '--dangerously-load-development-channels',
])

/** Official `d` — flags whose value is optional. */
const OPTIONAL_VALUE_FLAGS = new Set([
  '-d',
  '--debug',
  '-r',
  '--resume',
  '--from-pr',
  '-w',
  '--worktree',
  '--teleport',
  '--cloud',
  '--remote',
  '--project',
  '--remote-control',
  '--rc',
  '--prompt-suggestions',
])

/** Official `p$t` — a token that looks like a flag (so it is not a value). */
function looksLikeFlag(token: string): boolean {
  return token.length > 1 && token.startsWith('-')
}

/**
 * Official `Mgt` — given the token at index `n`, return the index of the
 * last argv token this flag consumes as its value (`n` when it takes none).
 */
function skipFlagValue(argv: string[], n: number): number {
  const token = argv[n]
  if (token !== undefined && OPTIONAL_VALUE_FLAGS.has(token)) {
    const next = argv[n + 1]
    return next !== undefined && !looksLikeFlag(next) ? n + 1 : n
  }
  if (token === undefined || !VALUE_FLAGS.has(token)) return n
  let end = n + 1
  if (MULTI_VALUE_FLAGS.has(token)) {
    while (end + 1 < argv.length && !looksLikeFlag(argv[end + 1]!)) end++
  }
  return end
}

/**
 * Official `Hgt` — index of the first command-position token satisfying
 * `predicate`, or -1. Scanning stops at `--`; value tokens of value-taking
 * flags are skipped and never matched.
 */
export function findArgIndex(
  predicate: (token: string) => boolean,
  argv: string[] = process.argv,
): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') break
    if (token !== undefined && predicate(token)) return i
    i = skipFlagValue(argv, i)
  }
  return -1
}

/** Official `Fw` — whether `flag` occurs in command position. */
export function hasArg(flag: string, argv: string[] = process.argv): boolean {
  return findArgIndex(t => t === flag, argv) !== -1
}

/**
 * Official `Q8s` — whether `--bg`/`--background` occurs in command position.
 * A prompt or reply whose CONTENT is `--bg`/`--background` (delivered as a
 * flag value or after `--`) must NOT match (2.1.299 fix).
 */
export function hasBackgroundFlag(argv: string[] = process.argv): boolean {
  return hasArg('--bg', argv) || hasArg('--background', argv)
}
