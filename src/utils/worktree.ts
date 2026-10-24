import { feature } from 'src/utils/featureFlags.js'
import chalk from 'chalk'
import { spawnSync } from 'child_process'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
} from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import ignore from 'ignore'
import { basename, dirname, join } from 'path'
import { saveCurrentProjectConfig } from './config.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { buildMergedGitEnv } from './git/gitEnv.js'
import { parseGitConfigValue } from './git/gitConfigParser.js'
import {
  getCommonDir,
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from './git/gitFilesystem.js'
import {
  bareLayoutRootMessage,
  buildWorktreeBaseResolveFailureMessage,
  classifyRevParseCause,
  gitFilePointsToBareRepository,
  worktreeBaseKindFor,
} from './git/worktreeBaseResolve.js'
import type { WorktreeBaseKind } from './git/worktreeBaseResolve.js'
// Official 2.1.309 item 56 — worktree lazy-fetch hardening + partial-clone
// pre-fetch (BIN309 @252742600..@252783700; see worktreeLazyFetch.ts filedoc
// for the full symbol map + declared deviations).
import {
  computePartialCloneContext,
  formatLazyFetchFailure,
  guardHiddenChars,
  isWorktreeFetchSandboxed,
  lazyFetchEnv,
  prefetchMissingObjects,
  sanitizeGitStderr,
} from './git/worktreeLazyFetch.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  getDefaultBranch,
  gitExe,
} from './git.js'
import { resolveFetchSshFailFast } from './gitFetchSshFailFast.js'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from './hooks.js'
import { containsPathTraversal } from './path.js'
import { getPlatform } from './platform.js'
import {
  filterValidIgnorePatterns,
  splitIgnorePatternLines,
} from './globPatternValidation.js'
import {
  getInitialSettings,
  getRelativeSettingsFilePathForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { isInITerm2 } from './swarm/backends/detection.js'

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

/**
 * Graceful "not in a git repository" decline. Shared by the fs-level gitRoot
 * check (createWorktreeForSession) and the rev-parse-stderr `no_repo`
 * classification (official 2.1.302 #23 — git ≥2.56 emits `fatal: gitfile does
 * not point to a valid repository` for a stray `.git` FILE whose gitdir target
 * doesn't exist; the official `pGt` predicate classifies it as no-repo →
 * decline gracefully like a plain non-repo dir, never a hard base-resolve
 * refusal). getOrCreateWorktree is only reached when no WorktreeCreate hook
 * is configured, so the hook guidance is always accurate here.
 */
const NOT_IN_GIT_REPO_WORKTREE_MESSAGE =
  'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
  'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.'

/**
 * Validates a worktree slug to prevent path traversal and directory escape.
 *
 * The slug is joined into `.claude/worktrees/<slug>` via path.join, which
 * normalizes `..` segments — so `../../../target` would escape the worktrees
 * directory. Similarly, an absolute path (leading `/` or `C:\`) would discard
 * the prefix entirely.
 *
 * Forward slashes are allowed for nesting (e.g. `asm/feature-foo`); each
 * segment is validated independently against the allowlist, so `.` / `..`
 * segments and drive-spec characters are still rejected.
 *
 * Throws synchronously — callers rely on this running before any side effects
 * (git commands, hook execution, chdir).
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  // Leading or trailing `/` would make path.join produce an absolute path
  // or a dangling segment. Splitting and validating each segment rejects
  // both (empty segments fail the regex) while allowing `user/feature`.
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      )
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

// Helper function to create directories recursively
async function mkdirRecursive(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/**
 * Symlinks directories from the main repository to avoid duplication.
 * This prevents disk bloat from duplicating node_modules and other large directories.
 *
 * @param repoRootPath - Path to the main repository root
 * @param worktreePath - Path to the worktree directory
 * @param dirsToSymlink - Array of directory names to symlink (e.g., ['node_modules'])
 */
async function symlinkDirectories(
  repoRootPath: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const dir of dirsToSymlink) {
    // Validate directory doesn't escape repository boundaries
    if (containsPathTraversal(dir)) {
      logForDebugging(
        `Skipping symlink for "${dir}": path traversal detected`,
        { level: 'warn' },
      )
      continue
    }

    const sourcePath = join(repoRootPath, dir)
    const destPath = join(worktreePath, dir)

    try {
      await symlink(sourcePath, destPath, 'dir')
      logForDebugging(
        `Symlinked ${dir} from main repository to worktree to avoid disk bloat`,
      )
    } catch (error) {
      const code = getErrnoCode(error)
      // ENOENT: source doesn't exist yet (expected - skip silently)
      // EEXIST: destination already exists (expected - skip silently)
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        // Unexpected error (e.g., permission denied, unsupported platform)
        logForDebugging(
          `Failed to symlink ${dir} (${code ?? 'unknown'}): ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
    }
  }
}

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** How long worktree creation took (unset when resuming an existing worktree). */
  creationDurationMs?: number
  /** True if git sparse-checkout was applied via settings.worktree.sparsePaths. */
  usedSparsePaths?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

/**
 * claude-code 2.1.97: detect if `cwd` is inside a linked git worktree (a
 * worktree created via `git worktree add`, where `.git` is a FILE containing
 * `gitdir: <path>` rather than a directory). Returns the worktree root (the
 * directory containing that `.git` file) or null if cwd is in the main repo.
 *
 * Walks up from cwd so any subdirectory of a linked worktree is detected.
 * Used by the status line JSON (`workspace.git_worktree`).
 */
export function getLinkedGitWorktreePath(): string | null {
  let dir = getCwd()
  const root = dirname(getCwd())
  // Walk up the directory tree.
  for (let i = 0; i < 40; i++) {
    const dotGit = join(dir, '.git')
    try {
      if (existsSync(dotGit)) {
        const stats = statSync(dotGit)
        if (stats.isFile()) {
          // Linked worktree: .git is a file starting with "gitdir:"
          const content = readFileSync(dotGit, 'utf8').trim()
          if (content.startsWith('gitdir:')) {
            return dir
          }
        }
        // .git is a directory → main repo (or submodule); stop walking.
        return null
      }
    } catch {
      // ignore stat/read errors, keep walking
    }
    if (dir === root || dir === dirname(dir)) {
      // Reached filesystem root.
      break
    }
    dir = dirname(dir)
  }
  return null
}

/**
 * Restore the worktree session on --resume. The caller must have already
 * verified the directory exists (via process.chdir) and set the bootstrap
 * state (cwd, originalCwd).
 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

export function generateTmuxSessionName(
  repoPath: string,
  branch: string,
): string {
  const repoName = basename(repoPath)
  const combined = `${repoName}_${branch}`
  return combined.replace(/[/.]/g, '_')
}

type WorktreeCreateResult =
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      existed: true
    }
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      baseBranch: string
      existed: false
    }

// Env vars to prevent git/SSH from prompting for credentials (which hangs the CLI).
// GIT_TERMINAL_PROMPT=0 prevents git from opening /dev/tty for credential prompts.
// GIT_ASKPASS='' disables askpass GUI programs.
// stdin: 'ignore' closes stdin so interactive prompts can't block.
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.claude', 'worktrees')
}

// Flatten nested slugs (`user/feature` → `user+feature`) for both the branch
// name and the directory path. Nesting in either location is unsafe:
//   - git refs: `worktree-user` (file) vs `worktree-user/feature` (needs dir)
//     is a D/F conflict that git rejects.
//   - directory: `.claude/worktrees/user/feature/` lives inside the `user`
//     worktree; `git worktree remove` on the parent deletes children with
//     uncommitted work.
// `+` is valid in git branch names and filesystem paths but NOT in the
// slug-segment allowlist ([a-zA-Z0-9._-]), so the mapping is injective.
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug))
}

/**
 * Official v306 `yot` (@250451600), the shared worktree-base ref resolver:
 *
 *   async function yot({base:e,kind:n,failure:r,cwd:s,root:h,exactRef:y}){
 *     let S=hc(h,{LC_ALL:"C"}),w=y===!0?"show-ref":"rev-parse",
 *     {stdout:H,stderr:q,code:K,exitCode:Q,timedOut:Se}=await ut(...,
 *       y===!0?[...Tn,"show-ref","--verify","--hash",e]
 *             :[...Tn,"rev-parse","--verify","--quiet",e],{cwd:s,env:S}),
 *     be=H.trim();
 *     if(K===0&&be!=="")return be;
 *     ... ve = y===!0 && Q===128 && we===`fatal: '${e}' - not a valid ref` ...
 *     throw Je(Error(`${r}: ${dt}`),`worktree base not resolved (base=${n},
 *       cause=${Te}, repo_confirmed=${Pe})`)
 *   }
 *
 * exactRef resolves a FULL ref name (`refs/remotes/origin/<branch>`) with
 * `git show-ref --verify --hash` — never the abbrev name, which in a bare-repo
 * layout can resolve against the local HEAD or fail outright (the v304 defect
 * this port fixes). Older git answers a missing ref to `show-ref --verify`
 * with exit 128 + `fatal: '<ref>' - not a valid ref` instead of exit 1 +
 * empty output; the official `ve` detection maps BOTH shapes to the
 * `name_missing` cause.
 *
 * Returns the resolved commit-ish string on success; THROWS
 * `<failure>: <detail>` on any failure (official semantics — callers do not
 * get a null return). The detail comes from the shared v299/v306 catalog in
 * src/utils/git/worktreeBaseResolve.ts.
 *
 * OCC deviations (documented): the exec wrapper reports `{stdout, stderr,
 * code, error?}` without separate `exitCode`/`timedOut` fields, so cause
 * classification reuses `classifyRevParseCause` (same approximation as the
 * 2.1.299 #146 port); the official `Je` error annotation text is emitted
 * byte-exact via `logForDebugging`; and the v302 (#23) `no_repo` intercept is
 * preserved —
 * no-repo stderr declines with the not-in-a-git-repo message instead of the
 * hard base-resolve refusal (OCC has no separate pre-resolve root rejection).
 */
export async function resolveGitRef(params: {
  base: string
  kind: WorktreeBaseKind
  failure: string
  cwd: string
  root: string
  exactRef?: boolean
}): Promise<string> {
  const { base, kind, failure, cwd, root } = params
  const exactRef = params.exactRef === true
  const commandLabel = exactRef ? 'show-ref' : 'rev-parse'
  const args = exactRef
    ? ['show-ref', '--verify', '--hash', base]
    : ['rev-parse', '--verify', '--quiet', base]
  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    cwd,
    // Official 2.1.309 items 10+44: the base-resolver spawns under the merge
    // builder `WNt(e,{LC_ALL:"C"})`→`air` — inherited GIT_* redirect/config
    // vars are scrubbed, GIT_NO_REPLACE_OBJECTS=1 is default-injected (item
    // 10), and the C locale is pinned as an explicit override (item 44).
    env: buildMergedGitEnv({ LC_ALL: 'C' }) as NodeJS.ProcessEnv,
  })
  const stdoutTrimmed = result.stdout.trim()
  if (result.code === 0 && stdoutTrimmed !== '') {
    return stdoutTrimmed
  }
  const stderrTrimmed = result.stderr.trim()
  // Official `ve`: exactRef ∧ exit 128 ∧ canonical not-a-valid-ref stderr.
  const isNotAValidRef =
    exactRef &&
    result.code === 128 &&
    stderrTrimmed === `fatal: '${base}' - not a valid ref`
  const cause = isNotAValidRef ? 'name_missing' : classifyRevParseCause(result)
  if (cause === 'no_repo') {
    throw new Error(NOT_IN_GIT_REPO_WORKTREE_MESSAGE)
  }
  // Official `Pe`: repo_confirmed = the .git layout resolves for this root.
  const repoConfirmed = (await resolveGitDir(root)) !== null
  const detail = buildWorktreeBaseResolveFailureMessage({
    cause,
    kind,
    repoConfirmed,
    stderrTrimmed,
    stdoutTrimmed,
    commandLabel,
  })
  // Official `Je` annotation, byte-exact (v306 dump @41593385 & @58462996):
  // `worktree base not resolved (base=${n}, cause=${Te}, repo_confirmed=${Pe})`
  logForDebugging(
    `worktree base not resolved (base=${kind}, cause=${cause}, repo_confirmed=${repoConfirmed ? 'yes' : 'no'})`,
    { level: 'warn' },
  )
  throw new Error(`${failure}: ${detail}`)
}

/**
 * Creates a new git worktree for the given slug, or resumes it if it already exists.
 * Named worktrees reuse the same path across invocations, so the existence check
 * prevents unconditionally running `git fetch` (which can hang waiting for credentials)
 * on every resume.
 */
export async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number; fromCwd?: string },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)

  // Fast resume path: if the worktree already exists skip fetch and creation.
  // Read the .git pointer file directly (no subprocess, no upward walk) — a
  // subprocess `rev-parse HEAD` burns ~15ms on spawn overhead even for a 2ms
  // task, and the await yield lets background spawnSyncs pile on (seen at 55ms).
  //
  // DECLARED DEVIATION (2.1.309 item 56): the official resume path `xGr`
  // (@252760456) is a full resume-REBASE subsystem (default-branch refresh,
  // claim/dirt checks, `git status` under the item-44 `{userLocale:!0}` pin,
  // and a `$st(…,RGr)` pre-fetch of the NEW base's missing objects under a
  // 2-minute budget — RESUME_FETCH_BUDGET_MINUTES). OCC's fast resume only
  // re-reads the HEAD sha and never moves the worktree's base, so there is no
  // host site for the resume prefetch; it is NOT ported rather than invented.
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    }
  }

  // Official 2.1.299 (#147): a root whose `.git` is a file/symlink pointing at
  // a BARE repository (linked worktree of a bare clone) can't sensibly host a
  // nested worktree — fail with an explanatory message before any side effects.
  // Official site: `if(fSe(e)===null&&aSs(e))throw ... git_worktree_create_bare_layout_root`
  // (v299 @225552076); OCC runs the aSs bare-pointer check directly since
  // resolveGitDir already gates the non-bare layout below.
  if (await gitFilePointsToBareRepository(repoRoot)) {
    throw new Error(bareLayoutRootMessage(repoRoot))
  }

  // New worktree: fetch base branch then add
  await mkdir(worktreesDir(repoRoot), { recursive: true })

  // Official v285 `aPe`: every worktree fetch spawns with `...await D0(dir)`
  // (2.1.285 changelog item 3) — SSH_ASKPASS_REQUIRE=never + SSH_ASKPASS=false
  // pins and a detached-from-controlling-terminal spawn, so ssh passphrase /
  // new-host prompts fail fast instead of seizing the terminal.
  // 309 review dataflow-01/07 repair: the fetch env base is routed through
  // buildMergedGitEnv like every sibling git spawn in this routine, so ambient
  // GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* redirect vars are scrubbed before the
  // remote-resolving subprocess sees them (probe: a decoy GIT_DIR otherwise
  // silently fetches the WRONG remote). The former partial-wiring comment here
  // argued the merge scrub breaks the SSH askpass pin shape — the review's
  // dataflow-07 probe falsified that: the scrub lists carry only GIT_*
  // redirect/config keys, and resolveFetchSshFailFast applies the SSH pins
  // AFTER the env build, so they survive verbatim. The official fetch-site 309
  // formula was not separately recovered; this composition (merged builder →
  // fail-fast wrapper) keeps both official mechanisms (WNt env + D0 pins)
  // intact and restores sink identity with the sibling spawns. The merged
  // builder's OCC defaults (deviation #4, dataflow-02) additionally neutralize
  // malicious `.git/config` `alias.remote-*` smuggling and pin
  // GIT_TERMINAL_PROMPT=0 on this network sink.
  const fetchSpawn = await resolveFetchSshFailFast(
    buildMergedGitEnv({ ...GIT_NO_PROMPT_ENV }) as NodeJS.ProcessEnv,
    repoRoot,
  )
  const fetchEnv = fetchSpawn.env
  const fetchOpts = {
    cwd: repoRoot,
    stdin: 'ignore' as const,
    env: fetchEnv,
    withoutControllingTerminal: fetchSpawn.withoutControllingTerminal,
  }

  let baseBranch: string
  let baseSha: string | null = null
  if (options?.prNumber) {
    const { code: prFetchCode, stderr: prFetchStderr } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', `pull/${options.prNumber}/head`],
        fetchOpts,
      )
    if (prFetchCode !== 0) {
      throw new Error(
        `Failed to fetch PR #${options.prNumber}: ${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`,
      )
    }
    baseBranch = 'FETCH_HEAD'
  } else {
    // If origin/<branch> already exists locally, skip fetch. In large repos
    // (210k files, 16M objects) fetch burns ~6-8s on a local commit-graph
    // scan before even hitting the network. A slightly stale base is fine —
    // the user can pull in the worktree if they want latest.
    // resolveRef reads the loose/packed ref directly; when it succeeds we
    // already have the SHA, so the later rev-parse is skipped entirely.
    const [defaultBranch, gitDir] = await Promise.all([
      getDefaultBranch(),
      resolveGitDir(repoRoot),
    ])
    const originRef = `origin/${defaultBranch}`
    const originSha = gitDir
      ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
      : null
    if (originSha) {
      baseBranch = originRef
      baseSha = originSha
    } else {
      const { code: fetchCode } = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', defaultBranch],
        fetchOpts,
      )
      if (fetchCode === 0) {
        baseBranch = originRef
        // Official v306 (#P8) fetch-success call site (@250461300):
        //   H=Ye, q=await yot({base:`refs/remotes/${Ye}`,exactRef:!0,
        //     kind:"origin_default",
        //     failure:`Failed to resolve base branch "${Ye}"`,cwd:e,root:e})
        // The FULL ref is resolved with `show-ref --verify --hash` right here
        // (throwing on failure) — NOT via the shared abbrev rev-parse below,
        // which in a bare-repo layout resolves `origin/<branch>` against the
        // local HEAD or fails outright (wrong start point / leak).
        baseSha = await resolveGitRef({
          base: `refs/remotes/${originRef}`,
          kind: 'origin_default',
          failure: `Failed to resolve base branch "${originRef}"`,
          cwd: repoRoot,
          root: repoRoot,
          exactRef: true,
        })
      } else {
        // Official 2.1.300 (#33): the fetch of origin/<default> failed — base
        // the worktree on the CURRENT checkout's local HEAD, not the canonical
        // repoRoot's. Official `Hen` @226745624 resolves HEAD with
        // `cwd = fromCwd ?? repoRoot`; fromCwd is the directory the user
        // launched from, which in a worktree of a bare repository can have a
        // different HEAD than the main repoRoot. The warn string is byte-exact
        // (v300 @226752150, em-dash U+2014).
        baseBranch = 'HEAD'
        logForDebugging(
          `[worktree] fetch of origin/${defaultBranch} failed — basing worktree on local HEAD`,
          { level: 'warn' },
        )
        const headCwd = options?.fromCwd ?? repoRoot
        const headRevParse = await execFileNoThrowWithCwd(
          gitExe(),
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          {
            cwd: headCwd,
            // Official 2.1.309 items 10+44: merge builder + explicit C locale
            // (same `WNt(e,{LC_ALL:"C"})` formula as resolveGitRef above).
            env: buildMergedGitEnv({ LC_ALL: 'C' }) as NodeJS.ProcessEnv,
          },
        )
        const headSha = headRevParse.stdout.trim()
        if (headRevParse.code === 0 && headSha !== '') {
          baseSha = headSha
        }
        // If HEAD can't be resolved from fromCwd, baseSha stays null and the
        // shared rev-parse below retries `HEAD` at repoRoot — preserving the
        // 2.1.299 (#146) head_fallback failure-catalog path.
      }
    }
  }

  // For the PR-fetch path (FETCH_HEAD) and the fetch-failure head fallback
  // (HEAD) we still need the SHA — the fs-only resolveRef above only covers
  // the "origin/<branch> already exists locally" case, and the v306
  // fetch-success exact-ref resolution above sets baseSha directly.
  //
  // Official 2.1.299 (#146) + v306 shared resolver: the official runs the
  // remaining bases through `yot` WITHOUT exactRef (`rev-parse --verify
  // --quiet` under LC_ALL=C); failure explains HOW the lookup ended + likely
  // reasons via the catalog in src/utils/git/worktreeBaseResolve.ts.
  if (!baseSha) {
    baseSha = await resolveGitRef({
      base: baseBranch,
      kind: worktreeBaseKindFor(baseBranch),
      failure: `Failed to resolve base branch "${baseBranch}"`,
      cwd: repoRoot,
      root: repoRoot,
    })
  }

  const sparsePaths = getInitialSettings().worktree?.sparsePaths
  const addArgs = ['worktree', 'add']
  if (sparsePaths?.length) {
    addArgs.push('--no-checkout')
  }
  // -B (not -b): reset any orphan branch left behind by a removed worktree dir.
  // Saves a `git branch -D` subprocess (~15ms spawn overhead) on every create.
  // Official 2.1.300 (#29): the start-point is the PEELED base SHA
  // (`${sha}^{commit}`), never the ref NAME: when a tag or branch is named
  // like a commit ID, git's DWIM start-point resolution could pick the wrong
  // object and the --worktree session would start from an unintended commit.
  // Official v306 (#P8) makes the peel UNCONDITIONAL (@250462300):
  //   let Se=`${q}^{commit}`;Q.push("--no-track",...,Se)
  // — baseSha is guaranteed non-null here: every resolution path above either
  // sets it or throws (resolveGitRef never returns falsy).
  addArgs.push('-B', worktreeBranch, worktreePath, `${baseSha}^{commit}`)

  // Official 2.1.309 item 56 (@252779841): BEFORE the add, compute the
  // partial-clone context (`be=await kMn(e,null)`) and pre-fetch the base
  // commit's still-missing objects under a shared 10-minute budget
  // (`we=(await $st(e,q,be,…)).failure`). The add spawn then layers
  // `yne(be)` — GIT_NO_LAZY_FETCH=1 + GIT_ALLOW_PROTOCOL=/ when in force —
  // over the merge env (`WNt(e,{LC_ALL:"C",...yne(be)})`), and the add-failure
  // diagnostic appends `ve(Je)`: the prefetch failure when one happened, else
  // Fst's explanation when the checkout ran with on-demand fetching off.
  // DECLARED DEVIATION: the official $st resource callback narrows enumeration
  // to sparsePaths (`eMn(K)`) — not ported; whole-tree QPn enumeration only
  // (see worktreeLazyFetch.ts deviation #1). The official add argv also
  // carries `--no-track` + a `-b`/`-B` variant and the Gst/Ust arg prefixes —
  // OCC keeps its existing `-B` argv (pre-existing deviation).
  const lazyCtx = await computePartialCloneContext(
    repoRoot,
    isWorktreeFetchSandboxed,
  )
  const prefetch = await prefetchMissingObjects(repoRoot, baseSha, lazyCtx)
  const lazyDiagnostic = (stderr: string): string =>
    prefetch.failure !== null
      ? `\n${prefetch.failure}`
      : lazyCtx.inForce
        ? formatLazyFetchFailure(stderr, {}, baseSha)
        : ''

  const { code: createCode, stderr: createStderr } =
    await execFileNoThrowWithCwd(gitExe(), addArgs, {
      cwd: repoRoot,
      // Official env:WNt(e,{LC_ALL:"C",...yne(be)}) — merge builder (scrubs
      // inherited GIT_* redirect/config vars; item-10 default
      // GIT_NO_REPLACE_OBJECTS=1) + C locale + the lazy-fetch overlay. A
      // caller-provided GIT_NO_LAZY_FETCH survives the merge scrub, so
      // inForce checkouts really run with on-demand fetching off.
      env: buildMergedGitEnv({
        LC_ALL: 'C',
        ...(lazyFetchEnv(lazyCtx) ?? {}),
      }) as NodeJS.ProcessEnv,
    })
  if (createCode !== 0) {
    // Official `Failed to create worktree: ${Gc(zXe(Je,"git's error"))}${ve(Je)}`
    // (Je = yO-normalized stderr). Gc≈identity + yO/sA≈sanitizeGitStderr per
    // worktreeLazyFetch.ts deviations #5/#6; OCC keeps its plain Error class
    // (official throws qf with a git_worktree_create_add_failed telemetry
    // marker — OCC has no such telemetry channel here).
    throw new Error(
      `Failed to create worktree: ${guardHiddenChars(sanitizeGitStderr(createStderr), "git's error")}${lazyDiagnostic(createStderr)}`,
    )
  }

  if (sparsePaths?.length) {
    // If sparse-checkout or checkout fail after --no-checkout, the worktree
    // is registered and HEAD is set but the working tree is empty. Next run's
    // fast-resume (rev-parse HEAD) would succeed and present a broken worktree
    // as "resumed". Tear it down before propagating the error.
    const tearDown = async (msg: string): Promise<never> => {
      await execFileNoThrowWithCwd(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: repoRoot },
      )
      throw new Error(msg)
    }
    const { code: sparseCode, stderr: sparseErr } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
        {
          cwd: worktreePath,
          // Official 2.1.309 item 56 (@252782780): env:WNt(s,yne(be)) — merge
          // builder + the lazy-fetch overlay, NO LC_ALL pin on this spawn.
          env: buildMergedGitEnv({
            ...(lazyFetchEnv(lazyCtx) ?? {}),
          }) as NodeJS.ProcessEnv,
        },
      )
    if (sparseCode !== 0) {
      await tearDown(
        `Failed to configure sparse-checkout: ${guardHiddenChars(sanitizeGitStderr(sparseErr), "git's error")}`,
      )
    }
    const { code: coCode, stderr: coErr } = await execFileNoThrowWithCwd(
      gitExe(),
      ['checkout', 'HEAD'],
      {
        cwd: worktreePath,
        // Official (@252783350): env:WNt(s,{...be.inForce&&{LC_ALL:"C"},
        // ...yne(be)}) — the C locale is pinned ONLY when lazy fetching is in
        // force. OCC keeps its existing `checkout HEAD` argv (the official
        // adds --no-recurse-submodules + Gst/Ust prefixes — pre-existing
        // deviation, not part of the 309 delta).
        env: buildMergedGitEnv({
          ...(lazyCtx.inForce ? { LC_ALL: 'C' } : {}),
          ...(lazyFetchEnv(lazyCtx) ?? {}),
        }) as NodeJS.ProcessEnv,
      },
    )
    // Official (@252783560): `Xt=be.inForce&&Fst(qt,be,q)!==""` — a checkout
    // that EXITED 0 but whose stderr matches the lazy-fetch detector means git
    // silently left out files it could not read; tear the worktree down too.
    const checkoutLeftOutFiles =
      lazyCtx.inForce && formatLazyFetchFailure(coErr, {}, baseSha) !== ''
    if (coCode !== 0) {
      await tearDown(
        `Failed to checkout sparse worktree: ${guardHiddenChars(sanitizeGitStderr(coErr), "git's error")}${lazyDiagnostic(coErr)}`,
      )
    }
    if (checkoutLeftOutFiles) {
      await tearDown(
        `Failed to checkout sparse worktree: git left out files whose contents it could not read, so the new worktree was removed.${lazyDiagnostic(coErr)}`,
      )
    }
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: baseSha,
    baseBranch,
    existed: false,
  }
}

