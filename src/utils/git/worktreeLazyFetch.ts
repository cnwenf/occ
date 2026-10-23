/**
 * Official Claude Code 2.1.309 changelog item 56 — worktree lazy-fetch
 * hardening + partial-clone pre-fetch.
 *
 * Source of truth (BIN309, byte-verified via read-only forensics; the official
 * binary was NEVER executed). The subsystem lives in one minified module around
 * @252742600..@252780600. Recovered pieces (official symbol -> OCC name):
 *
 *   W1r=2, G1r=67108864, Lst="more objects are missing than can be listed",
 *   z1r=10, RGr=2                              -> constants below
 *   q1r()  = Jr("tengu_eager_balloon",{safe:!0}) -> isEagerBalloonEnabled()
 *   yne({inForce})  @252745690                   -> lazyFetchEnv()
 *   Dst(e)          @252749140                   -> isSafeRemoteName()
 *   Mxe(e)          @252749230                   -> displayRemoteName()
 *   Q1r(e)                                       -> promisorDisplayList()
 *   yxo(e,n,r)      @247381540                   -> detectPartialClone()
 *   Kn=/^remote\.(.*)\.(promisor|partialclonefilter)$/s @247381416
 *   J1r(e,n)        @252749560                   -> promisorRemoteHasUrl()
 *   eGr(e,n)        @252749700                   -> remoteUploadPackArg()
 *   oMn()           @252753180                   -> isWorktreeFetchSandboxed()
 *   QPn(e,n,r)      @252752560                   -> listMissingObjects()
 *   Cke/zXe/SF      @247407119                   -> containsHiddenOrControlChars()/guardHiddenChars()/displaySubmodulePath()
 *   Fst(e,{submodule},r) @252743990              -> formatLazyFetchFailure()
 *   ZPn(e,n)        @252742919                   -> computePartialCloneContext()
 *   $st(e,n,{promisors},s,h) @252745747          -> prefetchMissingObjects()
 *   g6r/ase/oli     @240877979/@240878215        -> ALTERNATE_REFS_* / GIT_UPLOAD_PACK_DEFAULT
 *   worktree add spawn @252779841:
 *     env: WNt(e,{LC_ALL:"C",...yne(be)})  -> buildMergedGitEnv({LC_ALL:'C', ...lazyFetchEnv(ctx)})
 *
 * -- DECLARED DEVIATIONS (STOP-on-ambiguous / bounded port) ------------------
 * 1. Sparse side-dir resource `nMn`/`Oxe`/`eMn` (blob hashing + narrowing via
 *    the `worktree.sparsePaths` setting, and the `--filter=sparse:oid=` rev-list
 *    variant) is NOT recovered. `prefetchMissingObjects` therefore enumerates
 *    the WHOLE tree via `listMissingObjects` (QPn's own non-sparse path) and
 *    takes NO sparse argument. sparsePaths narrowing is omitted.
 * 2. Submodule superproject trust model (`V1r`/`Y1r`/`X1r`/`a8`/`superproject`)
 *    in `ZPn` is NOT recovered. `computePartialCloneContext` ports the
 *    non-submodule branch only (official `S===null`); the `submodule` key is
 *    never produced, so `formatLazyFetchFailure`'s submodule branch exists
 *    (ported verbatim) but is unreachable here.
 * 3. `oMn` gates on `isSandboxingEnabled() && MA()==="strict"`. OCC has no
 *    strict/non-strict sandbox split (`isStrictSandboxModeConfigured` is not
 *    ported - see sandbox-adapter.ts:1892). OCC's Bash sandbox IS the
 *    restricted-network environment official strict mode denotes, so the
 *    strict leg maps to `SandboxManager.isSandboxingEnabled()`. The fail-closed
 *    `catch -> true` is preserved verbatim. `EGr`'s path-scan legs (`Sne`) are
 *    omitted; only the sandbox predicate is consulted.
 * 4. `q1r` reads GrowthBook `tengu_eager_balloon` with `safe:!0` (default ON).
 *    OCC's GrowthBook is stubbed and the flag is safe-by-default, so
 *    `isEagerBalloonEnabled()` returns the safe default `true`.
 * 5. The git-stderr formatter `Gc` (wraps `zXe(...)` in the `git said:` clause
 *    and QPn's error return) was NOT independently recoverable in this module
 *    scope; per the no-invention rule it is treated as IDENTITY (the sanitized
 *    stderr is surfaced as-is). Every FIXED diagnostic string is byte-verbatim;
 *    only the dynamic git-stderr embedding omits Gc's unknown transform.
 * 6. `yO`/`sA` (normalize + secret-redact stderr) are approximated by a single
 *    `sanitizeGitStderr` (ANSI-strip + credential-redaction + trim); the
 *    security-relevant redaction is preserved.
 * 7. OCC's exec wrapper reports `{stdout,stderr,code,error?}` without separate
 *    `exitCode`/`timedOut`/`maxBufferExceeded` fields, so those are detected
 *    from the `error`/`code` shape (same approximation as the resolveGitRef
 *    port). Repository pin `UF(e)`->GitRepositoryInfo is not fed to the env
 *    builders; git discovery relies on `cwd` (matches OCC's existing worktree
 *    git spawns).
 */
