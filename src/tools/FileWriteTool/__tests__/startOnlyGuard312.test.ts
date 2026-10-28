import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
} from 'src/utils/fileStateCache.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import {
  FILE_START_ONLY_WRITE_MESSAGE,
  FileStateError,
} from 'src/utils/permissions/fileStateGuard.js'
import { applyChangedFileWatcherReseed } from 'src/utils/attachments.js'
import { memoryFilesToAttachments } from 'src/utils/attachments.js'
import type { MemoryFileInfo } from 'src/utils/claudemd.js'
import { getMemoryCharThreshold } from 'src/utils/memoryThreshold.js'
import { getContextWindowForModel } from 'src/utils/context.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'
import { getFileModificationTime } from 'src/utils/file.js'
import { normalizeForComparison } from 'src/utils/permissions/fileStateGuard.js'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.312 (item 4) — Write guard for files seeded from context with only
 * their start (eviction-proof startOnly set).
 *
 * Official v312 byte evidence (all verified in /tmp/cc-diff-312):
 * - Guidance message `e7o` @241153419 with `it="Edit"` and `Dee="allow_large"`
 *   (@240867736: `var Ve="Read",Dee="allow_large",…`).
 * - Read-state store `Sa` @244819043:
 *     `startOnly=new Set; markStartOnly(e){this.startOnly.add(rn(e))}
 *      startOnlyPaths(){return[...this.startOnly]}
 *      holdsOnlyStartOf(e){let n=rn(e);return this.startOnly.has(n)&&
 *        !Yoe(this.cache.get(n))}`
 *   with `rn` = `normalize` from "path" (@244818705 chunk import) and
 *   `Yoe(e){return e!==void 0&&CR(e)&&!e.contentNotInModelContext}` @244818076
 *   (≡ OCC isFileStateFullyTrusted), `CR` ≡ isFullReadOfFileState.
 * - Write validateInput @249830441:
 *     `if(s.readFileState.holdsOnlyStartOf(G))return{result:!1,message:e7o,
 *      errorCode:19}` — BEFORE the existing not-read branch (`let Oe=…get(G)`).
 * - Write call path @249832895:
 *     `if(rt!==null&&lt!==null){if(h.holdsOnlyStartOf(G))throw new BX(e7o);…}`
 *   (BX ≡ FileStateError; the check runs only when the file exists on disk).
 * - Marking site @251721817 (nested memory/@-include head cut, gate
 *   `tengu_quizzical_mango` default TRUE → ported unconditionally):
 *     `…isPartialView:Ae||G.contentDiffersFromDisk,…}),
 *      Ae&&k("tengu_quizzical_mango",!0))ze?.markStartOnly(G.path)`
 * - File-change watcher @251734727:
 *     `let mt=e.readFileState.holdsOnlyStartOf(Qe);…
 *      if(ze.isPartialView||mt){let qt=e.readFileState.get(Qe);if(qt)
 *        e.readFileState.set(Qe,{...qt,…ze.isPartialView&&{isPartialView:!0},
 *          …mt&&{contentNotInModelContext:!0}})}`
 * - Official clone `Gue` @244820696 copies the set:
 *     `r.load(s);for(let h of e.startOnlyPaths())r.markStartOnly(h);return r`
 *   and the official merge `X7s(e,n)` = `Gue(e)` + timestamp-newer sets, so
 *   the merged cache inherits ONLY the first cache's startOnly marks.
 *
 * NOT ported (STAGED upstream, gate `tengu_velvet_possum` default false): the
 * top-level CLAUDE.md cut @257559298 + `announced_file_cut` telemetry.
 */

/** The e7o template with it="Edit" / Dee="allow_large" interpolated. */
const EXPECTED_E7O =
  'You were given only the start of this file, and nothing shows that you have since read all of it in one call, so a Write could lose the rest. To change part of it, use Edit. To replace it whole, first Read it in one call with no offset or limit. If Read returns only a page or says the file is too large, Read it again with allow_large: true. If even that cannot return all of it, use Edit.'

function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

let toolUseCounter = 0

function makeContext(): ToolUseContext {
  toolUseCounter += 1
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermissionContext(),
  }
  return {
    toolUseId: `toolu_startonly312_${toolUseCounter}`,
    abortController: new AbortController(),
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [{ name: FILE_WRITE_TOOL_NAME }, { name: FILE_READ_TOOL_NAME }],
    },
    readFileState,
    updateFileHistoryState: () => {},
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

