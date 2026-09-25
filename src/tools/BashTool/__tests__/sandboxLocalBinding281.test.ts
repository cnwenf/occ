import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.281 PORT #111 tests: macOS EPERM local-port-binding guidance in the
 * Bash sandbox prompt section.
 *
 * Official gate (v281 ELF @203529833):
 *   sandboxOn && platform === "macos" && !getAllowLocalBinding()
 * (sandboxOn is implied by getSimpleSandboxSection's early return).
 * Variant selection: areUnsandboxedCommandsAllowed() → the "Treat it as the
 * sandbox-caused failure described above" item; otherwise the "Tell the user
 * they can allow it" item with the official Te() escape-hatch suffix
 * (getIsNonInteractiveSession → "", interactive + no CLAUDE_CODE_SESSION_KIND
 * → exclude-or-bang, other session kinds → exclude-only).
 *
 * Mock hygiene per the OCC-97 lesson: snapshot real namespaces BEFORE
 * mocking and restore in afterAll.
 */
const actualSandboxModule = await import(
  '../../../utils/sandbox/sandbox-adapter.js'
)
const actualSandboxExports = { ...actualSandboxModule }
const actualPlatformModule = await import('../../../utils/platform.js')
const actualPlatformExports = { ...actualPlatformModule }
const actualStateModule = await import('../../../bootstrap/state.js')
const actualStateExports = { ...actualStateModule }

let sandboxingEnabled = true
let unsandboxedCommandsAllowed = true
let allowLocalBinding: boolean | undefined
let mockedPlatform: 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown' = 'macos'
let nonInteractiveSession = false
// Passthrough flag: bun's mock.module is process-global and a re-mock
// "restore" does NOT heal modules whose bindings already resolved to the
// mock namespace — with the flag off (afterAll) every seam below delegates
// to the REAL implementation, so leaked closures stay behavior-neutral for
// later files in the shared test process.
let bindingMocksActive = true
const actualSandboxManager = actualSandboxExports.SandboxManager

mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
  ...actualSandboxExports,
  SandboxManager: {
    ...actualSandboxExports.SandboxManager,
    isSandboxingEnabled: () =>
      bindingMocksActive
        ? sandboxingEnabled
        : actualSandboxManager.isSandboxingEnabled(),
    areUnsandboxedCommandsAllowed: () =>
      bindingMocksActive
        ? unsandboxedCommandsAllowed
        : actualSandboxManager.areUnsandboxedCommandsAllowed(),
    getAllowLocalBinding: () =>
      bindingMocksActive
        ? allowLocalBinding
        : actualSandboxManager.getAllowLocalBinding(),
    getFsReadConfig: () =>
      bindingMocksActive
        ? { denyOnly: ['/etc/shadow'] }
        : actualSandboxManager.getFsReadConfig(),
    getFsWriteConfig: () =>
      bindingMocksActive
        ? {
            allowOnly: ['/home/user/project'],
            denyWithinAllow: [],
          }
        : actualSandboxManager.getFsWriteConfig(),
    getNetworkRestrictionConfig: () =>
      bindingMocksActive
        ? undefined
        : actualSandboxManager.getNetworkRestrictionConfig(),
    getAllowUnixSockets: () =>
      bindingMocksActive
        ? undefined
        : actualSandboxManager.getAllowUnixSockets(),
    getIgnoreViolations: () =>
      bindingMocksActive ? undefined : actualSandboxManager.getIgnoreViolations(),
  },
}))

mock.module('../../../utils/platform.js', () => ({
  ...actualPlatformExports,
  getPlatform: () =>
    bindingMocksActive
      ? mockedPlatform
      : (actualPlatformExports.getPlatform as () => typeof mockedPlatform)(),
}))

mock.module('../../../bootstrap/state.js', () => ({
  ...actualStateExports,
  getIsNonInteractiveSession: () =>
    bindingMocksActive
      ? nonInteractiveSession
      : (actualStateExports.getIsNonInteractiveSession as () => boolean)(),
}))

afterAll(() => {
  bindingMocksActive = false
  mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
    ...actualSandboxExports,
  }))
  mock.module('../../../utils/platform.js', () => ({
    ...actualPlatformExports,
  }))
  mock.module('../../../bootstrap/state.js', () => ({
    ...actualStateExports,
  }))
})

const { getSimplePrompt } = await import('../prompt.js')

