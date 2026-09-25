import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'

// validateInput's permission path reads MACRO.VERSION transitively.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.281 changelog #040 (security) — null-byte path inputs on the four
 * file tools. Byte-verified call sites in the v281 ELF:
 * - Write        `fy(vn,[["file_path",g]])`      @201120196
 * - Read         `fy(lt,[["file_path",g]])`      @201304178 (FIRST, before
 *                the pages validation)
 * - Edit         `fy(Pt,[["file_path",g]])`      @203959556
 * - NotebookEdit `fy(lc,[["notebook_path",n]])`  @203972885 (FIRST, before
 *                expandPath/resolve and the .ipynb check)
 *
 * Pre-v281 OCC behavior: the `\0` reached `expandPath` (utils/path.ts:49),
 * which THREW — an exception out of validateInput ended the WHOLE turn.
 * v281: per-call validation error, errorCode 2, turn survives. Glob/Grep
 * already had the equivalent inline (left untouched).
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

function makeContext(): ToolUseContext {
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermissionContext(),
  }
  return {
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [],
    },
    readFileState,
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

const NULL_BYTE_PATH = '/tmp/occ\0evil.txt'

function expectedMessage(toolName: string, param: string): string {
  return `${toolName} ${param} cannot contain null bytes (\\0). Remove the null byte and try again.`
}

describe('2.1.281 #040 — file tools reject null-byte paths as validation errors (binary fy call sites)', () => {
  test('Read: null byte in file_path → errorCode 2, no throw (check runs BEFORE pages validation)', async () => {
    // Arrange — a deliberately INVALID pages value proves the null-byte check
    // runs first (official @201304178 order): pages would give errorCode 7.
    const input = { file_path: NULL_BYTE_PATH, pages: 'not-a-range' }

    // Act
    const result = await FileReadTool.validateInput(
      input as never,
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    if (result.result === false) {
      expect(result.message).toBe(expectedMessage('Read', 'file_path'))
    }
  })

  test('Write: null byte in file_path → errorCode 2, no throw', async () => {
    // Arrange
    const input = { file_path: NULL_BYTE_PATH, content: 'x' }

    // Act
    const result = await FileWriteTool.validateInput(
      input as never,
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    if (result.result === false) {
      expect(result.message).toBe(expectedMessage('Write', 'file_path'))
    }
  })

  test('Edit: null byte in file_path → errorCode 2, no throw (before expandPath)', async () => {
    // Arrange
    const input = {
      file_path: NULL_BYTE_PATH,
      old_string: 'a',
      new_string: 'b',
    }

    // Act
    const result = await FileEditTool.validateInput(input as never, makeContext())

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    if (result.result === false) {
      expect(result.message).toBe(expectedMessage('Edit', 'file_path'))
    }
  })

  test('NotebookEdit: null byte in notebook_path → errorCode 2, no throw (before resolve/.ipynb check)', async () => {
    // Arrange — a non-.ipynb name proves the null-byte check precedes the
    // extension check (official @203972885 order: extension gives errorCode 2
    // too, so the message is the discriminator).
    const input = {
      notebook_path: '/tmp/occ\0notebook.txt',
      new_source: 'x',
      edit_mode: 'replace',
    }

    // Act
    const result = await NotebookEditTool.validateInput(
      input as never,
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    if (result.result === false) {
      expect(result.message).toBe(
        expectedMessage('NotebookEdit', 'notebook_path'),
      )
    }
  })

  test('clean paths are unaffected by the new check (no false positives)', async () => {
    // Arrange — Write to a fresh path validates past the null-byte check and
    // fails later only on read-before-write (errorCode 6/9 family), proving
    // the guard did not fire.
    const input = { file_path: '/tmp/occ-clean-281.txt', content: 'x' }

    // Act
    const result = await FileWriteTool.validateInput(
      input as never,
      makeContext(),
    )

    // Assert
    if (result.result === false) {
      expect(result.message).not.toContain('null bytes')
    }
  })
})
