import { statSync } from 'fs'
import ignore from 'ignore'
import * as path from 'path'
import {
  CLAUDE_CONFIG_DIRECTORIES,
  loadMarkdownFilesForSubdir,
} from 'src/utils/markdownConfigLoader.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import {
  CHUNK_MS,
  FileIndex,
  yieldToEventLoop,
} from '../native-ts/file-index/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import { getGlobalConfig } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import {
  filterValidIgnorePatterns,
  splitIgnorePatternLines,
} from '../utils/globPatternValidation.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { findGitRoot, gitExe } from '../utils/git.js'
import {
  createBaseHookInput,
  executeFileSuggestionCommand,
} from '../utils/hooks.js'
import { logError } from '../utils/log.js'
import { expandPath } from '../utils/path.js'
import { ripGrep } from '../utils/ripgrep.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { createSignal } from '../utils/signal.js'

// Lazily constructed singleton
let fileIndex: FileIndex | null = null

function getFileIndex(): FileIndex {
  if (!fileIndex) {
    fileIndex = new FileIndex()
  }
  return fileIndex
}

let fileListRefreshPromise: Promise<FileIndex> | null = null
// Signal fired when an in-progress index build completes. Lets the
// typeahead UI re-run its last search so partial results upgrade to full.
const indexBuildComplete = createSignal()
export const onIndexBuildComplete = indexBuildComplete.subscribe
let cacheGeneration = 0

// Background fetch for untracked files
let untrackedFetchPromise: Promise<void> | null = null

// Store tracked files so we can rebuild index with untracked
let cachedTrackedFiles: string[] = []
// Store config files so mergeUntrackedIntoNormalizedCache preserves them
let cachedConfigFiles: string[] = []
// Store tracked directories so mergeUntrackedIntoNormalizedCache doesn't
// recompute ~270k path.dirname() calls on each merge
let cachedTrackedDirs: string[] = []

// Cache for .ignore/.rgignore patterns (keyed by repoRoot:cwd)
let ignorePatternsCache: ReturnType<typeof ignore> | null = null
let ignorePatternsCacheKey: string | null = null

// CC 2.1.311 (ITEM 11): `.ignore`/`.rgignore` negation re-includes for the
// @-file picker. Official state (@263867357 in the 2.1.311 linux-x64 ELF):
// `ignoreReincludeGlobs:[],lastReincludedFiles:[],reincludeRetryAtMs:0`,
// reset in `fvo` (@263867910). Populated by loadRipgrepIgnorePatterns via
// deriveIgnoreReincludeGlobs (official `U`); consumed by the background
// untracked fetch (official `ae` @263877300).
let ignoreReincludeGlobs: string[] = []
let lastReincludedFiles: string[] = []
let reincludeRetryAtMs = 0

/** Official fetch timeout: `AbortSignal.timeout(1e4)` (@263877300). */
const REINCLUDE_FETCH_TIMEOUT_MS = 10_000
/** Official failure backoff: `se=300000` (@263874800). */
const REINCLUDE_RETRY_BACKOFF_MS = 300_000
/** Official `v=[".git",".svn",".hg",".bzr",".jj",".sl"]` (@263872950). */
const VCS_DIRS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
/** Official `Q=v.flatMap(e=>["--glob",`!${e}`])`. */
const VCS_DIR_GLOB_ARGS = VCS_DIRS.flatMap(dir => ['--glob', `!${dir}`])
/** Official chunk-yield budget `jAn=4` inside the G() filter (@263871008). */
const IGNORE_FILTER_CHUNK_MS = 4

// Throttle state for background refresh. .git/index mtime triggers an
// immediate refresh when tracked files change (add/checkout/commit/rm).
// The time floor still refreshes every 5s to pick up untracked files,
// which don't bump the index.
let lastRefreshMs = 0
let lastGitIndexMtime: number | null = null

// Signatures of the path lists loaded into the Rust index. Two separate
// signatures because the two loadFromFileList call sites use differently
// structured arrays — a shared signature would ping-pong and never match.
// Skips nucleo.restart() when git ls-files returns an unchanged list
// (e.g. `git add` of an already-tracked file bumps index mtime but not the list).
let loadedTrackedSignature: string | null = null
let loadedMergedSignature: string | null = null

/**
 * Clear all file suggestion caches.
 * Call this when resuming a session to ensure fresh file discovery.
 */
export function clearFileSuggestionCaches(): void {
  fileIndex = null
  fileListRefreshPromise = null
  cacheGeneration++
  untrackedFetchPromise = null
  cachedTrackedFiles = []
  cachedConfigFiles = []
  cachedTrackedDirs = []
  indexBuildComplete.clear()
  ignorePatternsCache = null
  ignorePatternsCacheKey = null
  // Official `fvo` reset (@263867910) clears the ITEM 11 re-include state.
  ignoreReincludeGlobs = []
  lastReincludedFiles = []
  reincludeRetryAtMs = 0
  lastRefreshMs = 0
  lastGitIndexMtime = null
  loadedTrackedSignature = null
  loadedMergedSignature = null
}