let tmpDir: string
let savedCheckpointEnv: string | undefined
let savedSimpleEnv: string | undefined

beforeAll(() => {
  savedCheckpointEnv = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  // Keep the call path hermetic: no fileHistory backup, no skill scans.
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
  process.env.CLAUDE_CODE_SIMPLE = '1'
})

afterAll(() => {
  if (savedCheckpointEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  } else {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = savedCheckpointEnv
  }
  if (savedSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = savedSimpleEnv
  }
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-startonly-312-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('CC 2.1.312 (item 4) — FILE_START_ONLY_WRITE_MESSAGE (e7o)', () => {
  test('the exported message is byte-verbatim e7o with Edit / allow_large interpolated', () => {
    expect(FILE_START_ONLY_WRITE_MESSAGE).toBe(EXPECTED_E7O)
  })
})

describe('CC 2.1.312 (item 4) — FileStateCache startOnly set (Sa @244819043)', () => {
  test('holdsOnlyStartOf is false for unmarked paths and true after markStartOnly when the entry is not a trusted full read', () => {
    // Arrange
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/sub/CLAUDE.md'
    cache.set(p, {
      content: 'full disk content',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })

    // Act / Assert — unmarked path: false even with a partial-view entry.
    expect(cache.holdsOnlyStartOf(p)).toBe(false)

    // Marked path + partial-view entry (not a trusted full read): true.
    cache.markStartOnly(p)
    expect(cache.holdsOnlyStartOf(p)).toBe(true)
    expect(cache.startOnlyPaths()).toEqual([p])
  })

  test('holdsOnlyStartOf normalizes paths like the cache get/set (rn = path.normalize)', () => {
    // Arrange — mark via a redundant-segment spelling.
    const cache = createFileStateCacheWithSizeLimit(100)
    cache.set('/proj/sub/CLAUDE.md', {
      content: 'head',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })

    // Act
    cache.markStartOnly('/proj/sub/../sub/CLAUDE.md')

    // Assert
    expect(cache.holdsOnlyStartOf('/proj/sub/CLAUDE.md')).toBe(true)
  })

  test('holdsOnlyStartOf is false once a trusted full read replaced the entry (Yoe combination)', () => {
    // Arrange — official holdsOnlyStartOf = startOnly.has(n) && !Yoe(cache.get(n)):
    // a later full Read (no offset/limit, content reached the model) clears the
    // block even though the path stays in the eviction-proof set.
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/full.md'
    cache.markStartOnly(p)
    expect(cache.holdsOnlyStartOf(p)).toBe(true) // no entry at all → not trusted

    // Act — seed a trusted full read.
    cache.set(p, {
      content: 'line1\nline2\n',
      timestamp: 2,
      offset: undefined,
      limit: undefined,
    })

    // Assert
    expect(cache.holdsOnlyStartOf(p)).toBe(false)
  })

  test('an entry with contentNotInModelContext:true is NOT trusted → holdsOnlyStartOf stays true', () => {
    // Arrange — Yoe(e){return e!==void 0&&CR(e)&&!e.contentNotInModelContext}
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/flagged.md'
    cache.markStartOnly(p)
    cache.set(p, {
      content: 'line1\nline2\n',
      timestamp: 2,
      offset: undefined,
      limit: undefined,
      contentNotInModelContext: true,
    })

    // Act / Assert
    expect(cache.holdsOnlyStartOf(p)).toBe(true)
  })

  test('EVICTION-PROOF: LRU eviction of the cache entry does not clear the block', () => {
    // Arrange — this is the regression the official fix addresses: pre-312,
    // evicting the read-state entry lost the block and Write fell through to
    // the generic not-read refusal (or, for newer models with an auto-allowed
    // Read, no refusal at all).
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/evicted.md'
    cache.set(p, {
      content: 'head',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    cache.markStartOnly(p)

    // Act — simulate the LRU eviction.
    cache.delete(p)

    // Assert — still blocked (startOnly.has(n) && !Yoe(undefined) → true).
    expect(cache.get(p)).toBeUndefined()
    expect(cache.holdsOnlyStartOf(p)).toBe(true)
  })

  test('cloneFileStateCache copies the startOnly set (official Gue @244820696)', () => {
    // Arrange
    const cache = createFileStateCacheWithSizeLimit(100)
    cache.markStartOnly('/proj/a.md')
    cache.markStartOnly('/proj/b.md')

    // Act
    const cloned = cloneFileStateCache(cache)

    // Assert — official: `for(let h of e.startOnlyPaths())r.markStartOnly(h)`.
    expect(cloned.startOnlyPaths().sort()).toEqual(['/proj/a.md', '/proj/b.md'])
    expect(cloned.holdsOnlyStartOf('/proj/a.md')).toBe(true)
  })
})

describe('CC 2.1.312 (item 4) — Write validateInput errorCode 19', () => {
  test('a startOnly-marked file seeded as a head cut is refused with errorCode 19 and the e7o message', async () => {
    // Arrange — seed readFileState exactly as the nested head cut does
    // (isPartialView:true) and mark startOnly.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'CLAUDE.md')
    await writeFile(filePath, 'full disk content that the model never saw')
    ctx.readFileState.set(filePath, {
      content: 'full disk content that the model never saw',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    ctx.readFileState.markStartOnly(filePath)

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'x' },
      ctx,
    )

    // Assert — dedicated refusal, NOT the generic not-read (errorCode 2).
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(19)
    expect(result.message).toBe(FILE_START_ONLY_WRITE_MESSAGE)
  })

  test('EVICTION-PROOF: after the LRU entry is evicted the refusal is still errorCode 19 (not 2)', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'evicted.md')
    await writeFile(filePath, 'content')
    ctx.readFileState.set(filePath, {
      content: 'content',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    ctx.readFileState.markStartOnly(filePath)

    // Act — simulate LRU eviction, then validate.
    ctx.readFileState.delete(filePath)
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'x' },
      ctx,
    )

    // Assert — pre-312 this returned errorCode 2 (or passed the guard-skip for
    // newer models); the startOnly set keeps the dedicated refusal alive.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(19)
    expect(result.message).toBe(FILE_START_ONLY_WRITE_MESSAGE)
  })

  test('errorCode 19 is checked BEFORE the not-read branch (ordering proof @249830441)', async () => {
    // Arrange — an entry that trips BOTH branches (isPartialView → the old
    // errorCode-2 path) plus the startOnly mark. Official order:
    // `if(s.readFileState.holdsOnlyStartOf(G))return{…errorCode:19};
    //  let Oe=s.readFileState.get(G);if(!Oe||Oe.isPartialView){…}`.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'both.md')
    await writeFile(filePath, 'content')
    ctx.readFileState.set(filePath, {
      content: 'content',
      timestamp: 0, // stale AND partial → would be errorCode 2/3 pre-312
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    ctx.readFileState.markStartOnly(filePath)

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'x' },
      ctx,
    )

    // Assert — 19 wins over 2.
    expect(result.errorCode).toBe(19)
  })

  test('a later trusted full read clears the refusal (validateInput passes)', async () => {
    // Arrange — the model followed the guidance: one Read call, no offset or
    // limit, whole file. The cache entry is now a trusted full read → Yoe true
    // → holdsOnlyStartOf false.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'reread.md')
    const disk = 'line one\nline two\n'
    await writeFile(filePath, disk)
    ctx.readFileState.markStartOnly(filePath)
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison(disk),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'line one\nline two\nline three\n' },
      ctx,
    )

    // Assert
    expect(result.result).toBe(true)
  })

  test('an entry with contentNotInModelContext:true keeps the refusal', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'flagged.md')
    const disk = 'line one\nline two\n'
    await writeFile(filePath, disk)
    ctx.readFileState.markStartOnly(filePath)
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison(disk),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      contentNotInModelContext: true,
    })

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'x' },
      ctx,
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(19)
  })

  test('a path never marked startOnly keeps the pre-312 behavior (errorCode 2 on partial view)', async () => {
    // Arrange — regression guard: the new branch must not fire without a mark.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'unmarked.md')
    await writeFile(filePath, 'content')
    ctx.readFileState.set(filePath, {
      content: 'content',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'x' },
      ctx,
    )

    // Assert — the generic not-read refusal, unchanged.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
  })

  test('a non-existent file still validates (the official check sits after the ENOENT early-return)', async () => {
    // Arrange — official: `catch(We){if(z(We))return{result:!0};throw We}`
    // runs BEFORE the holdsOnlyStartOf branch, so a brand-new path is never
    // refused with 19 even if somehow marked.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'brand-new.md')
    ctx.readFileState.markStartOnly(filePath)

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'hello' },
      ctx,
    )

    // Assert
    expect(result.result).toBe(true)
  })
})

