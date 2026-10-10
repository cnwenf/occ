import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
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
import type { ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { getFileModificationTime } from 'src/utils/file.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.295 (#088) — simulated-sed edit path freshness.
 *
 * Official v295 (verbatim): `Te=k4(ke)&&PLe(ke,FS(G))` then
 *   n.readFileState.set(S,{content:FS(h),timestamp:be,offset:void 0,
 *     limit:void 0,...!Te&&{contentNotInModelContext:!0}})
 * ke = the read record captured BEFORE the write, G = pre-write disk
 * content, FS = stripBom, h = newContent. v294 additionally tolerated a
 * frozen mtime (`...||be<=ke.timestamp` after a pre-stat); v295 REMOVES
 * that tolerance — a content match is now required. The stored content is
 * stripBom(newContent) (OCC previously stored raw newContent).
 */

function makeContext(): ToolUseContext {
  return {
    toolUseId: 'toolu_sed295',
    abortController: new AbortController(),
    options: { mainLoopModel: 'claude-opus-5', tools: [{ name: 'Bash' }] },
    readFileState: createFileStateCacheWithSizeLimit(100),
    updateFileHistoryState: () => {},
    getAppState: () => getDefaultAppState(),
  } as unknown as ToolUseContext
}

let tmpDir: string
let savedCheckpointEnv: string | undefined

beforeAll(() => {
  savedCheckpointEnv = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
})

afterAll(() => {
  if (savedCheckpointEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  } else {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = savedCheckpointEnv
  }
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-sed-088-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function callSedEdit(
  ctx: ToolUseContext,
  filePath: string,
  newContent: string,
): Promise<void> {
  await BashTool.call(
    {
      command: `sed -i s/OLD/NEW/ '${filePath}'`,
      _simulatedSedEdit: { filePath, newContent },
    } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_sed088' } as never,
  )
}

describe('CC 2.1.295 (#088) — simulated sed edit freshness flag', () => {
  test('record matches pre-write disk content → no flag, content stored BOM-stripped', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'ok.txt')
    await writeFile(filePath, 'OLD content\n')
    ctx.readFileState.set(filePath, {
      content: 'OLD content\n',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    await callSedEdit(ctx, filePath, 'NEW content\n')

    // Assert — k4 && PLe both hold.
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBeUndefined()
    expect(record?.content).toBe('NEW content\n')
    expect(await readFile(filePath, 'utf8')).toBe('NEW content\n')
  })

  test('content changed with frozen mtime → flagged (v295 removed the mtime tolerance)', async () => {
    // Arrange — full-read record, but the disk was swapped behind the model
    // and the mtime frozen back, so v294's `be<=ke.timestamp` escape would
    // have passed. v295 requires PLe(ke, FS(G)) — a content match.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'frozen.txt')
    await writeFile(filePath, 'RECORD content\n')
    const readAt = getFileModificationTime(filePath)
    ctx.readFileState.set(filePath, {
      content: 'RECORD content\n',
      timestamp: readAt,
      offset: undefined,
      limit: undefined,
    })
    await writeFile(filePath, 'SWAPPED content\n')
    const when = new Date(readAt)
    await utimes(filePath, when, when)

    // Act
    await callSedEdit(ctx, filePath, 'NEW content\n')

    // Assert
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBe(true)
    expect(record?.content).toBe('NEW content\n')
  })

  test('no prior read record → flagged', async () => {
    // Arrange — k4(undefined) is false.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'unread.txt')
    await writeFile(filePath, 'OLD content\n')

    // Act
    await callSedEdit(ctx, filePath, 'NEW content\n')

    // Assert
    expect(ctx.readFileState.get(filePath)?.contentNotInModelContext).toBe(true)
  })

  test('record with a BOM-prefixed match still clears the flag via stripBom', async () => {
    // Arrange — FS(G): the pre-write disk content is compared BOM-stripped.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'bom.txt')
    await writeFile(filePath, '﻿OLD content\n', 'utf8')
    ctx.readFileState.set(filePath, {
      content: 'OLD content\n',
      timestamp: getFileModificationTime(filePath),
      offset: undefined,
      limit: undefined,
    })

    // Act
    await callSedEdit(ctx, filePath, '﻿NEW content\n')

    // Assert — stored content is stripBom(newContent) per the official set.
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBeUndefined()
    expect(record?.content).toBe('NEW content\n')
  })
})
