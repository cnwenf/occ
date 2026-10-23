import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AssistantMessage } from '../../../types/message.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import {
  CCR_AUTH_ERROR_MESSAGE,
  CCR_AUTH_REASON_MAX_CONTENT_LENGTH,
  getAssistantMessageFromError,
} from '../errors.js'

/**
 * CC 2.1.307 (A8): in CCR mode (CLAUDE_CODE_REMOTE), a 403 that carries a
 * reason now surfaces that reason instead of the generic auth message.
 * Byte-verified from the v307 ELF text dump (new307.txt @2539100 region):
 *
 *   if(e instanceof Ht&&(e.status===401||e.status===403)){
 *     ...
 *     if(Y5t()){                                   // Y5t(): CLAUDE_CODE_REMOTE
 *       let K=e.status===403?ftr(e):null,          // reason (403 only)
 *           Q=`${e.status} `,
 *           Se=`${Dl}: ${Q}`,                      // Dl="API Error"
 *           be=K&&Ot(K,MLe-Se.length-1);           // MLe=1000, Ot truncator
 *       return Ws({error:"authentication_failed",
 *         content:be?Se+(be.startsWith(Q)?be.slice(Q.length):be):K5t})
 *     }                                            // K5t ≡ CCR_AUTH_ERROR_MESSAGE
 *
 *   function ftr(e){if(!R(e))return null;let n=e.error,
 *     o=n?.error?.message;  if(typeof o==="string"&&o.length>0){let s=C(o);if(s.length>0)return s}
 *     let a=n?.message;     if(typeof a==="string"&&a.length>0){let s=C(a);if(s.length>0)return s}
 *     return null}
 *   function R(e){return typeof e==="object"&&e!==null&&"error"in e&&typeof e.error==="object"&&e.error!==null}
 *   function C(e){if(/<!DOCTYPE html|<html\b/i.test(e)){let r=e.match(/<title>([^<]+)<\/title>/i);
 *     if(r&&r[1])return r[1].trim();return""}return e}
 *   var Dl="API Error",MLe=1000;
 *
 * The exact `Ot` truncator body was NOT recoverable from the binary (the
 * 2-letter name collides across bundle chunks); OCC uses a conservative
 * slice-to-budget that preserves the observable contract: total content
 * length ≤ MLe (1000).
 *
 * The SECOND CCR site (x-api-key invalid-credentials handler, errors.ts ~:935)
 * is UNCHANGED in v307 (byte-verified: `if(g3t(e)){if(Y5t())return Ws({error:
 * "authentication_failed",content:K5t})...}`) — not touched here.
 */

const MODEL = 'claude-sonnet-4-6'

const ENV_KEYS = [
  'CLAUDE_CODE_REMOTE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'USER_TYPE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpConfigDir: string
let prevConfigDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  // Isolate settings so the apiKeyHelper arm (firstParty + helper auth source
  // + helper error) can never preempt the CCR branch.
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-ccr-403-reason-307-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  resetSettingsCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  resetSettingsCache()
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

function messageText(msg: AssistantMessage): string {
  const content = msg.message.content as Array<{ text?: string }>
  return content.map(block => block.text ?? '').join('')
}

function forbidden(body: unknown, message?: string): APIError {
  return new APIError(403, body, message, undefined)
}

function textFor(error: APIError): string {
  return messageText(getAssistantMessageFromError(error, MODEL))
}

describe('CC 2.1.307 A8 — CCR 403 reason extraction (official ftr)', () => {
  test('nested body reason (error.error.message) renders as "API Error: 403 <reason>"', () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({ error: { message: 'Access denied: org policy' } })

    // Act
    const text = textFor(error)

    // Assert — head Se = `${Dl}: ${Q}` = "API Error: 403 "
    expect(text).toBe('API Error: 403 Access denied: org policy')
  })

  test('direct body reason (error.message) renders the same way', () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({ message: 'Access denied: org policy' })

    // Act
    const text = textFor(error)

    // Assert — ftr tries error.error.message first, then error.message
    expect(text).toBe('API Error: 403 Access denied: org policy')
  })

  test('nested reason wins over direct reason (official ftr order)', () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({
      error: { message: 'nested reason' },
      message: 'direct reason',
    })

    // Act & Assert
    expect(textFor(error)).toBe('API Error: 403 nested reason')
  })

  test('reason already starting with "403 " is deduped, not doubled', () => {
    // Arrange — official: be.startsWith(Q)?be.slice(Q.length):be
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({ message: '403 Access denied' })

    // Act
    const text = textFor(error)

    // Assert
    expect(text).toBe('API Error: 403 Access denied')
    expect(text).not.toContain('403 403')
  })

  test('HTML error body collapses to its <title> text (official C)', () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = '1'
    const html =
      '<!DOCTYPE html><html><head><title> Forbidden by org policy </title></head><body><h1>403</h1></body></html>'
    const error = forbidden({ message: html })

    // Act
    const text = textFor(error)

    // Assert — title extracted and trimmed; raw markup never leaks
    expect(text).toBe('API Error: 403 Forbidden by org policy')
    expect(text).not.toContain('<html')
  })

  test('HTML body without a title falls back to the generic CCR message', () => {
    // Arrange — official C returns '' for titleless HTML → ftr null → K5t
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({ message: '<html><body>nope</body></html>' })

    // Act & Assert
    expect(textFor(error)).toBe(CCR_AUTH_ERROR_MESSAGE)
  })

  test('403 with no reason in the body falls back to the generic CCR message', () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden(undefined, 'Forbidden')

    // Act & Assert
    expect(textFor(error)).toBe(CCR_AUTH_ERROR_MESSAGE)
  })

  test('403 with an empty-string reason falls back to the generic CCR message', () => {
    // Arrange — official ftr requires o.length>0 / a.length>0
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({ message: '' })

    // Act & Assert
    expect(textFor(error)).toBe(CCR_AUTH_ERROR_MESSAGE)
  })

  test('401 never extracts a reason (official: K=e.status===403?ftr(e):null)', () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = new APIError(
      401,
      { message: 'Access denied: org policy' },
      undefined,
      undefined,
    )

    // Act & Assert
    expect(textFor(error)).toBe(CCR_AUTH_ERROR_MESSAGE)
  })

  test('an oversized reason is truncated within the 1000-char content budget', () => {
    // Arrange — MLe=1000 total-content contract; head "API Error: 403 " is
    // 15 chars, budget = 1000 - 15 - 1 = 984.
    process.env.CLAUDE_CODE_REMOTE = '1'
    const error = forbidden({ message: 'x'.repeat(5000) })

    // Act
    const text = textFor(error)

    // Assert
    expect(text.startsWith('API Error: 403 ')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(CCR_AUTH_REASON_MAX_CONTENT_LENGTH)
    expect(CCR_AUTH_REASON_MAX_CONTENT_LENGTH).toBe(1000)
  })
})

describe('CC 2.1.307 A8 — non-CCR behavior unchanged', () => {
  test('without CLAUDE_CODE_REMOTE a 403 reason rides the normal /login path', () => {
    // Arrange — CCR env deliberately unset
    const error = forbidden(
      { message: 'Access denied: org policy' },
      'Access denied: org policy',
    )

    // Act
    const text = textFor(error)

    // Assert — the normal generic 401/403 rendering (interactive or
    // non-interactive prefix), NOT the CCR treatment
    expect(text).toContain('Access denied: org policy')
    expect(text).not.toContain('Authentication error ·')
    expect(text).toContain('API Error')
  })
})
