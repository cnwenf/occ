import { describe, expect, test } from 'bun:test'
import {
  AUTO_REJECT_MESSAGE,
  buildYoloRejectionMessage,
  DENIAL_WORKAROUND_GUIDANCE,
  DONT_ASK_REJECT_MESSAGE,
} from '../messages.js'
import { AUTO_MODE_OUTCOME_SCOPE_GUIDANCE } from '../permissions/autoModeOutcomeGuidance.js'

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

// CC 2.1.288 #15: the OCC-original BASH_CLASSIFIER long rule hint
// (`Bash(prompt: <description …>)` + "At the end of your session …") was
// removed — it matched neither official binary (0 hits in v287 AND v288).
// Official v288 `bKn` appends this sentence ONLY when allowRuleToolName is
// defined; with no options, no hint is appended at all.
const officialRuleHint = (toolName: string): string =>
  `To allow this type of action in the future, the user can add a permission rule for ${toolName} to their settings.`

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
    // CC 2.1.281 #109: official `hxn` @204144495 now embeds the outcome-scope
    // guidance (`lKe`) unconditionally between the stop suffix and the
    // permission-rule hint. CC 2.1.288 #15: the hint itself is now gated on
    // `allowRuleToolName` (official `bKn`) — with the option set, the official
    // v288 sentence is appended; the base (prefix → guidance) is unchanged.
    expect(
      buildYoloRejectionMessage('test reason', { allowRuleToolName: 'Bash' }),
    ).toBe(
      `Permission for this action was denied by the Claude Code auto mode classifier. Reason: test reason. ` +
        `If you have other tasks that don't depend on this action, continue working on those. ` +
        `${BASE}${AUTO_MODE_TAIL} ` +
        `${AUTO_MODE_OUTCOME_SCOPE_GUIDANCE} ` +
        officialRuleHint('Bash'),
    )
  })

  test('buildYoloRejectionMessage without allowRuleToolName carries no rule hint (2.1.288 #15)', () => {
    const message = buildYoloRejectionMessage('test reason')
    expect(message).toBe(
      `Permission for this action was denied by the Claude Code auto mode classifier. Reason: test reason. ` +
        `If you have other tasks that don't depend on this action, continue working on those. ` +
        `${BASE}${AUTO_MODE_TAIL} ` +
        `${AUTO_MODE_OUTCOME_SCOPE_GUIDANCE}`,
    )
    expect(message).not.toContain('To allow this type of action in the future')
    expect(message).not.toContain('Bash(prompt')
  })

  test('yolo message contains the new auto-mode guidance and drops the legacy junction', () => {
    const yolo = buildYoloRejectionMessage('test reason')
    expect(yolo).toContain('first try a safer method')
    expect(yolo).toContain('Let the user decide how to proceed.')
    expect(yolo).not.toContain('request, STOP and explain')
    expect(yolo).toContain('intent behind this denial. ')
  })
})
