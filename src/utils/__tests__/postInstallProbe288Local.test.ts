import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.288 #50 — the npm auto-updater reported success when the install
 * command exited 0 but only the placeholder stub landed. Official v288
 * (@~211722400, recovered in docs/gap-research-288/
 * cluster-b-protocol-auth-mcp-plugin.md "Item 50") re-probes the installed
 * `claude --version` after the install command exits 0:
 *
 *   outcome placeholder_stub → check `npm config get ignore-scripts`; if
 *     deliberately "true", trust the exit code; else fail with status
 *     install_failed + failureHint native_binary_missing and the error log
 *     "…exited 0 but the installed claude is still the placeholder stub: …"
 *   outcome inconclusive → trust the exit code with a log
 *   outcome landed → success carries probeDurationMs
 *
 * These tests cover the LOCAL npm path (installOrUpdateClaudePackage), where
 * the placeholder stub is the `writeIfMissing` wrapper shape from
 * localInstaller.ts (`#!/bin/sh\nexec "<dir>/node_modules/.bin/claude" "$@"`)
 * with no real package binary behind it.
 */

process.env.NODE_ENV = 'test'
const TMP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-probe-local-'))
process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.366',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

// -- Mock leaf collaborators (spread-real keeps every other export intact) --

const realExec = { ...(await import('../execFileNoThrow.js')) }
type ExecResult = { code: number; stdout: string; stderr: string }
let execCalls: Array<{ file: string; args: string[] }> = []
let execResponder: (file: string, args: string[]) => ExecResult = () => ({
  code: 1,
  stdout: '',
  stderr: 'unexpected exec',
})
let mocksActive = true
mock.module('../execFileNoThrow.js', () => ({
  ...realExec,
  execFileNoThrowWithCwd: async (file: string, args: string[]) => {
    if (!mocksActive) {
      return (
        realExec.execFileNoThrowWithCwd as (
          f: string,
          a: string[],
          o: unknown,
        ) => Promise<ExecResult>
      )(file, args, {})
    }
    execCalls.push({ file, args })
    return execResponder(file, args)
  },
}))

const realDebug = { ...(await import('../debug.js')) }
let debugLogs: Array<{ message: string; level: string }> = []
mock.module('../debug.js', () => ({
  ...realDebug,
  logForDebugging: (
    message: string,
    opts: { level?: string } = { level: 'debug' },
  ) => {
    if (mocksActive) {
      debugLogs.push({ message, level: opts.level ?? 'debug' })
    }
  },
}))

const realAnalytics = { ...(await import('src/services/analytics/index.js')) }
let events: Array<{ name: string; metadata: Record<string, unknown> }> = []
mock.module('src/services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (mocksActive) {
      events.push({ name, metadata })
    }
  },
}))

