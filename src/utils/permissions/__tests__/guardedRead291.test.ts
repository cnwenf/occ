import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext } from '../../../Tool.js'
import { getFsImplementation, getPathsForPermissionCheck } from '../../fsOperations.js'
import { _clearMatcherCacheForTesting } from '../../permissions/filesystem.js'
import { _clearPhysicalTwinsForTesting } from '../../permissions/symlinkEquivalences.js'
import {
  assertSymlinkResolutionsUnchangedForRead,
  SymlinkReadRefusedError,
  stashCheckTimeResolutions,
} from '../../permissions/symlinkResolutionStash.js'

// Some permission probes read MACRO.VERSION; mirror the cli.tsx polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.290 changelog (security) — cluster B1 (paste/drag half) + B2:
 *   "Fixed Read deny rules not applying to image paths pasted or dragged into
 *    the prompt"
 *   "Fixed an image read on macOS and Windows being able to return a file
 *    outside what was approved, through a link swapped in mid-read"
 *
 * Official v290 mechanism (byte-verified; see
 * docs/gap-research-291/cluster-b-read-deny-mentions.md §B1/§B2):
 *   - `sgs` @210758040 — the guarded paste read. `Ykt` decides
 *     `"refused"` / `"unexamined"` / the landing spelling set; `"refused"`
 *     short-circuits with the warn `Pasted path is not read: the read is
 *     refused`, `"unexamined"` falls back to the raw `readFileBytes(Gne(e))`,
 *     anything else goes through the verified landing read `Vkt`.
 *   - `Ykt` — deny-check over EVERY spelling, twice (before and after the
 *     resolution, because the context getter is re-invoked), with an
 *     `"unexamined"` perf bypass when no context blocks reads.
 *   - `Vkt`/`MMe` — verified read "where it lands": the official opens the
 *     path and re-checks the stat identity against the check-time spellings.
 *     OCC's port reuses the 2.1.251 stash gate instead (documented deviation):
 *     stash the landing spellings under a synthetic `attached-read-<uuid>`
 *     toolUseId (official `LMe`) and run
 *     `assertSymlinkResolutionsUnchangedForRead` before the IO, so a swapped
 *     link raises `SymlinkReadRefusedError` → `"refused"`.
 *   - failure sentinels: `"absent"` (path genuinely missing, resolutions
 *     unchanged — official `Nkt`) vs `"refused"`; warn text
 *     `Pasted path is not read where it lands: ${outcome}`.
 */

const SECRET_CONTENT = 'TOP-SECRET-KEY'

function makePermissionContext(
  opts: { deny?: string[] } = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

const {
  dotdotNormalizedReadPath,
  nextAttachedReadToolUseId,
  readGuardedAtLanding,
  readPastedFileGuarded,
  resolveGuardedRead,
} = await import('../guardedRead.js')

let farm: string
let farmReal: string
let secretDir: string
let openDir: string

const spies: Mock[] = []

function spyOnFs<
  K extends 'lstatSync' | 'realpathSync' | 'readlinkSync' | 'readFileBytes',
>(method: K): Mock {
  const spy = spyOn(getFsImplementation(), method) as unknown as Mock
  spies.push(spy)
  return spy
}

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-guardedread291-'))
  farmReal = realpathSync(farm)
  secretDir = join(farmReal, 'secret')
  openDir = join(farmReal, 'open')
  mkdirSync(secretDir, { recursive: true })
  mkdirSync(openDir, { recursive: true })
  writeFileSync(join(secretDir, 'a.png'), SECRET_CONTENT)
  writeFileSync(join(openDir, 'b.png'), 'PUBLIC-IMAGE')
})

afterAll(() => {
  rmSync(farm, { recursive: true, force: true })
})

beforeEach(() => {
  _clearMatcherCacheForTesting()
  _clearPhysicalTwinsForTesting()
})

afterEach(() => {
  while (spies.length > 0) {
    spies.pop()?.mockRestore()
  }
})

