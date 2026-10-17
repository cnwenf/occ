import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IMAGE_READ_CHUNK_BYTES,
  MAX_IMAGE_READ_BYTES,
} from '../limits.js'
import {
  ImageReadLimitError,
  imageFileTooLargeMessage,
  imageStreamTooLargeMessage,
  readImageBytesCapped,
  readImageBytesFromHandle,
  type ReadableHandle,
} from '../imageRead.js'
import { getFsImplementation } from '../../../utils/fsOperations.js'

/**
 * CC 2.1.302 #06 — Read tool image byte cap (128 MiB).
 *
 * Official evidence (v302 linux-x64 ELF, read-only forensics):
 *   - `cB = S_o` = 134217728 (128 MiB), chunk `zXr = 65536` (64 KiB).
 *   - `oOn` chunked reader @246685000: stat-first for regular files, chunked
 *     read for non-regular (pipe/device) sources.
 *   - `Zt(cB)` renders "128MB" (Zt @235066095 == OCC e2bigError formatBytes).
 *   - Refusal messages + reasons verbatim (see imageRead.ts).
 */

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'occ-image-cap-302-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** A tiny fixture that stands in for a small under-cap image. */
const SMALL_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
)

/** Fake non-regular readable that yields exactly `totalBytes` then EOF. */
function fakeStream(totalBytes: number): ReadableHandle {
  let remaining = totalBytes
  return {
    async stat() {
      return { isFile: () => false, size: 0 }
    },
    async read(buffer: Buffer, offset: number, length: number) {
      const n = Math.min(length, remaining)
      if (n > 0) {
        buffer.fill(0x41, offset, offset + n)
        remaining -= n
      }
      return { bytesRead: n }
    },
    async close() {},
  }
}

describe('CC 2.1.302 #06: image read byte cap constants', () => {
  test('MAX_IMAGE_READ_BYTES is 128 MiB and chunk is 64 KiB', () => {
    expect(MAX_IMAGE_READ_BYTES).toBe(134217728)
    expect(IMAGE_READ_CHUNK_BYTES).toBe(65536)
  })
})

describe('CC 2.1.302 #06: oversized regular image is refused', () => {
  test('a sparse regular file one byte over the cap throws message 1', async () => {
    const bigPath = join(tmpDir, 'big.png')
    writeFileSync(bigPath, Buffer.alloc(0))
    truncateSync(bigPath, MAX_IMAGE_READ_BYTES + 1)

    let caught: unknown
    try {
      await readImageBytesCapped(bigPath)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ImageReadLimitError)
    const err = caught as ImageReadLimitError
    expect(err.reason).toBe('File over the image read limit')
    expect(err.message).toContain('too large to read as an image')
    expect(err.message).toBe(
      `File is too large to read as an image (the limit is 128MB): ${bigPath}. ` +
        'If it is an image, resize it or export a smaller copy, then read that.',
    )
  })

  test('readImageWithTokenBudget surfaces the same refusal for an oversized image', async () => {
    const { readImageWithTokenBudget } = await import('../FileReadTool.js')
    const bigPath = join(tmpDir, 'big2.png')
    writeFileSync(bigPath, Buffer.alloc(0))
    truncateSync(bigPath, MAX_IMAGE_READ_BYTES + 1)

    let message = ''
    try {
      await readImageWithTokenBudget(bigPath)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('too large to read as an image')
  })
})

describe('CC 2.1.302 #06: pipe/device over the cap is refused (chunked reader)', () => {
  test('a non-regular source that sends more than the cap throws message 2', async () => {
    const cap = 100000
    let caught: unknown
    try {
      await readImageBytesFromHandle(fakeStream(cap + 1), 'foo.png', cap)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ImageReadLimitError)
    const err = caught as ImageReadLimitError
    expect(err.reason).toBe('Image stream over the read limit')
    expect(err.message).toContain('pipe or a device')
    expect(err.message).toContain('foo.png')
    expect(err.message).toContain('not a regular file')
  })

  test('a non-regular source under the cap assembles normally', async () => {
    const cap = 100000
    const total = 40000
    const bytes = await readImageBytesFromHandle(fakeStream(total), 'foo.png', cap)
    expect(bytes.length).toBe(total)
    expect(bytes.every(b => b === 0x41)).toBe(true)
  })

  test('a non-regular source exactly at the cap is allowed', async () => {
    const cap = 65536 * 2
    const bytes = await readImageBytesFromHandle(fakeStream(cap), 'foo.png', cap)
    expect(bytes.length).toBe(cap)
  })
})

describe('CC 2.1.302 #06: refusal messages render the cap as "128MB" (official Zt)', () => {
  test('message 1 (regular file over the cap) is verbatim', () => {
    expect(imageFileTooLargeMessage('big.png', MAX_IMAGE_READ_BYTES)).toBe(
      'File is too large to read as an image (the limit is 128MB): big.png. ' +
        'If it is an image, resize it or export a smaller copy, then read that.',
    )
  })

  test('message 2 (pipe/device over the cap) is verbatim', () => {
    expect(imageStreamTooLargeMessage('foo.png', MAX_IMAGE_READ_BYTES)).toBe(
      'Cannot read this as an image: foo.png is a pipe or a device, not a ' +
        'regular file, and it sent more than 128MB without ending.',
    )
  })
})

describe('CC 2.1.302 #06: under-cap regular image still reads', () => {
  test('a small PNG is returned byte-for-byte', async () => {
    const smallPath = join(tmpDir, 'small.png')
    writeFileSync(smallPath, SMALL_PNG_BYTES)
    const bytes = await readImageBytesCapped(smallPath)
    expect(Buffer.compare(bytes, SMALL_PNG_BYTES)).toBe(0)
  })
})

describe('CC 2.1.302 #06: FIFO named like an image (integration)', () => {
  test('a small FIFO under the cap reads fine', async () => {
    const fifoPath = join(tmpDir, 'small-fifo.png')
    execFileSync('mkfifo', [fifoPath])

    const payload = Buffer.alloc(5000, 0x42)
    const writer = spawn(
      'sh',
      ['-c', `cat > "${fifoPath}"`],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    // Attach the close/error listeners BEFORE any await: readImageBytesCapped
    // only returns after the read side sees EOF, which means the writer has
    // already exited — attaching afterwards races (and loses) the 'close'
    // event, hanging the test when this file shares a worker with slower
    // suites (observed vs allowLarge296.test.ts).
    const writerClosed = new Promise<void>(resolve => {
      writer.on('close', () => resolve())
      writer.on('error', () => resolve())
    })
    // Feed the writer, then close stdin so the reader sees EOF.
    writer.stdin.end(payload)

    const bytes = await readImageBytesCapped(fifoPath)
    await writerClosed
    expect(bytes.length).toBe(payload.length)
    expect(bytes.every(b => b === 0x42)).toBe(true)
  }, 15000)
})

describe('CC 2.1.302 #06: fsOperations.readFileBytes honors maxBytes', () => {
  test('readFileBytes never returns more than maxBytes', async () => {
    const path = join(tmpDir, 'over.bin')
    writeFileSync(path, Buffer.alloc(0))
    truncateSync(path, 5000)
    const bytes = await getFsImplementation().readFileBytes(path, 1000)
    expect(bytes.length).toBe(1000)
  })
})
