/**
 * CC 2.1.299 #126 — Write/Edit encoding fidelity:
 *
 * 1. BOM PRESERVATION (official UMr @224562900 / @227800100):
 *    - Write: `n=UMr(st,n)` — when the old on-disk content started with a
 *      BOM and the new content does not, the BOM is re-prefixed. Applies to
 *      UTF-8 BOM (EF BB BF → U+FEFF char) and UTF-16LE (FF FE).
 *    - Edit: `_n=V===""?UMr(zt,Xn):Xn` — UMr only on the whole-file
 *      (old_string==="") branch; ordinary string-replacement edits inherit
 *      the BOM through originalFileContents (readFileSyncWithMetadata keeps
 *      the BOM char in content).
 * 2. Encoding preservation: a UTF-16LE+BOM file stays UTF-16LE on rewrite
 *    (writeTextContent receives meta.encoding).
 * 3. Unconditional refusals (official `if(rt?.notText)throw new H9(Zpt(rt.notText))`):
 *    - utf16be (FE FF head) → Zpt('utf16be').
 *    - NUL in the first 8 KB → Zpt('nul').
 *    Nothing is written; the disk bytes survive untouched.
 */
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
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import {
  fileNotTextRefusalMessage,
  normalizeForComparison,
} from 'src/utils/permissions/fileStateGuard.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

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

function makeContext(): ToolUseContext {
  toolUseCounter += 1
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermissionContext(),
  }
  return {
    toolUseId: `toolu_bom299_${toolUseCounter}`,
    abortController: new AbortController(),
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [
        { name: FILE_WRITE_TOOL_NAME },
        { name: FILE_EDIT_TOOL_NAME },
        { name: FILE_READ_TOOL_NAME },
      ],
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-bom-299-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** Seed readFileState the way a Read of `bytes` (decoded as `encoding`) would. */
function seedRead(
  ctx: ToolUseContext,
  filePath: string,
  bytes: Buffer,
  encoding: BufferEncoding = 'utf8',
): void {
  ctx.readFileState.set(filePath, {
    content: normalizeForComparison(bytes.toString(encoding)),
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
}

async function callWrite(
  ctx: ToolUseContext,
  filePath: string,
  content: string,
): Promise<unknown> {
  stashCheckTimeResolutions(ctx as never, filePath, 'write')
  return FileWriteTool.call(
    { file_path: filePath, content } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_bom299_w' } as never,
  )
}

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
      replace_all: false,
    } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_bom299_e' } as never,
  )
}

describe('CC 2.1.299 #126: Write BOM preservation (official UMr)', () => {
  test('Write over a UTF-8-BOM file keeps EF BB BF on disk', async () => {
    // Arrange — old content starts with the BOM CHAR (readFileSyncWithMetadata
    // keeps it); new content does not → UMr re-prefixes \uFEFF.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'utf8-bom-write.txt')
    const bytes = Buffer.concat([UTF8_BOM, Buffer.from('original', 'utf8')])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    // Act
    await callWrite(ctx, filePath, 'replaced')

    // Assert
    const disk = await readFile(filePath)
    expect(disk.subarray(0, 3)).toEqual(UTF8_BOM)
    expect(disk.subarray(3).toString('utf8')).toBe('replaced')
  })

  test('Write over a UTF-16LE+BOM file stays UTF-16LE and keeps FF FE', async () => {
    // Arrange — "These tools write UTF-8 (or UTF-16LE behind its byte-order
    // mark)": the encoding detected on read is reused for the write.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'utf16le-write.txt')
    const bytes = Buffer.concat([
      UTF16LE_BOM,
      Buffer.from('hello', 'utf16le'),
    ])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes, 'utf16le')

    // Act
    await callWrite(ctx, filePath, 'goodbye world')

    // Assert — FF FE head, body decodes as UTF-16LE (no encoding conversion).
    const disk = await readFile(filePath)
    expect(disk.subarray(0, 2)).toEqual(UTF16LE_BOM)
    expect(disk.subarray(2).toString('utf16le')).toBe('goodbye world')
  })

  test('Write over a no-BOM UTF-8 file adds no BOM (UMr no-op)', async () => {
    const ctx = makeContext()
    const filePath = join(tmpDir, 'plain-write.txt')
    await writeFile(filePath, 'original')
    seedRead(ctx, filePath, Buffer.from('original', 'utf8'))

    await callWrite(ctx, filePath, 'replaced')

    const disk = await readFile(filePath)
    expect(disk.subarray(0, 3)).not.toEqual(UTF8_BOM)
    expect(disk.toString('utf8')).toBe('replaced')
  })
})

