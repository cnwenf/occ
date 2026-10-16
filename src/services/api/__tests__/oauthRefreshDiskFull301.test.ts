// CC 2.1.301 PORT #9 — OAuthRefreshDiskFullError + its user-facing message arm.
//
// Official v301 (linux-x64 ELF, byte-verified via grep+dd — binary NEVER
// executed):
//   class `wG` @226803700 region:
//     `class wG extends Error{constructor(){super("OAuth access token could
//      not be refreshed: the disk that holds the Claude Code config
//      directory, or the disk quota on it, is full; delete files you no
//      longer need on that disk and try again");
//      this.name="OAuthRefreshDiskFullError"}}`
//   mapper arm @226834409:
//     `if(e instanceof wG)return{...Ms({error:"invalid_request",
//        content:we()?"Failed to refresh OAuth token: the disk that holds
//        the Claude Code config directory (~/.claude by default), or your
//        disk quota on it, is full. Delete files you no longer need on that
//        disk and retry; signing in again won't help":OUo}),
//        oauthRefreshDiskFull:!0}`
//   where `we()` ≡ getIsNonInteractiveSession() and OUo (interactive arm,
//   @106575564, middle dot byte \xB7 verified via xxd `6675 6c6c 20b7 2044`):
//     "Could not refresh your login: the disk that holds the Claude Code
//      config directory (~/.claude by default), or your disk quota on it, is
//      full · Delete files you no longer need on that disk, then try again ·
//      Signing in again won't help"
//   The arm sits BEFORE the token-revoked arm so a disk-full refresh failure
//   never surfaces the misleading "OAuth token revoked · Please run /login".
//   DEVIATION: the official spreads an extra `oauthRefreshDiskFull:!0` flag
//   onto the assistant message; OCC's createAssistantAPIErrorMessage /
//   AssistantMessage taxonomy has no such field and nothing consumes it, so
//   it is not ported (noted in the round report).

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// --- mock: getIsNonInteractiveSession (official `we()`) ----------------------
// Passthrough-flag pattern — snapshot taken BEFORE mocking; flag flips off in
// afterAll so later files in the shared bun process see the real bootstrap
// state module.

const actualState = { ...require('../../../bootstrap/state.js') } as typeof import('../../../bootstrap/state.js')
let stateMockActive = true
let nonInteractiveMock = false
mock.module('../../../bootstrap/state.js', () => ({
  ...actualState,
  getIsNonInteractiveSession: () =>
    stateMockActive
      ? nonInteractiveMock
      : actualState.getIsNonInteractiveSession(),
}))

// Require AFTER mock registration.
const {
  OAuthRefreshDiskFullError,
  getOAuthRefreshDiskFullErrorMessage,
  getAssistantMessageFromError,
  TOKEN_REVOKED_ERROR_MESSAGE,
} = require('../errors.js') as typeof import('../errors.js')

beforeEach(() => {
  nonInteractiveMock = false
})

afterEach(() => {
  nonInteractiveMock = false
})

afterAll(() => {
  stateMockActive = false
})

// --- verbatim strings (byte-verified against the v301 ELF) --------------------

const CLASS_MESSAGE =
  'OAuth access token could not be refreshed: the disk that holds the Claude Code config directory, or the disk quota on it, is full; delete files you no longer need on that disk and try again'
const INTERACTIVE_MESSAGE =
  'Could not refresh your login: the disk that holds the Claude Code config directory (~/.claude by default), or your disk quota on it, is full · Delete files you no longer need on that disk, then try again · Signing in again won\'t help'
const HEADLESS_MESSAGE =
  'Failed to refresh OAuth token: the disk that holds the Claude Code config directory (~/.claude by default), or your disk quota on it, is full. Delete files you no longer need on that disk and retry; signing in again won\'t help'

// --- tests ---------------------------------------------------------------------

test('OAuthRefreshDiskFullError: name, inheritance, and verbatim constructor message', () => {
  // Arrange/Act
  const error = new OAuthRefreshDiskFullError()

  // Assert
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('OAuthRefreshDiskFullError')
  expect(error.message).toBe(CLASS_MESSAGE)
})

test('getOAuthRefreshDiskFullErrorMessage: interactive arm (OUo) verbatim, middle dot U+00B7', () => {
  // Arrange
  nonInteractiveMock = false

  // Act/Assert
  const message = getOAuthRefreshDiskFullErrorMessage()
  expect(message).toBe(INTERACTIVE_MESSAGE)
  // The separators are U+00B7 MIDDLE DOT (byte-verified \xB7), same family as
  // the other interactive auth pills.
  expect(message.split('·').length).toBe(3)
})

test('getOAuthRefreshDiskFullErrorMessage: headless/non-interactive arm verbatim', () => {
  // Arrange
  nonInteractiveMock = true

  // Act/Assert
  expect(getOAuthRefreshDiskFullErrorMessage()).toBe(HEADLESS_MESSAGE)
})

test('getAssistantMessageFromError maps OAuthRefreshDiskFullError to the interactive arm with error code invalid_request', () => {
  // Arrange
  nonInteractiveMock = false

  // Act
  const msg = getAssistantMessageFromError(
    new OAuthRefreshDiskFullError(),
    'test-model',
    { messages: [], messagesForAPI: [] },
  )

  // Assert — official `Ms({error:"invalid_request",content:…})` shape.
  expect(msg.isApiErrorMessage).toBe(true)
  expect(msg.error).toBe('invalid_request')
  const text = (msg.message.content as Array<{ type: string; text: string }>)[0]
  expect(text?.text).toBe(INTERACTIVE_MESSAGE)
  // The whole point of #9: NOT the misleading revoked-token pill.
  expect(text?.text).not.toBe(TOKEN_REVOKED_ERROR_MESSAGE)
})

test('getAssistantMessageFromError maps OAuthRefreshDiskFullError to the headless arm in non-interactive sessions', () => {
  // Arrange
  nonInteractiveMock = true

  // Act
  const msg = getAssistantMessageFromError(
    new OAuthRefreshDiskFullError(),
    'test-model',
    { messages: [], messagesForAPI: [] },
  )

  // Assert
  expect(msg.error).toBe('invalid_request')
  const text = (msg.message.content as Array<{ type: string; text: string }>)[0]
  expect(text?.text).toBe(HEADLESS_MESSAGE)
})
