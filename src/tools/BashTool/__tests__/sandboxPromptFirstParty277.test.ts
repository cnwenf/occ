import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Official Claude Code 2.1.277 changelog: "Changed the Bash sandbox
 * instructions on Bedrock, Vertex and Foundry to the first-party wording"
 * (A12 — the `tengu_elegant_ocean` flag default flipped false→true, so the
 * flag-ON branch of the official `HTn` builder is now shipped everywhere).
 *
 * Byte-verified against the v278 ELF (HTn @201,704,500-201,714,200):
 * - header: "## Bash command sandbox"
 * - intro: "By default, Bash commands run inside an OS-level sandbox${kUo()}
 *   applied to each command separately, not to the session as a whole; ..."
 *   with kUo(): macos → " (macOS Seatbelt)", linux/wsl → " (Linux bubblewrap)",
 *   else → ""
 * - the `_Uo` boundary paragraph (verbatim below)
 * - "How the sandbox is configured in this session:" replaces the flag-OFF
 *   "The sandbox has the following restrictions:"
 * - flag-ON retry pair (ve=false else-variant — OCC has no
 *   registerCommandNetworkLists) + the credential-denial boundary bullet
 * - policy-disabled (!h) branch: the official TWO bullets (byte-identical
 *   v276 ≡ v278), replacing OCC's older 2.1.248-era three-bullet drift.
 *
 * Mock.module hygiene per the OCC-97 lesson: snapshot the real namespaces
 * BEFORE mocking and restore in afterAll.
 */
const actualSandboxModule = await import(
  '../../../utils/sandbox/sandbox-adapter.js'
)
const actualSandboxExports = { ...actualSandboxModule }
const actualPlatformModule = await import('../../../utils/platform.js')
const actualPlatformExports = { ...actualPlatformModule }

let sandboxingEnabled = true
let unsandboxedCommandsAllowed = true
let mockedPlatform: 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown' = 'linux'

mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
  ...actualSandboxExports,
  SandboxManager: {
    ...actualSandboxExports.SandboxManager,
    isSandboxingEnabled: () => sandboxingEnabled,
    areUnsandboxedCommandsAllowed: () => unsandboxedCommandsAllowed,
    getFsReadConfig: () => ({ denyOnly: ['/etc/shadow'] }),
    getFsWriteConfig: () => ({
      allowOnly: ['/home/user/project'],
      denyWithinAllow: [],
    }),
    getNetworkRestrictionConfig: () => undefined,
    getAllowUnixSockets: () => undefined,
    getIgnoreViolations: () => undefined,
  },
}))

mock.module('../../../utils/platform.js', () => ({
  ...actualPlatformExports,
  getPlatform: () => mockedPlatform,
}))

afterAll(() => {
  mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
    ...actualSandboxExports,
  }))
  mock.module('../../../utils/platform.js', () => ({
    ...actualPlatformExports,
  }))
})

const { getSimplePrompt } = await import('../prompt.js')

beforeEach(() => {
  sandboxingEnabled = true
  unsandboxedCommandsAllowed = true
  mockedPlatform = 'linux'
})

/** Official `_Uo` boundary paragraph, byte-verbatim from the v278 ELF. */
const BOUNDARY_PARAGRAPH =
  "The sandbox marks out what this session was given: the directories listed below, the network destinations the task involves, and the credentials the user supplied for it. Treat that as the boundary even where a limit below is not enforced. Commands can reach more than that — credentials and keys elsewhere on this machine, the user's other projects and configuration, sockets that control this machine or other workloads, cloud metadata endpoints — but being reachable does not make them provided; those are the user's, not the task's, unless the user's request calls for them. If the task cannot be finished with what you were given, do what you can and tell the user plainly what is missing instead of finding another way to it; that report is a complete answer."

