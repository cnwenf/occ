/**
 * Left-arrow discard gate — CC 2.1.218 #4.
 *
 * "the left arrow key discarded the conversation with no undo — presses right
 * after editing now ASK TO CONFIRM." (Files: REPL input handling.)
 *
 * When the user presses left-arrow at the boundary that would discard/rewind the
 * conversation, this pure helper decides whether a confirmation prompt must be
 * shown before the discard happens:
 *   - hasEdits + cursor at the discard boundary (start)  -> CONFIRM
 *   - no edits (lossless / empty input)                   -> discard immediately
 *   - mid-text (cursor not at start)                     -> normal cursor movement
 *
 * Kept pure (no React / no Ink) so it is trivially unit-testable and reusable
 * from the message-actions edit cap in REPL.tsx.
 */

/**
 * @param input         The current prompt/edit buffer text.
 * @param hasEdits      True when real edits exist after the selected message
 *                      (file changes or non-synthetic trailing messages) — i.e.
 *                      discarding would lose work.
 * @param cursorAtStart True when the cursor is at the left boundary where
 *                      left-arrow would trigger the discard/rewind (not mid-text).
 * @returns True when a confirm prompt must be shown before discarding.
 */
export function shouldConfirmLeftArrowDiscard(
  input: string,
  hasEdits: boolean,
  cursorAtStart: boolean,
): boolean {
  // Whitespace-only buffer behaves like empty — nothing real to lose.
  const hasRealText = input.trim().length > 0;
  return hasEdits && cursorAtStart && hasRealText;
}
