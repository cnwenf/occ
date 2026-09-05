import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../envUtils.js'
import { resetSettingsCache } from '../../settings/settingsCache.js'
import { OUTPUT_CHARS_MAX, OUTPUT_CHARS_MIN } from '../../shell/outputLimits.js'
import {
  TASK_MAX_OUTPUT_DEFAULT,
  TASK_MAX_OUTPUT_UPPER_LIMIT,
  TASK_OUTPUT_INLINE_HEADROOM,
  getMaxTaskOutputLength,
  getTaskOutputMaxChars,
} from '../outputFormatting.js'

/**
 * 2.1.261 entry-002: the `taskOutputMaxChars` setting + its two-tier accessors.
 *
 * Official binary shapes (v261 byte-verified):
 *   - `function Kut(){return ree(ze().taskOutputMaxChars)??q8e}` with `q8e=32000`
 *     → getTaskOutputMaxChars (SETTINGS-ONLY — feeds the TaskOutput tool spec).
 *   - `eVo` (the truncation window over `TASK_MAX_OUTPUT_LENGTH`, cap
 *     `Rmn=160000`) now prefers the setting when present → getMaxTaskOutputLength.
 *   - `TWn = eN - q8e` = 50000 - 32000 = 18000 → TASK_OUTPUT_INLINE_HEADROOM;
 *     TaskOutput spec `CWn`: `get maxResultSizeChars(){return Kut()+TWn}`
 *     (default 50000, replacing the pre-2.1.261 static 100000).
 *
 * Fixtures follow the repo's settings-seeding pattern (prompt-cache-ttl.test):
 * a tmp CLAUDE_CONFIG_DIR, real settings.json writes, no module mocks; caches
 * are cleared after every env/seed change.
 */

let tmpConfigDir: string
const PREV_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'TASK_MAX_OUTPUT_LENGTH']

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
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-taskout261-'))
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
  delete process.env.TASK_MAX_OUTPUT_LENGTH
  clearUserSettings()
})

describe('getTaskOutputMaxChars (2.1.261 official Kut — settings-only accessor)', () => {
  test('returns the 32000 default when the setting is absent', () => {
    expect(getTaskOutputMaxChars()).toBe(32_000)
  })

  test('returns the clamped setting when present', () => {
    seedUserSettings({ taskOutputMaxChars: 50_000 })
    expect(getTaskOutputMaxChars()).toBe(50_000)
  })

  test('clamps an out-of-range setting (100 → 4000)', () => {
    seedUserSettings({ taskOutputMaxChars: 100 })
    expect(getTaskOutputMaxChars()).toBe(4_000)
  })

  test('clamps an oversized setting (999999 → 128000)', () => {
    seedUserSettings({ taskOutputMaxChars: 999_999 })
    expect(getTaskOutputMaxChars()).toBe(128_000)
  })

  test('ignores TASK_MAX_OUTPUT_LENGTH — the spec accessor is settings-only', () => {
    process.env.TASK_MAX_OUTPUT_LENGTH = '77777'
    clearCaches()
    expect(getTaskOutputMaxChars()).toBe(32_000)
  })
})

describe('getMaxTaskOutputLength (2.1.261 truncation window — setting first, env fallback)', () => {
  test('returns the 32000 default with no setting and no env var', () => {
    expect(getMaxTaskOutputLength()).toBe(32_000)
  })

  test('honors TASK_MAX_OUTPUT_LENGTH when the setting is absent', () => {
    process.env.TASK_MAX_OUTPUT_LENGTH = '77777'
    clearCaches()
    expect(getMaxTaskOutputLength()).toBe(77_777)
  })

  test('caps the env var at 160000 (env fallback keeps its own upper limit)', () => {
    process.env.TASK_MAX_OUTPUT_LENGTH = '999999'
    clearCaches()
    expect(getMaxTaskOutputLength()).toBe(160_000)
  })

  test('falls back to the default for an invalid env var', () => {
    process.env.TASK_MAX_OUTPUT_LENGTH = 'not-a-number'
    clearCaches()
    expect(getMaxTaskOutputLength()).toBe(32_000)
  })

  test('the setting replaces the env var when present', () => {
    process.env.TASK_MAX_OUTPUT_LENGTH = '77777'
    seedUserSettings({ taskOutputMaxChars: 60_000 })
    expect(getMaxTaskOutputLength()).toBe(60_000)
  })

  test('the setting is clamped to 4000-128000 even against a larger env var', () => {
    process.env.TASK_MAX_OUTPUT_LENGTH = '77777'
    seedUserSettings({ taskOutputMaxChars: 100 })
    expect(getMaxTaskOutputLength()).toBe(4_000)
  })
})

describe('TaskOutput inline-headroom constants (2.1.261 official TWn)', () => {
  test('constants match the byte-verified official values', () => {
    expect(TASK_MAX_OUTPUT_DEFAULT).toBe(32_000)
    expect(TASK_MAX_OUTPUT_UPPER_LIMIT).toBe(160_000)
    // TWn = eN(50000) - q8e(32000)
    expect(TASK_OUTPUT_INLINE_HEADROOM).toBe(18_000)
    expect(OUTPUT_CHARS_MIN).toBe(4_000)
    expect(OUTPUT_CHARS_MAX).toBe(128_000)
  })
})

describe('TaskOutputTool spec maxResultSizeChars wiring (2.1.261 official CWn)', () => {
  test('exposes the live official getter: Kut()+TWn, read per access', async () => {
    // Official: `get maxResultSizeChars(){return Kut()+TWn}` (default 50000,
    // replacing the pre-2.1.261 static 100000). The tool installs a live
    // getter after buildTool, so each access re-reads settings — no seeding
    // means 50000, and a seeded `taskOutputMaxChars` changes the value.
    const { TaskOutputTool } = await import('../../../tools/TaskOutputTool/TaskOutputTool.js')
    expect(TaskOutputTool.maxResultSizeChars).toBe(50_000)

    seedUserSettings({ taskOutputMaxChars: 60_000 })
    expect(TaskOutputTool.maxResultSizeChars).toBe(78_000)

    seedUserSettings({ taskOutputMaxChars: 100 }) // clamped to 4000
    expect(TaskOutputTool.maxResultSizeChars).toBe(OUTPUT_CHARS_MIN + TASK_OUTPUT_INLINE_HEADROOM)

    clearUserSettings()
    expect(TaskOutputTool.maxResultSizeChars).toBe(50_000)
  })
})
