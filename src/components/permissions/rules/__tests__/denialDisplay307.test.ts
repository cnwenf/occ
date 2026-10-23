import { describe, expect, test } from 'bun:test'
import type { AutoModeDenial } from '../../../../utils/autoModeDenials.js'
import {
  MAX_LABEL_UNITS,
  WITHHELD_MARKER,
  buildDenialsFooter,
  commandCutGutter,
  countCodePoints,
  denialReasonDescription,
  denialsMetaMessage,
  hiddenLinesHint,
  hiddenRowsGutter,
  previewDenialText,
  sanitizeDenialLabels,
  sanitizeDenialValue,
  shortcutParenHint,
  truncateCommand,
  truncateToWidth,
  windowWrappedText,
} from '../denialDisplay.js'

/**
 * CC 2.1.307 PORT B6 — recently-denied display builders.
 *
 * All functions ported verbatim from the official v307 linux-x64 ELF:
 *
 * - Sanitizer chunk @242775400–242784700: `CS` @242782807 (value sanitizer),
 *   withheld marker `f` @242780776 = "(value cannot be shown in full —
 *   approval withheld; one-time options only)", `ga` @242780495 (preview),
 *   `sbt`/`xze`/`mG` @242778861 (label dedup + withheld numbering), `Uh`
 *   (combining-run >8 → �, O=8), `ha`, `hpn` (pG=2000 + …), `mw`
 *   (needsGutter: \n or width>80), fit-check `I(n,t=pG){return re(n,t)===n}`.
 * - vi-chunk @239862215–239865000: `It`/`vt`/`Ir`/`Cr` predicates, `Ot`/`vi`
 *   scrubbers, `bue` tab stops (H_e=8), `jr` line budgets (Te=4096, Ar=4064,
 *   ot=1024, Dr=4*Te*Te, Nr=64*ot*ot), `xt`/`kt`/`Lr` width stabilizer,
 *   `Tr`/`At` grapheme-safe head truncation.
 * - `re` = OCC truncateToDisplayLength (chunk-e16zaw2j @238492551, export
 *   list @238498811): UTF-16 slice + lone-high-surrogate drop.
 * - UI chunk (new307 @16921200): `yd=8` (MAX_COMMAND_ROWS), command
 *   truncator `Tr(g){let i=CS(g,{maxUnits:AS});...cutChars:k9(g.slice(
 *   re(g,pG).length))}`, gutter `Gi(g)` = "… and ${g.toLocaleString
 *   ("en-US")} more ${I(g,"character")} not shown; approving grants the
 *   whole command", `k9` code-point counter @238491847.
 * - `$n` (new307 @36448041): "Permission granted for: ... You may now retry
 *   this command|these commands if you would like."
 * - `wgo` @274596849 (window: Gq=2, visible-1 rows), `s8r` @274806317
 *   (oPo=6), `Eoe` @239851415 ("… +N line(s)"), `pt` @239846016
 *   (grapheme width truncation + …), `dM` @258951597 parens variant.
 * - Footer (Ji, new307 @16921300–16927100): "   Esc will retry ${h.size}
 *   denied ${I(h.size,"call")}" / "   Esc will approve ${f.size} denied
 *   ${I(f.size,"call")}" (3 leading spaces).
 */

const FFFD = '�'

function denial(overrides: Partial<AutoModeDenial> = {}): AutoModeDenial {
  return {
    toolName: 'Bash',
    display: 'git push --force',
    reason: '',
    timestamp: 1,
    ...overrides,
  }
}

describe('CC 2.1.307 B6: withheld marker (official `f` @242780776)', () => {
  test('marker is byte-identical to the official string', () => {
    expect(WITHHELD_MARKER).toBe(
      '(value cannot be shown in full — approval withheld; one-time options only)',
    )
  })

  test('AS max-units constant is 200000', () => {
    expect(MAX_LABEL_UNITS).toBe(200000)
  })
})

