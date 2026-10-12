import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.296 — auto-default nudge accept-write merge semantics (OCC-115
 * acceptance P3-4).
 *
 * The sibling autoDefaultNudge296.test.ts mocks settings.js and asserts the
 * PAYLOAD the nudge writes ({permissions:{defaultMode:"auto"}}). This file
 * pins the complementary guarantee with the REAL settings module: the accept
 * write goes through `updateSettingsForSource`'s mergeWith, so it must NOT
 * clobber other fields of the same userSettings file — sibling
 * `permissions.*` keys (allow/deny/ask/additionalDirectories) or unrelated
 * top-level keys (theme, cleanupPeriodDays).
 *
 * Architecture: CLAUDE_CONFIG_DIR env window pointed at a temp dir (pattern:
 * allowedProviders285.test.ts), real settings.js + config.js, minimal mocks
 * for betas/model/analytics only (deterministic auto-gate + event capture).
 * Dynamic import of the target AFTER mocks; afterAll restores (OCC-97 Bun
 * mock.module leak).
 */

// MACRO polyfill (permissionSetup import graph reads MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const ENV_KEYS = ['CLAUDE_CONFIG_DIR'] as const
const savedEnv: Record<string, string | undefined> = {}

let configDir = ''

const actualBetas = await import('../../betas.js')
const actualModel = await import('../../model/model.js')
const actualAnalytics = await import('../../../services/analytics/index.js')

const events: Array<{ name: string; metadata: Record<string, unknown> }> = []

mock.module('../../betas.js', () => ({
  ...actualBetas,
  modelSupportsAutoMode: () => true,
}))
mock.module('../../model/model.js', () => ({
  ...actualModel,
  getMainLoopModel: () => 'claude-test',
}))
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    events.push({ name, metadata })
  },
}))

const { resolveAutoDefaultNudge } = await import('../autoDefaultNudge.js')
const { _resetForTesting: resetAutoModeState } = await import(
  '../autoModeState.js'
)
const { resetSettingsCache } = await import('../../settings/settingsCache.js')

/** The pre-existing userSettings the accept write must merge into, not replace. */
const SEEDED_USER_SETTINGS = {
  permissions: {
    defaultMode: 'default',
    allow: ['Bash(git status:*)'],
    deny: ['Read(.env)'],
    ask: ['Bash(git push:*)'],
    additionalDirectories: ['../docs'],
  },
  theme: 'dark',
  cleanupPeriodDays: 30,
}

function settingsPath(): string {
  return join(configDir, 'settings.json')
}

function readPersistedSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), 'utf8'))
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  configDir = mkdtempSync(join(tmpdir(), 'occ-nudge-merge-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

beforeEach(() => {
  writeFileSync(settingsPath(), JSON.stringify(SEEDED_USER_SETTINGS, null, 2))
  resetSettingsCache()
  resetAutoModeState()
  events.length = 0
})

afterAll(() => {
  mock.module('../../betas.js', () => ({ ...actualBetas }))
  mock.module('../../model/model.js', () => ({ ...actualModel }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

describe('CC 2.1.296 — nudge accept write merges into real userSettings (P3-4)', () => {
  test('accept persists defaultMode auto WITHOUT clobbering sibling permissions fields', async () => {
    const outcome = await resolveAutoDefaultNudge('accept', 'default')
    expect(outcome).toBe('switched')

    const persisted = readPersistedSettings()
    const permissions = persisted.permissions as Record<string, unknown>
    // The one field the nudge owns flips to auto…
    expect(permissions.defaultMode).toBe('auto')
    // …everything else in the same source survives the mergeWith write.
    expect(permissions.allow).toEqual(['Bash(git status:*)'])
    expect(permissions.deny).toEqual(['Read(.env)'])
    expect(permissions.ask).toEqual(['Bash(git push:*)'])
    expect(permissions.additionalDirectories).toEqual(['../docs'])
    // Unrelated top-level keys survive too.
    expect(persisted.theme).toBe('dark')
    expect(persisted.cleanupPeriodDays).toBe(30)
  })

  test('accept logs the switched event through the real resolver path', async () => {
    const outcome = await resolveAutoDefaultNudge('accept', 'plan')
    expect(outcome).toBe('switched')
    expect(
      events.find(e => e.name === 'tengu_auto_default_nudge_resolved')
        ?.metadata,
    ).toEqual({ choice: 'accept', outcome: 'switched', current_mode: 'plan' })
    // The hasSeenAutoDefaultNudge flag write itself is pinned elsewhere:
    // sibling unit test (mocked config) + nudge e2e (real temp HOME).
  })

  test('a second accept (relaunch after recovery) is still merge-safe', async () => {
    await resolveAutoDefaultNudge('accept', 'default')
    // Simulate the user re-pinning a non-auto mode, then accepting again.
    const afterFirst = readPersistedSettings()
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        {
          ...afterFirst,
          permissions: {
            ...(afterFirst.permissions as Record<string, unknown>),
            defaultMode: 'plan',
          },
        },
        null,
        2,
      ),
    )
    resetSettingsCache()

    const outcome = await resolveAutoDefaultNudge('accept', 'plan')
    expect(outcome).toBe('switched')
    const persisted = readPersistedSettings()
    const permissions = persisted.permissions as Record<string, unknown>
    expect(permissions.defaultMode).toBe('auto')
    expect(permissions.allow).toEqual(['Bash(git status:*)'])
    expect(persisted.theme).toBe('dark')
  })
})
