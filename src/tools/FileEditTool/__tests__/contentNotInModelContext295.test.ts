import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
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
import { getFileModificationTime } from 'src/utils/file.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FILE_STATE_CURRENT_NOTE } from 'src/utils/permissions/fileStateGuard.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.295 (#088) — Edit must not treat a file as fully read when its
 * contents changed WITHOUT the mtime advancing.
 *
 * Official v295 adds the `!PLe(en,FS(Nt))` disjunct to Edit call()'s
 * contentNotInModelContext expression:
 *   lo = h || no || ao || jt && (!k4(en) || Nn || !PLe(en, FS(Nt)))
 * (h=userModified; no/ao trimmed in OCC; jt=fileExists; en=last read record;
 * Nn=staleRecovered; Nt=pre-write disk content.) The v294 call-time guard
 * only compared mtimes, so a same-mtime content swap kept the post-write
 * record "fully read" — and the mapper kept asserting FILE_STATE_CURRENT_NOTE
 * to the model. v295 requires a content match.
 *
 * These tests pin: (1) frozen-mtime content change → data + record flagged,
 * mapper note suppressed; (2) clean edit → unflagged, note retained;
 * (3) isPartialView carryover through the edit (official v294+v295 set
 * statement spread, previously omitted by OCC).
 */

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
    toolUseId: `toolu_edit295_${toolUseCounter}`,
    abortController: new AbortController(),
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [{ name: FILE_EDIT_TOOL_NAME }, { name: FILE_READ_TOOL_NAME }],
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-edit-088-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function callEdit(
  ctx: ToolUseContext,
  filePath: string,
  oldString: string,
  newString: string,
): Promise<{ data: Record<string, unknown> }> {
  // TOCTOU gate (CC 2.1.251): call() asserts the stashed symlink resolutions
  // are unchanged — mirror the permission-check stash.
  stashCheckTimeResolutions(ctx as never, filePath, 'write')
  return FileEditTool.call(
    {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
    } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_edit088' } as never,
  ) as Promise<{ data: Record<string, unknown> }>
}

/** Freeze the file's mtime back to `timestamp` (ms), simulating a change
 * that did not advance the modification time (#088's core scenario). */
async function freezeMtime(filePath: string, timestamp: number) {
  const when = new Date(timestamp)
  await utimes(filePath, when, when)
}

describe('CC 2.1.295 (#088) — FileEditTool frozen-mtime freshness', () => {
  test('content changed without mtime advancing → record and data flagged, note suppressed', async () => {
    // Arrange — full read seeded, then the file is rewritten behind the
    // model's back and the mtime is frozen back to the recorded value, so
    // the v294-style mtime guard (C8b) sees "fresh" and does not throw.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'frozen.txt')
    const original = 'header\nTARGET_TOKEN\nfooter'
    await writeFile(filePath, original)
    const readAt = getFileModificationTime(filePath)
    ctx.readFileState.set(filePath, {
      content: original,
      timestamp: readAt,
      offset: undefined,
      limit: undefined,
    })
    await writeFile(filePath, 'header\nTARGET_TOKEN\nfooter\nSMUGGLED')
    await freezeMtime(filePath, readAt)

    // Act
    const result = await callEdit(ctx, filePath, 'TARGET_TOKEN', 'REPLACED')

    // Assert — edit applied over content the model never saw.
    expect(await readFile(filePath, 'utf8')).toBe(
      'header\nREPLACED\nfooter\nSMUGGLED',
    )
    expect(result.data.contentNotInModelContext).toBe(true)
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBe(true)
    expect(record?.content).toBe('header\nREPLACED\nfooter\nSMUGGLED')

    // The mapper must NOT claim the file state is current.
    const block = FileEditTool.mapToolResultToToolResultBlockParam(
      result.data as never,
      'toolu_edit088_mapper',
    )
    expect(String(block.content)).not.toContain(FILE_STATE_CURRENT_NOTE)
  })

  test('clean edit over an unchanged full read → no flag, note retained', async () => {
    // Arrange — record matches disk exactly and mtime is frozen at the read.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'clean.txt')
    const original = 'header\nTARGET_TOKEN\nfooter'
    await writeFile(filePath, original)
    ctx.readFileState.set(filePath, {
      content: original,
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    const result = await callEdit(ctx, filePath, 'TARGET_TOKEN', 'REPLACED')

    // Assert
    expect(result.data.contentNotInModelContext).toBeUndefined()
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBeUndefined()
    expect(record?.content).toBe('header\nREPLACED\nfooter')

    const block = FileEditTool.mapToolResultToToolResultBlockParam(
      result.data as never,
      'toolu_edit088_mapper2',
    )
    expect(String(block.content)).toContain(FILE_STATE_CURRENT_NOTE)
  })

  test('isPartialView record carries through the edit and forces the flag', async () => {
    // Arrange — official set statement: `...jt&&en?.isPartialView===!0&&
    // {isPartialView:!0}`. A partial-view record is never a full read (k4
    // false), so the post-write record is flagged AND stays partial.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'partial.txt')
    const original = 'header\nTARGET_TOKEN\nfooter'
    await writeFile(filePath, original)
    ctx.readFileState.set(filePath, {
      content: original,
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
      isPartialView: true,
    })

    // Act
    const result = await callEdit(ctx, filePath, 'TARGET_TOKEN', 'REPLACED')

    // Assert
    expect(result.data.contentNotInModelContext).toBe(true)
    const record = ctx.readFileState.get(filePath)
    expect(record?.isPartialView).toBe(true)
    expect(record?.contentNotInModelContext).toBe(true)
  })

  test('mapper: staleRecovered note takes precedence over flag suppression', async () => {
    // Arrange — official `Y=y?" (note: ...)":s||S?"":hyr`: the stale-recovery
    // disclosure wins; the currency note is suppressed either way.
    const data = {
      filePath: 'f.txt',
      userModified: false,
      replaceAll: false,
      staleRecovered: true,
      contentNotInModelContext: true,
    }

    // Act
    const block = FileEditTool.mapToolResultToToolResultBlockParam(
      data as never,
      'toolu_edit088_mapper3',
    )

    // Assert
    expect(String(block.content)).toContain(
      'the file had been modified on disk since you last read it',
    )
    expect(String(block.content)).not.toContain(FILE_STATE_CURRENT_NOTE)
  })
})