import { logForDebugging } from '../debug.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { redactCredentialsInText } from '../redactUrl.js'
import { SandboxManager } from '../sandbox/sandbox-adapter.js'
import { INVISIBLE_CHAR_RE } from '../secretRedaction/invisibleChars.js'
import {
  GIT_ALLOW_PROTOCOL_NONE,
  GIT_HOOKS_DISABLED_ARGS,
  type GitEnv,
  buildHardenedGitEnv,
  buildMergedGitEnv,
} from './gitEnv.js'

// -- Constants (verbatim from BIN309) ----------------------------------------

/** Official `G1r` @252742700 - rev-list maxBuffer (64 MiB). */
export const LIST_MISSING_MAX_BUFFER = 67_108_864

/** Official `Lst` @252742730 - the "too many to list" sentinel string. */
export const MORE_OBJECTS_THAN_LISTABLE =
  'more objects are missing than can be listed'

/** Official `z1r` @252742790 - default shared fetch budget, in minutes. */
export const DEFAULT_FETCH_BUDGET_MINUTES = 10

/** Official `W1r` @252742690 - extra fetch attempts allowed beyond #promisors. */
export const FETCH_RETRY_SLACK = 2

/** Official `RGr` - the fast-resume path's smaller budget (minutes). */
export const RESUME_FETCH_BUDGET_MINUTES = 2

/** Official `ase` @240878215 - default upload-pack for the promisor fetch. */
export const GIT_UPLOAD_PACK_DEFAULT = '--upload-pack=git-upload-pack'

/** Official `g6r` @240877979 - alternate-refs command neutralizer. */
export const ALTERNATE_REFS_COMMAND =
  'f() { git --git-dir="$1" for-each-ref --format=\'%(objectname)\'; }; f'

/** Official `oli` @240878240 - `["-c", core.alternateRefsCommand=<g6r>]`. */
export const ALTERNATE_REFS_ARGS: readonly string[] = Object.freeze([
  '-c',
  `core.alternateRefsCommand=${ALTERNATE_REFS_COMMAND}`,
])

/** Official `Kn` @247381416 - promisor / partialclonefilter config matcher. */
export const PARTIAL_CLONE_CONFIG_RE =
  /^remote\.(.*)\.(promisor|partialclonefilter)$/s

/** Official detector inside `Fst` @252744020 - stderr shapes that mean "the
 *  checkout failed because on-demand fetching was off / a promisor fetch failed
 *  / a transport was disallowed". */
export const LAZY_FETCH_FAILURE_RE =
  /lazy fetching disabled|could not fetch [0-9a-f]+ from promisor remote|transport '[^']*' not allowed/

