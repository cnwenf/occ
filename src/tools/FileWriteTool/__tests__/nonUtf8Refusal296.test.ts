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
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import {
  FILE_NOT_VALID_UTF8_WRITE_MESSAGE,
  fileNotTextRefusalMessage,
  normalizeForComparison,
} from 'src/utils/permissions/fileStateGuard.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.296 changelog #032 (P0) — the Write-side companion refusal.
 *
 * Binary evidence (official ELF v296, never executed; strings + mmap.find):
 * - Refusal message `UTs` @101773960 / @208137426, in the same file-state
 *   constants chunk as `aen` — pinned byte-exact below.
 * - Write call (Kto) @216339393: `Je=await Ve.readExisting()`; after the
 *   call-time staleness guard `qto(...)`:
 *   `if(Je?.lossyDecode&&n.includes("�"))throw new C8(UTs)` —
 *   CONDITIONAL on both: the disk file decodes lossily AND the incoming
 *   content carries U+FFFD (what Read showed for undecodable bytes).
 *   Content without U+FFFD overwrites freely (an intentional whole-file
 *   rewrite is not data loss); a non-lossy disk file never refuses.
 */

// Official UTs literal, byte-verified against the v296 ELF @101773960.
// CC 2.1.299 #126: GONE from the v299 binary — the constant is kept in
// fileStateGuard.ts only for legacy consumers; the Write path now refuses
// unconditionally via Zpt (below).
const OFFICIAL_UTS =
  'The file on disk is not valid UTF-8, and the new content holds U+FFFD, which is what Read shows for the bytes of that file it cannot decode. If the content came from Read, writing it destroys those characters. Nothing was written. Make the change with a shell command that reads and writes the file in its own encoding, or ask the user whether to convert the file to UTF-8 first.'

// Official Zpt('not_utf8') literal, byte-verified against the v299 ELF
// @216803634 — the v299 Write refusal message.
const OFFICIAL_ZPT_NOT_UTF8 =
  'File is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file\'s encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.'

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
    toolUseId: `toolu_write032_${toolUseCounter}`,
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-write-032-'))
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
    { uuid: 'msg_write032' } as never,
  )
}

/** Seed readFileState the way a Read of `bytes` would (staleness guard). */
function seedRead(
  ctx: ToolUseContext,
  filePath: string,
  bytes: Buffer,
): void {
  ctx.readFileState.set(filePath, {
    content: normalizeForComparison(bytes.toString('utf8')),
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
}

describe('CC 2.1.296 #032 FileWriteTool U+FFFD destruction guard', () => {
  test('legacy refusal constant is byte-identical to official UTs', () => {
    expect(FILE_NOT_VALID_UTF8_WRITE_MESSAGE).toBe(OFFICIAL_UTS)
  })

  test('v299 refusal message is byte-identical to official Zpt(not_utf8)', () => {
    expect(fileNotTextRefusalMessage('not_utf8')).toBe(OFFICIAL_ZPT_NOT_UTF8)
  })

  test('lossy disk file + U+FFFD-bearing content → throws Zpt, nothing written', async () => {
    // Arrange — the round-trip data-loss scenario: Read showed 'caf�'
    // for the cp1252 bytes; the model edits around it and writes the
    // replacement char back. Official v299 @224562900:
    // `if(rt?.notText)throw new H9(Zpt(rt.notText))` — unconditional.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'cafe-cp1252.txt')
    await writeFile(filePath, CP1252_CAFE)
    seedRead(ctx, filePath, CP1252_CAFE)

    // Act / Assert
    await expect(
      callWrite(ctx, filePath, 'caf� — edited'),
    ).rejects.toThrow(OFFICIAL_ZPT_NOT_UTF8)
    expect(Buffer.compare(await readFile(filePath), CP1252_CAFE)).toBe(0)
  })

  test('lossy disk file + content WITHOUT U+FFFD → v299 refuses unconditionally', async () => {
    // Arrange — v296 allowed an intentional whole-file rewrite (no U+FFFD in
    // content); v299 removed the conditional: any notText disk file refuses
    // ("To replace the whole file with new UTF-8 text anyway, delete it
    // first, then Write it.").
    const ctx = makeContext()
    const filePath = join(tmpDir, 'rewrite-cp1252.txt')
    await writeFile(filePath, CP1252_CAFE)
    seedRead(ctx, filePath, CP1252_CAFE)

    // Act / Assert
    await expect(
      callWrite(ctx, filePath, 'café (now real UTF-8)'),
    ).rejects.toThrow(OFFICIAL_ZPT_NOT_UTF8)
    expect(Buffer.compare(await readFile(filePath), CP1252_CAFE)).toBe(0)

    // The official escape hatch: delete first, then Write succeeds.
    await rm(filePath)
    await callWrite(ctx, filePath, 'café (now real UTF-8)')
    expect(await readFile(filePath, 'utf8')).toBe('café (now real UTF-8)')
  })

  test('valid UTF-8 disk file + U+FFFD content → proceeds (disk-lossiness required)', async () => {
    // Arrange — a model may legitimately write U+FFFD into a clean file;
    // the refusal keys on the DISK file being lossy, not the content alone.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'clean-utf8.txt')
    await writeFile(filePath, 'clean content')
    seedRead(ctx, filePath, Buffer.from('clean content', 'utf8'))

    // Act
    await callWrite(ctx, filePath, 'has � on purpose')

    // Assert
    expect(await readFile(filePath, 'utf8')).toBe('has � on purpose')
  })
})
