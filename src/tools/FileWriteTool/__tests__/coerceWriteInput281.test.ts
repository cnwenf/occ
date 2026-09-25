import { describe, expect, test } from 'bun:test'
import { coerceWriteInput, FileWriteTool } from '../FileWriteTool.js'

// The FileWriteTool module chain reads MACRO.VERSION at call time (permission
// path) — mirror the cli.tsx polyfill like coerceWriteInput280.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.281 changelog #041 — Write duplicate-alias dedup.
 * Byte-verified against the v281 ELF `ett()` @201115780 (marker
 * `new_text","body","text","contents` v280=0 / v281=1):
 *
 *   Zet=["file_text","file_content"],
 *   Rvn={file_path:["path","file"],
 *        content:[...Zet,"new_text","body","text","contents"]}
 *   ...
 *   for(let _ of["file_path","content"])
 *     for(let w of Rvn[_])
 *       if(typeof n[_]==="string"&&n[w]===n[_])
 *         delete n[w],r.push(`repeated_${w}`),
 *         s.push(`\`${w}\` repeated \`${_}\` and was ignored.`)
 *
 * An alias whose value EQUALS its canonical param is a harmless model
 * repeat → deleted, note recorded, call SUCCEEDS (v280 rejected it via
 * strictObject). Conflicting values stay → strictObject rejects.
 * The v280 coercion stage (coerceWriteInput280.test.ts) is unchanged.
 */
const NOTE_PREFIX =
  "Note: Write's parameters are named `file_path` and `content`. "

describe('2.1.281 #041 — coerceWriteInput dedup loop (binary ett @201115780)', () => {
  test('drops `path` when it repeats `file_path` — call succeeds with repeated_ note', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', content: 'x', path: '/abs/f.txt' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'x' })
    expect(repair!.shapeClass).toBe('repeated_path')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`path\` repeated \`file_path\` and was ignored.`,
    )
  })

  test('drops the NEW v281 content aliases (file/contents/body/text/new_text) when they repeat', () => {
    // Arrange — `file` repeats file_path; every content alias repeats content
    const input = {
      file_path: '/abs/f.txt',
      file: '/abs/f.txt',
      content: 'hello',
      file_text: 'hello',
      file_content: 'hello',
      new_text: 'hello',
      body: 'hello',
      text: 'hello',
      contents: 'hello',
    }

    // Act
    const repair = coerceWriteInput(input)

    // Assert — dedup walks Rvn order: file_path:[path,file] then
    // content:[file_text,file_content,new_text,body,text,contents]
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'hello' })
    expect(repair!.shapeClass).toBe(
      'repeated_file,repeated_file_text,repeated_file_content,repeated_new_text,repeated_body,repeated_text,repeated_contents',
    )
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`file\` repeated \`file_path\` and was ignored. ` +
        '`file_text` repeated `content` and was ignored. ' +
        '`file_content` repeated `content` and was ignored. ' +
        '`new_text` repeated `content` and was ignored. ' +
        '`body` repeated `content` and was ignored. ' +
        '`text` repeated `content` and was ignored. ' +
        '`contents` repeated `content` and was ignored.',
    )
  })

  test('a single repeated alias is dropped and the coerced call passes the schema (coerceInput succeeds)', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', content: 'x', text: 'x' }

    // Act
    const repair = FileWriteTool.coerceInput(input)

    // Assert — v280 returned null here (strictObject rejected `text`);
    // v281 dedups so the call SUCCEEDS.
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'x' })
    expect(repair!.shapeClass).toBe('repeated_text')
  })

  test('CONFLICTING alias values are NOT deduped — strictObject still rejects', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', content: 'x', text: 'DIFFERENT' }

    // Act
    const repair = coerceWriteInput(input)

    // Assert — nothing changed → no repair; the raw input fails the schema
    expect(repair).toBeNull()
    expect(FileWriteTool.coerceInput(input)).toBeNull()
    expect(FileWriteTool.inputSchema.safeParse(input).success).toBe(false)
  })

  test('conflicting `path` alongside canonical `file_path` is still rejected', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', path: '/other/f.txt', content: 'x' }

    // Act + Assert
    expect(coerceWriteInput(input)).toBeNull()
    expect(FileWriteTool.coerceInput(input)).toBeNull()
  })

  test('dedup composes with the v280 path coercion (`path` alone still coerces first)', () => {
    // Arrange — only the alias present: coercion renames it, dedup has
    // nothing left to drop (v280 behavior preserved)
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

  test('dedup composes with description-drop (official order: coerce → drop → dedup)', () => {
    // Arrange
    const input = {
      file_path: '/abs/f.txt',
      content: 'x',
      description: 'ignored me',
      body: 'x',
    }

    // Act
    const repair = coerceWriteInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair!.input).toEqual({ file_path: '/abs/f.txt', content: 'x' })
    expect(repair!.shapeClass).toBe('drop_description,repeated_body')
    expect(repair!.resultNote).toBe(
      `${NOTE_PREFIX}\`description\` was ignored. \`body\` repeated \`content\` and was ignored.`,
    )
  })

  test('non-string canonical values disable dedup (official typeof guard)', () => {
    // Arrange — content is a number: `text` with the same-looking value must
    // NOT be deduped
    const input = { file_path: '/abs/f.txt', content: 42, text: 42 }

    // Act + Assert
    expect(coerceWriteInput(input)).toBeNull()
  })

  test('clean canonical input needs no repair (unchanged v280 behavior)', () => {
    // Arrange
    const input = { file_path: '/abs/f.txt', content: 'x' }

    // Act + Assert
    expect(coerceWriteInput(input)).toBeNull()
    expect(FileWriteTool.coerceInput(input)).toBeNull()
    expect(FileWriteTool.inputSchema.safeParse(input).success).toBe(true)
  })
})
