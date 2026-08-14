import { afterEach, describe, expect, test } from 'bun:test'
import { ripgrepCommand } from '../../ripgrep.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../../settings/settingsCache.js'
import type { SettingsJson } from '../../settings/types.js'
import type { SettingSource } from '../../settings/constants.js'
import { convertToSandboxRuntimeConfig } from '../sandbox-adapter.js'

/**
 * 2.1.232 alignment — the sandbox's ripgrep override is now honored only
 * from policy (managed), --settings flag, and user settings, in that
 * priority order (official rTt scope). Project/local settings can no longer
 * point the sandbox's search binary at an arbitrary executable.
 *
 * Per-source settings are seeded through the settings cache test hook
 * (setCachedSettingsForSource), so getSettingsForSource never touches disk.
 * NO mock.module here — module mocks leak across test files in the same
 * worker and break later suites that rely on the real settings cache.
 */

type RipgrepOverride = { command?: string; args?: string[]; argv0?: string }

const ALL_SOURCES: SettingSource[] = [
  'policySettings',
  'projectSettings',
  'localSettings',
  'userSettings',
  'flagSettings',
]

function seedRipgrep(
  bySource: Partial<Record<SettingSource, RipgrepOverride>>,
): void {
  for (const source of ALL_SOURCES) {
    const ripgrep = bySource[source]
    setCachedSettingsForSource(
      source,
      ripgrep !== undefined
        ? ({ sandbox: { ripgrep } } as SettingsJson)
        : null, // null = cached "no settings for this source" (no disk read)
    )
  }
}

const convert = () => convertToSandboxRuntimeConfig({})

describe('2.1.232 — sandbox ripgrep source scope', () => {
  afterEach(() => {
    resetSettingsCache()
  })

  test('falls back to the bundled ripgrep when no honored source overrides', () => {
    // Arrange: project/local settings try to override — must be ignored
    seedRipgrep({
      projectSettings: { command: 'EVIL_RG' },
      localSettings: { command: 'EVIL_RG' },
    })

    // Act
    const config = convert()

    // Assert: project/local ignored; the bundled binary wins
    const { rgPath, rgArgs, argv0 } = ripgrepCommand()
    expect(config.ripgrep).toEqual({
      command: rgPath,
      args: rgArgs,
      argv0,
    })
  })

  test('user settings override is honored', () => {
    // Arrange
    seedRipgrep({ userSettings: { command: 'USER_RG', args: ['-j1'] } })

    // Act
    const config = convert()

    // Assert
    expect(config.ripgrep).toEqual({ command: 'USER_RG', args: ['-j1'] })
  })

  test('flag settings win over user settings', () => {
    // Arrange
    seedRipgrep({
      userSettings: { command: 'USER_RG' },
      flagSettings: { command: 'FLAG_RG' },
    })

    // Act
    const config = convert()

    // Assert
    expect(config.ripgrep).toEqual({ command: 'FLAG_RG' })
  })

  test('policy settings win over flag and user settings', () => {
    // Arrange
    seedRipgrep({
      userSettings: { command: 'USER_RG' },
      flagSettings: { command: 'FLAG_RG' },
      policySettings: { command: 'POLICY_RG', argv0: 'managed-rg' },
    })

    // Act
    const config = convert()

    // Assert
    expect(config.ripgrep).toEqual({
      command: 'POLICY_RG',
      argv0: 'managed-rg',
    })
  })
})