describe('CC 2.1.299 #126: Write unconditional notText refusals (utf16be / nul)', () => {
  test('UTF-16BE (FE FF) file → refused with Zpt(utf16be), nothing written', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'utf16be-write.txt')
    const bytes = Buffer.concat([UTF16BE_BOM, Buffer.from('hi')])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    // Act / Assert — official @224562900: `if(rt?.notText)throw new H9(Zpt(rt.notText))`
    await expect(callWrite(ctx, filePath, 'new content')).rejects.toThrow(
      fileNotTextRefusalMessage('utf16be'),
    )
    expect(fileNotTextRefusalMessage('utf16be')).toContain(
      'File is UTF-16 big-endian (it starts FE FF), which these tools cannot write.',
    )
    expect(Buffer.compare(await readFile(filePath), bytes)).toBe(0)
  })

  test('NUL-bearing file → refused with Zpt(nul), nothing written', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'nul-write.txt')
    const bytes = Buffer.concat([
      Buffer.from('text'),
      Buffer.alloc(1, 0),
      Buffer.from('more'),
    ])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    // Act / Assert
    await expect(callWrite(ctx, filePath, 'new content')).rejects.toThrow(
      fileNotTextRefusalMessage('nul'),
    )
    expect(fileNotTextRefusalMessage('nul')).toContain(
      'File has NUL bytes in its first 8 KB',
    )
    expect(Buffer.compare(await readFile(filePath), bytes)).toBe(0)
  })
})

describe('CC 2.1.299 #126: Edit BOM/encoding round-trip + refusals', () => {
  test('Edit on a UTF-16LE+BOM file preserves BOM + encoding (BOM inherited through content)', async () => {
    // Arrange — ordinary string-replacement edit: UMr itself only fires for
    // old_string==="" (official @227800100), but originalFileContents keeps
    // the BOM char, so the rewritten file retains it.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'utf16le-edit.txt')
    const bytes = Buffer.concat([
      UTF16LE_BOM,
      Buffer.from('hello world', 'utf16le'),
    ])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes, 'utf16le')

    // Act
    await callEdit(ctx, filePath, 'hello', 'goodbye')

    // Assert
    const disk = await readFile(filePath)
    expect(disk.subarray(0, 2)).toEqual(UTF16LE_BOM)
    expect(disk.subarray(2).toString('utf16le')).toBe('goodbye world')
  })

  test('Edit on a UTF-8-BOM file preserves EF BB BF', async () => {
    const ctx = makeContext()
    const filePath = join(tmpDir, 'utf8-bom-edit.txt')
    const bytes = Buffer.concat([
      UTF8_BOM,
      Buffer.from('header\nTARGET_TOKEN\nfooter', 'utf8'),
    ])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    await callEdit(ctx, filePath, 'TARGET_TOKEN', 'REPLACED')

    const disk = await readFile(filePath)
    expect(disk.subarray(0, 3)).toEqual(UTF8_BOM)
    expect(disk.subarray(3).toString('utf8')).toBe(
      'header\nREPLACED\nfooter',
    )
  })

  test('Edit validateInput on a NUL file → errorCode 15 with Zpt(nul)', async () => {
    // Arrange — official @227797374: `if(Ae)return{result:!1,message:Zpt(Ae),errorCode:15}`
    const ctx = makeContext()
    const filePath = join(tmpDir, 'nul-edit.txt')
    const bytes = Buffer.concat([
      Buffer.from('text'),
      Buffer.alloc(1, 0),
      Buffer.from('more'),
    ])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'text',
        new_string: 'replaced',
        replace_all: false,
      } as never,
      ctx,
    )

    // Assert
    expect(result).toEqual({
      result: false,
      message: fileNotTextRefusalMessage('nul'),
      errorCode: 15,
    })
    expect('behavior' in result).toBe(false)
  })
})
