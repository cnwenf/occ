// CC 2.1.216 #12: Esc-Esc at an idle prompt opens the rewind (message
// selector) picker in long-running sessions that have background tasks.
//
// Previously the gate used `!isLoading`, where `isLoading = isQueryActive ||
// isExternalLoading`. That blocked Esc-Esc whenever a background/external
// loading source was active — so in a long-running session with background
// agents running, users could not open the rewind picker via Esc-Esc.
//
// The fix keys off the MAIN query loop only (`isQueryActive`). When the main
// loop is idle (even if background/external loading is active), Esc-Esc opens
// the picker. When the main loop is active, Esc cancels the in-flight request
// instead.
//
// Extracted as a pure helper so the gate condition is unit-testable in
// isolation (Ink's useInput handler is not).

/**
 * Whether a double-Esc at an idle prompt should open the rewind picker.
 *
 * @param input         Current prompt input text.
 * @param messagesLength Number of conversation messages on screen.
 * @param isQueryActive  Whether the MAIN query loop is in flight (NOT the
 *                       composite isLoading — background/external loading
 *                       must not block the picker).
 */
export function shouldOpenRewindOnEscEsc(
  input: string,
  messagesLength: number,
  isQueryActive: boolean,
): boolean {
  // Non-empty input: first Esc clears the input, don't open the picker.
  if (input.length > 0) return false
  // No messages means nothing to rewind to.
  if (messagesLength === 0) return false
  // Main query loop active: Esc should cancel the request, not open picker.
  if (isQueryActive) return false
  return true
}
