/**
 * CC-295 plugin settings-load warning — install/enable CLI WIRING test
 * (review gap 3).
 *
 * `installPlugin` (pluginCliCommands.ts) and `enablePlugin` each end with
 * `warnIfWrittenScopeSettingsDoNotLoad(result.scope)` → `process.exit(0)`.
 * Neither call site had coverage: deleting the warn call kept every suite
 * green. This test drives the REAL CLI wrapper functions in-process with
 * only the heavyweight plugin operation layer mocked (a real install needs a
 * full marketplace + plugin fixture), against a REAL schema-invalid settings
 * file on disk, and asserts:
 *   - the official warning is printed (`... does not load (its "permissions"
 *     is not valid), ...`),
 *   - the command still exits 0 (warning is non-fatal).
 * Removing the warn call from installPlugin/enablePlugin turns this red.
 *
 * The fixture is schema-invalid-but-valid JSON: unlike malformed JSON,
 * updateSettingsForSource CAN merge onto it, so this is the shape a real
 * successful install/enable write leaves behind when the file is broken —
 * exactly the silent-no-effect case the 2.1.295 warning discloses.
 *
 * Mock discipline: repo mockActive delegation pattern (Bun runs test files
 * in one process, so mock.module leaks) — getters fall back to the real
 * pluginOperations exports once `mockActive` flips false in afterAll.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mocks — pluginOperations delegation (OCC-97/OCC-103 pattern).
// ---------------------------------------------------------------------------

let mockActive = false
type OpResult = {
  success: boolean
  message: string
  pluginId?: string
  scope?: string
}
let installResult: OpResult = { success: false, message: 'not set' }
let enableResult: OpResult = { success: false, message: 'not set' }

const actualOps = (await import('../pluginOperations.js')) as Record<
  string,
  unknown
>

mock.module('../pluginOperations.js', () => ({
  ...actualOps,
  installPluginOp: async (...args: unknown[]) =>
    mockActive
      ? installResult
      : ((actualOps.installPluginOp as (...a: unknown[]) => unknown)(...args) as never),
  enablePluginOp: async (...args: unknown[]) =>
    mockActive
      ? enableResult
      : ((actualOps.enablePluginOp as (...a: unknown[]) => unknown)(...args) as never),
}))

const mod = (await import('../pluginCliCommands.js')) as {
  installPlugin: (plugin: string, scope?: string) => Promise<void>
  enablePlugin: (plugin: string, scope?: string) => Promise<void>
}
mockActive = true

// ---------------------------------------------------------------------------
// Fixture — isolated CLAUDE_CONFIG_DIR with a schema-invalid settings.json.
// ---------------------------------------------------------------------------

const tempDirs: string[] = []
let exitSpy: ReturnType<typeof spyOn>
let logSpy: ReturnType<typeof spyOn>

function makeBrokenConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-warn-wiring-'))
  tempDirs.push(dir)
  // Valid JSON, invalid schema: parseSettingsFile yields a blocking record
  // with path 'permissions' → warning reason `its "permissions" is not valid`.
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ permissions: 'definitely-not-an-object' }),
  )
  // getClaudeConfigHomeDir is memoized keyed off the env var — a fresh value
  // recomputes without cache clearing.
  process.env.CLAUDE_CONFIG_DIR = dir
  return dir
}

beforeAll(() => {
  // installPlugin/enablePlugin end with process.exit(0) — swallow it so the
  // wrapper returns and the test can assert.
  exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never)
  logSpy = spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  exitSpy.mockClear()
  logSpy.mockClear()
})

afterAll(() => {
  mockActive = false
  exitSpy.mockRestore()
  logSpy.mockRestore()
  delete process.env.CLAUDE_CONFIG_DIR
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function loggedLines(): string[] {
  return logSpy.mock.calls.map(call => String(call[0]))
}

// ---------------------------------------------------------------------------

describe('installPlugin warns when the written settings file does not load (CC-295 wiring)', () => {
  test('schema-invalid user settings → warning printed AND exit 0', async () => {
    const dir = makeBrokenConfigDir()
    installResult = {
      success: true,
      message: 'Plugin installed',
      pluginId: 'demo@warn-wiring-market',
      scope: 'user',
    }

    await mod.installPlugin('demo@warn-wiring-market', 'user')

    // The command succeeded and exited 0 (warning is non-fatal)…
    expect(exitSpy).toHaveBeenCalledWith(0)
    // …and the official 2.1.295 warning fired against the real file.
    const settingsPath = join(dir, 'settings.json')
    const warning = loggedLines().find(line =>
      line.includes(`${settingsPath} does not load`),
    )
    expect(warning).toBeDefined()
    expect(warning).toContain('(its "permissions" is not valid)')
    expect(warning).toContain(
      'so Claude Code ignores the whole file, including anything this command wrote there.',
    )
  })

  test('a healthy settings file prints NO warning (still exit 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ-warn-wiring-ok-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: {} }))
    process.env.CLAUDE_CONFIG_DIR = dir
    installResult = {
      success: true,
      message: 'Plugin installed',
      pluginId: 'demo@warn-wiring-market',
      scope: 'user',
    }

    await mod.installPlugin('demo@warn-wiring-market', 'user')

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(
      loggedLines().some(line => line.includes('does not load')),
    ).toBe(false)
  })
})

describe('enablePlugin warns when the written settings file does not load (CC-295 wiring)', () => {
  test('schema-invalid user settings → warning printed AND exit 0', async () => {
    const dir = makeBrokenConfigDir()
    enableResult = {
      success: true,
      message: 'Plugin enabled',
      pluginId: 'demo@warn-wiring-market',
      scope: 'user',
    }

    await mod.enablePlugin('demo@warn-wiring-market')

    expect(exitSpy).toHaveBeenCalledWith(0)
    const settingsPath = join(dir, 'settings.json')
    const warning = loggedLines().find(line =>
      line.includes(`${settingsPath} does not load`),
    )
    expect(warning).toBeDefined()
    expect(warning).toContain('(its "permissions" is not valid)')
  })
})
