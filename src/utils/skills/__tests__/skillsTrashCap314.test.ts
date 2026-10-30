/**
 * Official Claude Code 2.1.314 changelog item 66 — "Fixed `~/.claude/skills/
 * .trash` and `~/.claude/plugins/.trash` growing without limit: each now holds
 * about 1024 entries, whatever `cleanupPeriodDays` says."
 *
 * Source of truth: BIN314 (byte-verified via read-only forensics; the binary
 * was never executed). All three markers are ABSENT from BIN312:
 *
 * Constants @253720840:
 *   var FDt=3,jmo=1024,RBe=604800000,Wmo=5,Gmo=100,zmo="tengu_linked_cocoa",
 *       qmo=/^(\d+)-\d+-(?:([0-9a-f]{32})-)?[^-]+$/,Kmo=new W(()=>new Map);
 *
 * Trim entry `L$r` @253721134 (queues per-root runs; `n===void 0` from the
 * cleanup sweep sets `countsUntagged=!0`, `justMoved` stays empty).
 *
 * Core algorithm `Ymo` (added.txt @35674200): groups batch dirs by hash tag
 * (`qmo[2]`) or full name when countsUntagged, keeps FDt=3 generations per
 * group (newest first, keep-candidates must be non-empty directories when the
 * group exceeds 3), deletes deeper generations immediately UNLESS inside the
 * RBe=604800000ms (7-day) window (`CW(e,r,n=Date.now()){return
 * Number.isFinite(e)&&Math.abs(n-e)<r}` @27108592), protects the OLDEST
 * in-window deferred entry (`ke.findLast((Te)=>CW(Te.movedAtMs,RBe))`), then
 * evicts oldest-first (`[...w.toSorted(xBe).toReversed(),...G.toSorted(xBe)
 * .toReversed()]`) down to jmo=1024 with
 * `let L=Math.max(0,S.length+w.length-jmo)`. Sort `xbe(e,n){return
 * Number(n.justMoved)-Number(e.justMoved)||n.movedAtMs-e.movedAtMs}`.
 * Analytics: `g("sync_trash_trim",{removed_count:s.removed,total:
 * y-s.removed})`.
 *
 * Sweep placement — official orchestrator (wpc-100920 @17420) runs
 * `w.push(await De(e))` AFTER and OUTSIDE the cutoff-null guard
 * (`let P=...,O=hw();if(O!==null){...}w.push(await De(e))`), i.e. the cap
 * applies "whatever cleanupPeriodDays says". `De` iterates `[gYe,aFe]`
 * (skills/.trash + plugins/.trash); OCC dropped plugins/marketplace (OCC-31)
 * so only skills/.trash is swept here.
 *
 * Documented OCC-scope omissions (surfaces absent from OCC, see report):
 * - `justMoved` set (no sync mover in OCC → always empty)
 * - `$Dt` in-use probe + second pass (sync claim subsystem removed with the
 *   sync engine; `SS` inner semantics UNVERIFIED across chunks → not ported)
 * - `F0` retry wrapper (Wmo=5/Gmo=100 on ENOTEMPTY|yq(h); yq unresolved)
 * - `Rz` storageV5 root verification (no storageV5 in OCC)
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realAnalytics from '../../../services/analytics/index.js'
import * as realGrowthbook from '../../../services/analytics/growthbook.js'

// ---------------------------------------------------------------------------
// Mock seams (re-pinned in afterAll, per cleanupCutoffNaN310.test.ts pattern)
// ---------------------------------------------------------------------------

type LoggedEvent = { name: string; metadata: Record<string, unknown> }
const loggedEvents: LoggedEvent[] = []

/** null → gate returns its default (official `v(zmo,!0)` default true). */
let gateOverride: boolean | null = null

mock.module('../../../services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    loggedEvents.push({ name, metadata })
  },
}))

mock.module('../../../services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (
    _feature: string,
    defaultValue: unknown,
  ) => (gateOverride === null ? defaultValue : gateOverride),
}))

const { trimSyncTrashRoot } = await import('../syncTrashTrim.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const HASH32 = 'a'.repeat(32)

const tmpRoots: string[] = []

async function makeTrashRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'occ-trash-cap-314-'))
  tmpRoots.push(root)
  return root
}

