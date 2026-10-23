/**
 * claude-code 2.1.307 PORT B1 — MCP credential-store-unavailable errors and
 * the per-server strict-read probe.
 *
 * Port of the official 2.1.307 credential module (linux ELF `JDe` @241629512,
 * `Tre`/`Are` @242287761; darwin ELF `rDe`, `Ore`/`Mre` @220653398 — both
 * byte-verified, never executed). When the macOS login keychain is LOCKED, a
 * plain `readAsync()` reports "no credentials" — indistinguishable from a
 * server the user simply never authenticated. The official binary fixes this
 * with:
 *
 *  1. A dedicated error class (`McpCredentialStoreUnavailableError`,
 *     code `CREDENTIAL_STORE_UNAVAILABLE`) in two modes: `unreadable` (the
 *     request never ran because credentials could not be read) and
 *     `read-too-late` (a request went out WITHOUT the stored credentials,
 *     the server challenged it, and the credentials only then turned up).
 *  2. A strict-read probe that distinguishes TRANSIENT inaccessibility (the
 *     `TRANSIENT_READ_FAILURE` sentinel) from a genuinely empty store, with
 *     1s negative / 30s answered verdict caches.
 *  3. Gating so the probe only fires where it can matter: keychain-backed
 *     storage, headless sessions (official `_e()` =
 *     `!host.launchOptions.isInteractive()`), and servers that were 401-
 *     challenged or have OAuth discovery state but no tokens.
 *
 * Documented OCC adaptations (observable contract preserved):
 *  - The official probe uses async `readAsyncStrict` with in-flight promise
 *    dedup (`w.inFlight ??= ...`); OCC's secure-storage API exposes a SYNC
 *    `readStrict` (macOsKeychainStorage.ts:114), so the probes are sync and
 *    need no in-flight dedup.
 *  - The official keychain-only probe passes `{inaccessibleAs:"failure"}`;
 *    OCC's only strict mode is `'failureIfTransient'`, which returns the
 *    sentinel exactly when `isMacOsKeychainLocked()` — equivalent to the
 *    official 'failure' mode for the locked case (OCC lacks the official's
 *    `keychainHoldsItem` refinement for other exit codes).
 *  - The official answered-cache check includes
 *    `w.cacheGeneration===vCe().generation` (a credential-generation counter
 *    OCC has no equivalent of); omitted — the time-based 30s window is kept.
 *  - The official backend gate is the platform constant `_zt()==="keychain"`
 *    (darwin build returns "keychain", linux returns "file"). OCC keys off
 *    the storage NAME instead: 'keychain' or the darwin fallback composite
 *    'keychain-with-plaintext-fallback' (fallbackStorage.ts:13).
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { TRANSIENT_READ_FAILURE } from '../../utils/secureStorage/transientRead.js'
import type { SecureStorageData } from '../../utils/secureStorage/types.js'
import { getServerKey, hasMcpDiscoveryButNoToken } from './auth.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from './types.js'

/** Official `mT`/`hT` = 1000 — negative ("failed") verdict cache window. */
export const CREDENTIAL_STORE_NEGATIVE_CACHE_MS = 1000

/** Official `_T`/`yT` = 30000 — answered/"empty" verdict cache window. */
export const CREDENTIAL_STORE_ANSWERED_CACHE_MS = 30000

/** Official `JDe`/`rDe` — verbatim messages, telemetry strings, code, name. */
export class McpCredentialStoreUnavailableError extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  code: string

  constructor(
    serverName: string,
    mode: 'unreadable' | 'read-too-late' = 'unreadable',
  ) {
    if (mode === 'unreadable') {
      super(
        `Couldn't read the stored credentials for MCP server "${serverName}", so the request didn't run. ${
          getPlatform() === 'macos'
            ? "If your Mac's keychain is locked, unlock it, then try again."
            : 'Try again.'
        }`,
        'MCP credential store could not be read',
      )
    } else {
      super(
        `A request to MCP server "${serverName}" was sent without your stored credentials, so the server rejected it. The credentials are available now. Try again.`,
        'MCP credentials were read only after a request went out without them',
      )
    }
    this.code = 'CREDENTIAL_STORE_UNAVAILABLE'
    this.name = 'McpCredentialStoreUnavailableError'
  }
}

