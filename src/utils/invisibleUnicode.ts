// CC 2.1.277 (D2 SECURITY): invisible-Unicode prompt classifier + strip.
//
// Byte-faithful port of the official Claude Code 2.1.277/2.1.278 linux-x64
// binary classifier (all regexes/constants/logic recovered verbatim from the
// ELF; minified symbol → readable name map below, with ELF offsets):
//
//   Ed  @196052928  PRINTABLE_ASCII_GAP_RE   fast path: pure printable ASCII → no-op
//   gi  @196052955  LETTER_RE                /^\p{L}$/u
//   bn  @196052978  MARK_RE                  /^\p{M}$/u
//   Rd  @196053000  EMOJI_RE                 /^[\p{Emoji}\p{Extended_Pictographic}]$/u
//   Vo  @196053049  EXTENDED_PICTOGRAPHIC_RE /^\p{Extended_Pictographic}$/u
//   kd  @196053090  MATH_SYMBOL_RE           /^\p{Sm}$/u
//   Wo  @196053114  buildScriptClass         "^[\p{Script=X}...]$" builder
//   ta  @196053225  makeScriptPair           {base: Script=, mark: Script_Extensions=}
//   Un  @196053306  asScriptPair             {base: re, mark: re}
//   na  @196053364  RTL_SCRIPTS_RE           Arabic/Hebrew/Syriac/Thaana/Nko/...
//   Td  @196053594  ALM_RTL_SCRIPTS_RE       Arabic/Syriac/Thaana/Hanifi_Rohingya
//   Go  @196053687  DIGIT_RE                 /^\p{Nd}$/u
//   Cd  @196053711  ZWNJ_JOINABLE_SCRIPTS    (ZWJ 8205 context, ta(...) list #1)
//   Pd  @196053853  ZWJ_FALLBACK_SCRIPTS     (ZWNJ 8204 context, ta(...) list #2)
//   ra  @196052850  SEA_SCRIPT_RE            Khmer/Thai/Lao/Myanmar
//   Fd  @196052928  SEA_SCRIPTS              Un(ra)
//   Yo  @196052951  ASCII_DIGIT_RE           /^[0-9]$/
//   Ko  @196052972  MONGOLIAN                Un(/^\p{Script=Mongolian}$/u)
//   $d  @196053010  KHMER                    Un(/^\p{Script=Khmer}$/u)
//   fi  @196053044  EGYPTIAN_HIEROGLYPHS     Un(/^\p{Script=Egyptian_Hieroglyphs}$/u)
//   qo  @196053102  DUPLOYAN                 Un(/^\p{Script=Duployan}$/u)
//   Jo  @196053144  BRAHMI_RE                /^\p{Script=Brahmi}$/u
//   Nd  @196053172  MYANMAR_LIKE_RE          Myanmar/Phags_Pa/Manichaean
//   jn  @196053341  isHiddenCodePoint
//   Md  @196053769  KEPT_FLAG_SUBDIVISIONS   ["gbeng","gbsct","gbwls"]
//   ia  @196053792  FLAG_LETTER_COUNT        5
//   bi  @196053798  decodeKeptFlagSequence   🏴 tag-sequence decoder
//   m4r @196054012  stripInvisibleUnicode    classifier core
//   Je/yi/Zo/Qo/Ld/mi/_n/In/yn/pi/Dn/sa/Bn/hi/ea/Id/Dd/Bd — ring + predicate helpers
//   Od/Pe/Le @191973481 toWellFormed lone-surrogate replacement (→ U+FFFD)
//   yr  @207937926  stripInvisibleWithMeta   gate + removed-info wrapper
//   Ga  @207938113  gate: P("tengu_tranquil_cloud", !0)  — default TRUE
//   Bxt @207936185  stripInvisibleText       plain-text strip (launch/queued prompts)
//   Bnt @207936294  stripInvisibleForSubmit  submit-time strip incl. pastedContents
//   fde @207937121  formatInvisibleStripNotice
//   FWe @207937426  logInvisibleStripEvent   tengu_prompt_invisible_strip telemetry
//   Ha  @207937858  accumulateRemoved
//   CCe @198110900  PLACEHOLDER_KINDS        Pasted text|Image|Audio|\.\.\.Truncated text
//   aUn @198117040  placeholder regex        \[(${CCe}) #(\d+)(?: \+\d+ lines)?(\.)*\]
//   nu  @198117155  findPlaceholderRefs
//   BL  @198116888  countNewlines (OCC: getPastedTextRefNumLines, byte-identical)
//   a4  @198116945  format pasted ref (OCC: formatPastedTextRef, byte-identical)
//
// CC 2.1.280 additions (v280 ELF offsets; byte-verified against v278, which
// has NONE of these — its 8204/8205 block @196083420 ends at `break}` right
// after the emoji-ZWJ branch):
//   Gc  @196840682  WHITESPACE_RE            /^\p{White_Space}$/u
//   Xc  @196841593  ZWJ_NEXT_SCRIPTS         Ur("Arabic Syriac Mongolian Nko")
//   Sn  @196846079  nextVisibleInScript      ≡ v278 `hi`, semantics unchanged:
//                   `Sn(e,n){return e!==void 0&&!En(e)&&Vr(n.base,e)}`, with
//                   `Vr(e,n){return Ce(Wn,n)&&Ce(e,n)}` @196844901 ≡ letter-in-
//                   script check and `Ce`=testCodePoint.
//   new 8204/8205 clause @196843700:
//     `if(!j&&D!==void 0&&!O)j=N===8204?Sn(L,Xs)&&!Ce(Gc,D)&&!Ce(Pt,D)
//       :Sn(L,Xc)&&!Ce(Wn,D)&&!Ce(Br,D)&&!Ce(Pt,D)`
//   (j=keep, D=prevCode, O=lastWasHidden, N=code, L=nextCode, Xs=
//   ZWNJ_CONTEXT_SCRIPTS, Gc=WHITESPACE_RE, Wn=LETTER_RE, Br=DIGIT_RE,
//   Pt=MARK_RE.) ZWNJ is kept when the NEXT visible char is a letter of the
//   ZWNJ context scripts and prev is not White_Space/Mark; ZWJ is kept when
//   the NEXT visible char is an Arabic/Syriac/Mongolian/Nko letter and prev is
//   not Letter/Nd-digit/Mark. Matches changelog 2.1.280 line: "Fixed the
//   invisible-character cleanup removing the zero-width non-joiner that
//   Persian and Arabic text uses to attach a suffix to a Latin word or
//   number, such as the plural of 'PDF'".
//
// Official submit-path contract (aIo @218498875): when removedTotal > 0 the
// cleaned text replaces the input (review state), a feedback notification
// `prompt-invisible-removed` shows `fde(removedTotal, empty?"empty":"review")`
// with priority "immediate" and timeoutMs 5000 (zT @218348618), telemetry is
// emitted with surface "prompt", and the submit is aborted — the user reviews
// the cleaned prompt and presses Enter again to send it.

