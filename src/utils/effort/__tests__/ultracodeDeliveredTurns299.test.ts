import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../../settings/types.js'
import {
  ULTRACODE_REMINDER_FULL,
  ULTRACODE_REMINDER_STILL,
  enableUltracodeForSession,
  getUltracodeTurnReminders,
  isUltracodeEnabled,
  isUltracodeSettingsFlag,
  resetUltracode,
} from '../ultracode.js'

/**
 * CC 2.1.299 #115: "Fixed Ultracode not being announced to scheduled tasks
 * and other delivered headless turns when `ultracode` is on in settings."
 *
 * Official forensics (v299/v296 ELF, /tmp/cc-diff-299 — offsets into
 * package/claude):
 *   - v296 @219246088: `Rd("ultra_effort_enter",()=>Promise.resolve(
 *     S?.isRegularUserPrompt?aLr(h,n):[]))` — reminder computed ONLY for
 *     regular user prompts; delivered turns were skipped.
 *   - v299 @227277280: `Td("ultra_effort_enter",()=>Promise.resolve(
 *     S?.isRegularUserPrompt||S?.deliveredTurnStart?yGr(h,n):[]))` — the
 *     single official diff: `||S?.deliveredTurnStart`.
 *   - deliveredTurnStart producer identical in both versions (v299
 *     @232231257 / v296 @224402433): delivered-turn attachment injection
 *     passes `{deliveredTurnStart:!0}`.
 *   - gate helpers identical: `oen`/`BXt` = `e.getAppState().ultracode===!0`
 *     (v299 @219479661 / v296 @211667418); `ch`/`zA` = `e===!0&&AO(n)`.
 *   - settings-schema `ultracode` key identical v296↔v299 (v299 @215529646 /
 *     v296 @208979371) — the describe text ported into types.ts is byte-exact.
 *
 * OCC adaptation: src/query.ts injects getUltracodeSystemReminders() on EVERY
 * API-loop turn with no prompt-type gate, so delivered turns (cron prompts
 * drained from the message queue by the REPL, teammate injections) already
 * flow through the same dispatcher as interactive turns. The missing half was
 * the settings-key consumer (official startup gate
 * `xzn(e)=Je().ultracode===!0||NNe(e)==="ultracode"`; staged occ139 §3.7b):
 * without it, "ultracode on in settings" never activated the session flag and
 * nothing was announced anywhere. These tests cover the schema key, the pure
 * settings gate, and the delivered-turn announcement (on → present, off →
 * absent) through the same dispatcher query.ts calls per turn.
 */

const ENV_KEY = 'CLAUDE_CODE_ULTRACODE'
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  resetUltracode()
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
  resetUltracode()
})

describe('CC 2.1.299 #115: settings schema accepts the `ultracode` key', () => {
  test('ultracode: true survives the schema parse (was stripped before)', () => {
    const parsed = SettingsSchema().parse({ ultracode: true })
    expect(parsed.ultracode).toBe(true)
  })

  test('ultracode: false is preserved', () => {
    const parsed = SettingsSchema().parse({ ultracode: false })
    expect(parsed.ultracode).toBe(false)
  })

  test('non-boolean ultracode falls back to undefined via .catch (official M().optional().catch(void 0))', () => {
    const parsed = SettingsSchema().parse({ ultracode: 'yes' })
    expect(parsed.ultracode).toBeUndefined()
  })

  test('absent key parses to undefined', () => {
    const parsed = SettingsSchema().parse({})
    expect(parsed.ultracode).toBeUndefined()
  })

  test('the official v299 describe text is attached to the key', () => {
    const shape = SettingsSchema().shape
    expect(shape.ultracode?.description).toBe(
      'Enable ultracode for the session: standing dynamic-workflow orchestration at any effort level. ' +
        'Session-scoped — typically provided via --settings or the apply_flag_settings control request; ' +
        'interactive toggles never persist it. Requires workflows to be enabled and a model that supports ultracode.',
    )
  })
})

describe('CC 2.1.299 #115: isUltracodeSettingsFlag (official xzn settings half, Je().ultracode===!0)', () => {
  test('strict === true gate', () => {
    expect(isUltracodeSettingsFlag({ ultracode: true })).toBe(true)
    expect(isUltracodeSettingsFlag({ ultracode: false })).toBe(false)
    expect(isUltracodeSettingsFlag({})).toBe(false)
    expect(isUltracodeSettingsFlag(null)).toBe(false)
    expect(isUltracodeSettingsFlag(undefined)).toBe(false)
  })

  test('truthy non-boolean values do NOT activate (fail-closed)', () => {
    expect(isUltracodeSettingsFlag({ ultracode: 'true' })).toBe(false)
    expect(isUltracodeSettingsFlag({ ultracode: 1 })).toBe(false)
  })
})

describe('CC 2.1.299 #115: delivered headless turns get the announcement', () => {
  // Simulates the main.tsx startup gate when the settings key is on, then the
  // per-turn dispatcher call that src/query.ts makes for EVERY API-loop turn —
  // including the turn a cron-delivered prompt (enqueuePendingNotification
  // mode:'prompt', drained by the REPL) or a teammate injection produces.

  test('settings-on: first delivered turn announces the full reminder', () => {
    // startup gate: xzn → settings half true → enableUltracodeForSession()
    expect(isUltracodeSettingsFlag({ ultracode: true })).toBe(true)
    enableUltracodeForSession()
    expect(isUltracodeEnabled()).toBe(true)

    const reminders = getUltracodeTurnReminders()
    const contents = reminders.map(r => r.content)
    expect(contents).toContain(ULTRACODE_REMINDER_FULL)
    expect(reminders.every(r => r.isMeta)).toBe(true)
  })

  test('settings-on: subsequent delivered turns announce the still-on reminder', () => {
    enableUltracodeForSession()
    getUltracodeTurnReminders() // consume the just-enabled turn
    const contents = getUltracodeTurnReminders().map(r => r.content)
    expect(contents).toContain(ULTRACODE_REMINDER_STILL)
  })

  test('settings-off: no announcement (fail-closed, unchanged path)', () => {
    expect(isUltracodeSettingsFlag({ ultracode: false })).toBe(false)
    expect(isUltracodeEnabled()).toBe(false)
    expect(getUltracodeTurnReminders()).toEqual([])
  })

  test('absent key + no flag + no env: dispatcher stays silent', () => {
    expect(isUltracodeSettingsFlag({})).toBe(false)
    expect(getUltracodeTurnReminders()).toEqual([])
  })

  test('env activation still announces (pre-existing source unaffected)', () => {
    process.env[ENV_KEY] = '1'
    expect(isUltracodeEnabled()).toBe(true)
    const contents = getUltracodeTurnReminders().map(r => r.content)
    // env path does not set justEnabled → the still-on reminder per turn.
    expect(contents).toContain(ULTRACODE_REMINDER_STILL)
  })
})
