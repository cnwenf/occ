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
import {
  FILE_NOT_VALID_UTF8_EDIT_MESSAGE,
  normalizeForComparison,
} from 'src/utils/permissions/fileStateGuard.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'

// The read-permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx). Mirror it.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.296 changelog #032 (P0): "Fixed Edit and NotebookEdit replacing
 * every non-ASCII character in files that are not valid UTF-8
 * (Windows-1252, Shift-JIS, GBK); such edits are now refused"
 *
 * Layer 2 of the port — FileEditTool validateInput + call refusals.
 *
 * Binary evidence (official ELF v296, never executed; strings + mmap.find):
 * - Refusal message `aen` @101773572 / @208137040, defined in the
 *   file-state constants chunk next to ren/oen/sen (READ_DENY_* /
 *   FILE_NOT_READ / MODIFIED_SINCE_READ) and `class C8 extends Error{
 *   name="FileStateError"}` — pinned byte-exact below.
 * - Edit validateInput @219762357: bytes read `Ze=await be.readFileBytes(V)`,
 *   BOM sniff `ut=...?"utf16le":"utf8"`, `Re=IAo(Ze,ut)` (lossy check),
 *   then AFTER the stale-read block (Pe) and BEFORE old_string matching:
 *   `if(Re)return{result:!1,message:aen,errorCode:15}` — no behavior field.
 * - Edit call (yjr): `{...,lossyDecode:on}=await _jr(Ft)`; after the
 *   call-time stale guard ($n=kjr(...)): `if(on)throw new C8(aen)` —
 *   before findActualString/patch/write; write preserves encoding +
 *   lineEndings (oPe).
 */

// Official aen literal, byte-verified against the v296 ELF @101773572.
const OFFICIAL_AEN =
  'File is not valid UTF-8. It may use a legacy encoding such as Windows-1252, Shift-JIS or GBK, or be binary. This tool saves the whole file as UTF-8, which would replace every byte it cannot decode with U+FFFD. Nothing was written. Make the change with a shell command that reads and writes the file in its own encoding, or ask the user whether to convert the file to UTF-8 first.'

const CP1252_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xe9]) // "café" in Windows-1252

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
    toolUseId: `toolu_edit032_${toolUseCounter}`,
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

/** Seed readFileState with whatever a Read of `bytes` would have cached. */
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-edit-032-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('CC 2.1.296 #032 FileEditTool non-UTF-8 refusal', () => {
  test('refusal constant is byte-identical to official aen', () => {
    expect(FILE_NOT_VALID_UTF8_EDIT_MESSAGE).toBe(OFFICIAL_AEN)
  })

  test('validateInput refuses a Windows-1252 file with errorCode 15 and NO behavior field', async () => {
    // Arrange — a fresh (matching) read of the lossy file, and an old_string
    // that WOULD match in the decoded content: the official refusal fires
    // before old_string matching, so matchability is irrelevant.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'cafe-cp1252.txt')
    await writeFile(filePath, CP1252_CAFE)
    seedRead(ctx, filePath, CP1252_CAFE)

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'caf',
        new_string: 'tea',
        replace_all: false,
      } as never,
      ctx,
    )

    // Assert — official shape: {result:!1,message:aen,errorCode:15}, no
    // behavior field (unlike the stale-read ask).
    expect(result).toEqual({
      result: false,
      message: OFFICIAL_AEN,
      errorCode: 15,
    })
    expect('behavior' in result).toBe(false)
  })

  test('validateInput refusal precedes the not-found error (lossy file, unmatched old_string → 15, not 8)', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'nomatch-cp1252.txt')
    await writeFile(filePath, CP1252_CAFE)
    seedRead(ctx, filePath, CP1252_CAFE)

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'DEFINITELY_NOT_PRESENT',
        new_string: 'x',
        replace_all: false,
      } as never,
      ctx,
    )

    // Assert
    expect(result.result).toBe(false)
    expect((result as { errorCode?: number }).errorCode).toBe(15)
  })

  test('validateInput control: valid UTF-8 file still validates', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'cafe-utf8.txt')
    const bytes = Buffer.from('café\n', 'utf8')
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'café',
        new_string: 'tea',
        replace_all: false,
      } as never,
      ctx,
    )

    // Assert
    expect(result.result).toBe(true)
  })

  test('validateInput control: UTF-16LE BOM file is NOT refused (official IAo utf8-only gate)', async () => {
    // Arrange — same bytes flagged lossy under utf8 decode; the BOM sniff
    // picks utf16le, so IAo keeps the flag off and the edit validates.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'hello-utf16le.txt')
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hello', 'utf16le'),
    ])
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes, 'utf16le')

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
        replace_all: false,
      } as never,
      ctx,
    )

    // Assert
    expect(result.result).toBe(true)
  })

  test('call throws FileStateError on a lossy file and leaves disk bytes untouched', async () => {
    // Arrange — the call-time refusal is the TOCTOU backstop: even when
    // validateInput was skipped/recovered, `if(on)throw new C8(aen)` fires
    // after the stale guard and before the write.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'call-cp1252.txt')
    await writeFile(filePath, CP1252_CAFE)
    seedRead(ctx, filePath, CP1252_CAFE)
    stashCheckTimeResolutions(ctx as never, filePath, 'write')

    // Act / Assert
    await expect(
      FileEditTool.call(
        {
          file_path: filePath,
          old_string: 'caf',
          new_string: 'tea',
          replace_all: false,
        } as never,
        ctx as never,
        undefined as never,
        { uuid: 'msg_edit032' } as never,
      ),
    ).rejects.toThrow(OFFICIAL_AEN)

    // Nothing was written — the raw cp1252 byte survives.
    expect(Buffer.compare(await readFile(filePath), CP1252_CAFE)).toBe(0)
  })

  test('call control: valid UTF-8 edit still lands on disk', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'call-utf8.txt')
    await writeFile(filePath, 'header\nTARGET_TOKEN\nfooter')
    ctx.readFileState.set(filePath, {
      content: 'header\nTARGET_TOKEN\nfooter',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })
    stashCheckTimeResolutions(ctx as never, filePath, 'write')

    // Act
    await FileEditTool.call(
      {
        file_path: filePath,
        old_string: 'TARGET_TOKEN',
        new_string: 'REPLACED',
        replace_all: false,
      } as never,
      ctx as never,
      undefined as never,
      { uuid: 'msg_edit032_ok' } as never,
    )

    // Assert
    expect(await readFile(filePath, 'utf8')).toBe('header\nREPLACED\nfooter')
  })
})
