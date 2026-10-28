import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEffortNotificationText, isEffortChangePending } from '../EffortIndicator.js'
import { resetUltracode } from '../../utils/effort/ultracode.js'
import { resetSentEffort, setSentEffort } from '../../utils/effort/sentEffort.js'
import { setTurnEffort } from '../../utils/effort/turnEffort.js'

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
  resetSentEffort()
  setTurnEffort(undefined)
})

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) delete process.env[key]
  resetUltracode()
  resetSentEffort()
  setTurnEffort(undefined)
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

// ---------------------------------------------------------------------------
// CC 2.1.312 item 16 — the mid-task effort-change note.
//
// Official indicator template UNCHANGED 311→312 (v312 `EH` @275881776):
//   function EH(h,x=!1,D=!1,H=!1){if(!h)return;
//     return`${D?"effort:":jQ(h)} ${h}${x?" · ultracode":""} · ${H?"may wait for your next message":"/effort"}`}
// The 4th flag H selects the literal `may wait for your next message`.
//
// 312 caller computes the flag (@276688231):
//   uT = sentEffort!==null && turnEffort===null
//        && sentEffort!==resolvedLevel && JEt(model)
// where `JEt(e){return Tir(e,Je(e))}` (v312 @243468953) is the
// per-turn-effort capability probe — OCC's modelSupportsPerTurnEffort.
//
// OCC renders the note through the same steady borderText chip (no 10s
// transient): the note "clears" naturally because the chip is derived
// per-render — once the model applies the new level (sentEffort == picked
// level) the flag goes false and the chip reverts to "· /effort".
// ---------------------------------------------------------------------------

describe('#16 effort indicator may-wait note (CC 2.1.312 official EH 4th flag)', () => {
  test('pending change shows "may wait for your next message" instead of "/effort"', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    setSentEffort('low')
    expect(isEffortChangePending('claude-sonnet-5-5', undefined)).toBe(true)
    const chip = getEffortNotificationText(undefined, 'claude-sonnet-5-5', true)
    expect(chip).toBeDefined()
    expect(chip?.endsWith('· may wait for your next message')).toBe(true)
    expect(chip?.includes('/effort')).toBe(false)
  })

  test('once sentEffort equals the picked level, the note reverts to "/effort"', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    setSentEffort('high')
    expect(isEffortChangePending('claude-sonnet-5-5', undefined)).toBe(false)
    const chip = getEffortNotificationText(undefined, 'claude-sonnet-5-5', false)
    expect(chip?.endsWith('· /effort')).toBe(true)
  })

  test('official 4-term condition: null slot / live turnEffort / equal levels / model gate each clear the flag', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    // term 1: sentEffort === null → no note
    setSentEffort(null)
    expect(isEffortChangePending('claude-sonnet-5-5', undefined)).toBe(false)
    // term 2: a live turn effort (ultrathink boost in force) → no note
    setSentEffort('low')
    setTurnEffort('xhigh')
    expect(isEffortChangePending('claude-sonnet-5-5', undefined)).toBe(false)
    setTurnEffort(undefined)
    // term 4: model WITHOUT the per_turn_effort capability → no note
    // (claude-opus-4-7 supports effort but is not in the v311/v312
    // per-turn-effort catalog — JEt ≡ per_turn_effort probe, byte-verified)
    expect(isEffortChangePending('claude-opus-4-7', undefined)).toBe(false)
    // positive control again with the slot restored
    expect(isEffortChangePending('claude-sonnet-5-5', undefined)).toBe(true)
  })

  test('default call shape (no flag argument) keeps the pre-312 chip', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    setSentEffort('low')
    const chip = getEffortNotificationText(undefined, 'claude-sonnet-5-5')
    expect(chip?.endsWith('· /effort')).toBe(true)
  })
})
