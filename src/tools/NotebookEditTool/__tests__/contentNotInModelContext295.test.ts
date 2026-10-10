import { mkdtemp, rm, writeFile } from 'fs/promises'
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
import { renderNotebookCells } from 'src/utils/notebook.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { stashCheckTimeResolutions } from 'src/utils/permissions/symlinkResolutionStash.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.295 (#088) — NotebookEdit frozen-mtime freshness fallback.
 *
 * Official v295 tt-logic (verbatim):
 *   let Je=G.get(he),tt=!1;
 *   if(k4(Je)){
 *     if(tt=PLe(Je,FS(Re)),!tt&&Fe<=Je.timestamp)
 *       try{tt=PLe(Je,_(_9e(Ge)))}
 *       catch(qt){t(`NotebookEdit: the cells cannot be rendered as Read
 *         renders them: ${l(qt)}`)}
 *   }
 * Read stores .ipynb state as jsonStringify(rendered cells) — NOT the raw
 * file bytes — so the raw compare normally fails and the frozen-mtime
 * fallback (re-render the parsed cells exactly as Read does, via
 * renderNotebookCells ≡ _9e) is the real matcher. tt=false ⇒ the post-write
 * record is marked contentNotInModelContext.
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

let toolUseCounter = 0

function makeContext(): ToolUseContext {
  toolUseCounter += 1
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermissionContext(),
  }
  return {
    toolUseId: `toolu_nb295_${toolUseCounter}`,
    abortController: new AbortController(),
    options: { mainLoopModel: 'claude-opus-5', tools: [{ name: 'NotebookEdit' }] },
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
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-nb-088-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeNotebook(source: string): string {
  return jsonStringify({
    cells: [
      {
        cell_type: 'code',
        id: 'cell-1',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [source],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: { name: 'python', version: '3.11.0' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  })
}

async function callNotebookEdit(
  ctx: ToolUseContext,
  notebookPath: string,
  newSource: string,
): Promise<void> {
  stashCheckTimeResolutions(ctx as never, notebookPath, 'write')
  await NotebookEditTool.call(
    {
      notebook_path: notebookPath,
      cell_id: 'cell-1',
      new_source: newSource,
      cell_type: 'code',
      edit_mode: 'replace',
    } as never,
    ctx as never,
    undefined as never,
    { uuid: 'msg_nb088' } as never,
  )
}

/** Seed readFileState the way FileReadTool does for .ipynb: the JSON of the
 * Read-rendered cells, at the file's current mtime. */
function seedAsRead(
  ctx: ToolUseContext,
  filePath: string,
  renderedCellsJson: string,
): void {
  ctx.readFileState.set(filePath, {
    content: renderedCellsJson,
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
}

describe('CC 2.1.295 (#088) — NotebookEdit rendered-cells fallback', () => {
  test('Read-seeded record matches via the rendered-cells fallback → no flag', async () => {
    // Arrange — record holds jsonStringify(renderNotebookCells(nb)); the raw
    // ipynb bytes never match it, so only the fallback can clear the flag.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'nb.ipynb')
    await writeFile(filePath, makeNotebook('print(1)\n'))
    const rendered = jsonStringify(
      renderNotebookCells(JSON.parse(makeNotebook('print(1)\n')) as never),
    )
    seedAsRead(ctx, filePath, rendered)

    // Act
    await callNotebookEdit(ctx, filePath, 'print(2)\n')

    // Assert — fallback matched (preWriteMtime <= record timestamp), so the
    // post-write record keeps full-read status.
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBeUndefined()
    expect(record?.content).toContain('print(2)')
  })

  test('record that matches neither raw bytes nor rendered cells (frozen mtime) → flagged', async () => {
    // Arrange — the model's record reflects an OLDER notebook; the disk was
    // swapped without the mtime advancing. Both compares fail.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'nb2.ipynb')
    await writeFile(filePath, makeNotebook('print(CURRENT)\n'))
    const readAt = getFileModificationTime(filePath)
    const staleRendered = jsonStringify(
      renderNotebookCells(JSON.parse(makeNotebook('print(STALE)\n')) as never),
    )
    ctx.readFileState.set(filePath, {
      content: staleRendered,
      timestamp: readAt,
      offset: undefined,
      limit: undefined,
    })

    // Act
    await callNotebookEdit(ctx, filePath, 'print(2)\n')

    // Assert
    const record = ctx.readFileState.get(filePath)
    expect(record?.contentNotInModelContext).toBe(true)
  })

  test('no prior read record → flagged', async () => {
    // Arrange — k4(undefined) is false, so tt stays false.
    const ctx = makeContext()
    const filePath = join(tmpDir, 'nb3.ipynb')
    await writeFile(filePath, makeNotebook('print(1)\n'))

    // Act
    await callNotebookEdit(ctx, filePath, 'print(2)\n')

    // Assert
    expect(ctx.readFileState.get(filePath)?.contentNotInModelContext).toBe(true)
  })
})
