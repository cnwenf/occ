import { gunzipSync } from 'zlib'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.300 (#59): "Changed large requests to api.anthropic.com to use gzip
 * compression even when telemetry is disabled; set
 * CLAUDE_CODE_GZIP_REQUEST_BODIES=0 to turn it off."
 *
 * Official v300 gzip module @219895347 (byte-verified):
 *   D=4096 (api min body chars), N=8192 (sniff read cap)
 *   vMt(url, body, res, rollout="api") decision fn; If(url) host check
 *     ["api.anthropic.com"] @216214637
 *   env tri-state O(): CLAUDE_CODE_GZIP_REQUEST_BODIES false→env_off /
 *     true→gzip (transport checks skipped, latch still honored)
 *   H(url) transport skips: unix_socket / proxy / mtls / custom_ca
 *   q() latch: latchedOff=rejectedThisProcess=persistedLatchChecked=true
 *   h() rejection classifier: status 400/403/415 + W() anthropic-response
 *     check (request-id "req_" prefix or cf-ray) + V() bad-json body sniff
 *     (Q strings + /^bad json: …/ regex)
 *   a_o() fallback: latch, cancel body, strip compress, re-dispatch with
 *     identityBody, warn "[API REQUEST] gzip request body rejected …"
 *   Removed flags: tengu_gzip_request_bodies / tengu_atomic_ocean (0 hits in
 *     s300) → gzip default-on for the api rollout.
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const MTLS_PATH = '../../../utils/mtls.js'
let realMtls: Record<string, unknown> = {}
let mtlsOverride: (() => { cert?: string } | undefined) | null = null

beforeAll(async () => {
  realMtls = { ...((await import(MTLS_PATH)) as object) }
  // OCC-97 seam: override only getMTLSConfig for the mtls-skip case.
  mock.module(MTLS_PATH, () => ({
    ...realMtls,
    getMTLSConfig: () =>
      mtlsOverride
        ? mtlsOverride()
        : (
            realMtls.getMTLSConfig as () => { cert?: string } | undefined
          )(),
  }))
})

afterAll(() => {
  mock.module(MTLS_PATH, () => ({ ...realMtls }))
})

const {
  shouldGzipRequestBody,
  latchGzipRequestBodyOff,
  resetGzipRequestBodyLatch,
  isGzipRequestBodyLatchedOff,
  GZIP_MIN_BODY_CHARS,
} = require('../gzipRequestBody.js') as typeof import('../gzipRequestBody.js')
const { buildFetch } = require('../client.js') as typeof import('../client.js')

const ENV_KEYS = [
  'CLAUDE_CODE_GZIP_REQUEST_BODIES',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'ANTHROPIC_UNIX_SOCKET',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_ENTRYPOINT',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  mtlsOverride = null
  resetGzipRequestBodyLatch()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  mtlsOverride = null
  resetGzipRequestBodyLatch()
})

const API_URL = 'https://api.anthropic.com/v1/messages'

/** A JSON request body of at least `chars` characters. */
function bigBody(chars = 6000): string {
  const payload = { model: 'claude', messages: [], pad: 'x'.repeat(chars) }
  return JSON.stringify(payload)
}