/**
 * Copy gitignored files specified in .worktreeinclude from base repo to worktree.
 *
 * Only copies files that are BOTH:
 * 1. Matched by patterns in .worktreeinclude (uses .gitignore syntax)
 * 2. Gitignored (not tracked by git)
 *
 * Uses `git ls-files --others --ignored --exclude-standard --directory` to list
 * gitignored entries with fully-ignored dirs collapsed to single entries (so large
 * build outputs like node_modules/ don't force a full tree walk), then filters
 * against .worktreeinclude patterns in-process using the `ignore` library. If a
 * .worktreeinclude pattern explicitly targets a path inside a collapsed directory,
 * that directory is expanded with a second scoped `ls-files` call.
 */
export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let includeContent: string
  try {
    includeContent = await readFile(join(repoRoot, '.worktreeinclude'), 'utf-8')
  } catch {
    return []
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  if (patterns.length === 0) {
    return []
  }

  // Single pass with --directory: collapses fully-gitignored dirs (node_modules/,
  // .turbo/, etc.) into single entries instead of listing every file inside.
  // In a large repo this cuts ~500k entries/~7s down to ~hundreds of entries/~100ms.
  const gitignored = await execFileNoThrowWithCwd(
    gitExe(),
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: repoRoot },
  )
  if (gitignored.code !== 0 || !gitignored.stdout.trim()) {
    return []
  }

  const entries = gitignored.stdout.trim().split('\n').filter(Boolean)
  const matcher = ignore().add(
    filterValidIgnorePatterns(
      splitIgnorePatternLines(includeContent),
      'worktreeinclude',
    ),
  )

  // --directory emits collapsed dirs with a trailing slash; everything else is
  // an individual file.
  const collapsedDirs = entries.filter(e => e.endsWith('/'))
  const files = entries.filter(e => !e.endsWith('/') && matcher.ignores(e))

  // Edge case: a .worktreeinclude pattern targets a path inside a collapsed dir
  // (e.g. pattern `config/secrets/api.key` when all of `config/secrets/` is
  // gitignored with no tracked siblings). Expand only dirs where a pattern has
  // that dir as its explicit path prefix (stripping redundant leading `/`), the
  // dir falls under an anchored glob's literal prefix (e.g. `config/**/*.key`
  // expands `config/secrets/`), or the dir itself matches a pattern. We don't
  // expand for `**/` or anchorless patterns -- those match files in tracked dirs
  // (already listed individually) and expanding every collapsed dir for them
  // would defeat the perf win.
  const dirsToExpand = collapsedDirs.filter(dir => {
    if (
      patterns.some(p => {
        const normalized = p.startsWith('/') ? p.slice(1) : p
        // Literal prefix match: pattern starts with the collapsed dir path
        if (normalized.startsWith(dir)) return true
        // Anchored glob: dir falls under the pattern's literal (non-glob) prefix
        // e.g. `config/**/*.key` has literal prefix `config/` → expand `config/secrets/`
        const globIdx = normalized.search(/[*?[]/)
        if (globIdx > 0) {
          const literalPrefix = normalized.slice(0, globIdx)
          if (dir.startsWith(literalPrefix)) return true
        }
        return false
      })
    )
      return true
    if (matcher.ignores(dir.slice(0, -1))) return true
    return false
  })
  if (dirsToExpand.length > 0) {
    const expanded = await execFileNoThrowWithCwd(
      gitExe(),
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...dirsToExpand,
      ],
      { cwd: repoRoot },
    )
    if (expanded.code === 0 && expanded.stdout.trim()) {
      for (const f of expanded.stdout.trim().split('\n').filter(Boolean)) {
        if (matcher.ignores(f)) {
          files.push(f)
        }
      }
    }
  }
  const copied: string[] = []

  for (const relativePath of files) {
    const srcPath = join(repoRoot, relativePath)
    const destPath = join(worktreePath, relativePath)
    try {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(srcPath, destPath)
      copied.push(relativePath)
    } catch (e: unknown) {
      logForDebugging(
        `Failed to copy ${relativePath} to worktree: ${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  if (copied.length > 0) {
    logForDebugging(
      `Copied ${copied.length} files from .worktreeinclude: ${copied.join(', ')}`,
    )
  }

  return copied
}

/**
 * Post-creation setup for a newly created worktree.
 * Propagates settings.local.json, configures git hooks, and symlinks directories.
 */
async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  // Copy settings.local.json to the worktree's .claude directory
  // This propagates local settings (which may contain secrets) to the worktree
  const localSettingsRelativePath =
    getRelativeSettingsFilePathForSource('localSettings')
  const sourceSettingsLocal = join(repoRoot, localSettingsRelativePath)
  try {
    const destSettingsLocal = join(worktreePath, localSettingsRelativePath)
    await mkdirRecursive(dirname(destSettingsLocal))
    await copyFile(sourceSettingsLocal, destSettingsLocal)
    logForDebugging(
      `Copied settings.local.json to worktree: ${destSettingsLocal}`,
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to copy settings.local.json: ${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  // Configure the worktree to use hooks from the main repository
  // This solves issues with .husky and other git hooks that use relative paths
  const huskyPath = join(repoRoot, '.husky')
  const gitHooksPath = join(repoRoot, '.git', 'hooks')
  let hooksPath: string | null = null
  for (const candidatePath of [huskyPath, gitHooksPath]) {
    try {
      const s = await stat(candidatePath)
      if (s.isDirectory()) {
        hooksPath = candidatePath
        break
      }
    } catch {
      // Path doesn't exist or can't be accessed
    }
  }
  if (hooksPath) {
    // `git config` (no --worktree flag) writes to the main repo's .git/config,
    // shared by all worktrees. Once set, every subsequent worktree create is a
    // no-op — skip the subprocess (~14ms spawn) when the value already matches.
    const gitDir = await resolveGitDir(repoRoot)
    const configDir = gitDir ? ((await getCommonDir(gitDir)) ?? gitDir) : null
    const existing = configDir
      ? await parseGitConfigValue(configDir, 'core', null, 'hooksPath')
      : null
    if (existing !== hooksPath) {
      const { code: configCode, stderr: configError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['config', 'core.hooksPath', hooksPath],
          { cwd: worktreePath },
        )
      if (configCode === 0) {
        logForDebugging(
          `Configured worktree to use hooks from main repository: ${hooksPath}`,
        )
      } else {
        logForDebugging(`Failed to configure hooks path: ${configError}`, {
          level: 'error',
        })
      }
    }
  }

  // Symlink directories to avoid disk bloat (opt-in via settings)
  const settings = getInitialSettings()
  const dirsToSymlink = settings.worktree?.symlinkDirectories ?? []
  if (dirsToSymlink.length > 0) {
    await symlinkDirectories(repoRoot, worktreePath, dirsToSymlink)
  }

  // Copy gitignored files specified in .worktreeinclude (best-effort)
  await copyWorktreeIncludeFiles(repoRoot, worktreePath)

  // The core.hooksPath config-set above is fragile: husky's prepare script
  // (`git config core.hooksPath .husky`) runs on every `bun install` and
  // resets the SHARED .git/config value back to relative, causing each
  // worktree to resolve to its OWN .husky/ again. The attribution hook
  // file isn't tracked (it's in .git/info/exclude), so fresh worktrees
  // don't have it. Install it directly into the worktree's .husky/ —
  // husky won't delete it (husky install is additive-only), and for
  // non-husky repos this resolves to the shared .git/hooks/ (idempotent).
  //
  // Pass the worktree-local .husky explicitly: getHooksDir would return
  // the absolute core.hooksPath we just set above (main repo's .husky),
  // not the worktree's — `git rev-parse --git-path hooks` echoes the config
  // value verbatim when it's absolute.
  if (feature('COMMIT_ATTRIBUTION')) {
    const worktreeHooksDir =
      hooksPath === huskyPath ? join(worktreePath, '.husky') : undefined
    void import('./postCommitAttribution.js')
      .then(m =>
        m
          .installPrepareCommitMsgHook(worktreePath, worktreeHooksDir)
          .catch(error => {
            logForDebugging(
              `Failed to install attribution hook in worktree: ${error}`,
            )
          }),
      )
      .catch(error => {
        // Dynamic import() itself rejected (module load failure). The inner
        // .catch above only handles installPrepareCommitMsgHook rejection —
        // without this outer handler an import failure would surface as an
        // unhandled promise rejection.
        logForDebugging(`Failed to load postCommitAttribution module: ${error}`)
      })
  }
}

/**
 * Parses a PR reference from a string.
 * Accepts GitHub-style PR URLs (e.g., https://github.com/owner/repo/pull/123,
 * or GHE equivalents like https://ghe.example.com/owner/repo/pull/123)
 * or `#N` format (e.g., #123).
 * Returns the PR number or null if the string is not a recognized PR reference.
 */
export function parsePRReference(input: string): number | null {
  // GitHub-style PR URL: https://<host>/owner/repo/pull/123 (with optional trailing slash, query, hash)
  // The /pull/N path shape is specific to GitHub — GitLab uses /-/merge_requests/N,
  // Bitbucket uses /pull-requests/N — so matching any host here is safe.
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  )
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  // #N format
  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}

export async function isTmuxAvailable(): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', ['-V'])
  return code === 0
}

export function getTmuxInstallInstructions(): string {
  const platform = getPlatform()
  switch (platform) {
    case 'macos':
      return 'Install tmux with: brew install tmux'
    case 'linux':
    case 'wsl':
      return 'Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)'
    case 'windows':
      return 'tmux is not natively available on Windows. Consider using WSL or Cygwin.'
    default:
      return 'Install tmux using your system package manager.'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const { code, stderr } = await execFileNoThrow('tmux', [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    worktreePath,
  ])

  if (code !== 0) {
    return { created: false, error: stderr }
  }

  return { created: true }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', [
    'kill-session',
    '-t',
    sessionName,
  ])
  return code === 0
}

