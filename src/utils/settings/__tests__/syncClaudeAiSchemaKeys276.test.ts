import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../types'

/**
 * claude-code 2.1.275/2.1.276: claude.ai skills/plugins sync settings keys.
 *
 * `syncClaudeAiSkills` / `syncClaudeAiPlugins` shipped dark in the official
 * 2.1.274 schema (identical in 2.1.276 — no 274→276 delta for these keys);
 * 2.1.275 announced/enabled the feature server-side. OCC implements no
 * claude.ai sync subsystem, so these keys are accepted for settings-file
 * compatibility ONLY: the strict Edit-tool validation
 * (src/utils/settings/validation.ts — `SettingsSchema().strict().safeParse`)
 * would otherwise reject them as `unrecognized_keys` and block edits when
 * users follow the official docs. Values are parsed but ignored.
 *
 * The .describe() texts below are byte-exact from the official v276 binary
 * (schema region @191113775 / @191114782; `H().optional().describe(…)` with
 * source-escaped `—` em-dashes). Key order mirrors the official schema:
 * directly after `cleanupPeriodDays`.
 */

// Byte-exact official v276 .describe() texts (runtime form — the binary's
// `—` escapes evaluate to em-dashes).
const SYNC_SKILLS_DESCRIBE =
  'Set to false to turn off syncing of the skills you have enabled on claude.ai. In your user settings (or managed settings): nothing more is downloaded, previously synced skills (~/.claude/skills/synced) can no longer be run, are hidden from every session started afterwards, and are moved to ~/.claude/skills/.trash at the next launch (deleted after cleanupPeriodDays; re-downloaded, not restored, if you re-enable). In .claude/settings.local.json or --settings: downloads stop and synced skills are blocked and hidden for sessions in that workspace or invocation only (nothing is moved). Not read from project settings (.claude/settings.json). Only false is honored — the feature is enabled server-side for your account, so setting true does not turn it on early. While it is on, synced skills are available in every session, re-synced every 10 minutes, and removed when you disable them on claude.ai. Only applies when signed in with your Claude account.'

const SYNC_PLUGINS_DESCRIBE =
  'Set to false to turn off syncing of the plugins you have enabled on claude.ai. In your user settings (or managed settings): nothing more is downloaded, previously synced plugins (~/.claude/plugins/synced) are hidden from every session started afterwards and moved to ~/.claude/plugins/.trash at the next launch (deleted after cleanupPeriodDays; re-downloaded, not restored, if you re-enable). In .claude/settings.local.json or --settings: downloads stop and synced plugins are hidden for sessions in that workspace or invocation only (nothing is moved). Not read from project settings (.claude/settings.json). Only false is honored — the feature is enabled server-side for your account, so setting true does not turn it on early. While it is on, synced plugins load in every session like plugins you installed yourself (a plugin you installed with the same name takes precedence), are re-synced at each launch, and are removed when you disable them on claude.ai. Only applies when signed in with your Claude account.'

describe('2.1.276 syncClaudeAi* settings schema keys (compat slice)', () => {
  test('strict parse accepts both keys with boolean values', () => {
    const result = SettingsSchema()
      .strict()
      .safeParse({ syncClaudeAiSkills: false, syncClaudeAiPlugins: true })
    expect(result.success).toBe(true)
  })

  test('strict parse accepts each key alone', () => {
    expect(
      SettingsSchema().strict().safeParse({ syncClaudeAiSkills: false }).success,
    ).toBe(true)
    expect(
      SettingsSchema().strict().safeParse({ syncClaudeAiPlugins: false })
        .success,
    ).toBe(true)
  })

  test('wrong types fail validation', () => {
    expect(
      SettingsSchema().safeParse({ syncClaudeAiSkills: 'no' }).success,
    ).toBe(false)
    expect(SettingsSchema().safeParse({ syncClaudeAiPlugins: 1 }).success).toBe(
      false,
    )
    expect(
      SettingsSchema().safeParse({ syncClaudeAiSkills: null }).success,
    ).toBe(false)
  })

  test('settings without the keys parse unchanged', () => {
    const result = SettingsSchema().safeParse({ cleanupPeriodDays: 30 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.syncClaudeAiSkills).toBeUndefined()
      expect(result.data.syncClaudeAiPlugins).toBeUndefined()
      expect(result.data.cleanupPeriodDays).toBe(30)
    }
  })

  test('describe texts are byte-exact from the official v276 binary', () => {
    const shape = SettingsSchema().shape
    expect(shape.syncClaudeAiSkills.description).toBe(SYNC_SKILLS_DESCRIBE)
    expect(shape.syncClaudeAiPlugins.description).toBe(SYNC_PLUGINS_DESCRIBE)
  })

  test('keys sit directly after cleanupPeriodDays (official schema order)', () => {
    const keys = Object.keys(SettingsSchema().shape)
    const cleanupIdx = keys.indexOf('cleanupPeriodDays')
    expect(cleanupIdx).toBeGreaterThan(-1)
    expect(keys[cleanupIdx + 1]).toBe('syncClaudeAiSkills')
    expect(keys[cleanupIdx + 2]).toBe('syncClaudeAiPlugins')
  })
})