import { formatPastedTextRef, getPastedTextRefNumLines } from '../history.js'
import { logEvent } from '../services/analytics/index.js'
import type { PastedContent } from './config.js'

// ---------------------------------------------------------------------------
// Classifier regexes (byte-verbatim from the official binary)
// ---------------------------------------------------------------------------

/** Official `Ed` — fast path: any char outside \t \n and printable ASCII. */
const PRINTABLE_ASCII_GAP_RE = /[^\t\n\x20-\x7e]/

const LETTER_RE = /^\p{L}$/u
const MARK_RE = /^\p{M}$/u
/** Official v280 `Gc` @196840682 — new in 2.1.280 (absent from v278). */
const WHITESPACE_RE = /^\p{White_Space}$/u
const EMOJI_RE = /^[\p{Emoji}\p{Extended_Pictographic}]$/u
const EXTENDED_PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u
const MATH_SYMBOL_RE = /^\p{Sm}$/u
const DIGIT_RE = /^\p{Nd}$/u
const ASCII_DIGIT_RE = /^[0-9]$/
const BRAHMI_RE = /^\p{Script=Brahmi}$/u
const MYANMAR_LIKE_RE = /^[\p{Script=Myanmar}\p{Script=Phags_Pa}\p{Script=Manichaean}]$/u
const SEA_SCRIPT_RE = /^[\p{Script=Khmer}\p{Script=Thai}\p{Script=Lao}\p{Script=Myanmar}]$/u

/** Official RTL script set (`na`) used for the LRM/RLM kept-conditional scan. */
const RTL_SCRIPTS_RE =
  /^[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]$/u

/** Official ALM (U+061C) RTL script subset (`Td`). */
const ALM_RTL_SCRIPTS_RE =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Hanifi_Rohingya}]$/u

type ScriptPair = { base: RegExp; mark: RegExp }

/** Official `Wo` — build a `^[\p{Kind=X}\p{Kind=Y}...]$` class from names. */
function buildScriptClass(kind: string, names: string): RegExp {
  const parts = names.split(' ').map((name) => `\\p{${kind}=${name}}`).join('')
  return new RegExp(`^[${parts}]$`, 'u')
}

/** Official `ta` — {base: Script=, mark: Script_Extensions=} pair. */
function makeScriptPair(names: string): ScriptPair {
  return {
    base: buildScriptClass('Script', names),
    mark: buildScriptClass('Script_Extensions', names),
  }
}

/** Official `Un` — same regex for base and mark. */
function asScriptPair(regex: RegExp): ScriptPair {
  return { base: regex, mark: regex }
}

/** Official `Cd` — scripts where ZWNJ (8204) is contextually legitimate. */
const ZWNJ_CONTEXT_SCRIPTS = makeScriptPair(
  'Arabic Syriac Nko Mongolian Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan',
)

/** Official `Pd` — scripts where ZWJ (8205) is contextually legitimate. */
const ZWJ_CONTEXT_SCRIPTS = makeScriptPair(
  'Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan Arabic Syriac Tifinagh',
)

/**
 * Official v280 `Xc` @196841593 — `Ur("Arabic Syriac Mongolian Nko")`, new in
 * 2.1.280 (absent from v278). Scripts whose letter AFTER a ZWJ (8205) keeps
 * the joiner when the preceding char is not a letter/digit/mark.
 */
