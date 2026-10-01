import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

/**
 * CC 2.1.286 (item-A): per-model-family fast-rejection store — binary `Ll`
 * (@199318400-199322600) + detectors `lOe`/`aBo`/`rBt`/`SYn`/`n9e`
 * (@206125600+, all byte-verified).
 *
 * "Fixed refusal and --fallback-model retries failing when the fallback model
 * can't run fast; they now run at standard speed, with a one-time notice in
 * interactive sessions." (The notice plugin qot/efo @226000442 is STAGED —
 * the onFallbackModelFastRejected signal below is its wiring point; the
 * one-time behavior is pinned here at the signal level.)
 */

const {
  clearFastRejectedFallbackModels,
  hasEverOrFallbackFastRejected,
  isFastRejectedFallback,
  isSpeedParamRejection,
  markFastRejected,
  modelFamilyKey,
  onFallbackModelFastRejected,
  onFastRejectedFallbackModelsChanged,
  resetFastRejectionStore,
} = require('../fastRejection.js') as typeof import('../fastRejection.js')

beforeEach(() => {
  resetFastRejectionStore()
})

afterEach(() => {
  resetFastRejectionStore()
})

function speedRejection400(quotedModel: string): APIError {
  const message = `'${quotedModel}' does not support the \`speed\` parameter`
  return new APIError(400, { message }, message, undefined)
}

describe('2.1.286 item-A — modelFamilyKey (binary Mh = kt(Ue(e,{identity:!0})))', () => {
  test('strips the trailing [1m] tag', () => {
    expect(modelFamilyKey('claude-opus-5[1m]')).toBe(modelFamilyKey('claude-opus-5'))
  })

  test('keys the same family to the same value across spelling variants', () => {
    // Dated and undated spellings of one family share a key.
    expect(modelFamilyKey('claude-sonnet-4-5')).toBe(
      modelFamilyKey('claude-sonnet-4-5-20250929'),
    )
  })
})

describe('2.1.286 item-A — isSpeedParamRejection (binary lOe)', () => {
  test('matches the official 400 message for the same model family', () => {
    expect(
      isSpeedParamRejection(
        speedRejection400('claude-sonnet-4-5'),
        'claude-sonnet-4-5[1m]',
      ),
    ).toBe(true)
  })

  test('rejects when the quoted model is a different family', () => {
    expect(
      isSpeedParamRejection(speedRejection400('claude-sonnet-4-5'), 'claude-opus-5'),
    ).toBe(false)
  })

  test('rejects non-400 statuses', () => {
    const message = "'claude-opus-5' does not support the `speed` parameter"
    expect(
      isSpeedParamRejection(
        new APIError(429, { message }, message, undefined),
        'claude-opus-5',
      ),
    ).toBe(false)
  })

  test('rejects non-APIErrors and unrelated 400s', () => {
    expect(
      isSpeedParamRejection(
        new Error("'claude-opus-5' does not support the `speed` parameter"),
        'claude-opus-5',
      ),
    ).toBe(false)
    const other = new APIError(400, { message: 'invalid' }, 'invalid', undefined)
    expect(isSpeedParamRejection(other, 'claude-opus-5')).toBe(false)
  })
})

describe('2.1.286 item-A — markFastRejected (binary aBo) + one-time notice', () => {
  test('records the family and forces standard speed for it this session', () => {
    expect(isFastRejectedFallback('claude-opus-5')).toBe(false)
    markFastRejected('claude-opus-5[1m]')
    // Family key match — the raw suffixed model and the bare one both hit.
    expect(isFastRejectedFallback('claude-opus-5')).toBe(true)
    expect(isFastRejectedFallback('claude-opus-5[1m]')).toBe(true)
    expect(hasEverOrFallbackFastRejected('claude-opus-5')).toBe(true)
  })

  test('the notice signal fires exactly once per family (one-time notice)', () => {
    const noticed: string[] = []
    const unsubscribe = onFallbackModelFastRejected((model: string) => {
      noticed.push(model)
    })
    markFastRejected('claude-opus-5')
    markFastRejected('claude-opus-5') // binary aBo: early-return when already present
    markFastRejected('claude-opus-5[1m]') // same family — still one notice
    unsubscribe()
    expect(noticed).toEqual(['claude-opus-5'])
  })

  test('a second family gets its own notice', () => {
    const noticed: string[] = []
    const unsubscribe = onFallbackModelFastRejected((model: string) => {
      noticed.push(model)
    })
    markFastRejected('claude-opus-5')
    markFastRejected('claude-sonnet-5')
    unsubscribe()
    expect(noticed).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })
})

describe('2.1.286 item-A — clear (binary n9e) vs ever-set (binary SYn)', () => {
  test('clearing the fallback set keeps the ever-rejected membership', () => {
    let changedEmits = 0
    const unsubscribe = onFastRejectedFallbackModelsChanged(() => {
      changedEmits++
    })
    markFastRejected('claude-opus-5')
    const emitsAfterMark = changedEmits
    clearFastRejectedFallbackModels()
    expect(changedEmits).toBe(emitsAfterMark + 1)
    // rBt: no longer forced to standard speed via the fallback set…
    expect(isFastRejectedFallback('claude-opus-5')).toBe(false)
    // …but SYn (either set) still sees the ever-rejected family — the item-A
    // retry branch stays armed for it.
    expect(hasEverOrFallbackFastRejected('claude-opus-5')).toBe(true)
    unsubscribe()
  })

  test('clearing an empty set is a no-op (no emit)', () => {
    let changedEmits = 0
    const unsubscribe = onFastRejectedFallbackModelsChanged(() => {
      changedEmits++
    })
    clearFastRejectedFallbackModels()
    expect(changedEmits).toBe(0)
    unsubscribe()
  })

  test('reset clears BOTH sets (binary Ll.reset)', () => {
    markFastRejected('claude-opus-5')
    resetFastRejectionStore()
    expect(isFastRejectedFallback('claude-opus-5')).toBe(false)
    expect(hasEverOrFallbackFastRejected('claude-opus-5')).toBe(false)
  })
})
