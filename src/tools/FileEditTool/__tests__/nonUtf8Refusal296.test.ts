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
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'

// The read-permission path transitively reads MACRO.VERSION (build-time
// constant polyfilled in cli.tsx). Mirror the repo-convention polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.296 (aen) — changelog: "Fixed Edit and NotebookEdit replacing every
 * non-ASCII character in files that are not valid UTF-8 (Windows-1252,
 * Shift-JIS, GBK); such edits are now refused."
 *
 * Official evidence (/tmp/cc296/ev-utf8.txt): the `aen` constant is declared
 * beside the Edit not-read / stale / deny messages and `C8` (FileStateError).
 * FileEditTool.validateInput reads the target as bytes, so the guard sits
 * right after that read (errorCode 14) and fires before the not-exist /
 * not-read / stale / match branches — nothing is written.
 *
 * utf16le (FF FE BOM) is exempt: OCC round-trips such files losslessly, so the
 * message premise ("saves the whole file as UTF-8") does not hold for them.
 */

// GBK bytes for "中文" — 0xD6 0xD0 0xCE 0xC4. 0xD6/0xCE are 2-byte UTF-8 leads
// but their followers (0xD0/0xC4) are leads, not continuations → invalid UTF-8.
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
// Windows-1252 / latin1 bytes for "café" — the trailing 0xE9 is a 3-byte UTF-8
// lead with no continuations → invalid UTF-8.
const LATIN1_BYTES = Buffer.from([0x63, 0x61, 0x66, 0xe9])

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
      tools: [{ name: FILE_EDIT_TOOL_NAME }, { name: FILE_READ_TOOL_NAME }],
    },
    readFileState,
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

function seedRead(
  ctx: ToolUseContext,
  filePath: string,
  rawBytes: Buffer,
): void {
  // The changelog scenario: the model Read the file first (Read shows U+FFFD
  // for the undecodable bytes), then Edit refuses to re-save it as UTF-8.
  ctx.readFileState.set(filePath, {
    content: normalizeForComparison(rawBytes.toString('utf8')),
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
}

describe('2.1.296 (aen) — Edit refuses non-UTF-8 files verbatim', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-edit-utf8-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('GBK-bytes file → refused with the verbatim aen message, nothing written', async () => {
    // Arrange
    const filePath = join(tmpDir, 'gbk.txt')
    await writeFile(filePath, GBK_BYTES)
    const ctx = makeContext(makePermissionContext())
    seedRead(ctx, filePath, GBK_BYTES)
    const before = await readFile(filePath)

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'x', new_string: 'y' },
      ctx,
    )

    // Assert — hard refusal (errorCode 14), exact message, disk untouched.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(14)
    expect(result.message).toBe(NOT_UTF8_REFUSAL_MESSAGE)
    expect(await readFile(filePath)).toEqual(before)
  })

  test('latin1/Windows-1252-bytes file → refused with the verbatim aen message', async () => {
    // Arrange
    const filePath = join(tmpDir, 'latin1.txt')
    await writeFile(filePath, LATIN1_BYTES)
    const ctx = makeContext(makePermissionContext())
    seedRead(ctx, filePath, LATIN1_BYTES)
    const before = await readFile(filePath)

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'caf', new_string: 'tea' },
      ctx,
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(14)
    expect(result.message).toBe(NOT_UTF8_REFUSAL_MESSAGE)
    expect(await readFile(filePath)).toEqual(before)
  })

  test('aen wins even without a prior Read (fires before the not-read guard)', async () => {
    // Arrange — no readFileState seed: the aen check precedes the not-read
    // branch (errorCode 6), so the UTF-8 refusal is what surfaces.
    const filePath = join(tmpDir, 'unread-gbk.txt')
    await writeFile(filePath, GBK_BYTES)
    const ctx = makeContext(makePermissionContext())

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'x', new_string: 'y' },
      ctx,
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(14)
    expect(result.message).toBe(NOT_UTF8_REFUSAL_MESSAGE)
  })

  test('valid UTF-8 file with non-ASCII (café / 日本語) is NOT refused', async () => {
    // Arrange — genuinely valid UTF-8 with multibyte characters must edit fine.
    const filePath = join(tmpDir, 'utf8.txt')
    const content = 'greeting: café\n日本語 line\nTARGET_UNIQUE_TOKEN\n'
    await writeFile(filePath, content, 'utf8')
    const ctx = makeContext(makePermissionContext())
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison(content),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'TARGET_UNIQUE_TOKEN',
        new_string: 'REPLACED',
      },
      ctx,
    )

    // Assert — no false positive on valid multibyte UTF-8.
    expect(result.result).toBe(true)
  })

  test('utf16le (FF FE BOM) file is exempt from the aen refusal', async () => {
    // Arrange — OCC round-trips utf16le losslessly, so the guard skips it.
    const filePath = join(tmpDir, 'u16.txt')
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('TARGET\r\n', 'utf16le'),
    ])
    await writeFile(filePath, bytes)
    const ctx = makeContext(makePermissionContext())
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison(bytes.toString('utf16le')),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    const result = await FileEditTool.validateInput(
      { file_path: filePath, old_string: 'TARGET', new_string: 'DONE' },
      ctx,
    )

    // Assert — specifically NOT the aen refusal (the carve-out contract).
    expect(result.errorCode).not.toBe(14)
    expect(result.message).not.toBe(NOT_UTF8_REFUSAL_MESSAGE)
  })
})
