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

/**
 * Check a command for git-redirect-escape in a worktree-isolated subagent.
 * Returns a block (with the official reason) if the command would redirect
 * git outside the worktree / via a glob / via a runtime-dynamic target /
 * via `--bare`; null if it's safe (or not a git redirect).
 */
export function checkWorktreeGitRedirect(
  command: string,
  agentWorktree: string,
  cwd: string,
): WorktreeGitRedirectBlock | null {
  const spans = commandToArgvSpans(command)
  for (const span of spans) {
    const argv = span.argv
    // Leading env-var assignments (KEY=VAL) before the command — capture
    // GIT_DIR / GIT_WORK_TREE redirects planted as env prefixes.
    const envPrefixes: Array<{ key: string; value: string }> = []
    let i = 0
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? '')) {
      const eq = argv[i].indexOf('=')
      envPrefixes.push({
        key: argv[i].slice(0, eq),
        value: argv[i].slice(eq + 1),
      })
      i++
    }
    const rest = argv.slice(i)
    // The first non-env token is the command word. Only guard `git`.
    const cmd = rest[0]
    if (!cmd || !isGitToken(cmd)) continue

    // 1. Env-prefix redirects: GIT_DIR=… / GIT_WORK_TREE=…
    for (const env of envPrefixes) {
      if (env.key === 'GIT_DIR' || env.key === 'GIT_WORK_TREE') {
        const block = evaluateTarget(env.value, env.key, agentWorktree, cwd)
        if (block) return block
      }
    }

    // 2. git flag redirects: -C <path>, --git-dir[=]<path>, --work-tree[=]<path>, --bare
    for (let j = 1; j < rest.length; j++) {
      const arg = rest[j]
      if (arg === '-C') {
        const val = rest[j + 1]
        if (val !== undefined) {
          const block = evaluateTarget(val, '-C', agentWorktree, cwd)
          if (block) return block
        }
      } else if (arg === '--git-dir' || arg === '--work-tree') {
        const val = rest[j + 1]
        if (val !== undefined && !val.startsWith('-')) {
          const block = evaluateTarget(val, arg, agentWorktree, cwd)
          if (block) return block
        }
      } else if (
        arg.startsWith('--git-dir=') ||
        arg.startsWith('--work-tree=')
      ) {
        const val = arg.slice(arg.indexOf('=') + 1)
        const mech = arg.startsWith('--git-dir=') ? '--git-dir' : '--work-tree'
        const block = evaluateTarget(val, mech, agentWorktree, cwd)
        if (block) return block
      } else if (arg === '--bare') {
        // Bare repo has no worktree to bound against → unverifiable.
        return {
          mechanism: '--bare',
          reason:
            'points git at a repository computed at runtime (--bare), which redirects git to a repository this guard cannot verify',
        }
      }
    }
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