describe('CC 2.1.307 B6: sanitizeDenialValue (official `CS`)', () => {
  test('plain short string passes through as full', () => {
    expect(sanitizeDenialValue('ls -la')).toEqual({
      kind: 'full',
      text: 'ls -la',
      needsGutter: false,
    })
  })

  test('tab expands to the next 8-column stop (official `bue`, H_e=8)', () => {
    // 'a' occupies column 0 → tab pads 7 spaces to column 8.
    const result = sanitizeDenialValue('a\tb')
    expect(result.kind).toBe('full')
    expect(result.kind === 'full' && result.text).toBe(`a${' '.repeat(7)}b`)
  })

  test('newline sets needsGutter (official `mw`)', () => {
    const result = sanitizeDenialValue('a\nb')
    expect(result).toEqual({ kind: 'full', text: 'a\nb', needsGutter: true })
  })

  test('width > 80 sets needsGutter (official `mw`)', () => {
    const result = sanitizeDenialValue('x'.repeat(81))
    expect(result.kind).toBe('full')
    expect(result.kind === 'full' && result.needsGutter).toBe(true)
  })

  test('control characters scrub to \\uFFFD (official `It` via `Ot`)', () => {
    const result = sanitizeDenialValue('a\x1bb')
    expect(result.kind).toBe('full')
    expect(result.kind === 'full' && result.text).toBe(`a${FFFD}b`)
  })

  test('bidi overrides scrub to \\uFFFD (official `vt`/`T`)', () => {
    const result = sanitizeDenialValue('a‪b')
    expect(result.kind === 'full' && result.text).toBe(`a${FFFD}b`)
  })

  test('variation selectors are dropped entirely (official `Ir`)', () => {
    const result = sanitizeDenialValue('a️b')
    expect(result.kind === 'full' && result.text).toBe('ab')
  })

  test('ZWJ and braille blank are exempt from replacement (official `M`)', () => {
    // p() flags U+200D (Default_Ignorable) and U+2800, but M() exempts
    // 8204-8207/1564/65024-65039/6155-6159/10240 → S = p && !M = false.
    expect(sanitizeDenialValue('a‍b').kind).toBe('full')
    expect(sanitizeDenialValue('a‍b')).toEqual({
      kind: 'full',
      text: 'a‍b',
      needsGutter: false,
    })
    expect(sanitizeDenialValue('a⠀b').kind).toBe('full')
  })

  test('9-code-point combining run withholds (official `Uh`, O=8)', () => {
    const result = sanitizeDenialValue(`a${'́'.repeat(9)}`)
    expect(result).toEqual({ kind: 'withheld', marker: WITHHELD_MARKER })
  })

  test('8-code-point combining run stays full and unchanged', () => {
    const input = `a${'́'.repeat(8)}`
    const result = sanitizeDenialValue(input)
    expect(result).toEqual({ kind: 'full', text: input, needsGutter: false })
  })

  test('pre-existing grapheme-budget marker withholds (official `O0e`)', () => {
    const result = sanitizeDenialValue('abc … [+12 graphemes] def')
    expect(result).toEqual({ kind: 'withheld', marker: WITHHELD_MARKER })
  })

  test('over the unit budget withholds; maxUnits raises the ceiling', () => {
    const long = 'x'.repeat(2001)
    expect(sanitizeDenialValue(long)).toEqual({
      kind: 'withheld',
      marker: WITHHELD_MARKER,
    })
    const raised = sanitizeDenialValue(long, MAX_LABEL_UNITS)
    expect(raised.kind).toBe('full')
    expect(raised.kind === 'full' && raised.text).toBe(long)
  })
})

describe('CC 2.1.307 B6: previewDenialText (official `ga` = y(Ud(hpn(n))))', () => {
  test('short text is unchanged, no gutter', () => {
    expect(previewDenialText('rm -rf /')).toEqual({
      text: 'rm -rf /',
      needsGutter: false,
    })
  })

  test('tab becomes a single space (hpn replaces before the scrubber)', () => {
    expect(previewDenialText('a\tb').text).toBe('a b')
  })

  test('over 2000 units truncates + \\u2026 (official `hpn`, pG=2000)', () => {
    const preview = previewDenialText('x'.repeat(2500))
    expect(preview.text).toBe(`${'x'.repeat(2000)}…`)
    expect(preview.needsGutter).toBe(true)
  })

  test('newline sets needsGutter', () => {
    expect(previewDenialText('a\nb').needsGutter).toBe(true)
  })
})

