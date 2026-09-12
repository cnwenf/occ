import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { authStatus } from '../handlers/auth.js'

/**
 * CC 2.1.268 (E05): `claude auth status --json` gained a `configDirectory`
 * field. Official 268 builder (byte-verified in added.txt/s2s.txt):
 * `{loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory,
 * configDirectory}` then conditional forcedLoginMethod/apiKeySource/email…
 * OCC exposes only the E05 addition; the field sits directly after
 * apiProvider, mirroring the official order for the fields OCC has.
 */

const FIXTURE_CONFIG_DIR = join(tmpdir(), 'occ-e05-config-fixture')

let savedConfigDir: string | undefined
let captured = ''
let exitCode: number | string | undefined
let writeSpy: { mockRestore(): void }
let exitSpy: { mockRestore(): void }

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = FIXTURE_CONFIG_DIR
  captured = ''
  exitCode = undefined
  writeSpy = spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown) => {
      captured += String(chunk)
      return true
    },
  )
  exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    return undefined
  }) as never)
})

afterEach(() => {
  writeSpy.mockRestore()
  exitSpy.mockRestore()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
})

describe('2.1.268: auth status --json includes configDirectory (E05)', () => {
  test('json output carries configDirectory from the config-dir accessor', async () => {
    // Act
    await authStatus({ json: true })

    // Assert — stdout got one JSON document with the new field
    const parsed = JSON.parse(captured) as Record<string, unknown>
    expect(parsed.configDirectory).toBe(getClaudeConfigHomeDir())
    expect(parsed.configDirectory).toBe(FIXTURE_CONFIG_DIR.normalize('NFC'))
    // Pre-existing fields are untouched and keep the official order:
    // loggedIn, authMethod, apiProvider, configDirectory
    const keys = Object.keys(parsed)
    expect(keys.slice(0, 4)).toEqual([
      'loggedIn',
      'authMethod',
      'apiProvider',
      'configDirectory',
    ])
    expect(typeof exitCode).toBe('number')
  })

  test('configDirectory follows CLAUDE_CONFIG_DIR overrides', async () => {
    // Arrange — the accessor's memoization is keyed off the env var, so a
    // changed value recomputes without cache clearing
    process.env.CLAUDE_CONFIG_DIR = '/tmp/occ-e05-other'

    // Act
    await authStatus({ json: true })

    // Assert
    const parsed = JSON.parse(captured) as Record<string, unknown>
    expect(parsed.configDirectory).toBe('/tmp/occ-e05-other')
  })
})