/** Official `yxo` falsy-config values: a `remote.*.promisor` set to any of
 *  these does NOT make the remote a promisor. */
const FALSY_CONFIG_VALUES: readonly string[] = Object.freeze([
  'false',
  'no',
  'off',
  '0',
  '',
])

/** C0 + DEL + C1 control-char matcher (part of the `Cke` approximation). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: official-derived Cke approximation (BIN309 @247407119) - the C0/C1 control ranges ARE the check
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/

// -- Types -------------------------------------------------------------------

/** Official `yxo` result. `null` = confirmed not-a-partial-clone (config exit
 *  1); `undefined` = the config read failed for another reason. */
export type PartialCloneDetection =
  | { readonly extension: string | null; readonly remotes: readonly string[] }
  | null
  | undefined

/** Official `ZPn`/`YPn` result - whether lazy-fetch is disabled (`inForce`) and
 *  which promisor remotes to pre-fetch from. */
export interface PartialCloneContext {
  readonly inForce: boolean
  readonly promisors: readonly string[]
}

/** Official `$st` result. */
export interface PrefetchResult {
  readonly failure: string | null
  readonly fetches: number
}

// -- Small verbatim helpers --------------------------------------------------

/** Official `yne` @252745690: `e?{GIT_NO_LAZY_FETCH:"1",GIT_ALLOW_PROTOCOL:jRe}:{}`.
 *  `jRe` = GIT_ALLOW_PROTOCOL_NONE ("/") - no transport allowed during the
 *  lazy-fetch-disabled checkout. */
export function lazyFetchEnv(ctx: {
  readonly inForce: boolean
}): GitEnv | undefined {
  return ctx.inForce
    ? { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: GIT_ALLOW_PROTOCOL_NONE }
    : undefined
}

/** Official `Dst` @252749140 - a remote name safe to show / pass to git. */
export function isSafeRemoteName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(name)
}

/** Official `Mxe` @252749230 - quote a safe name, else the verbatim refusal. */
export function displayRemoteName(name: string): string {
  return isSafeRemoteName(name)
    ? `"${name}"`
    : '(name not shown: it does not begin with a letter or digit, or has characters other than letters, digits and . _ / @ + -)'
}

/** Official `Cke` @247407119 (approximated): true when the text holds a C0/C1
 *  control char or an invisible/zero-width char. */
export function containsHiddenOrControlChars(text: string): boolean {
  return CONTROL_CHAR_RE.test(text) || INVISIBLE_CHAR_RE.test(text)
}

/** Official `zXe` - hide text that holds hidden/control chars. */
export function guardHiddenChars(text: string, label: string): string {
  return text.split(/\r?\n/).some(line => containsHiddenOrControlChars(line))
    ? `${label} is not shown here because it holds hidden or control characters`
    : text
}

/** Official `SF` @247407286 - submodule-path display (used only by Fst's
 *  submodule branch, which the bounded port never reaches). */
export function displaySubmodulePath(path: string): string {
  return containsHiddenOrControlChars(path)
    ? 'a path not shown here because it holds hidden or control characters'
    : path
}

/** Official `Q1r` - flatten a detection into an ordered promisor list, moving
 *  the `extensions.partialclone` value (itself a remote name) to the end. */
export function promisorDisplayList(
  detection: PartialCloneDetection,
): readonly string[] {
  if (detection === null || detection === undefined) {
    return []
  }
  const { extension, remotes } = detection
  return extension === null
    ? remotes
    : [...remotes.filter(remote => remote !== extension), extension]
}

/** Deviation #6: `yO`+`sA` approximated by ANSI-strip + credential-redaction +
 *  trim. Redaction is preserved so surfaced stderr cannot leak a token/URL. */
export function sanitizeGitStderr(stderr: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: official-derived ANSI strip regex (yO approximation) - the ESC prefix IS the point
  const withoutAnsi = stderr.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  return redactCredentialsInText(withoutAnsi).trim()
}

