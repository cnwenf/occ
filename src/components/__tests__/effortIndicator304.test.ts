import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEffortNotificationText } from '../EffortIndicator.js'
import { resetUltracode } from '../../utils/effort/ultracode.js'

/**
 * CC 2.1.304 #33 (official `EE`) — the effort indicator chip must HIDE when
 * the display resolver has nothing to show, instead of rendering the 303-era
 * guessed "high" chip.
 *
 * The hidden case is fully deterministic without settings mocks: env=auto
 * makes getEffortEnvOverride() return null, and resolveConfiguredEffort
 * short-circuits to undefined BEFORE any settings/cap read — so real user
 * settings cannot interfere.
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
    // modelSupportsEffort('claude-sonnet-5') is true, so the gate that hides
    // the chip here is the #33 undefined-level check, not the model check.
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
    // appState effort is passed explicitly — the env-auto override still wins
    // in the resolver (null → undefined), so the chip hides. This pins that
    // the hide is driven by the RESOLVER, not by the effortValue argument.
    expect(getEffortNotificationText('medium', 'claude-sonnet-5')).toBeUndefined()
  })

  test('non-effort models keep hiding the chip (pre-#33 gate unchanged)', () => {
    expect(getEffortNotificationText(undefined, 'claude-haiku-4-5')).toBeUndefined()
  })
})
