/**
 * 2.1.280 #042 wiring-regression harness (shared).
 *
 * Helpers for the WIRING-LEVEL tests that enter through the production tool
 * callers (BashTool / PowerShellTool) instead of calling
 * `classifyShellTaskResult` directly. The existing unit tests
 * (shellTaskResult042.test.ts) pin the classifier contract but passed even
 * when no production caller passed `shell` (acceptance defect #042: the
 * per-shell dispatch arm was dead code). The tests built on this harness are
 * mutation-resistant against:
 *   (a) any of the 4 call sites dropping its `shell:` argument,
 *   (b) the persistence spread in LocalShellTask.tsx being removed,
 *   (c) the classifier per-shell dispatch being removed.
 *
 * Not a *.test.ts file — bun test does not execute it directly.
 */

import type { AppState } from '../../../state/AppState.js'

/** Minimal AppState shape the task framework + notification path touch. */
export function makeInitialAppState(): Record<string, unknown> {
  return {
    tasks: {},
    // enqueueShellNotification → abortSpeculation reads prev.speculation.status
    speculation: { status: 'idle' },
    // BashTool/PowerShellTool call() → resetCwdIfOutsideProject reads it from
    // getAppState() on the main thread (fast-path no-op when cwd is unmoved).
    toolPermissionContext: { additionalWorkingDirectories: [] },
  }
}

export type TaskSnapshot = Record<string, unknown>

export type Harness = {
  setAppState: (fn: (prev: any) => any) => void
  getAppState: () => any
  /** Latest state (tasks mutated through setAppState updaters). */
  getState: () => Record<string, any>
  /** Shallow task snapshots captured on EVERY setAppState write — survives
   * unregisterForeground removing the task from the live state. */
  history: TaskSnapshot[][]
}

export function makeHarness(): Harness {
  let state: any = makeInitialAppState()
  const history: TaskSnapshot[][] = []
  const setAppState = (fn: (prev: any) => any): void => {
    state = fn(state)
    history.push(Object.values(state.tasks ?? {}).map((t: any) => ({ ...t })))
  }
  return {
    setAppState,
    getAppState: () => state,
    getState: () => state,
    history,
  }
}

/** Build a minimal ToolUseContext for BashTool.call / PowerShellTool.call. */
export function makeToolContext(
  harness: Harness,
  extra: { toolUseId?: string; setToolJSX?: (v: unknown) => void } = {},
): any {
  return {
    abortController: new AbortController(),
    getAppState: harness.getAppState,
    setAppState: harness.setAppState,
    setToolJSX: extra.setToolJSX,
    toolUseId: extra.toolUseId ?? 'tu-042-wiring',
    readFileState: new Map(),
  }
}

/** Poll `pred` until true; throws (failing the test) after timeoutMs. */
export async function waitFor(
  pred: () => boolean,
  timeoutMs = 8000,
  label = 'condition',
): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** First captured snapshot matching `pred` across all setAppState writes. */
export function findSnapshot(
  history: TaskSnapshot[][],
  pred: (task: TaskSnapshot) => boolean,
): TaskSnapshot | undefined {
  for (const snapshots of history) {
    for (const task of snapshots) {
      if (pred(task)) return task
    }
  }
  return undefined
}

/** True once the task reached a terminal classifier status. */
export function isTerminal(task: any): boolean {
  return (
    task !== undefined &&
    (task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'killed')
  )
}

/** The queued <task-notification> XML for `taskId`, if any. */
export function findNotification(
  queue: readonly { value?: unknown }[],
  taskId: string,
): string | undefined {
  for (const cmd of queue) {
    if (typeof cmd.value === 'string' && cmd.value.includes(taskId)) {
      return cmd.value
    }
  }
  return undefined
}

/** Re-exported for callers that build a ToolUseContext inline. */
export type { AppState }
