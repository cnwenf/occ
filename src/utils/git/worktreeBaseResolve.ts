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
 */

import { lstat, readFile, readlink } from 'fs/promises'
import { join, resolve } from 'path'
import { sliceHead } from '../truncateMiddle.js'
import { parseGitConfigValue } from './gitConfigParser.js'

export type WorktreeBaseKind = 'head_fallback' | 'fetch_head' | 'origin_default'

export type RevParseCause =
  | 'empty_answer'
  | 'timed_out'
  | 'not_completed'
  | 'name_missing'
  | 'exit_1_with_output'
  | 'git_refused'
  | 'other_exit'

// Official message fragments (v299 @225547600 region), byte-exact:
const REV_PARSE_OUTPUT_NOT_SHOWN =
  'git rev-parse failed, and its output is not shown.'
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
 */
export function classifyRevParseCause(result: {
  stdout: string
  stderr: string
  code: number
  error?: string
}): RevParseCause {
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
 */
export function buildWorktreeBaseResolveFailureMessage(params: {
  cause: RevParseCause
  kind: WorktreeBaseKind
  repoConfirmed: boolean
  stderrTrimmed: string
  stdoutTrimmed: string
}): string {
  const { cause, kind, repoConfirmed, stderrTrimmed, stdoutTrimmed } = params
  if (cause === 'empty_answer') {
    return 'git rev-parse succeeded but printed no commit id.'
  }
  if (cause === 'timed_out') {
    return 'git rev-parse timed out.'
  }
  if (cause === 'not_completed') {
    return 'git failed to start, or was stopped before it finished.'
  }
  if (!repoConfirmed) {
    return REPO_UNCONFIRMED
  }
  if (cause === 'exit_1_with_output') {
    if (kind === 'origin_default') {
      return `${REV_PARSE_OUTPUT_NOT_SHOWN} The fetch from origin succeeded, so it may be that this repository has no such ref afterwards (for example a single-branch clone of another branch, or a bare clone without a fetch refspec), ${MAY_NOT_BE_WORKING_WHICH} ${BASE_REF_HEAD_HINT}`
    }
    if (kind === 'fetch_head') {
      return `${REV_PARSE_OUTPUT_NOT_SHOWN} The fetch of the PR/MR succeeded, so it may be that FETCH_HEAD names no commit afterwards, ${MAY_NOT_BE_WORKING_WHICH}`
    }
    return `${REV_PARSE_OUTPUT_NOT_SHOWN} It may be that HEAD does not point to a commit (for example a new repository, or a branch without a commit yet), ${MAY_NOT_BE_WORKING_WHICH}`
  }
  if (cause !== 'name_missing') {
    // git_refused / other_exit — quote the most diagnostic stderr line.
    const line = pickDisplayStderrLine(stderrTrimmed)
    const said =
      quotedGitOutput(line, { head: 60, tail: 120 }) ||
      (stderrTrimmed === '' && stdoutTrimmed === ''
        ? 'nothing'
        : 'nothing that can be shown here')
    return `git rev-parse failed (git said ${said}).`
  }
  if (kind === 'origin_default') {
    return `the fetch from origin succeeded, but git rev-parse returned no commit for this ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`
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