describe('CC 2.1.307 B6: truncateCommand (official UI-chunk `Tr`)', () => {
  test('sanitizable command → sanitized text, cutChars 0', () => {
    expect(truncateCommand('rm -rf build')).toEqual({
      text: 'rm -rf build',
      needsGutter: false,
      cutChars: 0,
    })
  })

  test('withheld short command → preview text, cutChars 0', () => {
    // Combining-run >8 withholds CS; command ≤2000 units → cutChars 0; text
    // is the `ga` preview: 8 marks kept, 9th collapses to �.
    const command = `a${'́'.repeat(9)}`
    const result = truncateCommand(command)
    expect(result.cutChars).toBe(0)
    expect(result.text).toBe(`a${'́'.repeat(8)}${FFFD}`)
    expect(result.needsGutter).toBe(false)
  })

  test('withheld long command → preview + code-point cutChars (official `k9`)', () => {
    // 2509 UTF-16 units, withheld (combining run); head = re(g,2000) →
    // cutChars = code points in g.slice(2000) = 509.
    const command = `${'́'.repeat(9)}${'a'.repeat(2500)}`
    const result = truncateCommand(command)
    expect(result.cutChars).toBe(509)
    expect(result.text).toBe(
      `${'́'.repeat(8)}${FFFD}${'a'.repeat(1991)}…`,
    )
    expect(result.needsGutter).toBe(true)
  })

  test('long sanitizable command → full text, cutChars 0 (AS=200000 ceiling)', () => {
    const command = 'x'.repeat(2001)
    const result = truncateCommand(command)
    expect(result.cutChars).toBe(0)
    expect(result.text).toBe(command)
  })
})

describe('CC 2.1.307 B6: commandCutGutter (official `Gi`)', () => {
  test('singular', () => {
    expect(commandCutGutter(1)).toBe(
      '… and 1 more character not shown; approving grants the whole command',
    )
  })

  test('plural with en-US thousands separators', () => {
    expect(commandCutGutter(1234)).toBe(
      '… and 1,234 more characters not shown; approving grants the whole command',
    )
  })
})

describe('CC 2.1.307 B6: countCodePoints (official `k9`)', () => {
  test('counts astral pairs as one', () => {
    expect(countCodePoints('a😀b')).toBe(3)
    expect(countCodePoints('')).toBe(0)
    expect(countCodePoints('abc')).toBe(3)
  })
})

describe('CC 2.1.307 B6: sanitizeDenialLabels (official `sbt`/`xze`)', () => {
  test('identical labels stay plain (Set dedup → no disambiguation)', () => {
    expect(sanitizeDenialLabels(['ls', 'ls'], MAX_LABEL_UNITS)).toEqual([
      { text: 'ls', withheld: false },
      { text: 'ls', withheld: false },
    ])
  })

  test('NFC-colliding labels become JSON-escaped forms', () => {
    // 'a'+U+0301 and U+00E1 collapse to the same NFC key → xze escapes via
    // JSON.stringify + -￿ → \uXXXX (byte-verbatim official `o`).
    const labels = sanitizeDenialLabels(
      ['á', 'á'],
      MAX_LABEL_UNITS,
    )
    expect(labels[0]?.text).toBe('"a\\u0301"')
    expect(labels[1]?.text).toBe('"\\u00e1"')
    expect(labels.every(l => !l.withheld)).toBe(true)
  })

  test('withheld labels get sequential (#N) suffixes, withheld: true', () => {
    const labels = sanitizeDenialLabels(
      ['ok', `a${'́'.repeat(9)}`, '́'.repeat(9)],
      MAX_LABEL_UNITS,
    )
    expect(labels[0]).toEqual({ text: 'ok', withheld: false })
    expect(labels[1]).toEqual({
      text: `${WITHHELD_MARKER} (#1)`,
      withheld: true,
    })
    expect(labels[2]).toEqual({
      text: `${WITHHELD_MARKER} (#2)`,
      withheld: true,
    })
  })

  test('same-NFC-key + same escaped form → (#2) suffix on the second', () => {
    // Two distinct strings sharing an NFC key AND an escaped form (they
    // differ only past unit 2000, where `o` cuts + appends …).
    const base = 'x'.repeat(2000)
    const labels = sanitizeDenialLabels(
      [`${base} a`, `${base}  a`],
      MAX_LABEL_UNITS,
    )
    const escaped = `"${base}"…`
    expect(labels[0]?.text).toBe(escaped)
    expect(labels[1]?.text).toBe(`${escaped} (#2)`)
  })
})

