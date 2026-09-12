import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Tool, ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { runWithCwdOverride } from 'src/utils/cwd.js'
import { _clearMatcherCacheForTesting } from 'src/utils/permissions/filesystem.js'
import {
  READ_DENY_EDIT_MESSAGE,
  READ_DENY_WRITE_MESSAGE,
} from 'src/utils/permissions/fileStateGuard.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { runToolUse } from '../toolExecution.js'

// The read-permission check reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx for runtime
// execution). Mirror that polyfill so the permission path works in tests.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code 2.1.269 (OCC-123 E29): FileRead/FileWrite/FileEdit
 * validateInput permission-rule denials gained `deniedByPermissionRule: !0`,
 * and the tool-execution consumer reports flagged failures through
 * `onPermissionDenial` so they also land in the SDK result's
 * `permission_denials`. Binary v269 evidence:
 *
 * 1. Tool deny returns (7 sites), e.g. FileReadTool:
 *    `{result:!1,message:Iit,errorCode:1,deniedByPermissionRule:!0}`
 *    FileEditTool keeps `behavior:"ask"` and adds the flag on both the
 *    Edit-deny (errorCode 2) and Read-deny (errorCode 13) returns;
 *    FileWriteTool adds it on the Edit-deny (1) and Read-deny (13) returns.
 *
 * 2. Consumer (toolExecution):
 *    `we.deniedByPermissionRule){let $n={..._e.data};
 *     e.backfillObservableInput?.($n),s.onPermissionDenial?.(e,n,$n)}`
 *    — the observable input is a COPY of the parsed input, backfilled, and
 *    the callback fires BEFORE the tool_use_error result is returned.
 *
 * Ordering note (why this is a real behavior change): in OCC's
 * checkPermissionsAndCallTool, validateInput runs BEFORE canUseTool, so a
 * validateInput deny short-circuits and never reaches the canUseTool-based
 * denial recorder — `onPermissionDenial` is the sole recorder for this path.
 */

const DENY_MESSAGE =
  'File is in a directory that is denied by your permission settings.'

function makePermissionContext(deny: string[]): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: { userSettings: deny },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeToolContext(permContext: ToolPermissionContext): ToolUseContext {
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [{ name: FILE_EDIT_TOOL_NAME }, { name: FILE_READ_TOOL_NAME }],
    },
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

