import { describe, expect, test } from 'bun:test'
import { coerceWriteInput, FileWriteTool } from '../FileWriteTool.js'

// The FileWriteTool module chain reads MACRO.VERSION at call time (permission
// path) — mirror the cli.tsx polyfill like writeToDirectory278.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official Claude Code v2.1.280 changelog entry #008 — Write-tool input
 * coercion. Byte-verified against the v280 linux-x64 ELF:
 *
 * - @198306051 `fxn=["file_text","file_content"]` + `bZe(e)` — the coercion
 *   function ported here as `coerceWriteInput`.
 * - @198309000 Write-tool def: `coerceInputBeforePluginHooks:!0,coerceInput(e)
 *   {let n=bZe(e);return n!==null&&yxn()&&vZe().safeParse(n.input).success?n:null}`
 * - @198308036 `yxn(){return x("tengu_noble_mountain",!0)}` — default-true
 *   statsig gate; OCC implements it as unconditional (default-true ≡ always on).
 * - @192662800 `En="Write"` — the tool-name constant interpolated into the
 *   note template `${En}'s parameters are named \`file_path\` and \`content\`. `
 */
const NOTE_PREFIX =
  "Note: Write's parameters are named `file_path` and `content`. "

describe('2.1.280 #008 — coerceWriteInput (binary bZe @198306051)', () => {
  test('coerces file_text → content with the byte-exact note + shapeClass', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', file_text: 'hello' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'hello' })
    expect(repair!.shapeClass).toBe('file_text')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`file_text\` was read as \`content\`.`,
    )
  })

  test('coerces file_content → content with the byte-exact note', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', file_content: 'hello' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'hello' })
    expect(repair!.shapeClass).toBe('file_content')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`file_content\` was read as \`content\`.`,
    )
  })

  test('coerces path → file_path (byte-evident: official DOES coerce the path spelling)', () => {
    // Arrange
    const input = { path: '/abs/f.txt', content: 'x' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'x' })
    expect(repair!.shapeClass).toBe('path')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`path\` was read as \`file_path\`.`,
    )
  })

  test('drops a description param and notes it', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', content: 'x', description: 'd' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'x' })
    expect(repair!.shapeClass).toBe('drop_description')
    expect(repair!.resultNote).toBe(`${NOTE_PREFIX}\`description\` was ignored.`)
  })

  test('applies all three repairs in binary order — shapeClass comma-joined, sentences space-joined', () => {
    // Arrange
    const input = { path: '/abs/f.txt', file_text: 'hello', description: 'd' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert — binary bZe order: path first, then content key, then description.
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'hello' })
    expect(repair!.shapeClass).toBe('path,file_text,drop_description')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`path\` was read as \`file_path\`. \`file_text\` was read as \`content\`. \`description\` was ignored.`,
    )
  })

  test('precedence: an own content key wins — file_content is NOT coerced', () => {
    // Arrange — binary guard: `!Object.hasOwn(n,"content")`.
    const input = { file_path: '/abs/f.txt', content: 'a', file_content: 'b' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert — nothing else to repair, so no repair record at all.
    expect(repair).toBeNull()
  })

  test('precedence: both file_text AND file_content present → no content coercion (binary g.length===1)', () => {
    // Arrange
    const input = {
      file_path: '/abs/f.txt',
      file_text: 'a',
      file_content: 'b',
    }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).toBeNull()
  })

  test('precedence: an own file_path key wins — path is left untouched', () => {
    // Arrange — binary guard: `!Object.hasOwn(n,"file_path")`.
    const input = { file_path: '/abs/a.txt', content: 'x', path: '/abs/b.txt' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).toBeNull()
  })

  test('does not coerce non-string values (binary typeof guards)', () => {
    // Arrange / Act / Assert
    expect(coerceWriteInput({ file_path: '/a', file_text: 42 })).toBeNull()
    expect(coerceWriteInput({ path: 123, content: 'x' })).toBeNull()
    // `{path, file_text: null}`: binary bZe filters candidate content keys by
    // hasOwn ONLY (`fxn.filter(y=>Object.hasOwn(n,y))`); the typeof-string
    // guard skips just the CONTENT coercion, while the independent path repair
    // still fires and the non-string file_text key is left in the output.
    const repair = coerceWriteInput({ path: '/a', file_text: null })
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/a', file_text: null })
    expect(repair!.shapeClass).toBe('path')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`path\` was read as \`file_path\`.`,
    )
  })

  test('returns null for non-record inputs (binary Q() guard)', () => {
    // Arrange / Act / Assert
    expect(coerceWriteInput(null)).toBeNull()
    expect(coerceWriteInput('nope')).toBeNull()
    expect(coerceWriteInput(42)).toBeNull()
    expect(coerceWriteInput([{ file_path: '/a', file_text: 'x' }])).toBeNull()
  })

  test('returns null for canonical input — nothing to repair', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', content: 'x' }

    // Act / Assert — binary: `return r.length?{...}:null`
    expect(coerceWriteInput(input)).toBeNull()
  })

  test('never mutates the original input (binary copies via spread first)', () => {
    // Arrange
    const input = { path: '/abs/f.txt', file_text: 'hello', description: 'd' }
    const snapshot = JSON.stringify(input)

    // Act
    coerceWriteInput(input)

    // Assert
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('2.1.280 #008 — FileWriteTool.coerceInput (binary Write def @198309000)', () => {
  test('returns the repair when the coerced input passes the input schema', () => {
    // Arrange
    const input = { path: '/abs/f.txt', file_text: 'hello' }

    // Act
    const repair = FileWriteTool.coerceInput!(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'hello' })
    expect(repair!.shapeClass).toBe('path,file_text')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`path\` was read as \`file_path\`. \`file_text\` was read as \`content\`.`,
    )
  })

  test('returns null when the coerced input is still schema-invalid (binary vZe().safeParse guard)', () => {
    // Arrange — bZe repairs path→file_path but content is still missing; the
    // tool-level guard rejects the partial repair so validation proceeds on
    // the ORIGINAL input (and no note is produced).
    const input = { path: '/abs/f.txt' }

    // Act
    const repair = FileWriteTool.coerceInput!(input)

    // Assert — the raw repair exists, but the tool-level coerceInput nulls it.
    expect(coerceWriteInput(input)).not.toBeNull()
    expect(repair).toBeNull()
  })

  test('returns null when a leftover misnamed key breaks the strict schema', () => {
    // Arrange — content wins over file_content (no content coercion), but the
    // path repair still fires; the leftover file_content key makes the coerced
    // input fail strictObject → guard nulls the whole repair.
    const input = { path: '/abs/f.txt', content: 'a', file_content: 'b' }

    // Act / Assert
    expect(coerceWriteInput(input)).not.toBeNull()
    expect(FileWriteTool.coerceInput!(input)).toBeNull()
  })

  test('returns null for canonical input', () => {
    expect(
      FileWriteTool.coerceInput!({ file_path: '/abs/f.txt', content: 'x' }),
    ).toBeNull()
  })

  test('declares coerceInputBeforePluginHooks: true (byte-verified on the Write def)', () => {
    expect(FileWriteTool.coerceInputBeforePluginHooks).toBe(true)
  })
})
