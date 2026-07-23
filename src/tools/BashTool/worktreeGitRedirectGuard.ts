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

import { resolve, isAbsolute, sep, basename } from 'node:path'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

export interface WorktreeGitRedirectBlock {
  /** User-facing reason (official text). */
  reason: string
  /** The mechanism that triggered the block (for the "via <mechanism>" clause). */
  mechanism: string
}

/**
 * Official `Jss`: a token whose basename is exactly a git command name
 * (`git`, `git.exe`, `git.real`, `git-receive-pack`, `git-upload-pack`, …),
 * case-insensitive. Used by `ozg`'s `t` (git-presence) and `isGitToken`.
 */
const GIT_NAME_RE = /^git(?:\.exe|\.real|-[a-z][\w-]*)?$/i

function isGitToken(tok: string): boolean {
  if (!tok) return false
  // Match `git`, `/usr/bin/git`, `git-receive-pack`, `git.exe`, …
  return GIT_NAME_RE.test(basename(tok))
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
  /** This span receives its stdin from a pipe (preceded by a `|` operator). */
  stdinFromPipe: boolean
  /**
   * The `<`-family operator that flushed this span and feeds its stdin, or
   * null. shell-quote emits these as single ops: `<` (redirect), `<<<`
   * (here-string), `<<` (heredoc — currently split into two `<` ops, but
   * matched by the prefix check either way), `<<-` (dedent heredoc), `<&`
   * (fd-dup), `<(` (process substitution). Output redirections (`>`, `>>`,
   * `>&`) start with `>` and are excluded — they don't feed stdin.
   */
  stdinFeedOp: string | null
}

/**
 * Map a stdin-feeding operator to the user-facing source label embedded in
 * the block's mechanism/reason (Follow-up B). Distinct labels = honest
 * reporting, not a lumped "redirect".
 */
function stdinSourceLabel(op: string): string {
  if (op === '<(') return 'process substitution'
  if (op === '<<<') return 'here-string'
  if (op === '<&') return 'fd-dup'
  // `<`, or the first `<` of a `<<`/`<<-` heredoc (shell-quote splits
  // heredoc into two `<` ops, so the stored op is `<`). Both feed stdin
  // from a redirected source — "redirect" is accurate for both.
  return 'redirect'
}

/**
 * Split a command into argv spans (one per simple command), dropping shell
 * operators. Uses shell-quote so quoting is respected. On parse failure,
 * returns an empty list — callers treat parse-failure as fail-closed via
 * the existing redirect-safety path, not here.
 *
 * Spans carry stdin-source info (Follow-up B): any `<`-family operator that
 * flushes a span marks THAT span as reading a script from stdin (the
 * redirection attaches to the preceding command, e.g. `bash < script.sh`,
 * `bash <<< '…'`, `bash <&3`); a `|` operator marks the NEXT span as a
 * pipe-receiver (`echo … | bash`). The op is matched by `startsWith('<')`
 * (NOT exact `=== '<'`) so `<<<`/`<<`/`<<-`/`<&` are covered and a future
 * shell-quote change to a single `<<` op can't silently reopen the gap.
 */
