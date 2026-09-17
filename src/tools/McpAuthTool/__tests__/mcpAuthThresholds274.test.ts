/**
 * CC 2.1.274 — threshold + exception branches of the McpAuthTool gating
 * helpers (live-binary verified; forensics in
 * docs/upstream-version-gap-occ128.md).
 *
 * Locks in:
 *  - binary `a(e,{scope})` 1024-CODE-POINT cap on the anthropic-hosted
 *    message: the `Remove the stale entry with: \`occ mcp remove <name>\``
 *    hint is kept only while the WHOLE message stays within 1024 code points
 *    (`[...withRemove].length <= 1024 ? withRemove : base`). Both sides of
 *    the boundary are pinned (exactly 1024 → kept, exactly 1025 → dropped);
 *  - scope gating around the hint (local/project/user only — managed and
 *    undefined never render it);
 *  - binary `c(e)` URL classifier: blocked-host matching incl. hostname
 *    normalization (lowercase + trailing-dot strip), and the catch branch —
 *    unparseable URLs must return false, never throw and never default true.
 *
 * Pure-helper tests: no mock.module needed (same direct-import pattern as
 * mcpAuthToolDescription274.test.ts).
 */
import { describe, expect, test } from 'bun:test'

import {
  buildAnthropicHostedMessage,
  isAnthropicHostedMcpUrl,
} from '../McpAuthTool.js'

// ---------------------------------------------------------------------------
// Template-derived constants — the boundary name length is COMPUTED from the
// real message template (probe measurement), never hardcoded, while the tests
// still assert the exact 1024-code-point threshold.
// ---------------------------------------------------------------------------

/** Official cap: hint kept only when the whole message fits in 1024 code points. */
const MESSAGE_CODE_POINT_CAP = 1024

/** sanitizeServerNameForDisplay cap (binary `xr`, max=64). */
const SANITIZER_NAME_CAP = 64

/** The hint suffix exactly as buildAnthropicHostedMessage appends it. */
const removeHintSuffix = (serverName: string): string =>
  ` Remove the stale entry with: \`occ mcp remove ${serverName}\``

const codePointLength = (value: string): number => [...value].length

// A name of repeated 'a' is shell-safe (/^\w[\w.@-]*$/) and NFKC/invisible/
// quote-stable, so past the sanitizer cap the display portion is constant
// (64 chars + '…') and the with-hint message length is LINEAR in the raw
// name length: cpLen(message) = NON_NAME_OVERHEAD + rawNameLength.
const PROBE_NAME_LENGTH = SANITIZER_NAME_CAP + 36
const NON_NAME_OVERHEAD =
  codePointLength(
    buildAnthropicHostedMessage('a'.repeat(PROBE_NAME_LENGTH), 'local'),
  ) - PROBE_NAME_LENGTH

/** Raw name length whose with-hint message is EXACTLY 1024 code points. */
const EXACT_CAP_NAME_LENGTH = MESSAGE_CODE_POINT_CAP - NON_NAME_OVERHEAD

