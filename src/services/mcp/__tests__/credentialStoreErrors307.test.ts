/**
 * claude-code 2.1.307 PORT B1 — MCP macOS keychain-locked credential-store
 * errors (`McpCredentialStoreUnavailableError`, official `JDe` @241629512
 * linux ELF / `rDe` darwin ELF) + the per-server strict-read probe (official
 * `Tre`/`Are` @242287761 linux / `Ore`/`Mre` darwin @220653398).
 *
 * Contract pinned here (all strings/constants byte-verified against the
 * official 2.1.307 linux-x64 AND darwin-arm64 binaries):
 *   - unreadable-mode message, macOS branch:
 *     `Couldn't read the stored credentials for MCP server "<name>", so the
 *      request didn't run. If your Mac's keychain is locked, unlock it, then
 *      try again.`  (telemetry: "MCP credential store could not be read")
 *   - unreadable-mode message, non-macOS branch: same, but `Try again.`
 *   - read-too-late message:
 *     `A request to MCP server "<name>" was sent without your stored
 *      credentials, so the server rejected it. The credentials are available
 *      now. Try again.`
 *     (telemetry: "MCP credentials were read only after a request went out
 *      without them")
 *   - code = "CREDENTIAL_STORE_UNAVAILABLE",
 *     name = "McpCredentialStoreUnavailableError"
 *   - the INACCESSIBLE sentinel is never conflated with undefined/absent:
 *     `readMcpOAuthCredentials` maps sentinel → undefined, but
 *     `readCredentialStoreStrict` returns the sentinel itself, and the
 *     provider's `readCredentialStore()` THROWS instead of reporting
 *     credentials as absent.
 *   - per-server probe gating (official `Are` per-server branch):
 *     cached tokens → skip; `!challenged && !discoveryButNoToken` → skip;
 *     interactive session → skip (official `_e()` =
 *     `!host.launchOptions.isInteractive()`, both builds @238623598 /
 *     @216985158); non-keychain backend → skip (official `_zt()!=="keychain"`
 *     — a platform constant: darwin build returns "keychain" @219747106,
 *     linux returns "file" @241380122).
 *   - caches: 1s negative (`mT`/`hT`=1000), 30s answered (`_T`/`yT`=30000).
 *   - read-too-late throw with the verbatim log:
 *     `Stored credentials turned up only after the server challenged a
 *      request sent without them; failing that request so the next one sends
 *      them`
 *
 * Repo mock.module template (mcpOAuthTransientSkip281.test.ts): snapshot
 * actuals BEFORE mocking, dynamic-import the modules under test AFTER
 * registration, heal + restore in afterAll (bun mock.module is process-global,
 * OCC-97). `credentialStoreErrors.js` is imported under its PLAIN specifier
 * (single shared module state between the direct tests and the isolated auth
 * instance); `auth.js` gets the cache-busting query so this file's provider
 * instance does not pollute the process-global auth module for other tests.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const realSecureStorageIndex = {
  ...(await import('../../../utils/secureStorage/index.js')),
}
const realPlatform = { ...(await import('../../../utils/platform.js')) }
const realLog = { ...(await import('../../../utils/log.js')) }

import { setIsInteractive } from '../../../bootstrap/state.js'
import { TRANSIENT_READ_FAILURE } from '../../../utils/secureStorage/transientRead.js'

let fakeStorage: unknown
let loggedDebug: Array<{ server: string; message: string }> = []
let credentialStore307MocksActive = true

const actualLogMCPDebug = realLog.logMCPDebug as (
  server: string,
  message: string,
) => void

mock.module('../../../utils/secureStorage/index.js', () => ({
  ...realSecureStorageIndex,
  getSecureStorage: () => fakeStorage,
}))

mock.module('../../../utils/log.js', () => ({
  ...realLog,
  logMCPDebug: (server: string, message: string) => {
    if (credentialStore307MocksActive) {
      loggedDebug.push({ server, message })
    } else {
      actualLogMCPDebug(server, message)
    }
  },
}))

// Import the targets AFTER the mocks are registered.
const ISOLATED_AUTH = '../auth.js?occ-credstore-307-auth'
const {
  McpCredentialStoreUnavailableError,
  readCredentialStoreStrict,
  readMcpOAuthCredentials,
  hasMcpRefreshToken,
  CREDENTIAL_STORE_NEGATIVE_CACHE_MS,
  CREDENTIAL_STORE_ANSWERED_CACHE_MS,
  _resetCredentialStoreProbeStateForTesting,
} = await import('../credentialStoreErrors.js')
const { ClaudeAuthProvider, getServerKey } = (await import(
  ISOLATED_AUTH
)) as typeof import('../auth.js')

afterAll(() => {
  credentialStore307MocksActive = false
  setIsInteractive(false)
  fakeStorage = (
    realSecureStorageIndex as { getSecureStorage: () => unknown }
  ).getSecureStorage()
  mock.module(
    '../../../utils/secureStorage/index.js',
    () => realSecureStorageIndex,
  )
  mock.module('../../../utils/log.js', () => realLog)
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const SERVER_NAME = 'srv-b1'
const SERVER_CONFIG = {
  type: 'http' as const,
  url: 'https://srv-b1.example.com/mcp',
}
const SERVER_KEY = getServerKey(SERVER_NAME, SERVER_CONFIG)

interface FakeStorageOptions {
  /** Backend name; the darwin OCC backend is the keychain fallback pair. */
  name?: string
  /** What readAsync()/read() return (the "plain" read result). */
  asyncResult?: Record<string, unknown> | null
  /**
   * Strict-read results, consumed in call order (the last entry repeats).
   * Call #1 is the blob-level probe (official: `readAsyncStrict()` no args —
   * 'absent' semantics), call #2 the per-server keychain-only probe
   * (official: `readAsyncStrict(void 0, {inaccessibleAs:"failure"})`).
   */
  strictResults?: unknown[]
  hasReadStrict?: boolean
}

