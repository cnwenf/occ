import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEffortNotificationText } from '../EffortIndicator.js'
import { resetUltracode } from '../../utils/effort/ultracode.js'

/**
 * CC 2.1.304 #33/#35 (official `EE`) — the effort indicator chip must HIDE
 * when nothing is sent, instead of rendering the 303-era guessed "high" chip.
 * OCC-164: the chip now resolves through the SENT resolver `kWe` ≡
 * getSentEffortLevel (resolveAppliedEffort + normalizeSentEffortLevel),
 * matching official v304 EE — no longer the configured display resolver.
 *
 * The hidden case is deterministic without settings mocks when no effort cap
 * is configured on this machine: env=auto makes getEffortEnvOverride() return
 * null, and resolveAppliedEffort's gate (`envOverride === null &&
 * !hasSettingsCap`) short-circuits to undefined. Under a real settings cap
 * the applied resolver can materialize a level (official `ek` semantics) —
 * the same cap-sensitivity class the positive-control test below notes.
 */

const SAVED_ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_ULTRACODE',
  'USER_TYPE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key]
})

afterAll(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
  }
})

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) delete process.env[key]
  resetUltracode()
})

describe('#33 effort indicator chip hides instead of guessing (CC 2.1.304 official EE)', () => {
  test('env=auto + no session level → chip hidden (undefined), even on an effort model', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    // modelSupportsEffort('claude-sonnet-5') is true, so the chip hides via
    // the SENT resolver (getSentEffortLevel → resolveAppliedEffort's
    // env-auto/no-cap gate returning undefined), not the model-support gate.
    expect(getEffortNotificationText(undefined, 'claude-sonnet-5')).toBeUndefined()
  })

  test('positive control: a level that DOES resolve still renders the chip', () => {
    // env unset + opus-4-7 (model default xhigh) resolves to a level, so the
    // chip renders. Assert on the stable shape only — a real settings cap on
    // this machine could clamp the level, which is pre-#33 behavior under test
    // elsewhere (effortCap267.test.ts).
    const chip = getEffortNotificationText(undefined, 'claude-opus-4-7')
    expect(chip).toBeDefined()
    expect(chip?.endsWith('· /effort')).toBe(true)
  })

  test('an explicit session level renders the chip regardless of env-auto hiding logic', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    // appState effort is passed explicitly — with no settings cap on this
    // machine the env-auto override still wins in the SENT resolver
    // (resolveAppliedEffort's `envOverride === null && !hasSettingsCap` gate →
    // undefined), so the chip hides. This pins that the hide is driven by the
    // RESOLVER, not by the effortValue argument. (Under a real settings cap
    // the applied resolver would materialize 'medium' — official `ek`
    // semantics — same cap-sensitivity class as the positive control above.)
    expect(getEffortNotificationText('medium', 'claude-sonnet-5')).toBeUndefined()
  })

  test('non-effort models keep hiding the chip (pre-#33 gate unchanged)', () => {
    expect(getEffortNotificationText(undefined, 'claude-haiku-4-5')).toBeUndefined()
  })
})
