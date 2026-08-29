import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import { getCwd } from 'src/utils/cwd.js'
import { ripgrepCommand } from 'src/utils/ripgrep.js'
import {
  assertDenyPatternsUnchanged,
  computeReadDenyPatternSnapshot,
  prepareVerifiedSearchTarget,
  RipgrepNullByteError,
  searchCouldNotOpenMessage,
  searchDenyRulesChangedMessage,
  searchNotTraversableMessage,
  searchPathOnlyRipgrepRefusedMessage,
  searchSymlinkRefusedMessage,
} from '../searchTargetGate.js'
import {
  setSessionWritePermissionStashForTesting,
  stashCheckTimeResolutions,
  SymlinkReadRefusedError,
  SymlinkResolutionStash,
} from '../symlinkResolutionStash.js'

/**
 * CC 2.1.251 security fix (changelog, Gap-109b): Grep/Glob bind their
 * check-time symlink resolutions to the search (binary S2t gate + Nve stash
 * consumer + H2t deny-pattern recheck) so a concurrent rewrite of a
 * working-directory symlink cannot redirect an approved search between the
 * permission check and the ripgrep spawn. Every refusal string asserted here
 * is the official binary's exact string — none are invented.
 *
 * Environment note: in this repo's test environment ripgrep resolves to a
 * PATH-name-only `rg` (no vendored binary), so the binary's PATH-name-only
 * guard (R()) is live: searches OUTSIDE the session cwd are refused, and the
 * happy-path fixtures therefore live under getCwd().
 */

// The read-permission probe reaches getBundledSkillsRoot, which reads
// MACRO.VERSION; mirror the cli.tsx polyfill (same as symlinkResolutionStash251).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const NUL = String.fromCharCode(0)

const cleanupRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    cleanupRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  // Fresh session stash per test (binary: one stash per session tree).
  setSessionWritePermissionStashForTesting(new SymlinkResolutionStash())
})

function uniqueSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

// Happy-path fixture INSIDE the session cwd (PATH-name-only rg guard lets
// these through; /tmp fixtures are refused by design in this environment).
async function makeCwdDir(prefix: string): Promise<string> {
  const dir = join(getCwd(), `.${prefix}-${uniqueSuffix()}`)
  await mkdir(dir, { recursive: true })
  cleanupRoots.push(dir)
  return dir
}

// Outside-cwd fixture for the PATH-name-only guard + retarget refusals.
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanupRoots.push(dir)
  return dir
}

function makePermContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as ToolPermissionContext
}

function makeContext(opts: { toolUseId?: string } = {}): ToolUseContext {
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermContext(),
  }
  return {
    options: { tools: [] },
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    toolUseId: opts.toolUseId,
  } as unknown as ToolUseContext
}

describe('2.1.251: byte-matched search refusal messages (S2t/u/R/H2t)', () => {
  test('symlink-resolution refusal is the exact binary u() string', () => {
    expect(searchSymlinkRefusedMessage('/w/dir')).toBe(
      'Refusing to search /w/dir: its symlink resolution changed after permission was checked. If a link in the working directory is being rewritten concurrently, stop that and retry.',
    )
  })

  test('PATH-name-only ripgrep refusal is the exact binary R() string', () => {
    expect(searchPathOnlyRipgrepRefusedMessage('/w/dir')).toBe(
      'Refusing to search /w/dir: ripgrep was found only by name on PATH, and a search outside the working directory cannot apply your Read deny rules in that configuration. Install ripgrep at an absolute path or search under the working directory.',
    )
  })

  test('open-failure refusal is the exact binary aY-catch string (em dash)', () => {
    expect(searchCouldNotOpenMessage('/w/dir', 'EACCES')).toBe(
      'Refusing to search /w/dir: it could not be opened (EACCES) — it is unreadable, or is being replaced concurrently.',
    )
  })

  test('traversability refusal is the exact binary lY-catch string', () => {
    expect(searchNotTraversableMessage('/w/dir')).toBe(
      'Cannot search /w/dir: the directory is not traversable (no execute permission).',
    )
  })

  test('deny-rule-change refusal is the exact binary H2t string', () => {
    expect(searchDenyRulesChangedMessage('/w/dir')).toBe(
      'Refusing to search /w/dir: a path one of its Read deny rules is written through changed while the search was being prepared. Retry.',
    )
  })

  test('RipgrepNullByteError carries the binary j0 name', () => {
    expect(new RipgrepNullByteError('x').name).toBe('RipgrepNullByteError')
  })
})