const ZWJ_NEXT_SCRIPTS = makeScriptPair('Arabic Syriac Mongolian Nko')

const SEA_SCRIPTS = asScriptPair(SEA_SCRIPT_RE)
const MONGOLIAN = asScriptPair(/^\p{Script=Mongolian}$/u)
const KHMER = asScriptPair(/^\p{Script=Khmer}$/u)
const EGYPTIAN_HIEROGLYPHS = asScriptPair(/^\p{Script=Egyptian_Hieroglyphs}$/u)
const DUPLOYAN = asScriptPair(/^\p{Script=Duployan}$/u)

// ---------------------------------------------------------------------------
// Lone-surrogate normalization (official `Od`/`Pe`/`Le` @191973481)
// ---------------------------------------------------------------------------

/** Official `Pe` — unpaired UTF-16 surrogates. */
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

const toWellFormed: ((text: string) => string) | undefined =
  typeof String.prototype.toWellFormed === 'function'
    ? Function.prototype.call.bind(String.prototype.toWellFormed)
    : undefined

/** Official `Od` — lone surrogates become U+FFFD (toWellFormed semantics). */
function toWellFormedString(text: string): string {
  if (toWellFormed) return toWellFormed(text)
  return text.replace(LONE_SURROGATE_RE, '�')
}

/** Official `Dd` — count lone surrogates in a string. */
function countLoneSurrogates(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 55296 && code <= 56319) {
      const next = text.charCodeAt(i + 1)
      if (next >= 56320 && next <= 57343) i++
      else count++
    } else if (code >= 56320 && code <= 57343) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Hidden-code-point predicate (official `jn` @196053341, byte-verbatim ranges)
// ---------------------------------------------------------------------------

/** Official `jn` — is this code point an invisible formatting/tag character? */
function isHiddenCodePoint(code: number): boolean {
  if (code < 160) return (code < 32 && code !== 9 && code !== 10) || code >= 127
  if (code < 8192) {
    return (
      code === 173 ||
      code === 847 ||
      code === 1564 ||
      code === 4447 ||
      code === 4448 ||
      code === 6068 ||
      code === 6069 ||
      (code >= 6155 && code <= 6159)
    )
  }
  if (code < 65536) {
    return (
      (code >= 8203 && code <= 8207) ||
      (code >= 8232 && code <= 8238) ||
      (code >= 8288 && code <= 8303) ||
      code === 12644 ||
      (code >= 65024 && code <= 65039) ||
      code === 65279 ||
      code === 65440 ||
      (code >= 65520 && code <= 65531)
    )
  }
  return (
    code === 69759 ||
    (code >= 78896 && code <= 78911) ||
    code === 94180 ||
    (code >= 113824 && code <= 113827) ||
    (code >= 119155 && code <= 119162) ||
    (code >= 917504 && code <= 921599)
  )
}

/** Official `Bd` — which removed-count bucket a hidden code point lands in. */
function classifyHiddenCodePoint(
  code: number,
): 'tags' | 'bidi' | 'zeroWidth' | 'selectors' | 'other' {
  if (code >= 917504 && code <= 917631) return 'tags'
  if (
    code === 1564 ||
    code === 8206 ||
    code === 8207 ||
    (code >= 8234 && code <= 8238) ||
    (code >= 8294 && code <= 8297)
  ) {
    return 'bidi'
  }
  if (
    (code >= 8203 && code <= 8205) ||
    code === 8288 ||
    code === 65279
  ) {
    return 'zeroWidth'
  }
  if (
    (code >= 65024 && code <= 65039) ||
    (code >= 917760 && code <= 917999) ||
    (code >= 6155 && code <= 6157) ||
    code === 6159
  ) {
    return 'selectors'
  }
  return 'other'
}

/** Official `mi` — line-break code points (CR/LF/VT/FF/NEL/LS/PS). */
function isLineBreakCodePoint(code: number | undefined): boolean {
  return (
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 133 ||
    code === 8232 ||
    code === 8233
  )
}

// ---------------------------------------------------------------------------
// Kept-flag-sequence decoder (official `Md`/`ia`/`bi` @196053769)
// ---------------------------------------------------------------------------

/** Official `Md` — the only tag sequences kept: England/Scotland/Wales flags. */
const KEPT_FLAG_SUBDIVISIONS = ['gbeng', 'gbsct', 'gbwls']

/** Official `ia` — letters in a kept subdivision tag sequence. */
const FLAG_LETTER_COUNT = 5

/**
 * Official `bi` — 🏴 (U+1F3F4) tag-sequence decoder. `chars` is an array of
 * code-point strings starting at the 🏴; scans up to FLAG_LETTER_COUNT+1 tag
 * characters (917601..917626 → 'a'..'z') terminated by the cancel tag
 * (917631). Returns the end index when the sequence spells a KEPT
 * subdivision (gbeng/gbsct/gbwls), otherwise -1.
 */
