import { describe, expect, test } from 'bun:test'
import { coerceGrepInput, GrepTool } from '../GrepTool.js'

// The GrepTool module chain reads MACRO.VERSION at call time (permission path)
// — mirror the cli.tsx polyfill like coerceGrepInput292.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code v2.1.295 item #108 — "Grep sent with `-l`, `-c` or `-r`
 * flag now runs instead of failing."
 *
 * Byte-verified against the v295 linux-x64 ELF:
 *
 * - flag table `fZn` @~211695150:
 *   `[["-l","flag_l","files_with_matches"],["-c","flag_c","count"]]`
 *   (`flag_l`/`flag_c`/`flag_r` tokens: 0 hits in s294, 1 each in s295).
 * - @211695221 `lCt(e)` (dump @215618200) — full coercion ported into
 *   `coerceGrepInput` (superset of the 292 `cEt` file_path-only form):
 *   file_path→path repair, then the fZn flag loop with `BE` semantic-boolean
 *   activation and repeated_* shapeClasses, then `-r` (always dropped with its
 *   own note — Grep is inherently recursive). shapeClass is `r.join(",")`,
 *   resultNote is `Note: ${s.join(" ")}`.
 * - @208234413 `BE(e){return e==="true"?!0:e==="false"?!1:e}`.
 * - @215622816 def wiring: `coerceInput(e){return mU(dCt(),lCt(e))}`; the mU
 *   gate @215547561 (`n!==null&&e.safeParse(n.input).success?n:null`) rejects
 *   the repair when ANY stray key survives (e.g. a conflicting file_path).
 * - `Jr`=GREP_TOOL_NAME ("Grep").
 */

const FLAG_L_NOTE =
  'Note: `-l` is not a Grep parameter and was read as `output_mode: "files_with_matches"`.'
const FLAG_C_NOTE =
  'Note: `-c` is not a Grep parameter and was read as `output_mode: "count"`.'
const FLAG_R_NOTE =
  'Note: `-r` was ignored: Grep always searches a directory recursively.'
const REPEATED_L_NOTE = 'Note: `-l` repeated `output_mode` and was ignored.'

