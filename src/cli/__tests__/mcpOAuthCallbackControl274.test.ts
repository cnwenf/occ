/**
 * CC 2.1.274 review P2-2 (docs/upstream-version-gap-occ128.md): the headless
 * control-channel (`mcp_oauth_callback_url`) submission gating. A wrong-state
 * paste returns false from the submitter and the flow KEEPS WAITING — the
 * handler must respond with an IMMEDIATE error and must NOT await the auth
 * promise (pre-fix behavior blocked the single-threaded control-message loop
 * for up to the 5-minute flow timeout, a regression vs pr-base which failed
 * the paste instantly with a CSRF error).
 */
import { describe, expect, test } from 'bun:test'

import {
  CALLBACK_MISSING_CODE_MESSAGE,
  CALLBACK_NOT_ACCEPTED_MESSAGE,
  handleOAuthCallbackUrlControl,
} from '../mcpOAuthCallbackControl.js'

type CallLogEntry =
  | { kind: 'submit'; url: string }
  | { kind: 'markUsed' }
  | { kind: 'error'; message: string }
  | { kind: 'success' }

interface Harness {
  readonly calls: CallLogEntry[]
  run(serverName: string, callbackUrl: string): Promise<void>
}

function makeHarness(options: {
  submitter?: (url: string) => boolean
  authPromise?: Promise<void> | undefined
}): Harness {
  const calls: CallLogEntry[] = []
  return {
    calls,
    run: (serverName, callbackUrl) =>
      handleOAuthCallbackUrlControl(serverName, callbackUrl, {
        getSubmitter: () => options.submitter,
        getAuthPromise: () => options.authPromise,
        markManualCallbackUsed: () => {
          calls.push({ kind: 'markUsed' })
        },
        respondError: message => {
          calls.push({ kind: 'error', message })
        },
        respondSuccess: () => {
          calls.push({ kind: 'success' })
        },
      }),
  }
}

const VALID_URL = 'http://localhost:9/cb?code=a&state=S'

describe('2.1.274 headless mcp_oauth_callback_url gating (review P2-2)', () => {
  test('no registered submitter → immediate error, nothing else touched', async () => {
    const h = makeHarness({ submitter: undefined })
    await h.run('srv', VALID_URL)
    expect(h.calls).toEqual([
      { kind: 'error', message: 'No active OAuth flow for server: srv' },
    ])
  })

  test('URL without code/error param → missing-code error, submitter untouched', async () => {
    let submitted = 0
    const h = makeHarness({
      submitter: () => {
        submitted += 1
        return true
      },
    })
    await h.run('srv', 'http://localhost:9/cb?foo=bar')
    expect(h.calls).toEqual([
      { kind: 'error', message: CALLBACK_MISSING_CODE_MESSAGE },
    ])
    expect(submitted).toBe(0)
  })

  test('unparseable URL → missing-code error (no throw)', async () => {
    const h = makeHarness({ submitter: () => true })
    await h.run('srv', 'not a url ::: //')
    expect(h.calls).toEqual([
      { kind: 'error', message: CALLBACK_MISSING_CODE_MESSAGE },
    ])
  })

  test('rejected paste → IMMEDIATE error without awaiting the auth promise (no 5-min hang)', async () => {
    // Mutation gate: if the handler awaited authPromise on a rejected
    // submit, this never-resolving promise would hang the test until the
    // bun timeout — the pre-fix regression exactly.
    let resolveAuth!: () => void
    const neverResolves = new Promise<void>(resolve => {
      resolveAuth = resolve
    })
    neverResolves.catch(() => {})
    const h = makeHarness({ submitter: () => false, authPromise: neverResolves })

    await h.run('srv', VALID_URL)

    expect(h.calls).toEqual([
      { kind: 'error', message: CALLBACK_NOT_ACCEPTED_MESSAGE },
    ])
    // A rejected paste must NOT mark the manual path used — that would
    // suppress the background reconnect for a still-waiting flow.
    expect(h.calls.some(c => c.kind === 'markUsed')).toBe(false)
    resolveAuth()
  })

  test('accepted paste → marks manual use, awaits exchange, success', async () => {
    const submitted: string[] = []
    let resolveAuth!: () => void
    const authPromise = new Promise<void>(resolve => {
      resolveAuth = resolve
    })
    const h = makeHarness({
      submitter: url => {
        submitted.push(url)
        return true
      },
      authPromise,
    })

    const run = h.run('srv', VALID_URL)
    // Awaits the exchange: no response yet while it is pending.
    await Promise.resolve()
    expect(h.calls).toEqual([{ kind: 'markUsed' }])

    resolveAuth()
    await run

    expect(submitted).toEqual([VALID_URL])
    expect(h.calls).toEqual([{ kind: 'markUsed' }, { kind: 'success' }])
  })

  test('accepted paste with no tracked promise → success without waiting', async () => {
    const h = makeHarness({ submitter: () => true, authPromise: undefined })
    await h.run('srv', VALID_URL)
    expect(h.calls).toEqual([{ kind: 'markUsed' }, { kind: 'success' }])
  })

  test('exchange rejects with Error → error response carries the message', async () => {
    const h = makeHarness({
      submitter: () => true,
      authPromise: Promise.reject(new Error('token exchange exploded')),
    })
    await h.run('srv', VALID_URL)
    expect(h.calls).toEqual([
      { kind: 'markUsed' },
      { kind: 'error', message: 'token exchange exploded' },
    ])
  })

  test('exchange rejects with non-Error → generic failure message', async () => {
    const h = makeHarness({
      submitter: () => true,
      authPromise: Promise.reject('string failure'),
    })
    await h.run('srv', VALID_URL)
    expect(h.calls).toEqual([
      { kind: 'markUsed' },
      { kind: 'error', message: 'OAuth authentication failed' },
    ])
  })

  test('error-param callback URL passes validation and reaches the submitter', async () => {
    const submitted: string[] = []
    const h = makeHarness({
      submitter: url => {
        submitted.push(url)
        return true
      },
      authPromise: undefined,
    })
    await h.run('srv', 'http://localhost:9/cb?error=access_denied&state=S')
    expect(submitted).toEqual([
      'http://localhost:9/cb?error=access_denied&state=S',
    ])
    expect(h.calls.at(-1)).toEqual({ kind: 'success' })
  })
})
