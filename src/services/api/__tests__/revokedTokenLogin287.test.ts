import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getIsInteractive,
  setIsInteractive,
} from '../../../bootstrap/state.js'
import type { AssistantMessage } from '../../../types/message.js'
import {
  classifyAPIError,
  getAssistantMessageFromError,
  getTokenRevokedErrorMessage,
  TOKEN_REVOKED_ERROR_MESSAGE,
} from '../errors.js'

/**
 * CC 2.1.287 (Cluster-B Item 4): a revoked claude.ai login no longer surfaces
 * as a generic `API Error: 401`, and the `-p`/print-mode message now leads with
 * "Failed to authenticate".
 *
 * Official v287 predicate `PZ` (@198284746) adds a 401 arm to the previously
 * 403-only revocation check (v286 `X7`):
 *   function PZ(e){if(!(e instanceof xt))return!1;let r=e.message??"";
 *     return e.status===403&&r.includes("OAuth token has been revoked")
 *         ||e.status===401&&r.includes("OAuth access token has been revoked")}
 * and message fn `Q3n` adds the print-mode arm:
 *   function Q3n(){return ke()
 *     ?"Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator."
 *     :Elt}
 *   // Elt = "OAuth token revoked · Please run /login"   (interactive)
 * Call site: `if(PZ(e))return ns({error:"authentication_failed",content:Q3n()})`.
 *
 * Mapping: `ke()` ≡ OCC getIsNonInteractiveSession(); `xt` ≡ APIError; `ns` ≡
 * createAssistantAPIErrorMessage. BOTH OCC revocation predicates
 * (getAssistantMessageFromError + classifyAPIError) mirror `PZ`; each arm stays
 * status+message PAIRED (403↔"OAuth token…", 401↔"OAuth access token…"), so a
 * cross-wired status/message must NOT match — pinned by the negative controls.
 */

const MODEL = 'claude-opus-5'
const MSG_403 = 'OAuth token has been revoked'
const MSG_401 = 'OAuth access token has been revoked'
const PRINT_MODE_MESSAGE =
  'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.'

/**
 * An APIError whose `.message` carries the given body text. The SDK's
 * APIError.makeMessage derives `.message` as `${status} ${body.message}`, so
 * `error.message.includes(body)` is guaranteed (outputContentFiltered285
 * discipline).
 */
function apiError(status: number, bodyMessage: string): APIError {
  return new APIError(status, { message: bodyMessage }, bodyMessage, undefined)
}

/** The rendered text of an AssistantMessage from getAssistantMessageFromError. */
function messageText(msg: AssistantMessage): string {
  const content = msg.message?.content as Array<{ text?: string }> | undefined
  return Array.isArray(content)
    ? content.map(block => block.text ?? '').join('')
    : ''
}

// STATE.isInteractive defaults to false (non-interactive). Snapshot + restore so
// flipping the arm here never leaks into the shared single-process test run.
let savedInteractive = false

beforeEach(() => {
  savedInteractive = getIsInteractive()
})

afterEach(() => {
  setIsInteractive(savedInteractive)
})

describe('CC 2.1.287 Item 4 — getAssistantMessageFromError: revoked-token predicate (PZ)', () => {
  test('401 "OAuth access token has been revoked" → authentication_failed (new v287 arm)', () => {
    // Arrange — print mode (non-interactive).
    setIsInteractive(false)

    // Act
    const msg = getAssistantMessageFromError(apiError(401, MSG_401), MODEL)

    // Assert — mapped through the revocation predicate, not the generic 401.
    expect(msg.error).toBe('authentication_failed')
    expect(messageText(msg)).toBe(PRINT_MODE_MESSAGE)
  })

  test('403 "OAuth token has been revoked" → authentication_failed (retained arm)', () => {
    // Arrange
    setIsInteractive(false)

    // Act
    const msg = getAssistantMessageFromError(apiError(403, MSG_403), MODEL)

    // Assert — the original v286 arm still fires.
    expect(msg.error).toBe('authentication_failed')
    expect(messageText(msg)).toBe(PRINT_MODE_MESSAGE)
  })

  test('interactive session → the /login message (Elt), not the print-mode text', () => {
    // Arrange — interactive arm of Q3n.
    setIsInteractive(true)

    // Act
    const msg = getAssistantMessageFromError(apiError(401, MSG_401), MODEL)

    // Assert
    expect(msg.error).toBe('authentication_failed')
    expect(messageText(msg)).toBe(TOKEN_REVOKED_ERROR_MESSAGE)
    expect(messageText(msg)).toBe('OAuth token revoked · Please run /login')
  })
})

describe('CC 2.1.287 Item 4 — classifyAPIError: token_revoked (PZ mirror)', () => {
  test('401 "OAuth access token has been revoked" → token_revoked', () => {
    expect(classifyAPIError(apiError(401, MSG_401))).toBe('token_revoked')
  })

  test('403 "OAuth token has been revoked" → token_revoked', () => {
    expect(classifyAPIError(apiError(403, MSG_403))).toBe('token_revoked')
  })

  test('a generic 401 (unrelated message) is NOT token_revoked', () => {
    expect(classifyAPIError(apiError(401, 'invalid credentials'))).not.toBe(
      'token_revoked',
    )
  })
})

describe('CC 2.1.287 Item 4 — PZ arms are status+message PAIRED (negative controls)', () => {
  test('401 carrying the 403-style message does NOT map to revocation', () => {
    // The 401 arm requires "OAuth access token has been revoked"; the plain
    // 403 text must fall through to the generic auth handler.
    setIsInteractive(false)
    expect(classifyAPIError(apiError(401, MSG_403))).not.toBe('token_revoked')
    const msg = getAssistantMessageFromError(apiError(401, MSG_403), MODEL)
    expect(messageText(msg)).not.toBe(PRINT_MODE_MESSAGE)
  })

  test('403 carrying the 401-style "access token" message does NOT map to revocation', () => {
    // "OAuth access token has been revoked" does NOT contain the substring
    // "OAuth token has been revoked", and the status is 403 (not 401) — so
    // neither arm matches.
    setIsInteractive(false)
    expect(classifyAPIError(apiError(403, MSG_401))).not.toBe('token_revoked')
    const msg = getAssistantMessageFromError(apiError(403, MSG_401), MODEL)
    expect(messageText(msg)).not.toBe(PRINT_MODE_MESSAGE)
  })
})

describe('CC 2.1.287 Item 4 — getTokenRevokedErrorMessage (Q3n)', () => {
  test('non-interactive (print mode) → the "Failed to authenticate" arm', () => {
    // Arrange
    setIsInteractive(false)

    // Act
    const text = getTokenRevokedErrorMessage()

    // Assert — byte-exact v287 print-mode string, and it leads with the
    // "Failed to authenticate" prefix the changelog calls out for `-p`.
    expect(text).toBe(PRINT_MODE_MESSAGE)
    expect(text.startsWith('Failed to authenticate')).toBe(true)
  })

  test('interactive → the /login arm (Elt constant)', () => {
    // Arrange
    setIsInteractive(true)

    // Act + Assert
    expect(getTokenRevokedErrorMessage()).toBe(TOKEN_REVOKED_ERROR_MESSAGE)
    expect(getTokenRevokedErrorMessage()).toBe(
      'OAuth token revoked · Please run /login',
    )
  })
})
