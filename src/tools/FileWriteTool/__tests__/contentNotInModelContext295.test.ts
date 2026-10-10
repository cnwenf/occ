import { mkdtemp, rm, writeFile } from 'fs/promises'
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
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.295 (#088) complementary plumbing — Write's set statement.
 *
 * Official set statement is IDENTICAL in v294 and v295:
 *   h.set(G,{content:vg(n),timestamp:qt,offset:void 0,limit:void 0,
 *     ...(y||Gt)&&{contentNotInModelContext:!0}})
 * y = userModified (the user edited the proposed content at the permission
 * prompt), Gt = memory-dir-stamped write (a trimmed OCC surface). OCC
 * previously stored no flag here, so a user-modified Write record still
 * counted as fully read for the 2.1.295 k4 consumers (the sed path,
 * NotebookEdit, and subsequent Edits).
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

function makeContext(userModified?: boolean): ToolUseContext {
  toolUseCounter += 1
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermissionContext(),
  }
  return {
    toolUseId: `toolu_write295_${toolUseCounter}`,
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
    ...(userModified !== undefined && { userModified }),
  } as unknown as ToolUseContext
}

let tmpDir: string
let savedCheckpointEnv: string | undefined
let savedSimpleEnv: string | undefined

beforeAll(() => {
  savedCheckpointEnv = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-write-088-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function callWrite(
  ctx: ToolUseContext,
  filePath: string,
  content: string,
): Promise<void> {
  stashCheckTimeResolutions(ctx as never, filePath, 'write')
  await FileWriteTool.call(
    { file_path: filePath, content } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_write088' } as never,
  )
}

describe('CC 2.1.295 (#088) — Write userModified flag plumbing', () => {
  test('user-modified write marks the record contentNotInModelContext', async () => {
    // Arrange — existing file with a matching full-read record so the
    // call-time freshness guard passes.
    const ctx = makeContext(true)
    const filePath = join(tmpDir, 'w.txt')
    await writeFile(filePath, 'old\n')
    ctx.readFileState.set(filePath, {
      content: 'old\n',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    await callWrite(ctx, filePath, 'new\n')

    // Assert — the model never saw the user's final content.
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBe(true)
    expect(record?.content).toBe('new\n')
  })

  test('unmodified write leaves the record unflagged', async () => {
    // Arrange
    const ctx = makeContext(false)
    const filePath = join(tmpDir, 'w2.txt')
    await writeFile(filePath, 'old\n')
    ctx.readFileState.set(filePath, {
      content: 'old\n',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    await callWrite(ctx, filePath, 'new\n')

    // Assert
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBeUndefined()
    expect(record?.content).toBe('new\n')
  })

  test('new-file write without userModified leaves the record unflagged', async () => {
    // Arrange — brand-new file, no prior record (Write allows create).
    const ctx = makeContext()
    const filePath = join(tmpDir, 'fresh.txt')

    // Act
    await callWrite(ctx, filePath, 'created\n')

    // Assert
    const record = ctx.readFileState.get(filePath)
    expect(record).toBeDefined()
    expect(record?.contentNotInModelContext).toBeUndefined()
  })
})
