/**
 * CC 2.1.229 (changelog #27 / binary `KWm`/`XWm`/`VWm`/`YWm`): /login
 * CLAUDE_CODE_OAUTH_TOKEN override warning — shown at login start AND
 * repeated after a successful login.
 *
 * Tests the two exported pure message builders for byte-exact parity with
 * the 2.1.229 binary, including the two-newline separator between the done
 * base message and the repeated env-token note.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildLoginDoneMessage, getLoginStartingMessage } from '../login.js'

const WARNING_TAIL =
  'but if that variable is set in your shell profile or a Claude Code settings file, new `claude` sessions will keep using the old token until you remove it there.'

let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})

afterEach(() => {
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
})

describe('getLoginStartingMessage (binary KWm)', () => {
  test('returns undefined when CLAUDE_CODE_OAUTH_TOKEN is not set', () => {
    expect(getLoginStartingMessage()).toBeUndefined()
  })

  test('returns the byte-exact warning when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'some-token'
    expect(getLoginStartingMessage()).toBe(
      `Warning: CLAUDE_CODE_OAUTH_TOKEN is set in your environment. This session will switch to your new credentials after logging in, ${WARNING_TAIL}`,
    )
  })
})

describe('buildLoginDoneMessage (binary XWm)', () => {
  test('returns "Login interrupted" on failure regardless of opts', () => {
    expect(
      buildLoginDoneMessage(false, {
        bridgeDisconnected: false,
        envTokenWasSet: false,
        gatewayActive: false,
      }),
    ).toBe('Login interrupted')
    expect(
      buildLoginDoneMessage(false, {
        bridgeDisconnected: true,
        envTokenWasSet: true,
        gatewayActive: false,
      }),
    ).toBe('Login interrupted')
  })

  test('returns plain "Login successful" on success without env token', () => {
    expect(
      buildLoginDoneMessage(true, {
        bridgeDisconnected: false,
        envTokenWasSet: false,
        gatewayActive: false,
      }),
    ).toBe('Login successful')
  })

  test('repeats the env-token note after success, separated by two newlines', () => {
    const message = buildLoginDoneMessage(true, {
      bridgeDisconnected: false,
      envTokenWasSet: true,
      gatewayActive: false,
    })
    expect(message).toBe(
      'Login successful\n\n' +
        `Note: CLAUDE_CODE_OAUTH_TOKEN was set in your environment when /login started. This session will use your new credentials, ${WARNING_TAIL}`,
    )
    // Byte-exact separator check (raw-byte verified against the binary).
    expect(message.includes('\n\nNote:')).toBe(true)
    expect(message.includes('\n\n\n')).toBe(false)
  })

  test('omits the note when a gateway is active', () => {
    expect(
      buildLoginDoneMessage(true, {
        bridgeDisconnected: false,
        envTokenWasSet: true,
        gatewayActive: true,
      }),
    ).toBe('Login successful')
  })

  test('bridge-disconnected base still gets the note appended (byte-parity branch)', () => {
    const message = buildLoginDoneMessage(true, {
      bridgeDisconnected: true,
      envTokenWasSet: true,
      gatewayActive: false,
    })
    expect(message).toBe(
      'Login successful. Remote Control disconnected.\n\n' +
        `Note: CLAUDE_CODE_OAUTH_TOKEN was set in your environment when /login started. This session will use your new credentials, ${WARNING_TAIL}`,
    )
  })

  test('bridge-disconnected without env token', () => {
    expect(
      buildLoginDoneMessage(true, {
        bridgeDisconnected: true,
        envTokenWasSet: false,
        gatewayActive: false,
      }),
    ).toBe('Login successful. Remote Control disconnected.')
  })
})
