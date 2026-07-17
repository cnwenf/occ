/**
 * CC 2.1.212: MCP tool calls auto-background after a timeout.
 *
 * Ports the official 2.1.212 behavior: an MCP tool call running longer than
 * the auto-background threshold (default 120000ms / 2 min, override via
 * CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS) is moved to the background so the
 * session stays usable. The tool is NOT killed on backgrounding — it keeps
 * running under its own AbortController and its eventual result is delivered
 * via the background-tasks system (the model sees a "moved to background"
 * result immediately with the task id).
 *
 * Two public pieces:
 *   - getMcpAutoBackgroundMs(tool, { isNonInteractiveSession }) — the config
 *     ladder (official Bcy). Returns 0 when auto-background is disabled.
 *   - callMcpToolWithAutoBackground({ run, ... }) — the backgrounding
 *     primitive (official Ucy). Wraps an MCP tool-call invocation (`run`,
 *     taking an AbortSignal) with the threshold race + background-task
 *     registration.
 *
 * Non-interactive sessions only auto-background when the env var
 * CLAUDE_AUTO_BACKGROUND_TASKS (no CLAUDE_CODE_ prefix — note the different
 * prefix) is truthy. In interactive REPL sessions, auto-background is ON by
 * default (120000ms).
 */

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { feature } from '../../utils/featureFlags.js'
import type { McpBackgroundTaskState } from '../../tasks/McpBackgroundTask/McpBackgroundTask.js'
import {
  makeMcpBackgroundTask,
  registerMcpBackgroundTask,
} from '../../tasks/McpBackgroundTask/McpBackgroundTask.js'
import type { SetAppState } from '../../Task.js'

/** Binary-verified default threshold (official $cy = 120000). */
export const DEFAULT_MCP_AUTO_BACKGROUND_MS = 120000

/** Binary-verified max clamp (official Ncy = 2147483647, INT_MAX). */
export const MAX_MCP_AUTO_BACKGROUND_MS = 2147483647

/**
 * Tool kinds that never auto-background (official EXCLUDED_TOOL_TYPES). The
 * exact set could not be determined from the binary; per the task contract,
 * an empty set is used (no exclusions) rather than inventing ones. Document
 * here so a future binary re-verification can fill it in.
 */
export const EXCLUDED_TOOL_TYPES: Set<string> = new Set()

/**
 * True when running in strict pipe/print non-interactive mode (official pv()).
 *
 * OCC collapses pipe/print and SDK non-interactive sessions into a single
 * `!isInteractive` flag and has no distinct pipe-mode signal. To stay
 * faithful to the upstream 5-step ladder (where pipe mode short-circuits to
 * 0 BEFORE the CLAUDE_AUTO_BACKGROUND_TASKS non-interactive gate), this
 * defaults to false at runtime and the step-3 non-interactive gate handles
 * print mode. The step-2 path is exercised via the injectable override
 * (tests pass `isPipeNonInteractiveMode: () => true`).
 */
export function isPipeNonInteractiveMode(): boolean {
  // OCC has no distinct pipe-mode flag; the non-interactive gate in step 3
  // covers print mode. Returning false here keeps the ladder ordered so the
  // CLAUDE_AUTO_BACKGROUND_TASKS opt-in is reachable for non-interactive
  // sessions that aren't strict pipe mode.
  return false
}

/**
 * Compute the MCP auto-background threshold (ms) for a tool call.
 * 0 means auto-background is disabled for this call.
 *
 * Faithful port of the official `Bcy(e, { isNonInteractiveSession })`:
 *  1. excluded tool type → 0
 *  2. pipe non-interactive mode → 0
 *  3. non-interactive without CLAUDE_AUTO_BACKGROUND_TASKS → 0
 *  4. CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS override (clamped to [0, INT_MAX];
 *     non-numeric → NaN → treated as disabled/0, never throws)
 *  5. feature("tengu_mcp_auto_background") default-on → 120000 else 0
 *
 * Both `isNonInteractiveSession` and `isPipeNonInteractiveMode` are injectable
 * for testing; at runtime they default to the real session-mode checks.
 */