function createFakeStorage(options: FakeStorageOptions = {}) {
  const calls = { readAsync: 0, readStrict: 0 }
  const stored = options.asyncResult ?? null
  const strictQueue = options.strictResults ?? [stored]
  const storage: Record<string, unknown> = {
    name: options.name ?? 'keychain-with-plaintext-fallback',
    read() {
      return stored
    },
    async readAsync() {
      calls.readAsync++
      return stored
    },
    readStrict(_opts?: unknown) {
      const result =
        strictQueue[Math.min(calls.readStrict, strictQueue.length - 1)]
      calls.readStrict++
      return result
    },
    update(data: unknown) {
      return { success: true, data }
    },
    delete() {
      return true
    },
  }
  if (options.hasReadStrict === false) {
    delete storage.readStrict
  }
  return { storage, calls }
}

function resetState(): void {
  _resetCredentialStoreProbeStateForTesting()
  loggedDebug = []
  setIsInteractive(false)
}

afterEach(() => {
  resetState()
})

/**
 * Runs `body` with getPlatform() reporting `platform` (lodash-memoized —
 * clear its cache around the override; the official message branches on
 * `O()==="macos"`).
 */
async function withPlatform<T>(
  platform: 'darwin' | 'linux',
  body: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
  const getPlatform = (
    realPlatform as {
      getPlatform: { cache: { clear(): void }; (): string }
    }
  ).getPlatform
  getPlatform.cache.clear()
  try {
    return await body()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
    getPlatform.cache.clear()
  }
}

const CHALLENGED_TARGET = {
  serverName: SERVER_NAME,
  serverConfig: SERVER_CONFIG,
  challenged: true,
}

// ---------------------------------------------------------------------------
// (a) The error class — verbatim messages / code / name
// ---------------------------------------------------------------------------