describe('CC 2.1.312 (item 4) — Write call path throws FileStateError (BX(e7o) @249832895)', () => {
  test('call() on an existing startOnly file throws the e7o FileStateError and writes nothing', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'callpath.md')
    await writeFile(filePath, 'original content')
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison('original content'),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    ctx.readFileState.markStartOnly(filePath)
    // TOCTOU gate (CC 2.1.251): mirror the permission-check stash.
    stashCheckTimeResolutions(ctx as never, filePath, 'write')

    // Act / Assert — official: `if(rt!==null&&lt!==null){if(h.holdsOnlyStartOf(G))
    // throw new BX(e7o);…}` — only when the file exists with readable content.
    await expect(
      FileWriteTool.call(
        { file_path: filePath, content: 'destroyed' } as never,
        ctx as never,
        undefined as never,
        { uuid: 'msg_startonly312' } as never,
      ),
    ).rejects.toThrow(FILE_START_ONLY_WRITE_MESSAGE)

    // Nothing was written.
    expect(await readFile(filePath, 'utf8')).toBe('original content')
  })

  test('call() on a NON-existent startOnly-marked path still creates the file (guard is existence-gated)', async () => {
    // Arrange — `rt!==null&&lt!==null` is false for a missing file, so the
    // call-time throw must not fire.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'new-file.md')
    ctx.readFileState.markStartOnly(filePath)
    stashCheckTimeResolutions(ctx as never, filePath, 'write')

    // Act
    await FileWriteTool.call(
      { file_path: filePath, content: 'created' } as never,
      ctx as never,
      undefined as never,
      { uuid: 'msg_startonly312b' } as never,
    )

    // Assert
    expect(await readFile(filePath, 'utf8')).toBe('created')
  })

  test('FileStateError is the thrown error class (BX ≡ YMe mirror)', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'errclass.md')
    await writeFile(filePath, 'original')
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison('original'),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })
    ctx.readFileState.markStartOnly(filePath)
    stashCheckTimeResolutions(ctx as never, filePath, 'write')

    // Act
    let caught: unknown
    try {
      await FileWriteTool.call(
        { file_path: filePath, content: 'x' } as never,
        ctx as never,
        undefined as never,
        { uuid: 'msg_startonly312c' } as never,
      )
    } catch (e) {
      caught = e
    }

    // Assert
    expect(caught).toBeInstanceOf(FileStateError)
    expect((caught as Error).message).toBe(FILE_START_ONLY_WRITE_MESSAGE)
  })
})