/**
 * Create (or resume) the session worktree. `options.fromCwd` is the directory
 * the user launched from, BEFORE any canonical-repo chdir — official 2.1.300
 * (#33) bases the fetch-failure fallback on that checkout's HEAD (`Hen`
 * @226745624: `cwd = fromCwd ?? repoRoot`), which matters when launching from
 * a linked worktree of a bare repository whose origin default branch can't be
 * fetched. Forwarded verbatim to getOrCreateWorktree().
 */
export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number; fromCwd?: string },
): Promise<WorktreeSession> {
  // Must run before the hook branch below — hooks receive the raw slug as an
  // argument, and the git branch builds a path from it via path.join.
  validateWorktreeSlug(slug)

  const originalCwd = getCwd()

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based worktree at: ${hookResult.worktreePath}`,
    )

    currentWorktreeSession = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    }
  } else {
    // Fall back to git worktree
    const gitRoot = findGitRoot(getCwd())
    if (!gitRoot) {
      throw new Error(NOT_IN_GIT_REPO_WORKTREE_MESSAGE)
    }

    const originalBranch = await getBranch()

    const createStart = Date.now()
    const { worktreePath, worktreeBranch, headCommit, existed } =
      await getOrCreateWorktree(gitRoot, slug, options)

    let creationDurationMs: number | undefined
    if (existed) {
      logForDebugging(`Resuming existing worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `Created worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
      )
      await performPostCreationSetup(gitRoot, worktreePath)
      creationDurationMs = Date.now() - createStart
    }

    currentWorktreeSession = {
      originalCwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalBranch,
      originalHeadCommit: headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs,
      usedSparsePaths:
        (getInitialSettings().worktree?.sparsePaths?.length ?? 0) > 0,
    }
  }

  // Save to project config for persistence
  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: currentWorktreeSession ?? undefined,
  }))

  return currentWorktreeSession
}

export async function keepWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch } = currentWorktreeSession

    // Change back to original directory first
    process.chdir(originalCwd)

    // Clear the session but keep the worktree intact
    currentWorktreeSession = null

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    logForDebugging(
      `Linked worktree preserved at: ${worktreePath}${worktreeBranch ? ` on branch: ${worktreeBranch}` : ''}`,
    )
    logForDebugging(
      `You can continue working there by running: cd ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(`Error keeping worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * CC 2.1.299 #113 — reftable-aware worktree cleanup helpers.
 *
 * Under git's `reftable` ref storage, per-worktree registration state lives in
 * the shared reftable tables; hand-deleting files under `.git/worktrees/<id>`
 * (or ref files) corrupts them. The official fix (v299 @221341800, `Kt`) only
 * ever drops registrations through git-native means and treats a reftable
 * anchor specially. OCC's cleanup is already git-native (`git worktree remove
 * --force`), but under reftable a successful remove can still leave a stale
 * `.git/worktrees/<id>` registration behind — the exact `--worktree` leak the
 * official entry fixes. Detection = `<gitCommonDir>/reftable/` exists; the
 * reftable-safe cleanup is `git worktree prune` (git drops the stale
 * registration whole), never a manual file delete. Classic ref-storage repos
 * keep their existing behavior (no extra prune).
 */
export function isReftableGitDir(gitCommonDir: string): boolean {
  try {
    return (
      statSync(join(gitCommonDir, 'reftable'), { throwIfNoEntry: false })?.isDirectory() ===
      true
    )
  } catch {
    return false
  }
}

/**
 * Resolve the git common dir for `cwd` and return it when the repo uses
 * reftable ref storage; null for classic ref storage or non-repos.
 */
export async function getReftableCommonDir(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd)
  if (!gitDir) {
    return null
  }
  const commonDir = (await getCommonDir(gitDir)) ?? gitDir
  return isReftableGitDir(commonDir) ? commonDir : null
}

/**
 * Reftable-safe registration cleanup: when `cwd`'s repo uses reftable, run
 * `git worktree prune` so git itself drops stale `.git/worktrees/<id>`
 * registrations left behind by `git worktree remove`. No-ops (returns false)
 * for classic ref storage. `exec` is injectable for tests.
 */
export async function pruneWorktreesIfReftable(
  cwd: string,
  exec: typeof execFileNoThrowWithCwd = execFileNoThrowWithCwd,
): Promise<boolean> {
  const reftableDir = await getReftableCommonDir(cwd)
  if (!reftableDir) {
    return false
  }
  const { code, stderr } = await exec(gitExe(), ['worktree', 'prune'], { cwd })
  if (code !== 0) {
    logForDebugging(
      `reftable: 'git worktree prune' failed in ${cwd}: ${stderr}`,
      { level: 'error' },
    )
  } else {
    logForDebugging(
      `reftable: pruned stale worktree registrations beneath ${reftableDir}`,
    )
  }
  return true
}

export async function cleanupWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch, hookBased } =
      currentWorktreeSession

    // Change back to original directory first
    process.chdir(originalCwd)

    if (hookBased) {
      // Hook-based worktree: delegate cleanup to WorktreeRemove hook
      const hookRan = await executeWorktreeRemoveHook(worktreePath)
      if (hookRan) {
        logForDebugging(`Removed hook-based worktree at: ${worktreePath}`)
      } else {
        logForDebugging(
          `No WorktreeRemove hook configured, hook-based worktree left at: ${worktreePath}`,
          { level: 'warn' },
        )
      }
    } else {
      // Git-based worktree: use git worktree remove.
      // Explicit cwd: process.chdir above does NOT update getCwd() (the state
      // CWD that execFileNoThrow defaults to). If the model cd'd to a non-repo
      // dir, the bare execFileNoThrow variant would fail silently here.
      const { code: removeCode, stderr: removeError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: originalCwd },
        )

      if (removeCode !== 0) {
        logForDebugging(`Failed to remove linked worktree: ${removeError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`Removed linked worktree at: ${worktreePath}`)
        // CC 2.1.299 #113: under reftable ref storage a successful remove can
        // leave the `.git/worktrees/<id>` registration behind — let git drop
        // it whole via prune (never hand-delete ref files).
        await pruneWorktreesIfReftable(originalCwd)
      }
    }

    // Clear the session
    currentWorktreeSession = null

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    // Delete the temporary worktree branch (git-based only)
    if (!hookBased && worktreeBranch) {
      // Wait a bit to ensure git has released all locks
      await sleep(100)

      const { code: deleteBranchCode, stderr: deleteBranchError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['branch', '-D', worktreeBranch],
          { cwd: originalCwd },
        )

      if (deleteBranchCode !== 0) {
        logForDebugging(
          `Could not delete worktree branch: ${deleteBranchError}`,
          { level: 'error' },
        )
      } else {
        logForDebugging(`Deleted worktree branch: ${worktreeBranch}`)
      }
    }

    logForDebugging('Linked worktree cleaned up completely')
  } catch (error) {
    logForDebugging(`Error cleaning up worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * Create a lightweight worktree for a subagent.
 * Reuses getOrCreateWorktree/performPostCreationSetup but does NOT touch
 * global session state (currentWorktreeSession, process.chdir, project config).
 * Falls back to hook-based creation if not in a git repository.
 */
export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based agent worktree at: ${hookResult.worktreePath}`,
    )

    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  // Fall back to git worktree
  // findCanonicalGitRoot (not findGitRoot) so agent worktrees always land in
  // the main repo's .claude/worktrees/ even when spawned from inside a session
  // worktree — otherwise they nest at <worktree>/.claude/worktrees/ and the
  // periodic cleanup (which scans the canonical root) never finds them.
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      'Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
    )
  }

  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug)

  if (!existed) {
    logForDebugging(
      `Created agent worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
    )
    await performPostCreationSetup(gitRoot, worktreePath)
  } else {
    // Bump mtime so the periodic stale-worktree cleanup doesn't consider this
    // worktree stale — the fast-resume path is read-only and leaves the original
    // creation-time mtime intact, which can be past the 30-day cutoff.
    const now = new Date()
    await utimes(worktreePath, now, now)
    logForDebugging(`Resuming existing agent worktree at: ${worktreePath}`)
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/**
 * Remove a worktree created by createAgentWorktree.
 * For git-based worktrees, removes the worktree directory and deletes the temporary branch.
 * For hook-based worktrees, delegates to the WorktreeRemove hook.
 * Must be called with the main repo's git root (for git worktrees), not the worktree path,
 * since the worktree directory is deleted during this operation.
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) {
    const hookRan = await executeWorktreeRemoveHook(worktreePath)
    if (hookRan) {
      logForDebugging(`Removed hook-based agent worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `No WorktreeRemove hook configured, hook-based agent worktree left at: ${worktreePath}`,
        { level: 'warn' },
      )
    }
    return hookRan
  }

  if (!gitRoot) {
    logForDebugging('Cannot remove agent worktree: no git root provided', {
      level: 'error',
    })
    return false
  }

  // Run from the main repo root, not the worktree (which we're about to delete)
  const { code: removeCode, stderr: removeError } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: gitRoot },
    )

  if (removeCode !== 0) {
    logForDebugging(`Failed to remove agent worktree: ${removeError}`, {
      level: 'error',
    })
    return false
  }
  logForDebugging(`Removed agent worktree at: ${worktreePath}`)

  // CC 2.1.299 #113: reftable-safe registration cleanup (git-native prune).
  await pruneWorktreesIfReftable(gitRoot)

  if (!worktreeBranch) {
    return true
  }

  // Delete the temporary worktree branch from the main repo
  const { code: deleteBranchCode, stderr: deleteBranchError } =
    await execFileNoThrowWithCwd(gitExe(), ['branch', '-D', worktreeBranch], {
      cwd: gitRoot,
    })

  if (deleteBranchCode !== 0) {
    logForDebugging(
      `Could not delete agent worktree branch: ${deleteBranchError}`,
      { level: 'error' },
    )
  }
  return true
}

