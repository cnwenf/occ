/**
 * CC 2.1.304 #35: "/effort status, /effort ultracode and the prompt's effort
 * indicator showing a guessed effort level when CLAUDE_CODE_EFFORT_LEVEL is
 * auto or unset and no level is sent."
 *
 * Official fix (v2.1.304 linux-x64 ELF, byte-verified — OCC-164 supplement
 * round): all three display surfaces switched from the guesser `oR` (v303:
 * `function oR(e,n,r){let s=bw(e,n,{turnEffort:r})??"high";return O0(s)}`
 * @238103283 — fabricates a 'high' fallback from the display resolver) to the
 * undefined-aware SENT resolver `kWe` @240619154:
 *   `function kWe(e,n,r){let s=ek(e,n,{turnEffort:r});return s===void 0?void 0:Q0(s)}`
 *   `function Q0(e){if(typeof e==="string")return VS(e)?e:"high";return"high"}`
 * with the per-surface deltas:
 *   - status `f6t`: `let o=kWe(t,e);if(o===void 0)return{message:`Effort
 *     level: auto${r}`}` … else `Effort level: auto (currently ${e4(o)}${E})`
 *     (v304 also added the bare-auto guard and dropped the org suffix's
 *     guesser term; `e4` = String identity)
 *   - indicator `EE`: `function EE(h,R,L){return L?void 0:kWe(R,h)}` and the
 *     renderer `Mne` bails on a falsy level (`if(!h)return;`); v304 dropped
 *     v303 `_I`'s internal `Gb` model-support gate (OCC keeps the equivalent
 *     gate at the call site — its resolveAppliedEffort has no internal `Nh`)
 *   - ultracode toggle `D`: `let f=v(t.effort)??kWe(r,t.effort)??"auto"`
 *     (v303 `k` had no `??"auto"` fallback — could print "Effort stays
 *     undefined."). OCC's K3 envelope composes the "Effort stays auto." note
 *     conditionally (OCC's ultracode SETS xhigh, official's does not touch
 *     the effort value — documented divergence).
 * OCC symbol map: kWe=getSentEffortLevel (new), ek=resolveAppliedEffort,
 * Q0=normalizeSentEffortLevel, VS=isEffortLevel. getDisplayedEffortLevel
 * (≡ the retired guesser's OCC configured-base sibling) is retained as the
 * configured-display contract pinned by effortCap267/effortGap97 — no
 * production UI caller remains after this round.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  convertEffortValueToLevel,
  getDisplayedEffortLevel,
  getSentEffortLevel,
} from '../effort'
import { showCurrentEffort } from '../../commands/effort/effort'
import { getEffortNotificationText } from '../../components/EffortIndicator'
import { resetUltracode } from '../effort/ultracode'

const SAVED_ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_ULTRACODE',
  'USER_TYPE',
]
const savedEnv: Record<string, string | undefined> = {}
for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key]

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) delete process.env[key]
  resetUltracode()
})

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
  }
  resetUltracode()
})

describe('#35 getSentEffortLevel (official kWe = ek + Q0)', () => {
  test("env 'auto' → undefined (nothing is sent, so nothing is claimed)", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(getSentEffortLevel('claude-opus-4-7', undefined)).toBeUndefined()
    expect(getSentEffortLevel('claude-opus-4-7', 'medium')).toBeUndefined()
    expect(getSentEffortLevel('claude-sonnet-4-6', undefined)).toBeUndefined()
  })

  test("env 'unset' (any case) → undefined", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'UNSET'
    expect(getSentEffortLevel('claude-opus-4-7', undefined)).toBeUndefined()
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    expect(getSentEffortLevel('claude-opus-4-7', 'high')).toBeUndefined()
  })

  test('env absent → the materialized sent value (model default / appState)', () => {
    // opus-4-7 declares default_effort xhigh (Gap-97d) → it IS sent.
    expect(getSentEffortLevel('claude-opus-4-7', undefined)).toBe('xhigh')
    // sonnet-4-6 has no default → nothing is sent until the user sets one.
    expect(getSentEffortLevel('claude-sonnet-4-6', undefined)).toBeUndefined()
    expect(getSentEffortLevel('claude-sonnet-4-6', 'medium')).toBe('medium')
  })

  test('capability downgrades still apply to the sent value (xhigh→high on sonnet-4-6)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'xhigh'
    expect(getSentEffortLevel('claude-sonnet-4-6', undefined)).toBe('high')
    expect(getSentEffortLevel('claude-opus-4-7', undefined)).toBe('xhigh')
  })

  test('Q0 normalization: numeric effort → high (NO ant buckets, unlike the guesser)', () => {
    process.env.USER_TYPE = 'ant'
    // The old guesser bucketed ant numerics (30 → low); official Q0 maps any
    // non-string to 'high' — byte-faithful:
    //   `function Q0(e){if(typeof e==="string")return VS(e)?e:"high";return"high"}`
    expect(getSentEffortLevel('claude-sonnet-4-6', 30)).toBe('high')
    expect(convertEffortValueToLevel(30)).toBe('low') // guesser contrast
  })
})

describe('#35 showCurrentEffort (official f6t auto branch)', () => {
  test("env 'auto' → plain 'Effort level: auto' (the #35 fix — no guessed level)", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    const result = showCurrentEffort(undefined, 'claude-sonnet-4-6')
    expect(result.message).toBe('Effort level: auto')
    expect(result.message).not.toContain('currently')
  })

  test("env 'unset' → plain 'Effort level: auto'", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    expect(showCurrentEffort(undefined, 'claude-opus-4-7').message).toBe(
      'Effort level: auto',
    )
  })

  test('env absent + no materialized default → plain auto (sonnet-4-6 sends nothing)', () => {
    expect(showCurrentEffort(undefined, 'claude-sonnet-4-6').message).toBe(
      'Effort level: auto',
    )
  })

  test('env absent + sent default exists → auto (currently xhigh) for opus-4-7', () => {
    expect(showCurrentEffort(undefined, 'claude-opus-4-7').message).toBe(
      'Effort level: auto (currently xhigh)',
    )
  })

  test('explicit configured value → unchanged Current-effort branch', () => {
    const result = showCurrentEffort('medium', 'claude-sonnet-4-6')
    expect(result.message).toContain('Current effort level: medium')
  })

  test('coercion contrast: nothing sent → bare auto, while the legacy normalizer would coerce (regression contrast)', () => {
    // Official v303 `oR` fabricated `bw(...)??"high"` — a level shown when
    // nothing was sent. OCC's configured resolver never carried that exact
    // fallback (it returns undefined when nothing is configured), but the
    // legacy normalizer convertEffortValueToLevel still coerces unknown values
    // to 'high'. The #35 surfaces bypass both: with nothing sent the status
    // shows bare auto (and the chip hides), never a coerced level.
    expect(convertEffortValueToLevel('bogus-level')).toBe('high')
    expect(getDisplayedEffortLevel('claude-sonnet-4-6', undefined)).toBeUndefined()
    expect(getSentEffortLevel('claude-sonnet-4-6', undefined)).toBeUndefined()
    expect(showCurrentEffort(undefined, 'claude-sonnet-4-6').message).toBe(
      'Effort level: auto',
    )
  })
})

describe('#35 getEffortNotificationText (official EE + Mne)', () => {
  test("env 'auto' → indicator hidden (undefined), not a guessed chip", () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(
      getEffortNotificationText(undefined, 'claude-sonnet-4-6'),
    ).toBeUndefined()
    expect(
      getEffortNotificationText('medium', 'claude-sonnet-4-6'),
    ).toBeUndefined()
    expect(
      getEffortNotificationText(undefined, 'claude-opus-4-7'),
    ).toBeUndefined()
  })

  test('sent level present → the chip renders symbol + level + /effort', () => {
    expect(getEffortNotificationText('medium', 'claude-sonnet-4-6')).toBe(
      '◐ medium · /effort',
    )
    expect(getEffortNotificationText(undefined, 'claude-opus-4-7')).toBe(
      '◉ xhigh · /effort',
    )
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    expect(getEffortNotificationText(undefined, 'claude-sonnet-4-6')).toBe(
      '● high · /effort',
    )
  })

  test('nothing sent (no env, no appState, no default) → hidden', () => {
    expect(
      getEffortNotificationText(undefined, 'claude-sonnet-4-6'),
    ).toBeUndefined()
  })

  test('non-effort model gate is preserved (OCC call-site reduction)', () => {
    // Official v304 EE dropped its Gb gate because official ek gates model
    // support internally (Nh); OCC's resolveAppliedEffort has no internal
    // gate, so the call-site modelSupportsEffort check stays — same
    // observable outcome: no chip on a model that never sends effort.
    expect(
      getEffortNotificationText('high', 'claude-3-haiku-20240307'),
    ).toBeUndefined()
  })
})
