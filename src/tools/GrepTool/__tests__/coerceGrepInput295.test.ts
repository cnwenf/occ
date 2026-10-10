import { describe, expect, test } from 'bun:test'
import { coerceGrepInput, GrepTool } from '../GrepTool.js'

// The GrepTool module chain reads MACRO.VERSION at call time (permission path)
// — mirror the cli.tsx polyfill like coerceGrepInput292.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code v2.1.295 changelog #108 — "Improved Grep input handling:
 * a search sent with grep's `-l`, `-c` or `-r` flag now runs instead of failing
 * the call." Byte-verified against the v295 linux-x64 ELF:
 *
 * - @215618396 `lCt(e)` + the flag table
 *   `var fZn=[["-l","flag_l","files_with_matches"],["-c","flag_c","count"]]`
 *   — the merged coercion ported here as `coerceGrepInput`. It keeps the
 *   2.1.292 `file_path`→`path` repair and ADDS `-l`/`-c`→`output_mode` and
 *   `-r`→ignored, accumulating shapeClass (`r.join(",")`) and note (`s.join(" ")`).
 * - @208234413 `BE(e)` = `e==="true"?!0:e==="false"?!1:e` — the semantic-boolean
 *   resolver (`resolveSemanticBooleanValue` in GrepTool.ts). Only a value that
 *   resolves to boolean `true` counts as "flag set".
 * - @215622816 `coerceInput(e){return mU(dCt(),lCt(e))}` — the gate (`mU`, the
 *   renamed 2.1.292 `pH`) returns the repair ONLY when the coerced input passes
 *   the strict schema.
 * - v294 baseline @213178135 was file_path-only (single shapeClass, no
 *   `-l`/`-c`/`-r`) — the pre-#108 OCC behavior.
 *
 * `Jr`="Grep" (GREP_TOOL_NAME), `L`=isRecord.
 */

// Byte-exact note fragments (from the lCt string templates @215618396/215619065/99186633).
const L_NOTE =
  '`-l` is not a Grep parameter and was read as `output_mode: "files_with_matches"`.'
const C_NOTE = '`-c` is not a Grep parameter and was read as `output_mode: "count"`.'
const L_REPEATED = '`-l` repeated `output_mode` and was ignored.'
const C_REPEATED = '`-c` repeated `output_mode` and was ignored.'
const R_NOTE = '`-r` was ignored: Grep always searches a directory recursively.'
const FILE_PATH_NOTE =
  "Note: Grep's parameter for where to search is named `path`. `file_path` was read as `path`."

