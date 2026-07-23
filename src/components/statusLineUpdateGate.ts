// CC 2.1.216 #6 (c): statusline runs twice on resume.
//
// On resume, the conversation transcript already has assistant messages, so
// `lastAssistantMessageId` is non-null on the very first render. The mount
// effect fires `doUpdate()` (1st execution), and the change-detection effect
// sees `non-null !== null` (the ref's initial value) → fires `scheduleUpdate()`
// (2nd execution, 300 ms debounced). The statusline command therefore runs
// twice on resume.
//
// The fix: initialize `previousStateRef.current.messageId` to the initial
// `lastAssistantMessageId` prop (not `null`). Then the change-detection
// effect's condition is false on mount → only the mount effect fires.
//
// Extracted as a pure helper so the gate condition is unit-testable in
// isolation (Ink's useEffect is not).

/**
 * Whether the statusline change-detection effect should fire for a message-ID
 * change. The bug: on resume the ref was initialized to `null` while the prop
 * was already non-null, causing a spurious second update on mount.
 *
 * @param currentMessageId   The latest `lastAssistantMessageId` prop.
 * @param previousMessageId  The ref's stored message ID (initialized to the
 *                            initial prop value per the fix, not `null`).
 */
export function shouldStatusLineUpdateForMessageChange(
  currentMessageId: string | null,
  previousMessageId: string | null,
): boolean {
  return currentMessageId !== previousMessageId
}

/**
 * The correct initial value for `previousStateRef.current.messageId`.
 *
 * CC 2.1.216 #6 (c): must be the initial `lastAssistantMessageId` prop, NOT
 * `null`. When it matches the initial prop, the change-detection effect does
 * not fire on mount, preventing the double-run on resume.
 */
export function initStatusLinePreviousMessageId(
  initialLastAssistantMessageId: string | null,
): string | null {
  return initialLastAssistantMessageId
}
