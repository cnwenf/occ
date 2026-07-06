import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * F4 (2.1.97): statusLine.refreshInterval. Accepted by schema but not honored
 * at runtime — must re-run the status line command every N seconds in addition
 * to event-driven updates.
 *
 * Source-grep e2e: verifies StatusLine wires refreshInterval into a recurring
 * interval (seconds→ms, min 1s) calling doUpdate — matching the official
 * `Qc(updateCb, j != null ? Math.max(1, j) * 1000 : null)`.
 */

describe('statusLine.refreshInterval runtime (2.1.97)', () => {
  test('schema accepts refreshInterval (min 1, seconds)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/settings/types.ts`).text()
    expect(src).toContain('refreshInterval')
    expect(src).toMatch(/refreshInterval: z[\s\S]*?\.number\(\)[\s\S]*?\.min\(1\)/)
  })

  test('StatusLine converts seconds→ms (min 1s) + sets a recurring interval', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/StatusLine.tsx`).text()
    // Reads refreshInterval off the statusLine config.
    expect(src).toContain('settings?.statusLine?.refreshInterval')
    // Math.max(1, j) * 1000 — official conversion (null when absent).
    expect(src).toContain('Math.max(1, settings.statusLine.refreshInterval) * 1000')
    // Recurring timeout that re-runs the status line command.
    expect(src).toMatch(/setInterval\(\(\) => \{[\s\S]*?void doUpdate\(\)/)
    // Cleanup on tear-down.
    expect(src).toContain('clearInterval(id)')
  })
})
