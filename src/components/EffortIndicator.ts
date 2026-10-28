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
import { getSentEffort } from '../utils/effort/sentEffort.js'
import {
  getTurnEffort,
  modelSupportsPerTurnEffort,
} from '../utils/effort/turnEffort.js'
import {
  ULTRACODE_EFFORT_DESCRIPTION,
  isUltracodeEnabled,
} from '../utils/effort/ultracode.js'

/**
 * CC 2.1.312 item 16 — the mid-task effort-change note ("may wait for your
 * next message"). Official indicator template UNCHANGED 311→312 (v312 `EH`
 * @275881776, byte-verified):
 *
 *   `function EH(h,x=!1,D=!1,H=!1){if(!h)return;
 *      return`${D?"effort:":jQ(h)} ${h}${x?" · ultracode":""} · ${H?"may wait for your next message":"/effort"}`}`
 *
 * The 4th flag H selects the literal `may wait for your next message` in
 * place of `/effort`. The 312 caller computes the flag (@276688231):
 *
 *   `uT = sentEffort!==null && turnEffort===null
 *         && sentEffort!==resolvedLevel && JEt(model)`
 *   `JEt(e){return Tir(e,Je(e))}`  (v312 @243468953)
 *
 * `JEt` is the per-turn-effort capability probe (`Tir` = `evn(e,n)&&
 * !HTt(Us())`, the v311 `fot` lineage) — OCC's modelSupportsPerTurnEffort.
 * `resolvedLevel` is the SENT resolver's level (the `AH`/`kWe` lineage ≡
 * getSentEffortLevel): the note means "your /effort pick has NOT been applied
 * yet — the model still runs at sentEffort and may only pick the new level up
 * on your next message".
 *
 * OCC rendering note: the official clears the note via its own state cycle;
 * OCC renders the chip as a steady borderText derived per-render, so the note
 * clears naturally once the model applies the pick (next message_start
 * rewrites the sentEffort slot → flag goes false → chip reverts to /effort).
 */
export const EFFORT_MAY_WAIT_NOTE = 'may wait for your next message'

/** Official `uT` (@276688231) — the 4-term mid-task-change-pending flag. */
export function isEffortChangePending(
  model: string,
  effortValue: EffortValue | undefined,
): boolean {
  const sent = getSentEffort()
  // term 1: `sentEffort!==null` — nothing applied yet → nothing pending
  if (sent === null) return false
  // term 2: `turnEffort===null` — an ultrathink boost owns this turn's effort
  if (getTurnEffort() != null) return false
  // term 3: `sentEffort!==resolvedLevel` — the pick already matches in-force
  const resolvedLevel = getSentEffortLevel(model, effortValue)
  if (resolvedLevel === undefined || sent === resolvedLevel) return false
  // term 4: `JEt(model)` — the model supports per-turn effort at all
  return modelSupportsPerTurnEffort(model)
}

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
  mayWaitForNextMessage = false,
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
  // CC 2.1.312 item 16 — official EH's 4th flag swaps the `/effort` tail for
  // the literal `may wait for your next message` while a mid-task pick is
  // pending (see isEffortChangePending). The `!h` falsy-level bail above is
  // official EH's own guard (`if(!h)return;`), unchanged 311→312.
  return `${effortLevelToSymbol(level)} ${level} · ${mayWaitForNextMessage ? EFFORT_MAY_WAIT_NOTE : '/effort'}`
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