function commandToArgvSpans(command: string): ArgvSpan[] {
  const parsed = tryParseShellCommand(command, (env: string) => `$${env}`)
  if (!parsed.success) return []
  const tokens = parsed.tokens
  const spans: ArgvSpan[] = []
  let cur: string[] = []
  // True while the next span begins as the receiver of a pipe (`|`).
  let nextSpanPipeRecv = false
  const flush = (flushingOp: string | null): void => {
    if (cur.length === 0) return
    spans.push({
      argv: cur,
      stdinFromPipe: nextSpanPipeRecv,
      stdinFeedOp:
        flushingOp !== null && flushingOp.startsWith('<') ? flushingOp : null,
    })
    cur = []
    nextSpanPipeRecv = false
  }
  for (const tok of tokens) {
    if (typeof tok === 'string') {
      cur.push(tok)
    } else if (tok && typeof tok === 'object' && 'pattern' in tok) {
      // shell-quote emits globs as {op:'glob', pattern:'…'} — keep the
      // pattern as a string so -C/--git-dir glob targets are detected.
      cur.push((tok as { pattern: string }).pattern)
    } else if (tok && typeof tok === 'object' && 'op' in tok) {
      const op = (tok as { op: string }).op
      // operator boundary (&&, ||, ;, |, <, >, <(, ), …) — flush current
      // span. A `<`-family flushing op marks the flushed span as
      // stdin-fed (the redirect attaches to the preceding command).
      flush(op)
      if (op === '|') nextSpanPipeRecv = true
    }
  }
  flush(null)
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

// ─────────────────────────────────────────────────────────────────────────
// Official `ozg` shell-wrapper / opaque-feed detection (Follow-up A).
// Reverse-engineered from the 2.1.217 ELF `ozg`/`NZt`/`rzg`/`tzg`/`nzg`.
// `ozg` is called per simple-command in a worktree subagent and blocks
// commands that run git through an unverifiable wrapper — a builtin that runs
// a string (eval/source/./…), xargs/parallel feeding git from stdin, or
// `find -execdir/-okdir` cd-ing per match before git.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bash builtins that run a string/script (official `rLu` = `NZt` \ `rzg`):
 *   eval, source, ., fc, coproc, trap, enable, mapfile, readarray, hash,
 *   bind, complete, compgen, alias, let
 * (`exec`/`nocorrect` are excluded by `rzg`.) These are BUILTINS, not shells
 * — `bash -c`/`sh -c` are NOT in `rLu`, so the official's `ozg` does NOT
 * catch them (see the report's bash/sh note). Matching the official = not
 * inventing bash/sh handling.
 */
const SHELL_BUILTIN_WRAPPERS = new Set([
  'eval',
  'source',
  '.',
  'fc',
  'coproc',
  'trap',
  'enable',
  'mapfile',
  'readarray',
  'hash',
  'bind',
  'complete',
  'compgen',
  'alias',
  'let',
])

/** Commands that feed git's args from stdin (official `tzg`). */
const STDIN_FEED_WRAPPERS = new Set(['xargs', 'parallel'])

/** find flags that cd per match before running git (official `nzg`). */
const FIND_PERMATCH_FLAGS = new Set(['-execdir', '-okdir'])

/**
 * Shell interpreters that run a `-c` string or a scriptfile (Follow-up A
 * supplement): `bash`/`sh`/`zsh`/`dash`/`fish`/`csh`/`ksh`/`tcsh` (+
 * `rbash`). These are NOT in the official's `rLu` (builtins), so the official
 * `ozg` doesn't catch `bash -c`/`sh -c`; OCC doesn't recursively parse `-c`
 * strings, so `bash -c 'git -C /shared …'` is a direct worktree escape — block
 * it at the ozg layer (security review decision; going beyond the official
 * `ozg` by explicit leader sign-off, since OCC lacks -c recursion).
 */
const SHELL_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'csh',
  'ksh',
  'tcsh',
  'rbash',
])

/**
 * Command wrappers that exec their args as a command (the leader's list,
 * aligned with `bashPermissions`'s `BARE_SHELL_PREFIXES` wrapper subset):
 * env/sudo/command/nice/nohup/timeout/doas/stdbuf/time. Used to find the real
 * command word after leading wrappers (so `sudo bash -c …`, `env FOO=bar
 * bash …` still catch the shell at command position).
 */
const COMMAND_WRAPPERS = new Set([
  'env',
  'sudo',
  'command',
  'nice',
  'nohup',
  'timeout',
  'doas',
  'stdbuf',
  'time',
  'exec',
  'pkexec',
  'chroot',
  'runuser',
  'su',
])

/**
 * Find a shell-escape (security review #194 repass2, direction 2):
 *   - argv[0] is a shell → return 0 (command-position shell).
 *   - argv[0] is a `COMMAND_WRAPPERS` entry → scan the REST (argv[1:]) for a
 *     shell ANYWHERE. This avoids the arg-taking-flag value ambiguity that
 *     broke the prior command-position walker (`sudo -u user bash -c`,
 *     `env -C dir bash -c`, `env -u VAR bash -c`, `timeout 5 bash -c` — the
 *     walker stopped at the flag's value and missed the later shell).
 *   - otherwise (argv[0] not a shell, not a wrapper) → -1: `bash`/`sh`
 *     appearing as a search string / filename (`grep -rn bash .`,
 *     `rg bash .`, `git grep bash file`) is NOT an escape.
 * Returns the argv index of the shell, or -1.
 */
