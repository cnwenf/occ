// CC 2.1.216 #6 (d): resume-picker hangs on failure.
//
// The CLI-entry resume picker (`--resume`/`--continue`) calls `onSelect`
// which sets `resuming=true`, then on error re-throws without ever calling
// `setResuming(false)`. `LogSelector` invokes `onSelect` fire-and-forget
// (not awaited, no try/catch), so the rejected promise becomes an unhandled
// rejection and `resuming` stays `true` forever — the spinner hangs and the
// user cannot select another session.
//
// The fix: on failure, reset `setResuming(false)` and do NOT re-throw when
// the caller is fire-and-forget. The `/resume` slash-command picker already
// shows the correct pattern (catch → `onDone('Failed to resume…')`).
//
// Extracted as a pure helper so the error-handling decision is unit-testable
// in isolation (the async onSelect handler is not).

/**
 * Whether `onSelect` should re-throw a resume error.
 *
 * When the caller is fire-and-forget (`LogSelector` calls `onSelect(log)`
 * without await), re-throwing creates an unhandled rejection and leaves the
 * UI stuck (`resuming` stays `true`). Instead, reset state and return
 * normally so the picker falls back to the selector.
 *
 * @param isCallerAwaiting  True when the caller awaits `onSelect` (can
 *                           observe the rejection); false for fire-and-forget.
 */
export function shouldRethrowResumeError(
  isCallerAwaiting: boolean,
): boolean {
  // Fire-and-forget callers cannot observe the rejection — re-throwing only
  // creates an unhandled rejection. Reset state instead.
  return isCallerAwaiting
}

/**
 * Whether the resume picker should reset its `resuming` state on error.
 *
 * Always true — on failure the UI must fall back to the selector so the user
 * can try a different session. The bug was that the catch block re-threw
 * without resetting, leaving the spinner stuck indefinitely.
 */
export function shouldResetResumingOnError(
  _error: Error,
): boolean {
  return true
}
