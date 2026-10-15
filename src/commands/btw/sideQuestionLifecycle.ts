/**
 * Official v299 (#105 + #166) — lifecycle for NON-INTERACTIVE (SDK/headless)
 * /btw side questions. Recovered from the v299 binary (s299 btw SDK chunk):
 *
 *   two=660000,
 *   _Ht="side_question timed out: the host did not answer in time"
 *   ... xt=await Ht(ut,two,_Ht).finally(...)
 *   if(xt.cancelled) i("tengu_sdk_side_question_cancelled",{}), et(F,"Side question cancelled")
 *   ... catch(ut){ if(l(ut)===_Ht) t(`side_question: no answer by the deadline,
 *       giving the run up (request_id ...)`), _e.abort(...), et(F,_Ht) ... }
 *
 * and from the non-interactive runner `yt` + panel adoption path:
 *   h={question:i,settled:new Promise(...),abort:()=>b.abort()}; f.setInFlight(h)
 *   (dedupe: an identical in-flight question is ADOPTED — `g=await m.settled` —
 *    never run twice)
 *
 * Fixes ported:
 *  - #166: a side question unanswered for 11 minutes (660000 ms) times out;
 *    the run's controller is aborted and the caller responds with `_Ht`.
 *  - #105a: pending side questions are cancelled at session end
 *    (`cancelAllPendingSideQuestions`, wired via registerCleanup in print.ts).
 *  - #105b: an identical question already in flight is not started twice —
 *    the second caller awaits the in-flight outcome (official adoption).
 *
 * Timers are injectable for fake-clock tests (same pattern as
 * components/deferredRowCollapse.ts).
 */

import { createAbortController } from '../../utils/abortController.js'

/** Official `two` — 11 minutes. */
export const SIDE_QUESTION_TIMEOUT_MS = 660000

/** Official `_Ht` — byte-faithful timeout message. */
export const SIDE_QUESTION_TIMEOUT_MESSAGE =
  'side_question timed out: the host did not answer in time'

/** Official cancellation response text (paired with tengu_sdk_side_question_cancelled). */
export const SIDE_QUESTION_CANCELLED_MESSAGE = 'Side question cancelled'

export type SideQuestionOutcome<T> =
  | { type: 'answer'; value: T }
  | { type: 'timeout' }
  | { type: 'cancelled' }
  | { type: 'error'; error: unknown }

type TimerHandle = ReturnType<typeof setTimeout>

type InFlightEntry = {
  controller: AbortController
  outcome: Promise<SideQuestionOutcome<unknown>>
}

// Module-level in-flight registry keyed by question (official dedupes on
// question identity: `k.question===b`, panel adopts via `inFlight.settled`).
const inFlight = new Map<string, InFlightEntry>()

export type TrackedSideQuestionDeps<T> = {
  question: string
  /**
   * The actual side-question run. Receives the lifecycle AbortController —
   * wire it (e.g. as a child of the fork's toolUseContext.abortController)
   * so timeout/session-end aborts propagate into the forked agent.
   */
  run: (controller: AbortController) => Promise<T>
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle
  clearTimeoutFn?: (handle: TimerHandle) => void
}

/**
 * Run a non-interactive side question with the official lifecycle:
 * in-flight dedupe, 660000 ms timeout, session-end cancellation.
 * Resolves (never rejects) with a discriminated outcome.
 */
export function runTrackedSideQuestion<T>(
  deps: TrackedSideQuestionDeps<T>,
): Promise<SideQuestionOutcome<T>> {
  const existing = inFlight.get(deps.question)
  if (existing) {
    // #105b dedupe: identical question already in flight — adopt it
    // (official: panel mounts "adopting the running side question",
    // `g=await m.settled`) instead of starting a second run.
    return existing.outcome as Promise<SideQuestionOutcome<T>>
  }
  const controller = createAbortController()
  const outcome = executeTracked(deps, controller)
  inFlight.set(deps.question, {
    controller,
    outcome: outcome as Promise<SideQuestionOutcome<unknown>>,
  })
  return outcome
}

/**
 * #105a: abort every pending non-interactive side question (session end).
 * Each pending run's outcome resolves as 'cancelled'; registry entries are
 * removed by executeTracked's finally as the runs settle.
 */
export function cancelAllPendingSideQuestions(): void {
  for (const entry of inFlight.values()) {
    entry.controller.abort()
  }
}

/** Test/observability helper: number of side questions currently in flight. */
export function getPendingSideQuestionCount(): number {
  return inFlight.size
}

async function executeTracked<T>(
  deps: TrackedSideQuestionDeps<T>,
  controller: AbortController,
): Promise<SideQuestionOutcome<T>> {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
  let timer: TimerHandle | undefined
  try {
    const timeoutRace = new Promise<'timeout'>(resolve => {
      timer = setTimeoutFn(() => resolve('timeout'), SIDE_QUESTION_TIMEOUT_MS)
    })
    const cancelRace = new Promise<'cancelled'>(resolve => {
      // Guarantees a prompt 'cancelled' outcome even if run() ignores the
      // signal (official yt maps an aborted run to null/cancelled:
      // `v=b.signal.aborted?null:qe(C)`).
      controller.signal.addEventListener('abort', () => resolve('cancelled'), {
        once: true,
      })
    })
    // run() is caught here so a late rejection after a timeout/cancel race
    // can never surface as an unhandled rejection.
    const runRace = deps
      .run(controller)
      .then((value): SideQuestionOutcome<T> => ({ type: 'answer', value }))
      .catch((error: unknown): SideQuestionOutcome<T> =>
        controller.signal.aborted
          ? { type: 'cancelled' }
          : { type: 'error', error },
      )
    const raced = await Promise.race([runRace, timeoutRace, cancelRace])
    if (raced === 'timeout') {
      // Official: give the run up at the deadline and abort it
      // (`_e.abort(...)`, then respond with the `_Ht` error).
      controller.abort()
      return { type: 'timeout' }
    }
    if (raced === 'cancelled') {
      return { type: 'cancelled' }
    }
    return raced
  } finally {
    if (timer !== undefined) clearTimeoutFn(timer)
    // Drop our registry entry (only if it is still ours — a cancel-then-reask
    // may already have registered a newer run for the same question).
    if (inFlight.get(deps.question)?.controller === controller) {
      inFlight.delete(deps.question)
    }
  }
}
