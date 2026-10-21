import chalk from 'chalk'
import { color as themeColor } from 'src/components/design-system/color'
import { useThemeSetting } from 'src/components/design-system/ThemeProvider'
import { getInitialSettings } from 'src/utils/settings/settings'
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
  getSentEffortLevel,
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
  // Ultracode session mode: symbol-mode badge — just "ultracode" in the
  // effortUltra theme color (rgb(135,0,255) = purple). Mirrors the binary's
  // Ro("effortUltra",theme)("ultracode") — NOT the long text-mode string.
  if (isUltracodeEnabled()) {
    const themeName = getInitialSettings().theme ?? 'dark'
    return themeColor('effortUltra', themeName)('ultracode')
  }
  if (!modelSupportsEffort(model)) return undefined
  // CC 2.1.304 #35: official indicator resolver EE switched from the display
  // guesser (oR — v303: `bw(...)??"high"`, fabricating a level that was never
  // sent) to the SENT resolver (kWe):
  //   `function EE(h,R,L){return L?void 0:kWe(R,h)}`
  // and the renderer Mne bails on a falsy level (`if(!h)return;`). So when no
  // effort parameter is sent (env auto/unset, no settings cap, no model
  // default) the prompt indicator disappears instead of showing a guessed
  // level. (v304's EE also dropped v303's internal `Gb` model-support gate —
  // official relies on ek's internal `Nh` gate instead. OCC reduction: OCC's
  // resolveAppliedEffort has no internal support gate, so the
  // modelSupportsEffort gate above stays at the call site — same observable
  // outcome.)
  const level = getSentEffortLevel(model, effortValue)
  if (level === undefined) return undefined
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
