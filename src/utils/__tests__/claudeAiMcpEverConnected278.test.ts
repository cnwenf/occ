import { beforeEach, describe, expect, test } from 'bun:test'

import {
  clearClaudeAiMcpCurrentlyConnected,
  hasClaudeAiMcpEverConnected,
  markClaudeAiMcpConnected,
} from '../../services/mcp/claudeai.js'
import { claudeAiMcpEverConnectedOf } from '../claudeAiMcpEverConnected.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'

/**
 * claude-code 2.1.277 (C7): "Fixed an issue where a malformed
 * claudeAiMcpEverConnected value in ~/.claude.json crashed /mcp and /plugin
 * manage with a Type error."
 *
 * Official v277 accessor `LMe` (byte-extracted @0xbd3aeef) — the field is a
 * string[] (NOT a Record), guarded by the same shared `fa` normalizer as
 * mcpNeedsAuthNoticed / customApiKeyResponses:
 *
 *   function LMe(e){return fa(e.claudeAiMcpEverConnected)}
 *   k2t(e){return LMe(ae()).includes(e)}          // hasEverConnected read
 *   Z5e mark: ke((r)=>{let s=LMe(r);if(s.includes(e))return r;
 *     return{...r,claudeAiMcpEverConnected:[...s,e]}},n)  // normalize
 *     BEFORE merge → malformed value self-heals on persist
 *
 * Persistence goes through the NODE_ENV=test in-memory global config,
 * matching the mcpNeedsAuthNoticeNormalizer276.test.ts convention.
 */

/** Persist a raw (possibly malformed) value, bypassing the string[] type. */
function setPersistedRaw(value: unknown): void {
  saveGlobalConfig(current => ({
    ...current,
    claudeAiMcpEverConnected: value as string[],
  }))
}

function persistedRaw(): unknown {
  return getGlobalConfig().claudeAiMcpEverConnected
}

beforeEach(() => {
  clearClaudeAiMcpCurrentlyConnected()
  setPersistedRaw([])
})

describe('2.1.277 claudeAiMcpEverConnectedOf (official LMe)', () => {
  test('non-array values normalize to []', () => {
    for (const raw of ['foo', 123, null, undefined, {}, true]) {
      expect(claudeAiMcpEverConnectedOf({ claudeAiMcpEverConnected: raw })).toEqual([])
    }
  })

  test('mixed array keeps only string entries', () => {
    expect(
      claudeAiMcpEverConnectedOf({
        claudeAiMcpEverConnected: [1, 'a', null, 'b', {}],
      }),
    ).toEqual(['a', 'b'])
  })

  test('all-strings array is returned unchanged (identity fast path)', () => {
    const value = ['a', 'b']
    expect(claudeAiMcpEverConnectedOf({ claudeAiMcpEverConnected: value })).toBe(
      value,
    )
  })
})

describe('2.1.277 hasClaudeAiMcpEverConnected tolerates malformed persisted value', () => {
  test('object value → false, no throw (pre-fix: TypeError in /mcp)', () => {
    setPersistedRaw({})
    expect(hasClaudeAiMcpEverConnected('srv')).toBe(false)
  })

  test('number value → false, no throw', () => {
    setPersistedRaw(123)
    expect(hasClaudeAiMcpEverConnected('srv')).toBe(false)
  })

  test('string value → no substring semantics', () => {
    setPersistedRaw('srv')
    expect(hasClaudeAiMcpEverConnected('sr')).toBe(false)
    expect(hasClaudeAiMcpEverConnected('srv')).toBe(false)
  })

  test('mixed array → string entries still match', () => {
    setPersistedRaw([1, 'srv'])
    expect(hasClaudeAiMcpEverConnected('srv')).toBe(true)
    expect(hasClaudeAiMcpEverConnected('other')).toBe(false)
  })

  test('valid list passes through', () => {
    setPersistedRaw(['srv'])
    expect(hasClaudeAiMcpEverConnected('srv')).toBe(true)
  })
})

describe('2.1.277 markClaudeAiMcpConnected self-heals malformed persisted value', () => {
  test('object value → persists a clean string[]', () => {
    setPersistedRaw({})
    markClaudeAiMcpConnected('a')
    expect(persistedRaw()).toEqual(['a'])
  })

  test('mixed array → non-string entries dropped on the merge write', () => {
    setPersistedRaw([1, 'a'])
    markClaudeAiMcpConnected('b')
    expect(persistedRaw()).toEqual(['a', 'b'])
  })

  test('already-marked name → config untouched (official: return r)', () => {
    setPersistedRaw(['a'])
    const before = getGlobalConfig()
    markClaudeAiMcpConnected('a')
    expect(getGlobalConfig()).toBe(before)
    expect(persistedRaw()).toEqual(['a'])
  })
})
