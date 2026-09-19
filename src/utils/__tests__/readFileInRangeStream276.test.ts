/**
 * CC 2.1.275/2.1.276 (ITEM J) — readFileInRange streaming decode overhaul.
 *
 * Official v274 opened the stream with `encoding: 'utf8'`, so Node/Bun decoded
 * internally and handed the handler a string. Two consequences:
 *   1. A multi-byte character straddling a chunk boundary relied on the
 *      stream's own decoder, and any decode/alloc throw happened INSIDE the
 *      stream machinery — it escaped the handler as an uncaught exception,
 *      leaving `await readFileInRange(...)` pending forever.
 *   2. The BOM check consumed `isFirstChunk` on whatever the first handler call
 *      produced, including an empty decode.
 *
 * Official v276 (byte-extracted @197325400-197331600 of
 * /tmp/cc-diff-276/v276/package/claude):
 *   `Dko` state: `stream: vko(e,{highWaterMark:524288,…}), decoder:new wko("utf8")`
 *                — no `encoding` option, decoder held on the state
 *   `function Mko(e){let n=this.decoder.write(e);if(n.length>0)_tn.call(this,n)}`
 *                — decode first, skip empty decodes (BOM stays armed)
 *   `function Oko(){let e=this.decoder.end();if(e.length>0){_tn.call(this,e);
 *                if(this.stream.destroyed)return}…}` — flush the decoder at EOF
 *   `function btn(e){return function(...n){try{e.apply(this,n)}catch(r){
 *                this.stream.destroy(ue(r))}}}` — handler guard
 *   `var Nko=btn(Mko),Lko=btn(Oko)` and `U.stream.on("data",Nko.bind(U))`
 *
 * Part B of the upstream change (the handle-based reader `f7e` gained
 * `.catch(O=>{y=!1,w.destroy(ue(O))})`) has no OCC surface — OCC's streaming
 * path is createReadStream-based — so it is intentionally not ported.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'

import {
  type ReadFileRangeResult,
  type StreamState,
  readFileInRange,
  streamOnData,
  streamOnEnd,
  wrapStreamHandler,
} from '../readFileInRange.js'

const sandboxDir = mkdtempSync(join(tmpdir(), 'occ-readrange-276-'))

afterAll(() => {
  rmSync(sandboxDir, { recursive: true, force: true })
})

/** 512 KiB — the production highWaterMark, so chunk boundaries are realistic. */
const CHUNK_BYTES = 512 * 1024
/** Above FAST_PATH_MAX_SIZE (10 MiB) so the fixture takes the streaming path. */
const SPARSE_TOTAL_BYTES = 11 * 1024 * 1024

/**
 * A file whose size forces the streaming path while keeping only `content` on
 * disk: the tail is a sparse hole (reads back as NUL bytes, costs ~0 blocks).
 */
function writeSparseFixture(name: string, content: string): string {
  const filePath = join(sandboxDir, name)
  writeFileSync(filePath, content, 'utf8')
  truncateSync(filePath, SPARSE_TOTAL_BYTES)
  return filePath
}

// ---------------------------------------------------------------------------
// Hand-built StreamState harness (drives the exported handlers directly)
// ---------------------------------------------------------------------------

type FakeStream = EventEmitter & {
  destroyed: boolean
  destroy: (error?: Error) => void
}

function createFakeStream(): FakeStream {
  const emitter = new EventEmitter() as FakeStream
  emitter.destroyed = false
  emitter.destroy = (error?: Error) => {
    emitter.destroyed = true
    if (error) {
      emitter.emit('error', error)
    }
  }
  return emitter
}

function createHarness(options: { offset?: number; maxLines?: number } = {}): {
  state: StreamState
  stream: FakeStream
  done: Promise<ReadFileRangeResult>
  errors: unknown[]
} {
  const stream = createFakeStream()
  const errors: unknown[] = []
  stream.on('error', error => errors.push(error))

  let resolveResult: (value: ReadFileRangeResult) => void = () => {}
  const done = new Promise<ReadFileRangeResult>(resolve => {
    resolveResult = resolve
  })

  const offset = options.offset ?? 0
  const state: StreamState = {
    stream: stream as unknown as StreamState['stream'],
    decoder: new StringDecoder('utf8'),
    offset,
    endLine:
      options.maxLines !== undefined ? offset + options.maxLines : Number.POSITIVE_INFINITY,
    maxBytes: undefined,
    maxSelectedBytes: undefined,
    truncateOnByteLimit: false,
    resolve: resolveResult,
    totalBytesRead: 0,
    selectedBytes: 0,
    truncatedByBytes: false,
    currentLineIndex: 0,
    selectedLines: [],
    partial: '',
    partialBytes: 0,
    isFirstChunk: true,
    resolveMtime: () => {},
    mtimeReady: Promise.resolve(1234),
  }
  return { state, stream, done, errors }
}

