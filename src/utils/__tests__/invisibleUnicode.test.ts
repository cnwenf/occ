import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetForTesting,
  attachAnalyticsSink,
} from '../../services/analytics/index.js'
import type { PastedContent } from '../config.js'
import {
  INPUT_INVISIBLE_STRIP_COUNTER,
  INVISIBLE_STRIP_GATE,
  PROMPT_INVISIBLE_STRIP_EVENT,
  formatInvisibleStripNotice,
  stripInvisibleForSubmit,
  stripInvisibleText,
  stripInvisibleUnicode,
  stripInvisibleWithMeta,
} from '../invisibleUnicode.js'

// CC 2.1.278 (D2 SECURITY): invisible-Unicode classifier port — UTs for the
// byte-ported official classifier (m4r/jn/bi @196053341-196057200), the yr/Bxt
// /Bnt wrappers, the fde notice strings, and the tengu_prompt_invisible_strip
// telemetry. All expectations derive from the official binary semantics
// (see src/utils/invisibleUnicode.ts header for the symbol map + offsets).
//
// DISCIPLINE: this test source contains ZERO raw invisible characters — every
// non-ASCII code point is an explicit \u escape, so the fixtures are exact
// and the file itself would not trip the classifier it tests.

// Tag-plane (U+E0000 block) payload helper.
const tag = (...letters: string[]): string =>
  String.fromCodePoint(...letters.map(c => 917504 + c.charCodeAt(0)))
const CANCEL_TAG = String.fromCodePoint(0xe007f)
const BLACK_FLAG = '\u{1F3F4}'
// U+00B7 MIDDLE DOT — byte-verified notice separator (\xB7 in the ELF).
const MIDDOT = '·'

type CapturedEvent = {
  name: string
  metadata: Record<string, boolean | number | undefined>
}
let capturedEvents: CapturedEvent[] = []

beforeEach(() => {
  _resetForTesting()
  capturedEvents = []
  attachAnalyticsSink({
    logEvent: (name, metadata) => {
      capturedEvents.push({ name, metadata: { ...metadata } })
    },
    logEventAsync: async () => {},
  })
})

afterEach(() => {
  _resetForTesting()
})

describe('stripInvisibleUnicode — fast path', () => {
  test('pure printable ASCII is returned untouched with zero counts', () => {
    const input = 'hello world 123\n\t! ~ printable ASCII'
    const result = stripInvisibleUnicode(input)
    expect(result.text).toBe(input)
    expect(result.removedTotal).toBe(0)
    expect(result.removedByClass).toEqual({
      tags: 0,
      bidi: 0,
      zeroWidth: 0,
      selectors: 0,
      other: 0,
    })
    expect(result.keptConditional).toBe(0)
  })
})

describe('stripInvisibleUnicode — each category is stripped', () => {
  test('tags: U+E0000-block steganography payload is removed', () => {
    const payload = tag('a', 'b', 'c') + CANCEL_TAG
    const result = stripInvisibleUnicode(`a${payload}b`)
    expect(result.text).toBe('ab')
    expect(result.removedTotal).toBe(4)
    expect(result.removedByClass.tags).toBe(4)
    expect(result.removedByClass.bidi).toBe(0)
  })

  test('bidi: override and isolate control characters are removed', () => {
    // RLO (202E), LRE (202A), LRI (2066), PDI (2069)
    const result = stripInvisibleUnicode('a\u202eb\u202ac\u2066d\u2069e')
    expect(result.text).toBe('abcde')
    expect(result.removedTotal).toBe(4)
    expect(result.removedByClass.bidi).toBe(4)
  })

  test('zeroWidth: ZWSP / word-joiner / BOM are removed between Latin text', () => {
    const result = stripInvisibleUnicode('a\u200bb\u2060c\ufeffd')
    expect(result.text).toBe('abcd')
    expect(result.removedTotal).toBe(3)
    expect(result.removedByClass.zeroWidth).toBe(3)
  })

  test('selectors: variation selectors in non-kept context are removed', () => {
    // VS16 after a plain letter, VS1 after a plain letter
    const result = stripInvisibleUnicode('a\ufe0fb\ufe00c')
    expect(result.text).toBe('abc')
    expect(result.removedTotal).toBe(2)
    expect(result.removedByClass.selectors).toBe(2)
  })

  test('other: soft hyphen and CGJ are removed', () => {
    // SHY (00AD), COMBINING GRAPHEME JOINER (034F)
    const result = stripInvisibleUnicode('a­b\u034fc')
    expect(result.text).toBe('abc')
    expect(result.removedTotal).toBe(2)
    expect(result.removedByClass.other).toBe(2)
  })

  test('other: LINE SEPARATOR (U+2028) normalizes to \\n and counts as other', () => {
    const result = stripInvisibleUnicode('a\u2028b')
    expect(result.text).toBe('a\nb')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.other).toBe(1)
  })
})