function decodeKeptFlagSequence(chars: string[], start: number): number {
  let letters = ''
  const end = start + FLAG_LETTER_COUNT + 1
  for (let i = start + 1; i <= end && i < chars.length; i++) {
    const code = chars[i].codePointAt(0) ?? 0
    if (code === 917631) return KEPT_FLAG_SUBDIVISIONS.includes(letters) ? i : -1
    if (code < 917601 || code > 917626) return -1
    letters += String.fromCharCode(code - 917504)
  }
  return -1
}

// ---------------------------------------------------------------------------
// Context ring (official `_n`/`In`/`yn`/`pi`/`Dn`/`sa`/`Bn`/`hi` helpers)
// ---------------------------------------------------------------------------

/** Official `_n` — context ring capacity. */
const CONTEXT_RING_SIZE = 16

type ContextRing = {
  ring: number[]
  next: number
  size: number
  lastWasHidden: boolean
  keptConditional: number
}

/** Official `In` — push a code point onto the ring. */
function ringPush(state: ContextRing, code: number, hidden: boolean): void {
  state.ring[state.next] = code
  state.next = (state.next + 1) % CONTEXT_RING_SIZE
  if (state.size < CONTEXT_RING_SIZE) state.size++
  state.lastWasHidden = hidden
  if (hidden) state.keptConditional++
}

/** Official `yn` — nth-most-recent code point (0 = last). */
function ringGet(state: ContextRing, back: number): number | undefined {
  if (back >= state.size) return undefined
  return state.ring[
    (state.next - 1 - back + 2 * CONTEXT_RING_SIZE) % CONTEXT_RING_SIZE
  ]
}

/** Official `Je` — regex-test a code point. */
function testCodePoint(regex: RegExp, code: number | undefined): boolean {
  return code !== undefined && regex.test(String.fromCodePoint(code))
}

/** Official `yi` — code point is a letter AND in the given script class. */
function isLetterInScript(regex: RegExp, code: number | undefined): boolean {
  return testCodePoint(LETTER_RE, code) && testCodePoint(regex, code)
}

/** Official `pi` — last visible char matches the regex (ring non-empty). */
function prevVisibleMatches(state: ContextRing, regex: RegExp): boolean {
  return (
    state.size > 0 && !state.lastWasHidden && testCodePoint(regex, ringGet(state, 0))
  )
}

/**
 * Official `sa` — scan the ring backwards over combining marks: every mark
 * must belong to the script's Script_Extensions; the first non-mark decides
 * via base (`allowPlainScriptOnly=false` → letter+script via `yi`; true →
 * script class alone).
 */
function scanRingForScript(
  state: ContextRing,
  pair: ScriptPair,
  baseOnly: boolean,
): boolean {
  if (state.lastWasHidden) return false
  for (let i = 0; i < state.size; i++) {
    const code = ringGet(state, i) as number
    if (testCodePoint(MARK_RE, code)) {
      if (!testCodePoint(pair.mark, code)) return false
      continue
    }
    return baseOnly
      ? testCodePoint(pair.base, code)
      : isLetterInScript(pair.base, code)
  }
  return false
}

/** Official `Dn` — previous visible run is in the script (letters required). */
function prevVisibleInScript(state: ContextRing, pair: ScriptPair): boolean {
  return scanRingForScript(state, pair, false)
}

/** Official `Bn` — next code point is visible and matches the regex. */
function nextVisibleMatches(
  code: number | undefined,
  regex: RegExp,
): boolean {
  return code !== undefined && !isHiddenCodePoint(code) && testCodePoint(regex, code)
}

/** Official `hi` — next code point is visible and in the script (ext marks ok). */
function nextVisibleInScript(
  code: number | undefined,
  pair: ScriptPair,
): boolean {
  return (
    code !== undefined &&
    !isHiddenCodePoint(code) &&
    isLetterInScript(pair.base, code)
  )
}

/** Official `ea` — emoji skin-tone modifiers (U+1F3FB..U+1F3FF). */
function isSkinToneModifier(code: number | undefined): boolean {
  return code !== undefined && code >= 127995 && code <= 127999
}

/** Official `Id` — keycap bases (0-9, #, *). */
function isKeycapBase(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 35 || code === 42
}

/**
 * Official `Zo` — does the current line (from `lineStart`) contain a letter
 * of the given RTL script set? Stops at the first line break.
 */
function lineHasRtlScript(
  scripts: RegExp,
  text: string,
  lineStart: number,
): boolean {
  for (let i = lineStart; i < text.length; ) {
    const code = text.codePointAt(i) as number
    if (isLineBreakCodePoint(code)) return false
    if (
      ((code >= 1424 && code <= 2303) ||
        (code >= 64285 && code <= 65023) ||
        (code >= 65136 && code <= 65279) ||
        (code >= 67584 && code <= 69631) ||
        (code >= 124928 && code <= 126975)) &&
      isLetterInScript(scripts, code)
    ) {
      return true
    }
    i += code > 65535 ? 2 : 1
  }
  return false
}

/** Official `Qo` — Arabic tatweel (1600) or an RTL-script code point. */
function isRtlContextCodePoint(code: number): boolean {
  return code === 1600 || testCodePoint(RTL_SCRIPTS_RE, code)
}