describe('2.1.251: prepareVerifiedSearchTarget (binary S2t)', () => {
  test('a directory under the cwd passes and reports isDirectory', async () => {
    // Arrange
    const dir = await makeCwdDir('tmp-109b-okdir')
    const ctx = { toolUseId: `toolu_okdir_${uniqueSuffix()}` }
    stashCheckTimeResolutions(ctx, dir, 'read')

    // Act
    const target = await prepareVerifiedSearchTarget(
      makeContext(ctx),
      dir,
    )

    // Assert
    expect(target).not.toBeNull()
    expect(target?.isDirectory).toBe(true)
    expect(target?.lexicalPath).toBe(dir)
    // recheckBeforeSpawn passes while nothing changed.
    expect(() => target?.recheckBeforeSpawn()).not.toThrow()
  })

  test('a regular file under the cwd passes and reports isDirectory=false', async () => {
    // Arrange
    const dir = await makeCwdDir('tmp-109b-okfile')
    const file = join(dir, 'a.txt')
    await writeFile(file, 'A')
    const ctx = { toolUseId: `toolu_okfile_${uniqueSuffix()}` }
    stashCheckTimeResolutions(ctx, file, 'read')

    // Act
    const target = await prepareVerifiedSearchTarget(makeContext(ctx), file)

    // Assert
    expect(target).not.toBeNull()
    expect(target?.isDirectory).toBe(false)
  })

  test('a null byte in the target throws RipgrepNullByteError (binary fu)', async () => {
    // Arrange + Act
    let caught: unknown
    try {
      await prepareVerifiedSearchTarget(
        makeContext({ toolUseId: 'toolu_nul' }),
        `/tmp/evil${NUL}dir`,
      )
    } catch (err) {
      caught = err
    }

    // Assert — exact binary fu() message.
    expect(caught).toBeInstanceOf(RipgrepNullByteError)
    expect((caught as Error).message).toBe(
      'Cannot spawn ripgrep: the target path contains a null byte (\\0)',
    )
  })

  test('a retargeted directory symlink between check and prep is refused', async () => {
    // Arrange — approved while link → dirA; retarget to dirB before prep.
    const dir = await makeCwdDir('tmp-109b-retarget')
    const dirA = join(dir, 'a')
    const dirB = join(dir, 'b')
    await mkdir(dirA)
    await mkdir(dirB)
    await writeFile(join(dirB, 'secret.txt'), 'SECRET')
    const link = join(dir, 'link')
    await symlink(dirA, link)
    const ctx = { toolUseId: `toolu_rt_${uniqueSuffix()}` }
    stashCheckTimeResolutions(ctx, link, 'read')

    // Act — the TOCTOU window: the link is rewritten after approval.
    await unlink(link)
    await symlink(dirB, link)

    // Assert — refused with the exact binary u() message.
    let caught: unknown
    try {
      await prepareVerifiedSearchTarget(makeContext(ctx), link)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(searchSymlinkRefusedMessage(link))
  })

  test('recheckBeforeSpawn catches a retarget that lands after prep', async () => {
    // Arrange
    const dir = await makeCwdDir('tmp-109b-respawn')
    const dirA = join(dir, 'a')
    const dirB = join(dir, 'b')
    await mkdir(dirA)
    await mkdir(dirB)
    const link = join(dir, 'link')
    await symlink(dirA, link)
    const ctx = { toolUseId: `toolu_rs_${uniqueSuffix()}` }
    stashCheckTimeResolutions(ctx, link, 'read')
    const target = await prepareVerifiedSearchTarget(makeContext(ctx), link)
    expect(target).not.toBeNull()

    // Act — retarget AFTER prep, inside the prep→spawn window.
    await unlink(link)
    await symlink(dirB, link)

    // Assert — the binary beforeSpawn recheck refuses.
    let caught: unknown
    try {
      target?.recheckBeforeSpawn()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(searchSymlinkRefusedMessage(link))
  })

  test('a vanished target returns null (binary GPn/Qat empty-result branch)', async () => {
    // Arrange — real directory stashed, then removed before prep.
    const dir = await makeCwdDir('tmp-109b-vanish')
    const target = join(dir, 'searchdir')
    await mkdir(target)
    const ctx = { toolUseId: `toolu_van_${uniqueSuffix()}` }
    stashCheckTimeResolutions(ctx, target, 'read')
    await rm(target, { recursive: true, force: true })

    // Act
    const result = await prepareVerifiedSearchTarget(makeContext(ctx), target)

    // Assert — null, which callers turn into an empty search result.
    expect(result).toBeNull()
  })

  test('no stash entry fails open with a fresh resolution (binary Nve miss)', async () => {
    // Arrange — real directory, but nothing stashed for this toolUseId.
    const dir = await makeCwdDir('tmp-109b-fresh')
    await writeFile(join(dir, 'a.txt'), 'A')

    // Act + Assert — passes; no throw.
    const target = await prepareVerifiedSearchTarget(
      makeContext({ toolUseId: `toolu_unknown_${uniqueSuffix()}` }),
      dir,
    )
    expect(target).not.toBeNull()
  })

  test('an evicted stash entry fails closed with the expiry message', async () => {
    // Arrange — cap 1 evicts the first read-lane entry on the second stash.
    setSessionWritePermissionStashForTesting(new SymlinkResolutionStash(1, 16))
    const dir = await makeCwdDir('tmp-109b-evict')
    const ctx = { toolUseId: 'toolu_evicted' }
    stashCheckTimeResolutions(ctx, dir, 'read')
    stashCheckTimeResolutions(
      { toolUseId: 'toolu_other' },
      join(dir, 'x'),
      'read',
    )

    // Act + Assert — one-shot assert inside try/catch (consume is one-shot).
    let caught: unknown
    try {
      await prepareVerifiedSearchTarget(makeContext(ctx), dir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(
      `Refusing to read ${dir}: its permission check expired before it ran (too many concurrent file operations). Retry.`,
    )
  })

  test('PATH-name-only ripgrep: outside-cwd search behavior follows rgPath', async () => {
    // Arrange — a real /tmp directory (outside the session cwd).
    const dir = await makeTmpDir('occ-109b-pathguard-')
    const ctx = { toolUseId: `toolu_pg_${uniqueSuffix()}` }
    stashCheckTimeResolutions(ctx, dir, 'read')

    // Act + Assert — the guard only fires when rg is PATH-name-only.
    const { rgPath } = ripgrepCommand()
    if (rgPath.startsWith('/')) {
      // Absolute rg binary: deny rules stay anchored; the search passes.
      const target = await prepareVerifiedSearchTarget(makeContext(ctx), dir)
      expect(target).not.toBeNull()
    } else {
      // Bare-name rg: refusing is the binary R() behavior.
      let caught: unknown
      try {
        await prepareVerifiedSearchTarget(makeContext(ctx), dir)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
      expect((caught as Error).message).toBe(
        searchPathOnlyRipgrepRefusedMessage(dir),
      )
    }
  })

  test.skipIf(IS_ROOT)(
    'a directory without execute permission is refused (binary lY X_OK)',
    async () => {
      // Arrange — chmod 000 blocks traversal for non-root users only.
      const dir = await makeCwdDir('tmp-109b-noexec')
      await chmod(dir, 0o600)
      const ctx = { toolUseId: `toolu_nx_${uniqueSuffix()}` }
      stashCheckTimeResolutions(ctx, dir, 'read')

      // Act + Assert
      let caught: unknown
      try {
        await prepareVerifiedSearchTarget(makeContext(ctx), dir)
      } catch (err) {
        caught = err
      } finally {
        await chmod(dir, 0o755)
      }
      expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
      expect((caught as Error).message).toBe(searchNotTraversableMessage(dir))
    },
  )
})

describe('2.1.251: deny-pattern recheck (binary H2t)', () => {
  test('identical snapshots pass', () => {
    // Arrange
    const context = makePermContext()
    const baseline = computeReadDenyPatternSnapshot(context, '/w')

    // Act + Assert — no throw.
    assertDenyPatternsUnchanged(
      '/w',
      baseline,
      computeReadDenyPatternSnapshot(context, '/w'),
    )
  })

  test('a changed pattern is refused with the exact H2t message', () => {
    // Arrange
    const baseline = ['!/w/secret/**']

    // Act + Assert — one-shot assert (the function throws synchronously).
    expect(() =>
      assertDenyPatternsUnchanged('/w', baseline, ['!/w/other/**']),
    ).toThrow(searchDenyRulesChangedMessage('/w'))
  })

  test('a length change is refused', () => {
    expect(() =>
      assertDenyPatternsUnchanged('/w', ['!/w/a'], ['!/w/a', '!/w/b']),
    ).toThrow(searchDenyRulesChangedMessage('/w'))
  })

  test('computeReadDenyPatternSnapshot returns an array', () => {
    const snapshot = computeReadDenyPatternSnapshot(makePermContext(), '/w')
    expect(Array.isArray(snapshot)).toBe(true)
  })
})

describe('2.1.251: GrepTool wiring (binary zPn = S2t + GPn + beforeSpawn)', () => {
  test('checkPermissions stashes; a retargeted search dir is refused in call()', async () => {
    // Arrange — link → dirA approved at check time, retargeted before call.
    const root = await makeCwdDir('tmp-109b-greprt')
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    await mkdir(dirA)
    await mkdir(dirB)
    await writeFile(join(dirB, 'secret.txt'), 'SECRET')
    const link = join(root, 'link')
    await symlink(dirA, link)
    const ctx = makeContext({ toolUseId: `toolu_greprt_${uniqueSuffix()}` })

    // Act — the real checkPermissions runs the binary stash site…
    await GrepTool.checkPermissions(
      { pattern: 'token', path: link } as never,
      ctx,
    )
    // …then the link is rewritten inside the TOCTOU window…
    await unlink(link)
    await symlink(dirB, link)

    // Assert — …and call() refuses with the exact binary message.
    let caught: unknown
    try {
      await GrepTool.call({ pattern: 'token', path: link } as never, ctx)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(searchSymlinkRefusedMessage(link))
  })

  test('a vanished search path returns the binary GPn empty result (files_with_matches)', async () => {
    // Arrange — never-stashed path that does not exist.
    const gone = join(getCwd(), `.tmp-109b-gone-${uniqueSuffix()}`)
    const ctx = makeContext({ toolUseId: `toolu_gone1_${uniqueSuffix()}` })

    // Act
    const result = await GrepTool.call(
      { pattern: 'token', path: gone } as never,
      ctx,
    )

    // Assert — exact GPn files_with_matches shape.
    expect(result.data).toEqual({
      mode: 'files_with_matches',
      filenames: [],
      numFiles: 0,
      totalFiles: 0,
    })
  })

  test('a vanished search path returns the binary GPn empty result (count mode)', async () => {
    // Arrange
    const gone = join(getCwd(), `.tmp-109b-gone-${uniqueSuffix()}`)
    const ctx = makeContext({ toolUseId: `toolu_gone2_${uniqueSuffix()}` })

    // Act
    const result = await GrepTool.call(
      { pattern: 'token', path: gone, output_mode: 'count' } as never,
      ctx,
    )

    // Assert — exact GPn count shape.
    expect(result.data).toEqual({
      mode: 'count',
      numFiles: 0,
      filenames: [],
      content: '',
      numMatches: 0,
      appliedLimit: undefined,
      appliedOffset: undefined,
    })
  })

  test('a vanished search path returns the binary GPn empty result (content mode)', async () => {
    // Arrange
    const gone = join(getCwd(), `.tmp-109b-gone-${uniqueSuffix()}`)
    const ctx = makeContext({ toolUseId: `toolu_gone3_${uniqueSuffix()}` })

    // Act
    const result = await GrepTool.call(
      { pattern: 'token', path: gone, output_mode: 'content' } as never,
      ctx,
    )

    // Assert — exact GPn content shape.
    expect(result.data).toEqual({
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: '',
      numLines: 0,
      totalLines: 0,
      appliedLimit: undefined,
      appliedOffset: undefined,
    })
  })

  test('an unchanged search dir under cwd still searches (no regression)', async () => {
    // Arrange — a unique token file in a fresh cwd subdir.
    const token = `tok109b${uniqueSuffix()}`
    const dir = await makeCwdDir('tmp-109b-grepok')
    await writeFile(join(dir, 'hit.txt'), `${token}\n`)
    const ctx = makeContext({ toolUseId: `toolu_grepok_${uniqueSuffix()}` })
    await GrepTool.checkPermissions(
      { pattern: token, path: dir } as never,
      ctx,
    )

    // Act
    const result = await GrepTool.call(
      { pattern: token, path: dir } as never,
      ctx,
    )

    // Assert — the match is found through the gate.
    expect(result.data.numFiles).toBe(1)
    expect(result.data.filenames[0]).toContain('hit.txt')
  })
})

describe('2.1.251: GlobTool wiring (binary Qat = S2t + NI.getPath)', () => {
  test('getPath prefers an absolute pattern base dir (binary NI.getPath/Jve)', async () => {
    // Arrange
    const dir = await makeCwdDir('tmp-109b-globbase')

    // Act + Assert — absolute pattern: baseDir wins over the path param…
    expect(GlobTool.getPath({ pattern: join(dir, '*.ts'), path: '/elsewhere' })).toBe(dir)
    // …relative pattern: the path param wins…
    expect(GlobTool.getPath({ pattern: '*.ts', path: dir })).toBe(dir)
    // …and no path falls back to cwd.
    expect(GlobTool.getPath({ pattern: '*.ts' })).toBe(getCwd())
  })

  test('checkPermissions stashes; a retargeted search dir is refused in call()', async () => {
    // Arrange
    const root = await makeCwdDir('tmp-109b-globrt')
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    await mkdir(dirA)
    await mkdir(dirB)
    await writeFile(join(dirB, 'secret.txt'), 'SECRET')
    const link = join(root, 'link')
    await symlink(dirA, link)
    const ctx = makeContext({ toolUseId: `toolu_globrt_${uniqueSuffix()}` })

    // Act — the real checkPermissions stashes getPath({pattern, path: link})
    // = link (relative pattern, so the path param wins)…
    await GlobTool.checkPermissions(
      { pattern: '*', path: link } as never,
      ctx,
    )
    // …then the link is rewritten inside the TOCTOU window…
    await unlink(link)
    await symlink(dirB, link)

    // Assert — …and call() refuses with the exact binary message.
    let caught: unknown
    try {
      await GlobTool.call({ pattern: '*', path: link } as never, ctx)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(searchSymlinkRefusedMessage(link))
  })

  test('a vanished search dir returns the empty result (binary Qat null branch)', async () => {
    // Arrange
    const gone = join(getCwd(), `.tmp-109b-globgone-${uniqueSuffix()}`)
    const ctx = makeContext({ toolUseId: `toolu_globgone_${uniqueSuffix()}` })

    // Act
    const result = await GlobTool.call(
      { pattern: '*.txt', path: gone } as never,
      ctx,
    )

    // Assert — empty filenames, zero count, not truncated.
    expect(result.data.filenames).toEqual([])
    expect(result.data.numFiles).toBe(0)
    expect(result.data.truncated).toBe(false)
  })

  test('an unchanged search dir under cwd still globs (no regression)', async () => {
    // Arrange
    const dir = await makeCwdDir('tmp-109b-globok')
    await writeFile(join(dir, 'find-me.txt'), 'x')
    const ctx = makeContext({ toolUseId: `toolu_globok_${uniqueSuffix()}` })
    await GlobTool.checkPermissions(
      { pattern: '*.txt', path: dir } as never,
      ctx,
    )

    // Act
    const result = await GlobTool.call(
      { pattern: '*.txt', path: dir } as never,
      ctx,
    )

    // Assert — the file is found through the gate.
    expect(result.data.numFiles).toBe(1)
    expect(result.data.filenames[0]).toContain('find-me.txt')
    expect(result.data.truncated).toBe(false)
  })
})