/** Split a string into Buffers at byte offsets that cut multi-byte chars. */
function toChunks(text: string, splitAt: number[]): Buffer[] {
  const bytes = Buffer.from(text, 'utf8')
  const bounds = [0, ...splitAt, bytes.length]
  const chunks: Buffer[] = []
  for (let index = 0; index < bounds.length - 1; index++) {
    const start = bounds[index] as number
    const end = bounds[index + 1] as number
    if (end > start) {
      chunks.push(bytes.subarray(start, end))
    }
  }
  return chunks
}

// ---------------------------------------------------------------------------
// wrapStreamHandler (binary btn)
// ---------------------------------------------------------------------------

describe('wrapStreamHandler (v276 btn)', () => {
  test('passes arguments and this through on the success path', () => {
    // Arrange
    const { state } = createHarness()
    const seen: Array<{ self: unknown; args: unknown[] }> = []
    const wrapped = wrapStreamHandler<[Buffer]>(function handler(
      this: StreamState,
      chunk: Buffer,
    ) {
      seen.push({ self: this, args: [chunk] })
    })
    const chunk = Buffer.from('data')

    // Act
    wrapped.call(state, chunk)

    // Assert
    expect(seen).toEqual([{ self: state, args: [chunk] }])
  })

  test('converts a handler throw into stream.destroy(err)', () => {
    // Arrange
    const { state, stream, errors } = createHarness()
    const thrown = new Error('handler exploded')
    const wrapped = wrapStreamHandler<[Buffer]>(() => {
      throw thrown
    })

    // Act — without the wrapper this throw escapes the EventEmitter.
    expect(() => wrapped.call(state, Buffer.from('x'))).not.toThrow()

    // Assert
    expect(stream.destroyed).toBe(true)
    expect(errors).toEqual([thrown])
  })

  test('wraps a non-Error throw so destroy always receives an Error', () => {
    // Arrange
    const { state, errors } = createHarness()
    const wrapped = wrapStreamHandler<[]>(() => {
      throw 'plain string failure'
    })

    // Act
    wrapped.call(state)

    // Assert — binary `ue(r)` normalization.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('plain string failure')
  })
})

// ---------------------------------------------------------------------------
// Incremental decode (binary Mko + _tn + Oko)
// ---------------------------------------------------------------------------

