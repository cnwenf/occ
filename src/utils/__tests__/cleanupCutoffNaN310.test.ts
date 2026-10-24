/**
 * Official Claude Code 2.1.310 changelog item 3 — "Fixed background cleanup
 * deleting some recent files, such as pasted images, when cleanupPeriodDays
 * is set to a very large value."
 *
 * Source of truth: BIN310 @258251150..258251560 (byte-verified via read-only
 * forensics; the binary was never executed):
 *   function _e(e){let r=new Date(Date.now()-e*24*60*60*1000);
 *                  return Number.isNaN(r.getTime())?null:r}
 *   function kS(e){let s=(pr()||{}).cleanupPeriodDays??m1t;if(s===0)return null;
 *                  if(e!==void 0&&e<s)s=e;return _e(s)}
 * BIN309 @260440480 had the single UNGUARDED `_S` (same math, no NaN check).
 * Callers skip their sweep on a null cutoff (BIN310 @258253023, @258257219):
 *   let r=kS();if(r===null)return E();
 * and the background orchestrator wraps pastes + the stale-worktree sweep in
 * one null check (BIN310 @258283561):
 *   let O=kS();if(O!==null){await z1s(O,e);...let A=await vAo(O,g,!1);
 *                           if(A>0)a("tengu_worktree_cleanup",{removed:A});...}
 *
 * DEDICATED mock.module FILE (settings / cachePaths / pasteStore / worktree
 * seams) — all re-pinned in afterAll.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// --- temp config dir (memoize in envUtils is keyed off CLAUDE_CONFIG_DIR) ----
const configDir = mkdtempSync(join(tmpdir(), 'occ-cleanup-cutoff-310-'))
const savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR
const savedUserType = process.env.USER_TYPE
process.env.CLAUDE_CONFIG_DIR = configDir
delete process.env.USER_TYPE

// --- settings seam -----------------------------------------------------------
// Eager spread copies BEFORE any mock.module (OCC-97/132): bun patches the
// captured namespace IN PLACE, so a lazy `...realModule` spread inside a
// restore factory would re-pin the MOCK values and leak them into every later
// file in a shared-process `bun test src` run (OCC-132 A/B: this file's lazy
// restore polluted otelHeadersHelperFailure275 +11 and apiKeyHelper-retry +5).
let mockedCleanupPeriodDays: number | undefined

const realSettingsModule = await import('../settings/settings.js')
const realSettingsExports = { ...realSettingsModule }
mock.module('../settings/settings.js', () => ({
  ...realSettingsExports,
  getSettings_DEPRECATED: () =>
    mockedCleanupPeriodDays === undefined
      ? {}
      : { cleanupPeriodDays: mockedCleanupPeriodDays },
  rawSettingsContainsKey: () => false,
}))

const realAllErrorsModule = await import('../settings/allErrors.js')
const realAllErrorsExports = { ...realAllErrorsModule }
mock.module('../settings/allErrors.js', () => ({
  ...realAllErrorsExports,
  getSettingsWithAllErrors: () => ({ settings: {}, errors: [] }),
}))

// --- cachePaths seam (real CACHE_PATHS points at the ambient ~/.cache) -------
const realCachePathsModule = await import('../cachePaths.js')
const realCachePathsExports = { ...realCachePathsModule }
mock.module('../cachePaths.js', () => ({
  ...realCachePathsExports,
  CACHE_PATHS: {
    ...realCachePathsExports.CACHE_PATHS,
    errors: () => join(configDir, 'cache-errors'),
    baseLogs: () => join(configDir, 'cache-base-logs'),
    messages: () => join(configDir, 'cache-messages'),
  },
}))

// --- paste + worktree spy seams (orchestrator null-skip shape) ---------------
const realPasteStoreModule = await import('../pasteStore.js')
const realPasteStoreExports = { ...realPasteStoreModule }
const cleanupOldPastesSpy = mock(async (_cutoffDate: Date): Promise<void> => {})
mock.module('../pasteStore.js', () => ({
  ...realPasteStoreExports,
  cleanupOldPastes: cleanupOldPastesSpy,
}))

const realWorktreeModule = await import('../worktree.js')
const realWorktreeExports = { ...realWorktreeModule }
const cleanupStaleAgentWorktreesSpy = mock(
  async (_cutoffDate: Date | null): Promise<number> => 0,
)
mock.module('../worktree.js', () => ({
  ...realWorktreeExports,
  cleanupStaleAgentWorktrees: cleanupStaleAgentWorktreesSpy,
}))

const {
  cutoffDateFromDays,
  cleanupOldMiscConfigDirs,
  cleanupOldMessageFilesInBackground,
} = await import('../cleanup.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')

afterAll(() => {
  mock.module('../settings/settings.js', () => ({ ...realSettingsExports }))
  mock.module('../settings/allErrors.js', () => ({ ...realAllErrorsExports }))
  mock.module('../cachePaths.js', () => ({ ...realCachePathsExports }))
  mock.module('../pasteStore.js', () => ({ ...realPasteStoreExports }))
  mock.module('../worktree.js', () => ({ ...realWorktreeExports }))
  if (savedConfigDirEnv === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDirEnv
  }
  if (savedUserType !== undefined) {
    process.env.USER_TYPE = savedUserType
  }
  // The temp CLAUDE_CONFIG_DIR was live while module-level caches primed —
  // drop them so later files recompute against the restored env (the temp dir
  // itself is deleted right after).
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  mockedCleanupPeriodDays = undefined
  cleanupOldPastesSpy.mockClear()
  cleanupStaleAgentWorktreesSpy.mockClear()
  rmSync(join(configDir, 'tasks'), { recursive: true, force: true })
})

/** Cleanup-sweep filenames encode their timestamp: `YYYY-MM-DDTHH-mm-ss-SSSZ`. */
function timestampFileName(date: Date, ext = '.jsonl'): string {
  return `${date.toISOString().replaceAll(':', '-').replaceAll('.', '-')}${ext}`
}

