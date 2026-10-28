/**
 * Hook event system for broadcasting hook execution events.
 *
 * This module provides a generic event system that is separate from the
 * main message stream. Handlers can register to receive events and decide
 * what to do with them (e.g., convert to SDK messages, log, etc.).
 */

import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'

import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'

/**
 * Hook events that are always emitted regardless of the includeHookEvents
 * option. These are low-noise lifecycle events that were in the original
 * allowlist and are backwards-compatible.
 */
const ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart', 'Setup'] as const

const MAX_PENDING_EVENTS = 100

export type HookStartedEvent = {
  type: 'started'
  hookId: string
  hookName: string
  hookEvent: string
}

export type HookProgressEvent = {
  type: 'progress'
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}

export type HookResponseEvent = {
  type: 'response'
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}

export type HookExecutionEvent =
  | HookStartedEvent
  | HookProgressEvent
  | HookResponseEvent
export type HookEventHandler = (event: HookExecutionEvent) => void

const pendingEvents: HookExecutionEvent[] = []
let eventHandler: HookEventHandler | null = null
let allHookEventsEnabled = false
/**
 * Official v311 `SHt.userPromptSubmitStartAndEndEnabled` @249400832.
 * Sub-flag that enables ONLY the UserPromptSubmit started/response (start &
 * end) events — progress events stay gated by `allHookEventsEnabled`.
 */
let userPromptSubmitStartAndEndEnabled = false

export function registerHookEventHandler(
  handler: HookEventHandler | null,
): void {
  eventHandler = handler
  if (handler && pendingEvents.length > 0) {
    for (const event of pendingEvents.splice(0)) {
      handler(event)
    }
  }
}

function emit(event: HookExecutionEvent): void {
  if (eventHandler) {
    eventHandler(event)
  } else {
    pendingEvents.push(event)
    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents.shift()
    }
  }
}

/**
 * Base emission gate — official v311 `Gje(e)` @249400832.
 * Used by hook_progress (`uTo`) and the progress interval (`tme`), which the
 * `userPromptSubmitStartAndEndEnabled` sub-flag intentionally does NOT widen.
 */
function shouldEmit(hookEvent: string): boolean {
  if ((ALWAYS_EMITTED_HOOK_EVENTS as readonly string[]).includes(hookEvent)) {
    return true
  }
  return (
    allHookEventsEnabled &&
    (HOOK_EVENTS as readonly string[]).includes(hookEvent)
  )
}

/**
 * Start/end emission gate — official v311 `bHt(e)` @249401147:
 * `Gje(e) || e==="UserPromptSubmit" && userPromptSubmitStartAndEndEnabled`.
 * Used by hook_started (`Zpe`) and hook_response (`nf`).
 */
function shouldEmitStartOrEnd(hookEvent: string): boolean {
  if (shouldEmit(hookEvent)) {
    return true
  }
  return hookEvent === 'UserPromptSubmit' && userPromptSubmitStartAndEndEnabled
}

export function emitHookStarted(
  hookId: string,
  hookName: string,
  hookEvent: string,
): void {
  // Official `Zpe` gates on `bHt` (start/end gate), not the base `Gje`.
  if (!shouldEmitStartOrEnd(hookEvent)) return

  emit({
    type: 'started',
    hookId,
    hookName,
    hookEvent,
  })
}

export function emitHookProgress(data: {
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}): void {
  if (!shouldEmit(data.hookEvent)) return

  emit({
    type: 'progress',
    ...data,
  })
}

export function startHookProgressInterval(params: {
  hookId: string
  hookName: string
  hookEvent: string
  getOutput: () => Promise<{ stdout: string; stderr: string; output: string }>
  intervalMs?: number
}): () => void {
  if (!shouldEmit(params.hookEvent)) return () => {}

  let lastEmittedOutput = ''
  const interval = setInterval(() => {
    void params.getOutput().then(({ stdout, stderr, output }) => {
      if (output === lastEmittedOutput) return
      lastEmittedOutput = output
      emitHookProgress({
        hookId: params.hookId,
        hookName: params.hookName,
        hookEvent: params.hookEvent,
        stdout,
        stderr,
        output,
      })
    })
  }, params.intervalMs ?? 1000)
  interval.unref()

  return () => clearInterval(interval)
}

export function emitHookResponse(data: {
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}): void {
  // Always log full hook output to debug log for verbose mode debugging
  const outputToLog = data.stdout || data.stderr || data.output
  if (outputToLog) {
    logForDebugging(
      `Hook ${data.hookName} (${data.hookEvent}) ${data.outcome}:\n${outputToLog}`,
    )
  }

  // Official `nf` gates on `bHt` (start/end gate), not the base `Gje`.
  if (!shouldEmitStartOrEnd(data.hookEvent)) return

  emit({
    type: 'response',
    ...data,
  })
}

/**
 * Enable emission of all hook event types (beyond SessionStart and Setup).
 * Called when the SDK `includeHookEvents` option is set or when running
 * in CLAUDE_CODE_REMOTE mode.
 */
export function setAllHookEventsEnabled(enabled: boolean): void {
  allHookEventsEnabled = enabled
}

/**
 * Enable emission of the UserPromptSubmit started/response (start & end)
 * events only. Official v311 sets `userPromptSubmitStartAndEndEnabled` on the
 * hook-events singleton (`SHt` @249400832); progress events stay gated by
 * `allHookEventsEnabled`.
 */
export function setUserPromptSubmitStartAndEndEnabled(enabled: boolean): void {
  userPromptSubmitStartAndEndEnabled = enabled
}

export function isUserPromptSubmitStartAndEndEnabled(): boolean {
  return userPromptSubmitStartAndEndEnabled
}

const EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS_ENV_VAR =
  'CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS'

/**
 * One-shot startup env-flag application — official v311 `uFs()` @249402502:
 * if CLAUDE_CODE_EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS is set (truthy), enable
 * the UserPromptSubmit start/end sub-flag, then ALWAYS delete the env var so
 * child processes do not inherit it. Wire into the print/startup path next to
 * the `setAllHookEventsEnabled(true)` call (official call site @258725286:
 * `if(et||i.CLAUDE_CODE_REMOTE)cFs(!0);if(uFs(),we){…}`).
 */
export function applyHookEventsEnvFlags(): void {
  if (isEnvTruthy(process.env[EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS_ENV_VAR])) {
    userPromptSubmitStartAndEndEnabled = true
  }
  delete process.env[EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS_ENV_VAR]
}

export function clearHookEventState(): void {
  eventHandler = null
  pendingEvents.length = 0
  allHookEventsEnabled = false
  userPromptSubmitStartAndEndEnabled = false
}
