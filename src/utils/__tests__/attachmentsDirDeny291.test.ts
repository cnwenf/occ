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
import type { Dirent } from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getFsImplementation } from '../fsOperations.js'
import { _clearMatcherCacheForTesting } from '../permissions/filesystem.js'
import { _clearPhysicalTwinsForTesting } from '../permissions/symlinkEquivalences.js'

// Some permission/skill probes read MACRO.VERSION; mirror the cli.tsx polyfill
// (same as attachmentsSymlinkDenyLanding289.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.290 changelog (security) — cluster B1 (folder-listing half):
 *   "Fixed Read deny rules not applying to image paths pasted or dragged into
 *    the prompt, or to file names listed for an @-mentioned folder"
 *
 * Official v290 mechanism (byte-verified; see
 * docs/gap-research-291/cluster-b-read-deny-mentions.md §B1):
 *   - `d7n` @210756965 — the directory-listing filter. Scans at most
 *     `zkt = 1e4` entries, collects at most `Kkt = 1000`, yields to the event
 *     loop every `kkt = 50` entries while reads are blocked, honours
 *     `signal.aborted`, and returns
 *     ``[...collected, `… and ${entries.length - scanned} more entries`]``
 *     when it stopped before the end of the listing.
 *   - `Gkt` — per-entry judge: build every spelling of `<dir>/<name>`, deny on
 *     a surface match (`UB`/`isDenied`), otherwise resolve the landing for
 *     non-file/non-directory entries and deny when ANY spelling is denied
 *     (`Fne`) or, for non-files, when a spelling is a denied directory
 *     (`Akt`). Fail-closed: an `undefined` entry, or a thrown judge, denies.
 *
 * OCC port: `listMentionedDirectoryEntries` in src/utils/attachments.ts, built
 * on the shared `isFileReadDenied` predicate (surface + every symlink spelling
 * + canonical landing, with the `aje`/`hasReadDenyRules` no-syscall
 * short-circuit). Documented deviation: OCC's `matchingRuleForInput` has no
 * `{isDirectory:true}` option, so `Akt`'s directory-specific nuance is covered
 * by the same spelling-expanded predicate.
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

function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    options: {
      mcpClients: [],
      tools: [],
      mainLoopModel: 'claude-opus-5',
      agentDefinitions: { activeAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

/** Synthetic Dirent stand-in — the cap/abort tests must not need 10k files. */
function fakeEntry(name: string): Dirent {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  } as unknown as Dirent
}

function fakeEntries(count: number): Dirent[] {
  return Array.from({ length: count }, (_, i) =>
    fakeEntry(`f${String(i).padStart(5, '0')}.md`),
  )
}

const { getAttachments, listMentionedDirectoryEntries } = await import(
  '../attachments.js'
)

let farm: string
let farmReal: string
/** Directory that exists on disk but is never populated (synthetic entries). */
let scratchDir: string

const spies: Mock[] = []

function spyOnFs<K extends 'lstatSync' | 'realpathSync' | 'readlinkSync'>(
  method: K,
): Mock {
  const spy = spyOn(getFsImplementation(), method) as unknown as Mock
  spies.push(spy)
  return spy
}

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-dirlist291-'))
  farmReal = realpathSync(farm)
  scratchDir = join(farmReal, 'scratch')
  mkdirSync(scratchDir, { recursive: true })
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

/** Fresh per-test directory under the fixture farm. */
function makeDir(name: string): string {
  const dir = join(farmReal, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function realEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }) as Dirent[]
}

describe('CC 2.1.290 B1 — @-mentioned folder listing honours Read deny rules', () => {
  test('denied file name is filtered out, sibling is listed', async () => {
    const dir = makeDir('mixed')
    writeFileSync(join(dir, 'denied.md'), SECRET_CONTENT)
    writeFileSync(join(dir, 'ok.md'), 'PUBLIC')

    const names = await listMentionedDirectoryEntries(
      dir,
      realEntries(dir),
      makePermissionContext({ deny: [`Read(/${dir}/denied.md)`] }),
    )

    expect(names).toEqual(['ok.md'])
  })

  test('no deny rules → every entry listed, in readdir order', async () => {
    const dir = makeDir('no-deny')
    writeFileSync(join(dir, 'b.md'), 'B')
    writeFileSync(join(dir, 'a.md'), 'A')

    const entries = realEntries(dir)
    const names = await listMentionedDirectoryEntries(
      dir,
      entries,
      makePermissionContext(),
    )

    expect(names).toEqual(entries.map(e => e.name))
  })

  test('aje short-circuit: no deny rules → zero resolution syscalls', async () => {
    const dir = makeDir('fast-path')
    writeFileSync(join(dir, 'a.md'), 'A')
    writeFileSync(join(dir, 'b.md'), 'B')
    symlinkSync(join(dir, 'a.md'), join(dir, 'link.md'))
    const lstatSpy = spyOnFs('lstatSync')
    const realpathSpy = spyOnFs('realpathSync')
    const readlinkSpy = spyOnFs('readlinkSync')

    await listMentionedDirectoryEntries(
      dir,
      realEntries(dir),
      makePermissionContext(),
    )

    expect(lstatSpy).toHaveBeenCalledTimes(0)
    expect(realpathSpy).toHaveBeenCalledTimes(0)
    expect(readlinkSpy).toHaveBeenCalledTimes(0)
  })

  test('symlink entry whose LANDING is denied is filtered out', async () => {
    const dir = makeDir('landing')
    const secretDir = makeDir('landing-secret')
    writeFileSync(join(secretDir, 'x.md'), SECRET_CONTENT)
    symlinkSync(join(secretDir, 'x.md'), join(dir, 'link.md'))
    writeFileSync(join(dir, 'ok.md'), 'PUBLIC')

    const names = await listMentionedDirectoryEntries(
      dir,
      realEntries(dir),
      makePermissionContext({ deny: [`Read(/${secretDir}/**)`] }),
    )

    expect(names).toEqual(['ok.md'])
  })

  test('denied sub-directory entry is filtered out (Akt arm)', async () => {
    const dir = makeDir('subdir')
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'k.pem'), SECRET_CONTENT)
    mkdirSync(join(dir, 'public'), { recursive: true })

    const names = await listMentionedDirectoryEntries(
      dir,
      realEntries(dir),
      makePermissionContext({ deny: [`Read(/${dir}/secrets/**)`] }),
    )

    expect(names).toEqual(['public'])
  })

  test('undefined entry is never listed (fail-closed arm of Gkt)', async () => {
    const dir = makeDir('holes')
    writeFileSync(join(dir, 'ok.md'), 'PUBLIC')

    const names = await listMentionedDirectoryEntries(
      dir,
      [undefined, fakeEntry('ok.md'), undefined],
      makePermissionContext({ deny: [`Read(/${dir}/nope.md)`] }),
    )

    expect(names).toEqual(['ok.md'])
  })
})