function findShellEscapeIdx(argv: string[]): number {
  if (argv.length === 0) return -1
  const first = basename(argv[0] ?? '').toLowerCase()
  if (SHELL_INTERPRETERS.has(first)) return 0
  if (COMMAND_WRAPPERS.has(first)) {
    return argv.findIndex(
      (o, i) => i > 0 && SHELL_INTERPRETERS.has(basename(o ?? '').toLowerCase()),
    )
  }
  return -1
}

/**
 * Per-span stdin-source context for `checkShellWrapperObfuscation` (Follow-up
 * B): tells the shell-escape check whether the span's shell reads its script
 * from a non-REPL stdin source — a pipe, or any `<`-family redirect
 * (`<`/`<<<`/`<<`/`<<-`/`<&`/`<(`). When it does, and the shell has no
 * `-c`/scriptfile, the payload can't be verified → block (same
 * "unverifiable payload" principle as `bash -c`).
 */
interface ShellWrapperCtx {
  stdinFromPipe: boolean
  stdinFeedOp: string | null
}

const EMPTY_CTX: ShellWrapperCtx = {
  stdinFromPipe: false,
  stdinFeedOp: null,
}

/**
 * Official `ozg(e)`: detect an unverifiable wrapper around git in one
 * simple-command's argv. Returns a block (with the official reason) or null.
 *
 *   t = argv contains a token whose basename is a git command name (`Jss`).
 *   - t && xargs/parallel present  → "feeds git from stdin at runtime"
 *   - t && find && -execdir/-okdir → "changes directory per match before git"
 *   - a `rLu` builtin (eval/source/./…) with any other arg → "runs a string
 *     through <wrapper>, can't verify" (NOT git-gated — worktree isolation
 *     forbids unverifiable string-exec via builtins, matching the official).
 *
 * Follow-up A supplement: a shell interpreter at command position running a
 * `-c` string or scriptfile (bash -c '…', bash script.sh, sudo … bash …).
 * Follow-up B supplement: a shell interpreter reading a script from a
 * non-REPL stdin source (echo … | bash, bash < script.sh, bash <(…)); and
 * `su -c`/`runuser -c` (the `-c` hangs on su/runuser, not bash -c, so the
 * shell-escape scan misses it).
 */
