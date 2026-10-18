/**
 * occ162-01 — official 2.1.302 `statusLine.hideVimModeIndicator` schema pin.
 *
 * Byte-verified from the official linux-x64 ELF (md5
 * 39885c1377a0f0d922b73bf8653a6c3f), `grep -aboF 'hideVimModeIndicator'`
 * @234708166 — settings schema module:
 *
 *   `statusLine:()=>u({type:A("command"),command:o(),padding:v().optional(),
 *    refreshInterval:v().min(1).optional().catch(void 0).describe("Re-run the
 *    status line command every N seconds in addition to event-driven
 *    updates"),hideVimModeIndicator:M().optional().describe("Hide the
 *    built-in `-- INSERT --` / `-- VISUAL --` indicator below the prompt.
 *    Use this when your status line script renders `vim.mode` itself.")})
 *    .optional().describe("Custom status line display configuration")`
 *
 * Position: LAST key of the statusLine object, immediately after
 * refreshInterval. `M()` = boolean — cross-checked in the same schema module
 * via `alwaysThinkingEnabled:()=>M().optional()` @234727953 (OCC types
 * alwaysThinkingEnabled as z.boolean()).
 *
 * Consumer (byte-verified @267046486): `const gr=er?.hideVimModeIndicator??!1`
 * → prop `hideVimModeIndicator:gr` on the footer hint line; see
 * vimIndicatorGate302.test.ts for the gate pins.
 */
import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../types'

const OFFICIAL_DESCRIBE =
  'Hide the built-in `-- INSERT --` / `-- VISUAL --` indicator below the prompt. Use this when your status line script renders `vim.mode` itself.'

// statusLine is z.object({...}).optional() — unwrap to the object shape.
function statusLineShape(): Record<string, { description?: string }> {
  const statusLine = SettingsSchema().shape.statusLine as unknown as {
    unwrap(): { shape: Record<string, { description?: string }> }
  }
  return statusLine.unwrap().shape
}

describe('statusLine.hideVimModeIndicator — official 2.1.302 schema', () => {
  test('key set and order match the official statusLine object', () => {
    // Official order (byte-verified): type, command, padding,
    // refreshInterval, hideVimModeIndicator (last, right after
    // refreshInterval).
    expect(Object.keys(statusLineShape())).toEqual([
      'type',
      'command',
      'padding',
      'refreshInterval',
      'hideVimModeIndicator',
    ])
  })

  test('describe text is byte-identical to the official', () => {
    expect(statusLineShape().hideVimModeIndicator.description).toBe(
      OFFICIAL_DESCRIBE,
    )
  })

  test('accepts booleans inside a valid statusLine block', () => {
    for (const value of [true, false]) {
      const parsed = SettingsSchema().safeParse({
        statusLine: {
          type: 'command',
          command: 'echo hi',
          hideVimModeIndicator: value,
        },
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.statusLine?.hideVimModeIndicator).toBe(value)
      }
    }
  })

  test('optional — statusLine parses without it and the key stays absent', () => {
    const parsed = SettingsSchema().safeParse({
      statusLine: { type: 'command', command: 'echo hi' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(
        Object.hasOwn(
          parsed.data.statusLine ?? {},
          'hideVimModeIndicator',
        ),
      ).toBe(false)
    }
  })

  test('rejects non-boolean values (official M() = boolean)', () => {
    const parsed = SettingsSchema().safeParse({
      statusLine: {
        type: 'command',
        command: 'echo hi',
        hideVimModeIndicator: 'yes',
      },
    })
    expect(parsed.success).toBe(false)
  })
})
