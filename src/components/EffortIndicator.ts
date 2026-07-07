import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from '../constants/figures.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../utils/effort.js'
import {
  ULTRACODE_EFFORT_DESCRIPTION,
  isUltracodeEnabled,
} from '../utils/effort/ultracode.js'

/**
 * Build the text for the effort indicator, e.g. "◐ medium · /effort".
 *
 * Ultracode session mode returns a text-mode badge verbatim from the 2.1.200
 * binary: `effort: ultracode · xhigh effort + dynamic workflows for maximum
 * thoroughness` (the `${n?"effort:":Cbn}` text-mode branch of the badge render
 * fn). This is rendered as a PERSISTENT top-right borderText by
 * PromptInput.buildBorderText, not a 12s transient notification.
 *
 * Returns undefined if the model doesn't support effort (and ultracode is off
 * — ultracode requires an xhigh-capable model to activate, so the badge shows
 * whenever ultracode is on regardless of the model-effort gate).
 */
export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  // Ultracode session mode: persistent text-mode badge. Mirrors the binary's
  // `if(t)return`${n?"effort:":Cbn} ultracode · xhigh effort + …`` (text mode).
  if (isUltracodeEnabled()) {
    return `effort: ultracode · ${ULTRACODE_EFFORT_DESCRIPTION}`
  }
  if (!modelSupportsEffort(model)) return undefined
  const level = getDisplayedEffortLevel(model, effortValue)
  return `${effortLevelToSymbol(level)} ${level} · /effort`
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'xhigh':
      // 2.1.111: 'xhigh' sits between 'high' and 'max' for Opus 4.7/4.8.
      return EFFORT_XHIGH
    case 'max':
      return EFFORT_MAX
    default:
      // Defensive: level can originate from remote config. If an unknown
      // value slips through, render the high symbol rather than undefined.
      return EFFORT_HIGH
  }
}