// -- git config / enumeration (official yxo / J1r / eGr / QPn) ----------------

/** Config-read env: official `yt`/`od` use the FULL hardened builder `Ts`. */
function hardenedEnv(): GitEnv {
  return buildHardenedGitEnv({})
}

/** Official `yxo` @247381540 - read `extensions.partialclone` +
 *  `remote.*.(promisor|partialclonefilter)` via `git config --get-regexp`. */
export async function detectPartialClone(
  repoPath: string,
): Promise<PartialCloneDetection> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      ...GIT_HOOKS_DISABLED_ARGS,
      'config',
      '--includes',
      '--null',
      '--get-regexp',
      '^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$',
    ],
    {
      cwd: repoPath,
      env: hardenedEnv() as NodeJS.ProcessEnv,
      stdin: 'ignore',
      timeout: 5000,
      preserveOutputOnError: false,
    },
  )
  if (result.code !== 0) {
    // git config --get-regexp exits 1 when nothing matches (not a partial clone).
    return result.code === 1 ? null : undefined
  }
  let extension: string | null = null
  const remotes: string[] = []
  for (const entry of result.stdout.split('\u0000')) {
    const newlineIdx = entry.indexOf('\n')
    const key = newlineIdx === -1 ? entry : entry.slice(0, newlineIdx)
    const value = newlineIdx === -1 ? 'true' : entry.slice(newlineIdx + 1)
    if (key === 'extensions.partialclone') {
      extension = value === '' ? extension : value
      continue
    }
    const [, name, kind] = PARTIAL_CLONE_CONFIG_RE.exec(key) ?? []
    if (
      name !== undefined &&
      !remotes.includes(name) &&
      (kind === 'partialclonefilter' ||
        !FALSY_CONFIG_VALUES.includes(value.toLowerCase()))
    ) {
      remotes.push(name)
    }
  }
  return { extension, remotes }
}

/** Official `J1r` @252749560 - does `remote.<name>.url` resolve to a value? */
export async function promisorRemoteHasUrl(
  repoPath: string,
  remote: string,
): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [...GIT_HOOKS_DISABLED_ARGS, 'config', '--get', `remote.${remote}.url`],
    {
      cwd: repoPath,
      env: hardenedEnv() as NodeJS.ProcessEnv,
      stdin: 'ignore',
    },
  )
  return result.code === 0 && result.stdout.trim() !== ''
}

/** Official `eGr` @252749700 - `remote.<name>.uploadpack` -> `--upload-pack=...`. */
export async function remoteUploadPackArg(
  repoPath: string,
  remote: string,
): Promise<string | undefined> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      ...GIT_HOOKS_DISABLED_ARGS,
      'config',
      '--local',
      '--get',
      `remote.${remote}.uploadpack`,
    ],
    {
      cwd: repoPath,
      env: hardenedEnv() as NodeJS.ProcessEnv,
      stdin: 'ignore',
    },
  )
  const value = result.stdout.trim()
  return result.code === 0 && value !== '' ? `--upload-pack=${value}` : undefined
}

/** Official `oMn` @252753180 - see deviation #3 (strict leg -> OCC sandbox). */
export function isWorktreeFetchSandboxed(): boolean {
  try {
    return SandboxManager.isSandboxingEnabled()
  } catch {
    return true
  }
}

/** Official `q1r` - GrowthBook `tengu_eager_balloon` `safe:!0` default (#4). */
export function isEagerBalloonEnabled(): boolean {
  return true
}

/** Official `Ze(t,n)` - the substring before the first `n` (extracts the OID
 *  from a `?<oid> <path>` rev-list line). */
function firstFieldBefore(text: string, separator: string): string {
  const idx = text.indexOf(separator)
  return idx === -1 ? text : text.slice(0, idx)
}

/** Official `QPn` @252752560 - whole-tree missing-object enumeration. Returns
 *  the OID list on success, or a diagnostic STRING (the `Lst` sentinel or a
 *  git-error message) on failure. Deviation #1: no sparse variant. */
