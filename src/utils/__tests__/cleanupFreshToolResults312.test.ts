/**
 * Official Claude Code 2.1.312 changelog item 8 — "Fixed an issue where Read
 * of PDFs could fail with 'Could not write image' when the background
 * session-dir cleanup swept the freshly-created (still empty) tool-results
 * render directory between mkdir and pdftoppm's first write."
 *
 * Source of truth: BIN312 session-dir cleanup @259860697 (byte-verified via
 * read-only forensics on /tmp/cc-diff-312/v312/package/claude; the binary was
 * never executed). BIN311 rmdir'd the tool subdir (`ee`) and the tool-results
 * dir (`L`) UNCONDITIONALLY; BIN312 adds the two guards (verbatim):
 *
 *   if(ne.length>0||await Q(q,n).catch(()=>1/0)<e.getTime())await T(q,n)   // tool subdir
 *   if(I.length>0||await Q(j,n).catch(()=>1/0)<e.getTime())await T(j,n)    // tool-results dir
 *
 * — rmdir only when leftover entries exist (`ne`/`I` are the readdir results
 * captured BEFORE the deletion pass) OR the dir's mtime predates the cutoff;
 * a fresh empty dir survives the sweep. Helpers (byte-verified):
 *   T @259853708: `async function T(e,r){if(!await U(e,r))return;try{await r.rmdir(e)}catch{}}`
 *                 (exists-then-rmdir, empty-only, errors swallowed) ≡ OCC tryRmdir
 *   Q @259855632: `async function Q(e,r){return(await r.lstat(e)).mtimeMs}`
 *                 ≡ OCC getMtimeMs
 *
 * Race surface in OCC: src/utils/pdf.ts:246 — `mkdir(join(getToolResultsDir(),
 * `pdf-${uuid}`))` then pdftoppm renders into it; between the mkdir and the
 * first render write the dir is empty and fresh, exactly what the guard spares.
 *
 * Unpinnable (documented, kept as-is): whether the official ALSO guards the
 * outer session-dir / project-dir rmdir — only the two inner guards are
 * pinned, so OCC's tryRmdir(sessionDir) / tryRmdir(projectDir) stay
 * unconditional (tryRmdir is empty-only, so they remain safe).
 *
 * Harness: REAL temp-dir filesystem through the setFsImplementation seam
 * (same pattern as writePathDescriptor280.test.ts) with an rmdir spy + a
 * per-path lstat failure override; settings seam mocked like
 * cleanupCutoffNaN310.test.ts (eager spread copies BEFORE any mock.module —
 * OCC-97/132 — re-pinned in afterAll).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type * as nodeFs from 'fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const CLEANUP_PERIOD_DAYS = 30

// --- temp config dir (getClaudeConfigHomeDir memoizes off CLAUDE_CONFIG_DIR) --
const configDir = mkdtempSync(join(tmpdir(), 'occ-cleanup-fresh-312-'))
const savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

// --- settings seam (cutoff = now - 30 days) -----------------------------------
const realSettingsModule = await import('../settings/settings.js')
const realSettingsExports = { ...realSettingsModule }
mock.module('../settings/settings.js', () => ({
  ...realSettingsExports,
  getSettings_DEPRECATED: () => ({ cleanupPeriodDays: CLEANUP_PERIOD_DAYS }),
  rawSettingsContainsKey: () => false,
}))

// --- fs seam: real fs + rmdir spy + lstat failure override ---------------------
const {
  NodeFsOperations,
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} = await import('../fsOperations.js')
const { TOOL_RESULTS_SUBDIR } = await import('../toolResultStorage.js')
const { cleanupOldSessionFiles } = await import('../cleanup.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')

const realImpl = getFsImplementation()
const rmdirCalls: string[] = []
let failLstatFor = new Set<string>()

const spyFs: typeof NodeFsOperations = {
  ...realImpl,
  rmdir: async (path: string) => {
    rmdirCalls.push(path)
    return realImpl.rmdir(path)
  },
  lstat: async (path: string): Promise<nodeFs.Stats> => {
    if (failLstatFor.has(path)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
        code: 'ENOENT',
      })
    }
    return realImpl.lstat(path)
  },
}

afterAll(() => {
  setOriginalFsImplementation()
  mock.module('../settings/settings.js', () => ({ ...realSettingsExports }))
  if (savedConfigDirEnv === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDirEnv
  }
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

let projectsRoot: string

beforeEach(() => {
  setFsImplementation(spyFs)
  rmdirCalls.length = 0
  failLstatFor = new Set()
  projectsRoot = join(configDir, 'projects')
  rmSync(projectsRoot, { recursive: true, force: true })
})

afterEach(() => {
  setOriginalFsImplementation()
})

/** Build projects/<proj>/<session>/tool-results/<toolDirName> and return its path. */
function makeToolDir(toolDirName: string): string {
  const toolDirPath = join(
    projectsRoot,
    'proj-a',
    'session-a',
    TOOL_RESULTS_SUBDIR,
    toolDirName,
  )
  mkdirSync(toolDirPath, { recursive: true })
  return toolDirPath
}

