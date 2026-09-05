import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../envUtils.js'
import { resetSettingsCache } from '../../settings/settingsCache.js'
import {
  BASH_MAX_OUTPUT_DEFAULT,
  BASH_MAX_OUTPUT_UPPER_LIMIT,
  OUTPUT_CHARS_MAX,
  OUTPUT_CHARS_MIN,
  clampOutputChars,
  getBashOutputMaxChars,
  getMaxOutputLength,
} from '../outputLimits.js'

/**
 * 2.1.261 entry-002: the `bashOutputMaxChars` setting + its two-tier accessors.
 *
 * Official binary shapes (v261 byte-verified):
 *   - `function ree(e){if(e===void 0)return;return Math.min(Math.max(e,Asr),lge)}`
 *     with `Asr=4000`, `lge=128000` → clampOutputChars.
 *   - `function OBt(){return ree(ze().bashOutputMaxChars)??MBt}` with `MBt=30000`
 *     → getBashOutputMaxChars (SETTINGS-ONLY — feeds the Bash/PowerShell tool
 *     spec `maxResultSizeChars`).
 *   - `pHe` (the truncation window over `BASH_MAX_OUTPUT_LENGTH`, cap `fun=150000`)
 *     now prefers the setting when present → getMaxOutputLength.
 *
 * Fixtures follow the repo's settings-seeding pattern (prompt-cache-ttl.test):
 * a tmp CLAUDE_CONFIG_DIR, real settings.json writes, no module mocks; caches
 * are cleared after every env/seed change.
 */

let tmpConfigDir: string
const PREV_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'BASH_MAX_OUTPUT_LENGTH']

function clearCaches(): void {
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()
}

function seedUserSettings(settings: Record<string, unknown>): void {
  writeFileSync(join(tmpConfigDir, 'settings.json'), JSON.stringify(settings))
  clearCaches()
}

function clearUserSettings(): void {
  rmSync(join(tmpConfigDir, 'settings.json'), { force: true })
  clearCaches()
}

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-outlimits261-'))
  for (const key of ENV_KEYS) {
    PREV_ENV[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  clearCaches()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (PREV_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = PREV_ENV[key]
  }
  rmSync(tmpConfigDir, { recursive: true, force: true })
  clearCaches()
})

beforeEach(() => {
  delete process.env.BASH_MAX_OUTPUT_LENGTH
  clearUserSettings()
})

describe('clampOutputChars (2.1.261 official ree, Asr=4000 / lge=128000)', () => {
  test('passes undefined through (so callers can apply their own default)', () => {
    expect(clampOutputChars(undefined)).toBeUndefined()
  })

  test('keeps in-range values unchanged', () => {
    expect(clampOutputChars(50_000)).toBe(50_000)
  })

  test('boundary values are kept exactly', () => {
    expect(clampOutputChars(OUTPUT_CHARS_MIN)).toBe(4_000)
    expect(clampOutputChars(OUTPUT_CHARS_MAX)).toBe(128_000)
  })

  test('clamps below-minimum values up to 4000', () => {
    expect(clampOutputChars(100)).toBe(4_000)
    expect(clampOutputChars(3_999)).toBe(4_000)
  })

  test('clamps above-maximum values down to 128000', () => {
    expect(clampOutputChars(128_001)).toBe(128_000)
    expect(clampOutputChars(999_999)).toBe(128_000)
  })

  test('constants match the byte-verified official values', () => {
    expect(OUTPUT_CHARS_MIN).toBe(4_000)
    expect(OUTPUT_CHARS_MAX).toBe(128_000)
    expect(BASH_MAX_OUTPUT_DEFAULT).toBe(30_000)
    expect(BASH_MAX_OUTPUT_UPPER_LIMIT).toBe(150_000)
  })
})

describe('getBashOutputMaxChars (2.1.261 official OBt — settings-only accessor)', () => {
  test('returns the 30000 default when the setting is absent', () => {
    expect(getBashOutputMaxChars()).toBe(30_000)
  })

  test('returns the clamped setting when present', () => {
    seedUserSettings({ bashOutputMaxChars: 50_000 })
    expect(getBashOutputMaxChars()).toBe(50_000)
  })

  test('clamps an out-of-range setting (100 → 4000)', () => {
    seedUserSettings({ bashOutputMaxChars: 100 })
    expect(getBashOutputMaxChars()).toBe(4_000)
  })

  test('clamps an oversized setting (999999 → 128000)', () => {
    seedUserSettings({ bashOutputMaxChars: 999_999 })
    expect(getBashOutputMaxChars()).toBe(128_000)
  })

  test('ignores BASH_MAX_OUTPUT_LENGTH — the spec accessor is settings-only', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '77777'
    clearCaches()
    expect(getBashOutputMaxChars()).toBe(30_000)
  })
})

describe('getMaxOutputLength (2.1.261 truncation window — setting first, env fallback)', () => {
  test('returns the 30000 default with no setting and no env var', () => {
    expect(getMaxOutputLength()).toBe(30_000)
  })

  test('honors BASH_MAX_OUTPUT_LENGTH when the setting is absent', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '77777'
    clearCaches()
    expect(getMaxOutputLength()).toBe(77_777)
  })

  test('caps the env var at 150000 (env fallback keeps its own upper limit)', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '999999'
    clearCaches()
    expect(getMaxOutputLength()).toBe(150_000)
  })

  test('falls back to the default for an invalid env var', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = 'not-a-number'
    clearCaches()
    expect(getMaxOutputLength()).toBe(30_000)
  })

  test('the setting replaces the env var when present', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '77777'
    seedUserSettings({ bashOutputMaxChars: 50_000 })
    expect(getMaxOutputLength()).toBe(50_000)
  })

  test('the setting is clamped to 4000-128000 even against a larger env var', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '77777'
    seedUserSettings({ bashOutputMaxChars: 100 })
    expect(getMaxOutputLength()).toBe(4_000)
  })
})

describe('BashTool spec maxResultSizeChars wiring (2.1.261 official OBt consumer)', () => {
  test('exposes the live official getter: OBt(), read per access', async () => {
    // Official Bash/PowerShell spec: `get maxResultSizeChars(){return OBt()}`.
    // The tool installs a live getter after buildTool, so each access re-reads
    // settings — no seeding means the 30000 default, and a seeded
    // `bashOutputMaxChars` changes the value (env stays ignored: settings-only).
    const { BashTool } = await import('../../../tools/BashTool/BashTool.js')
    expect(BashTool.maxResultSizeChars).toBe(30_000)

    seedUserSettings({ bashOutputMaxChars: 50_000 })
    expect(BashTool.maxResultSizeChars).toBe(50_000)

    seedUserSettings({ bashOutputMaxChars: 100 }) // clamped to 4000
    expect(BashTool.maxResultSizeChars).toBe(OUTPUT_CHARS_MIN)

    clearUserSettings()
    process.env.BASH_MAX_OUTPUT_LENGTH = '77777'
    clearCaches()
    expect(BashTool.maxResultSizeChars).toBe(30_000) // env ignored: settings-only

    delete process.env.BASH_MAX_OUTPUT_LENGTH
    clearCaches()
    expect(BashTool.maxResultSizeChars).toBe(30_000)
  })
})
