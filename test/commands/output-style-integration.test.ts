import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * /output-style real-disk integration tests (review P3-4 + P2-3).
 *
 * The unit suite (test/commands/output-style.test.ts) mocks the settings and
 * style-discovery layers; this file drives the REAL cascade end-to-end on
 * temp-dir disk state, promoting the merge-validator's scratch tests into the
 * formal suite:
 *
 *   1. write → reread:  call('Concise') writes .claude/settings.local.json
 *      and the effective settings re-read it back.
 *   2. bad JSON:        a corrupt settings.local.json surfaces the official
 *      `Invalid JSON syntax in settings file at <path>` error, no overwrite.
 *   3. real discovery:  a .claude/output-styles/*.md file is discovered,
 *      listed, and selectable.
 *   4. P2-3 lock:       flagSettings {outputStyle} OVERRIDES the localSettings
 *      write — the official 2.1.270 write path (binary @202167402) has NO
 *      post-write validity check (`let d=await Kt(...);if(d.error)return{...};
 *      return ...{value:\`Output style set to ${_n(t)}\`}`), so a successful
 *      write that is silently ineffective under a flag override IS official
 *      behavior. This test pins that exact contract (decision: parity +
 *      documented, docs/upstream-version-gap-occ125.md §8).
 *
 * NO mock.module here — every import below is the production module. The CI
 * gate (scripts/ci-test.sh) runs each test file in its own process, so the
 * unit file's mocks can't leak in.
 */

const { call } = await import('../../src/commands/output-style/output-style.js')
const {
  getSettings_DEPRECATED,
} = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import(
  '../../src/utils/settings/settingsCache.js'
)
const {
  getCwdState,
  setFlagSettingsPath,
  setCwdState,
  setOriginalCwd,
} = await import('../../src/bootstrap/state.js')

const ctx = {} as any

let tmpRoot: string
let projectDir: string
const initialCwdState = getCwdState()

function text(result: { type: string; value?: string }): string {
  expect(result.type).toBe('text')
  return result.value ?? ''
}

function localSettingsPath(): string {
  return join(projectDir, '.claude', 'settings.local.json')
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'occ-output-style-'))
  projectDir = join(tmpRoot, 'project')
  const userConfigDir = join(tmpRoot, 'user-config')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(userConfigDir, { recursive: true })
  // Isolate the userSettings source (getClaudeConfigHomeDir is memoized ON
  // CLAUDE_CONFIG_DIR — a new value re-resolves without manual cache clears).
  process.env.CLAUDE_CONFIG_DIR = userConfigDir
  setOriginalCwd(projectDir)
  // getAllOutputStyles/getOutputStyleDirStyles resolve via getCwd() → pwd() →
  // getCwdState(); point the live cwd state at the temp project too.
  setCwdState(projectDir)
  setFlagSettingsPath(undefined)
  resetSettingsCache()
})

afterEach(() => {
  setFlagSettingsPath(undefined)
  setCwdState(initialCwdState)
  resetSettingsCache()
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('/output-style real-disk integration', () => {
  test('write → reread: set persists to settings.local.json and takes effect', async () => {
    const value = text(await call('Concise', ctx))
    expect(value).toBe('Output style set to Concise')

    // The file exists on real disk with the canonical style name.
    const written = JSON.parse(readFileSync(localSettingsPath(), 'utf8'))
    expect(written).toEqual({ outputStyle: 'Concise' })

    // The effective settings cascade re-reads it (the write path resets the
    // settings cache itself — no manual reset needed for the reread).
    expect(getSettings_DEPRECATED().outputStyle).toBe('Concise')

    // And a second invocation now short-circuits as already-active.
    const again = text(await call('Concise', ctx))
    expect(again).toBe('Output style is already Concise')
  })

  test('bad JSON in settings.local.json → official Invalid JSON error, file untouched', async () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    writeFileSync(localSettingsPath(), '{not valid json!!')

    const value = text(await call('Concise', ctx))
    expect(value).toBe(
      `Could not save output style: Invalid JSON syntax in settings file at ${localSettingsPath()}`,
    )

    // The corrupt file must NOT be overwritten (official guards the merge).
    expect(readFileSync(localSettingsPath(), 'utf8')).toBe('{not valid json!!')
    expect(getSettings_DEPRECATED().outputStyle).toBeUndefined()
  })

  test('real .claude/output-styles discovery: listed and selectable', async () => {
    const stylesDir = join(projectDir, '.claude', 'output-styles')
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(
      join(stylesDir, 'Pirate.md'),
      '---\nname: Pirate\ndescription: Talk like a pirate\n---\n\nRespond in pirate speak, matey.\n',
    )

    const listing = text(await call('', ctx))
    expect(listing).toContain('- Pirate: Talk like a pirate')

    const value = text(await call('pirate', ctx))
    expect(value).toBe('Output style set to Pirate')
    expect(JSON.parse(readFileSync(localSettingsPath(), 'utf8'))).toEqual({
      outputStyle: 'Pirate',
    })
    expect(getSettings_DEPRECATED().outputStyle).toBe('Pirate')
  })

  test('P2-3 lock: flagSettings override makes the write silently ineffective (official parity)', async () => {
    // Official merge order: userSettings < projectSettings < localSettings <
    // flagSettings < policySettings — a --settings flag file wins over the
    // localSettings write. The official command reports success anyway (no
    // post-write validity check in the binary); this test pins that contract
    // so a future "helpful" validation doesn't silently diverge.
    const flagPath = join(tmpRoot, 'flag-settings.json')
    writeFileSync(flagPath, JSON.stringify({ outputStyle: 'Learning' }))
    setFlagSettingsPath(flagPath)
    resetSettingsCache()

    // Current style reflects the flag file.
    const listing = text(await call('', ctx))
    expect(listing).toContain('Output style: Learning')
    expect(listing).toContain('- Learning (current)')

    // Switching to Concise reports success and really writes local settings...
    const value = text(await call('Concise', ctx))
    expect(value).toBe('Output style set to Concise')
    expect(JSON.parse(readFileSync(localSettingsPath(), 'utf8'))).toEqual({
      outputStyle: 'Concise',
    })

    // ...but the EFFECTIVE value stays Learning — flagSettings outranks
    // localSettings in the cascade. Silent no-op under override == official.
    expect(getSettings_DEPRECATED().outputStyle).toBe('Learning')

    // A follow-up listing still shows Learning as current (not Concise).
    const after = text(await call('', ctx))
    expect(after).toContain('Output style: Learning')
    expect(after).not.toContain('- Concise (current)')
  })
})
