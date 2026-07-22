/**
 * CC 2.1.216 #8: worktree-isolated subagents must not redirect git into the
 * shared/parent checkout (escaping isolation) via `git -C`, `--git-dir`,
 * `--work-tree`, the `GIT_DIR`/`GIT_WORK_TREE` env vars, or `--bare`.
 *
 * Reverse-engineered from the 2.1.216/2.1.217 ELF per `aligning-with-official-
 * binary`. The official emits:
 *   "[worktree] blocked shell exec: command redirects git into the shared
 *    checkout: cwd=… agentWorktree=… shared_checkout"
 * and the user-facing reasons:
 *   "redirects git to the shared checkout via <mechanism>, which redirects
 *    git to a repository this guard cannot verify"
 *   "redirects git through a glob pattern that expands at runtime; spell out
 *    the literal path"
 *   "points git at a directory computed at runtime (-C …)"
 *   "points git at a repository computed at runtime (…)"
 *   "redirects git to a repository this guard cannot verify"
 *
 * Detection: tokenize the command (shell-quote), find git invocations, scan
 * their args + leading env vars for redirect mechanisms. A target that is a
 * glob / runtime-dynamic / unresolved, or that resolves OUTSIDE the agent's
 * worktree (i.e. into the shared checkout or anywhere else) is blocked. A
 * target inside the worktree is allowed (the subagent's own space).
 *
 * `--bare` is unverifiable (no worktree to bound against) → block.
 */

import { resolve, isAbsolute, sep } from 'node:path'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

export interface WorktreeGitRedirectBlock {
  /** User-facing reason (official text). */
  reason: string
  /** The mechanism that triggered the block (for the "via <mechanism>" clause). */
  mechanism: string
}

function isGitToken(tok: string): boolean {
  if (!tok) return false
  return tok === 'git' || tok.endsWith('/git')
}

function isGlobTarget(path: string): boolean {
  // Brace/asterisk/question/char-class — brace expansion is the main vector.
  return GLOB_CHARS.some(c => path.includes(c))
}

const GLOB_CHARS = ['*', '?', '[', ']', '{', '}']

function isDynamicTarget(path: string): boolean {
  // Variable / command substitution / unexpanded tilde → resolves at runtime.
  return (
    path.includes('$') ||
    path.includes('`') ||
    path.includes('$(') ||
    path.startsWith('~')
  )
}

function isWithinWorktree(
  target: string,
  agentWorktree: string,
  cwd: string,
): boolean {
  const resolved = isAbsolute(target) ? target : resolve(cwd, target)
  const worktree = resolve(agentWorktree)
  return resolved === worktree || resolved.startsWith(worktree + sep)
}

interface ArgvSpan {
  argv: string[]
}

/**
 * Split a command into argv spans (one per simple command), dropping shell
 * operators. Uses shell-quote so quoting is respected. On parse failure,
 * returns an empty list — callers treat parse-failure as fail-closed via
 * the existing redirect-safety path, not here.
 */
function commandToArgvSpans(command: string): ArgvSpan[] {
  const parsed = tryParseShellCommand(command, (env: string) => `$${env}`)
  if (!parsed.success) return []
  const tokens = parsed.tokens
  const spans: ArgvSpan[] = []
  let cur: string[] = []
  for (const tok of tokens) {
    if (typeof tok === 'string') {
      cur.push(tok)
    } else if (tok && typeof tok === 'object' && 'pattern' in tok) {
      // shell-quote emits globs as {op:'glob', pattern:'…'} — keep the
      // pattern as a string so -C/--git-dir glob targets are detected.
      cur.push((tok as { pattern: string }).pattern)
    } else if (tok && typeof tok === 'object' && 'op' in tok) {
      // operator boundary (&&, ||, ;, |, etc.) — flush current span
      if (cur.length) spans.push({ argv: cur })
      cur = []
    }
  }
  if (cur.length) spans.push({ argv: cur })
  return spans
}

