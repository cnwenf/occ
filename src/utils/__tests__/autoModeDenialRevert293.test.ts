/**
 * CC 2.1.293 #38 — REVERT of the 2.1.281 auto-mode denial outcome-scope
 * guidance (docs/gap-research-293/triage-293.md §38).
 *
 * Official binary evidence (v2.1.293 linux-x64 ELF at
 * /tmp/cc-diff-293/vver/package/claude, byte-verified):
 *   - `This denial applies to the outcome` s292:2 → s293:0 (0 hits);
 *     likewise `Concretely, these all count` 2→0,
 *     `If this was a batch or range operation` 1→0,
 *     `If this denial names something that would clear it` 1→0.
 *   - Post-revert builder `fnr` (dd @216697200, verbatim):
 *       g=`${r}${e}. If you have other tasks that don't depend on this
 *          action, continue working on those. `+s
 *     where s = `UUr` = `CXe` (shared base @216693356) + auto-mode stop
 *     suffix — the sole delta vs vprev `ier` is `${Qat}` + its preceding
 *     space deleted, so the message now ENDS at the stop suffix (no
 *     trailing space) when no rule hint is appended.
 *   - Rule hint path unchanged (official `fnr`):
 *       `${g} ${h}` with h = `To allow this type of action in the future,
 *       the user can add a permission rule for ${toolName} to their
 *       settings.` — appended only when allowRuleToolName is set (OCC keeps
 *       its pre-existing divergence of not mapping the `!fUn()||iy()`
 *       session gates).
 */

import { describe, expect, test } from 'bun:test'
import { buildYoloRejectionMessage } from '../messages.js'

// Official post-revert pieces — verbatim from the v293 binary
// (CXe @216693356, UUr tail, fnr @216697200).
const PREFIX =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: '
const CONTINUATION =
  "If you have other tasks that don't depend on this action, continue working on those. "
const BASE =
  'IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. '
const AUTO_MODE_STOP_SUFFIX =
  "If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed."

// The full post-revert (2.1.293) base template, byte-exact.
const POST_REVERT_BASE = `${PREFIX}test reason. ${CONTINUATION}${BASE}${AUTO_MODE_STOP_SUFFIX}`

// The four sentences the official 2.1.293 revert removed (vprev
// C0n/x0n/Qat) — none may appear anywhere in the denial path.
const REVERTED_SENTENCES = [
  "This denial applies to the outcome, not only this exact command: don't pursue the same outcome through another tool, interpreter, host, encoding, sub-agent or later turn, and don't record ways around it.",
  'Concretely, these all count as pursuing the same outcome: running the same command in smaller pieces; leaving the flagged part out of this call and covering it in another; reading the same file or data with a different tool (Read, Grep, head, awk, a script); re-issuing it with different quoting, flags, paths or hosts.',
  'If this was a batch or range operation, you may re-run it without the flagged items, but do not then act on the flagged items separately — leave those for the user.',
  'If this denial names something that would clear it — for example a first-hand read that shows the missing source — doing that is not pursuing the denied outcome: do it, and if it shows what the denial asked for, you may redo the action citing it.',
]

describe('CC 2.1.293 #38: auto-mode denial message reverts to the official fnr template', () => {
  test('denial without allowRuleToolName is byte-exact with the post-revert template and ends at the stop suffix (no trailing space)', () => {
    const message = buildYoloRejectionMessage('test reason')
    expect(message).toBe(POST_REVERT_BASE)
    expect(message.endsWith('Let the user decide how to proceed.')).toBe(true)
  })

  test('denial with allowRuleToolName = base + single space + official rule hint', () => {
    const message = buildYoloRejectionMessage('test reason', {
      allowRuleToolName: 'Bash',
    })
    expect(message).toBe(
      `${POST_REVERT_BASE} To allow this type of action in the future, the user can add a permission rule for Bash to their settings.`,
    )
  })

  test('none of the four reverted 281 guidance sentences appear in the denial path', () => {
    const messages = [
      buildYoloRejectionMessage('test reason'),
      buildYoloRejectionMessage('test reason', { allowRuleToolName: 'Bash' }),
      buildYoloRejectionMessage('test reason', {
        allowRuleToolName: 'WebFetch',
      }),
    ]
    for (const message of messages) {
      for (const sentence of REVERTED_SENTENCES) {
        expect(message).not.toContain(sentence)
      }
      // Short distinctive fragments of each reverted sentence (covers the
      // s292→s293 newness probes verbatim).
      expect(message).not.toContain('This denial applies to the outcome')
      expect(message).not.toContain('Concretely, these all count')
      expect(message).not.toContain('If this was a batch or range operation')
      expect(message).not.toContain(
        'If this denial names something that would clear it',
      )
    }
  })

  test('stop suffix and shared base remain byte-identical between versions (not in revert scope)', () => {
    const message = buildYoloRejectionMessage('test reason')
    expect(message).toContain(BASE)
    expect(message).toContain(AUTO_MODE_STOP_SUFFIX)
    expect(message).toContain(CONTINUATION)
    expect(message.startsWith(`${PREFIX}test reason. `)).toBe(true)
  })
})