export async function listMissingObjects(
  repoPath: string,
  commit: string,
): Promise<readonly string[] | string> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      ...GIT_HOOKS_DISABLED_ARGS,
      'rev-list',
      '--objects',
      '--quiet',
      '--missing=print',
      '--no-walk',
      commit,
      '--',
    ],
    {
      cwd: repoPath,
      env: hardenedEnv() as NodeJS.ProcessEnv,
      stdin: 'ignore',
      maxBuffer: LIST_MISSING_MAX_BUFFER,
    },
  )
  if (result.code !== 0) {
    logForDebugging(
      `[worktree] could not list the missing objects of ${commit}: ${result.stderr}`,
      { level: 'warn' },
    )
    // Deviation #7: maxBufferExceeded approximated from the execa error text.
    const maxBufferExceeded =
      typeof result.error === 'string' &&
      /maxBuffer|max buffer/i.test(result.error)
    if (maxBufferExceeded) {
      return MORE_OBJECTS_THAN_LISTABLE
    }
    // Deviation #5: Gc treated as identity over the zXe-guarded stderr.
    return guardHiddenChars(sanitizeGitStderr(result.stderr), "git's error")
  }
  return result.stdout
    .split('\n')
    .filter(line => line.startsWith('?'))
    .map(line => firstFieldBefore(line.slice(1), ' '))
}

// -- Diagnostics (official Fst + $st inline messages) -------------------------

/** Official `Fst` @252743990 - the checkout-failure explanation appended to a
 *  `git worktree add` error when lazy fetching was off. `submodule` is never
 *  supplied by the bounded port (deviation #2), so the non-submodule branch is
 *  what fires; the submodule branch is ported verbatim for completeness. */
export function formatLazyFetchFailure(
  stderr: string,
  ctx: { readonly submodule?: string } = {},
  baseCommit?: string,
): string {
  if (!LAZY_FETCH_FAILURE_RE.test(stderr)) {
    return ''
  }
  const short = baseCommit ? baseCommit.slice(0, 12) : '<the base commit>'
  const submodule = ctx.submodule
  if (submodule !== undefined) {
    const folder = submodule
      ? `, "${displaySubmodulePath(submodule)}",`
      : ' (the folder its ".git" file points to)'
    return `\nThis checkout ran with git's on-demand fetching switched off, and git needed an object this repository does not have. This repository is a git submodule, and its git folder${folder} is kept inside the superproject's git folder, where commands running in the Bash sandbox can write. Because any git command run in the submodule follows what that folder holds, Claude Code fetched nothing ahead of time and cannot safely suggest a command to run there; while a sandboxed session that can write there is still running, the folder cannot be trusted at all. Once no such session is running, look through that folder for settings that should not be there — for example, in "config" (and "config.worktree", if present) a changed remote address, an upload-pack or ssh command, or an include line; a file named "commondir"; scripts in "hooks" that you did not install; or any other setting you did not make — and remove those. Then fetch the missing objects for commit ${short} in the submodule yourself and try again.`
  }
  return `\nThis checkout ran with git's on-demand fetching switched off, and git needed an object this repository does not have. If the repository is a partial clone, run "git archive -o objects.tar ${short}" (git fetches the commit's missing files — in a sparse checkout, the whole tree's; delete objects.tar afterwards) in its main checkout and try again; otherwise check it with "git fsck".`
}

// -- ZPn (reduced) + $st (bounded) -------------------------------------------

/** Official `ZPn` @252742919 reduced to the non-submodule branch (deviation
 *  #2). `isSandboxed` mirrors the official `EGr`->`oMn` callback. */
