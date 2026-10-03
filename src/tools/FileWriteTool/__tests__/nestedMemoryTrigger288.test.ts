import { mkdtemp, readFile, rm } from 'fs/promises'
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
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.288 (#53) — nested-memory trigger on the Write success path.
 *
 * Official v288 aligns the nested-memory trigger with the dynamic-skill-dir
 * trigger wiring: when Write creates or changes a file, the resolved path is
 * added to `context.nestedMemoryAttachmentTriggers` so the end-of-turn drain
 * (`getNestedMemoryAttachments`, attachments.ts) discovers any nested CLAUDE.md
 * / path-scoped rules under that path and injects them. FileReadTool already
 * does this (FileReadTool.ts:1424); this port adds the identical call to the
 * Write success path only — failure paths must NOT add a trigger.
 *
 * The change is a pure call-site addition (no new string literals). These
 * tests pin: (1) a successful create adds the expanded path to the trigger
 * set; (2) a Read-deny-covered write throws before any trigger is recorded.
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
    toolUseId: `toolu_write288_${toolUseCounter}`,
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-write-288-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function callWrite(
  ctx: ToolUseContext,
  filePath: string,
  content: string,
): Promise<unknown> {
  // TOCTOU gate (CC 2.1.251): checkPermissions stashes resolutions before
  // call() asserts they are unchanged. Mirror the permission-check stash.
  stashCheckTimeResolutions(ctx as never, filePath, 'write')
  return FileWriteTool.call(
    { file_path: filePath, content } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_write288' } as never,
  )
}

describe('CC 2.1.288 (#53) — FileWriteTool nested-memory trigger', () => {
  test('a successful create adds the expanded path to nestedMemoryAttachmentTriggers', async () => {
    // Arrange
    const ctx = makeContext(makePermissionContext())
    const filePath = join(tmpDir, 'created.txt')
    const triggers = ctx.nestedMemoryAttachmentTriggers as Set<string>
    expect(triggers.size).toBe(0)

    // Act
    await callWrite(ctx, filePath, 'hello world')

    // Assert — the file landed on disk and the trigger was recorded.
    expect(await readFile(filePath, 'utf8')).toBe('hello world')
    expect(triggers.has(filePath)).toBe(true)
    expect(triggers.size).toBe(1)
  })

  test('a successful overwrite of an existing (pre-read) file also records the trigger', async () => {
    // Arrange — Write over an existing file requires a prior read for the
    // staleness guard; seed readFileState so the guard sees current content.
    const ctx = makeContext(makePermissionContext())
    const filePath = join(tmpDir, 'existing.txt')
    const { writeFile } = await import('fs/promises')
    await writeFile(filePath, 'old content')
    const { getFileModificationTime } = await import('src/utils/file.js')
    const { normalizeForComparison } = await import(
      'src/utils/permissions/fileStateGuard.js'
    )
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison('old content'),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })
    const triggers = ctx.nestedMemoryAttachmentTriggers as Set<string>

    // Act
    await callWrite(ctx, filePath, 'new content')

    // Assert
    expect(await readFile(filePath, 'utf8')).toBe('new content')
    expect(triggers.has(filePath)).toBe(true)
  })

  test('a Read-deny-covered write throws and records NO trigger (failure path)', async () => {
    // Arrange — a bare `Read` deny rule makes the path read-denied; Write's
    // call-time guard (cVt) throws before any success-path side effect.
    const ctx = makeContext(makePermissionContext({ deny: ['Read'] }))
    const filePath = join(tmpDir, 'denied.txt')
    const triggers = ctx.nestedMemoryAttachmentTriggers as Set<string>

    // Act / Assert
    await expect(callWrite(ctx, filePath, 'nope')).rejects.toThrow()
    expect(triggers.size).toBe(0)
  })
})
