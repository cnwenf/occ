import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { getFileModificationTime } from 'src/utils/file.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { normalizeForComparison } from 'src/utils/permissions/fileStateGuard.js'
import { NOT_UTF8_REFUSAL_MESSAGE } from 'src/utils/utf8Safety.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'

// Transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.296 (aen) — changelog: "Fixed Edit and NotebookEdit replacing every
 * non-ASCII character in files that are not valid UTF-8 …; such edits are now
 * refused."
 *
 * NotebookEditTool.validateInput reads content via readFileSyncWithMetadata (a
 * string, not bytes), so the guard adds a raw-byte read before it (errorCode
 * 12) and refuses verbatim when the bytes are not valid UTF-8. It sits after
 * the not-read (errorCode 9) and stale (errorCode 10) guards, so a prior Read
 * must be seeded to reach it. utf16le (FF FE BOM) is exempt.
 */

// GBK bytes for "中文" — invalid UTF-8 (see the FileEditTool 296 test).
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])

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

function makeContext(permContext: ToolPermissionContext): ToolUseContext {
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [
        { name: NOTEBOOK_EDIT_TOOL_NAME },
        { name: FILE_READ_TOOL_NAME },
      ],
    },
    readFileState,
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

describe('2.1.296 (aen) — NotebookEdit refuses non-UTF-8 notebooks verbatim', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-nbedit-utf8-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('GBK-bytes .ipynb → refused with the verbatim aen message, nothing written', async () => {
    // Arrange — a non-UTF-8 file with a .ipynb extension. The aen guard fires
    // before the JSON parse, so the (invalid) notebook body is never reached.
    const filePath = join(tmpDir, 'gbk.ipynb')
    await writeFile(filePath, GBK_BYTES)
    const ctx = makeContext(makePermissionContext())
    // Seed a prior Read so the not-read (errorCode 9) guard passes and the
    // stale check (mtime === timestamp) does not fire.
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison(GBK_BYTES.toString('utf8')),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })
    const before = await readFile(filePath)

    // Act
    const result = await NotebookEditTool.validateInput(
      {
        notebook_path: filePath,
        edit_mode: 'insert',
        cell_type: 'code',
        new_source: 'print("hi")',
      },
      ctx,
    )

    // Assert — hard refusal (errorCode 12), exact message, disk untouched.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(12)
    expect(result.message).toBe(NOT_UTF8_REFUSAL_MESSAGE)
    expect(await readFile(filePath)).toEqual(before)
  })

  test('valid UTF-8 .ipynb is NOT refused by the aen guard', async () => {
    // Arrange — a real (minimal) notebook with multibyte UTF-8 in a cell.
    const filePath = join(tmpDir, 'ok.ipynb')
    const notebook = {
      cells: [
        {
          cell_type: 'code',
          id: 'cell-1',
          metadata: {},
          execution_count: null,
          outputs: [],
          source: ['café 日本語\n'],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }
    const content = JSON.stringify(notebook)
    await writeFile(filePath, content, 'utf8')
    const ctx = makeContext(makePermissionContext())
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison(content),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    const result = await NotebookEditTool.validateInput(
      {
        notebook_path: filePath,
        edit_mode: 'replace',
        cell_id: 'cell-1',
        new_source: 'print("edited")',
      },
      ctx,
    )

    // Assert — specifically not the aen refusal.
    expect(result.errorCode).not.toBe(12)
    expect(result.message).not.toBe(NOT_UTF8_REFUSAL_MESSAGE)
  })
})