// ─────────────────────────────────────────────────────────────────────────
// Official mechanism sets (reverse-engineered from the 2.1.217 ELF `ZRu`/
// `ezg`/`Xss`/`V6g`/`q6g`/`lzg`). Matching these = not inventing.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Env vars that redirect git at a repo/object level (official `Xss`):
 *   GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY,
 *   GIT_INDEX_FILE, GIT_SHALLOW_FILE
 * Scanned as `KEY=VAL` assignments anywhere in a span (covers `env`/`sudo`/
 * `command` wrappers — the official's env-assignment scan walks the whole
 * simple-command argv, not just the leading prefix).
 */
const ENV_REDIRECT_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_SHALLOW_FILE',
])

/**
 * Path-arg global flags (official `V6g`): `--git-dir`, `--work-tree`.
 * Evaluated as redirect targets (next token or `=<path>` form).
 */
const PATH_ARG_FLAGS = ['--git-dir', '--work-tree']

/**
 * Arg-taking global flags the official skips WITHOUT treating as redirects
 * (official `q6g`): `--namespace`, `--attr-source`, `--shallow-file`. The
 * walker must skip the flag + its arg so it doesn't mistake the arg for the
 * subcommand. These are NOT redirect mechanisms.
 */
const ARG_SKIP_FLAGS = new Set([
  '--namespace',
  '--attr-source',
  '--shallow-file',
])

function isEnvRedirectKey(key: string): boolean {
  return ENV_REDIRECT_KEYS.has(key.toUpperCase())
}

/**
 * Official `lzg`: git `-c`/`--config-env` config keys that redirect git
 * (`core.worktree`, `core.bare`, `include.*`, `includeif.*`). Any `-c
 * <key>=<val>` with such a key points git at attacker-controlled state →
 * unverifiable.
 */
function isRedirectConfigKey(key: string): boolean {
  return (
    key === 'core.worktree' ||
    key === 'core.bare' ||
    key.startsWith('include.') ||
    key.startsWith('includeif.')
  )
}

const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * Check a command for git-redirect-escape in a worktree-isolated subagent.
 * Returns a block (with the official reason) if the command would redirect
 * git outside the worktree / via a glob / via a runtime-dynamic target /
 * via `--bare` / via a `-c core.worktree=…` config override; null if safe.
 *
 * Per the official `ZRu`/`ezg`: scan KEY=VAL env-assignments ANYWHERE in a
 * span (covers `env`/`sudo`/`command` wrappers — the previous leading-prefix-
 * only scan was bypassed by `env GIT_DIR=… git`), AND scan each `git` command
 * word's following global-option tokens for the redirect mechanisms.
 */
export function checkWorktreeGitRedirect(
  command: string,
  agentWorktree: string,
  cwd: string,
): WorktreeGitRedirectBlock | null {
  const spans = commandToArgvSpans(command)
  for (const span of spans) {
    const argv = span.argv
    if (argv.length === 0) continue

    // 1. Scan ALL `KEY=VAL` env-assignments anywhere in the span. Catches
    //    `env GIT_DIR=/shared/.git git …`, `sudo GIT_WORK_TREE=/x git …`,
    //    `GIT_DIR=/x git …`, etc. — the previous leading-prefix-only scan
    //    missed the `env`/`sudo`/`command`-wrapped form (security review
    //    point 3, blocking).
    for (const tok of argv) {
      const m = ENV_ASSIGN_RE.exec(tok)
      if (m && isEnvRedirectKey(m[1])) {
        const block = evaluateTarget(m[2], m[1], agentWorktree, cwd)
        if (block) return block
      }
    }

    // 2. Find a `git` command word anywhere in the span; scan its following
    //    global-option tokens (ZRu-style) for redirect mechanisms. Scanning
    //    "anywhere" covers wrappers (`env … git`, `sudo … /usr/bin/git`).
    for (let g = 0; g < argv.length; g++) {
      if (!isGitToken(argv[g] ?? '')) continue
      const block = scanGitRedirectFlags(argv, g, agentWorktree, cwd)
      if (block) return block
    }
  }
  return null
}

