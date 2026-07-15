import { describe, expect, test } from 'bun:test'
import {
  createCappedStderrAccumulator,
  MAX_MCP_STDERR_BYTES,
} from '../stderrCap.js'

/**
 * CC 2.1.208 #29: MCP stdio stderr must be capped at 64MB so a chatty/faulty
 * stdio server cannot exhaust memory or hit Node's child_process maxBuffer
 * (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
 *
 * The official 2.1.210 binary implements a SOFT, head-retention cap:
 *   handler = (Q) => { if (g.length < 67108864) try { g += Q.toString() } catch {} }
 * i.e. it checks `g.length < cap` BEFORE appending the WHOLE chunk. Consequences
 * matched exactly here:
 *   - The retained buffer may exceed the cap by up to one chunk (the chunk that
 *     crosses the boundary is appended in full) — this is a SOFT cap.
 *   - Once `g.length >= cap`, no further chunks are appended (memory bounded).
 *   - Head-retention: the first chunks (up to the crossing chunk) are kept;
 *     everything written after is dropped.
 * The constant is folded to `67108864` (= 64 * 1024 * 1024) in the binary.
 */
describe('2.1.208 #29 — capped MCP stdio stderr accumulator', () => {
  test('MAX_MCP_STDERR_BYTES equals the binary folded constant 67108864', () => {
    // 64 * 1024 * 1024 === 67108864 — the exact constant in the 2.1.210 binary.
    expect(MAX_MCP_STDERR_BYTES).toBe(64 * 1024 * 1024)
    expect(MAX_MCP_STDERR_BYTES).toBe(67108864)
  })

  test('accumulates stderr while under the cap', () => {
    // Arrange
    const acc = createCappedStderrAccumulator(1024)

    // Act
    acc.handler(Buffer.from('hello '))
    acc.handler(Buffer.from('world'))

    // Assert
    expect(acc.getOutput()).toBe('hello world')
    expect(acc.getOutput().length).toBeLessThanOrEqual(1024)
  })

  test('soft cap: the crossing chunk is appended in full, then no further growth', () => {
    // Arrange — small cap so we can cross it cheaply
    const cap = 16
    const acc = createCappedStderrAccumulator(cap)

    // Act
    acc.handler(Buffer.from('AAAAAAAAAA')) // 10 bytes, under cap → appended
    acc.handler(Buffer.from('BBBBBBBBBB')) // 10<16 true → appended in full (crosses cap)
    const lengthAfterCrossing = acc.getOutput().length
    acc.handler(Buffer.from('CCCCCCCCCC')) // now >= cap → dropped
    acc.handler(Buffer.from('DDDDDDDDDD')) // still >= cap → dropped

    // Assert — soft cap: the crossing chunk is kept in full (20 > 16), but
    // subsequent chunks do NOT grow the buffer (memory is bounded).
    expect(acc.getOutput()).toContain('AAAA')
    expect(acc.getOutput()).toContain('BBBB')
    expect(acc.getOutput()).not.toContain('CCCC')
    expect(acc.getOutput()).not.toContain('DDDD')
    expect(acc.getOutput().length).toBe(lengthAfterCrossing) // no growth post-cap
    expect(acc.getOutput().length).toBe(20) // 10 + 10 crossing chunk
  })

  test('head-retention: bytes written before the cap survives; bytes after are dropped', () => {
    // Arrange — fill up to the cap with small chunks, then a late marker.
    const cap = 24
    const acc = createCappedStderrAccumulator(cap)

    // Act — six 4-byte chunks reach exactly the cap (24), then a late marker.
    acc.handler(Buffer.from('HEAD')) // 4
    acc.handler(Buffer.from('AAAA')) // 8
    acc.handler(Buffer.from('BBBB')) // 12
    acc.handler(Buffer.from('CCCC')) // 16
    acc.handler(Buffer.from('DDDD')) // 20
    acc.handler(Buffer.from('EEEE')) // 24 == cap (next chunk will be dropped)
    acc.handler(Buffer.from('LATE-TAIL-MARKER')) // 24<24 false → dropped

    // Assert
    expect(acc.getOutput()).toContain('HEAD')
    expect(acc.getOutput()).toContain('EEEE')
    expect(acc.getOutput()).not.toContain('LATE-TAIL-MARKER')
    expect(acc.getOutput().length).toBeLessThan(cap + 'LATE-TAIL-MARKER'.length)
  })

  test('reset releases the accumulated string', () => {
    // Arrange
    const acc = createCappedStderrAccumulator(1024)
    acc.handler(Buffer.from('some stderr'))

    // Act
    acc.reset()

    // Assert
    expect(acc.getOutput()).toBe('')
  })

  test('handler is a stable reference (so .off() can remove it)', () => {
    // Arrange
    const acc = createCappedStderrAccumulator(1024)

    // Assert — the listener reference is stable across reads, matching the
    // binary's single `f` function used for both .on() and .off().
    expect(acc.handler).toBe(acc.handler)
  })

  test('real 64MB cap: feeding >64MB bounds memory (soft cap, head retained)', () => {
    // This is the load-bearing assertion that the production 64MB cap works.
    // Arrange — default cap (64MB); feed 65MB in 1MB chunks with a head
    // marker first and a tail marker last.
    const acc = createCappedStderrAccumulator() // default = 64 * 1024 * 1024
    const oneMb = Buffer.alloc(1024 * 1024, 0x78) // 'x'

    // Act
    acc.handler(Buffer.from('HEAD-MARKER-START\n')) // written first → retained
    for (let i = 0; i < 65; i++) {
      // 65MB of fill, well past the 64MB cap
      acc.handler(oneMb)
    }
    acc.handler(Buffer.from('\nTAIL-MARKER-END')) // written last → dropped

    const retained = acc.getOutput()

    // Assert — soft cap: retained is bounded to ~cap + one chunk (here the
    // 18-byte head marker + 64 * 1MB = 67108882). It does NOT grow with the
    // extra 1MB or the tail marker (both dropped once the cap was reached).
    expect(retained.length).toBeLessThan(MAX_MCP_STDERR_BYTES + oneMb.length)
    expect(retained.length).toBe(18 + 64 * (1024 * 1024)) // 67108882
    expect(retained).toContain('HEAD-MARKER-START') // head retained
    expect(retained).not.toContain('TAIL-MARKER-END') // tail dropped
    // The 65th 1MB chunk was dropped (only 64 appended after the head).
    expect(retained.length).toBeLessThan(19 + 65 * (1024 * 1024))
  })
})