/**
 * Content hash of a path list. A length|first|last sample misses renames of
 * middle files (same length, same endpoints → stale entry stuck in nucleo).
 *
 * Samples every Nth path (plus length). On a 346k-path list this hashes ~700
 * paths instead of 14MB — enough to catch git operations (checkout, rebase,
 * add/rm) while running in <1ms. A single mid-list rename that happens to
 * fall between samples will miss the rebuild, but the 5s refresh floor picks
 * it up on the next cycle.
 */
export function pathListSignature(paths: string[]): string {
  const n = paths.length
  const stride = Math.max(1, Math.floor(n / 500))
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < n; i += stride) {
    const p = paths[i]!
    for (let j = 0; j < p.length; j++) {
      h = ((h ^ p.charCodeAt(j)) * 0x01000193) | 0
    }
    h = (h * 0x01000193) | 0
  }
  // Stride starts at 0 (first path always hashed); explicitly include last
  // so single-file add/rm at the tail is caught
  if (n > 0) {
    const last = paths[n - 1]!
    for (let j = 0; j < last.length; j++) {
      h = ((h ^ last.charCodeAt(j)) * 0x01000193) | 0
    }
  }
  return `${n}:${(h >>> 0).toString(16)}`
}

/**
 * Stat .git/index to detect git state changes without spawning git ls-files.
 * Returns null for worktrees (.git is a file → ENOTDIR), fresh repos with no
 * index yet (ENOENT), and non-git dirs — caller falls back to time throttle.
 */
function getGitIndexMtime(): number | null {
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) return null
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- mtimeMs is the operation here, not a pre-check. findGitRoot above already stat-walks synchronously; one more stat is marginal vs spawning git ls-files on every keystroke. Async would force startBackgroundCacheRefresh to become async, breaking the synchronous fileListRefreshPromise contract at the cold-start await site.
    return statSync(path.join(repoRoot, '.git', 'index')).mtimeMs
  } catch {
    return null
  }
}

/**
 * Normalize git paths relative to originalCwd
 */
function normalizeGitPaths(
  files: string[],
  repoRoot: string,
  originalCwd: string,
): string[] {
  if (originalCwd === repoRoot) {
    return files
  }
  return files.map(f => {
    const absolutePath = path.join(repoRoot, f)
    return path.relative(originalCwd, absolutePath)
  })
}

/**
 * Merge already-normalized untracked files into the cache
 */
async function mergeUntrackedIntoNormalizedCache(
  normalizedUntracked: string[],
): Promise<void> {
  if (normalizedUntracked.length === 0) return
  if (!fileIndex || cachedTrackedFiles.length === 0) return

  const untrackedDirs = await getDirectoryNamesAsync(normalizedUntracked)
  const allPaths = [
    ...cachedTrackedFiles,
    ...cachedConfigFiles,
    ...cachedTrackedDirs,
    ...normalizedUntracked,
    ...untrackedDirs,
  ]
  const sig = pathListSignature(allPaths)
  if (sig === loadedMergedSignature) {
    logForDebugging(
      `[FileIndex] skipped index rebuild — merged paths unchanged`,
    )
    return
  }
  await fileIndex.loadFromFileListAsync(allPaths).done
  loadedMergedSignature = sig
  logForDebugging(
    `[FileIndex] rebuilt index with ${cachedTrackedFiles.length} tracked + ${normalizedUntracked.length} untracked files`,
  )
}

/**
 * CC 2.1.311 (ITEM 11) re-include derivation — faithful port of the official
 * `U(e,i)` (@263869960 in the 2.1.311 linux-x64 binary) with its helpers:
 *
 *   M(e)=!e.startsWith("/")&&!e.replace(/\/+$/,"").includes("/")
 *   W(e)=e.replace(/[[\]{}*?\\]/g,"\\$&").replace(/^[!#]/,"\\$&")
 *   q(e,i): i===""→e; e.startsWith("/")→`${i}${e}`; M(e)→`${i}/**\/${e}`;
 *           else `${i}/${e}`
 *   U(e,i): per line — `p=c.endsWith("\\ ")?c:c.trimEnd()`; skip ""/#;
 *           `u=p.startsWith("!")`, `f=u?p.slice(1):p`, skip f===""; `g=q(f,r)`;
 *           negated → `o=true; n.push(g); if(!g.endsWith("**")){m=g.replace
 *           (/\/+$/,""); s.push(M(m)?`**\/${m}/**`:`${m}/**`)}`;
 *           else `n.push(`!${g}`)`; returns
 *           `{hasNegation:o,augmentations:s,rules:n}`.
 */
