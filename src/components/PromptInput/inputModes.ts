import type { HistoryMode } from 'src/hooks/useArrowKeyHistory.js'
import type { PromptInputMode } from 'src/types/textInputTypes.js'

export function prependModeCharacterToInput(
  input: string,
  mode: PromptInputMode,
): string {
  switch (mode) {
    case 'bash':
      return `!${input}`
    default:
      return input
  }
}

export function getModeFromInput(input: string): HistoryMode {
  if (input.startsWith('!')) {
    return 'bash'
  }
  return 'prompt'
}

export function getValueFromInput(input: string): string {
  const mode = getModeFromInput(input)
  if (mode === 'prompt') {
    return input
  }
  return input.slice(1)
}

export function isInputModeCharacter(input: string): boolean {
  return input === '!'
}

/**
 * Official 2.1.273 keypress-dispatch guard (byte-verified:
 * `pe!==void 0&&y.offset===D.length&&lBe(A)&&pe()!==hg(A)`), extracted as a
 * pure predicate. The mode-switch path (insert + cursor-left, so the prefix
 * char is consumed by the mode indicator) fires only when ALL hold:
 *   - a current-mode getter exists (host supports input modes),
 *   - the cursor is at the very start of the input,
 *   - the typed char is an input-mode character (`!`), AND
 *   - the current mode DIFFERS from the mode the char maps to.
 * v2.1.272 lacked the last clause (`ye!==void 0&&b.offset===N.length&&wje(C)`),
 * so a `!` typed while already in shell mode was swallowed as a (redundant)
 * mode switch — making negated commands like `! grep -v x` untypable in bash
 * mode. Returns true when the mode-switch path should run instead of a plain
 * insert.
 */
export function shouldTriggerModeSwitch(
  keystroke: string,
  isAtStart: boolean,
  currentMode: PromptInputMode | undefined,
): boolean {
  return (
    currentMode !== undefined &&
    isAtStart &&
    isInputModeCharacter(keystroke) &&
    currentMode !== getModeFromInput(keystroke)
  )
}

/**
 * Official 2.1.276 VALUE-shaped mode-switch predicate (byte-verified from the
 * v276 inputModes module @202985169, exported there as `Twr`):
 *   `function Twr({nextValue:t,value:r,cursorOffset:n,mode:o}){
 *      let e=gg(t);
 *      if(n!==0||e==="prompt"||e===o)return!1;
 *      return t.length===r.length+1||r.length===0}`
 * (`gg` = getModeFromInput.) v274's module had no such predicate — only the
 * keystroke-shaped `aGe`/`tze` char test — so the vim engine could not tell
 * that a just-produced value flips the input mode.
 *
 * The switch fires when ALL hold:
 *   - the cursor was at offset 0 when the value was produced,
 *   - the NEXT value maps to a non-prompt mode (i.e. it starts with `!`),
 *   - that mode DIFFERS from the current one (already in shell mode, a leading
 *     `!` is content — `! grep -v x` stays typable), AND
 *   - the value grew by exactly one character, or it was empty before (the
 *     multi-char-into-empty case, e.g. tab-accepting `! gcloud auth login`).
 *
 * Callers that set the cursor offset themselves (the vim engine) use this to
 * compensate for the mode-prefix character the host consumes: the `!` becomes
 * the mode indicator instead of buffer content, so the offset lands one column
 * too far right without the `-1`.
 */
export function shouldSwitchModeFromValue({
  nextValue,
  value,
  cursorOffset,
  mode,
}: {
  nextValue: string
  value: string
  cursorOffset: number
  mode: PromptInputMode
}): boolean {
  const nextMode = getModeFromInput(nextValue)
  if (cursorOffset !== 0 || nextMode === 'prompt' || nextMode === mode) {
    return false
  }
  return nextValue.length === value.length + 1 || value.length === 0
}
