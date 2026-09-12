import { describe, expect, test } from 'bun:test'
import {
  AUTO_REJECT_MESSAGE,
  buildYoloRejectionMessage,
  DENIAL_WORKAROUND_GUIDANCE,
  DONT_ASK_REJECT_MESSAGE,
} from '../messages.js'

/**
 * 2.1.268 alignment: the fused DENIAL_WORKAROUND_GUIDANCE constant was split
 * into the official three pieces (byte-verified from the linux-x64 ELF):
 *
 * - base = official `ANt` (ends "...intent behind this denial. ")
 * - LEGACY_STOP_SUFFIX = official `LOr` tail
 * - AUTO_MODE_STOP_SUFFIX = official `Tjs` tail ("first try a safer method")
 *
 * AUTO_REJECT_MESSAGE / DONT_ASK_REJECT_MESSAGE keep base+legacy (official
 * `LDn`/`MQ` use `LOr`) — their rendered strings MUST NOT change, asserted
 * here against hardcoded pre-edit snapshots. buildYoloRejectionMessage
 * switches to base+auto-mode (official `H5t` uses `Tjs`).
 *
 * The official fourth variant `Ejs` (autoModeConsentFlow) is NOT ported —
 * OCC has no consent-flow surface; `H5t` only selects `Ejs` when
 * `n?.autoModeConsentFlow` is set.
 */

// Official `ANt` — shared base, byte-verified against s2s.txt.
const BASE = `IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. `

// Official `LOr` tail — legacy stop-and-explain suffix.
const LEGACY_TAIL = `If you believe this capability is essential to complete the user's request, STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.`

// Official `Tjs` tail — new 2.1.268 auto-mode stop suffix.
const AUTO_MODE_TAIL = `If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.`

// OCC's BASH_CLASSIFIER-conditional long rule hint (feature is in
// FEATURE_ALLOWLIST → live in tests); intentionally kept untouched.
const LONG_RULE_HINT = `To allow this type of action in the future, the user can add a permission rule like Bash(prompt: <description of allowed action>) to their settings. At the end of your session, recommend what permission rules to add so you don't get blocked again.`

describe('2.1.268 — denial guidance suffix split', () => {
  test('DENIAL_WORKAROUND_GUIDANCE renders identically to the pre-split fused constant', () => {
    expect(DENIAL_WORKAROUND_GUIDANCE).toBe(BASE + LEGACY_TAIL)
  })

  test('AUTO_REJECT_MESSAGE snapshot is unchanged (pre-edit hardcoded value)', () => {
    expect(AUTO_REJECT_MESSAGE('Bash')).toBe(
      `Permission to use Bash has been denied. ${BASE}${LEGACY_TAIL}`,
    )
  })

  test("DONT_ASK_REJECT_MESSAGE snapshot is unchanged (pre-edit hardcoded value)", () => {
    expect(DONT_ASK_REJECT_MESSAGE('Bash')).toBe(
      `Permission to use Bash has been denied because Claude Code is running in don't ask mode. ${BASE}${LEGACY_TAIL}`,
    )
  })

  test('legacy denial messages keep the legacy stop junction', () => {
    for (const msg of [
      AUTO_REJECT_MESSAGE('Bash'),
      DONT_ASK_REJECT_MESSAGE('Bash'),
    ]) {
      expect(msg).toContain(`request, STOP and explain to the user`)
      expect(msg).not.toContain('first try a safer method')
    }
  })

  test('buildYoloRejectionMessage uses base + auto-mode suffix (official H5t/Tjs)', () => {
    expect(buildYoloRejectionMessage('test reason')).toBe(
      `Permission for this action was denied by the Claude Code auto mode classifier. Reason: test reason. ` +
        `If you have other tasks that don't depend on this action, continue working on those. ` +
        `${BASE}${AUTO_MODE_TAIL} ` +
        LONG_RULE_HINT,
    )
  })

  test('yolo message contains the new auto-mode guidance and drops the legacy junction', () => {
    const yolo = buildYoloRejectionMessage('test reason')
    expect(yolo).toContain('first try a safer method')
    expect(yolo).toContain('Let the user decide how to proceed.')
    expect(yolo).not.toContain('request, STOP and explain')
    expect(yolo).toContain('intent behind this denial. ')
  })
})