type ReincludeDerivation = {
  hasNegation: boolean
  augmentations: string[]
  rules: string[]
}

/** Official `M`: no leading slash and no interior slash (trailing stripped). */
function isBareName(pattern: string): boolean {
  return !pattern.startsWith('/') && !pattern.replace(/\/+$/, '').includes('/')
}

/** Official `W`: escape glob metacharacters (dot is NOT escaped). */
function escapeGlobChars(dir: string): string {
  return dir.replace(/[[\]{}*?\\]/g, '\\$&').replace(/^[!#]/, '\\$&')
}

/** Official `q`: anchor a pattern under its ignore file's relative dir. */
function anchorPatternToDir(pattern: string, escapedDir: string): string {
  if (escapedDir === '') return pattern
  if (pattern.startsWith('/')) return `${escapedDir}${pattern}`
  if (isBareName(pattern)) return `${escapedDir}/**/${pattern}`
  return `${escapedDir}/${pattern}`
}

/**
 * Derive the rg `--glob` whitelist set for one ignore file's patterns.
 * Exported for unit tests (mirrors official `U` exactly).
 */
export function deriveIgnoreReincludeGlobs(
  patterns: readonly string[],
  relDir: string,
): ReincludeDerivation {
  const escapedDir = escapeGlobChars(relDir)
  let hasNegation = false
  const augmentations: string[] = []
  const rules: string[] = []
  for (const rawLine of patterns) {
    // A trailing escaped space is significant — official keeps it untrimmed.
    const line = rawLine.endsWith('\\ ') ? rawLine : rawLine.trimEnd()
    if (line === '' || line.startsWith('#')) continue
    const isNegation = line.startsWith('!')
    const body = isNegation ? line.slice(1) : line
    if (body === '') continue
    const anchored = anchorPatternToDir(body, escapedDir)
    if (isNegation) {
      hasNegation = true
      rules.push(anchored)
      if (!anchored.endsWith('**')) {
        const stripped = anchored.replace(/\/+$/, '')
        augmentations.push(
          isBareName(stripped) ? `**/${stripped}/**` : `${stripped}/**`,
        )
      }
    } else {
      rules.push(`!${anchored}`)
    }
  }
  return { hasNegation, augmentations, rules }
}

/** Test-only snapshot of the ITEM 11 re-include state (copies, not aliases). */
export function _getReincludeStateForTesting(): {
  ignoreReincludeGlobs: string[]
  lastReincludedFiles: string[]
  reincludeRetryAtMs: number
} {
  return {
    ignoreReincludeGlobs: [...ignoreReincludeGlobs],
    lastReincludedFiles: [...lastReincludedFiles],
    reincludeRetryAtMs,
  }
}

/**
 * Official `G(e,i)` (@263871008): keep a path when the `ignore` package's
 * STATIC `isPathValid` rejects it (absolute / `..` paths can't be tested) or
 * the instance doesn't ignore it, yielding to the event loop every 256 paths
 * once the 4ms chunk budget (`jAn`) is spent. Used at BOTH filter sites.
 */
async function filterIgnoredPaths(
  ig: ReturnType<typeof ignore>,
  paths: readonly string[],
): Promise<string[]> {
  const kept: string[] = []
  let chunkStart = performance.now()
  for (let i = 0; i < paths.length; i++) {
    const candidate = paths[i]!
    if (!ignore.isPathValid(candidate) || !ig.ignores(candidate)) {
      kept.push(candidate)
    }
    if (
      (i & 255) === 255 &&
      performance.now() - chunkStart > IGNORE_FILTER_CHUNK_MS
    ) {
      await yieldToEventLoop()
      chunkStart = performance.now()
    }
  }
  return kept
}

/**
 * Official re-include fetch (@263877300):
 * `w5(["--files","--hidden",...globs.flatMap(u=>["--glob",u]),...Q],".",
 *  AbortSignal.timeout(1e4),{cwd:repoRoot,rejectOnPartial:!0})`.
 * OCC deviation: `ripGrep` takes no cwd/rejectOnPartial options, so repoRoot
 * is passed as the target and results are relativized back to repoRoot-
 * relative form. Failure semantics verbatim: the log line is UNCONDITIONAL,
 * the backoff write is cacheGeneration-guarded, and the failure RETURNS the
 * previous `lastReincludedFiles`.
 */
async function fetchReincludedFiles(
  repoRoot: string,
  generation: number,
): Promise<string[]> {
  const args = [
    '--files',
    '--hidden',
    ...ignoreReincludeGlobs.flatMap(glob => ['--glob', glob]),
    ...VCS_DIR_GLOB_ARGS,
  ]
  try {
    const listed = await ripGrep(
      args,
      repoRoot,
      AbortSignal.timeout(REINCLUDE_FETCH_TIMEOUT_MS),
    )
    const files = listed.map(f =>
      path.relative(repoRoot, f).replaceAll(path.sep, '/'),
    )
    if (generation === cacheGeneration) {
      lastReincludedFiles = files
    }
    return files
  } catch (error) {
    logForDebugging(
      `[FileIndex] .ignore re-include listing failed: ${errorMessage(error)}`,
    )
    if (generation === cacheGeneration) {
      reincludeRetryAtMs = Date.now() + REINCLUDE_RETRY_BACKOFF_MS
    }
    return lastReincludedFiles
  }
}

/**
 * Load ripgrep-specific ignore patterns from .ignore or .rgignore files
 * Returns an ignore instance if patterns were found, null otherwise
 * Results are cached per repoRoot:cwd combination
 */
async function loadRipgrepIgnorePatterns(
  repoRoot: string,
  cwd: string,
): Promise<ReturnType<typeof ignore> | null> {
  const cacheKey = `${repoRoot}:${cwd}`

  // Return cached result if available
  if (ignorePatternsCacheKey === cacheKey) {
    return ignorePatternsCache
  }

  const fs = getFsImplementation()
  const ignoreFiles = ['.ignore', '.rgignore']
  const directories = [...new Set([repoRoot, cwd])]

  const ig = ignore()
  let hasPatterns = false
  // CC 2.1.311 (ITEM 11): accumulate the per-file re-include derivations.
  // Official: `f||=k.hasNegation; g.push(...k.augmentations); m.push(...k.rules)`
  // then `ignoreReincludeGlobs = f ? [...g,...m] : []`.
  let hasNegation = false
  const augmentations: string[] = []
  const reincludeRules: string[] = []

  const paths = directories.flatMap(dir =>
    ignoreFiles.map(f => path.join(dir, f)),
  )
  const contents = await Promise.all(
    paths.map(p => fs.readFile(p, { encoding: 'utf8' }).catch(() => null)),
  )
  for (const [i, content] of contents.entries()) {
    if (content === null) continue
    const patterns = filterValidIgnorePatterns(
      splitIgnorePatternLines(content),
      'file_suggestions_ignore',
    )
    ig.add(patterns)
    hasPatterns = true
    // Official `k=U(b, path.relative(repoRoot, path.dirname(file))
    //   .replaceAll(path.sep,"/"))` — U consumes the SAME filtered list.
    const ignoreFilePath = paths[i]!
    const derived = deriveIgnoreReincludeGlobs(
      patterns,
      path
        .relative(repoRoot, path.dirname(ignoreFilePath))
        .replaceAll(path.sep, '/'),
    )
    hasNegation ||= derived.hasNegation
    augmentations.push(...derived.augmentations)
    reincludeRules.push(...derived.rules)
    logForDebugging(`[FileIndex] loaded ignore patterns from ${ignoreFilePath}`)
  }
  ignoreReincludeGlobs = hasNegation ? [...augmentations, ...reincludeRules] : []

  const result = hasPatterns ? ig : null
  ignorePatternsCache = result
  ignorePatternsCacheKey = cacheKey

  return result
}

/**
 * CC 2.1.311 (ITEM 11): merge the background git-untracked result with the
 * `.ignore` re-included listing (official merge tail of `ae` @263877300).
 * Extracted to keep getFilesUsingGit focused; semantics verbatim:
 * - `if(u.code!==0)return` — a git failure discards the re-included listing.
 * - Re-included files are normalized + sorted and PLAIN-APPENDED (no dedup).
 * - The summary log ALWAYS carries the `(${n} re-included by .ignore)` suffix.
 */
async function mergeBackgroundUntracked(
  untrackedResult: Awaited<ReturnType<typeof execFileNoThrowWithCwd>>,
  reincludedFiles: readonly string[],
  repoRoot: string,
  cwd: string,
): Promise<void> {
  if (untrackedResult.code !== 0) {
    return
  }
  const rawUntrackedFiles = untrackedResult.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
  const merged = [...rawUntrackedFiles]
  for (const reincluded of reincludedFiles
    .map(f => path.normalize(f).replaceAll(path.sep, '/'))
    .sort()) {
    merged.push(reincluded)
  }

  // Normalize paths BEFORE applying ignore patterns (consistent with tracked files)
  let normalizedUntracked = normalizeGitPaths(merged, repoRoot, cwd)

  // Apply .ignore/.rgignore patterns to normalized untracked files (official
  // G() filter — negation whitelists keep the re-included files).
  const ignorePatterns = await loadRipgrepIgnorePatterns(repoRoot, cwd)
  if (ignorePatterns && normalizedUntracked.length > 0) {
    const beforeCount = normalizedUntracked.length
    normalizedUntracked = await filterIgnoredPaths(
      ignorePatterns,
      normalizedUntracked,
    )
    logForDebugging(
      `[FileIndex] applied ignore patterns to untracked: ${beforeCount} -> ${normalizedUntracked.length} files`,
    )
  }

  logForDebugging(
    `[FileIndex] background untracked fetch: ${normalizedUntracked.length} files (${reincludedFiles.length} re-included by .ignore)`,
  )
  // Pass already-normalized files directly to merge function
  void mergeUntrackedIntoNormalizedCache(normalizedUntracked)
}

/**
 * Get files using git ls-files (much faster than ripgrep for git repos)
 * Returns tracked files immediately, fetches untracked in background
 * @param respectGitignore If true, excludes gitignored files from untracked results
 *
 * Note: Unlike ripgrep --follow, git ls-files doesn't follow symlinks.
 * This is intentional as git tracks symlinks as symlinks.
 */
async function getFilesUsingGit(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[] | null> {
  const startTime = Date.now()
  logForDebugging(`[FileIndex] getFilesUsingGit called`)

  // Check if we're in a git repo. findGitRoot is LRU-memoized per path.
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) {
    logForDebugging(`[FileIndex] not a git repo, returning null`)
    return null
  }

  try {
    const cwd = getCwd()

    // Get tracked files (fast - reads from git index)
    // Run from repoRoot so paths are relative to repo root, not CWD
    const lsFilesStart = Date.now()
    const trackedResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
      { timeout: 5000, abortSignal, cwd: repoRoot },
    )
    logForDebugging(
      `[FileIndex] git ls-files (tracked) took ${Date.now() - lsFilesStart}ms`,
    )

    if (trackedResult.code !== 0) {
      logForDebugging(
        `[FileIndex] git ls-files failed (code=${trackedResult.code}, stderr=${trackedResult.stderr}), falling back to ripgrep`,
      )
      return null
    }

    const trackedFiles = trackedResult.stdout.trim().split('\n').filter(Boolean)

    // Normalize paths relative to the current working directory
    let normalizedTracked = normalizeGitPaths(trackedFiles, repoRoot, cwd)

    // Apply .ignore/.rgignore patterns if present (faster than falling back to ripgrep)
    const ignorePatterns = await loadRipgrepIgnorePatterns(repoRoot, cwd)
    if (ignorePatterns) {
      const beforeCount = normalizedTracked.length
      // CC 2.1.311 (ITEM 11): official G() filter (@263871008) — paths the
      // `ignore` package can't test (absolute / `..`) are KEPT.
      normalizedTracked = await filterIgnoredPaths(
        ignorePatterns,
        normalizedTracked,
      )
      logForDebugging(
        `[FileIndex] applied ignore patterns: ${beforeCount} -> ${normalizedTracked.length} files`,
      )
    }

    // Cache tracked files for later merge with untracked
    cachedTrackedFiles = normalizedTracked

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] git ls-files: ${normalizedTracked.length} tracked files in ${duration}ms`,
    )

    logEvent('tengu_file_suggestions_git_ls_files', {
      file_count: normalizedTracked.length,
      tracked_count: normalizedTracked.length,
      untracked_count: 0,
      duration_ms: duration,
    })

    // Start background fetch for untracked files (don't await)
    if (!untrackedFetchPromise) {
      const untrackedArgs = respectGitignore
        ? [
            '-c',
            'core.quotepath=false',
            'ls-files',
            '--others',
            '--exclude-standard',
          ]
        : ['-c', 'core.quotepath=false', 'ls-files', '--others']

      const generation = cacheGeneration
      // CC 2.1.311 (ITEM 11): official gate `c=n&&e.ignoreReincludeGlobs.length>0`
      // — the re-include fetch runs only when gitignore is respected AND the
      // loader derived negation globs; while the 5-minute backoff is active it
      // serves the last successful listing ([] after a first failure).
      const reincludeActive =
        respectGitignore && ignoreReincludeGlobs.length > 0
      const reincludePromise =
        reincludeActive && Date.now() >= reincludeRetryAtMs
          ? fetchReincludedFiles(repoRoot, generation)
          : Promise.resolve(reincludeActive ? [...lastReincludedFiles] : [])

      untrackedFetchPromise = Promise.all([
        execFileNoThrowWithCwd(gitExe(), untrackedArgs, {
          timeout: 10000,
          cwd: repoRoot,
        }),
        reincludePromise,
      ])
        .then(async ([untrackedResult, reincludedFiles]) => {
          if (generation !== cacheGeneration) {
            return // Cache was cleared; don't merge stale untracked files
          }
          await mergeBackgroundUntracked(
            untrackedResult,
            reincludedFiles,
            repoRoot,
            cwd,
          )
        })
        .catch(error => {
          logForDebugging(
            `[FileIndex] background untracked fetch failed: ${error}`,
          )
        })
        .finally(() => {
          untrackedFetchPromise = null
        })
    }

    return normalizedTracked
  } catch (error) {
    logForDebugging(`[FileIndex] git ls-files error: ${errorMessage(error)}`)
    return null
  }
}

/**
 * This function collects all parent directories for each file path
 * and returns a list of unique directory names with a trailing separator.
 * For example, if the input is ['src/index.js', 'src/utils/helpers.js'],
 * the output will be ['src/', 'src/utils/'].
 * @param files An array of file paths
 * @returns An array of unique directory names with a trailing separator
 */
export function getDirectoryNames(files: string[]): string[] {
  const directoryNames = new Set<string>()
  collectDirectoryNames(files, 0, files.length, directoryNames)
  return [...directoryNames].map(d => d + path.sep)
}

/**
 * Async variant: yields every ~10k files so 270k+ file lists don't block
 * the main thread for >10ms at a time.
 */
export async function getDirectoryNamesAsync(
  files: string[],
): Promise<string[]> {
  const directoryNames = new Set<string>()
  // Time-based chunking: yield after CHUNK_MS of work so slow machines get
  // smaller chunks and stay responsive.
  let chunkStart = performance.now()
  for (let i = 0; i < files.length; i++) {
    collectDirectoryNames(files, i, i + 1, directoryNames)
    if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
      await yieldToEventLoop()
      chunkStart = performance.now()
    }
  }
  return [...directoryNames].map(d => d + path.sep)
}

function collectDirectoryNames(
  files: string[],
  start: number,
  end: number,
  out: Set<string>,
): void {
  for (let i = start; i < end; i++) {
    let currentDir = path.dirname(files[i]!)
    // Early exit if we've already processed this directory and all its parents.
    // Root detection: path.dirname returns its input at the root (fixed point),
    // so we stop when dirname stops changing. Checking this before add() keeps
    // the root out of the result set (matching the old path.parse().root guard).
    // This avoids path.parse() which allocates a 5-field object per file.
    while (currentDir !== '.' && !out.has(currentDir)) {
      const parent = path.dirname(currentDir)
      if (parent === currentDir) break
      out.add(currentDir)
      currentDir = parent
    }
  }
}

/**
 * Gets additional files from Claude config directories
 */
async function getClaudeConfigFiles(cwd: string): Promise<string[]> {
  const markdownFileArrays = await Promise.all(
    CLAUDE_CONFIG_DIRECTORIES.map(subdir =>
      loadMarkdownFilesForSubdir(subdir, cwd),
    ),
  )
  return markdownFileArrays.flatMap(markdownFiles =>
    markdownFiles.map(f => f.filePath),
  )
}

/**
 * Gets project files using git ls-files (fast) or ripgrep (fallback)
 */
async function getProjectFiles(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[]> {
  logForDebugging(
    `[FileIndex] getProjectFiles called, respectGitignore=${respectGitignore}`,
  )

  // Try git ls-files first (much faster for git repos)
  const gitFiles = await getFilesUsingGit(abortSignal, respectGitignore)
  if (gitFiles !== null) {
    logForDebugging(
      `[FileIndex] using git ls-files result (${gitFiles.length} files)`,
    )
    return gitFiles
  }

  // Fall back to ripgrep
  logForDebugging(
    `[FileIndex] git ls-files returned null, falling back to ripgrep`,
  )
  const startTime = Date.now()
  const rgArgs = [
    '--files',
    '--follow',
    '--hidden',
    '--glob',
    '!.git/',
    '--glob',
    '!.svn/',
    '--glob',
    '!.hg/',
    '--glob',
    '!.bzr/',
    '--glob',
    '!.jj/',
    '--glob',
    '!.sl/',
  ]
  if (!respectGitignore) {
    rgArgs.push('--no-ignore-vcs')
  }

  const files = await ripGrep(rgArgs, '.', abortSignal)
  const relativePaths = files.map(f => path.relative(getCwd(), f))

  const duration = Date.now() - startTime
  logForDebugging(
    `[FileIndex] ripgrep: ${relativePaths.length} files in ${duration}ms`,
  )

  logEvent('tengu_file_suggestions_ripgrep', {
    file_count: relativePaths.length,
    duration_ms: duration,
  })

  return relativePaths
}

/**
 * Gets both files and their directory paths for providing path suggestions
 * Uses git ls-files for git repos (fast) or ripgrep as fallback
 * Returns a FileIndex populated for fast fuzzy search
 */
export async function getPathsForSuggestions(): Promise<FileIndex> {
  const signal = AbortSignal.timeout(10_000)
  const index = getFileIndex()

  try {
    // Check project settings first, then fall back to global config
    const projectSettings = getInitialSettings()
    const globalConfig = getGlobalConfig()
    const respectGitignore =
      projectSettings.respectGitignore ?? globalConfig.respectGitignore ?? true

    const cwd = getCwd()
    const [projectFiles, configFiles] = await Promise.all([
      getProjectFiles(signal, respectGitignore),
      getClaudeConfigFiles(cwd),
    ])

    // Cache for mergeUntrackedIntoNormalizedCache
    cachedConfigFiles = configFiles

    const allFiles = [...projectFiles, ...configFiles]
    const directories = await getDirectoryNamesAsync(allFiles)
    cachedTrackedDirs = directories
    const allPathsList = [...directories, ...allFiles]

    // Skip rebuild when the list is unchanged. This is the common case
    // during a typing session — git ls-files returns the same output.
    const sig = pathListSignature(allPathsList)
    if (sig !== loadedTrackedSignature) {
      // Await the full build so cold-start returns complete results. The
      // build yields every ~4ms so the UI stays responsive — user can keep
      // typing during the ~120ms wait without input lag.
      await index.loadFromFileListAsync(allPathsList).done
      loadedTrackedSignature = sig
      // We just replaced the merged index with tracked-only data. Force
      // the next untracked merge to rebuild even if its own sig matches.
      loadedMergedSignature = null
    } else {
      logForDebugging(
        `[FileIndex] skipped index rebuild — tracked paths unchanged`,
      )
    }
  } catch (error) {
    logError(error)
  }

  return index
}

/**
 * Finds the common prefix between two strings
 */
function findCommonPrefix(a: string, b: string): string {
  const minLength = Math.min(a.length, b.length)
  let i = 0
  while (i < minLength && a[i] === b[i]) {
    i++
  }
  return a.substring(0, i)
}

/**
 * Finds the longest common prefix among an array of suggestion items
 */
export function findLongestCommonPrefix(suggestions: SuggestionItem[]): string {
  if (suggestions.length === 0) return ''

  const strings = suggestions.map(item => item.displayText)
  let prefix = strings[0]!
  for (let i = 1; i < strings.length; i++) {
    const currentString = strings[i]!
    prefix = findCommonPrefix(prefix, currentString)
    if (prefix === '') return ''
  }
  return prefix
}

/**
 * Creates a file suggestion item
 */
function createFileSuggestionItem(
  filePath: string,
  score?: number,
): SuggestionItem {
  return {
    id: `file-${filePath}`,
    displayText: filePath,
    metadata: score !== undefined ? { score } : undefined,
  }
}

/**
 * Find matching files and folders for a given query using the TS file index
 */
const MAX_SUGGESTIONS = 15

/**
 * CC 2.1.276 (ITEM T): "Fixed @-mention file suggestions being buried below
 * MCP resources." Official v276 `k` (byte-extracted @208749909):
 *   `function k(e){let r=e.slice(0,_);return r.map((o,n)=>S(o,n/Math.max(r.length,1)))}`
 * v274 mapped the raw array index as the score (`.slice(0,S).map(I)`), so
 * suggestions #2..#15 carried scores 1..14. The unified suggestion list sorts
 * ASCENDING (lower = better) and MCP resources score ~0.5 — every index-scored
 * file suggestion except the first sank below them. Normalizing to
 * `n / capped.length ∈ [0,1)` restores interleaving. Truncate FIRST, then
 * normalize by the post-truncation length (official order).
 */
function mapWithNormalizedScores(paths: string[]): SuggestionItem[] {
  const capped = paths.slice(0, MAX_SUGGESTIONS)
  return capped.map((filePath, index) =>
    createFileSuggestionItem(filePath, index / Math.max(capped.length, 1)),
  )
}

function findMatchingFiles(
  fileIndex: FileIndex,
  partialPath: string,
): SuggestionItem[] {
  const results = fileIndex.search(partialPath, MAX_SUGGESTIONS)
  return results.map(result =>
    createFileSuggestionItem(result.path, result.score),
  )
}

/**
 * Starts a background refresh of the file index cache if not already in progress.
 *
 * Throttled: when a cache already exists, we skip the refresh unless git state
 * has actually changed. This prevents every keystroke from spawning git ls-files
 * and rebuilding the nucleo index.
 */
const REFRESH_THROTTLE_MS = 5_000
export function startBackgroundCacheRefresh(): void {
  if (fileListRefreshPromise) return

  // Throttle only when a cache exists — cold start must always populate.
  // Refresh immediately when .git/index mtime changed (tracked files).
  // Otherwise refresh at most once per 5s — this floor picks up new UNTRACKED
  // files, which don't bump .git/index. The signature checks downstream skip
  // the rebuild when the 5s refresh finds nothing actually changed.
  const indexMtime = getGitIndexMtime()
  if (fileIndex) {
    const gitStateChanged =
      indexMtime !== null && indexMtime !== lastGitIndexMtime
    if (!gitStateChanged && Date.now() - lastRefreshMs < REFRESH_THROTTLE_MS) {
      return
    }
  }

  const generation = cacheGeneration
  const refreshStart = Date.now()
  // Ensure the FileIndex singleton exists — it's progressively queryable
  // via readyCount while the build runs. Callers searching early get partial
  // results; indexBuildComplete fires after .done so they can re-search.
  getFileIndex()
  fileListRefreshPromise = getPathsForSuggestions()
    .then(result => {
      if (generation !== cacheGeneration) {
        return result // Cache was cleared; don't overwrite with stale data
      }
      fileListRefreshPromise = null
      indexBuildComplete.emit()
      // Commit the start-time mtime observation on success. If git state
      // changed mid-refresh, the next call will see the newer mtime and
      // correctly refresh again.
      lastGitIndexMtime = indexMtime
      lastRefreshMs = Date.now()
      logForDebugging(
        `[FileIndex] cache refresh completed in ${Date.now() - refreshStart}ms`,
      )
      return result
    })
    .catch(error => {
      logForDebugging(
        `[FileIndex] Cache refresh failed: ${errorMessage(error)}`,
      )
      logError(error)
      if (generation === cacheGeneration) {
        fileListRefreshPromise = null // Allow retry on next call
      }
      return getFileIndex()
    })
}

/**
 * Gets the top-level files and directories in the current working directory
 * @returns Array of file/directory paths in the current directory
 */
async function getTopLevelPaths(): Promise<string[]> {
  const fs = getFsImplementation()
  const cwd = getCwd()

  try {
    const entries = await fs.readdir(cwd)
    return entries.map(entry => {
      const fullPath = path.join(cwd, entry.name)
      const relativePath = path.relative(cwd, fullPath)
      // Add trailing separator for directories
      return entry.isDirectory() ? relativePath + path.sep : relativePath
    })
  } catch (error) {
    logError(error as Error)
    return []
  }
}

/**
 * Generate file suggestions for the current input and cursor position
 * @param partialPath The partial file path to match
 * @param showOnEmpty Whether to show suggestions even if partialPath is empty (used for @ symbol)
 */
export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  // If input is empty and we don't want to show suggestions on empty, return nothing
  if (!partialPath && !showOnEmpty) {
    return []
  }

  // Use custom command directly if configured. We don't mix in our config files
  // because the command returns pre-ranked results using its own search logic.
  if (getInitialSettings().fileSuggestion?.type === 'command') {
    const input: FileSuggestionCommandInput = {
      ...createBaseHookInput(),
      query: partialPath,
    }
    const results = await executeFileSuggestionCommand(input)
    return mapWithNormalizedScores(results)
  }

  // If the partial path is empty or just a dot, return current directory suggestions
  if (partialPath === '' || partialPath === '.' || partialPath === './') {
    const topLevelPaths = await getTopLevelPaths()
    startBackgroundCacheRefresh()
    return mapWithNormalizedScores(topLevelPaths)
  }

  const startTime = Date.now()

  try {
    // Kick a background refresh. The index is progressively queryable —
    // searches during build return partial results from ready chunks, and
    // the typeahead callback (setOnIndexBuildComplete) re-fires the search
    // when the build finishes to upgrade partial → full.
    const wasBuilding = fileListRefreshPromise !== null
    startBackgroundCacheRefresh()

    // Handle both './' and '.\'
    let normalizedPath = partialPath
    const currentDirPrefix = '.' + path.sep
    if (partialPath.startsWith(currentDirPrefix)) {
      normalizedPath = partialPath.substring(2)
    }

    // Handle tilde expansion for home directory
    if (normalizedPath.startsWith('~')) {
      normalizedPath = expandPath(normalizedPath)
    }

    const matches = fileIndex
      ? findMatchingFiles(fileIndex, normalizedPath)
      : []

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] generateFileSuggestions: ${matches.length} results in ${duration}ms (${wasBuilding ? 'partial' : 'full'} index)`,
    )
    logEvent('tengu_file_suggestions_query', {
      duration_ms: duration,
      cache_hit: !wasBuilding,
      result_count: matches.length,
      query_length: partialPath.length,
    })

    return matches
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * Apply a file suggestion to the input
 */
export function applyFileSuggestion(
  suggestion: string | SuggestionItem,
  input: string,
  partialPath: string,
  startPos: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
): void {
  // Extract suggestion text from string or SuggestionItem
  const suggestionText =
    typeof suggestion === 'string' ? suggestion : suggestion.displayText

  // Replace the partial path with the selected file path
  const newInput =
    input.substring(0, startPos) +
    suggestionText +
    input.substring(startPos + partialPath.length)
  onInputChange(newInput)

  // Move cursor to end of the file path
  const newCursorPos = startPos + suggestionText.length
  setCursorOffset(newCursorPos)
}
