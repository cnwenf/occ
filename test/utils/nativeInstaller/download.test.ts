import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isTransientConnectionError,
  MAX_DOWNLOAD_RETRIES,
  _downloadAndVerifyBinaryForTesting,
} from '../../../src/utils/nativeInstaller/download.js'

/**
 * Feature #15 (2.1.202): installer/updater download retry on transient
 * connection drop. A proxy or network dropping the connection mid-download
 * used to fail immediately with "aborted"; transient drops now retry.
 *
 * These tests are leak-free: the retry loop is exercised via the injectable
 * `attemptDownload` seam (no `mock.module` of axios, which would leak across
 * files in this bun version), and the transient-detection helper is a pure
 * function tested directly.
 */

// Build a realistic axios-shaped transient error (connection reset mid-stream).
function axiosNetworkError(
  code: string,
  message = 'socket hang up',
): Error & { code: string; request: unknown; response?: unknown } {
  return Object.assign(new Error(message), {
    code,
    name: 'AxiosError',
    request: {},
    response: undefined,
  }) as Error & { code: string; request: unknown; response?: unknown }
}

describe('isTransientConnectionError', () => {
  test.each([
    ['ECONNRESET'],
    ['ETIMEDOUT'],
    ['ECONNABORTED'],
    ['ERR_NETWORK'],
  ])('returns true for transient code %s', code => {
    expect(isTransientConnectionError(axiosNetworkError(code))).toBe(true)
  })

  test('returns true for a message containing "aborted"', () => {
    const err = Object.assign(new Error('Request aborted by proxy'), {
      request: {},
      response: undefined,
    })
    expect(isTransientConnectionError(err)).toBe(true)
  })

  test('returns true when request sent but no response received (mid-stream drop)', () => {
    const err = Object.assign(new Error('some unknown socket error'), {
      request: {},
      response: undefined,
    }) // no code -> falls through to the no-response fallback
    expect(isTransientConnectionError(err)).toBe(true)
  })

  test('returns false for an HTTP status error (has a response)', () => {
    const err = Object.assign(new Error('Request failed with status code 500'), {
      code: 'ERR_BAD_RESPONSE',
      request: {},
      response: { status: 500 },
    })
    expect(isTransientConnectionError(err)).toBe(false)
  })

  test('returns false for a checksum mismatch (our own thrown Error)', () => {
    expect(
      isTransientConnectionError(
        new Error('Checksum mismatch: expected abc, got def'),
      ),
    ).toBe(false)
  })

  test('returns false for ENOTFOUND (DNS miss — not a connection drop)', () => {
    expect(isTransientConnectionError(axiosNetworkError('ENOTFOUND'))).toBe(false)
  })

  test('returns false for ECONNREFUSED (nothing listening)', () => {
    expect(isTransientConnectionError(axiosNetworkError('ECONNREFUSED'))).toBe(false)
  })

  test('returns false for non-Error values', () => {
    expect(isTransientConnectionError(null)).toBe(false)
    expect(isTransientConnectionError('aborted')).toBe(false)
    expect(isTransientConnectionError(undefined)).toBe(false)
  })
})

describe('downloadAndVerifyBinary retry loop', () => {
  let savedDelayEnv: string | undefined
  let tmpDir: string

  beforeEach(() => {
    // Make backoff near-instant (1ms, 2ms) so the retry tests are fast.
    savedDelayEnv = process.env.CLAUDE_CODE_DOWNLOAD_RETRY_DELAY_MS_FOR_TESTING
    process.env.CLAUDE_CODE_DOWNLOAD_RETRY_DELAY_MS_FOR_TESTING = '1'
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-dl-'))
  })

  afterEach(() => {
    if (savedDelayEnv === undefined) {
      delete process.env.CLAUDE_CODE_DOWNLOAD_RETRY_DELAY_MS_FOR_TESTING
    } else {
      process.env.CLAUDE_CODE_DOWNLOAD_RETRY_DELAY_MS_FOR_TESTING = savedDelayEnv
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('gives up after MAX_DOWNLOAD_RETRIES attempts on a transient ECONNRESET', async () => {
    let attempts = 0
    const attemptDownload = async () => {
      attempts++
      throw axiosNetworkError('ECONNRESET')
    }

    await expect(
      _downloadAndVerifyBinaryForTesting(
        'https://example.test/binary',
        'deadbeef',
        join(tmpDir, 'bin'),
        {},
        attemptDownload,
      ),
    ).rejects.toThrow(/socket hang up/)

    // Retried the full budget, no more.
    expect(attempts).toBe(MAX_DOWNLOAD_RETRIES)
  })

  test('retries on a transient ECONNRESET and succeeds once the link recovers', async () => {
    let attempts = 0
    const attemptDownload = async () => {
      attempts++
      if (attempts < MAX_DOWNLOAD_RETRIES) {
        throw axiosNetworkError('ECONNRESET')
      }
      // Link recovered — attempt succeeds (real write+checksum path is the
      // default seam; here the injected attempt just resolves).
    }

    await _downloadAndVerifyBinaryForTesting(
      'https://example.test/binary',
      'deadbeef',
      join(tmpDir, 'bin'),
      {},
      attemptDownload,
    )

    expect(attempts).toBe(MAX_DOWNLOAD_RETRIES)
  })

  test('does NOT retry a non-transient error (checksum mismatch) — fails fast', async () => {
    let attempts = 0
    const attemptDownload = async () => {
      attempts++
      throw new Error('Checksum mismatch: expected abc, got def')
    }

    await expect(
      _downloadAndVerifyBinaryForTesting(
        'https://example.test/binary',
        'abc',
        join(tmpDir, 'bin'),
        {},
        attemptDownload,
      ),
    ).rejects.toThrow(/Checksum mismatch/)

    // Non-transient -> no retries.
    expect(attempts).toBe(1)
  })

  test('does NOT retry an HTTP status error — fails fast', async () => {
    let attempts = 0
    const attemptDownload = async () => {
      attempts++
      throw Object.assign(new Error('Request failed with status code 503'), {
        code: 'ERR_BAD_RESPONSE',
        request: {},
        response: { status: 503 },
      })
    }

    await expect(
      _downloadAndVerifyBinaryForTesting(
        'https://example.test/binary',
        'abc',
        join(tmpDir, 'bin'),
        {},
        attemptDownload,
      ),
    ).rejects.toThrow(/503/)

    expect(attempts).toBe(1)
  })

  test('end-to-end real path: succeeds and writes+chmods the binary on first attempt', async () => {
    // Exercises the REAL defaultAttemptDownload seam via a local HTTP server,
    // proving the refactor preserved fetch+checksum+write behavior.
    const payload = Buffer.from('hello-binary')
    const expectedChecksum = createHash('sha256')
      .update(payload)
      .digest('hex')
    const binaryPath = join(tmpDir, 'claude')

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(payload),
    })
    const url = `http://localhost:${server.port}/binary`

    try {
      await _downloadAndVerifyBinaryForTesting(
        url,
        expectedChecksum,
        binaryPath,
        {},
      )
      expect(readFileSync(binaryPath, 'utf8')).toBe('hello-binary')
      // 0o755 executable bits set.
      expect(statSync(binaryPath).mode & 0o777).toBe(0o755)
    } finally {
      server.stop(true)
    }
  })
})
