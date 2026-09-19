import { beforeEach, describe, expect, test } from 'bun:test'

import { isCustomApiKeyApproved } from '../auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { normalizeConfigStringArray } from '../configStringArray.js'
import {
  customApiKeyResponsesOf,
  customApiKeyStatusOf,
} from '../customApiKeyResponses.js'

/**
 * claude-code 2.1.277 (C2): "Fixed an issue where malformed
 * customApiKeyResponses in ~/.claude.json could hang or error interactive
 * startup for ANTHROPIC_API_KEY users."
 *
 * Official v277 normalizer `HR` + status helper `kio` (byte-extracted
 * @0xb980a1c):
 *
 *   function HR(e){let n=e.customApiKeyResponses;return{
 *     approved:fa(n?.approved),rejected:fa(n?.rejected)}}
 *   function kio(e,n){let{approved:r,rejected:s}=HR(e);
 *     if(r.includes(n))return"approved";
 *     if(s.includes(n))return"rejected";return"new"}
 *   function fa(n){if(!Array.isArray(n))return[];return n.every((e)=>
 *     typeof e==="string")?n:n.filter((e)=>typeof e==="string")}
 *
 * Before the fix, a hand-edited/corrupted value reached destructuring /
 * spread / `.includes` and threw the v276 crash string "Cannot destructure
 * property 'approved' from null or undefined value" (or a spread TypeError)
 * during the ANTHROPIC_API_KEY approval flow at startup. All v277 write
 * paths normalize BEFORE merging, so a malformed value self-heals on the
 * next persist.
 *
 * Persistence goes through the NODE_ENV=test in-memory global config,
 * matching the mcpNeedsAuthNoticeNormalizer276.test.ts convention.
 */

/** Persist a raw (possibly malformed) value, bypassing the declared type. */
function setPersistedRaw(value: unknown): void {
  saveGlobalConfig(current => ({
    ...current,
    customApiKeyResponses: value as {
      approved?: string[]
      rejected?: string[]
    },
  }))
}

function persistedRaw(): unknown {
  return getGlobalConfig().customApiKeyResponses
}

beforeEach(() => {
  setPersistedRaw({ approved: [], rejected: [] })
})

describe('2.1.277 normalizeConfigStringArray (official shared fa)', () => {
  test('non-array values normalize to []', () => {
    expect(normalizeConfigStringArray('foo')).toEqual([])
    expect(normalizeConfigStringArray(123)).toEqual([])
    expect(normalizeConfigStringArray(null)).toEqual([])
    expect(normalizeConfigStringArray(undefined)).toEqual([])
    expect(normalizeConfigStringArray({})).toEqual([])
    expect(normalizeConfigStringArray(true)).toEqual([])
  })

  test('mixed array keeps only string entries', () => {
    expect(normalizeConfigStringArray([1, 'a', null, 'b', {}])).toEqual([
      'a',
      'b',
    ])
  })

  test('all-strings array is returned unchanged (every fast path — identity)', () => {
    const value = ['a', 'b']
    expect(normalizeConfigStringArray(value)).toBe(value)
  })
})

describe('2.1.277 customApiKeyResponsesOf (official HR)', () => {
  test('malformed containers normalize to empty lists, no throw', () => {
    for (const raw of [undefined, null, {}, 123, 'str', true, [1, 'a']]) {
      expect(customApiKeyResponsesOf({ customApiKeyResponses: raw })).toEqual({
        approved: [],
        rejected: [],
      })
    }
  })

  test('malformed inner lists normalize independently', () => {
    expect(
      customApiKeyResponsesOf({
        customApiKeyResponses: { approved: null, rejected: {} },
      }),
    ).toEqual({ approved: [], rejected: [] })
    expect(
      customApiKeyResponsesOf({
        customApiKeyResponses: { approved: [1, 'a'], rejected: 'x' },
      }),
    ).toEqual({ approved: ['a'], rejected: [] })
  })

  test('valid lists pass through unchanged (identity fast path)', () => {
    const approved = ['k1']
    const rejected = ['k2']
    const result = customApiKeyResponsesOf({
      customApiKeyResponses: { approved, rejected },
    })
    expect(result.approved).toBe(approved)
    expect(result.rejected).toBe(rejected)
  })
})

describe('2.1.277 customApiKeyStatusOf (official kio)', () => {
  test('approved wins over rejected, else new', () => {
    const config = {
      customApiKeyResponses: { approved: ['a', 'both'], rejected: ['r', 'both'] },
    }
    expect(customApiKeyStatusOf(config, 'both')).toBe('approved')
    expect(customApiKeyStatusOf(config, 'r')).toBe('rejected')
    expect(customApiKeyStatusOf(config, 'missing')).toBe('new')
  })

  test('malformed container → "new", no throw', () => {
    for (const raw of [null, {}, 123, 'str']) {
      expect(
        customApiKeyStatusOf({ customApiKeyResponses: raw }, 'k'),
      ).toBe('new')
    }
  })
})

