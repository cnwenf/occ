/**
 * CC 2.1.281 #137 — auto-mode dangerous-rm deny routes through the official
 * `$0t` builder. Still live in 2.1.293 (builder unchanged 2→2; NOT in the
 * §38 revert scope — docs/gap-research-293/triage-293.md).
 *
 * Migrated verbatim from autoModeOutcomeGuidance281.test.ts describe ③ when
 * the 2.1.293 #38 revert deleted the outcome-scope guidance tests.
 */

import { describe, expect, test } from 'bun:test'
import { buildDangerousRmAutoDenyMessage } from 'src/tools/BashTool/dangerousRmAutoDeny.js'
import { shouldAutoDenyInAutoMode } from '../../autoModeDenials.js'

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