/**
 * Slug patterns for throwaway worktrees created by AgentTool (`agent-a<7hex>`,
 * from earlyAgentId.slice(0,8)), WorkflowTool (`wf_<runId>-<idx>` where runId
 * is randomUUID().slice(0,12) = 8 hex + `-` + 3 hex), and bridgeMain
 * (`bridge-<safeFilenameId>`). These leak when the parent process is killed
 * (Ctrl+C, ESC, crash) before their in-process cleanup runs. Exact-shape
 * patterns avoid sweeping user-named EnterWorktree slugs like `wf-myfeature`.
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  // Legacy wf-<idx> slugs from before workflowRunId disambiguation — kept so
  // the 30-day sweep still cleans up worktrees leaked by older builds.
  /^wf-\d+$/,
  // Real bridge slugs are `bridge-${safeFilenameId(sessionId)}`.
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  // Template job worktrees: job-<templateName>-<8hex>. Prefix distinguishes
  // from user-named EnterWorktree slugs that happen to end in 8 hex.
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

/**
 * True when a worktree path's final segment matches one of the ephemeral
 * (machine-generated) slug patterns — the same gate `cleanupStaleAgentWorktrees`
 * uses, applied to a full path via its basename.
 */
export function isEphemeralWorktreePath(worktreePath: string): boolean {
  const slug = basename(worktreePath)
  return EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))
}

