/**
 * Prompt-input dialog suppression (official v299 #091 — ask withdrawal
 * lifecycle: `ask_withdrawn` / "standing request taken back unsent" /
 * `unreachable_unaccepted`, binary @112233225).
 *
 * While the user is actively typing, interrupt dialogs (permission prompts,
 * asks, elicitations) are suppressed so keystrokes don't accidentally dismiss
 * or answer a prompt the user hasn't read. The official v299 fix adds the
 * release gate below: a held ask must never be dropped into the keystroke
 * stream while unsent draft text is present — otherwise the released dialog's
 * Select consumes the next Enter the user meant for sending their message
 * (an accidental permission grant). The ask stays withdrawn until the draft
 * is sent or cleared.
 */

/** How long after the last keystroke before deferred dialogs may be shown. */
export const PROMPT_SUPPRESSION_MS = 1500;

/**
 * Release-gate predicate: suppressed dialogs may only re-enter the keystroke
 * stream once the prompt input holds no unsent text.
 *
 * @param unsentInputText current prompt-input value at debounce-release time
 * @returns true when it is safe to surface held dialogs (input sent/cleared)
 */
export function shouldReleaseSuppressedDialogs(unsentInputText: string): boolean {
  return unsentInputText.trim().length === 0;
}