/**
 * Official `Ld` — the next visible char is a letter/digit whose preceding
 * visible run (skipping marks) reaches back into hidden characters, i.e. an
 * invisible-char run is "attached" to real text and an LRM/RLM/ALM after it
 * must NOT be kept. Returns false when next is neither letter nor digit.
 */
function nextVisibleJoinsHiddenRun(
  state: ContextRing,
  next: number | undefined,
): boolean {
  const nextIsLetter = testCodePoint(LETTER_RE, next)
  if (!nextIsLetter && !testCodePoint(DIGIT_RE, next)) return false
  for (let i = 0; i < state.size; i++) {
    const code = ringGet(state, i) as number
    if (isHiddenCodePoint(code)) return true
    if (testCodePoint(MARK_RE, code)) continue
    return nextIsLetter
      ? testCodePoint(LETTER_RE, code) &&
          isRtlContextCodePoint(code) === isRtlContextCodePoint(next as number)
      : testCodePoint(DIGIT_RE, code)
  }
  return state.size >= CONTEXT_RING_SIZE
}

// ---------------------------------------------------------------------------
// Classifier core (official `m4r` @196054012)
// ---------------------------------------------------------------------------

export type RemovedByClass = {
  tags: number
  bidi: number
  zeroWidth: number
  selectors: number
  other: number
}

export type StripResult = {
  text: string
  removedTotal: number
  removedByClass: RemovedByClass
  keptConditional: number
}

/** Per-removed-info returned by the wrappers (official `removed` shape). */
export type RemovedInfo = {
  removedTotal: number
  removedByClass: RemovedByClass
  keptConditional: number
  textLength: number
}

/**
 * Official `m4r` — the invisible-Unicode classifier. Removes hidden
 * formatting/tag characters unless they are conditionally kept (emoji ZWJ
 * joiners, script-legitimate ZWNJ/FVS/combining marks, VS15/VS16 after emoji,
 * LRM/RLM/ALM inside genuine RTL lines, kept 🏴 gbeng/gbsct/gbwls flag
 * sequences, …). Normalizes CR / CR-LF to LF and lone surrogates to U+FFFD.
 */
