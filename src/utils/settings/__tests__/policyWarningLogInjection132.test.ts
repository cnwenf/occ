import { describe, expect, test } from 'bun:test'
import { sanitizePolicySourceData } from '../policySourceSanitizer'
import { sanitizeSecurityAllowlists } from '../sanitizeAllowlists'
import { sanitizeForWarningText } from '../sanitizeWarningText'
import { filterInvalidPermissionRules } from '../validation'

/**
 * OCC-132 §7 P3-5 (CWE-117 log injection): policy-controlled strings are
 * interpolated into sanitizer warning messages. A crafted policy value
 * carrying CR/LF or other C0 control characters must NOT be able to forge
 * extra log lines. sanitizeForWarningText strips C0 at the interpolation
 * sites; benign values never contain control characters, so messages for
 * legitimate input stay byte-identical.
 *
 * Crafted strings are built with String.fromCharCode so this source file
 * itself contains no literal control characters.
 */

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const NUL = String.fromCharCode(0)
const ESC = String.fromCharCode(27)
const CRLF = CR + LF

/** True when the message carries any CR or LF (i.e. an injected newline). */
function hasNewline(text: string): boolean {
  return text.includes(CR) || text.includes(LF)
}

describe('OCC-132 P3-5: sanitizeForWarningText helper', () => {
  test('strips CR, LF, NUL, ESC and the full C0 control range', () => {
    const crafted = `a${CRLF}b${NUL}c${ESC}d${String.fromCharCode(1)}e`
    expect(sanitizeForWarningText(crafted)).toBe('abcde')
  })

  test('is byte-identical for benign printable text', () => {
    const benign = 'Bash(git status) — plain 123 !@#$%^&*() ünicode 日本語'
    expect(sanitizeForWarningText(benign)).toBe(benign)
  })
})

describe('OCC-132 P3-5: crafted CRLF policy values cannot inject log lines', () => {
  test('crafted CRLF permission rule message stays single-line', () => {
    // Arrange — mismatched parens make the rule invalid, so the raw rule
    // string is interpolated into the warning message.
    const data: Record<string, unknown> = {
      permissions: { allow: [`Bash(echo${CRLF}Injected-Warning: pwned`] },
    }

    // Act
    const warnings = filterInvalidPermissionRules(data, 'policy.json')

    // Assert — no newline survives; the stripped content is still present.
    expect(warnings).toHaveLength(1)
    const message = warnings[0]?.message ?? ''
    expect(hasNewline(message)).toBe(false)
    expect(message).toContain(
      'Invalid permission rule "Bash(echoInjected-Warning: pwned" was skipped: Mismatched parentheses',
    )
  })

  test('crafted CRLF allowedChannelPlugins legacy string notice stays single-line', () => {
    // Arrange — the legacy "plugin@marketplace" accept-notice interpolates
    // the raw entry (and both halves) verbatim.
    const data: Record<string, unknown> = {
      allowedChannelPlugins: [`plu${CRLF}gin@mar${LF}ket`],
    }

    // Act
    const warnings = sanitizeSecurityAllowlists(data, 'policy.json')

    // Assert — notice is emitted (entry accepted) but carries no newline,
    // and equals the byte-exact message for the stripped benign value.
    expect(warnings).toHaveLength(1)
    const message = warnings[0]?.message ?? ''
    expect(hasNewline(message)).toBe(false)
    expect(message).toBe(
      '"allowedChannelPlugins" entry "plugin@market" was accepted; prefer the documented object form {"plugin": "plugin", "marketplace": "market"}.',
    )
  })

  test('crafted CRLF values across all three families stay single-line through the full pipeline', () => {
    // Arrange — one crafted value per sanitized family, via the shared
    // policy-source entry point.
    const data: Record<string, unknown> = {
      blockedMarketplaces: [{ source: `evil${CRLF}source` }],
      permissions: { deny: [`bad${LF}rule(`] },
      allowedHttpHookUrls: [42],
    }

    // Act
    const warnings = sanitizePolicySourceData(data, 'policy.json')

    // Assert — every emitted warning (message AND path) is newline-free.
    expect(warnings.length).toBeGreaterThan(0)
    for (const warning of warnings) {
      expect(hasNewline(warning.message)).toBe(false)
      expect(hasNewline(warning.path)).toBe(false)
    }
  })
})

describe('OCC-132 P3-5: benign inputs keep byte-identical messages', () => {
  test('benign legacy channel-plugin notice is unchanged', () => {
    const data: Record<string, unknown> = {
      allowedChannelPlugins: ['myplugin@my-market'],
    }
    const warnings = sanitizeSecurityAllowlists(data, 'policy.json')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      '"allowedChannelPlugins" entry "myplugin@my-market" was accepted; prefer the documented object form {"plugin": "myplugin", "marketplace": "my-market"}.',
    )
  })

  test('benign invalid permission rule message is unchanged', () => {
    const data: Record<string, unknown> = {
      permissions: { allow: ['Bash(missing-close'] },
    }
    const warnings = filterInvalidPermissionRules(data, 'policy.json')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      'Invalid permission rule "Bash(missing-close" was skipped: Mismatched parentheses. Ensure all opening parentheses have matching closing parentheses',
    )
  })
})