describe('2.1.277 A12 — first-party sandbox section header/intro', () => {
  test('renders the tool-name header and per-command intro with the Linux suffix', () => {
    // Arrange
    mockedPlatform = 'linux'

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain('## Bash command sandbox')
    expect(prompt).toContain(
      'By default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, not to the session as a whole; how it is configured in this session is described below.',
    )
  })

  test('macOS gets the Seatbelt suffix', () => {
    // Arrange
    mockedPlatform = 'macos'

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      'OS-level sandbox (macOS Seatbelt) applied to each command separately',
    )
  })

  test('WSL gets the bubblewrap suffix', () => {
    // Arrange
    mockedPlatform = 'wsl'

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      'OS-level sandbox (Linux bubblewrap) applied to each command separately',
    )
  })

  test('windows/unknown get no suffix (official kUo empty branch)', () => {
    // Arrange
    mockedPlatform = 'windows'

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      'OS-level sandbox applied to each command separately',
    )
    expect(prompt).not.toContain('(macOS Seatbelt)')
    expect(prompt).not.toContain('(Linux bubblewrap)')
  })

  test('no sandbox section at all when sandboxing is disabled', () => {
    // Arrange
    sandboxingEnabled = false

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).not.toContain('## Bash command sandbox')
    expect(prompt).not.toContain(BOUNDARY_PARAGRAPH)
  })
})

describe('2.1.277 A12 — boundary paragraph and config intro', () => {
  test('contains the official boundary paragraph verbatim', () => {
    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(BOUNDARY_PARAGRAPH)
  })

  test('session-config intro replaces the flag-OFF restrictions header', () => {
    // Act
    const prompt = getSimplePrompt()

    // Assert — new flag-ON line present, old flag-OFF wording gone
    expect(prompt).toContain('How the sandbox is configured in this session:')
    expect(prompt).not.toContain('The sandbox has the following restrictions:')
    expect(prompt).not.toContain(
      'By default, your command will be run in a sandbox.',
    )
  })

  test('filesystem restriction lines still render after the new intro', () => {
    // Act
    const prompt = getSimplePrompt()

    // Assert
    const introIdx = prompt.indexOf(
      'How the sandbox is configured in this session:',
    )
    const fsIdx = prompt.indexOf('Filesystem: ')
    expect(introIdx).toBeGreaterThan(-1)
    expect(fsIdx).toBeGreaterThan(introIdx)
    expect(prompt).toContain('/etc/shadow')
  })
})

describe('2.1.277 A12 — flag-ON retry guidance', () => {
  test('retry pair is the official flag-ON else-variant (ve=false)', () => {
    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      'Retry with `dangerouslyDisableSandbox: true` directly rather than asking in prose first — the retry itself goes through the permission gate (a user prompt, or the auto-mode classifier when auto mode is active)',
    )
    expect(prompt).toContain(
      'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
    )
  })

  test('old flag-OFF retry bullets are gone', () => {
    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).not.toContain(
      "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
    )
    expect(prompt).not.toContain('This will prompt the user for permission')
  })

  test('credential-denial boundary bullet follows the retry pair', () => {
    // Act
    const prompt = getSimplePrompt()

    // Assert
    const credentialBullet =
      'A sandbox denial on a credential, a file or a host that the task does not involve is the boundary above at work: tell the user rather than retrying with `dangerouslyDisableSandbox: true`.'
    expect(prompt).toContain(credentialBullet)
    // positioned after the retry pair, before the per-command "Treat" bullet
    expect(prompt.indexOf(credentialBullet)).toBeGreaterThan(
      prompt.indexOf('When you see evidence of sandbox-caused failure:'),
    )
    expect(prompt.indexOf(credentialBullet)).toBeLessThan(
      prompt.indexOf(
        'Treat each command you execute with `dangerouslyDisableSandbox: true` individually.',
      ),
    )
  })
})

describe('2.1.277 A12 — policy-disabled (!h) branch', () => {
  test('ships the official two bullets when unsandboxed commands are disallowed', () => {
    // Arrange
    unsandboxedCommandsAllowed = false

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      "The `dangerouslyDisableSandbox` parameter is disabled in this session's configuration; setting it does not take a command out of the sandbox.",
    )
    expect(prompt).toContain(
      'If a command the task needs fails on a sandbox restriction, tell the user which restriction it hit; changing the sandbox settings is their decision, not yours.',
    )
  })

  test('old 2.1.248-era three-bullet drift is gone', () => {
    // Arrange
    unsandboxedCommandsAllowed = false

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).not.toContain('All commands MUST run in sandbox mode')
    expect(prompt).not.toContain(
      'Commands cannot run outside the sandbox under any circumstances.',
    )
    expect(prompt).not.toContain(
      'work with the user to adjust sandbox settings instead.',
    )
  })
})
