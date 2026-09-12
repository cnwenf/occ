import { describe, expect, test } from 'bun:test'
import {
  INITIAL_STATE,
  isPartialTerminalResponse,
  type KeyParseState,
  parseMultipleKeypresses,
} from '../parse-keypress.js'

/**
 * Official 2.1.269 (E44): discard partial terminal-response buffers on
 * flush instead of emitting them as keystrokes.
 *
 * Binary evidence (x269 @193162377, @193165062): the `Ha` predicate
 * (mouse-prefix ≤32 / OSC-DCS ≤256 / CSI-body ≤64 shapes) gates the flush
 * path — `if(Ha(F))E=[]` drops the flush without resetting the tokenizer,
 * `else if(Gf.test(F))h.reset(),E=[]` drops an oversized mouse prefix and
 * resets. The 2.1.268 baseline only dropped the ≤32 mouse-prefix shape.
 */

function feed(state: KeyParseState, input: string): KeyParseState {
  const [, next] = parseMultipleKeypresses(state, input)
  return next
}

function flush(state: KeyParseState) {
  return parseMultipleKeypresses(state, null)
}

describe('isPartialTerminalResponse (Official 2.1.269 E44 — Ha predicate)', () => {
  test('SGR mouse prefix within 32 chars is partial', () => {
    expect(isPartialTerminalResponse('\x1b[<0;1')).toBe(true)
    expect(isPartialTerminalResponse('\x1b[<')).toBe(true)
    expect(isPartialTerminalResponse('\x1b[<0;1;2')).toBe(true)
  })

  test('oversized mouse prefix (>32) is NOT partial (Ha→Uf length cap)', () => {
    expect(isPartialTerminalResponse('\x1b[<' + '9;'.repeat(20))).toBe(false)
  })

  test('unterminated OSC/DCS/APC within 256 chars is partial', () => {
    expect(isPartialTerminalResponse('\x1b]52;abc')).toBe(true)
    expect(isPartialTerminalResponse('\x1b]0;title')).toBe(true)
    expect(isPartialTerminalResponse('\x1bP>|xterm.js')).toBe(true)
    expect(isPartialTerminalResponse('\x1b_G')).toBe(true)
  })

  test('oversized OSC (>256) is NOT partial', () => {
    expect(isPartialTerminalResponse('\x1b]52;' + 'x'.repeat(260))).toBe(
      false,
    )
  })

  test('CSI parameter body without final byte within 64 chars is partial', () => {
    expect(isPartialTerminalResponse('\x1b[?1;2')).toBe(true)
    expect(isPartialTerminalResponse('\x1b[12')).toBe(true)
    expect(isPartialTerminalResponse('\x1b[>0;1')).toBe(true)
    expect(isPartialTerminalResponse('\x1b[1;')).toBe(true)
  })

  test('oversized CSI body (>64) is NOT partial', () => {
    expect(isPartialTerminalResponse('\x1b[' + '1;'.repeat(40))).toBe(false)
  })

  test('complete or non-response buffers are NOT partial', () => {
    expect(isPartialTerminalResponse('\x1b[22c')).toBe(false) // complete CSI
    expect(isPartialTerminalResponse('\x1b[<0;1;2M')).toBe(false) // SGR complete
    expect(isPartialTerminalResponse('\x1b]0;t\x07')).toBe(false) // OSC terminated
    expect(isPartialTerminalResponse('abc')).toBe(false)
    expect(isPartialTerminalResponse('\x1b')).toBe(false)
    expect(isPartialTerminalResponse('\x1b[')).toBe(false)
    expect(isPartialTerminalResponse('')).toBe(false)
  })
})

describe('parseMultipleKeypresses flush (Official 2.1.269 E44)', () => {
  test("flushing partial CSI response '\\x1b[?1;2' drops it and keeps the buffer", () => {
    const state = feed(INITIAL_STATE, '\x1b[?1;2')
    const [keys, next] = flush(state)
    expect(keys).toEqual([])
    // Official Ha branch does NOT reset the tokenizer — buffer persists.
    expect(next.incomplete).toBe('\x1b[?1;2')
  })

  test('a later feed completes the retained partial sequence', () => {
    const state = feed(INITIAL_STATE, '\x1b[?1;2')
    const [, afterFlush] = flush(state)
    const [keys] = parseMultipleKeypresses(afterFlush, 'c')
    // '\x1b[?1;2c' — DA1-shaped complete response
    expect(keys.length).toBe(1)
    expect(keys[0]!.kind).toBe('response')
  })

  test("flushing unterminated OSC '\\x1b]52;abc' (≤256) drops it", () => {
    const state = feed(INITIAL_STATE, '\x1b]52;abc')
    const [keys, next] = flush(state)
    expect(keys).toEqual([])
    expect(next.incomplete).toBe('\x1b]52;abc')
  })

  test("flushing mouse partial '\\x1b[<0;1' (≤32) drops it", () => {
    const state = feed(INITIAL_STATE, '\x1b[<0;1')
    const [keys, next] = flush(state)
    expect(keys).toEqual([])
    expect(next.incomplete).toBe('\x1b[<0;1')
  })

  test('oversized mouse prefix (>32) is dropped AND the tokenizer is reset', () => {
    // Official second branch: `else if(Gf.test(F))h.reset(),E=[]`.
    const garbage = '\x1b[<' + '9;'.repeat(20)
    const state = feed(INITIAL_STATE, garbage)
    const [keys, next] = flush(state)
    expect(keys).toEqual([])
    expect(next.incomplete).toBe('')
  })

  test('long garbage >64 not matching CSI shape is NOT dropped (flushed as before)', () => {
    const long = '\x1b[' + '1;'.repeat(40)
    const state = feed(INITIAL_STATE, long)
    const [keys] = flush(state)
    expect(keys.length).toBeGreaterThan(0)
  })

  test('complete sequences are emitted at feed time, leaving nothing to flush', () => {
    // '\x1b[22c' completes during feed (no retained buffer) — the flush
    // guard sees an empty buffer and Ha('') is false.
    const [, afterFeed] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[22c')
    expect(afterFeed.incomplete).toBe('')
    const [keys] = flush(afterFeed)
    expect(keys).toEqual([])
    // A complete DA1-shaped response parses as a response, not a partial.
    const [respKeys] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[?22c')
    expect(respKeys.length).toBe(1)
    expect(respKeys[0]!.kind).toBe('response')
  })

  test('flush in IN_PASTE mode does NOT drop — partial stays literal paste text', () => {
    // Official guard: `n.mode!=="IN_PASTE"`.
    const pasting = feed(INITIAL_STATE, '\x1b[200~abc\x1b[?1;2')
    expect(pasting.mode).toBe('IN_PASTE')
    const [keys] = flush(pasting)
    expect(keys.length).toBe(1)
    expect(keys[0]!.kind).toBe('key')
    const paste = keys[0] as { isPasted?: boolean; sequence?: string }
    expect(paste.isPasted).toBe(true)
    expect(paste.sequence).toContain('abc')
    expect(paste.sequence).toContain('\x1b[?1;2')
  })

  test('flush with empty buffer emits nothing', () => {
    const [keys] = flush(INITIAL_STATE)
    expect(keys).toEqual([])
  })
})
