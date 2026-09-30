import { describe, expect, test } from 'bun:test'
import {
  mcpServerNotFoundMessage,
  mcpServerNotFoundMessageWithPending,
  sanitizeMcpCliText,
} from '../cliMessages.js'

/**
 * CC 2.1.285 (item 8) — unit tests for the byte-ported CLI sanitizer `Tn`
 * and the not-found builders `iQn` / `u2t` (v285 @231333109/@231333600
 * regions; v284 `wQn`/`Czt` templates identical, sanitization absent).
 * Command names follow the OCC rebrand (`claude` → `occ`); every other
 * character matches the binary.
 */

describe('sanitizeMcpCliText (binary Tn)', () => {
  test('replaces a line break in a hostile server name with a space', () => {
    // Arrange
    const hostile = 'evil\nname'

    // Act
    const sanitized = sanitizeMcpCliText(hostile)

    // Assert
    expect(sanitized).toBe('evil name')
  })

  test('neutralizes ANSI escape sequences, keeping the printable payload', () => {
    // Arrange — ESC is \p{Cc}; "[31m" is printable and stays
    const hostile = '\x1b[31mred\x1b[0m'

    // Act
    const sanitized = sanitizeMcpCliText(hostile)

    // Assert
    expect(sanitized).toBe(' [31mred [0m')
    expect(sanitized).not.toContain('\x1b')
  })

  test('collapses a carriage-return/tab run into a single space', () => {
    // Arrange
    const hostile = 'server\r\tname'

    // Act
    const sanitized = sanitizeMcpCliText(hostile)

    // Assert
    expect(sanitized).toBe('server name')
  })

  test('replaces U+2028/U+2029 line and paragraph separators', () => {
    // Arrange
    const hostile = 'a\u2028b\u2029c'

    // Act
    const sanitized = sanitizeMcpCliText(hostile)

    // Assert
    expect(sanitized).toBe('a b c')
  })

  test('replaces format characters (Cf) such as soft hyphen and RLO', () => {
    // Arrange — soft hyphen U+00AD and right-to-left override U+202E are \p{Cf}
    const hostile = 'na\u00adme\u202e!'

    // Act
    const sanitized = sanitizeMcpCliText(hostile)

    // Assert
    expect(sanitized).toBe('na me !')
  })

  test('collapses consecutive control characters into one space', () => {
    // Arrange
    const hostile = 'a\n\r\x00\x1bb'

    // Act
    const sanitized = sanitizeMcpCliText(hostile)

    // Assert
    expect(sanitized).toBe('a b')
  })

  test('leaves ordinary names untouched', () => {
    // Arrange
    const benign = 'my-server_1.test'

    // Act & Assert
    expect(sanitizeMcpCliText(benign)).toBe(benign)
  })
})

describe('mcpServerNotFoundMessage (binary iQn)', () => {
  test('suggests a close spelling within edit distance 2', () => {
    // Arrange
    const configured = ['github', 'sentry']

    // Act
    const message = mcpServerNotFoundMessage('githb', configured)

    // Assert
    expect(message).toBe(
      'No MCP server named "githb". Did you mean "github"? Run `occ mcp list` to see all.',
    )
  })

  test('counts an adjacent transposition as distance 1 (Damerau)', () => {
    // Arrange — "srever" is one transposition away from "server"
    const configured = ['server']

    // Act
    const message = mcpServerNotFoundMessage('srever', configured)

    // Assert
    expect(message).toContain('Did you mean "server"?')
  })

  test('prints the add-one hint when nothing is configured', () => {
    // Arrange & Act
    const message = mcpServerNotFoundMessage('anything', [])

    // Assert
    expect(message).toBe(
      'No MCP server named "anything". Run `occ mcp add` to add one.',
    )
  })

  test('enumerates configured names sorted when nothing is close', () => {
    // Arrange — length gap > 2 blocks any fuzzy suggestion
    const configured = ['zeta-server', 'alpha-server']

    // Act
    const message = mcpServerNotFoundMessage('x', configured)

    // Assert
    expect(message).toBe(
      'No MCP server named "x". Configured servers: alpha-server, zeta-server',
    )
  })

  test('caps the enumeration at 8 with the binary overflow suffix', () => {
    // Arrange — 10 names, all far from the query
    const configured = Array.from(
      { length: 10 },
      (_, i) => `server-name-${String(i).padStart(2, '0')}`,
    )

    // Act
    const message = mcpServerNotFoundMessage('q', configured)

    // Assert
    expect(message).toBe(
      'No MCP server named "q". Configured servers: server-name-00, ' +
        'server-name-01, server-name-02, server-name-03, server-name-04, ' +
        'server-name-05, server-name-06, server-name-07 ' +
        '(and 2 more — run `occ mcp list` to see all)',
    )
  })

  test('sanitizes the queried name and every configured name', () => {
    // Arrange
    const configured = ['a\r\nb']

    // Act
    const message = mcpServerNotFoundMessage('evil\nname', configured)

    // Assert
    expect(message).toBe(
      'No MCP server named "evil name". Configured servers: a b',
    )
    expect(message).not.toContain('\r')
  })

  test('picks the alphabetically first name on a distance tie', () => {
    // Arrange — both candidates are distance 1 from "aaa"; iQn sorts first,
    // and c7 keeps the STRICTLY lowest distance (first wins ties)
    const configured = ['aba', 'aab']

    // Act
    const message = mcpServerNotFoundMessage('aaa', configured)

    // Assert
    expect(message).toContain('Did you mean "aab"?')
  })
})

describe('mcpServerNotFoundMessageWithPending (binary u2t)', () => {
  test('stands the pending note alone when no servers are configured', () => {
    // Arrange & Act
    const message = mcpServerNotFoundMessageWithPending('nope', [], true)

    // Assert
    expect(message).toBe(
      'No MCP server named "nope". .mcp.json servers are awaiting approval — run `occ` in this directory to review them.',
    )
  })

  test('appends the pending note parenthesized to the enumeration', () => {
    // Arrange
    const configured = ['zeta-server']

    // Act
    const message = mcpServerNotFoundMessageWithPending('q', configured, true)

    // Assert
    expect(message).toBe(
      'No MCP server named "q". Configured servers: zeta-server ' +
        '(.mcp.json servers are awaiting approval — run `occ` in this ' +
        'directory to review them.)',
    )
  })

  test('appends the pending note to the did-you-mean variant too', () => {
    // Arrange & Act
    const message = mcpServerNotFoundMessageWithPending(
      'githb',
      ['github'],
      true,
    )

    // Assert
    expect(message).toStartWith(
      'No MCP server named "githb". Did you mean "github"?',
    )
    expect(message).toEndWith(
      '(.mcp.json servers are awaiting approval — run `occ` in this directory to review them.)',
    )
  })

  test('omits the note entirely without pending approvals', () => {
    // Arrange & Act
    const message = mcpServerNotFoundMessageWithPending(
      'q',
      ['zeta-server'],
      false,
    )

    // Assert
    expect(message).toBe(
      'No MCP server named "q". Configured servers: zeta-server',
    )
  })

  test('sanitizes the queried name in the pending-only variant', () => {
    // Arrange & Act
    const message = mcpServerNotFoundMessageWithPending(
      'evil\nname',
      [],
      true,
    )

    // Assert
    expect(message).toContain('No MCP server named "evil name".')
    expect(message).not.toContain('\nname')
  })
})
