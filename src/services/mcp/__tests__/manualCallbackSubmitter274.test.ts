/**
 * CC 2.1.274 — manual OAuth callback submitter semantics (official submitter
 * `F` in the MCP auth chunk, live-binary verified @220054636 region).
 *
 * The 274 behavior change this locks in: a pasted callback URL whose state
 * belongs to a DIFFERENT flow no longer aborts the live flow with a CSRF
 * error — the submitter logs "Ignoring manual callback URL whose state
 * belongs to a different flow", returns false, and the flow KEEPS WAITING.
 * Return contract: true = this flow consumed the URL (code resolved or error
 * rejected); false = flow still waiting.
 *
 * Official check order (byte-verified): `!code && !error` → state check →
 * error branch → code branch. A wrong-state URL carrying `error` is IGNORED
 * (state check precedes the error branch), never rejected into the flow.
 *
 * Forensics: docs/upstream-version-gap-occ128.md.
 */
import { describe, expect, test } from 'bun:test'

import { createManualCallbackSubmitter } from '../auth.js'

function makeHooks() {
  const calls = {
    cleanup: 0,
    resolved: [] as string[],
    rejected: [] as string[],
  }
  const submitter = createManualCallbackSubmitter('srv', 'STATE-1', {
    cleanup: () => {
      calls.cleanup += 1
    },
    resolveCode: code => {
      calls.resolved.push(code)
    },
    rejectFlow: err => {
      calls.rejected.push(err.message)
    },
  })
  return { submitter, calls }
}

describe('2.1.274 createManualCallbackSubmitter', () => {
  test('returns false for a URL with neither code nor error, flow untouched', () => {
    const { submitter, calls } = makeHooks()
    expect(submitter('http://localhost:1234/callback?foo=bar')).toBe(false)
    expect(calls.cleanup).toBe(0)
    expect(calls.resolved).toEqual([])
    expect(calls.rejected).toEqual([])
  })

  test('returns false for an unparseable URL, flow untouched', () => {
    const { submitter, calls } = makeHooks()
    expect(submitter('not a url at all')).toBe(false)
    expect(calls.cleanup).toBe(0)
  })

  test('wrong-state code URL returns false and KEEPS the flow waiting (no CSRF abort)', () => {
    const { submitter, calls } = makeHooks()
    const stale =
      'http://localhost:1234/callback?code=abc&state=STATE-FROM-OLDER-FLOW'
    expect(submitter(stale)).toBe(false)
    expect(calls.cleanup).toBe(0)
    expect(calls.resolved).toEqual([])
    expect(calls.rejected).toEqual([])
  })

  test('wrong-state URL carrying error is also ignored (state check precedes error branch)', () => {
    const { submitter, calls } = makeHooks()
    expect(
      submitter(
        'http://localhost:1234/callback?error=access_denied&state=OTHER',
      ),
    ).toBe(false)
    expect(calls.rejected).toEqual([])
    expect(calls.cleanup).toBe(0)
  })

  test('matching-state code URL resolves the code, cleans up, returns true', () => {
    const { submitter, calls } = makeHooks()
    expect(
      submitter('http://localhost:1234/callback?code=CODE-9&state=STATE-1'),
    ).toBe(true)
    expect(calls.resolved).toEqual(['CODE-9'])
    expect(calls.cleanup).toBe(1)
    expect(calls.rejected).toEqual([])
  })

  test('matching-state error URL rejects with official message shape, returns true', () => {
    const { submitter, calls } = makeHooks()
    expect(
      submitter(
        'http://localhost:1234/callback?error=access_denied&error_description=user%20said%20no&state=STATE-1',
      ),
    ).toBe(true)
    expect(calls.rejected).toEqual(['OAuth error: access_denied - user said no'])
    expect(calls.cleanup).toBe(1)
    expect(calls.resolved).toEqual([])
  })

  test('matching-state error URL without description rejects with empty tail', () => {
    const { submitter, calls } = makeHooks()
    expect(
      submitter('http://localhost:1234/callback?error=server_error&state=STATE-1'),
    ).toBe(true)
    expect(calls.rejected).toEqual(['OAuth error: server_error - '])
  })
})
