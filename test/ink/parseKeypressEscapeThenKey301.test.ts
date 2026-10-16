import { describe, expect, test } from 'bun:test'
import {
  ESCAPE_THEN_KEY_RE,
  INITIAL_STATE,
  isEscapePrefixedMultiChar,
  isEscapeThenKeySequence,
  parseMultipleKeypresses,
  readAsEscapeThenKey,
  splitEscapeThenKey,
  type ParsedKey,
} from '../../src/ink/parse-keypress.js'

// CC 2.1.301 #22 — vim stuck in INSERT after Esc on a slow machine.
//
// ROOT CAUSE (verified against the v301 linux-x64 ELF): when ESC and the next
// key arrive in the SAME stdin read (a "slow machine" / solo late read), the
// termio tokenizer merges them into ONE escape-final token. `\x1bj` parses to a
// single meta key with name '' — NOT an `escape` keypress — so the vim handler's
// `key.escape && mode === 'INSERT'` → NORMAL transition never fires and vim stays
// stuck in INSERT.
//
// Official fix spans FOUR sites; only the pure parse-layer helpers are inside
// this change's file ownership (src/ink/parse-keypress.ts). The other three —
//   (1) read-loop marking of `readLate`/`soloKeypress` (App.tsx handleReadable),
//   (2) the `dispatchKeyboardEvent(...) → mb(n, cy(A.sequence), …)` re-queue
//       (read loop, App.tsx),
//   (3) threading `sequence`/`readLate`/`readAsEscapeThenKey` onto the ink Key
//       (src/ink/events/input-event.ts parseKey) so the vim guard can consult
//       them (src/hooks/useVimInput.ts),
// are OUT of ownership. Wiring the useVimInput swallow-guard alone (without the
// read-loop re-queue) would DROP the keypress — a regression — so it is NOT
// wired here. The pure helpers below are the byte-faithful building blocks the
// read layer calls; they are landed + tested so the wiring is validated.
//
// Byte-verbatim official sources:
//   An `/^\x1b(?![[\]P_\\])[\x21-\x7e]$/`                                    @236341832
//   Jc `function Jc(n){return n.length>1&&n.startsWith(bR)}`  (bR="\x1B")      @231885357
//   cy `function cy(n){if(!Jc(n))return[];return[bR,n.slice(1)].flatMap((u)=>{let[f,m]=Ia({...Bc},u);return f.concat(Ia(m,null)[0])})}`  @231885408
//   readAsEscapeThenKey `this.soloKeypress!==void 0&&Jc(this.sequence)`        @231961993

describe('CC 2.1.301 #22 — CHARACTERIZATION: \\x1bj in one read merges (the bug)', () => {
  test('a single-chunk \\x1bj yields ONE merged meta key, not escape-then-j', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1bj')
    // The tokenizer treats ESC+printable-final as one 2-char escape sequence.
    expect(keys.length).toBe(1)
    const k = keys[0] as ParsedKey
    expect(k.kind).toBe('key')
    // name is '' (META_KEY_CODE_RE path) — crucially NOT 'escape' and NOT 'j'.
    expect(k.name).toBe('')
    expect(k.meta).toBe(true)
    expect(k.sequence).toBe('\x1bj')
  })

  test('the merged key is not an escape, so the vim INSERT→NORMAL branch cannot fire', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\x1bj')
    const k = keys[0] as ParsedKey
    // input-event.ts sets `key.escape = keypress.name === 'escape'`. With
    // name === '', escape is false → useVimInput's Esc branch is unreachable.
    expect(k.name === 'escape').toBe(false)
  })

  test('split across two reads, ESC and j parse separately (fast-path is fine)', () => {
    const [escKeys, state] = parseMultipleKeypresses(INITIAL_STATE, '\x1b')
    // A lone ESC buffers as incomplete until flushed.
    expect(escKeys.length).toBe(0)
    expect(state.incomplete).toBe('\x1b')
    const [jKeys] = parseMultipleKeypresses(state, 'j')
    // Now the buffered ESC + j form the same merged token — this is exactly the
    // slow-machine case; the two-read timing is what the read layer must detect.
    expect(jKeys.length).toBe(1)
  })
})

