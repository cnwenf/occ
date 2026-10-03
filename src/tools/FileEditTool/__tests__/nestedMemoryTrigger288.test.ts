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
import { getFileModificationTime } from 'src/utils/file.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'

// The read-permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx). Mirror it.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.288 (#53) — nested-memory trigger on the Edit success path.
 *
 * Mirror of the FileWriteTool port: when Edit changes a file, the resolved
 * path is added to `toolUseContext.nestedMemoryAttachmentTriggers` so the
 * end-of-turn drain discovers nested CLAUDE.md / path-scoped rules under it.
 * FileReadTool.ts:1424 is the reference shape. Failure paths (Read-deny)
 * throw before any trigger is recorded.
 *
 * Pure call-site addition (no new string literals).
 */

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

let toolUseCounter = 0

function makeContext(permContext: ToolPermissionContext): ToolUseContext {
  toolUseCounter += 1
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    toolUseId: `toolu_edit288_${toolUseCounter}`,
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-edit-288-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function callEdit(
  ctx: ToolUseContext,
  filePath: string,
  oldString: string,
  newString: string,
): Promise<unknown> {
  stashCheckTimeResolutions(ctx as never, filePath, 'write')
  return FileEditTool.call(
    {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
    } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_edit288' } as never,
  )
}

describe('CC 2.1.288 (#53) — FileEditTool nested-memory trigger', () => {
  test('a successful edit adds the expanded path to nestedMemoryAttachmentTriggers', async () => {
    // Arrange — Edit requires a prior read; seed readFileState with the exact
    // disk content and current mtime so the call-time guard (C8b) passes.
    const ctx = makeContext(makePermissionContext())
    const filePath = join(tmpDir, 'target.txt')
    await writeFile(filePath, 'header\nTARGET_TOKEN\nfooter')
    ctx.readFileState.set(filePath, {
      content: 'header\nTARGET_TOKEN\nfooter',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })
    const triggers = ctx.nestedMemoryAttachmentTriggers as Set<string>
    expect(triggers.size).toBe(0)

    // Act
    await callEdit(ctx, filePath, 'TARGET_TOKEN', 'REPLACED')

    // Assert — the edit landed and the trigger was recorded.
    expect(await readFile(filePath, 'utf8')).toBe('header\nREPLACED\nfooter')
    expect(triggers.has(filePath)).toBe(true)
    expect(triggers.size).toBe(1)
  })

  test('a Read-deny-covered edit throws and records NO trigger (failure path)', async () => {
    // Arrange
    const ctx = makeContext(makePermissionContext({ deny: ['Read'] }))
    const filePath = join(tmpDir, 'denied.txt')
    await writeFile(filePath, 'header\nTARGET_TOKEN\nfooter')
    ctx.readFileState.set(filePath, {
      content: 'header\nTARGET_TOKEN\nfooter',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })
    const triggers = ctx.nestedMemoryAttachmentTriggers as Set<string>

    // Act / Assert
    await expect(
      callEdit(ctx, filePath, 'TARGET_TOKEN', 'REPLACED'),
    ).rejects.toThrow()
    expect(triggers.size).toBe(0)
  })
})