describe('stripInvisibleUnicode — conditionally-kept flag sequences', () => {
  const keptFlags: Array<[string, string]> = [
    ['gbeng', 'England'],
    ['gbsct', 'Scotland'],
    ['gbwls', 'Wales'],
  ]
  for (const [letters, name] of keptFlags) {
    test(`black-flag tag sequence "${letters}" (${name}) is KEPT intact`, () => {
      const flag = BLACK_FLAG + tag(...letters.split('')) + CANCEL_TAG
      const result = stripInvisibleUnicode(`flag: ${flag}!`)
      expect(result.text).toBe(`flag: ${flag}!`)
      expect(result.removedTotal).toBe(0)
      // Official: 5 letters + cancel tag each ring-push as kept conditional
      // (bi @196053798 returns the cancel-tag index).
      expect(result.keptConditional).toBe(6)
    })
  }

  test('non-kept flag subdivision strips tags but keeps the visible black flag', () => {
    const flag = BLACK_FLAG + tag(...'usca'.split('')) + CANCEL_TAG
    const result = stripInvisibleUnicode(`x${flag}y`)
    expect(result.text).toBe(`x${BLACK_FLAG}y`)
    expect(result.removedTotal).toBe(5)
    expect(result.removedByClass.tags).toBe(5)
    expect(result.keptConditional).toBe(0)
  })
})

describe('stripInvisibleUnicode — emoji ZWJ sequences are kept', () => {
  test('family emoji (ZWJ between Extended_Pictographic) is kept', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'
    const result = stripInvisibleUnicode(`meet ${family} today`)
    expect(result.text).toBe(`meet ${family} today`)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(2)
  })

  test('ZWJ after skin-tone modifier reaches back to the emoji base', () => {
    // woman + skin tone + ZWJ + rocket
    const astronaut = '\u{1F469}\u{1F3FD}\u200d\u{1F680}'
    const result = stripInvisibleUnicode(astronaut)
    expect(result.text).toBe(astronaut)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(1)
  })

  test('lone ZWJ between Latin letters is removed (zeroWidth)', () => {
    const result = stripInvisibleUnicode('a\u200db')
    expect(result.text).toBe('ab')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.zeroWidth).toBe(1)
  })

  test('VS16 after copyright sign is kept; VS16 after a plain letter is removed', () => {
    const kept = stripInvisibleUnicode('©\ufe0f')
    expect(kept.text).toBe('©\ufe0f')
    expect(kept.removedTotal).toBe(0)
    expect(kept.keptConditional).toBe(1)

    const removed = stripInvisibleUnicode('a\ufe0fb')
    expect(removed.text).toBe('ab')
    expect(removed.removedByClass.selectors).toBe(1)
  })

  test('keycap sequence (digit + VS16 + U+20E3) keeps the VS16', () => {
    const keycap = '5\ufe0f⃣'
    const result = stripInvisibleUnicode(keycap)
    expect(result.text).toBe(keycap)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(1)
  })

  test('ZWSP between Khmer letters is kept (SEA script context)', () => {
    const input = 'ក\u200bខ'
    const result = stripInvisibleUnicode(input)
    expect(result.text).toBe(input)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(1)
  })

  test('Mongolian FVS1 after a Mongolian letter is kept', () => {
    const input = 'ᠠ\u180b'
    const result = stripInvisibleUnicode(input)
    expect(result.text).toBe(input)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(1)
  })
})

describe('stripInvisibleUnicode — RTL context gets official LRM treatment', () => {
  test('LRM at end of a Hebrew line is kept', () => {
    const input = 'אב\u200e'
    const result = stripInvisibleUnicode(input)
    expect(result.text).toBe(input)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(1)
  })

  test('RLM at end of an Arabic line is kept', () => {
    const input = 'سلام\u200f'
    const result = stripInvisibleUnicode(input)
    expect(result.text).toBe(input)
    expect(result.removedTotal).toBe(0)
    expect(result.keptConditional).toBe(1)
  })

  test('LRM in a pure-Latin line is removed (bidi)', () => {
    const result = stripInvisibleUnicode('hello\u200e')
    expect(result.text).toBe('hello')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.bidi).toBe(1)
  })

  test('LRM wedged between two Hebrew letters is removed (joins real text)', () => {
    // Official Ld guard: the mark is NOT kept when it sits between visible
    // same-script letters (it changes nothing visually and is smuggling).
    const result = stripInvisibleUnicode('א\u200eב')
    expect(result.text).toBe('אב')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.bidi).toBe(1)
  })
})