export function stripInvisibleUnicode(input: string): StripResult {
  const removedByClass: RemovedByClass = {
    tags: 0,
    bidi: 0,
    zeroWidth: 0,
    selectors: 0,
    other: 0,
  }
  // Official fast path: pure printable-ASCII input is returned untouched.
  if (!PRINTABLE_ASCII_GAP_RE.test(input)) {
    return { text: input, removedTotal: 0, removedByClass, keptConditional: 0 }
  }
  const text = toWellFormedString(input)
  const pieces: string[] = []
  let pieceStart = 0
  let removedTotal = text === input ? 0 : countLoneSurrogates(input)
  removedByClass.other += removedTotal
  const state: ContextRing = {
    ring: Array(CONTEXT_RING_SIZE).fill(0),
    next: 0,
    size: 0,
    lastWasHidden: false,
    keptConditional: 0,
  }
  let lineStart = 0
  let rtlLineScan: boolean | undefined
  let almLineScan: boolean | undefined
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i) as number
    const nextIndex = i + (code > 65535 ? 2 : 1)
    if (!isHiddenCodePoint(code)) {
      if (code === 10) {
        lineStart = nextIndex
        rtlLineScan = undefined
        almLineScan = undefined
      } else if (code === 127988) {
        // 🏴 — check for a conditionally-kept subdivision flag sequence.
        const chars = Array.from(text.slice(i, i + 2 * (FLAG_LETTER_COUNT + 2)))
        const flagEnd = decodeKeptFlagSequence(chars, 0)
        if (flagEnd !== -1) {
          ringPush(state, code, false)
          i = nextIndex
          for (let j = 1; j <= flagEnd; j++) {
            ringPush(state, chars[j].codePointAt(0) as number, true)
            i += chars[j].length
          }
          continue
        }
      }
      ringPush(state, code, false)
      i = nextIndex
      continue
    }
    if (isLineBreakCodePoint(code)) {
      // CR / CR-LF / NEL / LS / PS normalize to LF (lone CR counts as other).
      const isCrLf = code === 13 && text.charCodeAt(nextIndex) === 10
      if (i > pieceStart) pieces.push(text.slice(pieceStart, i))
      pieceStart = nextIndex
      if (!isCrLf) {
        pieces.push('\n')
        removedTotal++
        removedByClass.other++
        ringPush(state, 10, false)
        lineStart = nextIndex
        rtlLineScan = undefined
        almLineScan = undefined
      }
      i = nextIndex
      continue
    }
    const nextCode =
      nextIndex < text.length ? text.codePointAt(nextIndex) : undefined
    const prevCode = ringGet(state, 0)
    const { lastWasHidden } = state
    let keep = false
    switch (code) {
      case 8204: // ZWNJ
      case 8205: {
        // ZWJ
        // Official: `Dn(y, O===8204 ? Cd : Pd)` — ZWNJ scans Cd, ZWJ scans Pd.
        keep = prevVisibleInScript(
          state,
          code === 8204 ? ZWNJ_CONTEXT_SCRIPTS : ZWJ_CONTEXT_SCRIPTS,
        )
        if (!keep && code === 8205) {
          // Emoji ZWJ sequence: skip up to two VS16/skin-tone layers back to
          // the Extended_Pictographic base, and require an Extended_Pictographic
          // next.
          let base = prevCode
          if (base !== undefined && (base === 65039 || isSkinToneModifier(base))) {
            base = ringGet(state, 1)
            if (base !== undefined && (base === 65039 || isSkinToneModifier(base))) {
              base = ringGet(state, 2)
            }
          }
          keep =
            prevCode !== undefined &&
            prevCode !== 8205 &&
            testCodePoint(EXTENDED_PICTOGRAPHIC_RE, base) &&
            nextVisibleMatches(nextCode, EXTENDED_PICTOGRAPHIC_RE)
        }
        // Official v280 addition (byte-verified @196843700; the v278 block
        // @196083420 ends at the emoji-ZWJ branch with NO such clause):
        //   `if(!j&&D!==void 0&&!O)j=N===8204
        //      ?Sn(L,Xs)&&!Ce(Gc,D)&&!Ce(Pt,D)
        //      :Sn(L,Xc)&&!Ce(Wn,D)&&!Ce(Br,D)&&!Ce(Pt,D)`
        // Symbol map: j=keep, D=prevCode, O=lastWasHidden, N=code, L=nextCode,
        // Sn=nextVisibleInScript (v280 `Sn(e,n){return e!==void 0&&!En(e)&&
        // Vr(n.base,e)}` @196846079 ≡ v278 `hi`), Xs=ZWNJ_CONTEXT_SCRIPTS,
        // Xc=ZWJ_NEXT_SCRIPTS, Gc=WHITESPACE_RE, Ce=testCodePoint, Wn=LETTER_RE,
        // Br=DIGIT_RE, Pt=MARK_RE. Changelog 2.1.280: "Fixed the
        // invisible-character cleanup removing the zero-width non-joiner that
        // Persian and Arabic text uses to attach a suffix to a Latin word or
        // number, such as the plural of 'PDF'".
        if (!keep && prevCode !== undefined && !lastWasHidden) {
          keep =
            code === 8204
              ? nextVisibleInScript(nextCode, ZWNJ_CONTEXT_SCRIPTS) &&
                !testCodePoint(WHITESPACE_RE, prevCode) &&
                !testCodePoint(MARK_RE, prevCode)
              : nextVisibleInScript(nextCode, ZWJ_NEXT_SCRIPTS) &&
                !testCodePoint(LETTER_RE, prevCode) &&
                !testCodePoint(DIGIT_RE, prevCode) &&
                !testCodePoint(MARK_RE, prevCode)
        }
        break
      }
      case 8203: {
        // ZWSP — kept in Khmer/Thai/Lao/Myanmar or digit contexts.
        const seaRun = scanRingForScript(state, SEA_SCRIPTS, true)
        const nextIsSea =
          nextVisibleMatches(nextCode, SEA_SCRIPT_RE) &&
          !testCodePoint(MARK_RE, nextCode)
        keep =
          (seaRun && (nextIsSea || nextVisibleMatches(nextCode, ASCII_DIGIT_RE))) ||
          (nextIsSea && prevVisibleMatches(state, ASCII_DIGIT_RE))
        break
      }
      case 65038: // VS15
      case 65039: // VS16
        keep =
          prevCode !== undefined &&
          !lastWasHidden &&
          ((prevCode >= 169 && testCodePoint(EMOJI_RE, prevCode)) ||
            (isKeycapBase(prevCode) && nextCode === 8419))
        break
      case 65024: // VS1
      case 65025: // VS2
      case 65026: // VS3
        keep =
          prevCode !== undefined &&
          !lastWasHidden &&
          (testCodePoint(EGYPTIAN_HIEROGLYPHS.base, prevCode) ||
            (code === 65024 &&
              ((prevCode >= 8704 &&
                prevCode <= 11007 &&
                testCodePoint(MATH_SYMBOL_RE, prevCode)) ||
                testCodePoint(MYANMAR_LIKE_RE, prevCode))))
        break
      case 8206: // LRM
      case 8207: // RLM
      case 1564: // ALM
        if (code === 1564) {
          if (almLineScan === undefined) {
            almLineScan = lineHasRtlScript(ALM_RTL_SCRIPTS_RE, text, lineStart)
          }
          keep = almLineScan
        } else {
          if (rtlLineScan === undefined) {
            rtlLineScan = lineHasRtlScript(RTL_SCRIPTS_RE, text, lineStart)
          }
          keep = rtlLineScan
        }
        keep =
          keep &&
          !lastWasHidden &&
          (nextCode === undefined ||
            isLineBreakCodePoint(nextCode) ||
            (!isHiddenCodePoint(nextCode) && !testCodePoint(MARK_RE, nextCode))) &&
          !nextVisibleJoinsHiddenRun(state, nextCode)
        break
      case 847: // CGJ
        keep =
          prevVisibleMatches(state, MARK_RE) ||
          (!lastWasHidden && nextVisibleMatches(nextCode, MARK_RE))
        break
      case 6068: // KHMER VOWEL INHERENT AQ
      case 6069: // KHMER VOWEL INHERENT AA
        keep = prevVisibleInScript(state, KHMER)
        break
      case 6155: // MONGOLIAN FVS1
      case 6156: // MONGOLIAN FVS2
      case 6157: // MONGOLIAN FVS3
      case 6158: // MONGOLIAN VOWEL SEPARATOR
      case 6159: // MONGOLIAN FVS4 (alias)
        keep =
          prevVisibleInScript(state, MONGOLIAN) ||
          (!lastWasHidden && nextVisibleInScript(nextCode, MONGOLIAN))
        break
      case 69759: // BRAHMI VOWEL SIGN
        keep =
          prevVisibleMatches(state, BRAHMI_RE) &&
          nextVisibleMatches(nextCode, BRAHMI_RE)
        break
      default:
        if (code >= 78896 && code <= 78911) {
          // Egyptian Hieroglyphs format controls
          keep =
            prevVisibleInScript(state, EGYPTIAN_HIEROGLYPHS) ||
            (!lastWasHidden && nextVisibleInScript(nextCode, EGYPTIAN_HIEROGLYPHS))
        } else if (code >= 113824 && code <= 113827) {
          // Duployan combining marks
          keep =
            prevVisibleInScript(state, DUPLOYAN) ||
            (!lastWasHidden && nextVisibleInScript(nextCode, DUPLOYAN))
        }
    }
    if (keep) {
      ringPush(state, code, true)
    } else {
      if (i > pieceStart) pieces.push(text.slice(pieceStart, i))
      pieceStart = nextIndex
      removedTotal++
      removedByClass[classifyHiddenCodePoint(code)]++
    }
    i = nextIndex
  }
  const { keptConditional } = state
  if (pieceStart === 0) {
    return { text, removedTotal, removedByClass, keptConditional }
  }
  pieces.push(text.slice(pieceStart))
  return { text: pieces.join(''), removedTotal, removedByClass, keptConditional }
}

