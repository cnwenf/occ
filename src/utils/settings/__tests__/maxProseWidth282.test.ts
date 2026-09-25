import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../types'

/**
 * 2.1.282 PORT: `maxProseWidth` settings key.
 *
 * Official binary evidence (v2.1.282 linux-x64, /tmp/occ97b/package/claude):
 * - schema @194756308 (od -c byte-verified):
 *   `maxProseWidth:k().int().min(40).optional().catch(void 0).describe("…")`
 *   where k() = z.number() (cf. `bashOutputMaxChars:k().int().positive()`
 *   @194738138). int, min 40, NO max, optional; invalid values are silently
 *   caught to undefined → full terminal width (the default).
 * - positioned immediately after `syntaxHighlightingDisabled`, before
 *   `spellcheck` in the official schema object.
 * - absent from the v2.1.281 binary → new in 282.
 * - no env override exists (`CLAUDE_CODE_MAX_PROSE` grep: 0 hits).
 */

// Byte-exact official v2.1.282 .describe() text (ASCII apostrophe in
// "Claude's"), string-table copy @101314580.
const MAX_PROSE_WIDTH_DESCRIBE =
  "Maximum width, in terminal columns, of the prose in Claude's responses (paragraphs, headings, lists, blockquotes). In a wider terminal the prose wraps at this width while tables and code blocks keep the full width; only the display wraps, the response text itself gains no line breaks. Minimum 40. Unset (the default) uses the full terminal width."

describe('2.1.282 maxProseWidth settings schema key', () => {
  test('accepts integers at/above the official min of 40', () => {
    const r40 = SettingsSchema().safeParse({ maxProseWidth: 40 })
    expect(r40.success).toBe(true)
    if (r40.success) expect(r40.data.maxProseWidth).toBe(40)

    const r80 = SettingsSchema().safeParse({ maxProseWidth: 80 })
    expect(r80.success).toBe(true)
    if (r80.success) expect(r80.data.maxProseWidth).toBe(80)
  })

  test('has no maximum (official chain has .min(40) but no .max)', () => {
    const r = SettingsSchema().safeParse({ maxProseWidth: 100000 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.maxProseWidth).toBe(100000)
  })

  test('below-minimum is silently caught to undefined (official .catch(void 0))', () => {
    const r = SettingsSchema().safeParse({ maxProseWidth: 39 })
    // catch() swallows the failure — parse SUCCEEDS, key becomes undefined
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.maxProseWidth).toBeUndefined()
  })

  test('non-integer numbers are silently caught to undefined (official .int())', () => {
    const r = SettingsSchema().safeParse({ maxProseWidth: 80.5 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.maxProseWidth).toBeUndefined()
  })

  test('wrong types are silently caught to undefined', () => {
    for (const bad of ['80', null, true, {}]) {
      const r = SettingsSchema().safeParse({ maxProseWidth: bad })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.maxProseWidth).toBeUndefined()
    }
  })

  test('unset key parses to undefined (default = full terminal width)', () => {
    const r = SettingsSchema().safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.maxProseWidth).toBeUndefined()
  })

  test('strict parse accepts the key (Edit-tool validation compatibility)', () => {
    const r = SettingsSchema().strict().safeParse({ maxProseWidth: 100 })
    expect(r.success).toBe(true)
  })

  test('describe text is byte-exact from the official v2.1.282 binary', () => {
    const shape = SettingsSchema().shape
    expect(shape.maxProseWidth.description).toBe(MAX_PROSE_WIDTH_DESCRIBE)
  })

  test('key sits directly after syntaxHighlightingDisabled (official schema order)', () => {
    const keys = Object.keys(SettingsSchema().shape)
    const idx = keys.indexOf('syntaxHighlightingDisabled')
    expect(idx).toBeGreaterThan(-1)
    expect(keys[idx + 1]).toBe('maxProseWidth')
  })
})
