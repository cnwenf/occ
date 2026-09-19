import { describe, expect, test } from 'bun:test'
import type { PluginError } from '../../../types/plugin.js'
import { formatErrorMessage, stripControlChars } from '../PluginErrors.js'

/**
 * CC 2.1.277 (changelog): "Fixed /plugin not stripping terminal control
 * characters from messages on the Installed tab, such as the error of a
 * failed plugin update."
 *
 * Pinned derivation (official render-site pinpoint is weak): the strip set is
 * the official v277 general message-sanitizer `ag()` — strip-ANSI, then
 * REMOVE `/[\x00-\x1f\x7f-\x9f]/g` (C0 incl. \n, DEL, C1), then trim. The
 * removal form (not the space-substitute form of `sg()`) is pinned here via
 * the multi-line test: newlines are removed, matching `ag()` byte-for-byte.
 * Strip runs before credential redaction (see PluginErrors.tsx comment).
 */

function loadFailed(reason: string): PluginError {
  return {
    type: 'marketplace-load-failed',
    source: 'acme@marketplace',
    marketplace: 'marketplace',
    reason,
  }
}

describe('2.1.277: plugin error control-char strip (C10)', () => {
  test('ANSI color sequences in error.reason never reach the render', () => {
    // Arrange
    const error = loadFailed('\x1b[31mRED\x1b[0m')

    // Act
    const message = formatErrorMessage(error)

    // Assert — whole ANSI sequences (ESC + params) are gone, text survives.
    expect(message).toBe('Failed to load marketplace "marketplace": RED')
    expect(message).not.toContain('\x1b')
    expect(message).not.toContain('[31m')
  })

  test('NUL, DEL and C1 bytes are removed', () => {
    // Arrange / Act / Assert
    expect(stripControlChars('a\x00b\x7fc\x9bd')).toBe('abcd')
    expect(formatErrorMessage(loadFailed('ti\x00tle\x7f'))).toBe(
      'Failed to load marketplace "marketplace": title',
    )
  })

  test('a lone ESC (not part of a sequence) is removed', () => {
    expect(stripControlChars('a\x1bb')).toBe('ab')
  })

  test('plain reasons render unchanged', () => {
    // Arrange
    const error = loadFailed('repository not found')

    // Act / Assert
    expect(formatErrorMessage(error)).toBe(
      'Failed to load marketplace "marketplace": repository not found',
    )
  })

  test('multi-line reasons collapse (newline policy: removal form, per ag())', () => {
    // Pinned decision: \n is inside the stripped class — a marketplace-supplied
    // reason cannot break the single-row Installed-tab layout.
    expect(stripControlChars('line1\nline2')).toBe('line1line2')
  })

  test('surrounding whitespace is trimmed; empty input does not throw', () => {
    expect(stripControlChars('  spaced\x00  ')).toBe('spaced')
    expect(stripControlChars('')).toBe('')
  })

  test('credential redaction still applies after the strip', () => {
    // Arrange — strip runs BEFORE redactCredentialsInText (ordering guard).
    const error = loadFailed('fetch https://user:pass@evil.com/m.json failed')

    // Act
    const message = formatErrorMessage(error)

    // Assert
    expect(message).toContain('https://evil.com/m.json')
    expect(message).not.toContain('user:pass')
  })
})
