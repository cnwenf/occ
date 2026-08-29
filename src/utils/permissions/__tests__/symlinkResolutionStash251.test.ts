import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import {
  assertSymlinkResolutionsUnchangedForRead,
  assertSymlinkResolutionsUnchangedForWrite,
  PERMISSION_STASH_EVICTED,
  setSessionWritePermissionStashForTesting,
  stashCheckTimeResolutions,
  SymlinkReadRefusedError,
  SymlinkResolutionStash,
  symlinkReadRefusedMessage,
  SymlinkWriteRefusedError,
  symlinkWriteRefusedMessage,
  takeApprovedPaths,
  takeApprovedPathsForRead,
} from '../symlinkResolutionStash.js'

/**
 * CC 2.1.251 security fix (changelog, Gap-109a): file tools bind their
 * check-time symlink resolutions to the tool use (binary class `Re` stash +
 * `a1`/`Nve` consumers + `Uzt`/`LC` first gates) so a concurrent rewrite of
 * a working-directory symlink cannot redirect an approved read/write
 * between the permission check and the IO. Every refusal string asserted
 * here is the official binary's exact string — none are invented.
 */

// The read-permission probe reaches getBundledSkillsRoot, which reads
// MACRO.VERSION; mirror the cli.tsx polyfill (same as scriptPathGate251).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  // Fresh session stash per test (binary: one `new Re` per session tree).
  setSessionWritePermissionStashForTesting(new SymlinkResolutionStash())
})

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function makeContext(opts: { toolUseId?: string } = {}): ToolUseContext {
  const permContext = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as ToolPermissionContext
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    options: { tools: [] },
    getAppState: () => appState,
    toolUseId: opts.toolUseId,
  } as unknown as ToolUseContext
}