/** Fresh symlink `openDir/<name>` → target, returned as the link path. */
function makeLink(name: string, target: string): string {
  const linkPath = join(openDir, name)
  rmSync(linkPath, { force: true })
  symlinkSync(target, linkPath)
  return linkPath
}

const denySecret = () =>
  makePermissionContext({ deny: [`Read(/${secretDir}/**)`] })
const openContexts = () => [makePermissionContext()]

describe('CC 2.1.290 B1 — Ykt/resolveGuardedRead deny decisions', () => {
  test('no permission context at all → refused (fail-closed)', async () => {
    const outcome = await resolveGuardedRead(join(openDir, 'b.png'), () => [])

    expect(outcome).toBe('refused')
  })

  test('deny rule on the typed surface path → refused', async () => {
    const target = join(openDir, 'b.png')

    const outcome = await resolveGuardedRead(
      target,
      () => [makePermissionContext({ deny: [`Read(/${target})`] })],
    )

    expect(outcome).toBe('refused')
  })

  test('symlink whose LANDING is denied → refused', async () => {
    const linkPath = makeLink('paste.png', join(secretDir, 'a.png'))

    const outcome = await resolveGuardedRead(linkPath, () => [denySecret()])

    expect(outcome).toBe('refused')
  })

  test('persisted-only second context denies → refused (official igs arm)', async () => {
    const linkPath = makeLink('paste2.png', join(secretDir, 'a.png'))

    const outcome = await resolveGuardedRead(linkPath, () => [
      makePermissionContext(),
      denySecret(),
    ])

    expect(outcome).toBe('refused')
  })

  test('context that gains the deny rule while resolving → refused (post-check arm)', async () => {
    const linkPath = makeLink('paste3.png', join(secretDir, 'a.png'))
    let calls = 0

    const outcome = await resolveGuardedRead(linkPath, () => {
      calls += 1
      // First read (pre-resolution): open. Second read (post-resolution): denied.
      return calls === 1 ? [makePermissionContext()] : [denySecret()]
    })

    expect(calls).toBe(2)
    expect(outcome).toBe('refused')
  })

  test('no deny rules anywhere → "unexamined" (official he arm, decided post-resolution)', async () => {
    // Official walks the spellings even when nothing blocks reads — `he` is
    // only computed AFTER the resolution (`he=q.some(sy)?W:"unexamined"`), so
    // the raw-read fast path is chosen late, not by skipping the walk.
    makeLink('fast.png', join(openDir, 'b.png'))

    const outcome = await resolveGuardedRead(
      join(openDir, 'b.png'),
      openContexts,
    )

    expect(outcome).toBe('unexamined')
  })

  test('reads blocked only on the second consult → landing spellings, not the raw path', async () => {
    // The `he` arm (`q.some(sy)?W:"unexamined"`) reads the SECOND consult, so
    // a context that starts open and ends blocking still yields the examined
    // spelling set — the caller must verify the landing read instead of taking
    // the raw fast path. Official's `MD` early bypass is not ported (deviation
    // 2 in guardedRead.ts), so nothing short-circuits before this.
    const linkPath = makeLink('late-block.png', join(openDir, 'b.png'))
    let calls = 0

    const outcome = await resolveGuardedRead(linkPath, () => {
      calls += 1
      return calls === 1 ? [makePermissionContext()] : [denySecret()]
    })

    expect(calls).toBe(2)
    expect(Array.isArray(outcome)).toBe(true)
    if (Array.isArray(outcome)) {
      expect(outcome).toContain(join(openDir, 'b.png'))
    }
  })

  test('blocking on the first consult but not the second → "unexamined" (he reads q)', async () => {
    const linkPath = makeLink('early-block.png', join(openDir, 'b.png'))
    let calls = 0

    const outcome = await resolveGuardedRead(linkPath, () => {
      calls += 1
      return calls === 1 ? [denySecret()] : [makePermissionContext()]
    })

    expect(calls).toBe(2)
    expect(outcome).toBe('unexamined')
  })

  test('deny rules present but nothing matches → landing spellings returned', async () => {
    const linkPath = makeLink('allowed.png', join(openDir, 'b.png'))

    const outcome = await resolveGuardedRead(linkPath, () => [denySecret()])

    expect(Array.isArray(outcome)).toBe(true)
    if (Array.isArray(outcome)) {
      expect(outcome).toContain(linkPath)
      expect(outcome).toContain(join(openDir, 'b.png'))
      expect(outcome).toEqual(getPathsForPermissionCheck(linkPath))
    }
  })
})

