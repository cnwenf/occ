/**
 * Official Claude Code 2.1.299 (#146 + #147) worktree-creation error reporting.
 *
 * #146 — when the base commit doesn't resolve, the error now says HOW the
 * lookup ended (exit code / empty answer / timeout) and the LIKELY reasons,
 * instead of a bare "git rev-parse failed". Byte-exact port of the official
 * `DQt` classifier (v299 ELF @225547600):
 *
 *   Se = H===0 ? "empty_answer" : V ? "timed_out" : G===void 0 ? "not_completed"
 *        : G===1 ? (_e===""&&Q==="" ? "name_missing" : "exit_1_with_output")
 *        : G===128 ? "git_refused" : "other_exit"
 *
 * OCC deviation: execFileNoThrowWithCwd returns `{stdout, stderr, code,
 * error?}` with no separate `timedOut`/`exitCode` fields (code = exitCode ?? 1).
 * `timed_out` / `not_completed` are approximated from the wrapper's `error`
 * string ("timed out" → timed_out; spawn failures → not_completed).
 *
 * #147 — a worktree root whose `.git` is a FILE or SYMLINK pointing at a BARE
 * repository now fails with an explanatory message (official throw inside
 * `MYe` @225552076, detection helper `aSs` @221606923).
 *
 * Official Claude Code 2.1.302 (#23) — git ≥2.56 emits `fatal: gitfile does
 * not point to a valid repository` when a stray `.git` FILE's gitdir target
 * doesn't exist. Official v301 classified that stderr as "error" → worktree
 * create/resume refused; v302 extended the shared no-repo predicate (v301
 * `GWt` → v302 `pGt` @243939195):
 *
 *   function pGt(e){return/not a git repository/i.test(e)||/gitfile does not point to a valid repository/i.test(e)}
 *
 * so BOTH messages classify as no-repo → the worktree paths decline gracefully
 * (same class as "not a git repository") instead of hard-erroring. Ported here
 * as `isNoRepoGitStderr` + the `no_repo` cause in `classifyRevParseCause`.
 * No git-version check — the official has none; the stderr text is the signal.
 *
 * Official Claude Code 2.1.306 (#P8) — the resolver (official `yot`
 * @250451600) parameterizes the command word in every catalog message:
 * `w = exactRef===!0 ? "show-ref" : "rev-parse"`, so the detail texts read
 * `git ${w} succeeded but printed no commit id.` / `git ${w} timed out.` /
 * `git ${w} failed, and its output is not shown.` / `git ${w} failed (git
 * said …).` — and the origin_default `name_missing` phrase CHANGED from the
 * v299 `returned no commit for this ref` to `found no such ref afterwards`
 * (v304 has the old phrase ×2, v306 the new one ×2, old one ×0). Ported here
 * as the optional `commandLabel` parameter (default `'rev-parse'` keeps every
 * pre-306 caller's strings byte-identical).
 */

import { lstat, readFile, readlink } from 'fs/promises'
import { join, resolve } from 'path'
import { sliceHead } from '../truncateMiddle.js'
import { parseGitConfigValue } from './gitConfigParser.js'

export type WorktreeBaseKind = 'head_fallback' | 'fetch_head' | 'origin_default'

/**
 * Official v306 `w` (@250451652): `w = exactRef===!0 ? "show-ref" :
 * "rev-parse"` — the resolver command named in every failure-catalog message.
 */
export type WorktreeResolveCommandLabel = 'rev-parse' | 'show-ref'

export type RevParseCause =
  | 'empty_answer'
  | 'timed_out'
  | 'not_completed'
  | 'name_missing'
  | 'exit_1_with_output'
  | 'git_refused'
  | 'no_repo'
  | 'other_exit'

/**
 * Official v302 `pGt` (@243939195), byte-exact predicate — the shared no-repo
 * classifier for git stderr on worktree paths:
 *
 *   /not a git repository/i.test(e) ||
 *   /gitfile does not point to a valid repository/i.test(e)
 *
 * The second regex is the 2.1.302 (#23) addition: git ≥2.56 says `fatal:
 * gitfile does not point to a valid repository` when a `.git` FILE's gitdir
 * target doesn't exist (older git says `fatal: not a git repository: <path>`
 * for the same layout). Both mean "this directory is not a repo" — proceed /
 * decline gracefully, never a hard refusal.
 */