describe('stripInvisibleUnicode — newline + surrogate normalization', () => {
  test('lone CR becomes LF and counts as other', () => {
    const result = stripInvisibleUnicode('a\rb')
    expect(result.text).toBe('a\nb')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.other).toBe(1)
  })

  test('CRLF collapses to LF with removedTotal 0', () => {
    const result = stripInvisibleUnicode('a\r\nb')
    expect(result.text).toBe('a\nb')
    expect(result.removedTotal).toBe(0)
  })

  test('NEL (U+0085) becomes LF and counts as other', () => {
    const result = stripInvisibleUnicode('a\u0085b')
    expect(result.text).toBe('a\nb')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.other).toBe(1)
  })

  test('lone surrogate becomes U+FFFD and counts as other', () => {
    const result = stripInvisibleUnicode('a\uD800b')
    expect(result.text).toBe('a�b')
    expect(result.removedTotal).toBe(1)
    expect(result.removedByClass.other).toBe(1)
  })
})

describe('stripInvisibleWithMeta (official yr)', () => {
  test('unchanged text reports zeroed removed info', () => {
    const { text, removed } = stripInvisibleWithMeta('plain text')
    expect(text).toBe('plain text')
    expect(removed.removedTotal).toBe(0)
    expect(removed.textLength).toBe('plain text'.length)
  })

  test('stripped text carries per-class counts and input textLength', () => {
    const input = 'a\u202eb\u200bc'
    const { text, removed } = stripInvisibleWithMeta(input)
    expect(text).toBe('abc')
    expect(removed.removedTotal).toBe(2)
    expect(removed.removedByClass.bidi).toBe(1)
    expect(removed.removedByClass.zeroWidth).toBe(1)
    expect(removed.textLength).toBe(input.length)
  })

  test('kept-only input (flag sequence) reports removedTotal 0', () => {
    const flag = BLACK_FLAG + tag(...'gbeng'.split('')) + CANCEL_TAG
    const { text, removed } = stripInvisibleWithMeta(flag)
    expect(text).toBe(flag)
    expect(removed.removedTotal).toBe(0)
    expect(removed.keptConditional).toBe(0)
  })

  test('CRLF normalization changes text but keeps removedTotal 0', () => {
    const { text, removed } = stripInvisibleWithMeta('a\r\nb')
    expect(text).toBe('a\nb')
    expect(removed.removedTotal).toBe(0)
  })
})

describe('formatInvisibleStripNotice (official fde — byte-exact strings)', () => {
  test('review mode, singular', () => {
    expect(formatInvisibleStripNotice(1, 'review')).toBe(
      `Removed 1 invisible character ${MIDDOT} review and press Enter to send`,
    )
  })
  test('review mode, plural', () => {
    expect(formatInvisibleStripNotice(3, 'review')).toBe(
      `Removed 3 invisible characters ${MIDDOT} review and press Enter to send`,
    )
  })
  test('empty mode', () => {
    expect(formatInvisibleStripNotice(2, 'empty')).toBe(
      `Removed 2 invisible characters ${MIDDOT} nothing left to send`,
    )
  })
  test('sent mode (launch prompt)', () => {
    expect(formatInvisibleStripNotice(1, 'sent')).toBe(
      'Removed 1 invisible character from the launch prompt before sending it',
    )
  })
  test('default mode is review', () => {
    expect(formatInvisibleStripNotice(1)).toBe(formatInvisibleStripNotice(1, 'review'))
  })
  test('separator is U+00B7 MIDDLE DOT', () => {
    expect(formatInvisibleStripNotice(1, 'review').includes('·')).toBe(true)
  })
})