export function getMcpAutoBackgroundMs(
  tool?: { type?: string } | undefined,
  {
    isNonInteractiveSession = getIsNonInteractiveSession(),
    isPipeNonInteractiveMode = (): boolean => isPipeNonInteractiveModeDefault(),
  }: {
    isNonInteractiveSession?: boolean
    isPipeNonInteractiveMode?: () => boolean
  } = {},
): number {
  // 1. Excluded tool kinds never auto-background.
  if (EXCLUDED_TOOL_TYPES.has(tool?.type ?? '')) {
    return 0
  }

  // 2. Pipe/SDK non-interactive mode → 0 (official pv()).
  if (isPipeNonInteractiveMode()) {
    return 0
  }

  // 3. Non-interactive sessions only auto-background when the operator has
  //    opted in via CLAUDE_AUTO_BACKGROUND_TASKS (note: no CLAUDE_CODE_ prefix).
  if (isNonInteractiveSession && !process.env.CLAUDE_AUTO_BACKGROUND_TASKS) {
    return 0
  }

  // 4. Env override (applies in both interactive and non-interactive when
  //    enabled). Parse as integer; non-numeric → NaN → disabled (0). Clamp
  //    to [0, INT_MAX].
  const envOverride = process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS
  if (envOverride !== undefined) {
    const parsed = parseInt(envOverride, 10)
    if (Number.isNaN(parsed)) {
      return 0
    }
    return Math.min(Math.max(0, parsed), MAX_MCP_AUTO_BACKGROUND_MS)
  }

  // 5. Default gated by the tengu_mcp_auto_background feature flag, which
  //    defaults ON upstream (feature("tengu_mcp_auto_background", true)).
  //    OCC's allowlist membership makes feature() return true here.
  return feature('tengu_mcp_auto_background')
    ? DEFAULT_MCP_AUTO_BACKGROUND_MS
    : 0
}

// Wrapper so the default param eval doesn't recurse through the exported
// function name (keeps the call site honest if the export is shadowed).
function isPipeNonInteractiveModeDefault(): boolean {
  return isPipeNonInteractiveMode()
}

/**
 * Sleep that resolves after `ms` unless the abort signal fires first
 * (then it rejects/voids so the race in callMcpToolWithAutoBackground can
 * observe it). Mirrors the official `sleep(ms, signal).then(() => "timeout")`
 * — the resolved value is "timeout".
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<'timeout'> {
  return new Promise<'timeout'>(resolve => {
    if (signal.aborted) {
      // Resolving (not rejecting) keeps the race semantics intact: the
      // caller treats a non-"settled" race outcome as a timeout candidate.
      resolve('timeout')
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve('timeout')
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve('timeout')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The outcome of an auto-background-wrapped MCP tool call.
 *
 * - `settled`: the tool finished within the threshold (or the parent
 *   aborted); `result` is the tool's own return value.
 * - `backgrounded`: the tool exceeded the threshold with no pending
 *   elicitation; it was moved to the background and is still running under
 *   its own AbortController. The model is told it moved to background with
 *   the task id; the eventual result arrives later via the background-tasks
 *   system.
 */
export type McpAutoBackgroundOutcome<T> =
  | { kind: 'settled'; result: T }
  | {
      kind: 'backgrounded'
      task: McpBackgroundTaskState
      serverName: string
      toolName: string
      toolUseId: string
    }

/**
 * An adapter the auto-background primitive uses to register the backgrounded
 * task. Wraps OCC's registerTask(task, setAppState) so the primitive stays
 * decoupled from AppState. The official binary calls `taskRegistry.register(g)`.
 */
export type McpBackgroundTaskRegistry = {
  register(task: McpBackgroundTaskState): void
}

