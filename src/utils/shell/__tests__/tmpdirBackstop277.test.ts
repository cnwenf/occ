import { tmpdir as osTmpdir } from 'os'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Official Claude Code 2.1.277 changelog: "Fixed `$TMPDIR` expanding empty in
 * Bash commands that run outside the sandbox while sandboxing is enabled."
 *
 * Byte-verified official fix (v277 ≡ v278):
 * - caller @199,335,252: `tmpDirBackstop = sandboxTmpDir===undefined &&
 *   isSandboxingEnabled() && /\bTMPDIR\b/.test(command) ? XZr() : undefined`
 * - provider prelude @199,324,797: pushes the NON-destructive guard
 *   `{ [ -n "${TMPDIR:-}" ] || export TMPDIR=<quoted backstop>; }`
 *   (POSIX-converted on Windows), placed after the snapshot `source` and
 *   before the session-env / eval parts.
 * - `XZr()` @192,333,599: `By()` = `CLAUDE_CODE_TMPDIR || osTmpdir()`, kept
 *   when `Buffer.byteLength(dir) <= LPn` (44), else `osTmpdir()`.
 * - The provider env-object overrides (`getEnvironmentOverrides`) are
 *   UNCHANGED v276→v277 — the fix is the shell-prelude guard only.
 *
 * Mock.module hygiene per the OCC-97 lesson: snapshot real namespaces BEFORE
 * mocking and restore in afterAll.
 */
const actualSandboxModule = await import('../../sandbox/sandbox-adapter.js')
const actualSandboxExports = { ...actualSandboxModule }
const actualSessionEnvModule = await import('../../sessionEnvironment.js')
const actualSessionEnvExports = { ...actualSessionEnvModule }

let sandboxingEnabled = true

mock.module('../../sandbox/sandbox-adapter.js', () => ({
  ...actualSandboxExports,
  SandboxManager: {
    ...actualSandboxExports.SandboxManager,
    isSandboxingEnabled: () => sandboxingEnabled,
  },
}))

mock.module('../../sessionEnvironment.js', () => ({
  ...actualSessionEnvExports,
  getSessionEnvironmentScript: async () => '',
}))

afterAll(() => {
  mock.module('../../sandbox/sandbox-adapter.js', () => ({
    ...actualSandboxExports,
  }))
  mock.module('../../sessionEnvironment.js', () => ({
    ...actualSessionEnvExports,
  }))
})

const { createBashShellProvider } = await import('../bashProvider.js')
const { getTmpDirBackstop, getTmpRootDir } = await import(
  '../../tmpDirBackstop.js'
)
const { quote } = await import('../../bash/shellQuote.js')

let savedClaudeCodeTmpDir: string | undefined
beforeEach(() => {
  sandboxingEnabled = true
  savedClaudeCodeTmpDir = process.env.CLAUDE_CODE_TMPDIR
  delete process.env.CLAUDE_CODE_TMPDIR
})
afterEach(() => {
  if (savedClaudeCodeTmpDir === undefined) {
    delete process.env.CLAUDE_CODE_TMPDIR
  } else {
    process.env.CLAUDE_CODE_TMPDIR = savedClaudeCodeTmpDir
  }
})