describe('CC 2.1.290 B1 — d7n caps, overflow message and abort', () => {
  test('collect cap 1000 + "… and N more entries" (N = unscanned remainder)', async () => {
    const entries = fakeEntries(1500)

    const names = await listMentionedDirectoryEntries(
      scratchDir,
      entries,
      makePermissionContext(),
    )

    expect(names).toHaveLength(1001)
    expect(names[1000]).toBe('… and 500 more entries')
    expect(names.slice(0, 1000)).toEqual(
      entries.slice(0, 1000).map(e => e.name),
    )
  })

  test('exactly 1000 entries → no overflow message', async () => {
    const entries = fakeEntries(1000)

    const names = await listMentionedDirectoryEntries(
      scratchDir,
      entries,
      makePermissionContext(),
    )

    expect(names).toHaveLength(1000)
    expect(names.join('\n')).not.toContain('more entries')
  })

  test('scan cap 10000: denied entries are scanned but never collected', async () => {
    const entries = fakeEntries(10500)

    const names = await listMentionedDirectoryEntries(
      scratchDir,
      entries,
      // Everything under `scratchDir` is denied → the loop runs to the scan cap.
      makePermissionContext({ deny: [`Read(/${scratchDir}/**)`] }),
    )

    expect(names).toEqual(['… and 500 more entries'])
  })

  test('abort while reads are blocked stops the scan and reports the remainder', async () => {
    const entries = fakeEntries(200)

    const names = await listMentionedDirectoryEntries(
      scratchDir,
      entries,
      makePermissionContext({ deny: [`Read(/${scratchDir}/**)`] }),
      () => true,
    )

    expect(names).toEqual(['… and 200 more entries'])
  })

  test('abort is ignored when the context blocks nothing (official sy gate)', async () => {
    const entries = fakeEntries(200)

    const names = await listMentionedDirectoryEntries(
      scratchDir,
      entries,
      makePermissionContext(),
      () => true,
    )

    expect(names).toHaveLength(200)
  })

  test('empty listing → empty result, no overflow message', async () => {
    const dir = makeDir('empty')

    const names = await listMentionedDirectoryEntries(
      dir,
      realEntries(dir),
      makePermissionContext({ deny: [`Read(/${dir}/**)`] }),
    )

    expect(names).toEqual([])
  })
})

describe('CC 2.1.290 B1 — @-mention pipeline integration', () => {
  test('getAttachments: @-mentioned folder listing omits the denied name', async () => {
    const dir = makeDir('mention-dir')
    writeFileSync(join(dir, 'denied.md'), SECRET_CONTENT)
    writeFileSync(join(dir, 'ok.md'), 'PUBLIC')
    const context = makeToolUseContext(
      makePermissionContext({ deny: [`Read(/${dir}/denied.md)`] }),
    )

    const attachments = await getAttachments(
      `@${dir}`,
      context,
      null,
      [],
      [],
      undefined,
      { skipSkillDiscovery: true },
    )

    const directory = attachments.find(a => a.type === 'directory')
    expect(directory).toBeDefined()
    if (directory?.type === 'directory') {
      expect(directory.content.split('\n')).toEqual(['ok.md'])
      expect(directory.content).not.toContain('denied.md')
      expect(directory.content).not.toContain(SECRET_CONTENT)
    }
  })

  test('getAttachments: no deny rules → both names listed (regression)', async () => {
    const dir = makeDir('mention-dir-open')
    writeFileSync(join(dir, 'one.md'), 'ONE')
    writeFileSync(join(dir, 'two.md'), 'TWO')
    const context = makeToolUseContext(makePermissionContext())

    const attachments = await getAttachments(
      `@${dir}`,
      context,
      null,
      [],
      [],
      undefined,
      { skipSkillDiscovery: true },
    )

    const directory = attachments.find(a => a.type === 'directory')
    expect(directory).toBeDefined()
    if (directory?.type === 'directory') {
      expect(directory.content.split('\n').sort()).toEqual(['one.md', 'two.md'])
    }
  })
})