export function isNoRepoGitStderr(stderr: string): boolean {
  return (
    /not a git repository/i.test(stderr) ||
    /gitfile does not point to a valid repository/i.test(stderr)
  )
}

// Official message fragments (v299 @225547600 region; v306 @250452500 region
// parameterizes the command word), byte-exact:
/** Official v306 `Ge`: `git ${w} failed, and its output is not shown.` */
function gitOutputNotShown(commandLabel: WorktreeResolveCommandLabel): string {
  return `git ${commandLabel} failed, and its output is not shown.`
}
const GIT_THAT_CC_RUNS =
  'the git that Claude Code runs (which may not be the one in your shell)'
const MAY_NOT_BE_WORKING_WHICH = `or that ${GIT_THAT_CC_RUNS} is not working. Running git status in this repository may show which.`
const MAY_NOT_BE_WORKING_MORE = `It may also be that ${GIT_THAT_CC_RUNS} is not working. Running git status in this repository may show more.`
// OCC note: the `worktree.baseRef` settings key exists in OCC's schema
// (src/utils/settings/types.ts) so this hint stays accurate, verbatim.
const BASE_REF_HEAD_HINT =
  'To start worktrees from your current HEAD instead, set worktree.baseRef to "head" in Claude Code settings.'
const REPO_UNCONFIRMED =
  "Claude Code could not confirm that this repository's .git entry belongs to the folder it is in (for example a symlinked .git, or a .git file that points elsewhere), so no worktree can be made from it."

/** Surrogate-safe tail slice (official `Ql`, used by the `d6` truncator). */
function sliceTail(value: string, length: number): string {
  if (length <= 0) {
    return ''
  }
  const start = Math.max(0, value.length - length)
  const sliced = value.slice(start)
  // Drop a leading low surrogate whose high-surrogate pair was cut off.
  const first = sliced.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) {
    return sliced.slice(1)
  }
  return sliced
}

/**
 * Official `d6` (@214767927), byte-exact semantics:
 *   `if(t.length<=n+e)return t; head + "…" + tail`
 */
function truncateHeadTail(
  value: string,
  head: number,
  tail: number,
): string {
  if (value.length <= head + tail) {
    return value
  }
  const headPart = head > 0 ? sliceHead(value, head) : ''
  const tailPart = tail > 0 ? sliceTail(value, tail) : ''
  return `${headPart}…${tailPart}`
}

/**
 * Official `Xl` (@214862998): collapse whitespace, NFC-normalize, normalize
 * quote characters to `'`, strip control characters, trim, wrap in curly
 * quotes, and optionally middle-truncate with `…`.
 *
 * OCC deviation: the official `s`/`i` cleanup regexes are minified constants;
 * this port folds them into one smart-quote normalization + one control-char
 * strip, which covers the same observable behavior for git stderr lines.
 */
export function quotedGitOutput(
  line: string,
  opts?: { head: number; tail: number },
): string {
  const normalized = line
    .replace(/\s+/g, ' ')
    .normalize('NFC')
    .replace(/[“”ʻʼ]/g, "'")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char strip (official Xl cleanup)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim()
  if (!normalized) {
    return ''
  }
  const body = opts
    ? truncateHeadTail(normalized, opts.head, opts.tail)
    : normalized
  return `“${body}”`
}

/**
 * Official stderr-line picker from `DQt`: cap at 65536 bytes, split lines,
 * cap each at 4096, then prefer the first `fatal:`/`error:` line, then the
 * first `warning:` line, then the first line that normalizes non-empty.
 */
export function pickDisplayStderrLine(stderrTrimmed: string): string {
  const lines = sliceHead(stderrTrimmed, 65536)
    .split('\n')
    .map(line => sliceHead(line, 4096))
  return (
    lines.find(line => /^(fatal|error):/.test(line)) ??
    lines.find(line => line.startsWith('warning:')) ??
    lines.find(line => quotedGitOutput(line) !== '') ??
    ''
  )
}