describe('2.1.251: SymlinkResolutionStash semantics (binary Re)', () => {
  test('stash then consume returns the entry once (one-shot per toolUseId)', () => {
    // Arrange
    const stash = new SymlinkResolutionStash()

    // Act
    stash.stash('toolu_1', '/w/a.txt', ['/w/a.txt'])

    // Assert
    expect(stash.consume('toolu_1', '/w/a.txt')).toEqual(['/w/a.txt'])
    // One-shot: the entry is gone after the first consume (miss, not evicted).
    expect(stash.consume('toolu_1', '/w/a.txt')).toBeUndefined()
  })

  test('undefined toolUseId: stash is a no-op and consume returns undefined', () => {
    // Arrange
    const stash = new SymlinkResolutionStash()

    // Act
    stash.stash(undefined, '/w/a.txt', ['/w/a.txt'])

    // Assert
    expect(stash.consume(undefined, '/w/a.txt')).toBeUndefined()
  })

  test('re-stash of the same key intersects the resolution sets', () => {
    // Arrange
    const stash = new SymlinkResolutionStash()

    // Act
    stash.stash('toolu_1', '/w/a.txt', ['/w/a.txt', '/w/target1'])
    stash.stash('toolu_1', '/w/a.txt', ['/w/target1', '/w/target2'])

    // Assert — only the common resolution survives.
    expect(stash.consume('toolu_1', '/w/a.txt')).toEqual(['/w/target1'])
  })

  test('an evicted key is never re-stashed (the tool use stays expired)', () => {
    // Arrange — cap 1 forces eviction on the second entry.
    const stash = new SymlinkResolutionStash(1, 16)
    stash.stash('toolu_1', '/w/a.txt', ['/w/a.txt'])
    stash.stash('toolu_2', '/w/b.txt', ['/w/b.txt'])

    // Act — re-stash of the evicted key is ignored.
    stash.stash('toolu_1', '/w/a.txt', ['/w/a.txt'])

    // Assert
    expect(stash.consume('toolu_1', '/w/a.txt')).toBe(PERMISSION_STASH_EVICTED)
    expect(stash.consume('toolu_2', '/w/b.txt')).toEqual(['/w/b.txt'])
  })

  test('entriesCap pressure evicts the oldest entry → consume reports eviction', () => {
    // Arrange
    const stash = new SymlinkResolutionStash(2, 16)
    stash.stash('toolu_1', '/w/a.txt', ['/w/a.txt'])
    stash.stash('toolu_2', '/w/b.txt', ['/w/b.txt'])

    // Act — third entry evicts the oldest (toolu_1).
    stash.stash('toolu_3', '/w/c.txt', ['/w/c.txt'])

    // Assert
    expect(stash.consume('toolu_1', '/w/a.txt')).toBe(PERMISSION_STASH_EVICTED)
    expect(stash.consume('toolu_2', '/w/b.txt')).toEqual(['/w/b.txt'])
    expect(stash.consume('toolu_3', '/w/c.txt')).toEqual(['/w/c.txt'])
  })

  test('evictedKeysCap overflow poisons the lane: every later miss expires', () => {
    // Arrange — cap 2 entries, cap 1 evicted key.
    const stash = new SymlinkResolutionStash(2, 1)
    stash.stash('toolu_1', '/w/a.txt', ['a'])
    stash.stash('toolu_2', '/w/b.txt', ['b'])
    stash.stash('toolu_3', '/w/c.txt', ['c']) // evicts toolu_1
    stash.stash('toolu_4', '/w/d.txt', ['d']) // evicts toolu_2 → poisons

    // Act + Assert — even a never-seen key now fails closed.
    expect(stash.consume('toolu_1', '/w/a.txt')).toBe(PERMISSION_STASH_EVICTED)
    expect(stash.consume('toolu_never', '/w/zzz.txt')).toBe(
      PERMISSION_STASH_EVICTED,
    )
    // Live entries still resolve.
    expect(stash.consume('toolu_3', '/w/c.txt')).toEqual(['c'])
  })

  test('consume deletes every key of the toolUseId from the lane', () => {
    // Arrange
    const stash = new SymlinkResolutionStash()
    stash.stash('toolu_1', '/w/a.txt', ['a'])
    stash.stash('toolu_1', '/w/b.txt', ['b'])
    stash.stash('toolu_2', '/w/a.txt', ['other'])

    // Act
    expect(stash.consume('toolu_1', '/w/a.txt')).toEqual(['a'])

    // Assert — toolu_1's second path is gone (miss, not eviction)…
    expect(stash.consume('toolu_1', '/w/b.txt')).toBeUndefined()
    // …while another toolUseId's entry is untouched.
    expect(stash.consume('toolu_2', '/w/a.txt')).toEqual(['other'])
  })

  test('write and read lanes are isolated', () => {
    // Arrange
    const stash = new SymlinkResolutionStash()
    stash.stash('toolu_1', '/w/a.txt', ['write-set'], 'write')
    stash.stash('toolu_1', '/w/a.txt', ['read-set'], 'read')

    // Act + Assert
    expect(stash.consume('toolu_1', '/w/a.txt', 'read')).toEqual(['read-set'])
    expect(stash.consume('toolu_1', '/w/a.txt', 'write')).toEqual(['write-set'])
    // A lane miss is not an eviction in the other lane.
    expect(
      new SymlinkResolutionStash().consume('toolu_x', '/w/a.txt', 'read'),
    ).toBeUndefined()
  })
})

