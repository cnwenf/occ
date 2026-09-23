import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { runToolUse } from '../toolExecution.js'

// The tool-execution chain reads MACRO.VERSION transitively (analytics).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code v2.1.280 changelog entry #008 — the result-note wiring
 * in the tool-execution pipeline. Byte-verified against the v280 linux-x64 ELF:
 *
 * - @199195169 `CYn`: `ve=e.coerceInputBeforePluginHooks&&!ROe(r)?{repair:
 *   e.coerceInput?.(r)??null}:void 0` — with the flag set, coercion runs
 *   BEFORE the plugin hooks and the COERCED input `xe` is what the hooks and
 *   the permission stage observe (`COn(e.name,n,xe)`). OCC's single parse
 *   site is already upstream of runPreToolUseHooks/canUseTool, so the
 *   ordering contract holds structurally (asserted via source-grep below).
 * - @199201035 `PYn`: `Le=$e.coerced?.resultNote` — bound only AFTER the
 *   parse succeeds.
 * - @199218504 `Wr` (addToolResult equivalent):
 *   `Hl=[Le!==void 0&&!gi.is_error&&typeof gi.content==="string"?{...gi,
 *   content:`${gi.content}\n\n${Le}`}:gi]` — the note is appended to
 *   NON-ERROR STRING tool-result content with a `\n\n` separator (two
 *   newlines — the port brief's "two-space separator" is contradicted by the
 *   binary bytes; the binary wins).
 */
const NOTE_PREFIX =
  "Note: Write's parameters are named `file_path` and `content`. "

type ResultVariant = 'string' | 'error' | 'array'

function makeFakeWriteTool(variant: ResultVariant): Tool {
  return {
    name: 'FakeWriteCoerce280',
    maxResultSizeChars: 100_000,
    inputSchema: z.strictObject({
      file_path: z.string(),
      content: z.string(),
    }),
    coerceInputBeforePluginHooks: true,
    // Delegate to the REAL Write coercion so the note text flowing through the
    // pipeline is the official one.
    coerceInput: (input: unknown) => FileWriteTool.coerceInput!(input),
    call: async () => ({ data: 'WROTE' }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => {
      if (variant === 'error') {
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUseID,
          content: 'boom',
          is_error: true,
        }
      }
      if (variant === 'array') {
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUseID,
          content: [{ type: 'text' as const, text: String(data) }],
        }
      }
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: String(data),
      }
    },
  } as unknown as Tool
}

function makeRunContext(tool: Tool): ToolUseContext {
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
  } as unknown as ToolUseContext
}

type DriveResult = {
  updates: { message: { message?: { content?: unknown } } }[]
  permissionInputs: unknown[]
}

async function driveRunToolUse(
  tool: Tool,
  input: Record<string, unknown>,
): Promise<DriveResult> {
  const ctx = makeRunContext(tool)
  const permissionInputs: unknown[] = []
  const canUseTool = (async (
    _t: Tool,
    seenInput: Record<string, unknown>,
  ) => {
    permissionInputs.push(seenInput)
    return { behavior: 'allow', updatedInput: seenInput }
  }) as never
  const assistantMessage = {
    uuid: 'asst-280',
    message: { id: 'msg_280', role: 'assistant', content: [] },
  } as never
  const toolUse = {
    id: 'toolu_280',
    type: 'tool_use',
    name: tool.name,
    input,
  } as never

  const updates: DriveResult['updates'] = []
  for await (const update of runToolUse(
    toolUse,
    assistantMessage,
    canUseTool,
    ctx,
  )) {
    updates.push(update as never)
  }
  return { updates, permissionInputs }
}