// ---------------------------------------------------------------------------
// Gate + wrappers (official `Ga`/`yr`/`Bxt`/`Bnt`/`Ha` @207936185-207938200)
// ---------------------------------------------------------------------------

/**
 * Official gate flag name (`Ga` @207938113: `P("tengu_tranquil_cloud",!0)` —
 * a Statsig gate whose default is TRUE). OCC has no Statsig client, so the
 * strip is unconditionally enabled, matching the official default.
 */
export const INVISIBLE_STRIP_GATE = 'tengu_tranquil_cloud'

function isInvisibleStripGateOn(): boolean {
  return true
}

/** Official `yr` — classifier + gate; unchanged text reports zero removals. */
export function stripInvisibleWithMeta(input: string): {
  text: string
  removed: RemovedInfo
} {
  const result = stripInvisibleUnicode(input)
  if (result.text === input || !isInvisibleStripGateOn()) {
    return {
      text: input,
      removed: {
        removedTotal: 0,
        removedByClass: { tags: 0, bidi: 0, zeroWidth: 0, selectors: 0, other: 0 },
        keptConditional: 0,
        textLength: input.length,
      },
    }
  }
  const { text, ...rest } = result
  return { text, removed: { ...rest, textLength: input.length } }
}

/** Official `Ha` — accumulate a nested strip result into an accumulator. */
function accumulateRemoved(accumulator: RemovedInfo, incoming: RemovedInfo): void {
  accumulator.removedTotal += incoming.removedTotal
  accumulator.keptConditional += incoming.keptConditional
  accumulator.textLength += incoming.textLength
  for (const key of Object.keys(incoming.removedByClass) as (keyof RemovedByClass)[]) {
    accumulator.removedByClass[key] += incoming.removedByClass[key]
  }
}

/** Official surfaces seen at the `FWe`/`Bxt` call sites. */
export type InvisibleStripSurface = 'prompt' | 'fleet_dispatch' | 'fleet_reply'

/** Official telemetry event name (`FWe` @207937426). */
export const PROMPT_INVISIBLE_STRIP_EVENT = 'tengu_prompt_invisible_strip'

/** Official secondary counter name emitted alongside the telemetry event. */
export const INPUT_INVISIBLE_STRIP_COUNTER = 'input_invisible_strip'

/**
 * Official `FWe` — emit `tengu_prompt_invisible_strip`. The official payload
 * also carries the string fields `surface` (`c(h)`) and `text_length_bucket`
 * (`le_100`/`le_1k`/`le_10k`/`le_100k`/`gt_100k`), plus a secondary
 * `input_invisible_strip` counter event. OCC analytics are stubbed and
 * `LogEventMetadata` only accepts boolean|number|undefined, so the string
 * fields and the counter event cannot ride along; `surface` is kept as a
 * parameter for call-site parity with the official.
 */
export function logInvisibleStripEvent(
  removed: RemovedInfo,
  _surface: InvisibleStripSurface,
): void {
  logEvent(PROMPT_INVISIBLE_STRIP_EVENT, {
    removed_total: removed.removedTotal,
    removed_tags: removed.removedByClass.tags,
    removed_bidi: removed.removedByClass.bidi,
    removed_zero_width: removed.removedByClass.zeroWidth,
    removed_selectors: removed.removedByClass.selectors,
    removed_other: removed.removedByClass.other,
    kept_conditional: removed.keptConditional,
  })
}

