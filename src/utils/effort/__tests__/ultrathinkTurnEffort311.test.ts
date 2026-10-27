import { afterEach, describe, expect, test } from 'bun:test'
import { getIsRemoteMode, setIsRemoteMode } from '../../../bootstrap/state.js'
import {
  effortOrdinal,
  getSentEffortLevel,
  resolveAppliedEffort,
} from '../../effort.js'
import {
  applyUltrathinkTurnEffortBoost,
  canBoostTurnEffortForUltrathink,
  shouldBoostTurnEffortForUltrathink,
} from '../ultrathinkBoost.js'
import {
  ULTRATHINK_TURN_EFFORT,
  getTurnEffort,
  modelSupportsPerTurnEffort,
  setTurnEffort,
} from '../turnEffort.js'

/**
 * claude-code 2.1.311 triage-T4-sweep item 65 — ultrathink raises the turn's
 * reasoning effort to `xhigh`.
 *
 * Official v311 handler `ql` (@257369783, byte-verified; absent from the v310
 * binary, so it is new in 2.1.311):
 *   `function ql(e,n,r,s){try{if(!(jnr(n,r)&&e.some(...Nce(S.preExpansionValue).length>0)))return;
 *     let y=tn({type:"ultrathink_effort"},s);
 *     return g("ultrathink_boost"),a("tengu_ultrathink",{}),
 *       qbt(et()).setTurnEffort("xhigh"),
 *       {layer:{kind:"effort",effort:"xhigh"},reminder:y}}catch(h){l(h);return}}`
 *
 * Official gate `jnr`/`REt` (@243588108 / @243587988, byte-verified):
 *   `function REt(e,n){return ITt()&&!_e()&&ce(e)&&Zqr(e)&&typeof _S(e,n)==="string"&&_S(e,n,{turnEffort:"xhigh"})==="xhigh"}`
 *   `function jnr(e,n){return REt(e,n)&&h(AH(e,n))<h("xhigh")}`
 *   `function ce(e){return QS(e)&&!Rt()&&dA()===void 0}`
 *   `function Zqr(e){return fot(e,Je(e))}`  // per_turn_effort capability
 *   `function h(e){return ma.indexOf(e)}`   // effort ordinal
 *   `var ma=["low","medium","high","xhigh","max"]`   (@239566818)
 *
 * `per_turn_effort` catalog membership (v311 model registry, byte-verified at
 * @239158609 `{id:"claude-haiku-5-5"…}`, @239163899 `{id:"claude-sonnet-5-5"…}`,
 * @239170412 `{id:"claude-opus-5-5"…}`, @239172488 `{id:"claude-fable-5-1"…}`)
 * is exactly the four models the triage doc lists. The fifth `"per_turn_effort"`
 * string in the binary (@239178434) is the capability-NAME enum `$ts=[…]`, not
 * a fifth model — verified, so the allowlist below is complete.
 */

const SAVED_EFFORT_ENV = process.env.CLAUDE_CODE_EFFORT_LEVEL
const SAVED_REMOTE = getIsRemoteMode()

afterEach(() => {
  if (SAVED_EFFORT_ENV === undefined) {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  } else {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = SAVED_EFFORT_ENV
  }
  setIsRemoteMode(SAVED_REMOTE)
  setTurnEffort(undefined)
})

describe('2.1.311 #65: effort ordinal (official h / ma)', () => {
  test('orders low < medium < high < xhigh < max', () => {
    expect(effortOrdinal('low')).toBeLessThan(effortOrdinal('medium'))
    expect(effortOrdinal('medium')).toBeLessThan(effortOrdinal('high'))
    expect(effortOrdinal('high')).toBeLessThan(effortOrdinal('xhigh'))
    expect(effortOrdinal('xhigh')).toBeLessThan(effortOrdinal('max'))
  })

  test('ULTRATHINK_TURN_EFFORT is xhigh', () => {
    expect(ULTRATHINK_TURN_EFFORT).toBe('xhigh')
  })
})

describe('2.1.311 #65: modelSupportsPerTurnEffort (official fot/Ywn)', () => {
  test.each([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
  ])('is true for %s', model => {
    expect(modelSupportsPerTurnEffort(model)).toBe(true)
  })

  test.each([
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-3-5-sonnet-20241022',
  ])('is false for %s (no per_turn_effort capability)', model => {
    expect(modelSupportsPerTurnEffort(model)).toBe(false)
  })

  test('is case-insensitive', () => {
    expect(modelSupportsPerTurnEffort('CLAUDE-Opus-5-5')).toBe(true)
  })
})