/**
 * Remove stale agent/workflow worktrees older than cutoffDate.
 *
 * Safety:
 * - Only touches slugs matching ephemeral patterns (never user-named worktrees)
 * - Skips the current session's worktree
 * - Fail-closed: skips if git status fails or shows tracked changes
 *   (-uno: untracked files in a 30-day-old crashed agent worktree are build
 *   artifacts; skipping the untracked scan is 5-10× faster on large repos)
 * - Fail-closed: skips if any commits aren't reachable from a remote
 *
 * `git worktree remove --force` handles both the directory and git's internal
 * worktree tracking. If git doesn't recognize the path as a worktree (orphaned
 * dir), it's left in place — a later readdir finding it stale again is harmless.
 */
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    return 0
  }

  const dir = worktreesDir(gitRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const cutoffMs = cutoffDate.getTime()
  const currentPath = currentWorktreeSession?.worktreePath
  let removed = 0

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))) {
      continue
    }

    const worktreePath = join(dir, slug)
    if (currentPath === worktreePath) {
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) {
      continue
    }

    // Both checks must succeed with empty output. Non-zero exit (corrupted
    // worktree, git not recognizing it, etc.) means skip — we don't know
    // what's in there.
    const [status, unpushed] = await Promise.all([
      execFileNoThrowWithCwd(
        gitExe(),
        ['--no-optional-locks', 'status', '--porcelain', '-uno'],
        { cwd: worktreePath },
      ),
      execFileNoThrowWithCwd(
        gitExe(),
        ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath },
      ),
    ])
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      continue
    }
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) {
      continue
    }

    if (
      await removeAgentWorktree(worktreePath, worktreeBranchName(slug), gitRoot)
    ) {
      removed++
    }
  }

  if (removed > 0) {
    await execFileNoThrowWithCwd(gitExe(), ['worktree', 'prune'], {
      cwd: gitRoot,
    })
    logForDebugging(
      `cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`,
    )
  }
  return removed
}