describe('CC 2.1.307 B6: denialsMetaMessage (official `$n` @new307 36448041)', () => {
  test('display-only denials use their row label', () => {
    const all = [denial({ display: 'git push --force' }), denial({ display: 'npm install' })]
    expect(denialsMetaMessage([all[0] as AutoModeDenial], all)).toBe(
      'Permission granted for: git push --force. You may now retry this command if you would like.',
    )
  })

  test('label lookup indexes into the FULL denials list', () => {
    const all = [denial({ display: 'first' }), denial({ display: 'second' })]
    expect(denialsMetaMessage([all[1] as AutoModeDenial], all)).toBe(
      'Permission granted for: second. You may now retry this command if you would like.',
    )
  })

  test('command-bearing denials name the sanitized command', () => {
    const d = denial({ display: 'Push to remote', command: 'git push origin main' })
    expect(denialsMetaMessage([d], [d])).toBe(
      'Permission granted for: git push origin main. You may now retry this command if you would like.',
    )
  })

  test('truncated commands (cutChars>0) are named IN FULL', () => {
    const command = `${'́'.repeat(9)}${'a'.repeat(2500)}`
    const d = denial({ display: 'long one', command })
    expect(denialsMetaMessage([d], [d])).toBe(
      `Permission granted for: ${command}. You may now retry this command if you would like.`,
    )
  })

  test('multiple grants join with ", " and pluralize the retry sentence', () => {
    const a = denial({ display: 'ls', command: 'ls -la' })
    const b = denial({ display: 'pwd', command: 'pwd' })
    expect(denialsMetaMessage([a, b], [a, b])).toBe(
      'Permission granted for: ls -la, pwd. You may now retry these commands if you would like.',
    )
  })
})

describe('CC 2.1.307 B6: buildDenialsFooter (official Ji `Z`)', () => {
  test('retry wins over approve, 3 leading spaces, plural calls', () => {
    expect(buildDenialsFooter(2, 3)).toBe('   Esc will retry 2 denied calls')
  })

  test('approve-only, singular call', () => {
    expect(buildDenialsFooter(0, 1)).toBe('   Esc will approve 1 denied call')
  })

  test('retry-only singular', () => {
    expect(buildDenialsFooter(1, 0)).toBe('   Esc will retry 1 denied call')
  })

  test('nothing selected → empty footer', () => {
    expect(buildDenialsFooter(0, 0)).toBe('')
  })
})