function checkShellWrapperObfuscation(
  argv: string[],
  ctx: ShellWrapperCtx = EMPTY_CTX,
): WorktreeGitRedirectBlock | null {
  if (argv.length === 0) return null
  const t = argv.some(o => GIT_NAME_RE.test(basename(o)))
  if (t && argv.some(o => STDIN_FEED_WRAPPERS.has(basename(o).toLowerCase()))) {
    return {
      mechanism: 'xargs/parallel',
      reason:
        'feeds git its arguments from stdin at runtime (xargs/parallel), so the repository it targets cannot be verified',
    }
  }
  const hasFind = argv.some(o => basename(o).toLowerCase() === 'find')
  if (t && hasFind && argv.some(o => FIND_PERMATCH_FLAGS.has(o))) {
    return {
      mechanism: 'find -execdir/-okdir',
      reason:
        'changes directory per match (find -execdir/-okdir) before running git, so its repository cannot be verified',
    }
  }
  // Shell interpreter at COMMAND POSITION running a `-c` string or a
  // scriptfile (bash -c 'git …', sh -c '…', bash script.sh, env/sudo/command
  // … bash …). The payload can't be verified to stay inside the worktree
  // (OCC doesn't recurse into -c strings → direct escape, same class as
  // `eval "git …"`). Command-position only — `bash`/`sh` appearing as a
  // search string or filename (`grep -rn bash .`, `rg bash .`, `git grep
  // bash file`) is NOT mistaken for a shell wrapper.
  const shellIdx = findShellEscapeIdx(argv)
  if (shellIdx !== -1) {
    const rest = argv.slice(shellIdx + 1)
    const hasCFlag = rest.includes('-c')
    const hasScriptfile = rest.some(a => a.length > 0 && !a.startsWith('-'))
    if (hasCFlag || hasScriptfile) {
      const name = basename(argv[shellIdx])
      return {
        mechanism: `${name} -c`,
        reason: `runs a string through ${name} -c, which can't be verified to stay inside the worktree; run the command directly instead`,
      }
    }
    // Follow-up B: no `-c`/scriptfile, but the shell reads its script from a
    // non-REPL stdin source — a pipe (`echo … | bash`), a `<`/`<<<`/`<<`/
    // `<<-` redirect/heredoc/here-string, a `<&` fd-dup, or a `<(`
    // process substitution. shell-quote doesn't surface the fed payload,
    // so OCC can't verify it stays inside the worktree → direct escape, same
    // class as `bash -c`. REPL (`bash`, `bash -l`, `bash -i` with no stdin
    // feed) is NOT blocked here.
    const stdinFed = ctx.stdinFromPipe || ctx.stdinFeedOp !== null
    if (stdinFed) {
      const name = basename(argv[shellIdx])
      const source = ctx.stdinFromPipe
        ? 'pipe'
        : stdinSourceLabel(ctx.stdinFeedOp!)
      return {
        mechanism: `${name} (stdin: ${source})`,
        reason: `reads a script from stdin (${source}), which can't be verified to stay inside the worktree; run the command directly instead`,
      }
    }
  }
  // Follow-up B: `su -c`/`runuser -c` — the `-c` string hangs on su/runuser
  // (not `bash -c`), so `findShellEscapeIdx` sees no shell interpreter and
  // the branch above misses it. Auth-gated, but the payload is unverifiable
  // → block (same "unverifiable payload" principle as `bash -c`). Placed
  // AFTER the shell-escape block so a nested `su … bash -c` is still
  // reported as `bash -c` (the more accurate mechanism). argv[0]-only, per
  // the issue scope; `sudo su -c`/`env su -c` (su behind another wrapper) is
  // a known boundary — same direction-2 limit as #194's no-recursive -c.
  const head = basename(argv[0] ?? '').toLowerCase()
  if ((head === 'su' || head === 'runuser') && argv.includes('-c')) {
    return {
      mechanism: `${head} -c`,
      reason: `runs a string through ${head} -c, which can't be verified to stay inside the worktree; run the command directly instead`,
    }
  }
  // `.` matches only at position 0; other builtins match anywhere (official `rLu`).
  const n = argv.find((o, i) => {
    const b = basename(o).toLowerCase()
    return b === '.' ? i === 0 : SHELL_BUILTIN_WRAPPERS.has(b)
  })
  if (n !== undefined && argv.filter(i => i !== n).length > 0) {
    const name = basename(n)
    return {
      mechanism: name,
      reason: `runs a string through ${name}, which can't be verified to stay inside the worktree; run the command directly instead`,
    }
  }
  return null
}

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

  // c[f]: does span f or any LATER span contain a git command word? (official
  // `c[]`, computed right-to-left from `nLu` git-index.) Used by the
  // rLu-builtin-before-git check.
  const hasGitAtOrAfter: boolean[] = new Array(spans.length).fill(false)
  let seenGit = false
  for (let f = spans.length - 1; f >= 0; f--) {
    seenGit = seenGit || spans[f].argv.some(o => isGitToken(o ?? ''))
    hasGitAtOrAfter[f] = seenGit
  }

  for (let f = 0; f < spans.length; f++) {
    const argv = spans[f].argv
    if (argv.length === 0) continue

    // 0. ozg shell-wrapper obfuscation (Follow-up A): eval/source/./… running
    //    a string, xargs/parallel feeding git, find -execdir/-okdir. Branch 3
    //    (builtin string-exec) is NOT git-gated — worktree isolation forbids
    //    unverifiable string-exec via builtins, matching the official `ozg`.
    //    Follow-up B: pass the span's stdin-source flags so a shell reading a
    //    script from a pipe/`<`/`<(` (and `su -c`/`runuser -c`) is also caught.
    const ozgBlock = checkShellWrapperObfuscation(argv, {
      stdinFromPipe: spans[f].stdinFromPipe,
      stdinFeedOp: spans[f].stdinFeedOp,
    })
    if (ozgBlock) return ozgBlock

    // 0b. A `rLu` builtin (eval/source/./…) in a span that precedes a git
    //     command (in this or a later span) → its string payload can't be
    //     verified (official `_` check, gated on `c[f]`).
    if (hasGitAtOrAfter[f]) {
      const builtinIdx = argv.findIndex((o, i) => {
        const b = basename(o).toLowerCase()
        return b === '.' ? i === 0 : SHELL_BUILTIN_WRAPPERS.has(b)
      })
      if (builtinIdx !== -1) {
        const name = basename(argv[builtinIdx])
        return {
          mechanism: name,
          reason: `runs ${name} before a git command, whose string payload can't be verified to leave the worktree alone`,
        }
      }
    }

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