describe('shouldGzipRequestBody (official vMt)', () => {
  test('gzips large string bodies to api.anthropic.com', () => {
    const body = bigBody()
    const decision = shouldGzipRequestBody(API_URL, body)
    expect(decision).toEqual({ gzip: true, bodyChars: body.length })
  })

  test('returns undefined for non-anthropic hosts (official If)', () => {
    expect(
      shouldGzipRequestBody('https://example.com/v1/messages', bigBody()),
    ).toBeUndefined()
    expect(
      shouldGzipRequestBody('https://api.anthropic.com.evil.com/x', bigBody()),
    ).toBeUndefined()
  })

  test('skips bodies below the 4096-char minimum (official D)', () => {
    expect(GZIP_MIN_BODY_CHARS).toBe(4096)
    const small = 'x'.repeat(GZIP_MIN_BODY_CHARS - 1)
    expect(shouldGzipRequestBody(API_URL, small)).toEqual({
      gzip: false,
      reason: 'below_min_size',
      bodyChars: small.length,
    })
    const exact = 'x'.repeat(GZIP_MIN_BODY_CHARS)
    expect(shouldGzipRequestBody(API_URL, exact)?.gzip).toBe(true)
  })

  test('skips non-string bodies', () => {
    expect(shouldGzipRequestBody(API_URL, new Uint8Array(5000))).toEqual({
      gzip: false,
      reason: 'non_string_body',
      bodyChars: undefined,
    })
    expect(shouldGzipRequestBody(API_URL, undefined)).toEqual({
      gzip: false,
      reason: 'non_string_body',
      bodyChars: undefined,
    })
  })

  test('CLAUDE_CODE_GZIP_REQUEST_BODIES=0 turns gzip off (env_off)', () => {
    process.env.CLAUDE_CODE_GZIP_REQUEST_BODIES = '0'
    expect(shouldGzipRequestBody(API_URL, bigBody())).toEqual({
      gzip: false,
      reason: 'env_off',
      bodyChars: bigBody().length,
    })
    process.env.CLAUDE_CODE_GZIP_REQUEST_BODIES = 'false'
    expect(shouldGzipRequestBody(API_URL, bigBody())?.gzip).toBe(false)
  })

  test('CLAUDE_CODE_GZIP_REQUEST_BODIES=1 forces gzip past transport skips but not the latch', () => {
    process.env.CLAUDE_CODE_GZIP_REQUEST_BODIES = '1'
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'
    expect(shouldGzipRequestBody(API_URL, bigBody())?.gzip).toBe(true)
    latchGzipRequestBodyOff()
    expect(shouldGzipRequestBody(API_URL, bigBody())).toEqual({
      gzip: false,
      reason: 'latched_off',
      bodyChars: bigBody().length,
    })
  })

  test('transport skips: unix_socket / proxy / mtls / custom_ca (official H)', () => {
    const body = bigBody()
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/api.sock'
    expect(shouldGzipRequestBody(API_URL, body)).toEqual({
      gzip: false,
      reason: 'unix_socket',
      bodyChars: body.length,
    })
    delete process.env.ANTHROPIC_UNIX_SOCKET

    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'
    expect(shouldGzipRequestBody(API_URL, body)).toEqual({
      gzip: false,
      reason: 'proxy',
      bodyChars: body.length,
    })
    // NO_PROXY bypass re-enables gzip (official !Uy(e)).
    process.env.NO_PROXY = 'api.anthropic.com'
    expect(shouldGzipRequestBody(API_URL, body)?.gzip).toBe(true)
    delete process.env.NO_PROXY
    delete process.env.HTTPS_PROXY

    mtlsOverride = () => ({ cert: 'PEM' })
    expect(shouldGzipRequestBody(API_URL, body)).toEqual({
      gzip: false,
      reason: 'mtls',
      bodyChars: body.length,
    })
    mtlsOverride = null

    process.env.NODE_EXTRA_CA_CERTS = '/tmp/ca.pem'
    expect(shouldGzipRequestBody(API_URL, body)).toEqual({
      gzip: false,
      reason: 'custom_ca',
      bodyChars: body.length,
    })
  })

  test('the process latch disables gzip after a rejection (official q/te)', () => {
    expect(isGzipRequestBodyLatchedOff()).toBe(false)
    latchGzipRequestBodyOff()
    expect(isGzipRequestBodyLatchedOff()).toBe(true)
    expect(shouldGzipRequestBody(API_URL, bigBody())).toEqual({
      gzip: false,
      reason: 'latched_off',
      bodyChars: bigBody().length,
    })
    resetGzipRequestBodyLatch()
    expect(shouldGzipRequestBody(API_URL, bigBody())?.gzip).toBe(true)
  })
})

