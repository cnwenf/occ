import { describe, expect, test } from 'bun:test'
import { buildOtelHeadersFailureWarning } from '../doctorDiagnostic.js'

/**
 * 2.1.275 (Item E2): doctor diagnostic for a failing otelHeadersHelper.
 * Port of the official doctor entry (v2.1.276 binary @201240063):
 *   - issue prefix @96426392 / @201240063:
 *     `otelHeadersHelper is configured but its last invocation failed: `
 *   - fix text @96426464 / @201240146
 *   - message capped via official `j2(r,l8t)` with `l8t=500` (@190581258) —
 *     OCC's surrogate-safe `sliceHead(value, 500)`.
 * Gating (only when configured + failed) is enforced by
 * `getOtelHeadersLastFailure()` and covered by
 * src/utils/__tests__/otelHeadersHelperFailure275.test.ts.
 */

const ISSUE_PREFIX =
  'otelHeadersHelper is configured but its last invocation failed: '
const FIX_TEXT =
  'Run the configured helper manually and confirm it prints a JSON object of string header values. If the value is a file path, confirm the file exists and is executable.'

describe('buildOtelHeadersFailureWarning', () => {
  test('produces the byte-exact official issue and fix strings', () => {
    // Arrange
    const lastFailure = 'exited 3: boom'

    // Act
    const warning = buildOtelHeadersFailureWarning(lastFailure)

    // Assert
    expect(warning).toEqual({
      issue: `${ISSUE_PREFIX}exited 3: boom`,
      fix: FIX_TEXT,
    })
  })

  test('passes failures within the 500-char cap through unchanged', () => {
    // Arrange
    const lastFailure = 'a'.repeat(500)

    // Act
    const { issue } = buildOtelHeadersFailureWarning(lastFailure)

    // Assert
    expect(issue).toBe(`${ISSUE_PREFIX}${lastFailure}`)
  })

  test('truncates the failure message at the official 500-char cap (l8t=500)', () => {
    // Arrange
    const lastFailure = 'a'.repeat(600)

    // Act
    const { issue } = buildOtelHeadersFailureWarning(lastFailure)

    // Assert
    expect(issue).toBe(`${ISSUE_PREFIX}${'a'.repeat(500)}`)
  })

  test('never ends on a dangling surrogate half (sliceHead is surrogate-safe)', () => {
    // Arrange — 😀 starts at code-unit index 499, so a naive slice(0, 500)
    // would end on the lone high surrogate
    const lastFailure = `${'a'.repeat(499)}😀${'b'.repeat(10)}`

    // Act
    const { issue } = buildOtelHeadersFailureWarning(lastFailure)

    // Assert
    const rendered = issue.slice(ISSUE_PREFIX.length)
    expect(rendered).toBe('a'.repeat(499))
    const lastUnit = rendered.charCodeAt(rendered.length - 1)
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false)
  })
})