async function build(
  command: string,
  opts: { sandboxTmpDir?: string; useSandbox: boolean },
): Promise<string> {
  const provider = await createBashShellProvider('/bin/bash', {
    skipSnapshot: true,
  })
  const { commandString } = await provider.buildExecCommand(command, {
    id: '0001',
    ...opts,
  })
  return commandString
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${TMPDIR:-}` in the official guard string, not a JS template placeholder.
const GUARD_PREFIX = '{ [ -n "${TMPDIR:-}" ] || export TMPDIR='

describe('2.1.277 B6 — getTmpDirBackstop (official By()/XZr())', () => {
  test('prefers CLAUDE_CODE_TMPDIR when set', () => {
    // Arrange
    process.env.CLAUDE_CODE_TMPDIR = '/custom/tmp'

    // Act & Assert
    expect(getTmpRootDir()).toBe('/custom/tmp')
    expect(getTmpDirBackstop()).toBe('/custom/tmp')
  })

  test('falls back to the OS temp dir when CLAUDE_CODE_TMPDIR is unset', () => {
    // Act & Assert
    expect(getTmpRootDir()).toBe(osTmpdir())
    expect(getTmpDirBackstop()).toBe(osTmpdir())
  })

  test('keeps CLAUDE_CODE_TMPDIR at exactly the 44-byte socket-path limit', () => {
    // Arrange — official LPn = 44, boundary is inclusive (<=)
    const dir = '/t' + 'x'.repeat(42)
    process.env.CLAUDE_CODE_TMPDIR = dir

    // Act & Assert
    expect(Buffer.byteLength(dir)).toBe(44)
    expect(getTmpDirBackstop()).toBe(dir)
  })

  test('falls back to the OS temp dir when CLAUDE_CODE_TMPDIR exceeds 44 bytes', () => {
    // Arrange
    process.env.CLAUDE_CODE_TMPDIR = '/t' + 'x'.repeat(43)

    // Act & Assert
    expect(getTmpDirBackstop()).toBe(osTmpdir())
  })
})

describe('2.1.277 B6 — shell-prelude TMPDIR guard (outside sandbox)', () => {
  test('command referencing TMPDIR outside the sandbox gets the non-destructive guard', async () => {
    // Act
    const commandString = await build('echo "$TMPDIR"', { useSandbox: false })

    // Assert — exact official guard shape, exporting the backstop dir
    const expected = `${GUARD_PREFIX}${quote([osTmpdir()])}; }`
    expect(commandString).toContain(expected)
  })

  test('guard exports ONLY when TMPDIR is unset/empty (preserves a user-set TMPDIR)', async () => {
    // Act
    const commandString = await build('echo "$TMPDIR"', { useSandbox: false })

    // Assert — the `[ -n "${TMPDIR:-}" ] ||` short-circuit is the official
    // non-destructive form (string table @97,974,585)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${TMPDIR:-}` guard fragment under test, not a JS template placeholder.
    expect(commandString).toContain('[ -n "${TMPDIR:-}" ] ||')
  })

  test('no guard when the command runs INSIDE the sandbox (sandbox tmp dir set)', async () => {
    // Act
    const commandString = await build('echo "$TMPDIR"', {
      sandboxTmpDir: '/tmp/claude-1000',
      useSandbox: true,
    })

    // Assert — inside the sandbox, TMPDIR comes from the env overrides
    expect(commandString).not.toContain(GUARD_PREFIX)
  })

  test('no guard when sandboxing is globally disabled', async () => {
    // Arrange
    sandboxingEnabled = false

    // Act
    const commandString = await build('echo "$TMPDIR"', { useSandbox: false })

    // Assert
    expect(commandString).not.toContain(GUARD_PREFIX)
  })

  test('no guard when the command text does not reference TMPDIR', async () => {
    // Act — official gate is /\bTMPDIR\b/ on the raw command
    const commandString = await build('echo hello', { useSandbox: false })

    // Assert
    expect(commandString).not.toContain(GUARD_PREFIX)
  })

  test('guard runs BEFORE the eval of the user command', async () => {
    // Act
    const commandString = await build('echo "$TMPDIR"', { useSandbox: false })

    // Assert
    expect(commandString.indexOf(GUARD_PREFIX)).toBeLessThan(
      commandString.indexOf('eval '),
    )
  })

  test('guard honors a short CLAUDE_CODE_TMPDIR', async () => {
    // Arrange
    process.env.CLAUDE_CODE_TMPDIR = '/custom/tmp'

    // Act
    const commandString = await build('echo "$TMPDIR"', { useSandbox: false })

    // Assert
    expect(commandString).toContain(
      `${GUARD_PREFIX}${quote(['/custom/tmp'])}; }`,
    )
  })

  test('guard falls back to the OS temp dir for an over-long CLAUDE_CODE_TMPDIR', async () => {
    // Arrange
    process.env.CLAUDE_CODE_TMPDIR = '/t' + 'x'.repeat(43)

    // Act
    const commandString = await build('echo "$TMPDIR"', { useSandbox: false })

    // Assert
    expect(commandString).toContain(`${GUARD_PREFIX}${quote([osTmpdir()])}; }`)
  })
})

describe('2.1.277 B6 — provider env overrides unchanged (official v276≡v277)', () => {
  test('inside sandbox: TMPDIR/CLAUDE_CODE_TMPDIR/TMPPREFIX still come from the env overrides', async () => {
    // Arrange
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })
    await provider.buildExecCommand('echo hi', {
      id: '0001',
      sandboxTmpDir: '/tmp/claude-1000',
      useSandbox: true,
    })

    // Act
    const env = await provider.getEnvironmentOverrides('echo hi')

    // Assert
    expect(env.TMPDIR).toBe('/tmp/claude-1000')
    expect(env.CLAUDE_CODE_TMPDIR).toBe('/tmp/claude-1000')
    expect(env.TMPPREFIX).toBe('/tmp/claude-1000/zsh')
  })

  test('outside sandbox: env overrides carry NO TMPDIR (the fix is the shell guard, not the env object)', async () => {
    // Arrange
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })
    await provider.buildExecCommand('echo "$TMPDIR"', {
      id: '0001',
      useSandbox: false,
    })

    // Act
    const env = await provider.getEnvironmentOverrides('echo "$TMPDIR"')

    // Assert — a user-set process.env.TMPDIR must not be clobbered by the
    // override object (it is spread AFTER subprocessEnv() in Shell.ts)
    expect(env.TMPDIR).toBeUndefined()
    expect(env.TMPPREFIX).toBeUndefined()
  })
})
