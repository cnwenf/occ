import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../fileStateCache.js'
import type { MemoryFileInfo } from '../claudemd.js'

/**
 * CC 2.1.288 (#61) — the file-access InstructionsLoaded emit site threads the
 * subagent identity through to the hook.
 *
 * `memoryFilesToAttachments` (attachments.ts) is the lazy/file-access load
 * path: when a tool touches a file that triggers a nested CLAUDE.md or a
 * path-scoped rule, it produces the `nested_memory` attachment AND fires the
 * InstructionsLoaded hook. v288 passes {agentId, agentType} from the tool use
 * context into `executeInstructionsLoadedHooks` so the hook input can carry
 * the subagent identity (main-thread loads pass undefined for both).
 *
 * The drain itself (`getNestedMemoryAttachments`) is pre-existing and shared
 * with the Read path; this test asserts the attachment is produced (drain
 * seam) and that the emit site threads agentInfo.
 */

// --- Mock seams (OCC-97: mock.module leaks across files in the same worker —
// spread the real module, override narrowly, restore in afterAll). ---
const actualHooks = await import('../hooks.js')
const capturedCalls: any[][] = []
const executeInstructionsLoadedHooksSpy = mock(
  async (...args: any[]): Promise<void> => {
    capturedCalls.push(args)
  },
)
mock.module('../hooks.js', () => ({
  ...actualHooks,
  hasInstructionsLoadedHook: () => true,
  executeInstructionsLoadedHooks: executeInstructionsLoadedHooksSpy,
}))

afterAll(() => {
  mock.module('../hooks.js', () => ({ ...actualHooks }))
})

const { memoryFilesToAttachments } = await import('../attachments.js')

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-instr-agentinfo-288-'))
  capturedCalls.length = 0
  executeInstructionsLoadedHooksSpy.mockClear()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeContext(
  opts: { agentId?: string; agentType?: string } = {},
): ToolUseContext {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    loadedNestedMemoryPaths: new Set<string>(),
    agentId: opts.agentId,
    agentType: opts.agentType,
  } as unknown as ToolUseContext
}

function makeMemoryFile(path: string): MemoryFileInfo {
  return {
    path,
    type: 'Project',
    content: '# nested rules',
  } as MemoryFileInfo
}

describe('CC 2.1.288 (#61) — memoryFilesToAttachments threads agentInfo', () => {
  test('subagent file-access load produces a nested_memory attachment and threads {agentId, agentType}', () => {
    // Arrange
    const memoryPath = join(tmpDir, 'CLAUDE.md')
    const triggerPath = join(tmpDir, 'src', 'feature.ts')
    const ctx = makeContext({
      agentId: 'agent_123',
      agentType: 'code-reviewer',
    })

    // Act
    const attachments = memoryFilesToAttachments(
      [makeMemoryFile(memoryPath)],
      ctx,
      triggerPath,
    )

    // Assert — drain seam: the nested_memory attachment is produced.
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.type).toBe('nested_memory')

    // Assert — the emit site fired the hook with the subagent identity.
    expect(executeInstructionsLoadedHooksSpy).toHaveBeenCalledTimes(1)
    const args = capturedCalls[0]!
    expect(args[0]).toBe(memoryPath)
    expect(args[1]).toBe('Project')
    expect(args[2]).toBe('nested_traversal')
    expect(args[3]).toMatchObject({
      triggerFilePath: triggerPath,
      agentInfo: { agentId: 'agent_123', agentType: 'code-reviewer' },
    })
  })

  test('main-agent file-access load threads undefined agent identity', () => {
    // Arrange
    const memoryPath = join(tmpDir, 'CLAUDE.md')
    const ctx = makeContext()

    // Act
    memoryFilesToAttachments([makeMemoryFile(memoryPath)], ctx, undefined)

    // Assert
    expect(executeInstructionsLoadedHooksSpy).toHaveBeenCalledTimes(1)
    const options = capturedCalls[0]![3]
    expect(options.agentInfo).toEqual({
      agentId: undefined,
      agentType: undefined,
    })
  })
})
