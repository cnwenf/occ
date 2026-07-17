/**
 * `claude auto-mode reset` handler tests (CC 2.1.212).
 *
 * Covers every outcome of the official minified `MbS` reset handler:
 *   - no resolvable user settings path
 *   - unreadable settings file (real error, not missing)
 *   - invalid settings JSON
 *   - already at defaults (no autoMode section) → success, no write
 *   - happy path: autoMode present + --yes → writes removal, prints success
 *   - confirmation declined (no --yes) → "Aborted."
 *   - lossy_write_unconfirmed: --yes + unrecognized entries → refuses
 *   - write error → mapped message
 *   - pluralize singular vs plural in the lossy message
 *
 * Strategy: dependency injection. The handler accepts `AutoModeResetDeps`
 * so each test substitutes the exact boundary it controls. Two integration
 * cases (happy path + already-at-defaults) drive the REAL settings layer
 * against a tmpdir-backed CLAUDE_CONFIG_DIR (e2e).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autoModeResetHandler,
  defaultAutoModeResetDeps,
  detectUnrecognizedEntries,
  type AutoModeResetDeps,
} from '../handlers/autoMode.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { ValidationError } from '../../utils/settings/validation.js'

/** Capture stdout writes into an array. */
function captureStdout(): {
  writer: (m: string) => void
  output: () => string
} {
  const chunks: string[] = []
  return {
    writer: m => {
      chunks.push(m)
    },
    output: () => chunks.join(''),
  }
}

/** Build a mock deps with the given overrides; other seams are inert stubs. */
function makeDeps(overrides: Partial<AutoModeResetDeps>): AutoModeResetDeps {
  const inert: AutoModeResetDeps = {
    resolvePath: () => '/tmp/test-settings.json',
    readRawFile: () => null,
    parseSettings: () => ({ settings: null, errors: [] as ValidationError[] }),
    detectUnrecognized: () => [],
    writeSettings: () => ({ error: null }),
    confirm: async () => true,
    ...overrides,
  }
  return inert
}

describe('auto-mode reset: detectUnrecognizedEntries', () => {
  test('returns [] for empty content', () => {
    expect(detectUnrecognizedEntries('')).toEqual([])
  })

  test('returns [] when all keys are known', () => {
    const content = JSON.stringify({ autoMode: { allow: ['x'] } })
    expect(detectUnrecognizedEntries(content)).toEqual([])
  })

  test('returns unknown top-level keys', () => {
    const content = JSON.stringify({
      autoMode: { allow: ['x'] },
      fooBarUnknown: true,
      bazQuux: 1,
    })
    expect(detectUnrecognizedEntries(content).sort()).toEqual([
      'bazQuux',
      'fooBarUnknown',
    ])
  })

  test('returns [] for invalid JSON', () => {
    expect(detectUnrecognizedEntries('{not json')).toEqual([])
  })
})