describe('2.1.269 E29 deniedByPermissionRule — validateInput contract', () => {
  let tmpDir: string
  let secretFile: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-e29-'))
    await mkdir(join(tmpDir, 'secret'))
    await mkdir(join(tmpDir, 'open'))
    secretFile = join(tmpDir, 'secret', 'f.txt')
    await writeFile(secretFile, 'old content\n')
    await writeFile(join(tmpDir, 'open', 'g.txt'), 'open content\n')
    _clearMatcherCacheForTesting()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('FileRead: Read deny rule → errorCode 1 + deniedByPermissionRule', async () => {
    // Arrange
    const ctx = makeToolContext(makePermissionContext(['Read(./secret/**)']))

    // Act — cwd override scopes the relative-rule root to tmpDir (no global
    // state mutation; AsyncLocalStorage-based).
    const result = await runWithCwdOverride(tmpDir, () =>
      FileReadTool.validateInput({ file_path: secretFile } as never, ctx),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    expect(result.message).toBe(DENY_MESSAGE)
    expect(result.deniedByPermissionRule).toBe(true)
  })

  test('FileRead: path outside the deny rule → no flag', async () => {
    // Arrange
    const ctx = makeToolContext(makePermissionContext(['Read(./secret/**)']))
    const openFile = join(tmpDir, 'open', 'g.txt')

    // Act
    const result = await runWithCwdOverride(tmpDir, () =>
      FileReadTool.validateInput({ file_path: openFile } as never, ctx),
    )

    // Assert: validation passes and carries no denial flag
    expect(result.result).toBe(true)
    expect((result as { deniedByPermissionRule?: true }).deniedByPermissionRule).toBeUndefined()
  })

  test('FileWrite: Edit deny rule → errorCode 1 + deniedByPermissionRule', async () => {
    // Arrange
    const ctx = makeToolContext(makePermissionContext(['Edit(./secret/**)']))

    // Act
    const result = await runWithCwdOverride(tmpDir, () =>
      FileWriteTool.validateInput(
        { file_path: join(tmpDir, 'secret', 'new.txt'), content: 'x' },
        ctx,
      ),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    expect(result.message).toBe(DENY_MESSAGE)
    expect(result.deniedByPermissionRule).toBe(true)
  })

  test('FileWrite: Read deny rule covers write → errorCode 13 + flag', async () => {
    // Arrange
    const ctx = makeToolContext(makePermissionContext(['Read(./secret/**)']))

    // Act
    const result = await runWithCwdOverride(tmpDir, () =>
      FileWriteTool.validateInput(
        { file_path: join(tmpDir, 'secret', 'new.txt'), content: 'x' },
        ctx,
      ),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(13)
    expect(result.message).toBe(READ_DENY_WRITE_MESSAGE)
    expect(result.deniedByPermissionRule).toBe(true)
  })

  test('FileEdit: Edit deny rule → behavior ask, errorCode 2 + flag', async () => {
    // Arrange
    const ctx = makeToolContext(makePermissionContext(['Edit(./secret/**)']))

    // Act
    const result = await runWithCwdOverride(tmpDir, () =>
      FileEditTool.validateInput(
        {
          file_path: secretFile,
          old_string: 'old',
          new_string: 'new',
        },
        ctx,
      ),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.behavior).toBe('ask')
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(DENY_MESSAGE)
    expect(result.deniedByPermissionRule).toBe(true)
  })

  test('FileEdit: Read deny rule covers edit → behavior ask, errorCode 13 + flag', async () => {
    // Arrange
    const ctx = makeToolContext(makePermissionContext(['Read(./secret/**)']))

    // Act
    const result = await runWithCwdOverride(tmpDir, () =>
      FileEditTool.validateInput(
        {
          file_path: secretFile,
          old_string: 'old',
          new_string: 'new',
        },
        ctx,
      ),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.behavior).toBe('ask')
    expect(result.errorCode).toBe(13)
    expect(result.message).toBe(READ_DENY_EDIT_MESSAGE)
    expect(result.deniedByPermissionRule).toBe(true)
  })
})

describe('2.1.269 E29 onPermissionDenial — runToolUse consumer', () => {
  type DenialRecord = {
    name: string
    id: string
    input: Record<string, unknown>
  }

  function makeFakeTool(flagged: boolean): Tool {
    return {
      name: 'FakeDenyTool',
      inputSchema: z.object({ file_path: z.string() }),
      validateInput: async () =>
        flagged
          ? {
              result: false,
              message: DENY_MESSAGE,
              errorCode: 1,
              deniedByPermissionRule: true,
            }
          : {
              result: false,
              message: 'plain validation failure',
              errorCode: 9,
            },
      backfillObservableInput: (input: Record<string, unknown>) => {
        input.observed = true
      },
      call: async function* () {
        yield { type: 'text' as const, data: 'unused' }
      },
    } as unknown as Tool
  }

  function makeRunContext(
    tool: Tool,
    denials: DenialRecord[],
  ): ToolUseContext {
    return {
      options: {
        tools: [tool],
        mcpClients: {},
        mainLoopModel: 'claude-opus-5',
      },
      abortController: new AbortController(),
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => ({ ...getDefaultAppState() }),
      onPermissionDenial: (
        t: Tool,
        id: string,
        input: Record<string, unknown>,
      ) => {
        denials.push({ name: t.name, id, input })
      },
    } as unknown as ToolUseContext
  }

  async function driveRunToolUse(
    tool: Tool,
    denials: DenialRecord[],
  ): Promise<{ updates: unknown[]; canUseToolCalls: number }> {
    const ctx = makeRunContext(tool, denials)
    let canUseToolCalls = 0
    const canUseTool = (async () => {
      canUseToolCalls++
      return { behavior: 'allow', updatedInput: {} }
    }) as never
    const assistantMessage = {
      uuid: 'asst-e29',
      message: { id: 'msg_e29', role: 'assistant', content: [] },
    } as never
    const toolUse = {
      id: 'toolu_e29',
      type: 'tool_use',
      name: 'FakeDenyTool',
      input: { file_path: join(tmpdir(), 'occ-e29-target', 'x.txt') },
    } as never

    const updates: unknown[] = []
    for await (const update of runToolUse(
      toolUse,
      assistantMessage,
      canUseTool,
      ctx,
    )) {
      updates.push(update)
    }
    return { updates, canUseToolCalls }
  }

  test('flagged validateInput denial fires onPermissionDenial with backfilled input copy', async () => {
    // Arrange
    const denials: DenialRecord[] = []
    const tool = makeFakeTool(true)

    // Act
    const { updates, canUseToolCalls } = await driveRunToolUse(tool, denials)

    // Assert: recorded exactly once, with tool name, tool_use id, and a
    // backfilled COPY of the parsed input (binary: `$n={..._e.data};
    // e.backfillObservableInput?.($n)`).
    expect(denials.length).toBe(1)
    expect(denials[0].name).toBe('FakeDenyTool')
    expect(denials[0].id).toBe('toolu_e29')
    expect(denials[0].input).toEqual({
      file_path: join(tmpdir(), 'occ-e29-target', 'x.txt'),
      observed: true,
    })
    // validateInput short-circuits BEFORE canUseTool — the official ordering
    // that makes onPermissionDenial the sole recorder for this path.
    expect(canUseToolCalls).toBe(0)
    // The tool_use_error result is still produced.
    expect(updates.length).toBe(1)
    expect(JSON.stringify(updates[0])).toContain('<tool_use_error>')
    expect(JSON.stringify(updates[0])).toContain(DENY_MESSAGE)
  })

  test('unflagged validateInput failure does NOT fire onPermissionDenial', async () => {
    // Arrange
    const denials: DenialRecord[] = []
    const tool = makeFakeTool(false)

    // Act
    const { updates, canUseToolCalls } = await driveRunToolUse(tool, denials)

    // Assert
    expect(denials.length).toBe(0)
    expect(canUseToolCalls).toBe(0)
    expect(updates.length).toBe(1)
    expect(JSON.stringify(updates[0])).toContain('plain validation failure')
  })
})