describe('2.1.311 #65: turn-effort store (official setTurnEffort)', () => {
  test('starts unset', () => {
    expect(getTurnEffort()).toBeUndefined()
  })

  test('round-trips a level and clears back to undefined', () => {
    setTurnEffort('xhigh')
    expect(getTurnEffort()).toBe('xhigh')
    setTurnEffort(undefined)
    expect(getTurnEffort()).toBeUndefined()
  })
})

describe('2.1.311 #65: resolveAppliedEffort honors the turnEffort slot', () => {
  test('turnEffort wins over the appState value (official _S precedence)', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    expect(resolveAppliedEffort('claude-opus-5-5', 'low', 'xhigh')).toBe('xhigh')
  })

  test('turnEffort wins over the model default', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    expect(resolveAppliedEffort('claude-opus-5-5', undefined, 'xhigh')).toBe(
      'xhigh',
    )
  })

  test('an explicit env override still wins over turnEffort', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'low'
    expect(resolveAppliedEffort('claude-opus-5-5', undefined, 'xhigh')).toBe('low')
  })

  test('turnEffort never downgrades a higher appState value (floor semantics)', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    expect(resolveAppliedEffort('claude-opus-5-5', 'max', 'xhigh')).toBe('max')
    expect(resolveAppliedEffort('claude-opus-5-5', 'xhigh', 'xhigh')).toBe('xhigh')
  })

  test('a live turnEffort store value reaches the resolver without an argument', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setTurnEffort('xhigh')
    expect(resolveAppliedEffort('claude-opus-5-5', 'low')).toBe('xhigh')
    expect(getSentEffortLevel('claude-opus-5-5', 'low')).toBe('xhigh')
  })

  test('turnEffort is clamped for a model without xhigh support', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    expect(resolveAppliedEffort('claude-opus-4-6', undefined, 'xhigh')).toBe(
      'high',
    )
  })
})

describe('2.1.311 #65: canBoostTurnEffortForUltrathink (official jnr, env half)', () => {
  test('is true for a per_turn_effort model below xhigh', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(false)
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', undefined)).toBe(
      true,
    )
  })

  test('is false for a model without per_turn_effort', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(false)
    expect(canBoostTurnEffortForUltrathink('claude-opus-4-8', undefined)).toBe(
      false,
    )
  })

  test('is false in a remote session (official ce -> !Rt())', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(true)
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', undefined)).toBe(
      false,
    )
  })

  test('is false when CLAUDE_CODE_EFFORT_LEVEL is set (official ce -> dA()===void 0)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    setIsRemoteMode(false)
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', undefined)).toBe(
      false,
    )
  })

  test('is false when CLAUDE_CODE_EFFORT_LEVEL is unset/auto', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    setIsRemoteMode(false)
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', undefined)).toBe(
      false,
    )
  })

  test('is false when the current effort is already xhigh (no headroom)', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(false)
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', 'xhigh')).toBe(
      false,
    )
  })

  test('is false when the current effort is max (above xhigh)', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(false)
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', 'max')).toBe(false)
  })

  test('is independent of a stale turnEffort store value', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(false)
    setTurnEffort('xhigh')
    expect(canBoostTurnEffortForUltrathink('claude-opus-5-5', undefined)).toBe(
      true,
    )
  })
})

describe('2.1.311 #65: applyUltrathinkTurnEffortBoost (official ql)', () => {
  test('leaves the store unset and reports no boost when the gate is closed', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(true)
    expect(
      applyUltrathinkTurnEffortBoost('ultrathink this', 'claude-opus-5-5', undefined),
    ).toBe(false)
    expect(getTurnEffort()).toBeUndefined()
  })

  test('clears a previous turn effort when the new prompt does not boost', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(true)
    setTurnEffort('xhigh')
    applyUltrathinkTurnEffortBoost('plain prompt', 'claude-opus-5-5', undefined)
    expect(getTurnEffort()).toBeUndefined()
  })

  test('does not boost on a quoted ultrathink occurrence (official Nce filter)', () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setIsRemoteMode(false)
    expect(
      shouldBoostTurnEffortForUltrathink(
        'what does `ultrathink` mean',
        'claude-opus-5-5',
        undefined,
      ),
    ).toBe(false)
  })
})