/**
 * Check whether a worktree has uncommitted changes or new commits since creation.
 * Returns true if there are uncommitted changes (dirty working tree), if commits
 * were made on the worktree branch since `headCommit`, or if git commands fail
 * — callers use this to decide whether to remove a worktree, so fail-closed.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } =
    await execFileNoThrowWithCwd(gitExe(), ['status', '--porcelain'], {
      cwd: worktreePath,
    })
  if (statusCode !== 0) {
    return true
  }
  if (statusOutput.trim().length > 0) {
    return true
  }

  const { code: revListCode, stdout: revListOutput } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-list', '--count', `${headCommit}..HEAD`],
      { cwd: worktreePath },
    )
  if (revListCode !== 0) {
    return true
  }
  if (parseInt(revListOutput.trim(), 10) > 0) {
    return true
  }

  return false
}

/**
 * `git status --porcelain` cleanliness probe (fail-closed): true only when
 * git succeeds AND reports no entries. Used by the v306 cleanup fallback,
 * which has no headCommit baseline to run the rev-list comparison against.
 */
export async function isWorktreeStatusClean(
  worktreePath: string,
): Promise<boolean> {
  const { code, stdout } = await execFileNoThrowWithCwd(
    gitExe(),
    ['status', '--porcelain'],
    { cwd: worktreePath },
  )
  return code === 0 && stdout.trim().length === 0
}

/**
 * CC 2.1.306 (#P8) cleanup decision for an agent worktree, "unchanged 必清":
 *
 * - headCommit present → the existing fail-closed `hasWorktreeChanges` probe
 *   (status + rev-list against the creation baseline) decides.
 * - headCommit MISSING → previously the whole cleanup was skipped and the
 *   worktree leaked (official changelog: agent worktrees "sometimes not
 *   being cleaned up"). Fallback: remove anyway when the path is an
 *   EPHEMERAL machine-generated slug (never a user-named worktree) AND the
 *   working tree is status-clean. Any git failure → keep (fail-closed).
 *
 * Part 2 of the official fix has no independent code change (the official
 * cleanup bytes are identical v304↔v306) — the leak's root cause is the
 * bare-repo base-resolution defect fixed by `resolveGitRef`, which left
 * headCommit unset/misresolved; this fallback covers the residual cases
 * (e.g. hook-less resume paths that never recorded a baseline).
 */
export async function shouldRemoveUnchangedAgentWorktree(params: {
  worktreePath: string
  headCommit?: string
}): Promise<boolean> {
  const { worktreePath, headCommit } = params
  if (headCommit) {
    return !(await hasWorktreeChanges(worktreePath, headCommit))
  }
  if (!isEphemeralWorktreePath(worktreePath)) {
    return false
  }
  return isWorktreeStatusClean(worktreePath)
}

/**
 * Fast-path handler for --worktree --tmux.
 * Creates the worktree and execs into tmux running Claude inside.
 * This is called early in cli.tsx before loading the full CLI.
 */
