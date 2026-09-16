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
