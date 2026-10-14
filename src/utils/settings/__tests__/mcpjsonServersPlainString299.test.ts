import { describe, expect, test } from 'bun:test'

import { SettingsSchema } from '../types.js'

/**
 * claude-code 2.1.299 changelog (line 57):
 *   "Fixed a settings file being ignored when `enabledMcpjsonServers` or
 *    `disabledMcpjsonServers` held a single server name (letters, digits, - or _)
 *    as a plain string"
 *
 * Root cause (OCC): both keys were `z.array(z.string()).optional()`. Settings are
 * validated with `SettingsSchema().strict().safeParse(json)` (validation.ts) and
 * parsed with `SettingsSchema().safeParse/.strip().parse` (settings.ts), so a
 * hand-written `"enabledMcpjsonServers": "github"` failed array validation and the
 * WHOLE settings file was rejected/ignored — not just that key.
 *
 * Fix: a `z.preprocess` coerces a single plain string matching `^[a-zA-Z0-9_-]+$`
 * (the changelog's "letters, digits, - or _") into a one-element array before the
 * array schema runs, so every downstream reader (`getProjectMcpServerStatus`
 * `.some`, the approval dialogs' spread/`|| []`, the migration's `.length`) keeps
 * seeing an array. A string that is NOT a bare server name (spaces, dots, empty)
 * is left untouched and still fails validation — genuinely malformed input stays
 * rejected. The inferred type remains `string[] | undefined`.
 */
describe('SettingsSchema — 2.1.299 #55 enabled/disabledMcpjsonServers plain string', () => {
  test('a single plain server-name string is coerced to a one-element array', () => {
    const enabled = SettingsSchema().safeParse({
      enabledMcpjsonServers: 'github',
    })
    expect(enabled.success).toBe(true)
    if (enabled.success) {
      expect(enabled.data.enabledMcpjsonServers).toEqual(['github'])
    }

    const disabled = SettingsSchema().safeParse({
      disabledMcpjsonServers: 'blocked-server_1',
    })
    expect(disabled.success).toBe(true)
    if (disabled.success) {
      expect(disabled.data.disabledMcpjsonServers).toEqual(['blocked-server_1'])
    }
  })

  test('the array form still parses unchanged', () => {
    const result = SettingsSchema().safeParse({
      enabledMcpjsonServers: ['a', 'b'],
      disabledMcpjsonServers: ['c'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabledMcpjsonServers).toEqual(['a', 'b'])
      expect(result.data.disabledMcpjsonServers).toEqual(['c'])
    }
  })

  test('a string that is not a bare server name stays invalid', () => {
    // Spaces / dots / empty are not "letters, digits, - or _" — left untouched,
    // so the array schema rejects them (settings file genuinely malformed).
    for (const bad of ['has space', 'a.b', '']) {
      const result = SettingsSchema().safeParse({
        enabledMcpjsonServers: bad,
      })
      expect(result.success).toBe(false)
    }
  })

  test('omitting the keys is still valid (optional)', () => {
    const result = SettingsSchema().safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabledMcpjsonServers).toBeUndefined()
      expect(result.data.disabledMcpjsonServers).toBeUndefined()
    }
  })
})