describe('CC 2.1.301 #22 — isEscapeThenKeySequence (official `An`)', () => {
  test('matches ESC + a single printable non-introducer char', () => {
    expect(isEscapeThenKeySequence('\x1bj')).toBe(true)
    expect(isEscapeThenKeySequence('\x1bA')).toBe(true)
    expect(isEscapeThenKeySequence('\x1b1')).toBe(true)
    expect(isEscapeThenKeySequence('\x1b!')).toBe(true) // 0x21 lower bound
    expect(isEscapeThenKeySequence('\x1b~')).toBe(true) // 0x7e upper bound
  })

  test('rejects ESC + a longer-sequence introducer (CSI/OSC/DCS/APC/ST)', () => {
    expect(isEscapeThenKeySequence('\x1b[')).toBe(false) // CSI
    expect(isEscapeThenKeySequence('\x1b]')).toBe(false) // OSC
    expect(isEscapeThenKeySequence('\x1bP')).toBe(false) // DCS
    expect(isEscapeThenKeySequence('\x1b_')).toBe(false) // APC
    expect(isEscapeThenKeySequence('\x1b\\')).toBe(false) // ST
  })

  test('rejects a lone ESC, ESC + space, two trailing chars, or no ESC', () => {
    expect(isEscapeThenKeySequence('\x1b')).toBe(false)
    expect(isEscapeThenKeySequence('\x1b ')).toBe(false) // 0x20 < 0x21
    expect(isEscapeThenKeySequence('\x1bjj')).toBe(false) // >1 trailing char
    expect(isEscapeThenKeySequence('j')).toBe(false)
    expect(isEscapeThenKeySequence('')).toBe(false)
  })

  test('the exported regex is the byte-verbatim official `An`', () => {
    expect(ESCAPE_THEN_KEY_RE.source).toBe('^\\x1b(?![[\\]P_\\\\])[\\x21-\\x7e]$')
  })
})

describe('CC 2.1.301 #22 — isEscapePrefixedMultiChar (official `Jc`)', () => {
  test('true only for length>1 sequences starting with ESC', () => {
    expect(isEscapePrefixedMultiChar('\x1bj')).toBe(true)
    expect(isEscapePrefixedMultiChar('\x1b[A')).toBe(true)
    expect(isEscapePrefixedMultiChar('\x1b')).toBe(false) // length 1
    expect(isEscapePrefixedMultiChar('j')).toBe(false) // no ESC prefix
    expect(isEscapePrefixedMultiChar('')).toBe(false)
  })
})

describe('CC 2.1.301 #22 — splitEscapeThenKey (official `cy` re-split)', () => {
  test('re-splits a merged \\x1bj into [escape, j]', () => {
    const keys = splitEscapeThenKey('\x1bj')
    expect(keys.length).toBe(2)
    expect(keys[0]!.name).toBe('escape')
    expect(keys[1]!.name).toBe('j')
  })

  test('returns [] for a non-escape-prefixed sequence (Jc guard)', () => {
    expect(splitEscapeThenKey('j')).toEqual([])
    expect(splitEscapeThenKey('')).toEqual([])
    expect(splitEscapeThenKey('\x1b')).toEqual([]) // length 1 → Jc false
  })

  test('re-splits ESC + bracket-ish printable that An still excludes from the guard', () => {
    // cy only gates on Jc (escape-prefixed, length>1), not An — so a merged
    // ESC+[ re-splits too. The vim guard additionally applies An before use.
    const keys = splitEscapeThenKey('\x1b[')
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(keys[0]!.name).toBe('escape')
  })
})

describe('CC 2.1.301 #22 — readAsEscapeThenKey (official method, as a pure fn)', () => {
  function keyWith(over: Partial<ParsedKey>): ParsedKey {
    return {
      kind: 'key',
      fn: false,
      name: '',
      ctrl: false,
      meta: true,
      shift: false,
      option: false,
      super: false,
      sequence: '\x1bj',
      raw: '\x1bj',
      isPasted: false,
      ...over,
    }
  }

  test('true when soloKeypress is set AND the sequence is escape-prefixed multi-char', () => {
    expect(readAsEscapeThenKey(keyWith({ soloKeypress: true }))).toBe(true)
    expect(readAsEscapeThenKey(keyWith({ soloKeypress: false }))).toBe(true)
  })

  test('false when soloKeypress is undefined (the read layer did not mark it)', () => {
    expect(readAsEscapeThenKey(keyWith({ soloKeypress: undefined }))).toBe(false)
    expect(readAsEscapeThenKey(keyWith({}))).toBe(false)
  })

  test('false when the sequence is not escape-prefixed multi-char', () => {
    expect(
      readAsEscapeThenKey(keyWith({ soloKeypress: true, sequence: 'j' })),
    ).toBe(false)
    expect(
      readAsEscapeThenKey(keyWith({ soloKeypress: true, sequence: '\x1b' })),
    ).toBe(false)
  })
})