/** True for errors thrown by this module (also unwraps `cause`). */
export function isCredentialStoreUnavailableError(error: unknown): boolean {
  if (error instanceof McpCredentialStoreUnavailableError) return true
  const cause = (error as { cause?: unknown } | undefined)?.cause
  return cause instanceof McpCredentialStoreUnavailableError
}

// ---------------------------------------------------------------------------
// Probe state (official `hT` record; single module-level instance — the
// official keys it by host via `hT.of(B().host)`, OCC has one host per
// process)
// ---------------------------------------------------------------------------

interface KeychainOnlyProbeState {
  verdict: 'answered' | 'failed' | undefined
  settledAt: number
}

interface BlobProbeState {
  verdict: 'failed' | 'empty' | undefined
  settledAt: number
  seenPopulated: boolean
  /** Official `generation` — bumped whenever the store is seen populated. */
  generation: number
  keychainOnly: KeychainOnlyProbeState
}

function createProbeState(): BlobProbeState {
  return {
    verdict: undefined,
    settledAt: 0,
    seenPopulated: false,
    generation: 0,
    keychainOnly: { verdict: undefined, settledAt: 0 },
  }
}

let probeState: BlobProbeState = createProbeState()

/** Test hook: reset the module-level probe verdict caches. */
export function _resetCredentialStoreProbeStateForTesting(): void {
  probeState = createProbeState()
}

/** Official `yT`/`ST`: sentinel is never "emptyish". */
function isEmptyish(result: unknown): boolean {
  return (
    result !== TRANSIENT_READ_FAILURE &&
    (!result || Object.keys(result).length === 0)
  )
}

/** Official `bT`/`vT`: record that the store was seen populated. */
function recordPopulated(state: BlobProbeState): void {
  state.seenPopulated = true
  state.generation++
  if (state.verdict === 'empty') state.verdict = undefined
}

/**
 * Official `_zt()==="keychain"` mapped onto OCC storage names: the darwin
 * backend is the keychain primary wrapped in the plaintext fallback
 * ('keychain-with-plaintext-fallback'); bare 'keychain' covers the unwrapped
 * primary (and test fakes). Everything else (plaintext, windows-credman,
 * linux 'file') skips the per-server probe.
 */
function isKeychainBackedStorageName(name: string | undefined): boolean {
  return name === 'keychain' || name === 'keychain-with-plaintext-fallback'
}

type StrictReadFn = ((options?: {
  inaccessibleAs?: 'failureIfTransient'
}) => SecureStorageData) & { __strict?: true }

/**
 * Sync adaptation of the official `NW`/`vW` blob-probe wrapper: runs the
 * no-arg strict read ('absent' semantics) and maintains the failed/empty
 * verdict + settledAt bookkeeping, including the generation-staleness
 * bail-out.
 */
function probeBlobStrict(
  state: BlobProbeState,
  readStrict: StrictReadFn,
): SecureStorageData {
  const startGeneration = state.generation
  const result = readStrict()
  if (result !== TRANSIENT_READ_FAILURE && !isEmptyish(result)) {
    state.verdict = undefined
    recordPopulated(state)
  } else if (startGeneration !== state.generation) {
    return result
  } else {
    state.verdict = result === TRANSIENT_READ_FAILURE ? 'failed' : 'empty'
  }
  state.settledAt = Date.now()
  return result
}

/** Per-server target for the probe (official `Are(e)` with `e!==void 0`). */
export interface CredentialStoreServerTarget {
  serverName: string
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig
  /** True once this server answered a request with a 401 challenge. */
  challenged: boolean
}

/**
 * Official `Are`/`Mre` — strict credential-store read.
 *
 * Without a target: plain async read; when that comes back emptyish and the
 * backend supports strict reads, probe once (1s negative / 30s empty verdict
 * caches) and report the sentinel ONLY when the store was previously seen
 * populated — otherwise an inaccessible store degrades to the plain read.
 *
 * With a target: run the blob-level read first, then — gated on no cached
 * tokens, challenged-or-discovery state, headless session, and keychain
 * backend — run a keychain-only strict probe. If the probe turns up
 * credentials for a server whose request was just challenged, THROW
 * `read-too-late` (the request went out without them; failing it lets the
 * next one send them).
 */
