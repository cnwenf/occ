/**
 * CC 2.1.281 #109 — auto-mode denial outcome-scope guidance (mnn/gnn/lKe).
 *
 * Official binary evidence (v2.1.281 linux-x64 ELF; zero-hit proof on
 * v2.1.280 for "This denial applies to the outcome"):
 *   - constants `mnn`/`gnn`/`lKe` @200520366 (byte-compared against the
 *     binary-eval'd source during porting);
 *   - `hxn` @204144495 embeds `lKe` UNCONDITIONALLY between the stop suffix
 *     and the permission-rule hint — both call sites (`S0t` @203102301,
 *     block path @224914260) invoke it with no cadence gate. The
 *     `cKe=120000` constant @200521365 + `t4` formatter belong to `b6t`
 *     @204147071 (classifier API-wait message, `k4o=cKe` threshold), NOT to
 *     guidance cadence — the triage "once-per-2-min-window" reading is
 *     disproved by the binary, so these tests assert EVERY denial carries
 *     the guidance (second denial inside 2 minutes included).
 *   - `${lt}`="Read" / `${zr}`="Grep" resolved byte-exactly from the binary
 *     export/import chains (see autoModeOutcomeGuidance.ts header).
 */

import { describe, expect, jest, test } from 'bun:test'
import {
  AUTO_MODE_OUTCOME_SCOPE_GUIDANCE,
  OUTCOME_SCOPE_DENIAL_GUIDANCE,
  OUTCOME_SCOPE_PURSUIT_EXAMPLES,
} from '../autoModeOutcomeGuidance.js'
import { buildYoloRejectionMessage } from '../../messages.js'
import { buildDangerousRmAutoDenyMessage } from 'src/tools/BashTool/dangerousRmAutoDeny.js'
import { shouldAutoDenyInAutoMode } from '../../autoModeDenials.js'

describe('CC 2.1.281 #109: outcome-scope guidance constants (verbatim)', () => {
  test('mnn matches the official binary text byte-for-byte', () => {
    expect(OUTCOME_SCOPE_DENIAL_GUIDANCE).toBe(
      "This denial applies to the outcome, not only this exact command: don't pursue the same outcome through another tool, interpreter, host, encoding, sub-agent or later turn, and don't record ways around it.",
    )
  })

  test('gnn matches the official binary text with lt=Read and zr=Grep resolved', () => {
    expect(OUTCOME_SCOPE_PURSUIT_EXAMPLES).toBe(
      'Concretely, these all count as pursuing the same outcome: running the same command in smaller pieces; leaving the flagged part out of this call and covering it in another; reading the same file or data with a different tool (Read, Grep, head, awk, a script); re-issuing it with different quoting, flags, paths or hosts.',
    )
  })

  test('lKe is the exact official concatenation (mnn + gnn + batch + clear-it sentences)', () => {
    expect(AUTO_MODE_OUTCOME_SCOPE_GUIDANCE).toBe(
      `${OUTCOME_SCOPE_DENIAL_GUIDANCE} ${OUTCOME_SCOPE_PURSUIT_EXAMPLES} ` +
        'If this was a batch or range operation, you may re-run it without the flagged items, but do not then act on the flagged items separately — leave those for the user. ' +
        'If this denial names something that would clear it — for example a first-hand read that shows the missing source — doing that is not pursuing the denied outcome: do it, and if it shows what the denial asked for, you may redo the action citing it.',
    )
  })
})

describe('CC 2.1.281 #109: guidance injection into auto-mode denials (official hxn @204144495)', () => {
  test('auto-mode denial message includes the outcome-scope guidance', () => {
    const message = buildYoloRejectionMessage('file write outside workspace')
    expect(message).toContain(AUTO_MODE_OUTCOME_SCOPE_GUIDANCE)
  })

  test('guidance sits between the stop suffix and the permission-rule hint (official template order)', () => {
    jest.useFakeTimers()
    try {
      const message = buildYoloRejectionMessage('network exfiltration risk')
      const stopIdx = message.indexOf('Let the user decide how to proceed.')
      const guidanceIdx = message.indexOf(OUTCOME_SCOPE_DENIAL_GUIDANCE)
      const ruleHintIdx = message.indexOf(
        'To allow this type of action in the future',
      )
      expect(stopIdx).toBeGreaterThan(-1)
      expect(guidanceIdx).toBeGreaterThan(stopIdx)
      expect(ruleHintIdx).toBeGreaterThan(guidanceIdx)
      expect(message).toContain(
        'If you have other tasks that don’t depend on this action'.replace(
          '’',
          "'",
        ),
      )

      // Official hxn embeds lKe UNCONDITIONALLY: a second denial inside the
      // same 2-minute window still carries the full guidance (no cadence
      // gate exists in the binary — cKe/t4 belong to the b6t API-wait
      // builder @204147071).
      jest.advanceTimersByTime(5_000)
      const second = buildYoloRejectionMessage('another denied action')
      expect(second).toContain(AUTO_MODE_OUTCOME_SCOPE_GUIDANCE)
      const third = buildYoloRejectionMessage('yet another denied action')
      expect(third).toContain(AUTO_MODE_OUTCOME_SCOPE_GUIDANCE)
    } finally {
      jest.useRealTimers()
    }
  })

  test('denial reason still leads the message (prefix + reason first, official Wle @204144486)', () => {
    const message = buildYoloRejectionMessage('destructive shell pipeline')
    expect(message.startsWith(
      'Permission for this action was denied by the Claude Code auto mode classifier. Reason: destructive shell pipeline.',
    )).toBe(true)
  })
})

describe('CC 2.1.281 #137: auto-mode dangerous-rm deny routes through the official $0t builder', () => {
  test('dangerous-rm auto-deny carries the $0t rewrite-hint message', () => {
    const result = shouldAutoDenyInAutoMode('Bash', 'rm -rf $UNSET_VAR/*')
    expect(result.deny).toBe(true)
    expect(result.reason).toBe('dangerous rm pattern')
    expect(result.denyMessage).toBe(
      buildDangerousRmAutoDenyMessage(
        'dangerous rm pattern auto-denied in auto mode',
      ),
    )
    expect(result.denyMessage).toContain(
      'Permission for this command was denied by a built-in Claude Code safety check',
    )
    expect(result.denyMessage).toContain(
      'What was flagged: dangerous rm pattern auto-denied in auto mode',
    )
  })

  test('background-& auto-deny keeps the legacy message shape (no denyMessage)', () => {
    const result = shouldAutoDenyInAutoMode('Bash', 'sleep 100 &')
    expect(result.deny).toBe(true)
    expect(result.reason).toBe('background & pattern')
    expect(result.denyMessage).toBeUndefined()
  })

  test('safe commands are not auto-denied', () => {
    const result = shouldAutoDenyInAutoMode('Bash', 'ls -la')
    expect(result.deny).toBe(false)
  })
})