describe('2.1.295 #108 — coerceGrepInput flag table (binary lCt @211695221)', () => {
  test('-l:true runs as output_mode "files_with_matches" with the byte-exact note', () => {
    // Arrange
    const input = { pattern: 'TODO', path: '/repo', '-l': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual({
      pattern: 'TODO',
      path: '/repo',
      output_mode: 'files_with_matches',
    })
    expect(repair?.shapeClass).toBe('flag_l')
    expect(repair?.resultNote).toBe(FLAG_L_NOTE)
  })

  test('-c:true runs as output_mode "count"', () => {
    // Arrange
    const input = { pattern: 'TODO', '-c': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair?.input).toEqual({ pattern: 'TODO', output_mode: 'count' })
    expect(repair?.shapeClass).toBe('flag_c')
    expect(repair?.resultNote).toBe(FLAG_C_NOTE)
  })

  test('string "true" activates a flag (binary BE coercion @208234413)', () => {
    // Arrange
    const input = { pattern: 'TODO', '-l': 'true' }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair?.input).toEqual({
      pattern: 'TODO',
      output_mode: 'files_with_matches',
    })
    expect(repair?.shapeClass).toBe('flag_l')
  })

  test('-r:true is dropped with its own note (Grep always recurses)', () => {
    // Arrange
    const input = { pattern: 'TODO', path: '/repo', '-r': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair?.input).toEqual({ pattern: 'TODO', path: '/repo' })
    expect(repair?.shapeClass).toBe('flag_r')
    expect(repair?.resultNote).toBe(FLAG_R_NOTE)
  })

  test('-l:false / "false" does NOT activate the flag (BE maps to boolean false)', () => {
    // Arrange / Act / Assert — binary `if(BE(n[y])!==!0)continue`
    expect(coerceGrepInput({ pattern: 'x', '-l': false })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', '-l': 'false' })).toBeNull()
  })

  test('-l repeating an identical output_mode is dropped as repeated_flag_l', () => {
    // Arrange
    const input = {
      pattern: 'TODO',
      output_mode: 'files_with_matches',
      '-l': true,
    }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — binary `H?S:`repeated_${S}`` with the repeated-note variant
    expect(repair?.input).toEqual({
      pattern: 'TODO',
      output_mode: 'files_with_matches',
    })
    expect(repair?.shapeClass).toBe('repeated_flag_l')
    expect(repair?.resultNote).toBe(REPEATED_L_NOTE)
  })

  test('-l conflicting with a different output_mode is left alone (no repair → null)', () => {
    // Arrange — binary `if(H||n.output_mode===w)`: conflict skips the repair,
    // -l survives, r stays empty → null (validation rejects normally).
    const input = { pattern: 'TODO', output_mode: 'content', '-l': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).toBeNull()
  })

  test('combines -l and -r: comma-joined shapeClasses, space-joined notes in binary order', () => {
    // Arrange
    const input = { pattern: 'TODO', path: '/repo', '-r': true, '-l': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — fZn loop runs before the -r branch: flag_l then flag_r
    expect(repair?.input).toEqual({
      pattern: 'TODO',
      path: '/repo',
      output_mode: 'files_with_matches',
    })
    expect(repair?.shapeClass).toBe('flag_l,flag_r')
    expect(repair?.resultNote).toBe(
      'Note: `-l` is not a Grep parameter and was read as `output_mode: "files_with_matches"`. ' +
        '`-r` was ignored: Grep always searches a directory recursively.',
    )
  })

  test('combines the 292 file_path repair with 295 flags (file_path note first)', () => {
    // Arrange
    const input = { pattern: 'TODO', file_path: '/repo', '-c': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair?.input).toEqual({
      pattern: 'TODO',
      path: '/repo',
      output_mode: 'count',
    })
    expect(repair?.shapeClass).toBe('file_path,flag_c')
    expect(repair?.resultNote).toBe(
      "Note: Grep's parameter for where to search is named `path`. " +
        '`file_path` was read as `path`. ' +
        '`-c` is not a Grep parameter and was read as `output_mode: "count"`.',
    )
  })

  test('295 delta vs 292: a conflicting file_path no longer aborts flag repair', () => {
    // Arrange — 292 `cEt` returned null on conflict; 295 `lCt` skips ONLY the
    // file_path branch and still repairs the flag.
    const input = {
      pattern: 'TODO',
      path: '/repo',
      file_path: '/other',
      '-l': true,
    }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — repair exists (flag fixed, conflicting file_path retained)...
    expect(repair?.shapeClass).toBe('flag_l')
    expect(repair?.input).toHaveProperty('file_path', '/other')
    // ...but the def's mU-style safeParse gate rejects it (stray file_path key
    // fails strictObject), so coerceInput returns null — validation proceeds on
    // the ORIGINAL input, exactly like the official gate.
    expect(GrepTool.coerceInput?.(input)).toBeNull()
  })

  test('never mutates the caller object (immutable copy semantics)', () => {
    // Arrange
    const input: Record<string, unknown> = { pattern: 'TODO', '-l': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(input).toEqual({ pattern: 'TODO', '-l': true })
    expect(repair?.input).not.toBe(input)
  })

  test('end-to-end: a -l grep now parses and runs instead of failing strictObject', () => {
    // Arrange — pre-295 this input failed strict validation (unknown key -l).
    const rawInput = { pattern: 'TODO', path: '/repo', '-l': true }
    expect(GrepTool.inputSchema.safeParse(rawInput).success).toBe(false)

    // Act
    const repair = GrepTool.coerceInput?.(rawInput)
    const parsed = GrepTool.inputSchema.safeParse(repair?.input ?? rawInput)

    // Assert
    expect(repair?.shapeClass).toBe('flag_l')
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.output_mode).toBe('files_with_matches')
    }
  })
})