describe('stripInvisibleText (official Bxt) + telemetry', () => {
  test('clean text: no telemetry emitted', () => {
    const { text, removedTotal } = stripInvisibleText('hello', 'prompt')
    expect(text).toBe('hello')
    expect(removedTotal).toBe(0)
    expect(capturedEvents).toEqual([])
  })

  test('stripped text emits tengu_prompt_invisible_strip with numeric fields', () => {
    const { text, removedTotal } = stripInvisibleText('a\u200bb\u202ec', 'prompt')
    expect(text).toBe('abc')
    expect(removedTotal).toBe(2)
    expect(capturedEvents.length).toBe(1)
    expect(capturedEvents[0].name).toBe(PROMPT_INVISIBLE_STRIP_EVENT)
    expect(capturedEvents[0].metadata).toEqual({
      removed_total: 2,
      removed_tags: 0,
      removed_bidi: 1,
      removed_zero_width: 1,
      removed_selectors: 0,
      removed_other: 0,
      kept_conditional: 0,
    })
  })

  test('event name and counter constants match the official strings', () => {
    expect(PROMPT_INVISIBLE_STRIP_EVENT).toBe('tengu_prompt_invisible_strip')
    expect(INPUT_INVISIBLE_STRIP_COUNTER).toBe('input_invisible_strip')
    expect(INVISIBLE_STRIP_GATE).toBe('tengu_tranquil_cloud')
  })
})

describe('stripInvisibleForSubmit (official Bnt)', () => {
  const textEntry = (id: number, content: string): PastedContent => ({
    id,
    type: 'text',
    content,
  })

  test('clean input + clean entries: identical references, zero removed', () => {
    const entries: Record<number, PastedContent> = { 1: textEntry(1, 'clean\npaste') }
    const result = stripInvisibleForSubmit('hello [Pasted text #1]', entries)
    expect(result.input).toBe('hello [Pasted text #1]')
    expect(result.pastedContents).toBe(entries)
    expect(result.removed.removedTotal).toBe(0)
  })

  test('strips hidden characters from the input itself', () => {
    const result = stripInvisibleForSubmit('a\u202eb', {})
    expect(result.input).toBe('ab')
    expect(result.removed.removedTotal).toBe(1)
    expect(result.removed.removedByClass.bidi).toBe(1)
  })

  test('image entries are never touched', () => {
    const entries: Record<number, PastedContent> = {
      1: { id: 1, type: 'image', content: '\u200b', mediaType: 'image/png' },
    }
    const result = stripInvisibleForSubmit('[Image #1]', entries)
    expect(result.pastedContents).toBe(entries)
    expect(result.removed.removedTotal).toBe(0)
  })

  test('stripped entry content rewrites the placeholder line count', () => {
    const entries: Record<number, PastedContent> = { 1: textEntry(1, 'a\u0085b') }
    const result = stripInvisibleForSubmit('[Pasted text #1]', entries)
    // NEL -> LF raises the entry newline count 0 -> 1, so the chip is rewritten.
    expect(result.input).toBe('[Pasted text #1 +1 lines]')
    expect(result.pastedContents[1].content).toBe('a\nb')
    expect(result.removed.removedTotal).toBe(1)
    expect(result.removed.removedByClass.other).toBe(1)
    // Immutability: the caller's map and entry are untouched.
    expect(entries[1].content).toBe('a\u0085b')
    expect(result.pastedContents).not.toBe(entries)
  })

  test('truncated-text placeholder is rewritten with the new line count', () => {
    const entries: Record<number, PastedContent> = { 2: textEntry(2, 'x\u0085y') }
    const result = stripInvisibleForSubmit(
      'pre [...Truncated text #2 +3 lines...] post',
      entries,
    )
    expect(result.input).toBe('pre [...Truncated text #2 +1 lines...] post')
    expect(result.pastedContents[2].content).toBe('x\ny')
  })

  test('entry without newline-count change keeps its placeholder', () => {
    const entries: Record<number, PastedContent> = { 1: textEntry(1, 'a\u200bb') }
    const result = stripInvisibleForSubmit('[Pasted text #1 +0 lines]', entries)
    expect(result.input).toBe('[Pasted text #1 +0 lines]')
    expect(result.pastedContents[1].content).toBe('ab')
    expect(result.removed.removedTotal).toBe(1)
  })

  test('removals accumulate across input and entries (official Ha)', () => {
    const input = 'a\u200bb [Pasted text #1]'
    const entryContent = 'c\u200bd'
    const entries: Record<number, PastedContent> = { 1: textEntry(1, entryContent) }
    const result = stripInvisibleForSubmit(input, entries)
    expect(result.input).toBe('ab [Pasted text #1]')
    expect(result.pastedContents[1].content).toBe('cd')
    expect(result.removed.removedTotal).toBe(2)
    expect(result.removed.removedByClass.zeroWidth).toBe(2)
    expect(result.removed.textLength).toBe(input.length + entryContent.length)
  })
})