/**
 * Cause classification for a failed `git rev-parse --verify --quiet <base>`.
 * Mirrors the official `Se` ternary chain; see the header comment for the
 * timed_out/not_completed adaptation to OCC's exec wrapper.
 *
 * Official 2.1.302 (#23): the no-repo stderr predicate (`pGt`) is checked
 * FIRST — `if(pGt(n.stderr))return"no-repo"` — so "not a git repository" AND
 * git ≥2.56's "gitfile does not point to a valid repository" both classify as
 * `no_repo` (decline gracefully) instead of falling through to `git_refused`
 * (hard error).
 */
export function classifyRevParseCause(result: {
  stdout: string
  stderr: string
  code: number
  error?: string
}): RevParseCause {
  if (isNoRepoGitStderr(result.stderr)) {
    return 'no_repo'
  }
  const errorText = result.error ?? ''
  if (errorText.includes('timed out')) {
    return 'timed_out'
  }
  if (result.code === 0) {
    return 'empty_answer'
  }
  if (/ENOENT|EACCES|spawn/i.test(errorText) && result.code === 1) {
    return 'not_completed'
  }
  if (result.code === 1) {
    return result.stderr.trim() === '' && result.stdout.trim() === ''
      ? 'name_missing'
      : 'exit_1_with_output'
  }
  if (result.code === 128) {
    return 'git_refused'
  }
  return 'other_exit'
}

/**
 * Official `Xe` message from `DQt` (v299 @225547600), byte-exact per cause /
 * kind. `repoConfirmed` = the official `be === "yes"` (`.git` layout resolved).
 *
 * Note: the `no_repo` cause (2.1.302 #23) never reaches this catalog — the
 * worktree call site intercepts it and declines with the not-in-a-git-repo
 * message instead (the official treats no-repo as proceed/decline, not as a
 * base-resolve failure). If called defensively with `no_repo`, it falls into
 * the generic quoted-stderr branch below.
 */
export function buildWorktreeBaseResolveFailureMessage(params: {
  cause: RevParseCause
  kind: WorktreeBaseKind
  repoConfirmed: boolean
  stderrTrimmed: string
  stdoutTrimmed: string
  /** Official v306 `w` — the resolver command named in the detail text. */
  commandLabel?: WorktreeResolveCommandLabel
}): string {
  const { cause, kind, repoConfirmed, stderrTrimmed, stdoutTrimmed } = params
  const commandLabel = params.commandLabel ?? 'rev-parse'
  if (cause === 'empty_answer') {
    return `git ${commandLabel} succeeded but printed no commit id.`
  }
  if (cause === 'timed_out') {
    return `git ${commandLabel} timed out.`
  }
  if (cause === 'not_completed') {
    return 'git failed to start, or was stopped before it finished.'
  }
  if (!repoConfirmed) {
    return REPO_UNCONFIRMED
  }
  if (cause === 'exit_1_with_output') {
    const outputNotShown = gitOutputNotShown(commandLabel)
    if (kind === 'origin_default') {
      return `${outputNotShown} The fetch from origin succeeded, so it may be that this repository has no such ref afterwards (for example a single-branch clone of another branch, or a bare clone without a fetch refspec), ${MAY_NOT_BE_WORKING_WHICH} ${BASE_REF_HEAD_HINT}`
    }
    if (kind === 'fetch_head') {
      return `${outputNotShown} The fetch of the PR/MR succeeded, so it may be that FETCH_HEAD names no commit afterwards, ${MAY_NOT_BE_WORKING_WHICH}`
    }
    return `${outputNotShown} It may be that HEAD does not point to a commit (for example a new repository, or a branch without a commit yet), ${MAY_NOT_BE_WORKING_WHICH}`
  }
  if (cause !== 'name_missing') {
    // git_refused / other_exit — quote the most diagnostic stderr line.
    const line = pickDisplayStderrLine(stderrTrimmed)
    const said =
      quotedGitOutput(line, { head: 60, tail: 120 }) ||
      (stderrTrimmed === '' && stdoutTrimmed === ''
        ? 'nothing'
        : 'nothing that can be shown here')
    return `git ${commandLabel} failed (git said ${said}).`
  }
  if (kind === 'origin_default') {
    // v306 phrase: `git ${w} found no such ref afterwards` (was v299
    // `git rev-parse returned no commit for this ref afterwards`).
    return `the fetch from origin succeeded, but git ${commandLabel} found no such ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`
  }
  if (kind === 'fetch_head') {
    return `the fetch of the PR/MR succeeded, but git rev-parse returned no commit for FETCH_HEAD afterwards. ${MAY_NOT_BE_WORKING_MORE}`
  }
  return `git rev-parse returned no commit for HEAD (for example in a new repository, or on a branch without a commit yet), so Claude Code has nothing to base a worktree on. ${MAY_NOT_BE_WORKING_MORE}`
}

