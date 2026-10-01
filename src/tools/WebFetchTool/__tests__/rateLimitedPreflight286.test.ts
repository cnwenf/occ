import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// The fetch path reaches getWebFetchUserAgent, which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx for runtime execution).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.286 changelog: "Changed the WebFetch error for a rate-limited domain
 * safety check to tell Claude not to retry it in a loop."
 *
 * Official v286 (jxe class @205466878, throw site @205474632):
 *   case"check_failed":throw new jxe(Ne,ht.isCancel(Fe.error)
 *     ?"EDEADLINE_PREFLIGHT"
 *     :Fe.httpStatus===429?"ERATELIMIT_PREFLIGHT":void 0)
 * and the ERATELIMIT_PREFLIGHT branch of the constructor message. The 429
 * plumbing (httpStatus on check_failed, both the resolved-non-200 and the
 * AxiosError catch paths) existed already in v285 (@204272821/@204280372);
 * v285→v286 changed only the message text. OCC previously had neither.
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

const { getURLMarkdownContent } = await import('../utils.js')

afterEach(() => {
  mockedGet = undefined
})

/** Reject like a real AxiosError carrying an HTTP response status. */
function axiosErrorWithStatus(status: number): unknown {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, headers: {} },
  })
}

const RATE_LIMITED_MESSAGE = (domain: string): string =>
  `The safety check for domain ${domain} is rate-limited (too many domain checks from this network; the limit is shared and can stay exhausted for minutes). Do not retry WebFetch in a loop or sleep to wait it out; continue without this page and report that its safety check was rate-limited. A single later attempt is fine; if that is rate-limited too, stop.`

const GENERIC_MESSAGE = (domain: string): string =>
  `Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.`

describe('CC 2.1.286 — ERATELIMIT_PREFLIGHT domain-check error', () => {
  test('a 429 rejection from the domain check yields the do-not-retry-in-a-loop message', async () => {
    mockedGet = url =>
      url.includes('/api/web/domain_info')
        ? Promise.reject(axiosErrorWithStatus(429))
        : Promise.reject(new Error('page fetch must not be reached'))

    await expect(
      getURLMarkdownContent(
        'https://rl-reject.example.com/page',
        new AbortController(),
      ),
    ).rejects.toMatchObject({
      name: 'DomainCheckFailedError',
      code: 'ERATELIMIT_PREFLIGHT',
      message: RATE_LIMITED_MESSAGE('rl-reject.example.com'),
    })
  })

  test('a resolved non-200 429 response also classifies as ERATELIMIT_PREFLIGHT', async () => {
    mockedGet = url =>
      url.includes('/api/web/domain_info')
        ? Promise.resolve({ status: 429, data: {}, headers: {} })
        : Promise.reject(new Error('page fetch must not be reached'))

    await expect(
      getURLMarkdownContent(
        'https://rl-resolved.example.com/page',
        new AbortController(),
      ),
    ).rejects.toMatchObject({
      name: 'DomainCheckFailedError',
      code: 'ERATELIMIT_PREFLIGHT',
      message: RATE_LIMITED_MESSAGE('rl-resolved.example.com'),
    })
  })

  test('a non-429 HTTP failure keeps the generic message with no code', async () => {
    mockedGet = url =>
      url.includes('/api/web/domain_info')
        ? Promise.reject(axiosErrorWithStatus(500))
        : Promise.reject(new Error('page fetch must not be reached'))

    await expect(
      getURLMarkdownContent(
        'https://http-500.example.com/page',
        new AbortController(),
      ),
    ).rejects.toMatchObject({
      name: 'DomainCheckFailedError',
      code: undefined,
      message: GENERIC_MESSAGE('http-500.example.com'),
    })
  })

  test('a non-HTTP failure keeps the generic message with no code', async () => {
    mockedGet = url =>
      url.includes('/api/web/domain_info')
        ? Promise.reject(new Error('network unreachable'))
        : Promise.reject(new Error('page fetch must not be reached'))

    await expect(
      getURLMarkdownContent(
        'https://generic-fail.example.com/page',
        new AbortController(),
      ),
    ).rejects.toMatchObject({
      name: 'DomainCheckFailedError',
      code: undefined,
      message: GENERIC_MESSAGE('generic-fail.example.com'),
    })
  })

  test('a cancelled preflight still maps to EDEADLINE_PREFLIGHT (isCancel checked first)', async () => {
    mockedGet = url =>
      url.includes('/api/web/domain_info')
        ? Promise.reject(Object.assign(new Error('canceled'), { __CANCEL__: true }))
        : Promise.reject(new Error('page fetch must not be reached'))

    await expect(
      getURLMarkdownContent(
        'https://cancel-deadline.example.com/page',
        new AbortController(),
      ),
    ).rejects.toMatchObject({
      name: 'DomainCheckFailedError',
      code: 'EDEADLINE_PREFLIGHT',
      message: GENERIC_MESSAGE('cancel-deadline.example.com'),
    })
  })

  test('an allowed domain still fetches normally (happy path unchanged)', async () => {
    mockedGet = url =>
      url.includes('/api/web/domain_info')
        ? Promise.resolve({ status: 200, data: { can_fetch: true }, headers: {} })
        : Promise.resolve({
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/plain' },
            data: Buffer.from('hello page'),
          })

    const result = await getURLMarkdownContent(
      'https://allowed-286.example.com/page',
      new AbortController(),
    )
    expect(result).toMatchObject({ code: 200, content: 'hello page' })
  })
})
