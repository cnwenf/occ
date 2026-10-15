import { describe, expect, test } from 'bun:test'

import { SettingsSchema, coerceMcpjsonServerStrings } from '../types.js'

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
 * Fix (official layering, merge-integrated): the coercion lives in
 * `coerceMcpjsonServerStrings` — the official `pOr` (@215649900) — called by
 * `parseSettingsFile` BEFORE schema validation and ONLY for non-policy sources
 * (official `Tt`: `if(!r?.policySource)pOr(e)`). The schema itself stays
 * `z.array(z.string())`: a schema-level `z.preprocess` would also coerce policy
 * files, diverging from the official gate (the policy-source behavior is pinned
 * in mcpjsonStringCoercion299.test.ts). Downstream readers keep seeing arrays;
 * strings that are NOT bare server names (spaces, dots, empty) are left
 * untouched and still fail validation — genuinely malformed input stays
 * rejected. The inferred type remains `string[] | undefined`.
 */
describe('2.1.299 #55 enabled/disabledMcpjsonServers plain string (coerce → schema)', () => {
  test('a single plain server-name string is coerced to a one-element array', () => {
    const enabledRaw: Record<string, unknown> = {
      enabledMcpjsonServers: 'github',
    }
    coerceMcpjsonServerStrings(enabledRaw)
    const enabled = SettingsSchema().safeParse(enabledRaw)
    expect(enabled.success).toBe(true)
    if (enabled.success) {
      expect(enabled.data.enabledMcpjsonServers).toEqual(['github'])
    }

    const disabledRaw: Record<string, unknown> = {
      disabledMcpjsonServers: 'blocked-server_1',
    }
    coerceMcpjsonServerStrings(disabledRaw)
    const disabled = SettingsSchema().safeParse(disabledRaw)
    expect(disabled.success).toBe(true)
    if (disabled.success) {
      expect(disabled.data.disabledMcpjsonServers).toEqual(['blocked-server_1'])
    }
  })

  test('the array form still parses unchanged', () => {
    const raw: Record<string, unknown> = {
      enabledMcpjsonServers: ['a', 'b'],
      disabledMcpjsonServers: ['c'],
    }
    coerceMcpjsonServerStrings(raw)
    const result = SettingsSchema().safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabledMcpjsonServers).toEqual(['a', 'b'])
      expect(result.data.disabledMcpjsonServers).toEqual(['c'])
    }
  })

  test('a string that is not a bare server name stays invalid', () => {
    // Spaces / dots / empty are not "letters, digits, - or _" — coercion leaves
    // them untouched, so the array schema rejects them (settings file genuinely
    // malformed).
    for (const bad of ['has space', 'a.b', '']) {
      const raw: Record<string, unknown> = { enabledMcpjsonServers: bad }
      coerceMcpjsonServerStrings(raw)
      const result = SettingsSchema().safeParse(raw)
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