describe('2.1.295 #108 — coerceGrepInput `-l`/`-c`/`-r` (binary lCt @215618396)', () => {
  test('-l: true maps to output_mode "files_with_matches" (flag_l) with the byte-exact note', () => {
    // Arrange
    const input = { pattern: 'x', '-l': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', output_mode: 'files_with_matches' })
    expect(repair!.shapeClass).toBe('flag_l')
    expect(repair!.resultNote).toBe(`Note: ${L_NOTE}`)
  })

  test('-c: true maps to output_mode "count" (flag_c) with the byte-exact note', () => {
    // Arrange
    const input = { pattern: 'x', '-c': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', output_mode: 'count' })
    expect(repair!.shapeClass).toBe('flag_c')
    expect(repair!.resultNote).toBe(`Note: ${C_NOTE}`)
  })

  test('-r: true is dropped (flag_r) — Grep is always recursive', () => {
    // Arrange
    const input = { pattern: 'x', '-r': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — `-r` maps to nothing; it is simply removed with an explanatory note.
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x' })
    expect(repair!.shapeClass).toBe('flag_r')
    expect(repair!.resultNote).toBe(`Note: ${R_NOTE}`)
  })

  test('string "true" is accepted for the flags (BE resolver: `e==="true"?!0`)', () => {
    // Arrange / Act / Assert — models sometimes quote booleans.
    expect(coerceGrepInput({ pattern: 'x', '-l': 'true' })!.shapeClass).toBe('flag_l')
    expect(coerceGrepInput({ pattern: 'x', '-c': 'true' })!.shapeClass).toBe('flag_c')
    expect(coerceGrepInput({ pattern: 'x', '-r': 'true' })!.shapeClass).toBe('flag_r')
  })

  test('falsy / non-boolean flag values are NOT treated as set (BE: `1 !== true`)', () => {
    // Arrange / Act / Assert — nothing to coerce → null (r.length === 0).
    expect(coerceGrepInput({ pattern: 'x', '-l': false })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', '-l': 'false' })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', '-c': 1 })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', '-r': 0 })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', '-r': 'false' })).toBeNull()
  })

  test('combined -l + -r accumulate: comma-joined shapeClass, space-joined note', () => {
    // Arrange
    const input = { pattern: 'x', '-l': true, '-r': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — fZn loop runs before the -r branch, so flag_l precedes flag_r.
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', output_mode: 'files_with_matches' })
    expect(repair!.shapeClass).toBe('flag_l,flag_r')
    expect(repair!.resultNote).toBe(`Note: ${L_NOTE} ${R_NOTE}`)
  })

  test('combined file_path + -c accumulate across both repair branches', () => {
    // Arrange
    const input = { pattern: 'x', file_path: '/abs/dir', '-c': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — file_path branch (1) pushes first, then the fZn branch (2).
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({
      pattern: 'x',
      path: '/abs/dir',
      output_mode: 'count',
    })
    expect(repair!.shapeClass).toBe('file_path,flag_c')
    expect(repair!.resultNote).toBe(
      `Note: Grep's parameter for where to search is named \`path\`. \`file_path\` was read as \`path\`. ${C_NOTE}`,
    )
  })

  test('-l repeated (output_mode already files_with_matches) → repeated_flag_l, ignored note', () => {
    // Arrange — binary `H=!Object.hasOwn(n,"output_mode")` is false, mode equals w.
    const input = { pattern: 'x', '-l': true, output_mode: 'files_with_matches' }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', output_mode: 'files_with_matches' })
    expect(repair!.shapeClass).toBe('repeated_flag_l')
    expect(repair!.resultNote).toBe(`Note: ${L_REPEATED}`)
  })

  test('-c repeated (output_mode already count) → repeated_flag_c, ignored note', () => {
    // Arrange
    const input = { pattern: 'x', '-c': true, output_mode: 'count' }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', output_mode: 'count' })
    expect(repair!.shapeClass).toBe('repeated_flag_c')
    expect(repair!.resultNote).toBe(`Note: ${C_REPEATED}`)
  })

  test('-l conflicting with output_mode "content" → null (stray flag left, no guess)', () => {
    // Arrange — binary `if(H||n.output_mode===w)` is false → skip; -l survives,
    // r stays empty → lCt returns null (validation rejects the call normally).
    const input = { pattern: 'x', '-l': true, output_mode: 'content' }

    // Act / Assert
    expect(coerceGrepInput(input)).toBeNull()
  })

  test('both -l and -c with no output_mode → only -l applies; -c survives (gate nulls it)', () => {
    // Arrange — fZn processes -l first (sets output_mode), then -c sees a
    // present-but-different mode and is skipped, leaving `-c` in the input.
    const input = { pattern: 'x', '-l': true, '-c': true }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — the raw coercion keeps `-c`, so it is still schema-invalid.
    expect(repair).not.toBeNull()
    expect(repair!.shapeClass).toBe('flag_l')
    expect(repair!.input).toEqual({
      pattern: 'x',
      output_mode: 'files_with_matches',
      '-c': true,
    })
  })

  test('canonical input (no stray flags) → null (nothing to coerce)', () => {
    expect(coerceGrepInput({ pattern: 'x' })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', output_mode: 'content' })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', path: '/abs', '-i': true })).toBeNull()
  })

  test('returns null for non-record inputs (binary L() guard)', () => {
    expect(coerceGrepInput(null)).toBeNull()
    expect(coerceGrepInput('nope')).toBeNull()
    expect(coerceGrepInput(42)).toBeNull()
    expect(coerceGrepInput([{ pattern: 'x', '-l': true }])).toBeNull()
  })

  test('never mutates the original input (binary `let n={...e}`)', () => {
    // Arrange
    const input = { pattern: 'x', '-l': true, '-r': true, file_path: '/abs/dir' }
    const snapshot = JSON.stringify(input)

    // Act
    coerceGrepInput(input)

    // Assert
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  test('preserves 2.1.292 file_path→path behavior (regression guard for the merge)', () => {
    // Arrange / Act
    const repair = coerceGrepInput({ pattern: 'x', file_path: '/abs/dir' })

    // Assert — identical to the pre-#108 single-repair result.
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', path: '/abs/dir' })
    expect(repair!.shapeClass).toBe('file_path')
    expect(repair!.resultNote).toBe(FILE_PATH_NOTE)
  })
})

describe('2.1.295 #108 — GrepTool.coerceInput gate (binary mU @215622816)', () => {
  test('raw -l/-c/-r FAIL the strict schema (this is the bug #108 fixes)', () => {
    // Arrange / Act / Assert — proves the strictObject schema rejects the flags.
    expect(GrepTool.inputSchema.safeParse({ pattern: 'x', '-l': true }).success).toBe(false)
    expect(GrepTool.inputSchema.safeParse({ pattern: 'x', '-c': true }).success).toBe(false)
    expect(GrepTool.inputSchema.safeParse({ pattern: 'x', '-r': true }).success).toBe(false)
  })

  test('coerced -l/-c/-r PASS the strict schema (the call now runs)', () => {
    // Arrange / Act
    const l = coerceGrepInput({ pattern: 'x', '-l': true })!
    const c = coerceGrepInput({ pattern: 'x', '-c': true })!
    const r = coerceGrepInput({ pattern: 'x', '-r': true })!

    // Assert
    expect(GrepTool.inputSchema.safeParse(l.input).success).toBe(true)
    expect(GrepTool.inputSchema.safeParse(c.input).success).toBe(true)
    expect(GrepTool.inputSchema.safeParse(r.input).success).toBe(true)
  })

  test('gate returns the repair for -l (coerced input is schema-valid)', () => {
    // Arrange
    const input = { pattern: 'x', '-l': true }

    // Act
    const repair = GrepTool.coerceInput!(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', output_mode: 'files_with_matches' })
    expect(repair!.shapeClass).toBe('flag_l')
    expect(repair!.resultNote).toBe(`Note: ${L_NOTE}`)
  })

  test('gate returns the repair for -r (flag dropped, input valid)', () => {
    // Arrange / Act
    const repair = GrepTool.coerceInput!({ pattern: 'x', '-r': true })

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x' })
    expect(repair!.shapeClass).toBe('flag_r')
  })

  test('gate NULLS the -l + -c conflict (leftover `-c` breaks the strict schema)', () => {
    // Arrange — coerceGrepInput keeps `-c`, so safeParse fails → mU returns null.
    const input = { pattern: 'x', '-l': true, '-c': true }

    // Act / Assert
    expect(coerceGrepInput(input)).not.toBeNull()
    expect(GrepTool.coerceInput!(input)).toBeNull()
  })

  test('gate NULLS a flag repair that is still missing `pattern`', () => {
    // Arrange — `-l` coerces to output_mode but `pattern` is required.
    const input = { '-l': true }

    // Act / Assert
    expect(coerceGrepInput(input)).not.toBeNull()
    expect(GrepTool.coerceInput!(input)).toBeNull()
  })

  test('gate returns null for canonical input (nothing to repair)', () => {
    expect(GrepTool.coerceInput!({ pattern: 'x', output_mode: 'content' })).toBeNull()
    expect(GrepTool.coerceInput!({ pattern: 'x', path: '/abs' })).toBeNull()
  })
})
