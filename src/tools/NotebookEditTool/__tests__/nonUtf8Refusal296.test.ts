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
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import {
  FILE_NOT_VALID_UTF8_EDIT_MESSAGE,
  normalizeForComparison,
} from 'src/utils/permissions/fileStateGuard.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.296 changelog #032 (P0) — the NotebookEdit refusals.
 *
 * Binary evidence (official ELF v296, never executed; strings + mmap.find):
 * - NotebookEdit validateInput @219777185:
 *   `({content:he,lossyDecode:_e}=await E_(G,f$))` then
 *   `if(_e)return{result:!1,message:aen,errorCode:15}` — BEFORE the JSON
 *   parse, so a lossy .ipynb gets the UTF-8 refusal (errorCode 15), not
 *   "Notebook is not valid JSON." (errorCode 6).
 * - NotebookEdit call @219778736: `Te=await be.readExisting(f$)`;
 *   `if(Te===null)return _e("Notebook file does not exist.")`;
 *   `if(Te.lossyDecode)return _e(aen)` — the error STUB `_e(be)` shape:
 *   `{data:{new_source:r,old_source:void 0,cell_type:h??"code",
 *   language:"python",edit_mode:"replace",error:be,cell_id:s,
 *   notebook_path:he,original_file:"",updated_file:""}}` — a returned
 *   error result, not a throw.
 * - `aen` = the shared Edit/NotebookEdit refusal message @101773572.
 */

// Shift-JIS "か" bytes spliced into JSON-ish content — lossy under utf8 AND
// not valid JSON, so refusal-ordering is observable (15 before 6).
const LOSSY_NB_BYTES = Buffer.from([
  0x7b, 0x22, 0x63, 0x65, 0x6c, 0x6c, 0x73, 0x22, 0x3a, 0x82, 0xa9, 0x7d,
]) // {"cells":か} with か in Shift-JIS

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
    toolUseId: `toolu_nb032_${toolUseCounter}`,
    abortController: new AbortController(),
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [
        { name: NOTEBOOK_EDIT_TOOL_NAME },
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-nb-032-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

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

describe('CC 2.1.296 #032 NotebookEditTool non-UTF-8 refusal', () => {
  test('validateInput refuses a lossy .ipynb with errorCode 15 BEFORE the JSON-parse error', async () => {
    // Arrange — the bytes are also invalid JSON; official ordering puts the
    // UTF-8 refusal (15/aen) ahead of "Notebook is not valid JSON." (6).
    const ctx = makeContext()
    const filePath = join(tmpDir, 'lossy.ipynb')
    await writeFile(filePath, LOSSY_NB_BYTES)
    seedRead(ctx, filePath, LOSSY_NB_BYTES)

    // Act
    const result = await NotebookEditTool.validateInput(
      {
        notebook_path: filePath,
        new_source: 'print("hi")',
        cell_id: 'cell-0',
        edit_mode: 'replace',
      } as never,
      ctx,
    )

    // Assert
    expect(result).toEqual({
      result: false,
      message: FILE_NOT_VALID_UTF8_EDIT_MESSAGE,
      errorCode: 15,
    })
    expect(result.message).not.toContain('not valid JSON')
  })

  test('validateInput control: valid UTF-8 non-JSON .ipynb still gets errorCode 6', async () => {
    // Arrange — proves the lossy gate did not swallow the JSON error path.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'notjson.ipynb')
    const bytes = Buffer.from('this is not json', 'utf8')
    await writeFile(filePath, bytes)
    seedRead(ctx, filePath, bytes)

    // Act
    const result = await NotebookEditTool.validateInput(
      {
        notebook_path: filePath,
        new_source: 'x',
        cell_id: 'cell-0',
        edit_mode: 'replace',
      } as never,
      ctx,
    )

    // Assert
    expect(result.result).toBe(false)
    expect((result as { errorCode?: number }).errorCode).toBe(6)
    expect(result.message).toBe('Notebook is not valid JSON.')
  })

  test('call returns the official error stub on a lossy .ipynb and leaves disk untouched', async () => {
    // Arrange
    const ctx = makeContext()
    const filePath = join(tmpDir, 'call-lossy.ipynb')
    await writeFile(filePath, LOSSY_NB_BYTES)
    seedRead(ctx, filePath, LOSSY_NB_BYTES)
    stashCheckTimeResolutions(ctx as never, filePath, 'write')

    // Act
    const result = (await NotebookEditTool.call(
      {
        notebook_path: filePath,
        new_source: 'print("hi")',
        cell_id: 'cell-0',
        edit_mode: 'replace',
      } as never,
      ctx as never,
      undefined as never,
      { uuid: 'msg_nb032' } as never,
    )) as { data: Record<string, unknown> }

    // Assert — official `_e(aen)` stub shape: returned error result, not a
    // throw; updated_file/original_file empty.
    expect(result.data.error).toBe(FILE_NOT_VALID_UTF8_EDIT_MESSAGE)
    expect(result.data.updated_file).toBe('')
    expect(result.data.original_file).toBe('')
    expect(result.data.cell_type).toBe('code')
    expect(result.data.language).toBe('python')
    expect(result.data.edit_mode).toBe('replace')
    expect(result.data.notebook_path).toBe(filePath)
    expect(Buffer.compare(await readFile(filePath), LOSSY_NB_BYTES)).toBe(0)
  })
})