export async function execIntoTmuxWorktree(args: string[]): Promise<{
  handled: boolean
  error?: string
}> {
  // Check platform - tmux doesn't work on Windows
  if (process.platform === 'win32') {
    return {
      handled: false,
      error: 'Error: --tmux is not supported on Windows',
    }
  }

  // Check if tmux is available
  const tmuxCheck = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
  if (tmuxCheck.status !== 0) {
    const installHint =
      process.platform === 'darwin'
        ? 'Install tmux with: brew install tmux'
        : 'Install tmux with: sudo apt install tmux'
    return {
      handled: false,
      error: `Error: tmux is not installed. ${installHint}`,
    }
  }

  // Parse worktree name and tmux mode from args
  let worktreeName: string | undefined
  let forceClassicTmux = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '-w' || arg === '--worktree') {
      // Check if next arg exists and isn't another flag
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        worktreeName = next
      }
    } else if (arg.startsWith('--worktree=')) {
      worktreeName = arg.slice('--worktree='.length)
    } else if (arg === '--tmux=classic') {
      forceClassicTmux = true
    }
  }

  // Check if worktree name is a PR reference
  let prNumber: number | null = null
  if (worktreeName) {
    prNumber = parsePRReference(worktreeName)
    if (prNumber !== null) {
      worktreeName = `pr-${prNumber}`
    }
  }

  // Generate a slug if no name provided
  if (!worktreeName) {
    const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold']
    const nouns = ['fox', 'owl', 'elm', 'oak', 'ray']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]
    const suffix = Math.random().toString(36).slice(2, 6)
    worktreeName = `${adj}-${noun}-${suffix}`
  }

  // worktreeName is joined into worktreeDir via path.join below; apply the
  // same allowlist used by the in-session worktree tool so the constraint
  // holds uniformly regardless of entry point.
  try {
    validateWorktreeSlug(worktreeName)
  } catch (e) {
    return {
      handled: false,
      error: `Error: ${(e as Error).message}`,
    }
  }

  // Mirror createWorktreeForSession(): hook takes precedence over git so the
  // WorktreeCreate hook substitutes the VCS backend for this fast-path too
  // (anthropics/claude-code#39281). Git path below runs only when no hook.
  let worktreeDir: string
  let repoName: string
  if (hasWorktreeCreateHook()) {
    try {
      const hookResult = await executeWorktreeCreateHook(worktreeName)
      worktreeDir = hookResult.worktreePath
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
    repoName = basename(findCanonicalGitRoot(getCwd()) ?? getCwd())
    // biome-ignore lint/suspicious/noConsole: intentional console output
    console.log(`Using worktree via hook: ${worktreeDir}`)
  } else {
    // Get main git repo root (resolves through worktrees)
    const repoRoot = findCanonicalGitRoot(getCwd())
    if (!repoRoot) {
      return {
        handled: false,
        error: 'Error: --worktree requires a git repository',
      }
    }

    repoName = basename(repoRoot)
    worktreeDir = worktreePathFor(repoRoot, worktreeName)

    // Create or resume worktree
    try {
      const result = await getOrCreateWorktree(
        repoRoot,
        worktreeName,
        prNumber !== null ? { prNumber } : undefined,
      )
      if (!result.existed) {
        // biome-ignore lint/suspicious/noConsole: intentional console output
        console.log(
          `Created worktree: ${worktreeDir} (based on ${(result as any).baseBranch})`,
        )
        await performPostCreationSetup(repoRoot, worktreeDir)
      }
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
  }

  // Sanitize for tmux session name (replace / and . with _)
  const tmuxSessionName =
    `${repoName}_${worktreeBranchName(worktreeName)}`.replace(/[/.]/g, '_')

  // Build new args without --tmux and --worktree (we're already in the worktree)
  const newArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--tmux' || arg === '--tmux=classic') continue
    if (arg === '-w' || arg === '--worktree') {
      // Skip the flag and its value if present
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        i++ // Skip the value too
      }
      continue
    }
    if (arg.startsWith('--worktree=')) continue
    newArgs.push(arg)
  }

  // Get tmux prefix for user guidance
  let tmuxPrefix = 'C-b' // default
  const prefixResult = spawnSync('tmux', ['show-options', '-g', 'prefix'], {
    encoding: 'utf-8',
  })
  if (prefixResult.status === 0 && prefixResult.stdout) {
    const match = prefixResult.stdout.match(/prefix\s+(\S+)/)
    if (match?.[1]) {
      tmuxPrefix = match[1]
    }
  }

  // Check if tmux prefix conflicts with Claude keybindings
  // Claude binds: ctrl+b (task:background), ctrl+c, ctrl+d, ctrl+t, ctrl+o, ctrl+r, ctrl+s, ctrl+g, ctrl+e
  const claudeBindings = [
    'C-b',
    'C-c',
    'C-d',
    'C-t',
    'C-o',
    'C-r',
    'C-s',
    'C-g',
    'C-e',
  ]
  const prefixConflicts = claudeBindings.includes(tmuxPrefix)

  // Set env vars for the inner Claude to display tmux info in welcome message
  const tmuxEnv = {
    ...process.env,
    CLAUDE_CODE_TMUX_SESSION: tmuxSessionName,
    CLAUDE_CODE_TMUX_PREFIX: tmuxPrefix,
    CLAUDE_CODE_TMUX_PREFIX_CONFLICTS: prefixConflicts ? '1' : '',
  }

  // Check if session already exists
  const hasSessionResult = spawnSync(
    'tmux',
    ['has-session', '-t', tmuxSessionName],
    { encoding: 'utf-8' },
  )
  const sessionExists = hasSessionResult.status === 0

  // Check if we're already inside a tmux session
  const isAlreadyInTmux = Boolean(process.env.TMUX)

  // Use tmux control mode (-CC) for native iTerm2 tab/pane integration
  // This lets users use iTerm2's UI instead of learning tmux keybindings
  // Use --tmux=classic to force traditional tmux even in iTerm2
  // Control mode doesn't make sense when already in tmux (would need to switch-client)
  const useControlMode = isInITerm2() && !forceClassicTmux && !isAlreadyInTmux
  const tmuxGlobalArgs = useControlMode ? ['-CC'] : []

  // Print hint about iTerm2 preferences when using control mode
  if (useControlMode && !sessionExists) {
    const y = chalk.yellow
    // biome-ignore lint/suspicious/noConsole: intentional user guidance
    console.log(
      `\n${y('╭─ iTerm2 Tip ────────────────────────────────────────────────────────╮')}\n` +
        `${y('│')} To open as a tab instead of a new window:                           ${y('│')}\n` +
        `${y('│')} iTerm2 > Settings > General > tmux > "Tabs in attaching window"     ${y('│')}\n` +
        `${y('╰─────────────────────────────────────────────────────────────────────╯')}\n`,
    )
  }

  // For ants in claude-cli-internal, set up dev panes (watch + start)
  const isAnt = process.env.USER_TYPE === 'ant'
  const isClaudeCliInternal = repoName === 'claude-cli-internal'
  const shouldSetupDevPanes = isAnt && isClaudeCliInternal && !sessionExists

  if (shouldSetupDevPanes) {
    // Create detached session with Claude in first pane
    spawnSync(
      'tmux',
      [
        'new-session',
        '-d', // detached
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--',
        process.execPath,
        ...newArgs,
      ],
      { cwd: worktreeDir, env: tmuxEnv },
    )

    // Split horizontally and run watch
    spawnSync(
      'tmux',
      ['split-window', '-h', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync(
      'tmux',
      ['send-keys', '-t', tmuxSessionName, 'bun run watch', 'Enter'],
      { cwd: worktreeDir },
    )

    // Split vertically and run start
    spawnSync(
      'tmux',
      ['split-window', '-v', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync('tmux', ['send-keys', '-t', tmuxSessionName, 'bun run start'], {
      cwd: worktreeDir,
    })

    // Select the first pane (Claude)
    spawnSync('tmux', ['select-pane', '-t', `${tmuxSessionName}:0.0`], {
      cwd: worktreeDir,
    })

    // Attach or switch to the session
    if (isAlreadyInTmux) {
      // Switch to sibling session (avoid nesting)
      spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
        stdio: 'inherit',
      })
    } else {
      // Attach to the session
      spawnSync(
        'tmux',
        [...tmuxGlobalArgs, 'attach-session', '-t', tmuxSessionName],
        {
          stdio: 'inherit',
          cwd: worktreeDir,
        },
      )
    }
  } else {
    // Standard behavior: create or attach
    if (isAlreadyInTmux) {
      // Already in tmux - create detached session, then switch to it (sibling)
      // Check if session already exists first
      if (sessionExists) {
        // Just switch to existing session
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      } else {
        // Create new detached session
        spawnSync(
          'tmux',
          [
            'new-session',
            '-d', // detached
            '-s',
            tmuxSessionName,
            '-c',
            worktreeDir,
            '--',
            process.execPath,
            ...newArgs,
          ],
          { cwd: worktreeDir, env: tmuxEnv },
        )

        // Switch to the new session
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      }
    } else {
      // Not in tmux - create and attach (original behavior)
      const tmuxArgs = [
        ...tmuxGlobalArgs,
        'new-session',
        '-A', // Attach if exists, create if not
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--', // Separator before command
        process.execPath,
        ...newArgs,
      ]

      spawnSync('tmux', tmuxArgs, {
        stdio: 'inherit',
        cwd: worktreeDir,
        env: tmuxEnv,
      })
    }
  }

  return { handled: true }
}

// ---------------------------------------------------------------------------
// Official 2.1.304 #30 — worktree-exit "at stake" subsystem
//
// Changelog: "Fixed `claude --worktree` removing the worktree and its branch
// without asking at exit when HEAD was detached or on another branch, which
// could lose commits."
//
// The pre-304 guard counted `rev-list --count <originalHeadCommit>..HEAD` —
// commits reachable from HEAD. When HEAD was detached or moved to another
// branch, commits made on the worktree's OWN branch (refs/heads/<worktreeBranch>)
// were invisible to that count → 0 → silent removal deleted them. The official
// fix classifies HEAD (symbolic-ref) and counts at-stake commits on the
// worktree branch ref instead. Ported verbatim from the official 304 symbols
// `wV` / `QEn` / `G$r` / `nOt` / `tOt` (byte-recovered @249016065, see
// docs/gap-research-304/research-R6-env-misc.md #30).
// ---------------------------------------------------------------------------

/** Official `wV` — count commits reachable from positiveRefs but not from
 * negativeRefs. Returns null on git failure or non-numeric output (callers
 * must treat null as "unknown" and fail closed). */
export async function countCommitsOnRefs(
  worktreePath: string,
  positiveRefs: string[],
  negativeRefs: string[],
): Promise<number | null> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      'rev-list',
      '--count',
      ...positiveRefs,
      ...negativeRefs.map(ref => `^${ref}`),
      '--',
    ],
    { cwd: worktreePath },
  )
  const out = result.stdout.trim()
  return result.code === 0 && /^\d+$/.test(out) ? Number(out) : null
}

