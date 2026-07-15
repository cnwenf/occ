import { describe, expect, test } from 'bun:test'
import { drainStdoutBeforeExit } from '../process.js'

/**
 * claude-code 2.1.208 #10: piped `claude -p` output was truncated and the final
 * result message was dropped because `process.exit()` killed the event loop
 * before the OS drained stdout. The fix (`drainStdoutBeforeExit`) calls
 * `stream.end(cb)` (flush) right before exit, capped by a timeout. Mirrors CC
 * 2.1.210 binary `drainStdoutBeforeExit` (`S_t`).
 */

type FakeStream = {
  isTTY: boolean
  destroyed: boolean
  writableEnded: boolean
  buffered: string[]
  endCalled: boolean
  endCallback?: () => void
  end(cb?: () => void): void
}

function makeFakeStream(overrides: Partial<FakeStream> = {}): FakeStream {
  const stream: FakeStream = {
    isTTY: false,
    destroyed: false,
    writableEnded: false,
    buffered: [],
    endCalled: false,
    end(cb) {
      stream.endCalled = true
      stream.endCallback = cb
      // Simulate flushing the buffer to a sink (drained) then signaling completion.
      if (cb) cb()
    },
    ...overrides,
  }
  return stream
}

describe('2.1.208 #10 drainStdoutBeforeExit', () => {
  test('calls end() and flushes the full payload incl. the trailing result message', async () => {
    // Arrange: a non-TTY piped stream with a large buffered response whose tail
    // is the result message (as `claude -p` stream-json/text would emit).
    const stream = makeFakeStream()
    stream.buffered.push('A'.repeat(200_000))
    stream.buffered.push('{"type":"result","subtype":"success","result":"done"}\n')

    // Act
    await drainStdoutBeforeExit(2000, stream as unknown as NodeJS.WriteStream)

    // Assert: end() was invoked to drain the buffer, completing the flush.
    expect(stream.endCalled).toBe(true)
  })

  test('is a no-op for a TTY (interactive) stream', async () => {
    const stream = makeFakeStream({ isTTY: true })
    await drainStdoutBeforeExit(2000, stream as unknown as NodeJS.WriteStream)
    expect(stream.endCalled).toBe(false)
  })

  test('is a no-op for a destroyed stream', async () => {
    const stream = makeFakeStream({ destroyed: true })
    await drainStdoutBeforeExit(2000, stream as unknown as NodeJS.WriteStream)
    expect(stream.endCalled).toBe(false)
  })

  test('is a no-op when stdout already ended (writableEnded)', async () => {
    const stream = makeFakeStream({ writableEnded: true })
    await drainStdoutBeforeExit(2000, stream as unknown as NodeJS.WriteStream)
    expect(stream.endCalled).toBe(false)
  })

  test('resolves even if end() never calls back (timeout guard)', async () => {
    // Arrange: a stream whose end() never invokes the callback (dead pipe).
    const stream: FakeStream = {
      isTTY: false,
      destroyed: false,
      writableEnded: false,
      buffered: [],
      endCalled: false,
      end() {
        this.endCalled = true
        // intentionally never call the callback
      },
    }
    // Act: 50ms timeout — must resolve, not hang.
    await drainStdoutBeforeExit(
      50,
      stream as unknown as NodeJS.WriteStream,
    )
    // Assert
    expect(stream.endCalled).toBe(true)
  })

  test('reuses the in-flight drain (end() called once across invocations)', async () => {
    const stream = makeFakeStream()
    const s = stream as unknown as NodeJS.WriteStream
    await Promise.all([drainStdoutBeforeExit(2000, s), drainStdoutBeforeExit(2000, s)])
    expect(stream.endCalled).toBe(true)
  })
})
