/**
 * CC 2.1.299 #154 (security) — skill/command names with hidden,
 * direction-changing, or blank-like characters, `<`/`>`, or over 256 chars
 * must no longer be offered; a frontmatter `name:`/display name with such
 * characters is not shown (falls back to the file/dir name when that is
 * itself clean).
 *
 * Official predicate chain (v299 @214784506–214786551, @224020601):
 *   kr(e)  = e.length<=256 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029<>]/.test(e)
 *   UG(e)  = e.length>0 && kr(e)
 *   Ar     = [\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}
 *              \p{Default_Ignorable_Code_Point}\u2800] (u)
 *   Rr     = /(?! )\p{Zs}|[\uFFFC\u{1D159}\u{13441}\u{13442}\u{16FE4}]|^ | $/u
 *   _r     = combining-mark spoofing regex (see nameSafety.ts)
 *   vr(e)  = UG(e) && !Ar.test(e) && !Rr.test(e)
 *   XHo(e) = vr(e) && !e.includes("  ") && !_r.test(e)
 *   zao    = /(?:^|:) | (?::|$)|^:|:$/
 *   qao(e) = XHo(e) && !zao.test(e)
 *   sj(e)  = qao(e) || UG(e) && !bRt()    — skill "is offered" predicate
 *   k6(e)  = XHo(e) || UG(e) && !bRt()    — command "is shown" predicate
 *   bRt()  = _x() || k("tengu_slate_wicket", true) !== false  → defaults TRUE
 * OCC has no remote gates → bRt() is always true → sj reduces to qao and k6
 * reduces to XHo (the strict lane is the official default behavior).
 *
 * Official warn (wI @224020882):
 *   LJr = "a name may not hold hidden, direction-changing or blank-like
 *          characters, < or >, or be over 256 characters"
 *   message: `[names] ${Vc(ne(name,200)) + Zs-escapes} ${suffix}: ${LJr}`
 *   dedup via namesNotShown set, cap hir=100, the 100th appends
 *   ". No more are told", subsequent refusals are silent.
 *
 * Official registration gate (r8t @227120956/@227123544):
 *   if(!sj(qn)){wI(qn,"is not offered");return}
 *   if(!k6(ln.replace(/&[lg]t;/g,"<")))wI(ln,`is not shown for ${qn}`),Bgr(Xn)
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as debug from '../debug.js'
import {
  MAX_DISTINCT_NAME_WARNINGS,
  NAME_REFUSAL_REASON,
  _resetNamesNotShownForTesting,
  isCommandNameShown,
  isSkillNameOffered,
  warnNameNotShown,
} from '../nameSafety.js'

let logs: { message: string; level?: string }[] = []
let spy: ReturnType<typeof spyOn> | undefined

function captureLogs(): void {
  logs = []
  spy = spyOn(debug, 'logForDebugging').mockImplementation(
    (message: string, opts?: { level?: string }) => {
      logs.push({ message, level: opts?.level })
      return undefined as never
    },
  )
}

beforeEach(() => {
  captureLogs()
  _resetNamesNotShownForTesting()
})

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

const ZWSP = '\u200B' // ZERO WIDTH SPACE (Cf + Default_Ignorable)
const RLO = '\u202E' // RIGHT-TO-LEFT OVERRIDE (Cf)
const NBSP = '\u00A0' // NO-BREAK SPACE (Zs, not plain space)
const COMBINING_ACUTE = '\u0301' // COMBINING ACUTE ACCENT (M)
const DOT_ABOVE = '\u0307' // COMBINING DOT ABOVE (soft-dotted spoof)

describe('CC 2.1.299 #154: isSkillNameOffered (official sj, strict lane)', () => {
  test('clean name is offered', () => {
    expect(isSkillNameOffered('my-skill')).toBe(true)
    expect(isSkillNameOffered('ns:cmd')).toBe(true)
    expect(isSkillNameOffered('a'.repeat(256))).toBe(true)
  })

  test('name with ZWSP (hidden char) is refused', () => {
    expect(isSkillNameOffered(`my${ZWSP}skill`)).toBe(false)
  })

  test('name with RLO (direction-changing char) is refused', () => {
    expect(isSkillNameOffered(`evil${RLO}name`)).toBe(false)
  })

  test('name with < or > is refused', () => {
    expect(isSkillNameOffered('bad<name')).toBe(false)
    expect(isSkillNameOffered('bad>name')).toBe(false)
  })

  test('257-char name is refused', () => {
    expect(isSkillNameOffered('a'.repeat(257))).toBe(false)
  })

  test('empty name is refused', () => {
    expect(isSkillNameOffered('')).toBe(false)
  })

  test('control chars, blank-like chars, edge spaces are refused', () => {
    expect(isSkillNameOffered('bad\x07name')).toBe(false)
    expect(isSkillNameOffered(`bad${NBSP}name`)).toBe(false)
    expect(isSkillNameOffered(' leading-space')).toBe(false)
    expect(isSkillNameOffered('trailing-space ')).toBe(false)
    expect(isSkillNameOffered('double  space')).toBe(false)
    expect(isSkillNameOffered('\u2028sep')).toBe(false)
    expect(isSkillNameOffered('\u2800braille-blank')).toBe(false)
  })

  test('colon-edge patterns are refused for the offer predicate (zao)', () => {
    expect(isSkillNameOffered(':cmd')).toBe(false)
    expect(isSkillNameOffered('cmd:')).toBe(false)
    expect(isSkillNameOffered('ns: cmd')).toBe(false)
    expect(isSkillNameOffered('ns :cmd')).toBe(false)
  })

  test('combining-mark spoofing patterns are refused (_r)', () => {
    // A combining mark with no preceding letter/number/mark.
    expect(isSkillNameOffered(`${COMBINING_ACUTE}accent-first`)).toBe(false)
    // Soft-dotted letter + U+0307 (dot above spoof).
    expect(isSkillNameOffered(`i${DOT_ABOVE}spoof`)).toBe(false)
  })
})

describe('CC 2.1.299 #154: isCommandNameShown (official k6, strict lane)', () => {
  test('clean shown name passes; hidden chars fail', () => {
    expect(isCommandNameShown('My Skill')).toBe(true)
    expect(isCommandNameShown(`My${ZWSP}Skill`)).toBe(false)
    expect(isCommandNameShown('a'.repeat(257))).toBe(false)
  })

  test('k6 does NOT include the colon-edge rule (sj-only)', () => {
    // Official: k6 = XHo (no zao test) — ':cmd' is shown-safe but not
    // offer-safe.
    expect(isCommandNameShown(':cmd')).toBe(true)
    expect(isSkillNameOffered(':cmd')).toBe(false)
  })
})

describe('CC 2.1.299 #154: warnNameNotShown (official wI)', () => {
  test('warns with the official [names] message shape and reason', () => {
    // Act
    warnNameNotShown(`my${ZWSP}skill`, 'is not offered')

    // Assert — ZWSP is escaped as \u{200B} (uppercase hex), reason verbatim.
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('warn')
    expect(logs[0]!.message).toBe(
      `[names] my\\u{200B}skill is not offered: ${NAME_REFUSAL_REASON}`,
    )
    expect(NAME_REFUSAL_REASON).toBe(
      'a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters',
    )
  })

  test('RLO is escaped in the warning', () => {
    warnNameNotShown(`evil${RLO}name`, 'is not offered')
    expect(logs[0]!.message).toContain('evil\\u{202E}name')
  })

  test('duplicate refusals warn only once', () => {
    warnNameNotShown(`same${ZWSP}name`, 'is not offered')
    warnNameNotShown(`same${ZWSP}name`, 'is not offered')
    warnNameNotShown(`same${ZWSP}name`, 'is not offered')
    expect(logs).toHaveLength(1)
  })

  test('after 100 distinct warnings the cap message appears and further warnings are silent', () => {
    // Arrange / Act — 101 distinct refused names.
    for (let i = 0; i < MAX_DISTINCT_NAME_WARNINGS + 1; i++) {
      warnNameNotShown(`name${i}${ZWSP}`, 'is not offered')
    }

    // Assert — exactly 100 warnings; the 100th carries the cap suffix.
    expect(logs).toHaveLength(MAX_DISTINCT_NAME_WARNINGS)
    expect(
      logs[MAX_DISTINCT_NAME_WARNINGS - 1]!.message.endsWith(
        `${NAME_REFUSAL_REASON}. No more are told`,
      ),
    ).toBe(true)
    expect(logs[0]!.message.endsWith('. No more are told')).toBe(false)
  })

  test('warning name is truncated surrogate-safely to 200 chars', () => {
    // Arrange — a 300-char name ending in a hidden char.
    const longName = `${'x'.repeat(300)}${ZWSP}`

    // Act
    warnNameNotShown(longName, 'is not offered')

    // Assert — truncated to the first 200 code units (all 'x').
    expect(logs[0]!.message).toBe(
      `[names] ${'x'.repeat(200)} is not offered: ${NAME_REFUSAL_REASON}`,
    )
  })
})
