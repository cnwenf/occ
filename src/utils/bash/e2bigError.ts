import { sep } from 'path'

/**
 * E2BIG diagnostic for the Bash tool.
 *
 * Reproduces the upstream (claude-code 2.1.201+) behavior for "argument list
 * too long" failures in repos with many git worktrees. When the sandboxed
 * shell spawn hits the OS exec argument limit (ARG_MAX / MAX_ARG_STRLEN), the
 * raw error is an opaque `E2BIG: argument list too long`. These helpers turn
 * it into a human-readable, actionable message that names the cause and tells
 * the user how to recover.
 *
 * Root cause: the Bash sandbox profile denies writes to a set of per-worktree
 * git internal files (`config.worktree`, `config.worktree.lock`, `commondir`)
 * for every registered git worktree. That deny list grows without bound as the
 * user adds worktrees, eventually pushing the sandboxed command line past
 * ARG_MAX. This is surfaced (not silently capped) because the deny paths are
 * load-bearing for sandbox security; the fix is to give the user a clear error
 * so they can prune stale worktrees or relax the sandbox for the session.
 */

/**
 * True when an error is the OS `E2BIG` exec failure ("argument list too long").
 */
export function isE2BIG(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'E2BIG'
  )
}

// Segment that identifies a path inside <mainRepo>/.git/worktrees/<name>/.
const WORKTREE_SEGMENT = `${sep}worktrees${sep}`

// Per-worktree git internal files the sandbox denies writes to. Each
// registered worktree contributes one of each under .../.git/worktrees/<name>/.
const WORKTREE_DENY_SUFFIXES = [
  `${sep}config.worktree`,
  `${sep}config.worktree.lock`,
  `${sep}commondir`,
]

/**
 * True when a sandbox deny path is one of the per-worktree git internal files
 * (`config.worktree` / `config.worktree.lock` / `commondir`) that live under
 * `.../.git/worktrees/<name>/`. These are the paths that grow without bound as
 * the user registers more git worktrees.
 */
export function isWorktreeDenyPath(path: string): boolean {
  return (
    path.includes(WORKTREE_SEGMENT) &&
    WORKTREE_DENY_SUFFIXES.some(suffix => path.endsWith(suffix))
  )
}

/**
 * Format a byte count the way the upstream diagnostic does: `<n> bytes` under
 * 1 KiB, then `<x.x>KB` / `<x.x>MB` / `<x.x>GB` with a trailing `.0` stripped.
 */
function formatBytes(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1) return `${bytes} bytes`
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')}GB`
}

/**
 * Options for {@link formatE2BigError}.
 */
export interface E2BigErrorOptions {
  /** The binary that was spawned (e.g. the shell path). */
  binary: string
  /** The argv passed to the spawn (excluding argv[0]). */
  argv: string[]
  /** The environment passed to the spawn. */
  env: Record<string, unknown>
  /** Sandbox filesystem deny paths active for this command (may be empty). */
  sandboxDenyPaths: string[]
}

/**
 * Build a human-readable, actionable error message for an E2BIG spawn failure.
 *
 * Reports the command-line and environment byte sizes (and the largest single
 * arg / env var). When the Bash sandbox contributed deny paths, reports how
 * many — and how many belong to registered git worktrees — then suggests
 * removing worktrees (`git worktree remove` / `git worktree prune`) and
 * restarting, or relaxing the sandbox for the session with `/sandbox`.
 */
export function formatE2BigError({
  binary,
  argv,
  env,
  sandboxDenyPaths,
}: E2BigErrorOptions): string {
  // Command-line size: binary + each argv element, each terminated by a NUL.
  let commandLineBytes = Buffer.byteLength(binary) + 1
  let largestArgBytes = 0
  for (const arg of argv) {
    const argBytes = Buffer.byteLength(arg) + 1
    commandLineBytes += argBytes
    if (argBytes > largestArgBytes) largestArgBytes = argBytes
  }

  // Environment size: each "KEY=VALUE\0" entry.
  let envBytes = 0
  let envVarCount = 0
  let largestEnvVar: string | undefined
  let largestEnvVarBytes = 0
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    envVarCount++
    const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(value) + 2
    envBytes += entryBytes
    if (entryBytes > largestEnvVarBytes) {
      largestEnvVarBytes = entryBytes
      largestEnvVar = key
    }
  }

  let message =
    `Could not start ${binary}: the command line plus environment exceed the OS exec argument limit (E2BIG). ` +
    `At spawn: command line ${formatBytes(commandLineBytes)} across ${argv.length + 1} args ` +
    `(largest single arg ${formatBytes(largestArgBytes)}); environment ${formatBytes(envBytes)} across ${envVarCount} vars`
  if (largestEnvVar !== undefined) {
    message += ` (largest: ${largestEnvVar} at ${formatBytes(largestEnvVarBytes)})`
  }
  message += '.'

  if (sandboxDenyPaths.length === 0) return message

  const worktreeCount = sandboxDenyPaths.filter(isWorktreeDenyPath).length
  message += ` The Bash sandbox profile adds ${sandboxDenyPaths.length} filesystem deny paths to every command`
  if (worktreeCount > 0) {
    message +=
      `, ${worktreeCount} of them for registered git worktrees, which grow this list without bound. ` +
      `From another terminal, remove worktrees you no longer need (git worktree remove <path>; ` +
      `git worktree prune for already-deleted checkouts), then restart Claude Code so the profile is ` +
      `rebuilt without them — or relax the Bash sandbox for this session with /sandbox.`
  } else {
    message += '.'
  }
  return message
}