describe('CC 2.1.312 (item 4) — file-change watcher reseed (mt @251734727)', () => {
  test('heldOnlyStart re-seeds the changed entry with contentNotInModelContext:true', () => {
    // Arrange — the watcher read (QS.call) already re-seeded a fresh entry.
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/watched.md'
    cache.set(p, {
      content: 'fresh disk content',
      timestamp: 5,
      offset: undefined,
      limit: undefined,
    })

    // Act — official: `if(ze.isPartialView||mt){…set(Qe,{...qt,…mt&&
    // {contentNotInModelContext:!0}})}` with mt = holdsOnlyStartOf captured
    // BEFORE the read.
    applyChangedFileWatcherReseed(cache, p, {
      priorIsPartialView: false,
      heldOnlyStart: true,
    })

    // Assert — the fresh entry is no longer a trusted full read.
    const reseeded = cache.get(p)
    expect(reseeded?.contentNotInModelContext).toBe(true)
    expect(reseeded?.content).toBe('fresh disk content')
    expect(reseeded?.timestamp).toBe(5)
  })

  test('priorIsPartialView re-seeds the changed entry with isPartialView:true', () => {
    // Arrange
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/watched2.md'
    cache.set(p, {
      content: 'fresh',
      timestamp: 5,
      offset: undefined,
      limit: undefined,
    })

    // Act
    applyChangedFileWatcherReseed(cache, p, {
      priorIsPartialView: true,
      heldOnlyStart: false,
    })

    // Assert
    const reseeded = cache.get(p)
    expect(reseeded?.isPartialView).toBe(true)
    expect(reseeded?.contentNotInModelContext).toBeUndefined()
  })

  test('neither flag → the entry is left untouched', () => {
    // Arrange
    const cache = createFileStateCacheWithSizeLimit(100)
    const p = '/proj/watched3.md'
    const entry = {
      content: 'fresh',
      timestamp: 5,
      offset: undefined,
      limit: undefined,
    }
    cache.set(p, entry)

    // Act
    applyChangedFileWatcherReseed(cache, p, {
      priorIsPartialView: false,
      heldOnlyStart: false,
    })

    // Assert — official `if(ze.isPartialView||mt)` gate: no set() at all.
    expect(cache.get(p)).toBe(entry)
  })

  test('a missing entry is a no-op (official `if(qt)` guard)', () => {
    // Arrange
    const cache = createFileStateCacheWithSizeLimit(100)

    // Act / Assert — must not throw and must not create an entry.
    applyChangedFileWatcherReseed(cache, '/proj/gone.md', {
      priorIsPartialView: true,
      heldOnlyStart: true,
    })
    expect(cache.get('/proj/gone.md')).toBeUndefined()
  })
})

