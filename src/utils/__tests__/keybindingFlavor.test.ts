import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetSettingsCache } from '../settings/settingsCache.js'
import {
  getKeybindingFlavor,
  isReadlineKeybindingFlavor,
} from '../keybindingFlavor.js'

/**
 * 2.1.238 `keybindingFlavor` reader (binary `kKi`, default binary `Arh`).
 * `getKeybindingFlavor()` returns the merged `settings.keybindingFlavor` and
 * falls back to `"classic"` when the key is absent or invalid. Mirrors the
 * official `.optional().catch(undefined)` + `?? "classic"` semantics.
 *
 * Settings are seeded via a temp CLAUDE_CONFIG_DIR (disk-read path) instead
 * of `mock.module('../settings/settings.js')` — `mock.module` registrations
 * are process-wide and leak into other test files in the same `bun test`
 * worker (broke screenReader.test.ts). Same seam as screenReader.test.ts.
 */

const SAVED_ENV = { ...process.env }
let tmpConfigDir: string | undefined

function seedUserSettings(settings: object): void {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-kbf-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  writeFileSync(join(tmpConfigDir, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
}

beforeEach(() => {
  resetSettingsCache()
})

afterEach(() => {
  resetSettingsCache()
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k]
  }
  if (tmpConfigDir) {
    rmSync(tmpConfigDir, { recursive: true, force: true })
    tmpConfigDir = undefined
  }
})

describe('getKeybindingFlavor (2.1.238)', () => {
  test('defaults to "classic" when the setting is absent', () => {
    seedUserSettings({})
    expect(getKeybindingFlavor()).toBe('classic')
    expect(isReadlineKeybindingFlavor()).toBe(false)
  })

  test('honors "readline"', () => {
    seedUserSettings({ keybindingFlavor: 'readline' })
    expect(getKeybindingFlavor()).toBe('readline')
    expect(isReadlineKeybindingFlavor()).toBe(true)
  })

  test('honors "classic"', () => {
    seedUserSettings({ keybindingFlavor: 'classic' })
    expect(getKeybindingFlavor()).toBe('classic')
    expect(isReadlineKeybindingFlavor()).toBe(false)
  })

  test('falls back to "classic" for an unexpected value', () => {
    // The schema catches unknown enum values to undefined (`.catch(undefined)`),
    // so an invalid value on disk never reaches the reader as-is; the reader
    // then defaults to "classic".
    seedUserSettings({ keybindingFlavor: 'emacs' })
    expect(getKeybindingFlavor()).toBe('classic')
    expect(isReadlineKeybindingFlavor()).toBe(false)
  })
})
