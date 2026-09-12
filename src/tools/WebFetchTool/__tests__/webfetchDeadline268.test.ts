import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// The fetch path reaches getWebFetchUserAgent, which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx for runtime execution).
// Mirror that polyfill so the fetch path works in tests.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * 2.1.268 alignment (OCC-122):
 * - E9: overall WebFetch deadline (`CLAUDE_CODE_WEBFETCH_DEADLINE_MS`,
 *   default 300000, 0 disables, INT32_MAX cap) wrapping the redirect chain;
 *   deadline aborts surface as WebFetchTransportError code 'EDEADLINE';
 *   redirect status set gains 303 (official Wis, pre-existing divergence).
 * (E37 dotless-hostname rejection landed separately in the OCC-83 round —
 * see dotlessHostname268.test.ts.)
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only `default.get`, and restore after.
const actualAxios = await import('axios')

type MockGet = (url: string, config: Record<string, unknown>) => Promise<unknown>
let mockedGet: MockGet | undefined

const mockedAxiosDefault = Object.assign(
  (url: string, config: Record<string, unknown>) =>
    mockedGet ? mockedGet(url, config) : actualAxios.default(url, config),
  actualAxios.default,
  {
    get: (url: string, config: Record<string, unknown>) =>
      mockedGet
        ? mockedGet(url, config)
        : actualAxios.default.get(url, config),
  },
)

mock.module('axios', () => ({
  ...actualAxios,
  default: mockedAxiosDefault,
}))

afterAll(() => {
  mock.module('axios', () => ({ ...actualAxios }))
})

const {
  getURLMarkdownContent,
  getWebFetchDeadlineMs,
  getWithPermittedRedirects,
  WebFetchTransportError,
} = await import('../utils.js')

afterEach(() => {
  delete process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS
  mockedGet = undefined
})

describe('2.1.268 — getWebFetchDeadlineMs', () => {
  test('defaults to 300000', () => {
    expect(getWebFetchDeadlineMs()).toBe(300_000)
  })

  test('env override wins', () => {
    process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS = '1500'
    expect(getWebFetchDeadlineMs()).toBe(1500)
  })

  test('0 disables the deadline', () => {
    process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS = '0'
    expect(getWebFetchDeadlineMs()).toBe(0)
  })

  test('values are capped at INT32_MAX', () => {
    process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS = '99999999999'
    expect(getWebFetchDeadlineMs()).toBe(2_147_483_647)
  })

  test('invalid env falls back to the default', () => {
    process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS = 'not-a-number'
    expect(getWebFetchDeadlineMs()).toBe(300_000)
  })
})

describe('2.1.268 — overall fetch deadline (E9)', () => {
  test('deadline abort surfaces as WebFetchTransportError EDEADLINE', async () => {
    process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS = '50'
    mockedGet = (_url, config) =>
      new Promise((_resolve, reject) => {
        const signal = config.signal as AbortSignal
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('canceled'), { __CANCEL__: true }))
        })
      })

    const controller = new AbortController()
    await expect(
      getWithPermittedRedirects(
        'https://example.com/slow',
        controller.signal,
        () => false,
      ),
    ).rejects.toMatchObject({
      name: 'WebFetchTransportError',
      code: 'EDEADLINE',
      message: 'Fetch did not complete within the 0.05s deadline',
    })
    await expect(
      getWithPermittedRedirects(
        'https://example.com/slow',
        controller.signal,
        () => false,
      ),
    ).rejects.toBeInstanceOf(WebFetchTransportError)
  })

  test('caller abort is NOT re-labelled as a deadline error', async () => {
    process.env.CLAUDE_CODE_WEBFETCH_DEADLINE_MS = '10000'
    mockedGet = (_url, config) =>
      new Promise((_resolve, reject) => {
        const signal = config.signal as AbortSignal
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('canceled'), { __CANCEL__: true }))
        })
      })

    const controller = new AbortController()
    const promise = getWithPermittedRedirects(
      'https://example.com/slow',
      controller.signal,
      () => false,
    )
    controller.abort()
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(WebFetchTransportError)
  })

  test('303 is treated as a redirect status', async () => {
    mockedGet = () =>
      Promise.reject(
        Object.assign(new Error('Request failed with status code 303'), {
          isAxiosError: true,
          response: {
            status: 303,
            headers: { location: 'https://example.com/other' },
          },
        }),
      )

    const result = await getWithPermittedRedirects(
      'https://example.com/page',
      new AbortController().signal,
      () => false,
    )
    expect(result).toEqual({
      type: 'redirect',
      originalUrl: 'https://example.com/page',
      redirectUrl: 'https://example.com/other',
      statusCode: 303,
    })
  })
})