describe('auto-mode reset: outcome branches', () => {
  test('no resolvable user settings path → "Could not resolve"', async () => {
    const out = captureStdout()
    const deps = makeDeps({ resolvePath: () => undefined })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(out.output()).toBe(
      'Could not resolve the user settings file path.\n',
    )
  })

  test('unreadable settings file (real error) → "Could not read <path>: <err>"', async () => {
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/etc/shadow/cannot',
      readRawFile: () => {
        throw new Error('EACCES: permission denied')
      },
    })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(out.output()).toContain('Could not read /etc/shadow/cannot:')
    expect(out.output()).toContain('EACCES: permission denied')
  })

  test('missing file (ENOENT) is NOT an error — treated as defaults', async () => {
    // Missing file → content null → hasContent false → settings null →
    // autoMode undefined → already-at-defaults success path.
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/nonexistent/path/settings.json',
      readRawFile: () => null, // ENOENT → null
    })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(out.output()).toContain('already at defaults')
    expect(out.output()).toContain('has no autoMode section')
  })

  test('invalid settings JSON → settings-invalid message', async () => {
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/bad/settings.json',
      readRawFile: () => '{ not valid json',
      parseSettings: () => ({
        settings: null,
        errors: [
          {
            path: '',
            message: 'Invalid or malformed JSON',
          },
        ] as ValidationError[],
      }),
    })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(out.output()).toContain('Invalid settings in /bad/settings.json')
    expect(out.output()).toContain('Invalid or malformed JSON')
  })

  test('autoMode undefined → "already at defaults" success (no write)', async () => {
    const out = captureStdout()
    const writeSettings = mock(() => ({ error: null }))
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () => JSON.stringify({ cleanupPeriodDays: 30 }),
      parseSettings: () => ({
        settings: { cleanupPeriodDays: 30 } as SettingsJson,
        errors: [],
      }),
      writeSettings,
    })
    await autoModeResetHandler({ yes: true }, deps, out.writer)
    expect(out.output()).toContain('already at defaults')
    expect(out.output()).toContain('/user/settings.json')
    expect(out.output()).toContain('no autoMode section')
    // Must NOT have written — already at defaults.
    expect(writeSettings).not.toHaveBeenCalled()
  })

  test('happy path: autoMode present + --yes → writes removal, prints success', async () => {
    const out = captureStdout()
    const writeSettings = mock(() => ({ error: null }))
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () => JSON.stringify({ autoMode: { allow: ['safe'] } }),
      parseSettings: () => ({
        settings: { autoMode: { allow: ['safe'] } } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => [],
      writeSettings,
    })
    await autoModeResetHandler({ yes: true }, deps, out.writer)
    expect(writeSettings).toHaveBeenCalledTimes(1)
    expect(out.output()).toContain('reset to defaults')
    expect(out.output()).toContain('autoMode section removed from /user/settings.json')
    expect(out.output()).toContain('Run `claude auto-mode config`')
  })

  test('no --yes, confirm declined → "Aborted."', async () => {
    const out = captureStdout()
    const writeSettings = mock(() => ({ error: null }))
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () => JSON.stringify({ autoMode: { allow: ['safe'] } }),
      parseSettings: () => ({
        settings: { autoMode: { allow: ['safe'] } } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => [],
      writeSettings,
      confirm: async () => false,
    })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(writeSettings).not.toHaveBeenCalled()
    expect(out.output()).toBe('Aborted.\n')
  })

  test('no --yes, confirm accepted → writes removal, prints success', async () => {
    const out = captureStdout()
    const writeSettings = mock(() => ({ error: null }))
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () => JSON.stringify({ autoMode: { allow: ['safe'] } }),
      parseSettings: () => ({
        settings: { autoMode: { allow: ['safe'] } } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => [],
      writeSettings,
      confirm: async () => true,
    })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(writeSettings).toHaveBeenCalledTimes(1)
    expect(out.output()).toContain('reset to defaults')
  })

  test('--yes + unrecognized entries → refuses (lossy_write_unconfirmed)', async () => {
    const out = captureStdout()
    const writeSettings = mock(() => ({ error: null }))
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () =>
        JSON.stringify({ autoMode: { allow: ['safe'] }, fooBar: 1 }),
      parseSettings: () => ({
        settings: {
          autoMode: { allow: ['safe'] },
          fooBar: 1,
        } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => ['fooBar'],
      writeSettings,
    })
    await autoModeResetHandler({ yes: true }, deps, out.writer)
    expect(writeSettings).not.toHaveBeenCalled()
    expect(out.output()).toContain('Not resetting')
    expect(out.output()).toContain('cannot parse')
    expect(out.output()).toContain('fooBar')
    expect(out.output()).toContain('delete it too')
    expect(out.output()).toContain('that entry')
    expect(out.output()).toContain('without --yes')
  })

  test('pluralize: 2 unrecognized entries → "entries"/"them"/"those entries"', async () => {
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () =>
        JSON.stringify({ autoMode: { allow: ['safe'] }, fooBar: 1, bazQuux: 2 }),
      parseSettings: () => ({
        settings: {
          autoMode: { allow: ['safe'] },
          fooBar: 1,
          bazQuux: 2,
        } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => ['fooBar', 'bazQuux'],
    })
    await autoModeResetHandler({ yes: true }, deps, out.writer)
    const text = out.output()
    expect(text).toContain('entries this version of Claude Code cannot parse')
    expect(text).toContain('delete them too')
    expect(text).toContain('those entries first')
  })

  test('pluralize: 1 unrecognized entry → "entry"/"it"/"that entry"', async () => {
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () =>
        JSON.stringify({ autoMode: { allow: ['safe'] }, onlyOne: 1 }),
      parseSettings: () => ({
        settings: {
          autoMode: { allow: ['safe'] },
          onlyOne: 1,
        } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => ['onlyOne'],
    })
    await autoModeResetHandler({ yes: true }, deps, out.writer)
    const text = out.output()
    expect(text).toContain('entry this version of Claude Code cannot parse')
    expect(text).toContain('delete it too')
    expect(text).toContain('that entry first')
  })

  test('write error → mapped failure message', async () => {
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/user/settings.json',
      readRawFile: () => JSON.stringify({ autoMode: { allow: ['safe'] } }),
      parseSettings: () => ({
        settings: { autoMode: { allow: ['safe'] } } as unknown as SettingsJson,
        errors: [],
      }),
      detectUnrecognized: () => [],
      writeSettings: () => ({ error: new Error('disk full') }),
    })
    await autoModeResetHandler({ yes: true }, deps, out.writer)
    expect(out.output()).toContain('Failed to reset auto mode')
    expect(out.output()).toContain('disk full')
  })

  test('invalid settings with no error list → generic invalid message', async () => {
    const out = captureStdout()
    const deps = makeDeps({
      resolvePath: () => '/bad/settings.json',
      readRawFile: () => '{ broken',
      parseSettings: () => ({ settings: null, errors: [] }),
    })
    await autoModeResetHandler({ yes: false }, deps, out.writer)
    expect(out.output()).toContain('Invalid settings in /bad/settings.json')
    expect(out.output()).toContain('Fix the errors before resetting')
  })

  test('defaultConfirm returns false in a non-TTY session', async () => {
    // Test runners are not a TTY — confirms the non-interactive guard.
    const result = await defaultAutoModeResetDeps.confirm('proceed?')
    expect(result).toBe(false)
  })

  test('defaultConfirm TTY: "y" → true (readline mocked)', async () => {
    // Force the TTY branch and mock the readline interface so the question
    // resolves with "y" — covers the interactive confirmation path.
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    await mock.module('node:readline/promises', () => {
      const fakeInterface = {
        question: async (prompt: string) => {
          expect(prompt).toContain('Reset auto mode')
          return 'y'
        },
        close: () => {},
      }
      return {
        createInterface: () => fakeInterface,
        default: { createInterface: () => fakeInterface },
      }
    })
    try {
      const result = await defaultAutoModeResetDeps.confirm(
        'Reset auto mode configuration to defaults?',
      )
      expect(result).toBe(true)
    } finally {
      if (originalIsTTY === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY
      } else {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
      }
    }
  })

  test('defaultConfirm TTY: "n" → false (readline mocked)', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    await mock.module('node:readline/promises', () => {
      const fakeInterface = {
        question: async () => 'n',
        close: () => {},
      }
      return {
        createInterface: () => fakeInterface,
        default: { createInterface: () => fakeInterface },
      }
    })
    try {
      const result = await defaultAutoModeResetDeps.confirm('proceed?')
      expect(result).toBe(false)
    } finally {
      if (originalIsTTY === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY
      } else {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
      }
    }
  })

  test('detectUnrecognizedEntries: JSON array → []', () => {
    expect(detectUnrecognizedEntries('[1, 2, 3]')).toEqual([])
  })

  test('detectUnrecognizedEntries: JSON scalar → []', () => {
    expect(detectUnrecognizedEntries('"hello"')).toEqual([])
  })

  test('default stdout sink writes to process.stdout (no-path branch)', async () => {
    // Call without the optional stdout arg → uses defaultStdout. Captures
    // via a process.stdout.write spy to avoid polluting test output.
    const original = process.stdout.write.bind(process.stdout)
    const chunks: string[] = []
    process.stdout.write = ((c: string | Uint8Array) => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString())
      return true
    }) as typeof process.stdout.write
    const deps = makeDeps({ resolvePath: () => undefined })
    try {
      await autoModeResetHandler({ yes: false }, deps)
    } finally {
      process.stdout.write = original
    }
    expect(chunks.join('')).toBe(
      'Could not resolve the user settings file path.\n',
    )
  })
})

