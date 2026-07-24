import { describe, expect, test } from 'bun:test'
import { formatForkConfirmation } from '../confirmation.js'

/**
 * 2.1.216 #30 — `/fork` confirmation is one line with the new session's
 * name, the `occ attach` id, and a note when the copy shares your
 * checkout.
 *
 * The 2.1.212 format was `Forked session <id> (fork)` — it named only the
 * session id and gave no attach hint or checkout note. #30 improves the
 * in-session row to a single line carrying all three pieces.
 *
 * These tests lock the DECISION/parse logic of the confirmation string
 * (not the visual render — that's the OCC-11 e2e surface).
 */
describe('2.1.216 #30 — /fork one-line confirmation', () => {
  test('includes the fork name and the occ attach id on one line', () => {
    const name = 'refactor-auth'
    const sessionId = '11111111-2222-3333-4444-555555555555'

    const line = formatForkConfirmation(name, sessionId, false)

    expect(line).toBe(
      'Forked session refactor-auth (occ attach 11111111-2222-3333-4444-555555555555)',
    )
    expect(line.includes('\n')).toBe(false)
  })

  test('appends the shares-checkout note when the copy shares your checkout', () => {
    const name = 'deploy-to-staging'
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    const line = formatForkConfirmation(name, sessionId, true)

    expect(line).toBe(
      'Forked session deploy-to-staging (occ attach aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee) (shares your checkout)',
    )
    expect(line.includes('\n')).toBe(false)
    expect(line.endsWith('(shares your checkout)')).toBe(true)
  })

  test('omits the shares-checkout note when the copy has its own checkout', () => {
    const line = formatForkConfirmation('fix-bug', 'cccccccc-0000-0000-0000-000000000000', false)

    expect(line).not.toContain('shares your checkout')
    expect(line).toBe(
      'Forked session fix-bug (occ attach cccccccc-0000-0000-0000-000000000000)',
    )
  })

  test('uses the derived fork name even for multi-word directives', () => {
    // deriveForkName('Deploy to staging') === 'deploy-to-staging'
    const line = formatForkConfirmation('deploy-to-staging', 'deadbeef-0000-0000-0000-000000000000', false)

    expect(line.startsWith('Forked session deploy-to-staging ')).toBe(true)
  })
})
