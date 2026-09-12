import { describe, expect, test } from 'bun:test'
import {
  getURLMarkdownContent,
  invalidUrlErrorMessage,
  validateURL,
} from '../utils.js'

/**
 * CC 2.1.268 (E37): WebFetch dotless-hostname error message. The official
 * binary (fn jvn) — when its validateURL equivalent fails — re-parses with
 * `URL.parse(url)?.hostname` and, if the hostname exists and contains no dot,
 * throws "WebFetch cannot fetch localhost or other hostnames without a dot.
 * To reach a local server, use Bash with curl instead." (error code
 * web-fetch-dotless-host); otherwise it keeps the generic "Invalid URL"
 * (web-fetch-invalid-url). Message byte-verified against s2s.txt/added.txt.
 * The branch is a pure helper (invalidUrlErrorMessage), so no network needed.
 */

const DOTLESS_MESSAGE =
  'WebFetch cannot fetch localhost or other hostnames without a dot. To reach a local server, use Bash with curl instead.'

describe('2.1.268: WebFetch dotless-hostname error (E37)', () => {
  test('localhost URL yields the dedicated dotless-hostname message', () => {
    // Arrange / Act
    const message = invalidUrlErrorMessage('http://localhost:3000/x')

    // Assert
    expect(message).toBe(DOTLESS_MESSAGE)
  })

  test('dotless intranet hostname yields the dedicated message', () => {
    expect(invalidUrlErrorMessage('http://intranet/x')).toBe(DOTLESS_MESSAGE)
  })

  test('syntactically invalid URL keeps the generic Invalid URL message', () => {
    expect(invalidUrlErrorMessage('::::')).toBe('Invalid URL')
    expect(invalidUrlErrorMessage('http://exa mple.com/')).toBe('Invalid URL')
  })

  test('URL rejected for other validateURL reasons keeps Invalid URL', () => {
    // Parses fine and hostname HAS dots — validateURL rejects it for the
    // embedded credentials, but the dotless message must not fire.
    expect(invalidUrlErrorMessage('http://user:pass@example.com/x')).toBe(
      'Invalid URL',
    )
  })

  test('dotted hosts are unaffected: validateURL still passes them', () => {
    expect(validateURL('https://example.com/x')).toBe(true)
    expect(validateURL('http://localhost:3000/x')).toBe(false)
    expect(validateURL('http://intranet/x')).toBe(false)
  })

  test('getURLMarkdownContent throws the exact message before any fetch', async () => {
    // The validateURL branch is the first statement — rejects synchronously,
    // no network involved. Tool-call errors surface to the model via
    // toolExecution's `Error calling tool…: ${error.message}` wrapper, so the
    // exact text reaches the model unchanged.
    await expect(
      getURLMarkdownContent('http://localhost:3000/x', new AbortController()),
    ).rejects.toThrow(DOTLESS_MESSAGE)

    await expect(
      getURLMarkdownContent('::::', new AbortController()),
    ).rejects.toThrow('Invalid URL')
  })
})
