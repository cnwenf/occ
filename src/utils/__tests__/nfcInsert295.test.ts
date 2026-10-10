import { describe, expect, test } from 'bun:test'
import { nfcInsert, nfcSplice } from '../nfcInsert.js'

/**
 * CC 2.1.295 — NFC-aware insertion (official `insertText` @236618722 +
 * `jF` NFC-splice @236615963).
 *
 * Official references (v295 linux-x64 ELF):
 *   insertText: if(h==="")return #w(L,H),H;
 *               let Z=L.normalize("NFC"),he=H<L.length?H:Z.length,
 *                   {written:Se,end:Me}=jF(Z.slice(0,he),h,Z.slice(he));
 *               return #w(Se,Me),he
 *   jF: H=A.normalize("NFC"); Z=(h+A).normalize("NFC"); he=(Z+L).normalize("NFC");
 *       Se=Z.length;
 *       if(Se!==h.length+H.length)
 *         for(let{index:Me,segment:De}of na().segment(he)){
 *           if(Me>=Se)break;
 *           let Oe=Me+De.length;
 *           if(Oe>Se&&!VIt(he,Se,Oe))Se=Oe}
 *       return{written:he,end:Se}
 *
 * Bug fixed: pasting macOS NFD text (decomposed é) mid-prompt
 * concatenated raw UTF-16 and set the cursor to `offset + text.length`;
 * downstream NFC normalization then shrank the string under the cursor,
 * landing it one char too far.
 *
 * All test data uses explicit \u escapes — never literal combining marks —
 * so the file's own encoding cannot silently change the fixtures.
 *
 * Note: the official `VIt`/`gNo` placeholder-chip guard is ported faithfully,
 * but under Intl.Segmenter grapheme rules a `[` can only START a cluster, so
 * the guard's straddle branch is practically unreachable; the reachable
 * length-adjustment branch is covered by the straddling-cluster cases below.
 */

const E_ACUTE_NFC = '\u00e9' // NFC é
const COMBINING_ACUTE = '\u0301' // combining acute accent
const COMBINING_TILDE = '\u0303' // combining tilde

describe('nfcSplice — official jF (2.1.295)', () => {
  test('ASCII splice with no composition keeps the naive end', () => {
    expect(nfcSplice('a', 'b', 'c')).toEqual({ written: 'abc', end: 2 })
  })

  test('composition across the seam keeps end at the composed head length', () => {
    // head = ('e' + '́x').NFC = 'éx' (len 2); prefix 1 + insertedNFC 2 = 3
    // ≠ 2 → adjustment loop runs; no cluster straddles end → end stays 2.
    const { written, end } = nfcSplice('e', `${COMBINING_ACUTE}x`, 'y')
    expect(written).toBe(`${E_ACUTE_NFC}xy`)
    expect(end).toBe(2)
  })

  test('straddling grapheme cluster advances end to the cluster boundary', () => {
    // head = ('e' + '́̃x').NFC = 'é̃x' (len 3);
    // prefix 1 + insertedNFC 3 = 4 ≠ 3 → loop. written = 'é̃x̃y' (len 5).
    // The cluster 'x̃' spans [2,4) and straddles end=3 → end = 4.
    const { written, end } = nfcSplice(
      'e',
      `${COMBINING_ACUTE}${COMBINING_TILDE}x`,
      `${COMBINING_TILDE}y`,
    )
    expect(written).toBe(`${E_ACUTE_NFC}${COMBINING_TILDE}x${COMBINING_TILDE}y`)
    expect(written.length).toBe(5)
    expect(end).toBe(4)
  })
})

describe('nfcInsert — official insertText (2.1.295)', () => {
  test('empty insert is the identity (written=value, end=cursorOffset)', () => {
    expect(nfcInsert('ab', 1, '')).toEqual({ written: 'ab', end: 1 })
  })

  test('NFD é pasted mid-prompt: cursor lands on the NFC-based offset', () => {
    // The 295 bug: raw concat gives cursor 1+2=3; the official NFC splice
    // composes 'e'+U+0301 across the seam → written 'aéb' (len 3), end=2.
    const { written, end } = nfcInsert('ab', 1, `e${COMBINING_ACUTE}`)
    expect(written).toBe(`a${E_ACUTE_NFC}b`)
    expect(written.length).toBe(3)
    expect(end).toBe(2)
  })

  test('cursor past end-of-value splits at the normalized length', () => {
    // value 'aéb' (NFD, len 4) → Z = 'aéb' (NFC, len 3); H=99 ≥ 4 → he = 3.
    const { written, end } = nfcInsert(`ae${COMBINING_ACUTE}b`, 99, 'x')
    expect(written).toBe(`a${E_ACUTE_NFC}bx`)
    expect(end).toBe(4)
  })

  test('cursor at end-of-value splits at the normalized length', () => {
    const { written, end } = nfcInsert(`${E_ACUTE_NFC}x`, 3, 'y')
    expect(written).toBe(`${E_ACUTE_NFC}xy`)
    expect(end).toBe(3)
  })

  test('mid-value insert keeps a normalized prefix and adjusts the cursor', () => {
    // Z = 'éx' (len 2); he = 1 < 2 → split at 1: jF('é','y','x') →
    // head 'éy' (2) = prefix 1 + 'y' 1 → naive end 2 holds.
    const { written, end } = nfcInsert(`${E_ACUTE_NFC}x`, 1, 'y')
    expect(written).toBe(`${E_ACUTE_NFC}yx`)
    expect(end).toBe(2)
  })

  test('combining-mark insert that composes with the prefix char', () => {
    // jF('ae','́x','b'): head = ('ae'+U+0301+'x').NFC = 'aéx' (len 3);
    // 2 + 2 = 4 ≠ 3 → loop; written 'aéxb' (len 4); no straddling cluster
    // → end stays 3 (right after the composed 'é').
    const { written, end } = nfcInsert('aeb', 2, `${COMBINING_ACUTE}x`)
    expect(written).toBe(`a${E_ACUTE_NFC}xb`)
    expect(end).toBe(3)
  })
})