describe('CC 2.1.312 (item 4) — nested head-cut marking site (@251721817)', () => {
  const NESTED_PATH = '/proj/sub/CLAUDE.md'
  const BUDGET = getMemoryCharThreshold(
    getContextWindowForModel('claude-sonnet-4-5'),
  )

  function makeMemoryContext(): ToolUseContext {
    return {
      readFileState: createFileStateCacheWithSizeLimit(100),
      loadedNestedMemoryPaths: new Set<string>(),
      options: { mainLoopModel: 'claude-sonnet-4-5' },
    } as unknown as ToolUseContext
  }

  function makeMemoryFile(
    content: string,
    overrides: Partial<MemoryFileInfo> = {},
  ): MemoryFileInfo {
    return {
      path: NESTED_PATH,
      type: 'Project',
      content,
      ...overrides,
    } as MemoryFileInfo
  }

  function makeOverBudgetContent(marker: string): string {
    const lineCount = Math.ceil((BUDGET + 100) / 11) + 1
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i} end`)
    return [...lines, marker].join('\n')
  }

  test('an over-budget (head-cut) nested memory file is marked startOnly', () => {
    // Arrange — official: `Ae&&k("tengu_quizzical_mango",!0))ze?.markStartOnly(
    // G.path)` — Ae is the cut flag and the gate defaults TRUE.
    const ctx = makeMemoryContext()

    // Act
    memoryFilesToAttachments(
      [makeMemoryFile(makeOverBudgetContent('TAIL-MARKER'))],
      ctx,
    )

    // Assert — marked, and the seeded isPartialView entry is not trusted, so
    // holdsOnlyStartOf fires.
    expect(ctx.readFileState.startOnlyPaths()).toContain(NESTED_PATH)
    expect(ctx.readFileState.holdsOnlyStartOf(NESTED_PATH)).toBe(true)
  })

  test('an under-budget nested memory file is NOT marked startOnly', () => {
    // Arrange — official marks only on Ae (the cut), not on plain seeds.
    const ctx = makeMemoryContext()

    // Act
    memoryFilesToAttachments([makeMemoryFile('# small\n\nbe kind')], ctx)

    // Assert
    expect(ctx.readFileState.startOnlyPaths()).not.toContain(NESTED_PATH)
    expect(ctx.readFileState.holdsOnlyStartOf(NESTED_PATH)).toBe(false)
  })

  test('a contentDiffersFromDisk-only seed (no cut) is NOT marked startOnly', () => {
    // Arrange — official gate is Ae (cut) alone; contentDiffersFromDisk sets
    // isPartialView but does NOT markStartOnly.
    const ctx = makeMemoryContext()

    // Act
    memoryFilesToAttachments(
      [makeMemoryFile('# small', { contentDiffersFromDisk: true })],
      ctx,
    )

    // Assert
    expect(ctx.readFileState.startOnlyPaths()).not.toContain(NESTED_PATH)
    expect(ctx.readFileState.get(NESTED_PATH)?.isPartialView).toBe(true)
  })
})