const realConfig = { ...(await import('../config.js')) }
let savedConfigs: Array<Record<string, unknown>> = []
mock.module('../config.js', () => ({
  ...realConfig,
  saveGlobalConfig: (
    fn: (c: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (mocksActive) {
      savedConfigs.push(fn({}))
    }
  },
}))

const realLog = { ...(await import('../log.js')) }
mock.module('../log.js', () => ({
  ...realLog,
  logError: () => {
    // no-op: keep test runs from touching the real error log
  },
}))

const { installOrUpdateClaudePackage } = await import('../localInstaller.js')

const LOCAL_DIR = join(TMP_CONFIG_DIR, 'local')
const BIN_DIR = join(LOCAL_DIR, 'node_modules', '.bin')

/** Wipe + recreate the local install dir (package.json only). */
function resetLocalDir(): void {
  rmSync(LOCAL_DIR, { recursive: true, force: true })
  mkdirSync(BIN_DIR, { recursive: true })
  writeFileSync(
    join(LOCAL_DIR, 'package.json'),
    JSON.stringify({ name: 'claude-local', version: '0.0.1', private: true }),
  )
}

/** Simulate the writeIfMissing placeholder stub wrapper (no real package). */
function writeStubWrapper(): void {
  writeFileSync(
    join(LOCAL_DIR, 'claude'),
    `#!/bin/sh\nexec "${LOCAL_DIR}/node_modules/.bin/claude" "$@"`,
    { mode: 0o755 },
  )
}

/** Simulate a real installed package binary in node_modules/.bin. */
function writeRealBin(): void {
  const binPath = join(BIN_DIR, 'occ')
  writeFileSync(binPath, '#!/bin/sh\necho 2.1.367\n', { mode: 0o755 })
  chmodSync(binPath, 0o755)
}

let probeStdout = '2.1.367'
let probeExitCode = 0
let ignoreScriptsValue: string | null = 'false'
let installExitCode = 0

beforeEach(() => {
  execCalls = []
  debugLogs = []
  events = []
  savedConfigs = []
  probeStdout = '2.1.367'
  probeExitCode = 0
  ignoreScriptsValue = 'false'
  installExitCode = 0
  resetLocalDir()
  execResponder = (file: string, args: string[]) => {
    if (file === 'npm' && args[0] === 'install') {
      return { code: installExitCode, stdout: '', stderr: '' }
    }
    if (
      file === 'npm' &&
      args[0] === 'config' &&
      args[1] === 'get' &&
      args[2] === 'ignore-scripts'
    ) {
      return ignoreScriptsValue === null
        ? { code: 1, stdout: '', stderr: 'npm broken' }
        : { code: 0, stdout: `${ignoreScriptsValue}\n`, stderr: '' }
    }
    if (args.includes('--version')) {
      return {
        code: probeExitCode,
        stdout: probeExitCode === 0 ? probeStdout : '',
        stderr: probeExitCode === 0 ? '' : 'probe crashed',
      }
    }
    return { code: 1, stdout: '', stderr: 'unexpected exec' }
  }
})

afterAll(() => {
  mocksActive = false
  mock.module('../execFileNoThrow.js', () => ({ ...realExec }))
  mock.module('../debug.js', () => ({ ...realDebug }))
  mock.module('src/services/analytics/index.js', () => ({ ...realAnalytics }))
  mock.module('../config.js', () => ({ ...realConfig }))
  mock.module('../log.js', () => ({ ...realLog }))
  rmSync(LOCAL_DIR, { recursive: true, force: true })
})

describe('2.1.288 #50: local npm install post-install verification', () => {
  test('npm exits 0 but only the placeholder stub exists → install_failed', async () => {
    // Arrange: stub wrapper present, node_modules/.bin has no real binary
    writeStubWrapper()

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('install_failed')
    expect(savedConfigs.length).toBe(0)
    const errLog = debugLogs.find(l => l.level === 'error')
    expect(errLog).toBeDefined()
    expect(errLog?.message).toContain(
      'exited 0 but the installed claude is still the placeholder stub',
    )
    expect(
      events.some(e => e.name === 'update_apply_native_binary_missing'),
    ).toBe(true)
  })

  test('real version landed → success with probeDurationMs telemetry', async () => {
    // Arrange: real bin exists and the probe prints a valid semver
    writeRealBin()

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('success')
    expect(savedConfigs.some(c => c.installMethod === 'local')).toBe(true)
    const applied = events.find(e => e.name === 'update_apply')
    expect(applied).toBeDefined()
    expect(typeof applied?.metadata.probeDurationMs).toBe('number')
    expect(
      events.some(e => e.name === 'update_apply_native_binary_missing'),
    ).toBe(false)
  })

  test('stub + npm ignore-scripts deliberately true → success (trust exit code)', async () => {
    // Arrange
    writeStubWrapper()
    ignoreScriptsValue = 'true'

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('success')
    expect(savedConfigs.some(c => c.installMethod === 'local')).toBe(true)
    expect(
      debugLogs.some(l =>
        l.message.includes(
          'npm install scripts are disabled on purpose; trusting the exit code',
        ),
      ),
    ).toBe(true)
    expect(
      events.some(e => e.name === 'update_apply_native_binary_missing'),
    ).toBe(false)
  })

  test('stub + ignore-scripts query fails (not deliberate) → install_failed', async () => {
    // Arrange: cannot confirm ignore-scripts is deliberately true
    writeStubWrapper()
    ignoreScriptsValue = null

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('install_failed')
    expect(
      events.some(e => e.name === 'update_apply_native_binary_missing'),
    ).toBe(true)
  })

  test('probe crash (binary exists, exits non-zero) → inconclusive, success trusted + log', async () => {
    // Arrange: real bin exists but the --version probe fails
    writeRealBin()
    probeExitCode = 1

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('success')
    expect(savedConfigs.some(c => c.installMethod === 'local')).toBe(true)
    expect(
      debugLogs.some(l =>
        l.message.includes(
          'the install-prefix --version probe was inconclusive, trusting the exit code',
        ),
      ),
    ).toBe(true)
    expect(
      events.some(e => e.name === 'update_apply_native_binary_missing'),
    ).toBe(false)
  })

  test('probe prints non-semver garbage with exit 0 → inconclusive, success trusted', async () => {
    // Arrange
    writeRealBin()
    probeStdout = 'not-a-version'

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('success')
    expect(debugLogs.some(l => l.message.includes('inconclusive'))).toBe(true)
  })

  test('npm install itself fails (non-zero exit) → install_failed without probe', async () => {
    // Arrange
    installExitCode = 1
    writeStubWrapper()

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('install_failed')
    expect(execCalls.some(c => c.args.includes('--version'))).toBe(false)
  })

  test('npm exit 190 keeps in_progress semantics (no probe)', async () => {
    // Arrange
    installExitCode = 190
    writeStubWrapper()

    // Act
    const status = await installOrUpdateClaudePackage('latest')

    // Assert
    expect(status).toBe('in_progress')
    expect(execCalls.some(c => c.args.includes('--version'))).toBe(false)
  })
})
