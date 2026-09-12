import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../settings/types.js'

/**
 * 2.1.268 alignment (OCC-122, E42): SessionEnd hook timing split into
 * a per-hook default (official Wir: env CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
 * ?? 1500ms) and an overall budget (official Wge: env override wins outright —
 * v268 dropped v267's `>0` guard — else the largest configured SessionEnd hook
 * `timeout` (seconds) clamped to [1500, 60000]ms).
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only getHooksConfigFromSnapshot, restore.
const actualSnapshotModule = await import('../hooks/hooksConfigSnapshot.js')

let mockedHooksConfig: HooksSettings | null = null

mock.module('../hooks/hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

afterAll(() => {
  mock.module('../hooks/hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
})

const { getSessionEndHookTimeoutMs, getSessionEndHooksBudgetMs } =
  await import('../hooks.js')

afterEach(() => {
  delete process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  mockedHooksConfig = null
})

function sessionEndConfig(
  matcherTimeouts: number[][],
): HooksSettings {
  return {
    SessionEnd: matcherTimeouts.map(timeouts => ({
      hooks: timeouts.map(timeout => ({
        type: 'command',
        command: 'true',
        timeout,
      })),
    })),
  } as HooksSettings
}

describe('2.1.268 — getSessionEndHookTimeoutMs (E42, official Wir)', () => {
  test('defaults to 1500ms', () => {
    expect(getSessionEndHookTimeoutMs()).toBe(1500)
  })

  test('env override wins', () => {
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = '5000'
    expect(getSessionEndHookTimeoutMs()).toBe(5000)
  })

  test('invalid env falls back to the default', () => {
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = 'not-a-number'
    expect(getSessionEndHookTimeoutMs()).toBe(1500)
  })
})

describe('2.1.268 — getSessionEndHooksBudgetMs (E42, official Wge)', () => {
  test('floor of 1500ms with no snapshot config', () => {
    expect(getSessionEndHooksBudgetMs()).toBe(1500)
  })

  test('env override wins outright (v268 dropped the >0 guard)', () => {
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = '20000'
    mockedHooksConfig = sessionEndConfig([[3]])
    expect(getSessionEndHooksBudgetMs()).toBe(20000)

    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = '0'
    expect(getSessionEndHooksBudgetMs()).toBe(0)
  })

  test('invalid env falls back to the config scan', () => {
    process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = 'garbage'
    mockedHooksConfig = sessionEndConfig([[10]])
    expect(getSessionEndHooksBudgetMs()).toBe(10000)
  })

  test('largest configured hook timeout (seconds) becomes the budget', () => {
    mockedHooksConfig = sessionEndConfig([[3, 10], [5]])
    expect(getSessionEndHooksBudgetMs()).toBe(10000)
  })

  test('budget is clamped to the 60000ms ceiling', () => {
    mockedHooksConfig = sessionEndConfig([[120]])
    expect(getSessionEndHooksBudgetMs()).toBe(60000)
  })

  test('budget never drops below the 1500ms floor', () => {
    mockedHooksConfig = sessionEndConfig([[1]])
    expect(getSessionEndHooksBudgetMs()).toBe(1500)
  })

  test('non-SessionEnd hooks are ignored', () => {
    mockedHooksConfig = {
      PreToolUse: [
        {
          hooks: [{ type: 'command', command: 'true', timeout: 30 }],
        },
      ],
    } as HooksSettings
    expect(getSessionEndHooksBudgetMs()).toBe(1500)
  })
})
