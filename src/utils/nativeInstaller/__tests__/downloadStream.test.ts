import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { _downloadAndVerifyBinaryForTesting } from '../download.js'

// 2.1.205 #17: auto-update binary downloads stream to disk (−~400MB peak).
// Exercises the real defaultAttemptDownload path (axios stream → PassThrough
// sha256 → pipeline → createWriteStream → chmod) via a local HTTP server
// serving a known payload. No attemptDownload override — we want the real
// streaming + checksum + write code to run end-to-end.

describe('downloadAndVerifyBinary streaming (2.1.205 #17)', () => {
  let server: Server
  let baseUrl: string
  let tmpRoot: string
  let outPath: string
  let payload: Buffer
  let checksum: string

  beforeEach(async () => {
    // Fast stall + retry timing so a slow CI box doesn't time out.
    process.env.CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING = '5000'
    process.env.CLAUDE_CODE_DOWNLOAD_RETRY_DELAY_MS_FOR_TESTING = '1'

    tmpRoot = mkdtempSync(join(tmpdir(), 'occ-dl-stream-'))
    outPath = join(tmpRoot, 'binary')

    // 2MB pseudo-random payload — big enough to span multiple chunks so the
    // PassThrough 'data' handler fires more than once (exercises per-chunk
    // hash.update + resetStallTimer).
    payload = randomBytes(2 * 1024 * 1024)
    checksum = createHash('sha256').update(payload).digest('hex')

    server = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length),
      })
      // Stream in 64KB chunks to exercise incremental hash updates.
      const chunkSize = 64 * 1024
      let offset = 0
      const sendChunk = () => {
        const next = payload.subarray(offset, offset + chunkSize)
        if (next.length === 0) {
          res.end()
          return
        }
        offset += next.length
        res.write(next, sendChunk)
      }
      sendChunk()
    })

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const addr = server.address()
    if (addr === null || typeof addr === 'string') {
      throw new Error('failed to bind test server')
    }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('streams payload to disk, verifies checksum, chmods 0o755', async () => {
    await _downloadAndVerifyBinaryForTesting(
      `${baseUrl}/binary`,
      checksum,
      outPath,
    )

    // File written with exact payload bytes.
    expect(existsSync(outPath)).toBe(true)
    const written = readFileSync(outPath)
    expect(written.length).toBe(payload.length)
    expect(written.equals(payload)).toBe(true)

    // Executable bit set (0o755).
    const mode = statSync(outPath).mode & 0o777
    expect(mode).toBe(0o755)
  })

  test('throws on checksum mismatch and removes the partial file', async () => {
    const wrongChecksum = createHash('sha256')
      .update(randomBytes(32))
      .digest('hex')

    await expect(
      _downloadAndVerifyBinaryForTesting(
        `${baseUrl}/binary`,
        wrongChecksum,
        outPath,
      ),
    ).rejects.toThrow(/Checksum mismatch/)

    // Atomicity parity: no leftover file on mismatch.
    expect(existsSync(outPath)).toBe(false)
  })
})