describe('2.1.274 buildAnthropicHostedMessage — 1024 code-point cap (binary a(e,{scope}))', () => {
  test('keeps the remove hint when the with-hint message is exactly 1024 code points', () => {
    // Arrange — name length derived from the template so the total lands on
    // the cap exactly; it must sit above the sanitizer cap for the linear
    // overhead model to hold.
    expect(EXACT_CAP_NAME_LENGTH).toBeGreaterThan(SANITIZER_NAME_CAP)
    const serverName = 'a'.repeat(EXACT_CAP_NAME_LENGTH)

    // Act
    const message = buildAnthropicHostedMessage(serverName, 'local')

    // Assert — pins the threshold itself: exactly 1024 code points, hint kept.
    expect(codePointLength(message)).toBe(1024)
    expect(message.endsWith(removeHintSuffix(serverName))).toBe(true)
  })

  test('drops the remove hint and falls back to the base message one code point over the cap (1025)', () => {
    // Arrange — one raw-name char longer: the with-hint message would be
    // exactly 1025 code points.
    const serverName = 'a'.repeat(EXACT_CAP_NAME_LENGTH + 1)

    // Act
    const message = buildAnthropicHostedMessage(serverName, 'local')

    // Assert — hint removed; message equals the no-hint base (same as a
    // scope that never renders the hint) and is correspondingly shorter.
    expect(message).not.toContain('Remove the stale entry')
    expect(message).toBe(buildAnthropicHostedMessage(serverName, undefined))
    expect(codePointLength(message)).toBe(
      NON_NAME_OVERHEAD - codePointLength(removeHintSuffix('')),
    )
  })

  test('keeps the remove hint for a normal short shell-safe name in local scope', () => {
    // Arrange
    const serverName = 'gmail-sync'

    // Act
    const message = buildAnthropicHostedMessage(serverName, 'local')

    // Assert — byte-exact with-hint message (display name passes through the
    // sanitizer unchanged at this length).
    expect(message).toBe(
      `"gmail-sync" is Anthropic-hosted and doesn't support local OAuth. ` +
        'Connect it via Settings → Connectors on claude.ai (requires ' +
        '`claude login`), then it\'ll be available here automatically.' +
        removeHintSuffix(serverName),
    )
  })

  test('renders the identical hint for project and user scopes', () => {
    // Arrange
    const localMessage = buildAnthropicHostedMessage('gmail-sync', 'local')

    // Act
    const projectMessage = buildAnthropicHostedMessage('gmail-sync', 'project')
    const userMessage = buildAnthropicHostedMessage('gmail-sync', 'user')

    // Assert
    expect(projectMessage).toBe(localMessage)
    expect(userMessage).toBe(localMessage)
  })

  test('never renders the remove hint for managed scope, even with a short shell-safe name', () => {
    // Arrange / Act
    const message = buildAnthropicHostedMessage('gmail-sync', 'managed')

    // Assert
    expect(message).not.toContain('Remove the stale entry')
    expect(message).toBe(buildAnthropicHostedMessage('gmail-sync', undefined))
  })

  test('never renders the remove hint when the scope is undefined', () => {
    // Arrange / Act
    const message = buildAnthropicHostedMessage('gmail-sync', undefined)

    // Assert
    expect(message).not.toContain('Remove the stale entry')
    expect(message.endsWith('available here automatically.')).toBe(true)
  })
})

describe('2.1.274 isAnthropicHostedMcpUrl — blocked-host classifier (binary c(e))', () => {
  test('returns true for each default-blocked Anthropic-hosted MCP host', () => {
    // Arrange
    const blockedUrls = [
      'https://microsoft365.mcp.claude.com/mcp',
      'https://gmail.mcp.claude.com/mcp',
      'https://gcal.mcp.claude.com/sse',
    ]

    // Act / Assert
    for (const url of blockedUrls) {
      expect(isAnthropicHostedMcpUrl(url)).toBe(true)
    }
  })

  test('normalizes hostname case and trailing dot before matching', () => {
    // Arrange — uppercase host + trailing dot, both neutralized by the
    // binary `i(e)` normalization (lowercase + trailing-dot strip).
    const normalizedUrl = 'https://GMAIL.MCP.CLAUDE.COM./mcp'

    // Act / Assert
    expect(isAnthropicHostedMcpUrl(normalizedUrl)).toBe(true)
  })

  test('returns false for benign https URLs and blocked-host-suffix lookalikes', () => {
    // Arrange / Act / Assert
    expect(isAnthropicHostedMcpUrl('https://example.com/mcp')).toBe(false)
    // Hostname merely ENDS WITH a blocked host — must not match.
    expect(
      isAnthropicHostedMcpUrl('https://gmail.mcp.claude.com.evil.test/'),
    ).toBe(false)
  })

  test('returns false when URL parsing throws instead of propagating or defaulting true', () => {
    // Arrange — every input makes `new URL()` throw (invalid scheme, invalid
    // IPv6 literal, forbidden host code point).
    const unparseableUrls = [
      'not a url ::: //',
      'http://[::1',
      '://x',
      'https://exa mple.com',
    ]

    // Act / Assert — the catch branch must swallow and return false.
    for (const url of unparseableUrls) {
      expect(() => new URL(url)).toThrow()
      expect(isAnthropicHostedMcpUrl(url)).toBe(false)
    }
  })

  test('returns false for missing or empty url without attempting a parse', () => {
    // Act / Assert — falsy short-circuit branch.
    expect(isAnthropicHostedMcpUrl(undefined)).toBe(false)
    expect(isAnthropicHostedMcpUrl('')).toBe(false)
  })
})