export async function computePartialCloneContext(
  repoPath: string,
  isSandboxed: () => boolean | Promise<boolean>,
): Promise<PartialCloneContext> {
  if (!isEagerBalloonEnabled()) {
    return { inForce: false, promisors: [] }
  }
  const promisors = promisorDisplayList(await detectPartialClone(repoPath))
  // Official: `if(H.length===0)return{inForce:!0,promisors:H}` - lazy fetch is
  // disabled unconditionally when there is nothing to pre-fetch from.
  if (promisors.length === 0) {
    return { inForce: true, promisors: [] }
  }
  // Official: `if(!await n(...))return YPn` - with promisors present, only
  // disable lazy fetch (and pre-fetch) when the checkout runs sandboxed.
  if (!(await isSandboxed())) {
    return { inForce: false, promisors: [] }
  }
  return { inForce: true, promisors }
}

function moreObjectsDiagnostic(shortCommit: string): string {
  return `This repository is a partial clone, and commit ${shortCommit} needs more than about 1.5 million objects it does not have, too many to fetch before checking it out. Limit the worktree with the worktree.sparsePaths setting, or check that commit out once in the main checkout so git fetches them, then try again.`
}

function couldNotListDiagnostic(shortCommit: string, detail: string): string {
  return `This repository is a partial clone, and git could not list the objects needed for commit ${shortCommit} (${detail}), so none were fetched before the checkout. Check the repository with "git fsck" and try again.`
}

function promisorNoUrlDiagnostic(
  remote: string,
  shortCommit: string,
  count: number,
): string {
  const objects = count === 1 ? 'object' : `${count} objects`
  return isSafeRemoteName(remote)
    ? `This repository is a partial clone, but its promisor remote "${remote}" has no URL in the repository's git config (remote.${remote}.url is not set), so the ${objects} needed for commit ${shortCommit} could not be fetched. Set it with "git config remote.${remote}.url <url>" and try again.`
    : `This repository is a partial clone, but its promisor remote ${displayRemoteName(remote)} cannot be fetched from safely (its name begins with "-", which git would read as an option, or it has no URL in the repository's git config), so the ${objects} needed for commit ${shortCommit} could not be fetched. Look through the [remote "…"] sections and the extensions.partialclone line in that config, and in any file it includes, for a remote you did not set up; correct or remove it, then try again.`
}

function budgetExhaustedDiagnostic(
  shortCommit: string,
  fetches: number,
  remainingMs: number,
  budgetMinutes: number,
): string {
  const fetchWord = fetches === 1 ? '1 fetch' : `${fetches} fetches`
  const budgetNote = remainingMs <= 0 ? ` and ${budgetMinutes} minutes` : ''
  return `This repository is a partial clone, and its promisor remotes had still not delivered every object needed for commit ${shortCommit} after ${fetchWord}${budgetNote}. Run "git fetch <remote>" for each promisor remote to see which one is failing, then try again.`
}

function fetchFailureDiagnostic(
  shortCommit: string,
  count: number,
  remote: string,
  gitSaid: string,
): string {
  const objects = count === 1 ? 'an object' : `${count} objects`
  const reachable = isSafeRemoteName(remote)
    ? `for example "git fetch ${remote}"`
    : 'run "git remote -v" to see which remotes are configured'
  return `This repository is a partial clone, and ${objects} needed for commit ${shortCommit} could not be fetched from its promisor remote ${displayRemoteName(remote)} before checking it out (Claude Code checks worktrees out with git's on-demand fetching switched off). Check that the remote is reachable (${reachable}) and try again. ${gitSaid}`
}

/** Official `$st` @252745747 (bounded - deviation #1: whole-tree enumeration,
 *  no sparse resource). Round-robins the promisor remotes that have a URL,
 *  fetching the still-missing OIDs over stdin under a shared minute budget, and
 *  returns a verbatim failure diagnostic (or `null` on success). */
