import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from 'src/Tool.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { getFileModificationTime } from 'src/utils/file.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import {
  checkEditWouldApply,
  isStaleReadRecoverable,
} from 'src/tools/FileEditTool/utils.js'

/**
 * claude-code 2.1.208 #13: Edit no longer fail-stales when the file changed
 * after Read but the target text still matches uniquely. Tests cover the
 * wouldHaveResult classifier, the recovery guard, and the end-to-end
 * validateInput stale-read branch.
 */

describe('2.1.208 #13 checkEditWouldApply (wouldHaveResult classifier)', () => {
  test('returns "applies" when old_string is uniquely present', () => {
    // Arrange
    const content = 'alpha\nTARGET\nbeta'
    // Act
    const result = checkEditWouldApply(content, 'TARGET', false)
    // Assert
    expect(result).toBe('applies')
  })

  test('returns "no_match" when old_string is empty', () => {
    expect(checkEditWouldApply('some content', '', false)).toBe('no_match')
  })

  test('returns "no_match" when old_string is absent', () => {
    expect(checkEditWouldApply('alpha\nbeta', 'TARGET', false)).toBe('no_match')
  })

  test('returns "ambiguous" when multiple matches and replace_all is false', () => {
    // Arrange
    const content = 'TARGET\nother\nTARGET'
    // Act
    const result = checkEditWouldApply(content, 'TARGET', false)
    // Assert
    expect(result).toBe('ambiguous')
  })

  test('returns "applies" for multiple matches when replace_all is true', () => {
    const content = 'TARGET\nother\nTARGET'
    expect(checkEditWouldApply(content, 'TARGET', true)).toBe('applies')
  })
})

describe('2.1.208 #13 isStaleReadRecoverable', () => {
  function makeContext(tools: { name: string }[]): ToolUseContext {
    const appState = {
      ...getDefaultAppState(),
      toolPermissionContext: getEmptyToolPermissionContext(),
    }
    return {
      options: { tools: tools as never },
      readFileState: createFileStateCacheWithSizeLimit(100),
      getAppState: () => appState,
    } as unknown as ToolUseContext
  }

  test('recoverable when the Read tool is present and no deny rule', () => {
    // Arrange
    const ctx = makeContext([{ name: FILE_READ_TOOL_NAME }])
    // Act
    const result = isStaleReadRecoverable('/proj/file.txt', ctx)
    // Assert
    expect(result).toBe(true)
  })

  test('not recoverable when the Read tool is absent', () => {
    const ctx = makeContext([{ name: 'Edit' }])
    expect(isStaleReadRecoverable('/proj/file.txt', ctx)).toBe(false)
  })
})

describe('2.1.208 #13 FileEditTool.validateInput stale-read recovery', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-edit-stale-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  function makeContext(tools: { name: string }[]): ToolUseContext {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const appState = {
      ...getDefaultAppState(),
      toolPermissionContext: getEmptyToolPermissionContext(),
    }
    return {
      options: { tools: tools as never },
      readFileState,
      getAppState: () => appState,
    } as unknown as ToolUseContext
  }

  test('succeeds when file modified after read but target still unique', async () => {
    // Arrange: a file with a unique target line and a separate region.
    const filePath = join(tmpDir, 'edit.txt')
    const oldContent = 'header line\nTARGET_UNIQUE_TOKEN\nfooter line'
    await writeFile(filePath, oldContent)
    const readAt = getFileModificationTime(filePath)
    // Simulate a prior full Read of the file.
    const ctx = makeContext([{ name: FILE_READ_TOOL_NAME }])
    ctx.readFileState.set(filePath, {
      content: oldContent,
      timestamp: readAt,
      offset: undefined,
      limit: undefined,
    })
    // Externally modify a DIFFERENT region (target still present, uniquely).
    await new Promise(r => setTimeout(r, 20))
    await writeFile(filePath, 'header line CHANGED\nTARGET_UNIQUE_TOKEN\nfooter line')

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'TARGET_UNIQUE_TOKEN', new_string: 'REPLACED' },
      ctx,
    )

    // Assert: recovered (not stale-failed).
    expect(result.result).toBe(true)
  })

  test('fails stale (errorCode 7) when the target was removed after read', async () => {
    // Arrange
    const filePath = join(tmpDir, 'edit-gone.txt')
    const oldContent = 'header\nTARGET_UNIQUE_TOKEN\nfooter'
    await writeFile(filePath, oldContent)
    const readAt = getFileModificationTime(filePath)
    const ctx = makeContext([{ name: FILE_READ_TOOL_NAME }])
    ctx.readFileState.set(filePath, {
      content: oldContent,
      timestamp: readAt,
      offset: undefined,
      limit: undefined,
    })
    // Externally modify so the target is gone.
    await new Promise(r => setTimeout(r, 20))
    await writeFile(filePath, 'header\nNO_TARGET_HERE\nfooter')

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'TARGET_UNIQUE_TOKEN', new_string: 'REPLACED' },
      ctx,
    )

    // Assert: not recovered (target absent) → stale-read error.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(7)
  })

  test('fails stale (errorCode 7) when target unique but Read tool absent', async () => {
    // Arrange
    const filePath = join(tmpDir, 'edit-noread.txt')
    const oldContent = 'header\nTARGET_UNIQUE_TOKEN\nfooter'
    await writeFile(filePath, oldContent)
    const readAt = getFileModificationTime(filePath)
    const ctx = makeContext([{ name: 'Edit' }]) // no Read tool
    ctx.readFileState.set(filePath, {
      content: oldContent,
      timestamp: readAt,
      offset: undefined,
      limit: undefined,
    })
    await new Promise(r => setTimeout(r, 20))
    await writeFile(filePath, 'header CHANGED\nTARGET_UNIQUE_TOKEN\nfooter')

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'TARGET_UNIQUE_TOKEN', new_string: 'REPLACED' },
      ctx,
    )

    // Assert: target still unique, but recovery guard fails (no Read tool).
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(7)
  })
})