// --- 1. the guarded helper (official `_e`) ------------------------------------

describe('2.1.310 cutoffDateFromDays — NaN-guarded Date math (official `_e`)', () => {
  test('returns a valid Date ~N days in the past for ordinary day counts', () => {
    const before = Date.now()
    const cutoff = cutoffDateFromDays(30)
    const after = Date.now()
    expect(cutoff).toBeInstanceOf(Date)
    expect(cutoff!.getTime()).toBeGreaterThanOrEqual(before - 30 * MS_PER_DAY)
    expect(cutoff!.getTime()).toBeLessThanOrEqual(after - 30 * MS_PER_DAY)
  })

  test('0 days yields a Date ≈ now (the 0→null short-circuit lives in getCutoffDate, like official `kS`)', () => {
    const cutoff = cutoffDateFromDays(0)
    expect(cutoff).toBeInstanceOf(Date)
    expect(Math.abs(cutoff!.getTime() - Date.now())).toBeLessThan(60_000)
  })

  test('returns null for an absurd day count (1e12) whose ms product overflows the Date range', () => {
    // 1e12 * 8.64e7 = 8.64e19 ms — far beyond ±8.64e15 → Invalid Date → null.
    expect(cutoffDateFromDays(1e12)).toBeNull()
  })

  test('returns null for 1e300 days (the triage failure mode: ms product is Infinity)', () => {
    expect(cutoffDateFromDays(1e300)).toBeNull()
  })

  test('returns null for 1e9 days (just past the ±8.64e15 ms Date range)', () => {
    // 1e9 * 8.64e7 = 8.64e16 ms > 8.64e15 max → Invalid Date.
    expect(cutoffDateFromDays(1e9)).toBeNull()
  })

  test('returns a valid Date for 1e8 days (still inside the Date range)', () => {
    // 1e8 * 8.64e7 = 8.64e15 ms = exactly the Date range edge; Date.now() > 0
    // keeps Date.now() - 8.64e15 inside [-8.64e15, 8.64e15].
    expect(cutoffDateFromDays(1e8)).toBeInstanceOf(Date)
  })

  test('returns null for a NaN day count', () => {
    expect(cutoffDateFromDays(Number.NaN)).toBeNull()
  })
})

// --- 2. null cutoff → cleanup functions skip (official `if(r===null)return E();`)

describe('2.1.310 null cutoff → cleanup functions skip their sweep', () => {
  test('cleanupOldMiscConfigDirs deletes nothing and returns zeroed result when cleanupPeriodDays is absurd', async () => {
    mockedCleanupPeriodDays = 1e12
    const tasksDir = join(configDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const oldFile = join(tasksDir, timestampFileName(new Date(Date.UTC(2020, 0, 1))))
    writeFileSync(oldFile, 'old')

    const result = await cleanupOldMiscConfigDirs()

    expect(result).toEqual({ messages: 0, errors: 0 })
    // Skip semantics: the ancient file is untouched (no sweep ran).
    expect(existsSync(oldFile)).toBe(true)
  })

  test('cleanupOldMiscConfigDirs deletes old files and keeps new ones with a valid cleanupPeriodDays', async () => {
    mockedCleanupPeriodDays = 1
    const tasksDir = join(configDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const oldFile = join(tasksDir, timestampFileName(new Date(Date.UTC(2020, 0, 1))))
    const newFile = join(tasksDir, timestampFileName(new Date()))
    writeFileSync(oldFile, 'old')
    writeFileSync(newFile, 'new')

    const result = await cleanupOldMiscConfigDirs()

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(newFile)).toBe(true)
    // Non-message paths count removals in `errors` (existing OCC semantics).
    expect(result).toEqual({ messages: 0, errors: 1 })
  })
})

// --- 3. orchestrator: pastes + worktree sweep behind one null check -----------

describe('2.1.310 background orchestrator — pastes/worktrees skipped on null cutoff (official `if(O!==null){...}`)', () => {
  test('cleanupOldMessageFilesInBackground never invokes paste/worktree cleanup when cleanupPeriodDays is absurd', async () => {
    mockedCleanupPeriodDays = 1e12

    await cleanupOldMessageFilesInBackground()

    expect(cleanupOldPastesSpy).not.toHaveBeenCalled()
    expect(cleanupStaleAgentWorktreesSpy).not.toHaveBeenCalled()
  })

  test('cleanupOldMessageFilesInBackground passes a valid Date to paste and worktree cleanup with the default period', async () => {
    mockedCleanupPeriodDays = undefined // → DEFAULT_CLEANUP_PERIOD_DAYS (30)

    await cleanupOldMessageFilesInBackground()

    expect(cleanupOldPastesSpy).toHaveBeenCalledTimes(1)
    expect(cleanupStaleAgentWorktreesSpy).toHaveBeenCalledTimes(1)
    const pasteCutoff = cleanupOldPastesSpy.mock.calls[0]![0] as Date
    const worktreeCutoff = cleanupStaleAgentWorktreesSpy.mock.calls[0]![0] as Date
    expect(pasteCutoff).toBeInstanceOf(Date)
    expect(Number.isNaN(pasteCutoff.getTime())).toBe(false)
    expect(worktreeCutoff).toBeInstanceOf(Date)
    expect(Number.isNaN(worktreeCutoff.getTime())).toBe(false)
  })
})
