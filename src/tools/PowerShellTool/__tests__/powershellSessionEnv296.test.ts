/**
 * CC 2.1.296 #036 — PowerShell sees CLAUDE_ENV_FILE plain assignments.
 *
 * PowerShell cannot dot-source the bash-style session environment script
 * (the bash provider inlines `source <script>` into every command). The
 * official 2.1.296 fix parses the script's plain assignments into a Map
 * (official `A_t`, see sessionEnvPlainAssignments296.test.ts) and injects
 * them into the pwsh child-process env.
 *
 * OCC wiring (DEVIATION NOTE): the Map is merged inside
 * powershellProvider.getEnvironmentOverrides() — the single env-assembly
 * point Shell.ts consults for both foreground and background spawns.
 * PowerShell consumed NO session env before this change.
 *
 * Merge order asserted here:
 *   /env session vars  <  session-env-file Map  <  sandbox TMPDIR
 * (bash parity: the sourced script wins over the ambient env; sandbox
 * isolation wins over both.)
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearSessionEnvVars,
  setSessionEnvVar,
} from '../../../utils/sessionEnvVars.js'
import { invalidateSessionEnvCache } from '../../../utils/sessionEnvironment.js'
import { createPowerShellProvider } from '../../../utils/shell/powershellProvider.js'

const configDir = await mkdtemp(join(tmpdir(), 'occ-ps-env-296-'))
process.env.CLAUDE_CONFIG_DIR = configDir
const envFilePath = join(configDir, 'claude-env-file.sh')

const FAKE_PWSH = '/usr/bin/fake-pwsh-296'

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  clearSessionEnvVars()
  delete process.env.CLAUDE_ENV_FILE
  invalidateSessionEnvCache()
})

afterEach(() => {
  clearSessionEnvVars()
  delete process.env.CLAUDE_ENV_FILE
  invalidateSessionEnvCache()
})

async function withEnvScript(content: string): Promise<void> {
  await writeFile(envFilePath, content, 'utf8')
  process.env.CLAUDE_ENV_FILE = envFilePath
  invalidateSessionEnvCache()
}

describe('CC 2.1.296 #036: PowerShell session-env injection', () => {
  test('plain assignments from CLAUDE_ENV_FILE reach the pwsh spawn env', async () => {
    // Arrange
    await withEnvScript(
      ['export VIRTUAL_ENV=/opt/venv', "CONDA_PROMPT='(base) '"].join('\n'),
    )
    const provider = createPowerShellProvider(FAKE_PWSH)

    // Act
    const env = await provider.getEnvironmentOverrides()

    // Assert
    expect(env['VIRTUAL_ENV']).toBe('/opt/venv')
    expect(env['CONDA_PROMPT']).toBe('(base) ')
  })

  test('a non-plain-assignment script injects nothing (all-or-nothing)', async () => {
    // Arrange — venv activate scripts are functions/conditionals, not plain
    await withEnvScript('export GOOD=yes\nsource ./activate.sh')
    const provider = createPowerShellProvider(FAKE_PWSH)

    // Act
    const env = await provider.getEnvironmentOverrides()

    // Assert — no partial application
    expect(env['GOOD']).toBeUndefined()
    expect(Object.keys(env).length).toBe(0)
  })

  test('session-env-file values override /env session vars on conflict', async () => {
    // Arrange — bash parity: the sourced script wins over the ambient env
    setSessionEnvVar('SHARED', 'from-env-command')
    await withEnvScript('SHARED=from-env-file')
    const provider = createPowerShellProvider(FAKE_PWSH)

    // Act
    const env = await provider.getEnvironmentOverrides()

    // Assert
    expect(env['SHARED']).toBe('from-env-file')
  })

  test('/env-only vars still pass through alongside the file map', async () => {
    // Arrange
    setSessionEnvVar('ONLY_ENV_CMD', 'kept')
    await withEnvScript('ONLY_FILE=present')
    const provider = createPowerShellProvider(FAKE_PWSH)

    // Act
    const env = await provider.getEnvironmentOverrides()

    // Assert
    expect(env['ONLY_ENV_CMD']).toBe('kept')
    expect(env['ONLY_FILE']).toBe('present')
  })

  test('sandbox TMPDIR wins over a session-env TMPDIR', async () => {
    // Arrange
    await withEnvScript('TMPDIR=/from/session')
    const provider = createPowerShellProvider(FAKE_PWSH)
    await provider.buildExecCommand('Get-Location', {
      id: 296,
      sandboxTmpDir: '/sandbox/tmp-296',
      useSandbox: true,
    })

    // Act
    const env = await provider.getEnvironmentOverrides()

    // Assert — sandbox isolation is applied last
    expect(env['TMPDIR']).toBe('/sandbox/tmp-296')
    expect(env['CLAUDE_CODE_TMPDIR']).toBe('/sandbox/tmp-296')
  })

  test('no session env at all leaves the override set unchanged', async () => {
    // Arrange — no CLAUDE_ENV_FILE, empty session dir
    const provider = createPowerShellProvider(FAKE_PWSH)

    // Act
    const env = await provider.getEnvironmentOverrides()

    // Assert
    expect(Object.keys(env).length).toBe(0)
  })
})