describe('2.1.307 B1 McpCredentialStoreUnavailableError', () => {
  test('unreadable mode renders the macOS keychain-locked message verbatim', async () => {
    await withPlatform('darwin', async () => {
      // Arrange / Act
      const error = new McpCredentialStoreUnavailableError('srv-b1')

      // Assert
      expect(error.message).toBe(
        `Couldn't read the stored credentials for MCP server "srv-b1", so the request didn't run. If your Mac's keychain is locked, unlock it, then try again.`,
      )
    })
  })

  test('unreadable mode renders the non-macOS message verbatim', async () => {
    await withPlatform('linux', async () => {
      // Arrange / Act
      const error = new McpCredentialStoreUnavailableError('srv-b1')

      // Assert
      expect(error.message).toBe(
        `Couldn't read the stored credentials for MCP server "srv-b1", so the request didn't run. Try again.`,
      )
    })
  })

  test('read-too-late mode renders the verbatim message', () => {
    // Arrange / Act
    const error = new McpCredentialStoreUnavailableError(
      'srv-b1',
      'read-too-late',
    )

    // Assert
    expect(error.message).toBe(
      `A request to MCP server "srv-b1" was sent without your stored credentials, so the server rejected it. The credentials are available now. Try again.`,
    )
  })

  test('carries code CREDENTIAL_STORE_UNAVAILABLE and the official name', () => {
    // Arrange / Act
    const error = new McpCredentialStoreUnavailableError('srv-b1')

    // Assert
    expect(error.code).toBe('CREDENTIAL_STORE_UNAVAILABLE')
    expect(error.name).toBe('McpCredentialStoreUnavailableError')
    expect(error).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// (b) The strict-read probe — sentinel handling + gating + caches
// ---------------------------------------------------------------------------

describe('2.1.307 B1 readCredentialStoreStrict probe', () => {
  test('returns the populated blob without consulting readStrict', async () => {
    // Arrange
    resetState()
    const blob = { mcpOAuth: { [SERVER_KEY]: { accessToken: 'a' } } }
    const fake = createFakeStorage({ asyncResult: blob })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert
    expect(result).toBe(blob)
    expect(fake.calls.readStrict).toBe(0)
  })

  test('probes strictly when keychain-backed, challenged, and no cached creds — sentinel is returned, never null', async () => {
    // Arrange
    resetState()
    const fake = createFakeStorage({
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert — the sentinel, identity-matched; NOT null/undefined.
    // Two strict reads: the blob-level probe (empty blob → strict probe) and
    // the per-server keychain-only probe.
    expect(result).toBe(TRANSIENT_READ_FAILURE)
    expect(result).not.toBeNull()
    expect(result).not.toBeUndefined()
    expect(fake.calls.readStrict).toBe(2)
  })

  test('does not probe per-server when the backend is not keychain-based', async () => {
    // Arrange
    resetState()
    const fake = createFakeStorage({
      name: 'plaintext',
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert — the blob-level probe still runs (backend-agnostic), but its
    // sentinel degrades to the plain read (store never seen populated); the
    // per-server keychain-only probe is gated off by the backend name.
    expect(result).toBeNull()
    expect(fake.calls.readStrict).toBe(1)
  })

  test('does not probe per-server when not challenged and no discovery state is stored', async () => {
    // Arrange
    resetState()
    const fake = createFakeStorage({
      asyncResult: { someOtherSection: {} },
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict({
      serverName: SERVER_NAME,
      serverConfig: SERVER_CONFIG,
      challenged: false,
    })

    // Assert — the populated blob read short-circuits both probes.
    expect(result).toEqual({ someOtherSection: {} })
    expect(fake.calls.readStrict).toBe(0)
  })

  test('does not probe when cached credentials exist for the server', async () => {
    // Arrange
    resetState()
    const blob = { mcpOAuth: { [SERVER_KEY]: { refreshToken: 'r' } } }
    const fake = createFakeStorage({
      asyncResult: blob,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert
    expect(result).toBe(blob)
    expect(fake.calls.readStrict).toBe(0)
  })

  test('does not probe per-server in an interactive session (official _e gate)', async () => {
    // Arrange
    resetState()
    setIsInteractive(true)
    const fake = createFakeStorage({
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert — only the blob-level probe ran; the per-server probe is
    // headless-only, so an interactive caller sees the plain (null) read
    // rather than the sentinel.
    expect(result).toBeNull()
    expect(fake.calls.readStrict).toBe(1)
  })

  test('negative cache: a second challenged read within 1s returns the sentinel without re-probing', async () => {
    // Arrange
    resetState()
    const fake = createFakeStorage({
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage
    expect(CREDENTIAL_STORE_NEGATIVE_CACHE_MS).toBe(1000)

    // Act
    const first = await readCredentialStoreStrict(CHALLENGED_TARGET)
    const second = await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert — first call: blob probe + keychain-only probe (2). Second call
    // within 1s: both verdict caches answer without any further strict read.
    expect(first).toBe(TRANSIENT_READ_FAILURE)
    expect(second).toBe(TRANSIENT_READ_FAILURE)
    expect(fake.calls.readStrict).toBe(2)
  })

  test('answered cache: a successful probe suppresses re-probing for 30s', async () => {
    // Arrange — the plain blob is populated (so the blob level never probes)
    // but holds no tokens for THIS server, opening the per-server probe.
    resetState()
    const answeredBlob = { mcpOAuth: {} }
    const fake = createFakeStorage({
      asyncResult: answeredBlob,
      strictResults: [answeredBlob],
    })
    fakeStorage = fake.storage
    expect(CREDENTIAL_STORE_ANSWERED_CACHE_MS).toBe(30000)

    // Act
    await readCredentialStoreStrict(CHALLENGED_TARGET)
    await readCredentialStoreStrict(CHALLENGED_TARGET)

    // Assert — one keychain-only probe; the answered verdict is cached 30s.
    expect(fake.calls.readStrict).toBe(1)
  })

  test('read-too-late: challenged probe that turns up credentials throws with the verbatim log', async () => {
    // Arrange — the blob-level strict probe answers "empty" (locked-keychain
    // 'absent' semantics → null), the per-server keychain-only probe then
    // finds the credentials that were not reported to the outgoing request.
    resetState()
    const lateBlob = {
      mcpOAuth: {
        [SERVER_KEY]: { accessToken: 'late-access', refreshToken: 'late-r' },
      },
    }
    const fake = createFakeStorage({
      asyncResult: null,
      strictResults: [null, lateBlob],
    })
    fakeStorage = fake.storage

    // Act / Assert
    const error = await readCredentialStoreStrict(CHALLENGED_TARGET).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(McpCredentialStoreUnavailableError)
    expect((error as Error).message).toBe(
      `A request to MCP server "srv-b1" was sent without your stored credentials, so the server rejected it. The credentials are available now. Try again.`,
    )
    expect((error as { code: string }).code).toBe(
      'CREDENTIAL_STORE_UNAVAILABLE',
    )
    expect(loggedDebug).toContainEqual({
      server: SERVER_NAME,
      message:
        'Stored credentials turned up only after the server challenged a request sent without them; failing that request so the next one sends them',
    })
  })

  test('unchallenged probe that turns up credentials returns the probed blob instead of throwing', async () => {
    // Arrange — discovery-but-no-token state gates the probe open even
    // without a 401 challenge; the strict probe then answers with tokens.
    resetState()
    const seeded = {
      mcpOAuth: { [SERVER_KEY]: { serverName: SERVER_NAME, clientId: 'cid' } },
    }
    const probedBlob = {
      mcpOAuth: {
        [SERVER_KEY]: {
          serverName: SERVER_NAME,
          serverUrl: SERVER_CONFIG.url,
          clientId: 'cid',
          accessToken: 'late-access',
        },
      },
    }
    const fake = createFakeStorage({
      asyncResult: seeded,
      strictResults: [probedBlob],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readCredentialStoreStrict({
      serverName: SERVER_NAME,
      serverConfig: SERVER_CONFIG,
      challenged: false,
    })

    // Assert — no throw; the answered strict result is surfaced.
    expect(result).toBe(probedBlob)
  })
})

// ---------------------------------------------------------------------------
// (c) Tre/U2e ports — sentinel is never conflated with absent
// ---------------------------------------------------------------------------

describe('2.1.307 B1 readMcpOAuthCredentials / hasMcpRefreshToken', () => {
  test('readMcpOAuthCredentials without a server reads the plain async blob', async () => {
    // Arrange
    resetState()
    const blob = { mcpOAuth: { [SERVER_KEY]: { accessToken: 'a' } } }
    const fake = createFakeStorage({ asyncResult: blob })
    fakeStorage = fake.storage

    // Act
    const result = await readMcpOAuthCredentials()

    // Assert
    expect(result).toBe(blob.mcpOAuth)
    expect(fake.calls.readStrict).toBe(0)
  })

  test('readMcpOAuthCredentials maps the sentinel to undefined (never throws)', async () => {
    // Arrange
    resetState()
    const fake = createFakeStorage({
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage

    // Act
    const result = await readMcpOAuthCredentials(CHALLENGED_TARGET)

    // Assert
    expect(result).toBeUndefined()
  })

  test('hasMcpRefreshToken returns true when a previously-populated store becomes inaccessible', async () => {
    // Arrange — the process saw populated credentials first (seenPopulated),
    // then the store locks: only then does the blob-level read report the
    // sentinel (official `S===gl&&!s.seenPopulated?r:S` guard). Seed via the
    // blob-mode strict read (official U2e calls `Are()` with no args;
    // recordPopulated only happens on that path, not the plain Tre read).
    resetState()
    fakeStorage = createFakeStorage({ asyncResult: { mcpOAuth: {} } }).storage
    await readCredentialStoreStrict()

    // Act
    fakeStorage = createFakeStorage({
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    }).storage
    const result = await hasMcpRefreshToken(SERVER_NAME, SERVER_CONFIG)

    // Assert — official U2e: sentinel → true (do not report creds as absent).
    expect(result).toBe(true)
  })

  test('hasMcpRefreshToken reflects the stored refresh token when readable', async () => {
    // Arrange
    resetState()
    const withRefresh = { mcpOAuth: { [SERVER_KEY]: { refreshToken: 'r' } } }
    const withoutRefresh = { mcpOAuth: { [SERVER_KEY]: { accessToken: 'a' } } }
    fakeStorage = createFakeStorage({ asyncResult: withRefresh }).storage

    // Act / Assert
    expect(await hasMcpRefreshToken(SERVER_NAME, SERVER_CONFIG)).toBe(true)
    resetState()
    fakeStorage = createFakeStorage({ asyncResult: withoutRefresh }).storage
    expect(await hasMcpRefreshToken(SERVER_NAME, SERVER_CONFIG)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) Provider integration — surface the error instead of "needs auth"
// ---------------------------------------------------------------------------

describe('2.1.307 B1 ClaudeAuthProvider.readCredentialStore', () => {
  function makeProvider(handleRedirection = false) {
    return new ClaudeAuthProvider(
      SERVER_NAME,
      SERVER_CONFIG,
      'http://localhost:33418/callback',
      handleRedirection,
    )
  }

  test('tokens() throws McpCredentialStoreUnavailableError with the verbatim log when the store is inaccessible', async () => {
    // Arrange
    resetState()
    const fake = createFakeStorage({
      asyncResult: null,
      strictResults: [TRANSIENT_READ_FAILURE],
    })
    fakeStorage = fake.storage
    const provider = makeProvider()
    // Simulate the server having challenged a request (401 seen on its URL).
    provider.noteServerAnswer(`${SERVER_CONFIG.url}/`, false)
    provider.noteServerAnswer(SERVER_CONFIG.url, true)

    // Act
    const error = await provider.tokens().catch((e: unknown) => e)

    // Assert
    expect(error).toBeInstanceOf(McpCredentialStoreUnavailableError)
    expect((error as { code: string }).code).toBe(
      'CREDENTIAL_STORE_UNAVAILABLE',
    )
    expect(loggedDebug).toContainEqual({
      server: SERVER_NAME,
      message:
        'Credential store could not be read (the login keychain may be locked); not reporting credentials as absent',
    })
  })

  test('noteServerAnswer only tracks answers from the server URL itself', () => {
    // Arrange
    resetState()
    fakeStorage = createFakeStorage({ asyncResult: null }).storage
    const provider = makeProvider()

    // Act — a challenge on an unrelated URL must not open the challenge state.
    provider.noteServerAnswer('https://idp.example.com/token', true)

    // Assert
    expect(provider.authChallengeOpen).toBe(false)

    // Act — the server's own URL does.
    provider.noteServerAnswer(SERVER_CONFIG.url, true)

    // Assert
    expect(provider.authChallengeOpen).toBe(true)

    // Act — a subsequent non-challenge answer closes it again.
    provider.noteServerAnswer(SERVER_CONFIG.url, false)

    // Assert
    expect(provider.authChallengeOpen).toBe(false)
  })
})