describe('streaming decode (v276 Mko/Oko)', () => {
  test('decodes a multi-byte character split across a chunk boundary', async () => {
    // Arrange — 😀 is F0 9F 98 80; split it after the second byte.
    const text = 'first 😀 line\nsecond 中文 line\n'
    const emojiStart = Buffer.from(text, 'utf8').indexOf(0xf0)
    const { state, done } = createHarness()

    // Act
    for (const chunk of toChunks(text, [emojiStart + 2])) {
      streamOnData.call(state, chunk)
    }
    streamOnEnd.call(state)

    // Assert — a per-chunk TextDecoder/toString would emit replacement chars.
    // The trailing newline yields the usual empty final line (unchanged
    // behavior, identical to the fast path).
    const result = await done
    expect(result.content).toBe('first 😀 line\nsecond 中文 line\n')
    expect(result.lineCount).toBe(3)
    expect(result.totalLines).toBe(3)
  })

  test('keeps the BOM armed when the first decode is empty', async () => {
    // Arrange — the BOM (EF BB BF) arrives one byte per chunk, so the first two
    // decoder.write calls return '' and must NOT consume isFirstChunk.
    const text = '\uFEFFhello\nworld\n'
    const { state, done } = createHarness()

    // Act
    for (const chunk of toChunks(text, [1, 2])) {
      streamOnData.call(state, chunk)
    }
    streamOnEnd.call(state)

    // Assert
    const result = await done
    expect(result.content).toBe('hello\nworld\n')
    expect(result.content.charCodeAt(0)).not.toBe(0xfeff)
  })

  test('strips a BOM delivered whole in the first chunk', async () => {
    // Arrange
    const text = '\uFEFFalpha\nbeta\n'
    const { state, done } = createHarness()

    // Act
    streamOnData.call(state, Buffer.from(text, 'utf8'))
    streamOnEnd.call(state)

    // Assert
    expect((await done).content).toBe('alpha\nbeta\n')
  })

  test('a BOM in a later chunk is content, not a marker', async () => {
    // Arrange — only the FIRST decoded chunk may carry the BOM.
    const text = 'one\n\uFEFFtwo\n'
    const { state, done } = createHarness()

    // Act
    for (const chunk of toChunks(text, [Buffer.from('one\n', 'utf8').length])) {
      streamOnData.call(state, chunk)
    }
    streamOnEnd.call(state)

    // Assert
    expect((await done).content).toBe('one\n\uFEFFtwo\n')
  })

  test('an empty decode does not advance the scanner', async () => {
    // Arrange — a leading 2-byte character fed one byte at a time: the first
    // decode is empty, so isFirstChunk (and the BOM check) must stay armed.
    const bytes = Buffer.from('éllo\n', 'utf8')
    expect(bytes[0]).toBe(0xc3)
    const { state, done } = createHarness()

    // Act
    streamOnData.call(state, bytes.subarray(0, 1)) // lead byte only → ''
    expect(state.isFirstChunk).toBe(true)
    streamOnData.call(state, bytes.subarray(1))
    streamOnEnd.call(state)

    // Assert
    expect((await done).content).toBe('éllo\n')
  })

  test('streamOnEnd flushes trailing decoder bytes through the scanner', async () => {
    // Arrange — the file ends mid-character, so only decoder.end() can emit it.
    const bytes = Buffer.from('tail\n中文', 'utf8')
    const splitAfterLeadByte = bytes.indexOf(0xe4) + 1
    const { state, done } = createHarness()

    // Act
    streamOnData.call(state, bytes.subarray(0, splitAfterLeadByte))
    streamOnEnd.call(state)

    // Assert — the flush surfaces the incomplete sequence as U+FFFD instead of
    // silently dropping the trailing bytes, and it still reaches the scanner.
    const result = await done
    expect(result.content).toBe('tail\n�')
    expect(result.lineCount).toBe(2)
  })

  test('a throwing data handler destroys the stream instead of escaping', async () => {
    // Arrange — the production wrapper around the real handler.
    const { state, stream, errors } = createHarness()
    const thrown = new TypeError('decode failed')
    const wrapped = wrapStreamHandler<[Buffer]>(() => {
      throw thrown
    })

    // Act
    wrapped.call(state, Buffer.from('payload'))

    // Assert — 'error' is the reject path in readFileInRangeStreaming, so the
    // promise settles instead of hanging.
    expect(stream.destroyed).toBe(true)
    expect(errors).toEqual([thrown])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through readFileInRange
// ---------------------------------------------------------------------------

describe('readFileInRange streaming path (v276 end-to-end)', () => {
  const realWrite = StringDecoder.prototype.write

  afterEach(() => {
    StringDecoder.prototype.write = realWrite
  })

  test('a throwing decode rejects the read instead of hanging', async () => {
    // Arrange — >10MB so the streaming path runs, decoder poisoned to throw
    // from inside the production handler.
    const filePath = writeSparseFixture('poisoned.bin', 'line one\nline two\n')
    const thrown = new Error('decoder exploded')
    StringDecoder.prototype.write = () => {
      throw thrown
    }

    // Act
    const error = await readFileInRange(filePath).then(
      result => {
        throw new Error(`expected rejection, resolved ${result.lineCount} lines`)
      },
      (e: unknown) => e,
    )

    // Assert — v274 lost this throw inside the stream and never settled.
    expect(error).toBe(thrown)
  })

  test('a >10MB read returns the same content as the unchanged fast path', async () => {
    // Arrange — ~1.2MB of multi-byte content: three 512KiB chunks, so several
    // characters straddle real chunk boundaries.
    const lines = Array.from(
      { length: 24_000 },
      (_, index) => `line ${String(index)} héllo 中文 😀 padded-out-to-length`,
    )
    const content = `${lines.join('\n')}\n`
    expect(Buffer.byteLength(content)).toBeGreaterThan(CHUNK_BYTES * 2)

    const smallPath = join(sandboxDir, 'same-content-small.txt')
    writeFileSync(smallPath, content, 'utf8') // <10MB → fast path
    const bigPath = writeSparseFixture('same-content-big.txt', content)

    // Act
    const fast = await readFileInRange(smallPath)
    const streamed = await readFileInRange(bigPath, 0, lines.length)

    // Assert — the decoder rewrite is content-identical to the old path.
    expect(fast.content).toBe(content)
    expect(streamed.content).toBe(content.slice(0, -1)) // trailing '\n' is line N+1
    expect(streamed.lineCount).toBe(lines.length)
    expect(streamed.totalLines).toBe(lines.length + 1)
    // Proof the fixture really took the streaming path (whole sparse size read).
    expect(streamed.totalBytes).toBeGreaterThanOrEqual(SPARSE_TOTAL_BYTES)
  })

  test('a ranged read of a large file selects the same window as before', async () => {
    // Arrange
    const lines = Array.from({ length: 12_000 }, (_, index) => `row ${String(index)} ✓`)
    const content = `${lines.join('\n')}\n`
    const bigPath = writeSparseFixture('ranged-big.txt', content)

    // Act
    const window = await readFileInRange(bigPath, 100, 3)

    // Assert
    expect(window.content).toBe('row 100 ✓\nrow 101 ✓\nrow 102 ✓')
    expect(window.lineCount).toBe(3)
    expect(window.totalLines).toBe(lines.length + 1)
  })

  test('CRLF and BOM handling survive the decoder rewrite', async () => {
    // Arrange
    const content = '\uFEFFalpha\r\nbeta\r\n'
    const bigPath = writeSparseFixture('crlf-big.txt', content)

    // Act
    const streamed = await readFileInRange(bigPath, 0, 2)

    // Assert
    expect(streamed.content).toBe('alpha\nbeta')
  })
})
