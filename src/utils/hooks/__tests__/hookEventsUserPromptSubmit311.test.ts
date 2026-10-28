import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { HookExecutionEvent } from '../hookEvents.js'

/**
 * WP-8 (2.1.311): CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS.
 *
 * Official v311 @249400832 adds a `userPromptSubmitStartAndEndEnabled`
 * sub-flag to the hook-events singleton (`class SHt`):
 *   - `Gje(e)` (base shouldEmit): always-emitted list OR
 *     allHookEventsEnabled && known hook event.
 *   - `bHt(e)` (start/end shouldEmit): `Gje(e) || e==="UserPromptSubmit" &&
 *     userPromptSubmitStartAndEndEnabled`.
 *   - hook_started (`Zpe`) and hook_response (`nf`) gate on `bHt`;
 *     hook_progress (`uTo`) and the progress interval (`tme`) gate on `Gje`
 *     only — the sub-flag covers ONLY the UserPromptSubmit start/end events.
 *
 * Official v311 @249402502 one-shot startup function `uFs()`:
 *   if (env CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS is truthy)
 *     → userPromptSubmitStartAndEndEnabled = true
 *   then ALWAYS unset the env var (child processes must not inherit it).
 *
 * Byte-verification evidence (v311 ELF, read-only):
 *   - `CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS` @116591720,
 *     238995614, 243146554, 249402502, 249402603 (0 hits in v310)
 *   - `userPromptSubmitStartAndEndEnabled` @119193600, 249400832, 249401147,
 *     249402556 (0 hits in v310)
 */

// NOTE: sibling test files (e.g. asyncHookJson295.test.ts) call
// mock.module('../../hooks/hookEvents.js', …) and bun's mock.module is
// process-global — a plain import can resolve to the leaked mock namespace
// when files share a test process. A cache-busting query suffix loads a
// fresh REAL instance of the module that no mock.module registration
// matches, keeping this file deterministic regardless of run order.
const {
  registerHookEventHandler,
  emitHookStarted,
  emitHookProgress,
  emitHookResponse,
  setAllHookEventsEnabled,
  setUserPromptSubmitStartAndEndEnabled,
  isUserPromptSubmitStartAndEndEnabled,
  applyHookEventsEnvFlags,
  clearHookEventState,
} = await import('../hookEvents.js?real311')

const ENV_FLAG_NAME = 'CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS'

let capturedEvents: HookExecutionEvent[] = []

beforeEach(() => {
  capturedEvents = []
  registerHookEventHandler((event) => {
    capturedEvents.push(event)
  })
})

afterEach(() => {
  clearHookEventState()
  delete process.env[ENV_FLAG_NAME]
})

function typesFor(hookEvent: string): string[] {
  return capturedEvents
    .filter((event) => event.hookEvent === hookEvent)
    .map((event) => event.type)
}