/**
 * Official `Bxt` — plain-text strip for launch/queued prompts: strips, logs
 * telemetry when anything was removed, returns the cleaned text + count.
 */
export function stripInvisibleText(
  input: string,
  surface: InvisibleStripSurface,
): { text: string; removedTotal: number } {
  const { text, removed } = stripInvisibleWithMeta(input)
  if (removed.removedTotal > 0) logInvisibleStripEvent(removed, surface)
  return { text, removedTotal: removed.removedTotal }
}

/** Official notice modes (`fde` second parameter). */
export type InvisibleStripNoticeMode = 'review' | 'empty' | 'sent'

/**
 * Official `fde` @207937121 (byte-verified string atoms @93292208-93292450):
 *   review: `Removed N invisible character(s) · review and press Enter to send`
 *   empty:  `Removed N invisible character(s) · nothing left to send`
 *   sent:   `Removed N invisible character(s) from the launch prompt before sending it`
 * The separator is U+00B7 MIDDLE DOT (`\xB7` in the binary) with single
 * spaces on both sides.
 */
export function formatInvisibleStripNotice(
  count: number,
  mode: InvisibleStripNoticeMode = 'review',
): string {
  const base =
    count === 1
      ? 'Removed 1 invisible character'
      : `Removed ${count} invisible characters`
  switch (mode) {
    case 'review':
      return `${base} · review and press Enter to send`
    case 'empty':
      return `${base} · nothing left to send`
    case 'sent':
      return `${base} from the launch prompt before sending it`
  }
}

// ---------------------------------------------------------------------------
// Submit-time strip incl. pasted contents (official `Bnt` @207936294)
// ---------------------------------------------------------------------------

/** Official `CCe` @198110900 — placeholder chip kinds (byte-verbatim). */
const PLACEHOLDER_KINDS = String.raw`Pasted text|Image|Audio|\.\.\.Truncated text`

/** Official `aUn` @198117040 — placeholder chip regex (byte-verbatim). */
const PLACEHOLDER_RE = new RegExp(
  String.raw`\[(${PLACEHOLDER_KINDS}) #(\d+)(?: \+\d+ lines)?(\.)*\]`,
  'g',
)

type PlaceholderRef = { id: number; match: string; index: number }

/** Official `nu` @198117155 — locate placeholder chips with their ids. */
function findPlaceholderRefs(text: string): PlaceholderRef[] {
  if (!text) return []
  return [...text.matchAll(PLACEHOLDER_RE)]
    .map((m) => ({
      id: Number.parseInt(m[2] || '0', 10),
      match: m[0],
      index: m.index as number,
    }))
    .filter((ref) => ref.id > 0)
}

export type SubmitStripResult = {
  input: string
  pastedContents: Record<number, PastedContent>
  removed: RemovedInfo
}

/**
 * Official `Bnt` @207936294 — submit-time strip: cleans the input AND each
 * text-typed pastedContents entry (accumulating removals via `Ha`), and
 * rewrites `[Pasted text #N]` / `[...Truncated text #N +M lines...]`
 * placeholders when an entry's newline count changed. The official inline
 * entry branch (`I.inline`) has no OCC equivalent — OCC's `PastedContent`
 * type has no `inline` field — so that branch is absent by construction.
 */
export function stripInvisibleForSubmit(
  input: string,
  pastedContents: Record<number, PastedContent>,
): SubmitStripResult {
  const { text: cleanedInput, removed } = stripInvisibleWithMeta(input)
  let nextPastedContents = pastedContents
  let text = cleanedInput
  const refs = findPlaceholderRefs(text)
  const lineCountChanges = new Map<number, number>()
  for (const { id } of refs) {
    const entry = nextPastedContents[id]
    if (entry?.type !== 'text') continue
    const entryStrip = stripInvisibleWithMeta(entry.content)
    if (entryStrip.text !== entry.content) {
      if (nextPastedContents === pastedContents) {
        nextPastedContents = { ...pastedContents }
      }
      nextPastedContents[id] = { ...entry, content: entryStrip.text }
      accumulateRemoved(removed, entryStrip.removed)
      const newLines = getPastedTextRefNumLines(entryStrip.text)
      if (newLines !== getPastedTextRefNumLines(entry.content)) {
        lineCountChanges.set(id, newLines)
      }
    }
  }
  if (lineCountChanges.size > 0) {
    for (let i = refs.length - 1; i >= 0; i--) {
      const ref = refs[i]
      const newLines = lineCountChanges.get(ref.id)
      if (newLines === undefined) continue
      const replacement = ref.match.startsWith('[Pasted text #')
        ? formatPastedTextRef(ref.id, newLines)
        : ref.match.startsWith('[...Truncated text #')
          ? `[...Truncated text #${ref.id} +${newLines} lines...]`
          : ref.match
      text = text.slice(0, ref.index) + replacement + text.slice(ref.index + ref.match.length)
    }
  }
  return { input: text, pastedContents: nextPastedContents, removed }
}