describe('CC 2.1.290 B1 — sgs/readPastedFileGuarded', () => {
  test('denied path → "refused" sentinel and no bytes ever read', async () => {
    const readSpy = spyOnFs('readFileBytes')
    const secretPath = join(secretDir, 'a.png')

    const outcome = await readPastedFileGuarded(secretPath, () => [
      denySecret(),
    ])

    expect(outcome).toBe('refused')
    expect(readSpy).toHaveBeenCalledTimes(0)
  })

  test('denied symlink landing → "refused" and no bytes ever read', async () => {
    const readSpy = spyOnFs('readFileBytes')
    const linkPath = makeLink('denied-read.png', join(secretDir, 'a.png'))

    const outcome = await readPastedFileGuarded(linkPath, () => [denySecret()])

    expect(outcome).toBe('refused')
    expect(readSpy).toHaveBeenCalledTimes(0)
  })

  test('no deny rules → raw fast path reads the typed path', async () => {
    const target = join(openDir, 'b.png')
    const readSpy = spyOnFs('readFileBytes')

    const outcome = await readPastedFileGuarded(target, openContexts)

    expect(Buffer.isBuffer(outcome)).toBe(true)
    if (Buffer.isBuffer(outcome)) {
      expect(outcome.toString('utf8')).toBe('PUBLIC-IMAGE')
    }
    expect(readSpy).toHaveBeenCalledWith(target)
  })

  test('deny rules present, path allowed → bytes come from the RESOLVED landing', async () => {
    const linkPath = makeLink('landing-read.png', join(openDir, 'b.png'))
    const readSpy = spyOnFs('readFileBytes')

    const outcome = await readPastedFileGuarded(linkPath, () => [denySecret()])

    expect(Buffer.isBuffer(outcome)).toBe(true)
    if (Buffer.isBuffer(outcome)) {
      expect(outcome.toString('utf8')).toBe('PUBLIC-IMAGE')
    }
    // The landing (canonical) spelling is what gets opened, not the link.
    expect(readSpy).toHaveBeenCalledWith(join(openDir, 'b.png'))
  })

  test('missing path under a deny rule → "absent" (official Nkt arm)', async () => {
    const missing = join(openDir, 'nope.png')

    const outcome = await readPastedFileGuarded(missing, () => [denySecret()])

    expect(outcome).toBe('absent')
  })

  test('a throwing resolver fails closed to "refused"', async () => {
    const readSpy = spyOnFs('readFileBytes')

    const outcome = await readPastedFileGuarded(join(openDir, 'b.png'), () => {
      throw new Error('context unavailable')
    })

    expect(outcome).toBe('refused')
    expect(readSpy).toHaveBeenCalledTimes(0)
  })

  test('".." segments are expanded before the raw read (official Gne)', async () => {
    expect(dotdotNormalizedReadPath(join(openDir, '..', 'open', 'b.png'))).toBe(
      join(farmReal, 'open', 'b.png'),
    )
    expect(dotdotNormalizedReadPath(join(openDir, 'b.png'))).toBe(
      join(openDir, 'b.png'),
    )
  })
})

