import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  MAX_PLUGIN_ZIP_BYTES,
  fetchPluginZipFromUrl,
  validatePluginZipUrl,
} from '../fetchPluginZip'

describe('OCC-21 Gap-2a: --plugin-url validation (https-only, OCC hardening)', () => {
  test('accepts https:// URLs', () => {
    const u = validatePluginZipUrl('https://example.com/plugin.zip')
    expect(u.protocol).toBe('https:')
  })

  test('rejects http:// (plaintext) with a clear message', () => {
    expect(() => validatePluginZipUrl('http://example.com/plugin.zip')).toThrow(
      /only https:\/\//i,
    )
  })

  test('rejects file:// / ftp:// / ssh', () => {
    expect(() => validatePluginZipUrl('file:///etc/passwd')).toThrow(/https/i)
    expect(() => validatePluginZipUrl('ftp://h/x.zip')).toThrow(/https/i)
    expect(() => validatePluginZipUrl('ssh://h/x.zip')).toThrow(/https/i)
  })

  test('rejects unparseable input', () => {
    expect(() => validatePluginZipUrl('not a url')).toThrow(/invalid URL/i)
    expect(() => validatePluginZipUrl('')).toThrow(/invalid URL/i)
  })
})

describe('OCC-21 Gap-2a: --plugin-url fetch (mock transport)', () => {
  const mockResponse = (chunks: Uint8Array[], status = 200): Response => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(c)
        }
        controller.close()
      },
    })
    return new Response(stream, { status, statusText: status === 200 ? 'OK' : '' })
  }

  test('fetches to a temp .zip path and reports the source url', async () => {
    const fetched: string[] = []
    const result = await fetchPluginZipFromUrl('https://example.com/p.zip', {
      fetchImpl: async () => {
        fetched.push('called')
        return mockResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
      },
    })
    expect(fetched).toEqual(['called'])
    expect(result.url).toBe('https://example.com/p.zip')
    expect(result.path.endsWith('plugin.zip')).toBe(true)
  })

  test('rejects non-2xx responses', async () => {
    await expect(
      fetchPluginZipFromUrl('https://example.com/p.zip', {
        fetchImpl: async () => mockResponse([], 404),
      }),
    ).rejects.toThrow(/HTTP 404/)
  })

  test('enforces the size cap', async () => {
    await expect(
      fetchPluginZipFromUrl('https://example.com/p.zip', {
        maxBytes: 4,
        fetchImpl: async () => mockResponse([new Uint8Array([1, 2, 3, 4, 5, 6])]),
      }),
    ).rejects.toThrow(/exceeds the 4-byte limit/)
  })

  test('rejects empty body', async () => {
    await expect(
      fetchPluginZipFromUrl('https://example.com/p.zip', {
        fetchImpl: async () => mockResponse([]),
      }),
    ).rejects.toThrow(/was empty/)
  })

  test('MAX_PLUGIN_ZIP_BYTES is the documented 100 MiB', () => {
    expect(MAX_PLUGIN_ZIP_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe('OCC-21 hardening: timeout + temp-cleanup (Gap-2 security LOW)', () => {
  const mockResponse = (chunks: Uint8Array[], status = 200): Response => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(c)
        }
        controller.close()
      },
    })
    return new Response(stream, { status, statusText: status === 200 ? 'OK' : '' })
  }

  const occTmpDirs = (): string[] =>
    readdirSync(tmpdir())
      .filter(d => d.startsWith('occ-plugin-url-'))

  test('aborts the fetch via timeout when the server stalls', async () => {
    let aborted = false
    const hangingFetch = (
      _url: unknown,
      init: { signal: AbortSignal },
    ): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    await expect(
      fetchPluginZipFromUrl('https://example.com/p.zip', {
        fetchImpl: hangingFetch as unknown as typeof fetch,
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out after 40ms/)
    expect(aborted).toBe(true)
  })

  test('cleans the session temp dir on oversize failure', async () => {
    const before = new Set(occTmpDirs())
    await expect(
      fetchPluginZipFromUrl('https://example.com/p.zip', {
        maxBytes: 4,
        fetchImpl: async () => mockResponse([new Uint8Array([1, 2, 3, 4, 5, 6])]),
      }),
    ).rejects.toThrow(/exceeds the 4-byte limit/)
    expect(occTmpDirs().filter(d => !before.has(d))).toEqual([])
  })

  test('cleans the session temp dir on empty-body failure', async () => {
    const before = new Set(occTmpDirs())
    await expect(
      fetchPluginZipFromUrl('https://example.com/p.zip', {
        fetchImpl: async () => mockResponse([]),
      }),
    ).rejects.toThrow(/was empty/)
    expect(occTmpDirs().filter(d => !before.has(d))).toEqual([])
  })

  test('leaves the temp zip in place on success (caller consumes it)', async () => {
    const before = new Set(occTmpDirs())
    const result = await fetchPluginZipFromUrl('https://example.com/p.zip', {
      fetchImpl: async () => mockResponse([new Uint8Array([1, 2, 3])]),
    })
    // The success dir is present (not cleaned) and the zip path resolves.
    expect(result.path.endsWith('plugin.zip')).toBe(true)
    const newDirs = occTmpDirs().filter(d => !before.has(d))
    expect(newDirs.length).toBe(1)
  })
})