describe('2.1.277 getCustomApiKeyStatus tolerates malformed persisted value', () => {
  test('null container → "new" (pre-fix: destructure TypeError)', async () => {
    setPersistedRaw(null)
    const { getCustomApiKeyStatus } = await import('../config.js')
    expect(getCustomApiKeyStatus('k')).toBe('new')
  })

  test('object container → "new"', async () => {
    setPersistedRaw({})
    const { getCustomApiKeyStatus } = await import('../config.js')
    expect(getCustomApiKeyStatus('k')).toBe('new')
  })

  test('mixed approved array → string entries still resolve', async () => {
    setPersistedRaw({ approved: [1, 'KEYTAIL'], rejected: 123 })
    const { getCustomApiKeyStatus } = await import('../config.js')
    expect(getCustomApiKeyStatus('KEYTAIL')).toBe('approved')
    expect(getCustomApiKeyStatus('other')).toBe('new')
  })

  test('valid value passes through: approved / rejected / new', async () => {
    setPersistedRaw({ approved: ['a'], rejected: ['r'] })
    const { getCustomApiKeyStatus } = await import('../config.js')
    expect(getCustomApiKeyStatus('a')).toBe('approved')
    expect(getCustomApiKeyStatus('r')).toBe('rejected')
    expect(getCustomApiKeyStatus('n')).toBe('new')
  })
})

describe('2.1.277 isCustomApiKeyApproved tolerates malformed persisted value', () => {
  // normalizeApiKeyForConfig keeps the last 20 chars of the key.
  const key = `sk-ant-${'x'.repeat(30)}`
  const tail = key.slice(-20)

  test('number container → false, no throw', () => {
    setPersistedRaw(123)
    expect(isCustomApiKeyApproved(key)).toBe(false)
  })

  test('non-array approved list → false, no throw', () => {
    setPersistedRaw({ approved: 'nope' })
    expect(isCustomApiKeyApproved(key)).toBe(false)
  })

  test('mixed approved array → string tail still matches', () => {
    setPersistedRaw({ approved: [1, null, tail] })
    expect(isCustomApiKeyApproved(key)).toBe(true)
  })

  test('valid approved list passes through', () => {
    setPersistedRaw({ approved: [tail], rejected: [] })
    expect(isCustomApiKeyApproved(key)).toBe(true)
    setPersistedRaw({ approved: [], rejected: [tail] })
    expect(isCustomApiKeyApproved(key)).toBe(false)
  })
})

describe('2.1.277 write paths self-heal malformed persisted value', () => {
  // The routed write sites (ApproveApiKey yes/no, Settings toggle, auth
  // saveApiKey, logout) all apply the official normalize-before-merge shape:
  // destructure via HR, then persist concrete string[] lists. Exercised here
  // through the same saveGlobalConfig + customApiKeyResponsesOf combination
  // those callbacks now use (ApproveApiKey "yes" shape).
  test('null container → approval write persists a clean pair', () => {
    setPersistedRaw(null)
    saveGlobalConfig(current => {
      const { approved, rejected } = customApiKeyResponsesOf(current)
      return {
        ...current,
        customApiKeyResponses: {
          approved: [...approved, 'TAIL'],
          rejected,
        },
      }
    })
    expect(persistedRaw()).toEqual({ approved: ['TAIL'], rejected: [] })
  })

  test('mixed arrays → non-string entries dropped on the merge write', () => {
    setPersistedRaw({ approved: [1, 'a'], rejected: {} })
    saveGlobalConfig(current => {
      const { approved, rejected } = customApiKeyResponsesOf(current)
      return {
        ...current,
        customApiKeyResponses: {
          approved: [...approved, 'b'],
          rejected,
        },
      }
    })
    expect(persistedRaw()).toEqual({ approved: ['a', 'b'], rejected: [] })
  })

  test('logout shape: defined malformed container → approved cleared, rejected normalized', () => {
    setPersistedRaw({ approved: [1, 'a'], rejected: [2, 'r'] })
    saveGlobalConfig(current => {
      const updated = { ...current }
      if (updated.customApiKeyResponses !== undefined) {
        updated.customApiKeyResponses = {
          approved: [],
          rejected: customApiKeyResponsesOf(updated).rejected,
        }
      }
      return updated
    })
    expect(persistedRaw()).toEqual({ approved: [], rejected: ['r'] })
  })
})