function setMtimeDaysAgo(path: string, days: number): void {
  const when = (Date.now() - days * MS_PER_DAY) / 1000
  utimesSync(path, when, when)
}

describe('2.1.312 #8 — cleanupOldSessionFiles spares FRESH empty tool dirs (official rmdir guards @259860697)', () => {
  test("(a) a fresh empty tool subdir (mtime = now, the pdf-<uuid> race) is NEVER rmdir'd", async () => {
    const freshDir = makeToolDir('pdf-race-uuid')
    // Age the PARENT tool-results dir so the subdir guard's decision is
    // isolated to the mtime clause: snapshot `I` = [pdf-race-uuid] (1 entry),
    // subdir snapshot `ne` = [] (empty) + fresh mtime → both clauses false.
    const toolResultsDir = join(
      projectsRoot,
      'proj-a',
      'session-a',
      TOOL_RESULTS_SUBDIR,
    )
    setMtimeDaysAgo(toolResultsDir, CLEANUP_PERIOD_DAYS + 10)

    await cleanupOldSessionFiles()

    // Official guard: `ne.length>0||await Q(q,n).catch(()=>1/0)<e.getTime()` —
    // no leftover entries AND mtime(now) >= cutoff → no T(q,n) call at all.
    expect(rmdirCalls).not.toContain(freshDir)
    expect(existsSync(freshDir)).toBe(true)
  })

  test("(a2) a fresh EMPTY tool-results dir (the exact 312 race window: mkdir'd, render not yet written) is spared — outer session rmdir then fails empty-only", async () => {
    // projects/proj-b/session-b/tool-results — created fresh, no children yet.
    const toolResultsDir = join(
      projectsRoot,
      'proj-b',
      'session-b',
      TOOL_RESULTS_SUBDIR,
    )
    mkdirSync(toolResultsDir, { recursive: true })

    await cleanupOldSessionFiles()

    // Official guard: `I.length>0||await Q(j,n).catch(()=>1/0)<e.getTime()` —
    // snapshot empty + mtime fresh → no T(j,n). And because tool-results
    // survives, the (unconditional, unpinned) session-dir tryRmdir fails
    // empty-only and the session dir survives too.
    expect(rmdirCalls).not.toContain(toolResultsDir)
    expect(existsSync(toolResultsDir)).toBe(true)
    expect(existsSync(join(projectsRoot, 'proj-b', 'session-b'))).toBe(true)
  })

  test("(b) an OLD empty tool subdir (mtime < cutoff) IS rmdir'd", async () => {
    const oldDir = makeToolDir('pdf-old')
    setMtimeDaysAgo(oldDir, CLEANUP_PERIOD_DAYS + 10)

    await cleanupOldSessionFiles()

    expect(rmdirCalls).toContain(oldDir)
  })

  test("(c) a dir with leftover entries after the deletion pass IS rmdir'd even with a fresh mtime (guard first clause `ne.length>0`)", async () => {
    const leftoverDir = makeToolDir('pdf-leftover')
    // Fresh file (mtime = now) survives unlinkIfOld → leftover entry.
    writeFileSync(join(leftoverDir, 'fresh-page.png'), 'rendered')

    await cleanupOldSessionFiles()

    expect(rmdirCalls).toContain(leftoverDir)
  })

  test("(c2) a dir whose only file was deleted IS still rmdir'd — the guard's entry list is the PRE-deletion readdir snapshot (official `ne`, never re-read)", async () => {
    const sweptDir = makeToolDir('pdf-swept')
    const staleFile = join(sweptDir, '2020-01-01T00-00-00-000Z.jsonl')
    writeFileSync(staleFile, 'old render')
    setMtimeDaysAgo(staleFile, CLEANUP_PERIOD_DAYS + 10)
    // Directory mtime stays fresh (now), but the snapshot `ne` has 1 entry →
    // `ne.length>0` → rmdir runs (and now succeeds: the file was swept).
    const result = await cleanupOldSessionFiles()

    expect(result.messages).toBeGreaterThanOrEqual(1) // the stale file was swept
    expect(rmdirCalls).toContain(sweptDir)
    expect(existsSync(sweptDir)).toBe(false)
  })

  test('(d) lstat throwing keeps the dir — `.catch(()=>1/0)` semantics (Infinity < cutoff is false)', async () => {
    const freshDir = makeToolDir('pdf-lstat-fail')
    failLstatFor.add(freshDir)
    failLstatFor.add(
      join(projectsRoot, 'proj-a', 'session-a', TOOL_RESULTS_SUBDIR),
    )

    await cleanupOldSessionFiles()

    expect(rmdirCalls).not.toContain(freshDir)
  })
})