/**
 * Walk the tokens AFTER a `git` command word, mirroring the official `ZRu`:
 *   -C <path>                  → chdir (evaluate path)
 *   --git-dir / --work-tree [=<path>]  → pin (evaluate path)
 *   --bare                     → unverifiable (no worktree to bound against)
 *   -c <key=val> / --config-env[=]<key=val> → unverifiable if key ∈ lzg
 *   --namespace/--attr-source/--shallow-file (q6g) → skip flag + arg
 *   -- (end of options) / first non-flag (subcommand) → stop
 */
function scanGitRedirectFlags(
  argv: string[],
  gitIdx: number,
  agentWorktree: string,
  cwd: string,
): WorktreeGitRedirectBlock | null {
  let i = gitIdx + 1
  while (i < argv.length) {
    const s = argv[i]
    if (s === '--') break

    if (s === '-C') {
      const val = argv[i + 1]
      if (val === undefined) break
      const block = evaluateTarget(val, '-C', agentWorktree, cwd)
      if (block) return block
      i += 2
      continue
    }

    if (s === '--bare') {
      return {
        mechanism: '--bare',
        reason:
          'points git at a repository computed at runtime (--bare), which redirects git to a repository this guard cannot verify',
      }
    }

    // --git-dir / --work-tree (V6g), `--flag <path>` or `--flag=<path>`.
    const v6g = PATH_ARG_FLAGS.find(f => s === f || s.startsWith(`${f}=`))
    if (v6g !== undefined) {
      const val = s === v6g ? argv[i + 1] : s.slice(v6g.length + 1)
      if (val === undefined) break
      // Next-token form: a following flag means no value given — don't claim it.
      if (s === v6g && val.startsWith('-')) {
        i += 1
        continue
      }
      const block = evaluateTarget(val, v6g, agentWorktree, cwd)
      if (block) return block
      i += s === v6g ? 2 : 1
      continue
    }

    // -c <key=val> / --config-env <key=val> / --config-env=<key=val> — git
    // config override. If the key redirects git (lzg: core.worktree /
    // core.bare / include.* / includeif.*), it's unverifiable.
    if (s === '-c' || s === '--config-env' || s.startsWith('--config-env=')) {
      const kv =
        s === '-c' || s === '--config-env'
          ? argv[i + 1]
          : s.slice('--config-env='.length)
      if (kv === undefined) break
      const eq = kv.indexOf('=')
      const cfgKey = eq >= 0 ? kv.slice(0, eq) : kv
      if (eq >= 0 && isRedirectConfigKey(cfgKey)) {
        return {
          mechanism: '-c',
          reason: `points git at a repository computed at runtime (-c ${kv}), which redirects git to a repository this guard cannot verify`,
        }
      }
      i += s === '-c' || s === '--config-env' ? 2 : 1
      continue
    }

    // q6g arg-taking flags — skip the flag + its arg (NOT a redirect).
    if (ARG_SKIP_FLAGS.has(s)) {
      i += 2
      continue
    }

    // Any other flag — skip as a single token.
    if (s.startsWith('-')) {
      i += 1
      continue
    }

    // First non-flag token → the subcommand; global options end here.
    break
  }
  return null
}

function evaluateTarget(
  target: string,
  mechanism: string,
  agentWorktree: string,
  cwd: string,
): WorktreeGitRedirectBlock | null {
  if (!target) return null
  if (isGlobTarget(target)) {
    return {
      mechanism,
      reason:
        'redirects git through a glob pattern that expands at runtime; spell out the literal path',
    }
  }
  if (isDynamicTarget(target)) {
    return {
      mechanism,
      reason: `points git at a directory computed at runtime (${mechanism} ${target}), which redirects git to a repository this guard cannot verify`,
    }
  }
  // Literal target — resolve and bound against the worktree.
  if (isWithinWorktree(target, agentWorktree, cwd)) {
    return null // inside the worktree — allowed (the subagent's own space)
  }
  // Outside the worktree → the shared checkout / an escape.
  return {
    mechanism,
    reason: `redirects git to the shared checkout via ${mechanism}, which redirects git to a repository this guard cannot verify`,
  }
}