describe('buildFetch gzip wiring (official @220216119 + a_o fallback)', () => {
  type FetchCall = { url: string; init: RequestInit & { headers: Headers } }

  function recordingFetch(responder: (call: FetchCall) => Response) {
    const calls: FetchCall[] = []
    const stub = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const call = {
        url: String(input),
        init: { ...init, headers: new Headers(init?.headers) } as FetchCall['init'],
      }
      calls.push(call)
      return responder(call)
    }) as unknown as typeof fetch
    return { stub, calls }
  }

  function anthropicOk(): Response {
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'request-id': 'req_ok123', 'content-type': 'application/json' },
    })
  }

  test('large api.anthropic.com bodies go out gzip-compressed with Content-Encoding', async () => {
    const { stub, calls } = recordingFetch(() => anthropicOk())
    const f = buildFetch(stub, 'repl_main_thread')
    const body = bigBody()
    const res = await f(API_URL, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const sent = calls[0].init
    expect(sent.headers.get('content-encoding')).toBe('gzip')
    expect(typeof sent.body).not.toBe('string')
    const bytes = sent.body as Uint8Array
    const decoded = gunzipSync(Buffer.from(bytes)).toString('utf8')
    // Official bNt pads with trailing whitespace — JSON must round-trip.
    expect(JSON.parse(decoded)).toEqual(JSON.parse(body))
    expect(decoded.startsWith(body)).toBe(true)
    expect(decoded.slice(body.length).trim()).toBe('')
  })

  test('CLAUDE_CODE_GZIP_REQUEST_BODIES=0 sends the identity body', async () => {
    process.env.CLAUDE_CODE_GZIP_REQUEST_BODIES = '0'
    const { stub, calls } = recordingFetch(() => anthropicOk())
    const f = buildFetch(stub, 'repl_main_thread')
    const body = bigBody()
    await f(API_URL, { method: 'POST', body })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.body).toBe(body)
    expect(calls[0].init.headers.get('content-encoding')).toBeNull()
  })

  test('small bodies are sent uncompressed', async () => {
    const { stub, calls } = recordingFetch(() => anthropicOk())
    const f = buildFetch(stub, 'repl_main_thread')
    const body = JSON.stringify({ model: 'x' })
    await f(API_URL, { method: 'POST', body })
    expect(calls[0].init.body).toBe(body)
    expect(calls[0].init.headers.get('content-encoding')).toBeNull()
  })

  test('non-anthropic 4xx rejection → latch + uncompressed re-send (official a_o)', async () => {
    let call = 0
    const { stub, calls } = recordingFetch(() => {
      call++
      if (call === 1) {
        // No request-id / cf-ray → non_anthropic_rejection (official W).
        return new Response('rejected by intermediary', { status: 400 })
      }
      return anthropicOk()
    })
    const f = buildFetch(stub, 'repl_main_thread')
    const body = bigBody()
    const res = await f(API_URL, { method: 'POST', body })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    // Re-send carries the identity body and no Content-Encoding.
    expect(calls[1].init.body).toBe(body)
    expect(calls[1].init.headers.get('content-encoding')).toBeNull()
    // The latch is set process-wide.
    expect(isGzipRequestBodyLatchedOff()).toBe(true)
    expect(shouldGzipRequestBody(API_URL, body)).toEqual({
      gzip: false,
      reason: 'latched_off',
      bodyChars: body.length,
    })
  })

  test('origin bad-JSON 400 → latch + uncompressed re-send (invalid_json_at_origin)', async () => {
    let call = 0
    const { stub, calls } = recordingFetch(() => {
      call++
      if (call === 1) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'The request body is not valid JSON',
            },
          }),
          { status: 400, headers: { 'request-id': 'req_bad1' } },
        )
      }
      return anthropicOk()
    })
    const f = buildFetch(stub, 'repl_main_thread')
    const body = bigBody()
    const res = await f(API_URL, { method: 'POST', body })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1].init.body).toBe(body)
    expect(isGzipRequestBodyLatchedOff()).toBe(true)
  })

  test('an unrelated anthropic 400 passes through with a readable body — no re-send', async () => {
    const { stub, calls } = recordingFetch(
      () =>
        new Response('prompt is too long', {
          status: 400,
          headers: { 'request-id': 'req_real400' },
        }),
    )
    const f = buildFetch(stub, 'repl_main_thread')
    const res = await f(API_URL, { method: 'POST', body: bigBody() })
    expect(calls).toHaveLength(1)
    expect(res.status).toBe(400)
    // The rejection sniff reads a clone — the caller can still read the body.
    expect(await res.text()).toBe('prompt is too long')
    expect(isGzipRequestBodyLatchedOff()).toBe(false)
  })

  test('ok responses are never sniffed or altered', async () => {
    const { stub, calls } = recordingFetch(() => anthropicOk())
    const f = buildFetch(stub, 'repl_main_thread')
    const res = await f(API_URL, { method: 'POST', body: bigBody() })
    expect(calls).toHaveLength(1)
    expect(await res.text()).toBe('{"ok":true}')
  })

  test('non-api.anthropic.com requests are never gzipped', async () => {
    const { stub, calls } = recordingFetch(() => anthropicOk())
    const f = buildFetch(stub, 'repl_main_thread')
    const body = bigBody()
    await f('https://gateway.example.com/v1/messages', {
      method: 'POST',
      body,
    })
    expect(calls[0].init.body).toBe(body)
    expect(calls[0].init.headers.get('content-encoding')).toBeNull()
  })
})