function findToolResultBlock(
  updates: DriveResult['updates'],
): Record<string, unknown> | undefined {
  for (const update of updates) {
    const content = update.message?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'tool_result') return block
    }
  }
  return undefined
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('2.1.280 #008 — coerceInputBeforePluginHooks ordering (pipeline)', () => {
  test('misnamed params: permission/hook stage observes the COERCED input', async () => {
    // Arrange — official `CYn` feeds the coerced `xe` into the hook input;
    // OCC's canUseTool (downstream of runPreToolUseHooks, same processedInput)
    // is the observable proxy.
    const tool = makeFakeWriteTool('string')

    // Act
    const { permissionInputs } = await driveRunToolUse(tool, {
      path: '/abs/f.txt',
      file_text: 'hello',
    })

    // Assert — the pre-coercion input had `path`/`file_text`; the stage sees
    // the canonical shape.
    expect(permissionInputs.length).toBe(1)
    expect(permissionInputs[0]).toEqual({
      file_path: '/abs/f.txt',
      content: 'hello',
    })
  })

  test('coercion site precedes runPreToolUseHooks in toolExecution (source ordering)', async () => {
    // Arrange — OCC has no injectable-hook test seam, so the ordering contract
    // is asserted structurally (the repo's established source-grep convention,
    // cf. version-2.1.169-taskcreate-autorepair.e2e.test.ts H13a+b).
    const src = await Bun.file(
      'src/services/tools/toolExecution.ts',
    ).text()

    // Act
    const coerceIdx = src.indexOf('tool.coerceInput?.(input)')
    const hooksIdx = src.indexOf('for await (const result of runPreToolUseHooks(')
    const parsedIdx = src.indexOf('let processedInput = parsedInput.data')

    // Assert — coerce → parse → hooks, and the hook input derives from the
    // coerced parse.
    expect(coerceIdx).toBeGreaterThan(-1)
    expect(hooksIdx).toBeGreaterThan(-1)
    expect(parsedIdx).toBeGreaterThan(-1)
    expect(coerceIdx).toBeLessThan(hooksIdx)
    expect(parsedIdx).toBeLessThan(hooksIdx)
    // The note is bound only after a successful parse (official `Le` sits
    // after the parse-success gate in `PYn`).
    expect(src).toContain(
      'const coercedResultNote = parsedInput.success',
    )
    // The append guard mirrors the binary byte-for-byte in structure:
    // `Le!==void 0&&!gi.is_error&&typeof gi.content==="string"`.
    expect(src).toContain('coercedResultNote !== undefined')
    expect(src).toContain('!mappedBlock.is_error')
    expect(src).toContain("typeof mappedBlock.content === 'string'")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text of the template in toolExecution.ts under source-grep, not a JS template placeholder.
    expect(src).toContain('${mappedBlock.content}\\n\\n${coercedResultNote}')
  })
})

describe('2.1.280 #008 — result note appended via addToolResult', () => {
  test('coerced call: note appended exactly once with the official text and \\n\\n separator', async () => {
    // Arrange
    const tool = makeFakeWriteTool('string')
    const expectedNote = `${NOTE_PREFIX}\`path\` was read as \`file_path\`. \`file_text\` was read as \`content\`.`

    // Act
    const { updates } = await driveRunToolUse(tool, {
      path: '/abs/f.txt',
      file_text: 'hello',
    })

    // Assert
    const block = findToolResultBlock(updates)
    expect(block).toBeDefined()
    expect(block!.is_error).toBeFalsy()
    expect(block!.content).toBe(`WROTE\n\n${expectedNote}`)
    expect(
      countOccurrences(String(block!.content), "Note: Write's parameters"),
    ).toBe(1)
  })

  test('canonical input (no coercion): result carries NO note', async () => {
    // Arrange
    const tool = makeFakeWriteTool('string')

    // Act
    const { updates } = await driveRunToolUse(tool, {
      file_path: '/abs/f.txt',
      content: 'hello',
    })

    // Assert
    const block = findToolResultBlock(updates)
    expect(block).toBeDefined()
    expect(block!.content).toBe('WROTE')
  })

  test('error result (is_error): NO note appended (binary `!gi.is_error` guard)', async () => {
    // Arrange
    const tool = makeFakeWriteTool('error')

    // Act
    const { updates } = await driveRunToolUse(tool, {
      path: '/abs/f.txt',
      file_text: 'hello',
    })

    // Assert
    const block = findToolResultBlock(updates)
    expect(block).toBeDefined()
    expect(block!.is_error).toBe(true)
    expect(block!.content).toBe('boom')
  })

  test('non-string result content: block passes through unchanged (binary typeof guard)', async () => {
    // Arrange
    const tool = makeFakeWriteTool('array')

    // Act
    const { updates } = await driveRunToolUse(tool, {
      path: '/abs/f.txt',
      file_text: 'hello',
    })

    // Assert
    const block = findToolResultBlock(updates)
    expect(block).toBeDefined()
    expect(Array.isArray(block!.content)).toBe(true)
    expect(JSON.stringify(block!.content)).not.toContain('Note:')
  })

  test('unrepairable misnamed input: InputValidationError, NO note (parse fails before Le binds)', async () => {
    // Arrange — file_text alone: bZe repairs to {content} but the schema still
    // lacks file_path, so the tool-level guard nulls the repair and the
    // ORIGINAL input fails validation.
    const tool = makeFakeWriteTool('string')

    // Act
    const { updates } = await driveRunToolUse(tool, { file_text: 'hello' })

    // Assert
    const block = findToolResultBlock(updates)
    expect(block).toBeDefined()
    expect(block!.is_error).toBe(true)
    const text = String(block!.content)
    expect(text).toContain('<tool_use_error>')
    expect(text).toContain('InputValidationError')
    expect(text).not.toContain("Note: Write's parameters")
  })
})