/**
 * Build a real task-registry adapter backed by AppState. The caller (the MCP
 * dispatch site) constructs this from its setAppState.
 */
export function makeAppStateTaskRegistry(
  setAppState: SetAppState,
): McpBackgroundTaskRegistry {
  return {
    register(task) {
      registerMcpBackgroundTask(task, setAppState)
    },
  }
}

/**
 * The MCP tool-call invocation function. Takes an AbortSignal (the
 * background task's own controller signal) and returns a promise of the tool
 * result. This is the existing MCP-tool-invocation function the dispatch site
 * already calls — wrapped here so the auto-background primitive can race it
 * against the threshold.
 */
export type McpToolRunFn<T> = (signal: AbortSignal) => Promise<T>

/**
 * Backgrounding primitive (official Ucy). Wraps an MCP tool-call `run` with
 * the auto-background threshold race. If the tool settles within the
 * threshold (or the parent aborts), returns its result normally. If it
 * exceeds the threshold with no pending elicitation, registers an mcp_task
 * background task, fires `onBackgrounded`, and returns a `backgrounded`
 * outcome — the tool keeps running under its own AbortController.
 *
 * The `run` is started with a child AbortController linked to the parent so
 * a parent abort propagates to the backgrounded call.
 */
export async function callMcpToolWithAutoBackground<T>({
  run,
  serverName,
  toolName,
  toolUseId,
  parentAbortController,
  taskRegistry,
  autoBackgroundMs,
  hasPendingElicitation,
  onBackgrounded,
}: {
  run: McpToolRunFn<T>
  serverName: string
  toolName: string
  toolUseId: string
  parentAbortController: AbortController
  taskRegistry: McpBackgroundTaskRegistry
  autoBackgroundMs: number
  hasPendingElicitation?: () => boolean
  onBackgrounded?: () => void
}): Promise<McpAutoBackgroundOutcome<T>> {
  // 1. The background task's OWN controller — survives after the foreground
  //    turn ends. Linked to the parent so a parent abort propagates.
  const backgroundController =
    createChildAbortController(parentAbortController)

  // 3. Start the MCP tool call (async; returns a promise of the result).
  //    f resolves to "settled" whether the call fulfilled or rejected.
  const resultPromise = run(backgroundController.signal)
  const settledPromise = resultPromise.then(
    () => 'settled' as const,
    () => 'settled' as const,
  )

  // 4. The timeout-race controller (used to cancel the sleep once the tool
  //    settles). Official `m`.
  const raceController = new AbortController()

  // 5. Loop: race the settled promise against the threshold sleep.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const winner = await Promise.race([
      settledPromise,
      sleepWithAbort(autoBackgroundMs, raceController.signal),
    ])

    if (
      winner === 'settled' ||
      parentAbortController.signal.aborted
    ) {
      // Tool finished in time, or parent aborted → cleanup + return normally.
      raceController.abort()
      const result = await resultPromise
      return { kind: 'settled', result }
    }

    // Timeout fired. If there's a pending MCP elicitation (the server is
    // asking the user something), keep waiting — don't background mid-
    // elicitation. Loop again with a fresh threshold race.
    if (hasPendingElicitation?.()) {
      continue
    }

    // No pending elicitation and the threshold elapsed → background it.
    break
  }

  // 6. On backgrounding: build + register the mcp_task background task.
  const task = makeMcpBackgroundTask({
    serverName,
    toolName,
    toolUseId,
    abortController: backgroundController,
  })
  taskRegistry.register(task)
  onBackgrounded?.()

  // Suppress unhandled-rejection from the still-pending run: its eventual
  // settlement is handled by the background-task completion observer, not by
  // this returned promise. We attach a no-op catcher so a backgrounded call
  // that later rejects doesn't emit unhandledRejection.
  resultPromise.catch(() => {
    /* backgrounded — result handled by the task completion observer */
  })

  return {
    kind: 'backgrounded',
    task,
    serverName,
    toolName,
    toolUseId,
  }
}
