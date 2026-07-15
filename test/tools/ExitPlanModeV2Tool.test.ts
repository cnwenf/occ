import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ExitPlanModeV2Tool — plan-approval label guard + no-clobber (CC 2.1.210 #12).
 *
 * Two bugs ported from claude-code 2.1.210 #12:
 *  - Bug 1: an unedited plan approval was mislabeled "Approved Plan (edited
 *    by user)" because `normalizeToolInput` (api.ts) injects `plan` from disk
 *    pre-permission, so `inputPlan` was always set even without a user edit.
 *  - Bug 2: that same injected snapshot was written back to the plan file at
 *    approval time, clobbering any in-memory state with a stale snapshot.
 *
 * Binary fix (2.1.210): strip `plan`/`planFilePath` from the no-edit
 * permission fallback. OCC mirrors the effect in call() by detecting the
 * injection via `planFilePath` presence: `normalizeToolInput` always injects
 * BOTH keys, whereas the permission UI's `updatedInput` only ever carries
 * `plan` (never `planFilePath`). So `planFilePath` in input => injection
 * (not a real edit) => no label suffix, no clobber.
 *
 * This UT exercises the REAL `call()` against a real (temp) plan file — no
 * module mocking. The plan path is pinned via the slug cache so getPlan /
 * getPlanFilePath / writeFile all agree on the same deterministic path.
 */

import { getClaudeConfigHomeDir } from '../../src/utils/envUtils.js'
import { getPlansDirectory, getPlanFilePath } from '../../src/utils/plans.js'
import { getPlanSlugCache, getSessionId } from '../../src/bootstrap/state.js'
import { ExitPlanModeV2Tool } from '../../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'

const PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
let tempHome: string
let planPath: string

const FIXED_SLUG = 'occ-exitplan-ut'

function clearMemoCaches(): void {
  // getClaudeConfigHomeDir + getPlansDirectory are lodash memoize; clear so a
  // fresh CLAUDE_CONFIG_DIR is honored (mirrors fable.test.ts pattern).
  ;(getClaudeConfigHomeDir as unknown as { cache: { clear: () => void } }).cache.clear()
  ;(getPlansDirectory as unknown as { cache: { clear: () => void } }).cache.clear()
}

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'occ-exitplan-ut-'))
  process.env.CLAUDE_CONFIG_DIR = tempHome
  clearMemoCaches()
  // Pin a known slug so the plan file path is deterministic across the suite.
  getPlanSlugCache().set(getSessionId(), FIXED_SLUG)
  planPath = getPlanFilePath() // <tempHome>/plans/<FIXED_SLUG>.md
  mkdirSync(join(tempHome, 'plans'), { recursive: true })
})

beforeEach(() => {
  // Reset the plan file to the "on-disk" snapshot before each case.
  writeFileSync(planPath, 'DISK_PLAN_CONTENT', 'utf-8')
})

afterAll(() => {
  clearMemoCaches()
  rmSync(tempHome, { recursive: true, force: true })
  if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR
  clearMemoCaches()
})

/**
 * Minimal ToolUseContext. The non-teammate approval path in call() touches:
 * context.agentId, context.options.tools (for hasTaskTool, short-circuited by
 * isAgentSwarmsEnabled()=false), context.getAppState() (prePlanMode='default'
 * so the auto-mode gate block is skipped), and context.setAppState() (no-op —
 * callback not invoked, so the restore logic is skipped).
 */
function makeContext(): unknown {
  return {
    agentId: undefined,
    options: { tools: [] },
    getAppState: () => ({
      toolPermissionContext: { mode: 'plan', prePlanMode: undefined },
    }),
    setAppState: () => {},
  }
}

describe('ExitPlanModeV2Tool plan-approval label + no-clobber (CC 2.1.210 #12)', () => {
  test('approve WITHOUT edit (normalizeToolInput injection) -> not edited, disk NOT clobbered', async () => {
    // Arrange: input mirrors what normalizeToolInput injects pre-permission —
    // BOTH `plan` and `planFilePath` from disk. No user edit happened.
    const input = {
      allowedPrompts: [],
      plan: 'INJECTED_SNAPSHOT',
      planFilePath: planPath,
    }

    // Act
    const result = (await ExitPlanModeV2Tool.call(
      input as never,
      makeContext() as never,
    )) as { data?: { planWasEdited?: boolean; plan?: string } }

    // Assert — Bug 1: must NOT be labeled as edited.
    expect(result.data?.planWasEdited).toBeFalsy()
    // Assert — Bug 2: the injected snapshot must NOT clobber the plan file.
    expect(readFileSync(planPath, 'utf-8')).toBe('DISK_PLAN_CONTENT')
  })

  test('approve WITH edit (permission updatedInput plan only) -> edited, edit persisted', async () => {
    // Arrange: input mirrors the permission UI's updatedInput on Ctrl+G edit —
    // `plan` only, NEVER `planFilePath`.
    const input = {
      allowedPrompts: [],
      plan: 'USER_EDITED_PLAN',
    }

    // Act
    const result = (await ExitPlanModeV2Tool.call(
      input as never,
      makeContext() as never,
    )) as { data?: { planWasEdited?: boolean; plan?: string } }

    // Assert — a real edit IS labeled.
    expect(result.data?.planWasEdited).toBe(true)
    // Assert — the edit is persisted to disk so VerifyPlanExecution / Read see it.
    expect(readFileSync(planPath, 'utf-8')).toBe('USER_EDITED_PLAN')
  })

  test('approve with empty input (no plan, e.g. CCR sends {}) -> not edited, no clobber, disk fallback', async () => {
    // Arrange: input carries no plan at all.
    const input = { allowedPrompts: [] }

    // Act
    const result = (await ExitPlanModeV2Tool.call(
      input as never,
      makeContext() as never,
    )) as { data?: { planWasEdited?: boolean; plan?: string } }

    // Assert
    expect(result.data?.planWasEdited).toBeFalsy()
    expect(readFileSync(planPath, 'utf-8')).toBe('DISK_PLAN_CONTENT')
    // plan falls back to the on-disk content.
    expect(result.data?.plan).toBe('DISK_PLAN_CONTENT')
  })
})

describe('ExitPlanModeV2Tool label rendering via mapToolResultToToolResultBlockParam', () => {
  // Pure function — no I/O. Verifies the label decision end-to-end.
  test('planWasEdited falsy -> "Approved Plan" (no suffix)', () => {
    const out = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(
      {
        isAgent: false,
        plan: 'P',
        filePath: '/p.md',
        planWasEdited: undefined,
      } as never,
      'tu-label-1',
    ) as { content: string }

    expect(out.content).toContain('## Approved Plan:')
    expect(out.content).not.toContain('(edited by user)')
  })

  test('planWasEdited true -> "Approved Plan (edited by user)"', () => {
    const out = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(
      {
        isAgent: false,
        plan: 'P',
        filePath: '/p.md',
        planWasEdited: true,
      } as never,
      'tu-label-2',
    ) as { content: string }

    expect(out.content).toContain('## Approved Plan (edited by user):')
  })
})