export async function prefetchMissingObjects(
  repoPath: string,
  baseCommit: string,
  ctx: PartialCloneContext,
  budgetMinutes: number = DEFAULT_FETCH_BUDGET_MINUTES,
): Promise<PrefetchResult> {
  const promisors = ctx.promisors
  const done = (failure: string | null, fetches = 0): PrefetchResult => ({
    failure,
    fetches,
  })
  if (promisors.length === 0) {
    return done(null)
  }
  const shortCommit = baseCommit.slice(0, 12)
  const usable: string[] = []
  for (const remote of promisors) {
    if (
      !remote.startsWith('-') &&
      (await promisorRemoteHasUrl(repoPath, remote))
    ) {
      usable.push(remote)
    }
  }
  const hasUsable = usable.length > 0
  const fetchCap = usable.length + FETCH_RETRY_SLACK
  const deadline = Date.now() + budgetMinutes * 60_000
  let lastFailure: string | null = null
  // Deviation: local mutable loop counters/array mirror the official `for(;;)`
  // choreography exactly (fetches=Se, rotation=be); no shared state is mutated.
  for (let fetches = 0, rotation = 0; ; ) {
    const missing = await listMissingObjects(repoPath, baseCommit)
    if (typeof missing === 'string') {
      return done(
        missing === MORE_OBJECTS_THAN_LISTABLE
          ? moreObjectsDiagnostic(shortCommit)
          : couldNotListDiagnostic(shortCommit, missing),
        fetches,
      )
    }
    if (missing.length === 0) {
      return done(null, fetches)
    }
    if (!hasUsable) {
      return done(
        promisorNoUrlDiagnostic(promisors[0]!, shortCommit, missing.length),
        fetches,
      )
    }
    const remainingMs = deadline - Date.now()
    if (usable.length === 0 || fetches === fetchCap || remainingMs <= 0) {
      return done(
        lastFailure ??
          budgetExhaustedDiagnostic(
            shortCommit,
            fetches,
            remainingMs,
            budgetMinutes,
          ),
        fetches,
      )
    }
    const remote = usable[rotation % usable.length]!
    logForDebugging(
      `[worktree] partial clone: fetching ${missing.length} missing object(s) for ${shortCommit} from ${displayRemoteName(remote)} before materializing`,
    )
    const fetchResult = await execFileNoThrowWithCwd(
      gitExe(),
      [
        ...ALTERNATE_REFS_ARGS,
        '-c',
        'fetch.negotiationAlgorithm=noop',
        'fetch',
        (await remoteUploadPackArg(repoPath, remote)) ??
          GIT_UPLOAD_PACK_DEFAULT,
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        '--filter=blob:none',
        '--stdin',
        remote,
      ],
      {
        cwd: repoPath,
        // Official fetch env is `WNt(e)` = the merge builder `air`.
        env: buildMergedGitEnv({}) as NodeJS.ProcessEnv,
        input: `${missing.join('\n')}\n`,
        stdin: 'pipe',
        timeout: remainingMs,
        withoutControllingTerminal: true,
      },
    )
    fetches++
    if (fetchResult.code === 0) {
      rotation++
      continue
    }
    const stderr = sanitizeGitStderr(fetchResult.stderr)
    logForDebugging(
      `[worktree] explicit fetch from ${displayRemoteName(remote)} failed: ${stderr}`,
      { level: 'warn' },
    )
    // Deviation #7: `timedOut` approximated from the execa error text.
    const timedOut =
      typeof fetchResult.error === 'string' &&
      /timed ?out|timeout/i.test(fetchResult.error)
    const gitSaid = timedOut
      ? `The fetches ran out of their shared ${budgetMinutes}-minute budget.`
      : `git said: ${guardHiddenChars(stderr, "git's error")}`
    lastFailure = fetchFailureDiagnostic(
      shortCommit,
      missing.length,
      remote,
      gitSaid,
    )
    // Official: drop the failing remote and don't count the failed attempt.
    const failedIdx = usable.indexOf(remote)
    const nextUsable =
      failedIdx === -1 ? usable : usable.filter((_, i) => i !== failedIdx)
    usable.length = 0
    usable.push(...nextUsable)
    fetches--
  }
}
