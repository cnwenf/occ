/**
 * Tests for the CC 2.1.295 settings-file load check after plugin commands
 * (`settingsFileLoadWarning.ts`, verbatim port of official `pIr`). The
 * warning sentence and its three reason branches are asserted byte-identical
 * to the decompiled 2.1.295 template.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ValidationError } from '../../settings/validation.js'

// ---------------------------------------------------------------------------
// Mocks (OCC-97/OCC-103 delegation pattern — getters fall back to the real
// implementations once `mockActive` flips false in afterAll). Only the
// settings module is mocked; the existsSync path uses real temp files.
// ---------------------------------------------------------------------------

let mockActive = false
let pathsBySource: Record<string, string | undefined> = {}
let parseResults: Record<string, { settings: unknown; errors: ValidationError[] }> = {}

let actualSettingsMod: Record<string, unknown>
let realGetSettingsFilePathForSource: (source: string) => string | undefined
let realParseSettingsFile: (path: string) => unknown

let mod: typeof import('../settingsFileLoadWarning.js')

beforeAll(async () => {
  actualSettingsMod = await import('../../settings/settings.js')
  const actualSettings = actualSettingsMod as any
  realGetSettingsFilePathForSource = actualSettings.getSettingsFilePathForSource
  realParseSettingsFile = actualSettings.parseSettingsFile

  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsMod,
    getSettingsFilePathForSource: (source: string) =>
      mockActive
        ? pathsBySource[source]
        : realGetSettingsFilePathForSource(source as any),
    parseSettingsFile: (path: string) =>
      mockActive
        ? (parseResults[path] ?? { settings: null, errors: [] })
        : realParseSettingsFile(path),
  }))

  mockActive = true
  mod = await import('../settingsFileLoadWarning.js')
})

afterAll(() => {
  mockActive = false
})

beforeEach(() => {
  pathsBySource = { userSettings: '/home/u/.claude/settings.json' }
  parseResults = {}
})

const err = (over: Partial<ValidationError> = {}): ValidationError => ({
  file: '/home/u/.claude/settings.json',
  path: '',
  message: 'Invalid or malformed JSON',
  ...over,
})

const TAIL =
  'so Claude Code ignores the whole file, including anything this command wrote there. Fix the file, then run this command again if its change is missing. If a newer Claude Code wrote the file, update Claude Code instead.'

describe('getSettingsFileLoadWarning (official pIr)', () => {
  test('returns null when no source / the managed-policy source is given', () => {
    expect(mod.getSettingsFileLoadWarning(undefined)).toBeNull()
    expect(mod.getSettingsFileLoadWarning('policySettings')).toBeNull()
  })

  test('returns null when the source has no resolvable file path', () => {
    pathsBySource = {}
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBeNull()
  })

  test('returns null for a cowork-mode userSettings file', () => {
    pathsBySource = { userSettings: '/home/u/.claude/cowork_settings.json' }
    parseResults['/home/u/.claude/cowork_settings.json'] = {
      settings: null,
      errors: [err({ file: '/home/u/.claude/cowork_settings.json' })],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBeNull()
  })

  test('returns null when the file loads without blocking errors', () => {
    parseResults['/home/u/.claude/settings.json'] = {
      settings: {},
      errors: [],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBeNull()
  })

  test('ignores warning-severity records and records for other files', () => {
    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [
        err({ severity: 'warning', path: 'env.X' }),
        err({ file: '/somewhere/else.json', path: 'env.Y' }),
      ],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBeNull()
  })

  test('names a single invalid value with its path', () => {
    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [err({ path: 'env.X', message: 'Expected string, but received number' })],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBe(
      `/home/u/.claude/settings.json does not load (its "env.X" is not valid), ${TAIL}`,
    )
  })

  test('counts further invalid values with plural agreement', () => {
    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [
        err({ path: 'env.X' }),
        err({ path: 'env.Y' }),
      ],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBe(
      `/home/u/.claude/settings.json does not load (its "env.X" and 1 other value are not valid), ${TAIL}`,
    )

    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [err({ path: 'a' }), err({ path: 'b' }), err({ path: 'c' })],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBe(
      `/home/u/.claude/settings.json does not load (its "a" and 2 other values are not valid), ${TAIL}`,
    )
  })

  test('truncates the value path at 80 characters (official je(path, 80))', () => {
    const longPath = `env.${'x'.repeat(120)}`
    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [err({ path: longPath })],
    }
    const warning = mod.getSettingsFileLoadWarning('userSettings')
    expect(warning).toContain(`its "${longPath.slice(0, 80)}" is not valid`)
    expect(warning).not.toContain(longPath)
  })

  test('reports an OS-level read failure as "it could not be read"', () => {
    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [err({ errorClass: 'unreadable', errno: 'EACCES' })],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBe(
      `/home/u/.claude/settings.json does not load (it could not be read), ${TAIL}`,
    )
  })

  test('reports a malformed/non-object document as "it is not a JSON object"', () => {
    parseResults['/home/u/.claude/settings.json'] = {
      settings: null,
      errors: [err()],
    }
    expect(mod.getSettingsFileLoadWarning('userSettings')).toBe(
      `/home/u/.claude/settings.json does not load (it is not a JSON object), ${TAIL}`,
    )
  })

  test('checks a project-scope file only when it exists on disk', () => {
    // Arrange — a real temp dir; the missing path never exists, the present
    // one is a real file so existsSync (unmocked) sees it.
    const dir = mkdtempSync(join(tmpdir(), 'occ295-loadwarn-'))
    const presentPath = join(dir, 'settings.json')
    writeFileSync(presentPath, 'not json')
    const missingPath = join(dir, 'settings.local.json')
    pathsBySource = {
      userSettings: '/home/u/.claude/settings.json',
      projectSettings: missingPath,
      localSettings: presentPath,
    }
    const blockingError = (file: string): ValidationError => ({
      file,
      path: '',
      message: 'Invalid or malformed JSON',
    })
    parseResults[missingPath] = {
      settings: null,
      errors: [blockingError(missingPath)],
    }
    parseResults[presentPath] = {
      settings: null,
      errors: [blockingError(presentPath)],
    }

    // Act & Assert — file absent → nothing to load, no warning
    expect(mod.getSettingsFileLoadWarning('projectSettings')).toBeNull()

    // File present → official warning for that file
    expect(mod.getSettingsFileLoadWarning('localSettings')).toBe(
      `${presentPath} does not load (it is not a JSON object), ${TAIL}`,
    )
  })
})

describe('warnIfSettingsFileDoesNotLoad (official printer fragment)', () => {
  test('prints "⚠ <warning>" and stays silent when the file loads', () => {
    const lines: string[] = []
    const realLog = console.log
    console.log = (line: string) => {
      lines.push(line)
    }
    try {
      parseResults['/home/u/.claude/settings.json'] = { settings: {}, errors: [] }
      mod.warnIfSettingsFileDoesNotLoad('userSettings')
      expect(lines).toEqual([])

      parseResults['/home/u/.claude/settings.json'] = {
        settings: null,
        errors: [err()],
      }
      mod.warnIfSettingsFileDoesNotLoad('userSettings')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toStartWith('⚠ /home/u/.claude/settings.json does not load (')
    } finally {
      console.log = realLog
    }
  })
})