describe('CC 2.1.307 B6: windowWrappedText (official `wgo` @274596849)', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`)
  const text = lines.join('\n')

  test('content within maxRows passes through untouched', () => {
    const short = 'a\nb\nc'
    expect(windowWrappedText(short, 40, 8)).toEqual({
      text: short,
      hiddenRows: 0,
      hiddenAbove: 0,
      nextStart: 0,
    })
  })

  test('overflow shows maxRows-1 lines from start, counts hidden below', () => {
    const w = windowWrappedText(text, 40, 8, 0)
    expect(w.text).toBe(lines.slice(0, 7).join('\n'))
    expect(w.hiddenRows).toBe(13)
    expect(w.hiddenAbove).toBe(0)
    expect(w.nextStart).toBe(7)
  })

  test('window at the end hides above, nextStart wraps to 0', () => {
    const w = windowWrappedText(text, 40, 8, 13)
    expect(w.text).toBe(lines.slice(13).join('\n'))
    expect(w.hiddenRows).toBe(0)
    expect(w.hiddenAbove).toBe(13)
    expect(w.nextStart).toBe(0)
  })

  test('start clamps to lines.length - visible', () => {
    const w = windowWrappedText(text, 40, 8, 999)
    expect(w.hiddenAbove).toBe(13)
  })

  test('maxRows floors at 2 visible rows (official Gq=2)', () => {
    const w = windowWrappedText(text, 40, 1, 0)
    expect(w.text).toBe('L1')
    expect(w.hiddenRows).toBe(19)
  })
})

describe('CC 2.1.307 B6: hiddenLinesHint (official `Eoe`)', () => {
  test('zero → empty, singular, plural', () => {
    expect(hiddenLinesHint(0)).toBe('')
    expect(hiddenLinesHint(1)).toBe('… +1 line')
    expect(hiddenLinesHint(5)).toBe('… +5 lines')
  })
})

describe('CC 2.1.307 B6: truncateToWidth (official `pt` @239846016)', () => {
  test('fits → unchanged', () => {
    expect(truncateToWidth('ab', 5)).toBe('ab')
  })

  test('truncates on grapheme boundaries + ellipsis', () => {
    expect(truncateToWidth('abcdef', 3)).toBe('ab…')
  })

  test('maxWidth 1 → bare ellipsis', () => {
    expect(truncateToWidth('abcdef', 1)).toBe('…')
  })

  test('respects double-width characters', () => {
    expect(truncateToWidth('日本語', 4)).toBe('日…')
  })
})

describe('CC 2.1.307 B6: hiddenRowsGutter (official `s8r` @274806317)', () => {
  test('hidden below only', () => {
    expect(
      hiddenRowsGutter({ hiddenRows: 3, hiddenAbove: 0, hint: '', columns: 80 }),
    ).toBe('… +3 lines')
  })

  test('hidden above only → first fitting variant', () => {
    expect(
      hiddenRowsGutter({ hiddenRows: 0, hiddenAbove: 4, hint: '', columns: 80 }),
    ).toBe('… +4 lines above')
  })

  test('hidden both directions', () => {
    expect(
      hiddenRowsGutter({ hiddenRows: 2, hiddenAbove: 3, hint: '', columns: 80 }),
    ).toBe('… +2 lines, +3 above')
  })

  test('narrow columns fall back to the truncated last variant', () => {
    // No variant fits 3 columns → pt('↑3 ↓2', 3) = '↑3…'.
    expect(
      hiddenRowsGutter({ hiddenRows: 2, hiddenAbove: 3, hint: '', columns: 3 }),
    ).toBe('↑3…')
  })

  test('hint appended when at least 6 columns remain (official oPo=6)', () => {
    expect(
      hiddenRowsGutter({
        hiddenRows: 3,
        hiddenAbove: 0,
        hint: '(ctrl+o to see more)',
        columns: 80,
      }),
    ).toBe('… +3 lines (ctrl+o to see more)')
  })

  test('empty hint never appended', () => {
    // Width-8 columns: '… +3 lines' (width 10) doesn't fit → pt truncates it
    // even with an empty hint (official `be` fallback), then Te<oPo → return.
    expect(
      hiddenRowsGutter({ hiddenRows: 3, hiddenAbove: 0, hint: '', columns: 8 }),
    ).toBe('… +3 li…')
  })
})

describe('CC 2.1.307 B6: shortcutParenHint (official `dM` parens variant)', () => {
  test('formats "(chord to action)"', () => {
    expect(shortcutParenHint('ctrl+o', 'see more')).toBe(
      '(ctrl+o to see more)',
    )
  })
})

describe('CC 2.1.307 B6: denialReasonDescription (official `nt` @16924183)', () => {
  test('empty reason \u2192 undefined (no description rendered)', () => {
    expect(denialReasonDescription('')).toBeUndefined()
  })

  test('collapses line breaks to \uFFFD and whitespace runs to single spaces', () => {
    // Official `nt`: `N.reason?ha(ga(N.reason).text).replace(/\\s+/g," ")
    // .trim():void 0`. ga (previewDenialText) scrubs \\r as a control char
    // \u2192 \uFFFD and tabs \u2192 space; ha (collapseLineBreaks) turns \\n
    // \u2192 \uFFFD; then whitespace runs collapse.
    expect(denialReasonDescription('looks\nlike\r\na wipe')).toBe(
      `looks${FFFD}like${FFFD}${FFFD}a wipe`,
    )
    expect(denialReasonDescription('many   spaces\tand\n\nbreaks')).toBe(
      `many spaces and${FFFD}${FFFD}breaks`,
    )
  })

  test('plain single-line reason passes through trimmed', () => {
    expect(denialReasonDescription('  dangerous rm pattern  ')).toBe(
      'dangerous rm pattern',
    )
  })
})