const EPERM_PREFIX =
  'If a command fails to bind or listen on a local port with "Operation not permitted" (EPERM), local port binding is off in this sandbox. '
const TREAT_AS_FAILURE_ITEM = `${EPERM_PREFIX}Treat it as the sandbox-caused failure described above, and tell the user that \`sandbox.network.allowLocalBinding: true\` in their settings (it applies without a restart) allows it without leaving the sandbox.`
const TELL_USER_ITEM_PREFIX = `${EPERM_PREFIX}Tell the user they can allow it with \`sandbox.network.allowLocalBinding: true\` in their settings (it applies without a restart)`
const TELL_USER_ITEM_SUFFIX =
  '; changing sandbox settings is their decision, not yours.'

let savedSessionKind: string | undefined

beforeEach(() => {
  sandboxingEnabled = true
  unsandboxedCommandsAllowed = true
  allowLocalBinding = undefined
  mockedPlatform = 'macos'
  nonInteractiveSession = false
  savedSessionKind = process.env.CLAUDE_CODE_SESSION_KIND
  delete process.env.CLAUDE_CODE_SESSION_KIND
})

afterAll(() => {
  if (savedSessionKind === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_KIND
  } else {
    process.env.CLAUDE_CODE_SESSION_KIND = savedSessionKind
  }
})

describe('2.1.281 #111 — macOS EPERM local-port-binding guidance', () => {
  test('macOS + sandbox + local binding off + unsandboxed allowed → treat-as-sandbox-failure item', () => {
    // Arrange
    mockedPlatform = 'macos'
    allowLocalBinding = undefined
    unsandboxedCommandsAllowed = true

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(TREAT_AS_FAILURE_ITEM)
    expect(prompt).toContain('sandbox.network.allowLocalBinding: true')
    expect(prompt).not.toContain(TELL_USER_ITEM_PREFIX)
  })

  test('macOS + sandbox + local binding off + unsandboxed disabled → tell-the-user item with exclude-or-bang suffix (interactive, no session kind)', () => {
    // Arrange
    unsandboxedCommandsAllowed = false
    nonInteractiveSession = false
    delete process.env.CLAUDE_CODE_SESSION_KIND

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      `${TELL_USER_ITEM_PREFIX}, exclude the command with \`/sandbox exclude <pattern>\`, or run it themselves with the \`!\` prefix${TELL_USER_ITEM_SUFFIX}`,
    )
    expect(prompt).not.toContain(TREAT_AS_FAILURE_ITEM)
  })

  test('tell-the-user item uses the exclude-only suffix when a session kind is set', () => {
    // Arrange
    unsandboxedCommandsAllowed = false
    nonInteractiveSession = false
    process.env.CLAUDE_CODE_SESSION_KIND = 'team'

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      `${TELL_USER_ITEM_PREFIX}, or exclude the command with \`/sandbox exclude <pattern>\`${TELL_USER_ITEM_SUFFIX}`,
    )
  })

  test('tell-the-user item drops the escape-hatch suffix in non-interactive sessions', () => {
    // Arrange
    unsandboxedCommandsAllowed = false
    nonInteractiveSession = true

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(
      `${TELL_USER_ITEM_PREFIX}${TELL_USER_ITEM_SUFFIX}`,
    )
    expect(prompt).not.toContain('/sandbox exclude <pattern>`, or run it themselves')
  })

  test('allowLocalBinding: true suppresses the guidance', () => {
    // Arrange
    allowLocalBinding = true

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).not.toContain('allowLocalBinding')
  })

  test('allowLocalBinding: false still shows the guidance (explicitly off)', () => {
    // Arrange
    allowLocalBinding = false
    unsandboxedCommandsAllowed = true

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain(TREAT_AS_FAILURE_ITEM)
  })

  test('non-macOS platforms never get the guidance', () => {
    // Arrange
    mockedPlatform = 'linux'
    allowLocalBinding = undefined

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).toContain('## Bash command sandbox')
    expect(prompt).not.toContain('allowLocalBinding')
  })

  test('sandbox disabled → no sandbox section and no guidance', () => {
    // Arrange
    sandboxingEnabled = false

    // Act
    const prompt = getSimplePrompt()

    // Assert
    expect(prompt).not.toContain('## Bash command sandbox')
    expect(prompt).not.toContain('allowLocalBinding')
  })
})
