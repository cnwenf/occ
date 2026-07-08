import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../src/utils/envUtils.js'
import { isFableModel } from '../../src/utils/fable/isFableModel.js'
import {
  getFableCredits,
  getRemainingFableCredits,
  incrementFableCredits,
} from '../../src/utils/fable/fableCredits.js'
import {
  getFableConsent,
  hasFableConsent,
  hasFableConsentRecord,
  saveFableConsent,
} from '../../src/utils/fable/fableConsent.js'

// getClaudeConfigHomeDir is memoized on the CLAUDE_CONFIG_DIR env value, so
// each test points it at a fresh temp dir and clears the cache.
const PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
let tmpDir: string

function resetConfigDirCache(): void {
  getClaudeConfigHomeDir.cache.clear()
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fable-test-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetConfigDirCache()
})

afterEach(() => {
  resetConfigDirCache()
  rmSync(tmpDir, { recursive: true, force: true })
  if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR
  resetConfigDirCache()
})

describe('isFableModel', () => {
  test('detects Fable 5 across providers and the mythos alias', () => {
    expect(isFableModel('claude-fable-5')).toBe(true)
    expect(isFableModel('us.anthropic.claude-fable-5')).toBe(true)
    expect(isFableModel('anthropic.claude-fable-5')).toBe(true)
    expect(isFableModel('claude-mythos-5')).toBe(true)
  })

  test('returns false for non-Fable models and empty input', () => {
    expect(isFableModel('claude-sonnet-4-5')).toBe(false)
    expect(isFableModel('claude-opus-4-1')).toBe(false)
    expect(isFableModel('')).toBe(false)
    expect(isFableModel(null)).toBe(false)
    expect(isFableModel(undefined)).toBe(false)
  })
})

describe('fableCredits', () => {
  test('defaults to the full allotment when no credits file exists', () => {
    const credits = getFableCredits()
    expect(credits.used).toBe(0)
    expect(credits.limit).toBeGreaterThan(0)
    expect(getRemainingFableCredits()).toBe(credits.limit)
  })

  test('increments used and decreases remaining', () => {
    incrementFableCredits(1)
    expect(getFableCredits().used).toBe(1)
    const limit = getFableCredits().limit
    expect(getRemainingFableCredits()).toBe(limit - 1)

    incrementFableCredits(3)
    expect(getFableCredits().used).toBe(4)
    expect(getRemainingFableCredits()).toBe(limit - 4)
  })

  test('never reports negative remaining credits', () => {
    const limit = getFableCredits().limit
    incrementFableCredits(limit + 50)
    expect(getRemainingFableCredits()).toBe(0)
  })

  test('persists used count across fresh disk reads', () => {
    incrementFableCredits(5)
    expect(getFableCredits().used).toBe(5)
    // A second instance / fresh read still sees the persisted value.
    resetConfigDirCache()
    expect(getFableCredits().used).toBe(5)
  })

  test('falls back to defaults on a corrupt credits file', () => {
    const path = join(getClaudeConfigHomeDir(), 'fable-credits.json')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(path, 'not valid json', { encoding: 'utf-8' })
    const credits = getFableCredits()
    expect(credits.used).toBe(0)
    expect(getRemainingFableCredits()).toBe(credits.limit)
  })
})

describe('fableConsent', () => {
  test('no record means no consent and no record', () => {
    expect(hasFableConsentRecord()).toBe(false)
    expect(hasFableConsent()).toBe(false)
    expect(getFableConsent()).toEqual({ consented: false, timestamp: 0 })
  })

  test('saveFableConsent(true) persists consent', () => {
    saveFableConsent(true)
    expect(hasFableConsentRecord()).toBe(true)
    expect(hasFableConsent()).toBe(true)
    expect(getFableConsent().consented).toBe(true)
    expect(getFableConsent().timestamp).toBeGreaterThan(0)
  })

  test('saveFableConsent(false) records a sticky decline', () => {
    saveFableConsent(false)
    expect(hasFableConsentRecord()).toBe(true)
    expect(hasFableConsent()).toBe(false)
  })

  test('falls back to no-consent on a corrupt consent file', () => {
    const path = join(getClaudeConfigHomeDir(), 'fable-consent.json')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(path, 'not valid json', { encoding: 'utf-8' })
    expect(hasFableConsent()).toBe(false)
    expect(getFableConsent()).toEqual({ consented: false, timestamp: 0 })
  })
})
