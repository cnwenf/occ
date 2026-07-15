/**
 * Pure selection-toggle helpers for multi-select components (CC 2.1.208#4).
 *
 * Extracted from use-multi-select-state.ts so the mouse-click dispatch path
 * (`onClick → state.toggleValue(value)`) can be unit-tested without rendering
 * React/Ink — OCC's test runner has no component-test harness.
 */

/**
 * Immutably add or remove a value from a selection list.
 *
 * - If `value` is already present → returns a new list without it.
 * - If `value` is absent → returns a new list with it appended.
 *
 * The input array is never mutated (immutability invariant per coding-style).
 */
export function toggleValueInSelection<T>(
  prev: readonly T[],
  value: T,
): T[] {
  return prev.includes(value)
    ? prev.filter(v => v !== value)
    : [...prev, value]
}

/**
 * The click-dispatch action the multi-select render layer resolves for an
 * option, mirroring the official binary's inline factory:
 *
 *   disabled?void 0 : type==="input" ? focusOption : toggleValue
 *
 * Returns a discriminated union so the decision tree (not the side-effecting
 * state methods) is unit-testable.
 */
export type MultiSelectClickAction = 'none' | 'focus' | 'toggle'

export function getMultiSelectClickAction(
  option: { disabled?: boolean; type?: string },
  isDisabled: boolean,
): MultiSelectClickAction {
  if (isDisabled || option.disabled === true) return 'none'
  if (option.type === 'input') return 'focus'
  return 'toggle'
}