describe('2.1.251: error classes + byte-matched messages (Gm/c7/H/B)', () => {
  test('error class names match the binary', () => {
    expect(new SymlinkWriteRefusedError('x').name).toBe(
      'SymlinkWriteRefusedError',
    )
    expect(new SymlinkReadRefusedError('x').name).toBe('SymlinkReadRefusedError')
  })

  test('read refusal message is the exact binary H() string', () => {
    expect(symlinkReadRefusedMessage('/w/link.txt')).toBe(
      'Refusing to read /w/link.txt: its symlink resolution changed after permission was checked. If a link in the working directory is being rewritten concurrently, stop that and retry.',
    )
  })

  test('write refusal message is the exact binary B() string', () => {
    expect(symlinkWriteRefusedMessage('/w/link.txt')).toBe(
      'Refusing to write /w/link.txt: its parent-directory symlink resolution changed after permission was checked.',
    )
  })

  test('expiry messages are the exact binary a1 strings (write + read lanes)', () => {
    // Arrange — cap 1 evicts the first entry on the second stash.
    setSessionWritePermissionStashForTesting(new SymlinkResolutionStash(1, 16))
    const ctx = { toolUseId: 'toolu_old' }
    stashCheckTimeResolutions(ctx, '/w/expired.txt', 'write')
    stashCheckTimeResolutions({ toolUseId: 'toolu_new' }, '/w/other.txt', 'write')

    // Act + Assert — write lane.
    expect(() => takeApprovedPaths(ctx, '/w/expired.txt', 'write')).toThrow(
      'Refusing to write /w/expired.txt: its permission check expired before it ran (too many concurrent file operations). Retry.',
    )

    // Arrange + Act + Assert — read lane (one-shot consume: assert once).
    setSessionWritePermissionStashForTesting(new SymlinkResolutionStash(1, 16))
    stashCheckTimeResolutions(ctx, '/w/expired.txt', 'read')
    stashCheckTimeResolutions({ toolUseId: 'toolu_new' }, '/w/other.txt', 'read')
    let caught: unknown
    try {
      takeApprovedPathsForRead(ctx, '/w/expired.txt')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(
      'Refusing to read /w/expired.txt: its permission check expired before it ran (too many concurrent file operations). Retry.',
    )
  })
})

describe('2.1.251: takeApprovedPaths (binary a1/Nve)', () => {
  test('returns the stashed entry on a hit', () => {
    // Arrange
    const ctx = { toolUseId: 'toolu_hit' }
    stashCheckTimeResolutions(ctx, '/w/plain.txt', 'write')

    // Act + Assert — the stashed set contains at least the path itself.
    const approved = takeApprovedPaths(ctx, '/w/plain.txt', 'write')
    expect(approved).toContain('/w/plain.txt')
  })

  test('missing stash falls back to a fresh resolution without throwing', async () => {
    // Arrange — real file, but nothing was stashed for this toolUseId.
    const dir = await makeDir('occ-109a-fresh-')
    const file = join(dir, 'file.txt')
    await writeFile(file, 'content')

    // Act
    const approved = takeApprovedPaths({ toolUseId: 'toolu_fresh' }, file)

    // Assert — fresh resolution, no error.
    expect(approved).toContain(file)
  })
})

describe('2.1.251: IO-time gates over a real filesystem (Uzt/LC first gates)', () => {
  test('read gate passes when the resolution is unchanged', async () => {
    // Arrange
    const dir = await makeDir('occ-109a-rok-')
    const target = join(dir, 'target.txt')
    await writeFile(target, 'A')
    const link = join(dir, 'link.txt')
    await symlink(target, link)
    const ctx = { toolUseId: 'toolu_rok' }
    stashCheckTimeResolutions(ctx, link, 'read')

    // Act + Assert — no throw.
    assertSymlinkResolutionsUnchangedForRead(ctx, link)
  })

  test('write gate passes when the resolution is unchanged', async () => {
    // Arrange
    const dir = await makeDir('occ-109a-wok-')
    const target = join(dir, 'target.txt')
    await writeFile(target, 'A')
    const link = join(dir, 'link.txt')
    await symlink(target, link)
    const ctx = { toolUseId: 'toolu_wok' }
    stashCheckTimeResolutions(ctx, link, 'write')

    // Act + Assert — no throw.
    assertSymlinkResolutionsUnchangedForWrite(ctx, link)
  })

  test('write gate passes for a plain regular file that does not exist yet', async () => {
    // Arrange — the common FileWrite create case.
    const dir = await makeDir('occ-109a-new-')
    const file = join(dir, 'new-file.txt')
    const ctx = { toolUseId: 'toolu_new' }
    stashCheckTimeResolutions(ctx, file, 'write')

    // Act + Assert — no throw.
    assertSymlinkResolutionsUnchangedForWrite(ctx, file)
  })

  test('read gate refuses a retargeted symlink with the byte-matched message', async () => {
    // Arrange — approved while link → targetA; retarget to targetB before IO.
    const dir = await makeDir('occ-109a-rrt-')
    const targetA = join(dir, 'a.txt')
    const targetB = join(dir, 'b.txt')
    await writeFile(targetA, 'A')
    await writeFile(targetB, 'B')
    const link = join(dir, 'link.txt')
    await symlink(targetA, link)
    const ctx = { toolUseId: 'toolu_rrt' }
    stashCheckTimeResolutions(ctx, link, 'read')

    // Act — the TOCTOU window: the link is rewritten after approval.
    await unlink(link)
    await symlink(targetB, link)

    // Assert — refused with the exact binary H() message (one-shot consume:
    // the gate runs exactly once per tool use, like the binary IO path).
    let caught: unknown
    try {
      assertSymlinkResolutionsUnchangedForRead(ctx, link)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(symlinkReadRefusedMessage(link))
  })

  test('write gate refuses a retargeted symlink with the byte-matched message', async () => {
    // Arrange
    const dir = await makeDir('occ-109a-wrt-')
    const targetA = join(dir, 'a.txt')
    const targetB = join(dir, 'b.txt')
    await writeFile(targetA, 'A')
    await writeFile(targetB, 'B')
    const link = join(dir, 'link.txt')
    await symlink(targetA, link)
    const ctx = { toolUseId: 'toolu_wrt' }
    stashCheckTimeResolutions(ctx, link, 'write')

    // Act
    await unlink(link)
    await symlink(targetB, link)

    // Assert — refused with the exact binary B() message (one-shot consume).
    let caught: unknown
    try {
      assertSymlinkResolutionsUnchangedForWrite(ctx, link)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkWriteRefusedError)
    expect((caught as Error).message).toBe(symlinkWriteRefusedMessage(link))
  })

  test('a symlink swapped to a different link chain is refused', async () => {
    // Arrange — link → hop1 → target at check time; link → hop2 at IO time.
    const dir = await makeDir('occ-109a-chain-')
    const target = join(dir, 'target.txt')
    await writeFile(target, 'A')
    const hop1 = join(dir, 'hop1')
    const hop2 = join(dir, 'hop2')
    await symlink(target, hop1)
    await symlink(target, hop2)
    const link = join(dir, 'link.txt')
    await symlink(hop1, link)
    const ctx = { toolUseId: 'toolu_chain' }
    stashCheckTimeResolutions(ctx, link, 'read')

    // Act
    await unlink(link)
    await symlink(hop2, link)

    // Assert — hop2 was never part of the approved resolution set.
    expect(() => assertSymlinkResolutionsUnchangedForRead(ctx, link)).toThrow(
      SymlinkReadRefusedError,
    )
  })
})

describe('2.1.251: tool wiring at checkPermissions time', () => {
  test('FileReadTool.checkPermissions stashes the read lane; a later retarget is refused', async () => {
    // Arrange
    const dir = await makeDir('occ-109a-frt-')
    const targetA = join(dir, 'a.txt')
    const targetB = join(dir, 'b.txt')
    await writeFile(targetA, 'A')
    await writeFile(targetB, 'SECRET')
    const link = join(dir, 'link.txt')
    await symlink(targetA, link)
    const ctx = makeContext({ toolUseId: 'toolu_fr_1' })

    // Act — the real checkPermissions runs the binary's stash site.
    await FileReadTool.checkPermissions({ file_path: link } as never, ctx)

    // Assert — a retarget inside the TOCTOU window is refused (one-shot
    // consume: the single gate call below IS the IO-time check).
    await unlink(link)
    await symlink(targetB, link)
    let caught: unknown
    try {
      assertSymlinkResolutionsUnchangedForRead(ctx, link)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkReadRefusedError)
    expect((caught as Error).message).toBe(symlinkReadRefusedMessage(link))
  })

  test('FileWriteTool.checkPermissions stashes the write lane; a later retarget is refused', async () => {
    // Arrange
    const dir = await makeDir('occ-109a-fwt-')
    const targetA = join(dir, 'a.txt')
    const targetB = join(dir, 'b.txt')
    await writeFile(targetA, 'A')
    await writeFile(targetB, 'B')
    const link = join(dir, 'link.txt')
    await symlink(targetA, link)
    const ctx = makeContext({ toolUseId: 'toolu_fw_1' })

    // Act
    await FileWriteTool.checkPermissions(
      { file_path: link, content: 'x' } as never,
      ctx,
    )

    // Assert — a retarget inside the TOCTOU window is refused (one-shot).
    await unlink(link)
    await symlink(targetB, link)
    let caught: unknown
    try {
      assertSymlinkResolutionsUnchangedForWrite(ctx, link)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SymlinkWriteRefusedError)
    expect((caught as Error).message).toBe(symlinkWriteRefusedMessage(link))
  })

  test('without a toolUseId the gate fails open exactly like the binary', async () => {
    // Arrange — binary a1 with no stashed entry: fresh resolution fallback.
    const dir = await makeDir('occ-109a-noid-')
    const targetA = join(dir, 'a.txt')
    const targetB = join(dir, 'b.txt')
    await writeFile(targetA, 'A')
    await writeFile(targetB, 'B')
    const link = join(dir, 'link.txt')
    await symlink(targetA, link)
    const ctx = makeContext({ toolUseId: 'toolu_noid' })
    await FileReadTool.checkPermissions({ file_path: link } as never, ctx)

    // Act — consume with an UNKNOWN toolUseId (no stash of its own).
    await unlink(link)
    await symlink(targetB, link)

    // Assert — fresh fallback passes (binary behavior), no throw.
    assertSymlinkResolutionsUnchangedForRead({ toolUseId: 'toolu_unknown' }, link)
  })
})