/** Official `kind` ternary from the DQt call site (@225554140). */
export function worktreeBaseKindFor(baseBranch: string): WorktreeBaseKind {
  return baseBranch === 'HEAD'
    ? 'head_fallback'
    : baseBranch === 'FETCH_HEAD'
      ? 'fetch_head'
      : 'origin_default'
}

/**
 * Official `qB` (@221641974) path display: paths holding hidden or control
 * characters are replaced with a fixed sentence.
 *
 * OCC deviation: the official `S8t` also screens "hidden" path segments via a
 * minified helper (`amr`); this port screens control characters and the line
 * separators only, which covers the injection concern the message exists for.
 */
export function displayPathForError(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char matcher (official qB path-display gate)
  return /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(path)
    ? 'a path not shown here because it holds hidden or control characters'
    : path
}

/**
 * Official 2.1.299 (#147) message, byte-exact (v299 @225552076 region):
 *   `The .git in ${qB(e)} points to a bare repository, so Claude Code can't
 *    create a worktree from this directory. Start Claude Code in one of that
 *    repository's worktrees instead (git worktree add makes one).`
 */
export function bareLayoutRootMessage(repoRoot: string): string {
  return `The .git in ${displayPathForError(repoRoot)} points to a bare repository, so Claude Code can't create a worktree from this directory. Start Claude Code in one of that repository's worktrees instead (git worktree add makes one).`
}

/**
 * Official `aSs` (@221606923): true only when `<repoRoot>/.git` is a FILE or
 * SYMLINK (not a directory) whose resolved gitdir target is a BARE repository
 * — the linked-worktree-of-a-bare-clone layout, where `git worktree add` from
 * this directory cannot produce a sane nested worktree.
 *
 * OCC adaptation: the official walks `cte(R(n,t))` + `v(o)` (minified gitdir
 * resolver + is-bare check); this port resolves the pointer, follows a
 * `commondir` file when present (linked gitdirs keep `core.bare` in the common
 * config), and reads `core.bare` from that config.
 */
export async function gitFilePointsToBareRepository(
  repoRoot: string,
): Promise<boolean> {
  const gitPath = join(repoRoot, '.git')
  let stats
  try {
    stats = await lstat(gitPath)
  } catch {
    return false
  }
  let target: string | null = null
  try {
    if (stats.isSymbolicLink()) {
      target = await readlink(gitPath)
    } else if (stats.isFile()) {
      const content = (await readFile(gitPath, 'utf-8')).trim()
      if (content.startsWith('gitdir:')) {
        target = content.slice('gitdir:'.length).trim()
      }
    }
  } catch {
    return false
  }
  if (!target) {
    return false
  }
  const gitDir = resolve(repoRoot, target)
  // Linked worktree gitdirs (<bare>/worktrees/<name>) carry a `commondir`
  // file; `core.bare` lives in the common config.
  let configDir = gitDir
  try {
    const commondir = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim()
    if (commondir) {
      configDir = resolve(gitDir, commondir)
    }
  } catch {
    // No commondir file — gitDir itself holds the config.
  }
  const bare = await parseGitConfigValue(configDir, 'core', null, 'bare')
  return bare?.toLowerCase() === 'true'
}