describe('CC 2.1.290 B2 — mid-read symlink swap is refused', () => {
  test('swap between check-time spellings and read → "refused", no bytes', async () => {
    const linkPath = makeLink('toctou.png', join(openDir, 'b.png'))
    const spellings = getPathsForPermissionCheck(linkPath)
    // Attacker flips the link to the denied secret after the check.
    makeLink('toctou.png', join(secretDir, 'a.png'))
    const readSpy = spyOnFs('readFileBytes')

    const outcome = await readGuardedAtLanding(linkPath, spellings)

    expect(outcome).toBe('refused')
    expect(readSpy).toHaveBeenCalledTimes(0)
  })

  test('swap during the read (link flipped while resolutions are recomputed) → "refused"', async () => {
    const linkPath = makeLink('toctou-mid.png', join(openDir, 'b.png'))
    const spellings = getPathsForPermissionCheck(linkPath)
    let swapped = false
    const realLstat = getFsImplementation().lstatSync.bind(
      getFsImplementation(),
    )
    const lstatSpy = spyOnFs('lstatSync')
    lstatSpy.mockImplementation(((p: string) => {
      if (!swapped) {
        swapped = true
        makeLink('toctou-mid.png', join(secretDir, 'a.png'))
      }
      return realLstat(p)
    }) as never)
    const readSpy = spyOnFs('readFileBytes')

    const outcome = await readGuardedAtLanding(linkPath, spellings)

    expect(swapped).toBe(true)
    expect(outcome).toBe('refused')
    expect(readSpy).toHaveBeenCalledTimes(0)
  })

  test('swap and swap back before the read → succeeds (no false positive)', async () => {
    const linkPath = makeLink('toctou-back.png', join(openDir, 'b.png'))
    const spellings = getPathsForPermissionCheck(linkPath)
    makeLink('toctou-back.png', join(secretDir, 'a.png'))
    makeLink('toctou-back.png', join(openDir, 'b.png'))

    const outcome = await readGuardedAtLanding(linkPath, spellings)

    expect(Buffer.isBuffer(outcome)).toBe(true)
    if (Buffer.isBuffer(outcome)) {
      expect(outcome.toString('utf8')).toBe('PUBLIC-IMAGE')
    }
  })

  test('stable symlink → landing bytes', async () => {
    const linkPath = makeLink('stable.png', join(openDir, 'b.png'))
    const spellings = getPathsForPermissionCheck(linkPath)

    const outcome = await readGuardedAtLanding(linkPath, spellings)

    expect(Buffer.isBuffer(outcome)).toBe(true)
    if (Buffer.isBuffer(outcome)) {
      expect(outcome.toString('utf8')).toBe('PUBLIC-IMAGE')
    }
  })

  test('the stash gate itself raises SymlinkReadRefusedError for a swapped link', () => {
    const linkPath = makeLink('toctou-assert.png', join(openDir, 'b.png'))
    const spellings = getPathsForPermissionCheck(linkPath)
    const toolUseId = nextAttachedReadToolUseId()
    stashCheckTimeResolutions({ toolUseId }, linkPath, 'read', spellings)
    makeLink('toctou-assert.png', join(secretDir, 'a.png'))

    expect(() =>
      assertSymlinkResolutionsUnchangedForRead({ toolUseId }, linkPath),
    ).toThrow(SymlinkReadRefusedError)
  })

  test('attached-read toolUseIds are unique and prefixed (official LMe)', () => {
    const first = nextAttachedReadToolUseId()
    const second = nextAttachedReadToolUseId()

    expect(first).toMatch(/^attached-read-[0-9a-f-]{36}$/)
    expect(first).not.toBe(second)
  })

  test('guard reads the same bytes as a direct read of the landing', async () => {
    const linkPath = makeLink('parity.png', join(openDir, 'b.png'))
    const spellings = getPathsForPermissionCheck(linkPath)

    const outcome = await readGuardedAtLanding(linkPath, spellings)

    expect(Buffer.isBuffer(outcome)).toBe(true)
    if (Buffer.isBuffer(outcome)) {
      expect(outcome.equals(readFileSync(join(openDir, 'b.png')))).toBe(true)
    }
  })
})