/** Official batch dir name: `<movedAtMs>-<pid>[-<hash32>]-<name>` (qmo). */
function batchName(movedAtMs: number, name: string, tagged = false): string {
  return `${movedAtMs}-${tagged ? `777-${HASH32}-` : '4242-'}${name}`
}

/** Untagged batch dir → its own one-entry group (countsUntagged mode). */
async function makeBatchDir(
  root: string,
  movedAtMs: number,
  name: string,
): Promise<string> {
  const dir = join(root, batchName(movedAtMs, name))
  await mkdir(dir, { recursive: true })
  return dir
}

/** Tagged batch dir sharing one hash group; non-empty unless `empty`. */
async function makeTaggedBatchDir(
  root: string,
  movedAtMs: number,
  name: string,
  empty = false,
): Promise<string> {
  const dir = join(root, batchName(movedAtMs, name, true))
  await mkdir(dir, { recursive: true })
  if (!empty) {
    await writeFile(join(dir, 'SKILL.md'), '---\nname: x\n---\n')
  }
  return dir
}

beforeEach(() => {
  loggedEvents.length = 0
  gateOverride = null
})

afterAll(async () => {
  mock.module('../../../services/analytics/index.js', () => realAnalytics)
  mock.module(
    '../../../services/analytics/growthbook.js',
    () => realGrowthbook,
  )
  await Promise.all(
    tmpRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

// ---------------------------------------------------------------------------
// Tests — official Ymo behavior only
// ---------------------------------------------------------------------------

describe('2.1.314 #66 skills/.trash ~1024-entry cap', () => {
  test('caps at 1024 entries, evicting oldest-first, whatever the entry age', async () => {
    const root = await makeTrashRoot()
    const now = Date.now()
    const TOTAL = 1040
    // Every entry is far older than any cleanupPeriodDays cutoff would care
    // about differently — age does NOT drive eviction here; the cap does.
    // All are also outside the 7-day window so none is window-protected.
    for (let i = 0; i < TOTAL; i++) {
      await makeBatchDir(root, now - (TOTAL - i + 30) * DAY_MS, `skill${i}`)
    }

    const result = await trimSyncTrashRoot(root, now)

    expect(result.errors).toBe(0)
    expect(result.removed).toBe(TOTAL - 1024) // jmo=1024
    const remaining = await readdir(root)
    expect(remaining.length).toBe(1024)
    // Oldest-first eviction: skill0..skill15 gone, newest 1024 kept.
    expect(remaining.some(n => n.endsWith('-skill0'))).toBe(false)
    expect(remaining.some(n => n.endsWith('-skill15'))).toBe(false)
    expect(remaining.some(n => n.endsWith('-skill16'))).toBe(true)
    expect(remaining.some(n => n.endsWith('-skill1039'))).toBe(true)
    // Official: g("sync_trash_trim",{removed_count:s.removed,total:y-s.removed})
    expect(loggedEvents).toContainEqual({
      name: 'sync_trash_trim',
      metadata: { removed_count: 16, total: TOTAL - 16 },
    })
  })

  test('keeps the newest 3 generations per tag group, deletes older ones outside the 7-day window', async () => {
    const root = await makeTrashRoot()
    const now = Date.now()
    // 5 generations of one tagged name, all outside the window, non-empty.
    const dirs: string[] = []
    for (let gen = 0; gen < 5; gen++) {
      dirs.push(
        await makeTaggedBatchDir(root, now - (gen + 10) * DAY_MS, 'myskill'),
      )
    }

    const result = await trimSyncTrashRoot(root, now)

    expect(result.removed).toBe(2) // FDt=3 kept, 2 oldest deleted
    const remaining = await readdir(root)
    expect(remaining.length).toBe(3)
    // newest-first kept (dirs[0] is newest: movedAt = now-10d)
    expect(remaining).toContain(dirs[0]!.split('/').pop())
    expect(remaining).toContain(dirs[1]!.split('/').pop())
    expect(remaining).toContain(dirs[2]!.split('/').pop())
    expect(remaining).not.toContain(dirs[3]!.split('/').pop())
    expect(remaining).not.toContain(dirs[4]!.split('/').pop())
  })

  test('protects a past-3rd-generation entry inside the 7-day window and deletes one outside it', async () => {
    // In-window 4th generation survives (deferred via CW), out-of-window
    // 4th/5th generations are removed immediately (RBe=604800000).
    const rootA = await makeTrashRoot()
    const rootB = await makeTrashRoot()
    const now = Date.now()
    for (const [root, gen4AgeDays, expectedRemoved] of [
      [rootA, 4, 1] as const, // gen4 inside window → only gen5 removed
      [rootB, 40, 2] as const, // gen4 outside window → gen4+gen5 removed
    ]) {
      for (let gen = 0; gen < 3; gen++) {
        await makeTaggedBatchDir(root, now - (gen + 1) * DAY_MS, 'wskill')
      }
      await makeTaggedBatchDir(
        root,
        now - gen4AgeDays * DAY_MS,
        'wskill',
      )
      await makeTaggedBatchDir(root, now - 50 * DAY_MS, 'wskill')

      const result = await trimSyncTrashRoot(root, now)
      expect(result.removed).toBe(expectedRemoved)
      const remaining = await readdir(root)
      expect(remaining.length).toBe(5 - expectedRemoved)
    }
  })

  test('skips empty directories as keep-candidates when the group exceeds 3 generations', async () => {
    const root = await makeTrashRoot()
    const now = Date.now()
    // e1 non-empty (kept #1), e2 EMPTY (validation `continue` — does not count
    // as a kept generation), e3/e4 non-empty (kept #2/#3) → nothing reaches the
    // Se>=FDt delete branch.
    const e2 = await makeTaggedBatchDir(root, now - 20 * DAY_MS, 'esk', true)
    await makeTaggedBatchDir(root, now - 10 * DAY_MS, 'esk')
    await makeTaggedBatchDir(root, now - 30 * DAY_MS, 'esk')
    await makeTaggedBatchDir(root, now - 40 * DAY_MS, 'esk')

    const result = await trimSyncTrashRoot(root, now)

    expect(result.removed).toBe(0)
    const remaining = await readdir(root)
    expect(remaining.length).toBe(4)
    expect(remaining).toContain(e2.split('/').pop())
  })

  test('leaves non-batch-name entries and regular files untouched and uncounted', async () => {
    const root = await makeTrashRoot()
    const now = Date.now()
    await mkdir(join(root, 'random-dir'))
    await mkdir(join(root, '12345')) // missing second numeric group
    await mkdir(join(root, `${now - 40 * DAY_MS}-42-${'Z'.repeat(32)}-bad`)) // non-hex tag + dashed tail
    const regularFile = join(root, batchName(now - 40 * DAY_MS, 'fileskill'))
    await writeFile(regularFile, 'x') // matches qmo but isFile → skipped

    const result = await trimSyncTrashRoot(root, now)

    expect(result.removed).toBe(0)
    expect(result.errors).toBe(0)
    const remaining = await readdir(root)
    expect(remaining.length).toBe(4)
    expect(remaining).toContain(regularFile.split('/').pop())
    // No removals → no analytics event (official logs only when removed > 0).
    expect(
      loggedEvents.filter(e => e.name === 'sync_trash_trim'),
    ).toHaveLength(0)
  })

  test('no-ops when the tengu_linked_cocoa gate is off (official `if(!v(zmo,!0))return s`)', async () => {
    const root = await makeTrashRoot()
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await makeBatchDir(root, now - (i + 30) * DAY_MS, `gskill${i}`)
    }
    gateOverride = false

    const result = await trimSyncTrashRoot(root, now)

    expect(result).toEqual({ removed: 0, errors: 0 })
    expect(await readdir(root)).toHaveLength(5)
  })

  test('returns an empty result for a missing trash root', async () => {
    const root = await makeTrashRoot()
    const result = await trimSyncTrashRoot(join(root, 'does-not-exist'))
    expect(result).toEqual({ removed: 0, errors: 0 })
  })
})
