import { describe, expect, test } from 'bun:test'
import {
  looksLikeImageBytes,
  parseOSC52ResponseData,
  readClipboardImageViaOSC52,
} from '../../src/utils/osc52ClipboardRead.js'
import type { TerminalQuerier } from '../../src/ink/terminal-querier.js'
import type { TerminalResponse } from '../../src/ink/parse-keypress.js'

// 1x1 red PNG (well-known). Real PNG magic bytes so the reader treats it as
// an image, not text.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKd0CgAAAABJRU5ErkJggg==',
  'base64',
)

/** Build a fake querier that resolves send() with `response` and flush(). */
function fakeQuerier(response: TerminalResponse | undefined): TerminalQuerier {
  return {
    send: () => Promise.resolve(response),
    flush: () => Promise.resolve(),
    // onResponse / queue are internal — not exercised here.
  } as unknown as TerminalQuerier
}

describe('parseOSC52ResponseData', () => {
  test('decodes c;<base64> payload', () => {
    const data = `c;${PNG_1x1.toString('base64')}`
    const buf = parseOSC52ResponseData(data)
    expect(buf).not.toBeNull()
    expect(buf!.equals(PNG_1x1)).toBe(true)
  })

  test('returns null for empty/undefined', () => {
    expect(parseOSC52ResponseData(undefined)).toBeNull()
    expect(parseOSC52ResponseData('')).toBeNull()
    expect(parseOSC52ResponseData('c;')).toBeNull()
  })
})

describe('looksLikeImageBytes', () => {
  test('recognizes PNG magic bytes', () => {
    expect(looksLikeImageBytes(PNG_1x1)).toBe(true)
  })

  test('recognizes JPEG magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    expect(looksLikeImageBytes(jpeg)).toBe(true)
  })

  test('rejects text bytes (clipboard held text, not an image)', () => {
    const text = Buffer.from('hello clipboard text', 'utf8')
    expect(looksLikeImageBytes(text)).toBe(false)
  })

  test('rejects tiny buffer', () => {
    expect(looksLikeImageBytes(Buffer.from([0x89, 0x50]))).toBe(false)
  })
})

describe('readClipboardImageViaOSC52', () => {
  test('returns image bytes when terminal responds with a PNG clipboard', async () => {
    const querier = fakeQuerier({
      type: 'osc',
      code: 52,
      data: `c;${PNG_1x1.toString('base64')}`,
    })
    const result = await readClipboardImageViaOSC52(querier)
    expect(result).not.toBeNull()
    expect(result!.buffer.equals(PNG_1x1)).toBe(true)
    expect(result!.mediaType).toBe('image/png')
  })

  test('returns null when clipboard held text (no image magic)', async () => {
    const textBuf = Buffer.from('plain text clipboard', 'utf8')
    const querier = fakeQuerier({
      type: 'osc',
      code: 52,
      data: `c;${textBuf.toString('base64')}`,
    })
    expect(await readClipboardImageViaOSC52(querier)).toBeNull()
  })

  test('returns null when terminal ignored the query (DA1 sentinel first)', async () => {
    // send() resolves undefined — the querier's flush() sentinel arrived
    // before any OSC 52 reply, i.e. the terminal doesn't support read.
    const querier = fakeQuerier(undefined)
    expect(await readClipboardImageViaOSC52(querier)).toBeNull()
  })

  test('returns null when querier is null/undefined', async () => {
    expect(await readClipboardImageViaOSC52(null)).toBeNull()
    expect(await readClipboardImageViaOSC52(undefined)).toBeNull()
  })

  test('returns null for a non-OSC-52 response', async () => {
    const querier = fakeQuerier({ type: 'osc', code: 11, data: 'rgb:00/00/00' })
    expect(await readClipboardImageViaOSC52(querier)).toBeNull()
  })
})
