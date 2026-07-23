import { describe, expect, test } from 'bun:test';
import { shouldConfirmLeftArrowDiscard } from './messageActionsLeftArrowGate.js';

// CC 2.1.218 #4 — "the left arrow key discarded the conversation with no undo —
// presses right after editing now ASK TO CONFIRM."
//
// The gate decides: when the user presses left-arrow at the boundary that would
// discard/rewind the conversation, do we need to ask for confirmation first?
//   - hasEdits + cursor at start (the discard boundary)  -> CONFIRM
//   - no edits (lossless / empty)                        -> discard immediately
//   - mid-text (cursor not at start)                    -> normal cursor move

describe('shouldConfirmLeftArrowDiscard', () => {
  test('returns true when user has edited and cursor is at the discard boundary', () => {
    // Arrange — user just edited, cursor at start (left-arrow would discard)
    const input = 'fix the bug in auth.ts';
    const hasEdits = true;
    const cursorAtStart = true;

    // Act
    const result = shouldConfirmLeftArrowDiscard(input, hasEdits, cursorAtStart);

    // Assert — must ASK TO CONFIRM before discarding
    expect(result).toBe(true);
  });

  test('returns false when there are no edits — discard immediately (current behavior)', () => {
    // Arrange — lossless: nothing edited after the message
    const input = '';
    const hasEdits = false;
    const cursorAtStart = true;

    // Act
    const result = shouldConfirmLeftArrowDiscard(input, hasEdits, cursorAtStart);

    // Assert — no confirm, direct restore (no undo needed)
    expect(result).toBe(false);
  });

  test('returns false when cursor is mid-text — normal cursor movement', () => {
    // Arrange — left-arrow in the middle of the text just moves the cursor
    const input = 'fix the bug in auth.ts';
    const hasEdits = true;
    const cursorAtStart = false;

    // Act
    const result = shouldConfirmLeftArrowDiscard(input, hasEdits, cursorAtStart);

    // Assert — not a discard boundary, no confirm
    expect(result).toBe(false);
  });

  // --- Edge cases ---

  test('returns false for null-ish input with no edits even at start', () => {
    expect(shouldConfirmLeftArrowDiscard('', false, true)).toBe(false);
  });

  test('returns false when hasEdits is false regardless of cursor position', () => {
    expect(shouldConfirmLeftArrowDiscard('some text', false, false)).toBe(false);
    expect(shouldConfirmLeftArrowDiscard('some text', false, true)).toBe(false);
  });

  test('returns false when cursor is not at start regardless of edits', () => {
    expect(shouldConfirmLeftArrowDiscard('edited text', true, false)).toBe(false);
  });

  test('returns true only when ALL three conditions hold (edits + at-start + non-empty)', () => {
    expect(shouldConfirmLeftArrowDiscard('edited', true, true)).toBe(true);
    // drop any one condition -> false
    expect(shouldConfirmLeftArrowDiscard('', true, true)).toBe(false);
    expect(shouldConfirmLeftArrowDiscard('edited', false, true)).toBe(false);
    expect(shouldConfirmLeftArrowDiscard('edited', true, false)).toBe(false);
  });

  test('treats whitespace-only input as empty for discard gating', () => {
    // A blanked-out prompt behaves like empty — no real edit to lose
    expect(shouldConfirmLeftArrowDiscard('   ', true, true)).toBe(false);
  });
});
