import { describe, expect, test } from 'bun:test'
import { coerceGrepInput, GrepTool } from '../GrepTool.js'

// The GrepTool module chain reads MACRO.VERSION at call time (permission path)
// — mirror the cli.tsx polyfill like coerceWriteInput280.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code v2.1.292 C5 — Grep stray-parameter tolerance
 * (`file_path` → `path`). Byte-verified against the v292 linux-x64 ELF:
 *
 * - @212215273 `cEt(e)` — the coercion function ported here as `coerceGrepInput`:
 *   `function cEt(e){if(!L(e)||typeof e.file_path!=="string"||e.file_path==="")return null;
 *    let{file_path:n,...r}=e,s=!Object.hasOwn(r,"path");
 *    if(!s&&r.path!==n)return null;
 *    return{input:s?{...r,path:n}:r,shapeClass:s?"file_path":"repeated_file_path",
 *     resultNote:`Note: ${qr}'s parameter for where to search is named \`path\`.
 *      ${s?"`file_path` was read as `path`.":"`file_path` repeated `path` and was ignored."}`}}`
 * - @212219127 Grep def wiring (byte-verified, NO coerceInputBeforePluginHooks —
 *   that flag is Write-only): `coerceInput(e){return pH(fEt(),cEt(e))}`.
 * - @212144777 pH gate: `function pH(e,n){return n!==null&&e.safeParse(n.input).success?n:null}`.
 * - `qr`="Grep" (tool-name constant), `L`=isRecord, `fEt()`=schema getter.
 */
const NOTE_PREFIX =
  "Note: Grep's parameter for where to search is named `path`. "
const READ_AS = '`file_path` was read as `path`.'
const REPEATED = '`file_path` repeated `path` and was ignored.'

describe('2.1.292 C5 — coerceGrepInput (binary cEt @212215273)', () => {
  test('coerces file_path → path (path absent) with the byte-exact note + shapeClass', () => {
    // Arrange
    const input = { pattern: 'x', file_path: '/abs/dir' }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', path: '/abs/dir' })
    expect(repair!.shapeClass).toBe('file_path')
    expect(repair!.resultNote).toBe(`${NOTE_PREFIX}${READ_AS}`)
  })

  test('dedupes file_path when path is present and equal → repeated_file_path note', () => {
    // Arrange — binary `s=!Object.hasOwn(r,"path")` is false and `r.path===n`.
    const input = { pattern: 'x', file_path: '/abs/dir', path: '/abs/dir' }

    // Act
    const repair = coerceGrepInput(input)

    // Assert — input is `r` (raw minus file_path); the duplicate is dropped.
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', path: '/abs/dir' })
    expect(repair!.shapeClass).toBe('repeated_file_path')
    expect(repair!.resultNote).toBe(`${NOTE_PREFIX}${REPEATED}`)
  })

  test('conflicting file_path vs path → null (no coercion; normal validation error)', () => {
    // Arrange — binary `if(!s&&r.path!==n)return null`.
    const input = { pattern: 'x', file_path: '/abs/a', path: '/abs/b' }

    // Act / Assert
    expect(coerceGrepInput(input)).toBeNull()
  })

  test('empty-string file_path → null (binary `e.file_path===""`)', () => {
    expect(coerceGrepInput({ pattern: 'x', file_path: '' })).toBeNull()
  })

  test('non-string file_path → null (binary typeof guard)', () => {
    // Arrange / Act / Assert
    expect(coerceGrepInput({ pattern: 'x', file_path: 42 })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', file_path: null })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x', file_path: ['/abs'] })).toBeNull()
  })

  test('no file_path at all → null (typeof undefined !== "string")', () => {
    expect(coerceGrepInput({ pattern: 'x', path: '/abs' })).toBeNull()
    expect(coerceGrepInput({ pattern: 'x' })).toBeNull()
  })

  test('returns null for non-record inputs (binary L() guard)', () => {
    // Arrange / Act / Assert
    expect(coerceGrepInput(null)).toBeNull()
    expect(coerceGrepInput('nope')).toBeNull()
    expect(coerceGrepInput(42)).toBeNull()
    expect(coerceGrepInput([{ pattern: 'x', file_path: '/abs' }])).toBeNull()
  })

  test('preserves sibling params through the spread (only file_path is renamed)', () => {
    // Arrange
    const input = {
      pattern: 'x',
      file_path: '/abs/dir',
      output_mode: 'content',
      '-i': true,
    }

    // Act
    const repair = coerceGrepInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({
      pattern: 'x',
      path: '/abs/dir',
      output_mode: 'content',
      '-i': true,
    })
    expect(repair!.shapeClass).toBe('file_path')
  })

  test('never mutates the original input (binary destructures `{file_path,...r}`)', () => {
    // Arrange
    const input = { pattern: 'x', file_path: '/abs/dir' }
    const snapshot = JSON.stringify(input)

    // Act
    coerceGrepInput(input)

    // Assert
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('2.1.292 C5 — GrepTool.coerceInput (binary Grep def @212219127)', () => {
  test('returns the repair when the coerced input passes the strict schema', () => {
    // Arrange
    const input = { pattern: 'x', file_path: '/abs/dir' }

    // Act
    const repair = GrepTool.coerceInput!(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', path: '/abs/dir' })
    expect(repair!.shapeClass).toBe('file_path')
    expect(repair!.resultNote).toBe(`${NOTE_PREFIX}${READ_AS}`)
  })

  test('returns the repeated_file_path repair when path already matched', () => {
    // Arrange
    const input = { pattern: 'x', file_path: '/abs/dir', path: '/abs/dir' }

    // Act
    const repair = GrepTool.coerceInput!(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ pattern: 'x', path: '/abs/dir' })
    expect(repair!.shapeClass).toBe('repeated_file_path')
    expect(repair!.resultNote).toBe(`${NOTE_PREFIX}${REPEATED}`)
  })

  test('pH gate: null when the coerced input is still schema-invalid (missing pattern)', () => {
    // Arrange — cEt repairs file_path→path but `pattern` is required; the
    // coerced input fails strictObject, so pH nulls the repair (no note).
    const input = { file_path: '/abs/dir' }

    // Act / Assert — the raw coercion exists, but the tool-level gate nulls it.
    expect(coerceGrepInput(input)).not.toBeNull()
    expect(GrepTool.coerceInput!(input)).toBeNull()
  })

  test('pH gate: null when a leftover stray key breaks the strict schema', () => {
    // Arrange — path repair fires but `bogus` survives into the coerced input
    // and strictObject rejects it → pH nulls the whole repair.
    const input = { pattern: 'x', file_path: '/abs/dir', bogus: 1 }

    // Act / Assert
    expect(coerceGrepInput(input)).not.toBeNull()
    expect(GrepTool.coerceInput!(input)).toBeNull()
  })

  test('returns null for conflicting file_path vs path (cEt already null)', () => {
    const input = { pattern: 'x', file_path: '/abs/a', path: '/abs/b' }
    expect(GrepTool.coerceInput!(input)).toBeNull()
  })

  test('returns null for canonical input (no file_path) — nothing to repair', () => {
    expect(GrepTool.coerceInput!({ pattern: 'x', path: '/abs/dir' })).toBeNull()
    expect(GrepTool.coerceInput!({ pattern: 'x' })).toBeNull()
  })

  test('does NOT declare coerceInputBeforePluginHooks (byte-verified: that flag is Write-only)', () => {
    expect(GrepTool.coerceInputBeforePluginHooks).toBeUndefined()
  })
})
