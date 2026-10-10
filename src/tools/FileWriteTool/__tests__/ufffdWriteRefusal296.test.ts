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
import { normalizeForComparison } from 'src/utils/permissions/fileStateGuard.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'
import { UFFFD_WRITE_REFUSAL_MESSAGE } from 'src/utils/utf8Safety.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

// Transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.296 (UTs) — the Write-path companion to Edit/NotebookEdit's aen load
 * guard. Official evidence (/tmp/cc296/ev-utf8.txt): `UTs` is declared right
 * beside `aen` and `C8` (FileStateError). It refuses a Write when the file on
 * disk is not valid UTF-8 AND the new content holds U+FFFD — the marker Read
 * shows for bytes it could not decode. If the content came from Read, writing
 * it back destroys the original characters, so the write throws FileStateError
 * and nothing lands on disk.
 *
 * Edit's aen guard pre-empts every non-UTF-8 disk file before a U+FFFD-content
 * check could matter, so Write is UTs's only non-redundant home. The guard is
 * narrow: clean content (no U+FFFD) written to a non-UTF-8 file still proceeds
 * (re-saved as UTF-8), matching the official condition.
 */

// GBK bytes for "中文" — invalid UTF-8.
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
// U+FFFD REPLACEMENT CHARACTER — what Read shows for undecodable bytes.
const FFFD = '�'

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

function makeContext(permContext: ToolPermissionContext): ToolUseContext {
  toolUseCounter += 1
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    toolUseId: `toolu_write296_${toolUseCounter}`,
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-write-utf8-'))
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
    { uuid: 'msg_write296' } as never,
  )
}

/** Seed readFileState with the lossy decode so the freshness guard passes. */
function seedLossyRead(
  ctx: ToolUseContext,
  filePath: string,
  rawBytes: Buffer,
): void {
  ctx.readFileState.set(filePath, {
    content: normalizeForComparison(rawBytes.toString('utf8')),
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
}

describe('2.1.296 (UTs) — Write refuses U+FFFD content onto a non-UTF-8 file', () => {
  test('non-UTF-8 disk + U+FFFD in new content → FileStateError, nothing written', async () => {
    // Arrange — disk holds GBK bytes; the model Read it (saw U+FFFD) and is now
    // writing that lossy content back.
    const filePath = join(tmpDir, 'gbk.txt')
    await writeFile(filePath, GBK_BYTES)
    const ctx = makeContext(makePermissionContext())
    seedLossyRead(ctx, filePath, GBK_BYTES)
    const before = await readFile(filePath)
    const lossyContent = `header\n${FFFD}${FFFD}\nfooter`

    // Act / Assert — throws the verbatim UTs message.
    await expect(callWrite(ctx, filePath, lossyContent)).rejects.toThrow(
      UFFFD_WRITE_REFUSAL_MESSAGE,
    )
    // Nothing written: the original GBK bytes are intact.
    expect(await readFile(filePath)).toEqual(before)
  })

  test('non-UTF-8 disk + clean content (no U+FFFD) → proceeds, re-saved as UTF-8', async () => {
    // Arrange — UTs is narrow: it only blocks the Read-round-trip corruption
    // case. Genuinely new clean content is allowed.
    const filePath = join(tmpDir, 'gbk-clean.txt')
    await writeFile(filePath, GBK_BYTES)
    const ctx = makeContext(makePermissionContext())
    seedLossyRead(ctx, filePath, GBK_BYTES)

    // Act
    await callWrite(ctx, filePath, 'clean replacement content')

    // Assert — the write landed as UTF-8.
    expect(await readFile(filePath, 'utf8')).toBe('clean replacement content')
  })

  test('valid UTF-8 disk + U+FFFD in new content → NOT refused by UTs', async () => {
    // Arrange — UTs requires the DISK to be non-UTF-8. A valid UTF-8 file with
    // an intentional U+FFFD in the new content is a legitimate write.
    const filePath = join(tmpDir, 'utf8.txt')
    await writeFile(filePath, 'original valid content', 'utf8')
    const ctx = makeContext(makePermissionContext())
    ctx.readFileState.set(filePath, {
      content: normalizeForComparison('original valid content'),
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    await callWrite(ctx, filePath, `has a ${FFFD} char on purpose`)

    // Assert — written (disk was valid UTF-8, so UTs does not apply).
    expect(await readFile(filePath, 'utf8')).toBe(
      `has a ${FFFD} char on purpose`,
    )
  })
})