// ---------------------------------------------------------------------------
// Integration (e2e) tests: real settings layer against a tmpdir-backed
// CLAUDE_CONFIG_DIR. Exercises the real path resolution, raw read, parse,
// and write paths.
// ---------------------------------------------------------------------------

describe('auto-mode reset: integration (tmpdir + real settings layer)', () => {
  let configDir: string
  let savedConfigDir: string | undefined
  let savedMemoCache: unknown

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'occ-reset-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    // The settings cache and the memoized config-home must not leak between
    // tests. Reset both so resolvePath reads the new tmpdir.
    const { resetSettingsCache } = require('../../utils/settings/settingsCache.js')
    resetSettingsCache()
    // getClaudeConfigHomeDir is memoized keyed off CLAUDE_CONFIG_DIR; force a
    // fresh evaluation by clearing the memoize cache.
    const { getClaudeConfigHomeDir } = require('../../utils/envUtils.js')
    // lodash memoize exposes .cache; clear it so the new env var is honored.
    if (typeof getClaudeConfigHomeDir.cache?.clear === 'function') {
      getClaudeConfigHomeDir.cache.clear()
    }
    savedMemoCache = getClaudeConfigHomeDir
  })

  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    const { resetSettingsCache } = require('../../utils/settings/settingsCache.js')
    resetSettingsCache()
    const { getClaudeConfigHomeDir } = require('../../utils/envUtils.js')
    if (typeof getClaudeConfigHomeDir.cache?.clear === 'function') {
      getClaudeConfigHomeDir.cache.clear()
    }
  })

  test('happy path: real settings.json with autoMode → removed on disk', async () => {
    const settingsPath = join(configDir, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ autoMode: { allow: ['safe-rule'] } }, null, 2) + '\n',
    )
    const out = captureStdout()
    // Real deps, but confirm is skipped via --yes.
    await autoModeResetHandler({ yes: true }, defaultAutoModeResetDeps, out.writer)
    expect(out.output()).toContain('reset to defaults')
    expect(out.output()).toContain(settingsPath)

    // Verify autoMode was actually removed from the file on disk.
    const after = await Bun.file(settingsPath).text()
    const parsed = JSON.parse(after)
    expect(parsed.autoMode).toBeUndefined()
  })

  test('already at defaults: real settings.json with no autoMode → no write', async () => {
    const settingsPath = join(configDir, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ cleanupPeriodDays: 30 }, null, 2) + '\n',
    )
    const before = await Bun.file(settingsPath).text()
    const out = captureStdout()
    await autoModeResetHandler({ yes: true }, defaultAutoModeResetDeps, out.writer)
    expect(out.output()).toContain('already at defaults')
    // File unchanged.
    const after = await Bun.file(settingsPath).text()
    expect(after).toBe(before)
  })

  test('missing settings.json → real ENOENT read → already at defaults', async () => {
    // No settings.json written — the real readUserSettingsRaw returns null
    // (ENOENT), so the handler treats it as empty/defaults.
    const out = captureStdout()
    await autoModeResetHandler({ yes: true }, defaultAutoModeResetDeps, out.writer)
    expect(out.output()).toContain('already at defaults')
  })

  test('real lossy path: settings.json with autoMode + unknown key, --yes → refuses', async () => {
    const settingsPath = join(configDir, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { autoMode: { allow: ['safe'] }, someUnknownKey: true },
        null,
        2,
      ) + '\n',
    )
    const out = captureStdout()
    await autoModeResetHandler({ yes: true }, defaultAutoModeResetDeps, out.writer)
    expect(out.output()).toContain('Not resetting')
    expect(out.output()).toContain('someUnknownKey')
    // autoMode must still be present — no write occurred.
    const after = JSON.parse(await Bun.file(settingsPath).text())
    expect(after.autoMode).toBeDefined()
  })

  test('unreadable file (directory at path → EISDIR) → "Could not read"', async () => {
    // Place a directory where settings.json should be — readFileSync throws
    // EISDIR (a real error, not ENOENT), exercising readUserSettingsRaw's
    // rethrow branch via the real default deps.
    const { mkdirSync } = require('node:fs')
    mkdirSync(join(configDir, 'settings.json'))
    const out = captureStdout()
    await autoModeResetHandler({ yes: true }, defaultAutoModeResetDeps, out.writer)
    expect(out.output()).toContain('Could not read')
    expect(out.output()).toContain('settings.json')
  })
})