describe('userPromptSubmitStartAndEndEnabled sub-flag', () => {
  test('defaults to false', () => {
    expect(isUserPromptSubmitStartAndEndEnabled()).toBe(false)
  })

  test('UserPromptSubmit started/response are NOT emitted by default', () => {
    emitHookStarted('hook-1', 'mcp__srv__hook', 'UserPromptSubmit')
    emitHookResponse({
      hookId: 'hook-1',
      hookName: 'mcp__srv__hook',
      hookEvent: 'UserPromptSubmit',
      output: '',
      stdout: '',
      stderr: '',
      outcome: 'success',
    })
    expect(typesFor('UserPromptSubmit')).toEqual([])
  })

  test('sub-flag enables UserPromptSubmit started and response events', () => {
    setUserPromptSubmitStartAndEndEnabled(true)
    emitHookStarted('hook-1', 'mcp__srv__hook', 'UserPromptSubmit')
    emitHookResponse({
      hookId: 'hook-1',
      hookName: 'mcp__srv__hook',
      hookEvent: 'UserPromptSubmit',
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      outcome: 'success',
    })
    expect(typesFor('UserPromptSubmit')).toEqual(['started', 'response'])
  })

  test('sub-flag does NOT enable UserPromptSubmit progress events (official Gje gate)', () => {
    setUserPromptSubmitStartAndEndEnabled(true)
    emitHookProgress({
      hookId: 'hook-1',
      hookName: 'mcp__srv__hook',
      hookEvent: 'UserPromptSubmit',
      stdout: 'partial',
      stderr: '',
      output: 'partial',
    })
    expect(typesFor('UserPromptSubmit')).toEqual([])
  })

  test('sub-flag does not enable other non-always-emitted hook events', () => {
    setUserPromptSubmitStartAndEndEnabled(true)
    emitHookStarted('hook-2', 'mcp__srv__hook', 'PreToolUse')
    expect(typesFor('PreToolUse')).toEqual([])
  })

  test('always-emitted events keep working regardless of the sub-flag', () => {
    emitHookStarted('hook-3', 'mcp__srv__hook', 'SessionStart')
    expect(typesFor('SessionStart')).toEqual(['started'])
  })

  test('allHookEventsEnabled still emits everything including progress', () => {
    setAllHookEventsEnabled(true)
    emitHookStarted('hook-4', 'mcp__srv__hook', 'UserPromptSubmit')
    emitHookProgress({
      hookId: 'hook-4',
      hookName: 'mcp__srv__hook',
      hookEvent: 'UserPromptSubmit',
      stdout: 'partial',
      stderr: '',
      output: 'partial',
    })
    expect(typesFor('UserPromptSubmit')).toEqual(['started', 'progress'])
  })

  test('clearHookEventState resets the sub-flag', () => {
    setUserPromptSubmitStartAndEndEnabled(true)
    clearHookEventState()
    expect(isUserPromptSubmitStartAndEndEnabled()).toBe(false)
    registerHookEventHandler((event) => {
      capturedEvents.push(event)
    })
    emitHookStarted('hook-5', 'mcp__srv__hook', 'UserPromptSubmit')
    expect(typesFor('UserPromptSubmit')).toEqual([])
  })
})

describe('applyHookEventsEnvFlags (official uFs one-shot)', () => {
  test('truthy env var enables the sub-flag and deletes the env var', () => {
    process.env[ENV_FLAG_NAME] = '1'
    applyHookEventsEnvFlags()
    expect(isUserPromptSubmitStartAndEndEnabled()).toBe(true)
    expect(process.env[ENV_FLAG_NAME]).toBeUndefined()
  })

  test('"true" env var enables the sub-flag and deletes the env var', () => {
    process.env[ENV_FLAG_NAME] = 'true'
    applyHookEventsEnvFlags()
    expect(isUserPromptSubmitStartAndEndEnabled()).toBe(true)
    expect(process.env[ENV_FLAG_NAME]).toBeUndefined()
  })

  test('falsy env var leaves the sub-flag false but still deletes the env var', () => {
    process.env[ENV_FLAG_NAME] = '0'
    applyHookEventsEnvFlags()
    expect(isUserPromptSubmitStartAndEndEnabled()).toBe(false)
    expect(process.env[ENV_FLAG_NAME]).toBeUndefined()
  })

  test('absent env var leaves the sub-flag false and does not throw', () => {
    delete process.env[ENV_FLAG_NAME]
    expect(() => applyHookEventsEnvFlags()).not.toThrow()
    expect(isUserPromptSubmitStartAndEndEnabled()).toBe(false)
    expect(process.env[ENV_FLAG_NAME]).toBeUndefined()
  })

  test('enabled flag drives end-to-end emission after the one-shot call', () => {
    process.env[ENV_FLAG_NAME] = 'true'
    applyHookEventsEnvFlags()
    emitHookStarted('hook-6', 'mcp__srv__hook', 'UserPromptSubmit')
    emitHookResponse({
      hookId: 'hook-6',
      hookName: 'mcp__srv__hook',
      hookEvent: 'UserPromptSubmit',
      output: '',
      stdout: '',
      stderr: '',
      outcome: 'success',
    })
    expect(typesFor('UserPromptSubmit')).toEqual(['started', 'response'])
  })
})