/** Official `QEn` — true iff `refs/heads/<branch>` does not exist
 * (for-each-ref with --count=1 exits 0 with empty stdout AND stderr). */
export async function branchMissing(
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      `refs/heads/${branch}`,
    ],
    { cwd: worktreePath },
  )
  return (
    result.code === 0 &&
    result.stdout.trim() === '' &&
    result.stderr.trim() === ''
  )
}

/** Official `t8t` (@247137662). */
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu

/** Official `dtn`/`Yt` (@243657122) — hidden/control/surrogate chars. */
const HIDDEN_NAME_RE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]|(?! )\p{Zs}/u
const SURROGATE_NAME_RE = /\p{Cs}/u

/**
 * Official `hh` (@247137742) — Unicode casefold used to detect a
 * differently-encoded/cased checkout of the worktree's own branch
 * (`like_its_branch`), byte-faithful.
 */
export function foldBranchName(name: string): string {
  return name
    .replace(DEFAULT_IGNORABLE_RE, '')
    .normalize('NFKD')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .replace(/i̇/g, 'i')
    .replace(/ς/g, 'σ')
    .normalize('NFC')
}

/**
 * Official `fve` (@243657174) — whether a branch name must not be echoed
 * into dialog copy (hidden or control characters); callers fall back to
 * "another branch".
 */
export function isDisplayUnsafeBranchName(branch: string): boolean {
  return HIDDEN_NAME_RE.test(branch) || SURROGATE_NAME_RE.test(branch)
}

/**
 * Official `G$r` HEAD classification (2.1.304 #30):
 * - `its_branch`       — HEAD is on the worktree's own branch
 * - `another_branch`   — HEAD is on a different branch (carries its name)
 * - `like_its_branch`  — HEAD is on a branch whose name compares equal to the
 *                        worktree branch under normalization (fail-closed:
 *                        commits stays null)
 * - `detached`         — HEAD is detached (`symbolic-ref -q` exits 1, silent)
 * - `unreadable`       — any other symbolic-ref outcome (fail-closed: null)
 * `null` is returned when no classification is possible at all (hook-based
 * worktrees, or no worktreeBranch recorded).
 */
export type WorktreeHeadClassification =
  | { head: 'its_branch'; commits: number | null }
  | { head: 'another_branch'; branch: string; commits: number | null }
  | { head: 'like_its_branch'; commits: null }
  | { head: 'detached'; commits: number | null }
  | { head: 'unreadable'; commits: null }

/**
 * OCC-164 supplement: WP7 deviation #1 RESOLVED — the official `hh` normalizer
 * WAS recovered from the v304 binary (@247137742, byte-verified; ported above
 * as foldBranchName): a full Unicode casefold (strip DEFAULT_IGNORABLE, NFKD,
 * toLowerCase→toUpperCase→toLowerCase, dotted-i and final-sigma fixups, NFC).
 * The prior case-insensitive lowercase comparison was the documented fail-closed
 * stand-in; like_its_branch detection now matches the official `hh(S)===hh(n)`
 * byte-for-byte (still fail-closed: like_its_branch yields commits:null →
 * dialog asks, tool refuses).
 */
function normalizeBranchNameForComparison(branch: string): string {
  return foldBranchName(branch)
}

/** Official `G$r` — classify where the worktree HEAD points relative to the
 * branch the session created, counting at-stake commits on the worktree
 * branch ref (`refs/heads/<worktreeBranch>`), NOT on HEAD. */
export async function classifyWorktreeHead({
  worktreePath,
  worktreeBranch,
  originalHeadCommit,
  hookBased,
}: {
  worktreePath: string
  worktreeBranch?: string
  originalHeadCommit?: string
  hookBased?: boolean
}): Promise<WorktreeHeadClassification | null> {
  if (hookBased || !worktreeBranch) {
    return null
  }
  const itsBranchRef = `refs/heads/${worktreeBranch}`
  const symbolic = await execFileNoThrowWithCwd(
    gitExe(),
    ['symbolic-ref', '-q', 'HEAD'],
    { cwd: worktreePath },
  )
  const [, headBranch] =
    /^refs\/heads\/(.+)$/.exec(symbolic.stdout.replace(/\r?\n$/, '')) ?? []
  // `git symbolic-ref -q HEAD` exits 1 with no output on a detached HEAD.
  // (Official checks `exitCode===1`; OCC's exec wrapper field is `code`.)
  const isDetached =
    symbolic.code === 1 &&
    symbolic.stdout.trim() === '' &&
    symbolic.stderr.trim() === ''
  if (headBranch === undefined && !isDetached) {
    return { head: 'unreadable', commits: null }
  }
  if (
    headBranch !== undefined &&
    headBranch !== worktreeBranch &&
    normalizeBranchNameForComparison(headBranch) ===
      normalizeBranchNameForComparison(worktreeBranch)
  ) {
    return { head: 'like_its_branch', commits: null }
  }
  const baseline = originalHeadCommit
  if (headBranch === worktreeBranch) {
    return {
      head: 'its_branch',
      commits: baseline
        ? await countCommitsOnRefs(worktreePath, [itsBranchRef], [baseline])
        : null,
    }
  }
  if (headBranch !== undefined) {
    // HEAD moved to another branch: count commits on OUR branch that the
    // other branch and the baseline both lack. If our branch is gone
    // entirely, nothing can be lost through it → 0.
    const commits = baseline
      ? (await countCommitsOnRefs(
          worktreePath,
          [itsBranchRef],
          [`refs/heads/${headBranch}`, baseline],
        )) ?? ((await branchMissing(worktreePath, worktreeBranch)) ? 0 : null)
      : null
    return { head: 'another_branch', branch: headBranch, commits }
  }
  // Detached HEAD: count commits on our branch OR at HEAD beyond the
  // baseline. If our branch is gone, only the detached HEAD can hold work.
  return {
    head: 'detached',
    commits: baseline
      ? (await countCommitsOnRefs(
          worktreePath,
          [itsBranchRef, 'HEAD'],
          [baseline],
        )) ??
        ((await branchMissing(worktreePath, worktreeBranch))
          ? await countCommitsOnRefs(worktreePath, ['HEAD'], [baseline])
          : null)
      : null,
  }
}

/**
 * Full at-stake picture for a worktree exit (official `nOt` result union):
 * the classification above, plus
 * - `not_read`    — no classification was possible; commits came from the
 *                   legacy HEAD rev-list fallback (or are null)
 * - `onKeptBranch` — the worktree moved to another branch AND the worktree's
 *   own branch has 0 unbacked commits, but the branch it moved to holds
 *   commits the session's starting commit lacks. Removal keeps that branch,
 *   so nothing is lost — but the user may still be working there, so never
 *   auto-remove / auto-accept (official refinement in `nOt`).
 */
export type WorktreeExitAtStake =
  | WorktreeHeadClassification
  | { head: 'not_read'; commits: number | null }
  | {
      head: 'another_branch'
      branch: string
      commits: 0
      onKeptBranch: number | null
    }

/** Official `nOt` — entry point. Gate: official
 * `ui('tengu_wary_ladle', {safe:!0})` is default-ON; OCC's `feature()`
 * returns false for unregistered flags, so the gate is hardcoded ON here
 * (same precedent as tengu_bright_lake in
 * src/tools/BashTool/destructiveCommandWarning.ts). */
export async function computeWorktreeExitAtStake(
  session: Pick<
    WorktreeSession,
    'worktreePath' | 'worktreeBranch' | 'originalHeadCommit' | 'hookBased'
  >,
): Promise<WorktreeExitAtStake> {
  const { worktreePath, originalHeadCommit } = session
  const classification = await classifyWorktreeHead(session)
  if (classification === null) {
    return {
      head: 'not_read',
      commits: originalHeadCommit
        ? await countCommitsOnRefs(worktreePath, ['HEAD'], [originalHeadCommit])
        : null,
    }
  }
  if (
    classification.head !== 'another_branch' ||
    classification.commits !== 0
  ) {
    return classification
  }
  // Refinement: the worktree's own branch is clean, but HEAD sits on another
  // branch — count what THAT branch holds beyond the session baseline. 0 →
  // plain another_branch (auto-remove allowed); >0 or unknown (null) →
  // onKeptBranch (never auto-remove).
  const commitsOnKeptBranch = originalHeadCommit
    ? (await countCommitsOnRefs(
        worktreePath,
        [`refs/heads/${classification.branch}`],
        [originalHeadCommit],
      )) ?? null
    : null
  return commitsOnKeptBranch === 0
    ? classification
    : {
        head: classification.head,
        branch: classification.branch,
        commits: 0,
        onKeptBranch: commitsOnKeptBranch,
      }
}

/** Official `tOt` — human phrasing for where at-stake commits live.
 * `otherBranchName` is the branch HEAD moved to (another_branch case). */
export function formatAtStakePhrase(
  atStake: WorktreeExitAtStake,
  branchName: string,
  otherBranchName: string,
): string {
  switch (atStake.head) {
    case 'another_branch':
    case 'like_its_branch':
      return `on ${branchName} that ${otherBranchName} doesn't have`
    case 'detached':
      return `on ${branchName} or at the detached HEAD`
    case 'its_branch':
    case 'unreadable':
    case 'not_read':
      return `on ${branchName}`
  }
}
