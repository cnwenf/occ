import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

/**
 * CC 2.1.288 (#61) — InstructionsLoaded hook input carries the subagent
 * identity + effort level for file-access load reasons.
 *
 * Official v288 threads {agentId, agentType} from the tool/subagent context
 * into the InstructionsLoaded hook input so a hook can tell a subagent load
 * from a main-thread load, and the payload/schema surface the active effort
 * level. `createBaseHookInput` already emits `agent_id` / `agent_type` /
 * `effort` (2.1.133); the gap is (a) `executeInstructionsLoadedHooks` calling
 * `createBaseHookInput(undefined)` without agentInfo, and (b) the SDK
 * InstructionsLoaded schema not declaring `effort` (Zod strips it).
 *
 * These tests capture the real command-hook stdin (end-to-end proof of the
 * runtime payload) and assert the schema preserves `effort`.
 */

// --- Mock seams (OCC-97: Bun's mock.module leaks across test files in the
// same worker — spread the real module, override narrowly, restore below). ---
const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
let mockedHooksConfig: HooksSettings | null = null
mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
})

const { executeInstructionsLoadedHooks } = await import('../../hooks.js')
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')
const { InstructionsLoadedHookInputSchema } = await import(
  '../../../entrypoints/sdk/coreSchemas.js'
)

let tmpDir: string
let savedEffortEnv: string | undefined
let savedSimpleEnv: string | undefined
let counter = 0

beforeAll(() => {
  // Interactive-mode trust gate (shouldSkipHookDueToTrust) — latch true.
  setSessionTrustAccepted(true)
  savedEffortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  // Deterministic effort level; SIMPLE would disable executeHooksOutsideREPL.
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'medium'
  delete process.env.CLAUDE_CODE_SIMPLE
})

afterAll(() => {
  if (savedEffortEnv === undefined) {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  } else {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = savedEffortEnv
  }
  if (savedSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = savedSimpleEnv
  }
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-instr-loaded-288-'))
})

afterEach(async () => {
  mockedHooksConfig = null
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * Wire a real command hook (`cat > <file>`) that captures the hook input JSON
 * on stdin, then invoke executeInstructionsLoadedHooks and return the capture.
 */
async function captureHookInput(options?: unknown): Promise<Record<string, any>> {
  counter += 1
  const captureFile = join(tmpDir, `hook-input-${counter}.json`)
  mockedHooksConfig = {
    InstructionsLoaded: [
      { matcher: '', hooks: [{ type: 'command', command: `cat > ${captureFile}` }] },
    ],
  } as unknown as HooksSettings

  await executeInstructionsLoadedHooks(
    '/project/src/nested/example.ts',
    'Project',
    'nested_traversal',
    options as never,
  )

  const raw = await readFile(captureFile, 'utf8')
  return JSON.parse(raw) as Record<string, any>
}

describe('CC 2.1.288 (#61) — InstructionsLoaded hook input: agent identity + effort', () => {
  test('subagent file-access load carries agent_id / agent_type + effort', async () => {
    const captured = await captureHookInput({
      agentInfo: { agentId: 'agent_xyz', agentType: 'code-reviewer' },
    })

    expect(captured.hook_event_name).toBe('InstructionsLoaded')
    expect(captured.load_reason).toBe('nested_traversal')
    expect(captured.agent_id).toBe('agent_xyz')
    expect(captured.agent_type).toBe('code-reviewer')
    expect(captured.effort).toEqual({ level: 'medium' })
  })

  test('main-agent load is unchanged: no agent_id, effort still present', async () => {
    const captured = await captureHookInput(undefined)

    expect(captured.hook_event_name).toBe('InstructionsLoaded')
    // agent_id is only set for subagents; JSON.stringify drops the undefined.
    expect(captured.agent_id).toBeUndefined()
    expect(captured.effort).toEqual({ level: 'medium' })
  })
})

describe('CC 2.1.288 (#61) — InstructionsLoaded schema accepts effort', () => {
  test('InstructionsLoadedHookInputSchema preserves the effort field', () => {
    const parsed = InstructionsLoadedHookInputSchema().parse({
      session_id: 'sess_1',
      transcript_path: '/tmp/sess_1.jsonl',
      cwd: '/project',
      hook_event_name: 'InstructionsLoaded',
      file_path: '/project/CLAUDE.md',
      memory_type: 'Project',
      load_reason: 'nested_traversal',
      effort: { level: 'medium' },
    }) as Record<string, any>

    expect(parsed.effort).toEqual({ level: 'medium' })
  })
})
