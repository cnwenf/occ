import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { expandPath } from '../../../utils/path.js'
import { BashTool } from '../BashTool.js'

// MACRO.VERSION polyfill — isFileReadDenied reaches getBundledSkillsRoot.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.293 changelog #29 — END-TO-END wiring proof.
 *
 * The unit suite (bashReadCommands293.test.ts) drives `recordBashReadFiles`
 * directly. This file enters through the PRODUCTION caller `BashTool.call()`
 * with a REAL shell command (no module mocks, mirroring shellWiring042) so a
 * mis-wired call site — wrong guard, wrong variable, recorder never invoked —
 * fails here even though every unit test passes. This is the behavioral e2e the
 * aligning-with-official-binary skill requires ("proves the feature works, not
 * that the string exists").
 *
 * Official call site (vver @216678800):
 *   if(!Ce && !Mo && !Ie.backgroundTaskId)
 *     await _Rn(command, readFileState, signal, code, <truncFlag>,
 *       remoteCall===void 0 && nestedMemoryAttachmentTriggers
 *         ? {triggers, permissions} : void 0)
 */

let tmpDir: string
let repoDir: string

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'occ-bashread-293-int-')))
  repoDir = join(tmpDir, 'repo')
  mkdirSync(repoDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function stageFile(relPath: string, content: string): string {
  const full = join(repoDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf-8')
  return full
}

type Ctx = {
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>
  triggers: Set<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any
}

/** A minimal but complete ToolUseContext for BashTool.call (foreground path). */
function makeContext(): Ctx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = {
    tasks: {},
    speculation: { status: 'idle' },
    toolPermissionContext: getEmptyToolPermissionContext(),
  }
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const triggers = new Set<string>()
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setAppState: (fn: (prev: any) => any) => {
      state = fn(state)
    },
    setToolJSX: undefined,
    toolUseId: 'tu-293-integration',
    readFileState,
    nestedMemoryAttachmentTriggers: triggers,
  }
  return { readFileState, triggers, context }
}

const LINES_20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

describe('CC 2.1.293 #29 — BashTool.call() end-to-end wiring', () => {
  test('a real `cat FILE` records readFileState AND fires the nested-memory trigger', async () => {
    const file = stageFile('f.txt', LINES_20)
    const key = expandPath(file)
    const { readFileState, triggers, context } = makeContext()

    // Act — through the production entry point (real shell spawn).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (BashTool as any).call({ command: `cat ${file}` }, context)

    // Assert — the call site invoked recordBashReadFiles with the right args:
    // readFileState populated (read-before-edit) + trigger fired (#29 fix).
    expect(readFileState.get(key)).toBeDefined()
    expect(readFileState.get(key)?.content).toBe(LINES_20)
    expect(triggers.has(key)).toBe(true)
  })

  test('core 292 bug e2e: re-`cat` of an ALREADY-recorded file STILL fires the trigger', async () => {
    const file = stageFile('f.txt', LINES_20)
    const key = expandPath(file)
    const { readFileState, triggers, context } = makeContext()
    // Pre-populate as if a prior Read/cat recorded it (sentinel content).
    readFileState.set(key, {
      content: 'STALE-SENTINEL',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (BashTool as any).call({ command: `cat ${file}` }, context)

    // The early-return path fires the trigger WITHOUT re-reading (sentinel kept).
    expect(triggers.has(key)).toBe(true)
    expect(readFileState.get(key)?.content).toBe('STALE-SENTINEL')
  })

  test('gate e2e: a non-read command (`echo`) records nothing and fires no trigger', async () => {
    const { readFileState, triggers, context } = makeContext()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (BashTool as any).call({ command: 'echo hello-293' }, context)

    expect(readFileState.size).toBe(0)
    expect(triggers.size).toBe(0)
  })

  test('slice e2e: a real `sed -n 5,10p FILE` records only the sliced window', async () => {
    const file = stageFile('f.txt', LINES_20)
    const key = expandPath(file)
    const { readFileState, triggers, context } = makeContext()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (BashTool as any).call(
      { command: `sed -n '5,10p' ${file}` },
      context,
    )

    const entry = readFileState.get(key)
    expect(entry?.content).toBe(
      ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n'),
    )
    expect(entry?.offset).toBe(5)
    expect(entry?.limit).toBe(6)
    expect(triggers.has(key)).toBe(true)
  })
})