export async function readCredentialStoreStrict(
  server?: CredentialStoreServerTarget,
): Promise<SecureStorageData> {
  const storage = getSecureStorage()
  if (server !== undefined) {
    const keychainOnly = probeState.keychainOnly
    // Official answered-cache check minus the OCC-absent cacheGeneration
    // comparison (see module header).
    const answeredFresh =
      keychainOnly.verdict === 'answered' &&
      Date.now() - keychainOnly.settledAt < CREDENTIAL_STORE_ANSWERED_CACHE_MS
    const blob = await readCredentialStoreStrict()
    const readStrict = storage.readStrict as StrictReadFn | undefined
    if (blob === TRANSIENT_READ_FAILURE || !readStrict || answeredFresh) {
      return blob
    }
    const { serverName, serverConfig } = server
    const serverKey = getServerKey(serverName, serverConfig)
    const entry = blob?.mcpOAuth?.[serverKey]
    if (
      entry?.accessToken ||
      entry?.refreshToken ||
      (!server.challenged &&
        !hasMcpDiscoveryButNoToken(
          serverName,
          serverConfig,
          blob?.mcpOAuth,
        )) ||
      !getIsNonInteractiveSession() ||
      !isKeychainBackedStorageName(storage.name)
    ) {
      return blob
    }
    if (
      keychainOnly.verdict === 'failed' &&
      Date.now() - keychainOnly.settledAt < CREDENTIAL_STORE_NEGATIVE_CACHE_MS
    ) {
      return TRANSIENT_READ_FAILURE
    }
    const probed = readStrict({ inaccessibleAs: 'failureIfTransient' })
    keychainOnly.verdict = probed === TRANSIENT_READ_FAILURE ? 'failed' : 'answered'
    keychainOnly.settledAt = Date.now()
    if (probed === TRANSIENT_READ_FAILURE || !server.challenged) {
      return probed ?? blob
    }
    const probedEntry = probed?.mcpOAuth?.[serverKey]
    if (!probedEntry?.accessToken && !probedEntry?.refreshToken) {
      return probed ?? blob
    }
    logMCPDebug(
      serverName,
      'Stored credentials turned up only after the server challenged a request sent without them; failing that request so the next one sends them',
    )
    throw new McpCredentialStoreUnavailableError(serverName, 'read-too-late')
  }
  const plain = await storage.readAsync()
  const state = probeState
  const readStrict = storage.readStrict as StrictReadFn | undefined
  if (!isEmptyish(plain)) {
    recordPopulated(state)
    return plain
  }
  if (!readStrict) return plain
  const age = Date.now() - state.settledAt
  if (state.verdict === 'failed' && age < CREDENTIAL_STORE_NEGATIVE_CACHE_MS) {
    return state.seenPopulated ? TRANSIENT_READ_FAILURE : plain
  }
  if (state.verdict === 'empty' && age < CREDENTIAL_STORE_ANSWERED_CACHE_MS) {
    return plain
  }
  const probed = probeBlobStrict(state, readStrict)
  return probed === TRANSIENT_READ_FAILURE && !state.seenPopulated
    ? plain
    : probed
}

/**
 * Official `Tre`/`Ore` — read the mcpOAuth section. Without a target, reads
 * the plain async blob; with a target, routes through the strict probe and
 * maps the INACCESSIBLE sentinel to `undefined` (never conflated with an
 * absent store by callers that check `=== undefined`… the sentinel itself is
 * only surfaced by `readCredentialStoreStrict`).
 */
export async function readMcpOAuthCredentials(
  server?: CredentialStoreServerTarget,
): Promise<SecureStorageData> {
  if (server === undefined) {
    return (await getSecureStorage().readAsync())?.mcpOAuth
  }
  const result = await readCredentialStoreStrict(server)
  return result === TRANSIENT_READ_FAILURE ? undefined : result?.mcpOAuth
}

/**
 * Official `U2e` — does this server have a stored refresh token? An
 * INACCESSIBLE store answers `true`: never report credentials as absent when
 * they might exist behind a locked keychain.
 */
export async function hasMcpRefreshToken(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): Promise<boolean> {
  const blob = await readCredentialStoreStrict()
  if (blob === TRANSIENT_READ_FAILURE) return true
  const serverKey = getServerKey(serverName, serverConfig)
  return !!blob?.mcpOAuth?.[serverKey]?.refreshToken
}
