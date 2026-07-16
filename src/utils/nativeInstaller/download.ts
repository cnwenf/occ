/**
 * Download functionality for native installer
 *
 * Handles downloading Claude binaries from various sources:
 * - Artifactory NPM packages
 * - GCS bucket
 */

import { feature } from 'src/utils/featureFlags.js'
import { parseEnvInt } from 'src/utils/envValidation.js'
import axios from 'axios'
import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { chmod, unlink } from 'fs/promises'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import type { ReleaseChannel } from '../config.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { sleep } from '../sleep.js'
import { jsonStringify, writeFileSync_DEPRECATED } from '../slowOperations.js'
import { getBinaryName, getPlatform } from './installer.js'

// 2.1.116: moved from storage.googleapis.com to downloads.claude.ai.
const GCS_BUCKET_URL = 'https://downloads.claude.ai/claude-code-releases'
export const ARTIFACTORY_REGISTRY_URL =
  'https://artifactory.infra.ant.dev/artifactory/api/npm/npm-all/'

export async function getLatestVersionFromArtifactory(
  tag: string = 'latest',
): Promise<string> {
  const startTime = Date.now()
  const { stdout, code, stderr } = await execFileNoThrowWithCwd(
    'npm',
    [
      'view',
      `${MACRO.NATIVE_PACKAGE_URL}@${tag}`,
      'version',
      '--prefer-online',
      '--registry',
      ARTIFACTORY_REGISTRY_URL,
    ],
    {
      timeout: 30000,
      preserveOutputOnError: true,
    },
  )

  const latencyMs = Date.now() - startTime

  if (code !== 0) {
    logEvent('tengu_version_check_failure', {
      latency_ms: latencyMs,
      source_npm: true,
      exit_code: code,
    })
    const error = new Error(`npm view failed with code ${code}: ${stderr}`)
    logError(error)
    throw error
  }

  logEvent('tengu_version_check_success', {
    latency_ms: latencyMs,
    source_npm: true,
  })
  logForDebugging(
    `npm view ${MACRO.NATIVE_PACKAGE_URL}@${tag} version: ${stdout}`,
  )
  const latestVersion = stdout.trim()
  return latestVersion
}

export async function getLatestVersionFromBinaryRepo(
  channel: ReleaseChannel = 'latest',
  baseUrl: string,
  authConfig?: { auth: { username: string; password: string } },
): Promise<string> {
  const startTime = Date.now()
  try {
    const response = await axios.get(`${baseUrl}/${channel}`, {
      timeout: 30000,
      responseType: 'text',
      ...authConfig,
    })
    const latencyMs = Date.now() - startTime
    logEvent('tengu_version_check_success', {
      latency_ms: latencyMs,
    })
    return response.data.trim()
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    logEvent('tengu_version_check_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
    })
    const fetchError = new Error(
      `Failed to fetch version from ${baseUrl}/${channel}: ${errorMessage}`,
    )
    logError(fetchError)
    throw fetchError
  }
}

export async function getLatestVersion(
  channelOrVersion: string,
): Promise<string> {
  // Direct version - match internal format too (e.g. 1.0.30-dev.shaf4937ce)
  if (/^v?\d+\.\d+\.\d+(-\S+)?$/.test(channelOrVersion)) {
    const normalized = channelOrVersion.startsWith('v')
      ? channelOrVersion.slice(1)
      : channelOrVersion
    // 99.99.x is reserved for CI smoke-test fixtures on real GCS.
    // feature() is false in all shipped builds — DCE collapses this to an
    // unconditional throw. Only `bun --feature=ALLOW_TEST_VERSIONS` (the
    // smoke test's source-level invocation) bypasses.
    if (/^99\.99\./.test(normalized) && !feature('ALLOW_TEST_VERSIONS')) {
      throw new Error(
        `Version ${normalized} is not available for installation. Use 'stable' or 'latest'.`,
      )
    }
    return normalized
  }

  // ReleaseChannel validation
  const channel = channelOrVersion as ReleaseChannel
  if (channel !== 'stable' && channel !== 'latest') {
    throw new Error(
      `Invalid channel: ${channelOrVersion}. Use 'stable' or 'latest'`,
    )
  }

  // Route to appropriate source
  if (process.env.USER_TYPE === 'ant') {
    // Use Artifactory for ant users
    const npmTag = channel === 'stable' ? 'stable' : 'latest'
    return getLatestVersionFromArtifactory(npmTag)
  }

  // Use GCS for external users
  return getLatestVersionFromBinaryRepo(channel, GCS_BUCKET_URL)
}

export async function downloadVersionFromArtifactory(
  version: string,
  stagingPath: string,
) {
  const fs = getFsImplementation()

  // If we get here, we own the lock and can delete a partial download
  await fs.rm(stagingPath, { recursive: true, force: true })

  // Get the platform-specific package name
  const platform = getPlatform()
  const platformPackageName = `${MACRO.NATIVE_PACKAGE_URL}-${platform}`

  // Fetch integrity hash for the platform-specific package
  logForDebugging(
    `Fetching integrity hash for ${platformPackageName}@${version}`,
  )
  const {
    stdout: integrityOutput,
    code,
    stderr,
  } = await execFileNoThrowWithCwd(
    'npm',
    [
      'view',
      `${platformPackageName}@${version}`,
      'dist.integrity',
      '--registry',
      ARTIFACTORY_REGISTRY_URL,
    ],
    {
      timeout: 30000,
      preserveOutputOnError: true,
    },
  )

  if (code !== 0) {
    throw new Error(`npm view integrity failed with code ${code}: ${stderr}`)
  }

  const integrity = integrityOutput.trim()
  if (!integrity) {
    throw new Error(
      `Failed to fetch integrity hash for ${platformPackageName}@${version}`,
    )
  }

  logForDebugging(`Got integrity hash for ${platform}: ${integrity}`)

  // Create isolated npm project in staging
  await fs.mkdir(stagingPath)

  const packageJson = {
    name: 'claude-native-installer',
    version: '0.0.1',
    dependencies: {
      [MACRO.NATIVE_PACKAGE_URL!]: version,
    },
  }

  // Create package-lock.json with integrity verification for platform-specific package
  const packageLock = {
    name: 'claude-native-installer',
    version: '0.0.1',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'claude-native-installer',
        version: '0.0.1',
        dependencies: {
          [MACRO.NATIVE_PACKAGE_URL!]: version,
        },
      },
      [`node_modules/${MACRO.NATIVE_PACKAGE_URL}`]: {
        version: version,
        optionalDependencies: {
          [platformPackageName]: version,
        },
      },
      [`node_modules/${platformPackageName}`]: {
        version: version,
        integrity: integrity,
      },
    },
  }

  writeFileSync_DEPRECATED(
    join(stagingPath, 'package.json'),
    jsonStringify(packageJson, null, 2),
    { encoding: 'utf8', flush: true },
  )

  writeFileSync_DEPRECATED(
    join(stagingPath, 'package-lock.json'),
    jsonStringify(packageLock, null, 2),
    { encoding: 'utf8', flush: true },
  )

  // Install with npm - it will verify integrity from package-lock.json
  // Use --prefer-online to force fresh metadata checks, helping with Artifactory replication delays
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['ci', '--prefer-online', '--registry', ARTIFACTORY_REGISTRY_URL],
    {
      timeout: 60000,
      preserveOutputOnError: true,
      cwd: stagingPath,
    },
  )

  if (result.code !== 0) {
    throw new Error(`npm ci failed with code ${result.code}: ${result.stderr}`)
  }

  logForDebugging(
    `Successfully downloaded and verified ${MACRO.NATIVE_PACKAGE_URL}@${version}`,
  )
}

// Stall timeout: abort if no bytes received for this duration
const DEFAULT_STALL_TIMEOUT_MS = 60000 // 60 seconds
const MAX_DOWNLOAD_RETRIES = 3

function getStallTimeoutMs(): number {
  return (
    parseEnvInt(process.env.CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING) ??
    DEFAULT_STALL_TIMEOUT_MS
  )
}

class StallTimeoutError extends Error {
  constructor() {
    super('Download stalled: no data received for 60 seconds')
    this.name = 'StallTimeoutError'
  }
}

/**
 * Network-level error codes that represent a transient connection drop —
 * i.e. the connection was established and data was flowing, then the peer
 * (or an intervening proxy) reset/timed out/aborted it mid-download.
 * 2.1.202: previously the installer/updater failed immediately with
 * "aborted"; these now retry.
 */
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', // socket reset by peer (proxy/network dropped mid-stream)
  'ETIMEDOUT', // connection timed out
  'ECONNABORTED', // connection aborted
  'ERR_NETWORK', // axios umbrella for network-level failures
])

/**
 * True iff `error` looks like a transient connection drop that is worth
 * retrying: a known transient network code, an "aborted" message, or a
 * fetch/axios network error where a request was sent but no response was
 * ever received (the connection died mid-flight). HTTP status errors
 * (which carry a `response`) and checksum mismatches (our own thrown
 * Error with neither request nor response) are intentionally NOT retried.
 */
function isTransientConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const anyErr = error as {
    code?: unknown
    message?: string
    response?: unknown
    request?: unknown
  }
  const code = typeof anyErr.code === 'string' ? anyErr.code : undefined
  const message = (anyErr.message ?? '').toLowerCase()

  if (code !== undefined && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true
  if (message.includes('aborted')) return true
  // Request sent but no response received and no clearly-permanent code
  // (ENOTFOUND = DNS miss, ECONNREFUSED = nothing listening) — treat the
  // mid-stream drop as transient so a flaky proxy/network gets a retry.
  if (!anyErr.response && anyErr.request && code !== 'ENOTFOUND' && code !== 'ECONNREFUSED') {
    return true
  }
  return false
}

// Base delay (ms) for download-retry backoff. Doubled per attempt
// (1s, 2s, 4s by default). Override via env for fast tests.
const DEFAULT_DOWNLOAD_RETRY_BASE_DELAY_MS = 1000

function getDownloadRetryBaseDelayMs(): number {
  return (
    parseEnvInt(process.env.CLAUDE_CODE_DOWNLOAD_RETRY_DELAY_MS_FOR_TESTING) ??
    DEFAULT_DOWNLOAD_RETRY_BASE_DELAY_MS
  )
}

/**
 * Common logic for downloading and verifying a binary.
 * Includes stall detection (aborts if no bytes for 60s) and retry logic.
 *
 * `attemptDownload` is an injectable seam (defaults to the real
 * fetch+checksum+write) so the retry loop can be unit-tested without mocking
 * the network. Production callers never pass it.
 */
async function downloadAndVerifyBinary(
  binaryUrl: string,
  expectedChecksum: string,
  binaryPath: string,
  requestConfig: Record<string, unknown> = {},
  attemptDownload?: () => Promise<void>,
) {
  // Default per-attempt body: stall-guarded fetch, checksum, write to disk.
  // The stall timer is cleared in `finally` so a thrown error never leaves a
  // dangling abort timer.
  const defaultAttemptDownload = async () => {
    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    const resetStallTimer = () => {
      clearStallTimer()
      stallTimer = setTimeout(c => c.abort(), getStallTimeoutMs(), controller)
    }

    try {
      // Start the stall timer before the request
      resetStallTimer()

      // 2.1.205 #17: stream the binary to disk chunk-by-chunk (−~400MB peak
      // memory) instead of buffering the whole response in an ArrayBuffer.
      // The sha256 is updated incrementally as each chunk lands, and the
      // stall timer is reset per chunk so a stalled peer still aborts.
      const response = await axios.get(binaryUrl, {
        timeout: 5 * 60000, // 5 minute total timeout (time to first byte)
        responseType: 'stream',
        signal: controller.signal,
        ...requestConfig,
      })

      const hash = createHash('sha256')
      const hashAndStall = new PassThrough()
      hashAndStall.on('data', chunk => {
        hash.update(chunk)
        resetStallTimer()
      })

      try {
        await pipeline(
          response.data as NodeJS.ReadableStream,
          hashAndStall,
          createWriteStream(binaryPath),
        )
      } catch (streamError) {
        // A partial file may remain on disk; clean it up so a retry or a
        // later attempt doesn't mistake a truncated binary for a valid one.
        try {
          await unlink(binaryPath)
        } catch {
          // ignore — the file may not exist or the dir is read-only
        }
        throw streamError
      }

      const actualChecksum = hash.digest('hex')
      if (actualChecksum !== expectedChecksum) {
        // The full (but wrong) binary landed on disk; remove it so a later
        // attempt doesn't mistake a truncated/mismatched file for valid.
        try {
          await unlink(binaryPath)
        } catch {
          // ignore — the file may not exist or the dir is read-only
        }
        throw new Error(
          `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
        )
      }

      await chmod(binaryPath, 0o755)
    } finally {
      clearStallTimer()
    }
  }

  const doAttempt = attemptDownload ?? defaultAttemptDownload
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    try {
      await doAttempt()
      // Success - return early
      return
    } catch (error) {
      // Check if this was a stall timeout (axios wraps abort signals in CanceledError)
      const isStallTimeout = axios.isCancel(error)
      // 2.1.202: also retry transient connection drops — a proxy/network
      // resetting/aborting the stream mid-download (ECONNRESET/ETIMEDOUT/
      // ECONNABORTED). Previously these failed immediately with "aborted".
      const isTransient = !isStallTimeout && isTransientConnectionError(error)

      if (isStallTimeout) {
        lastError = new StallTimeoutError()
      } else {
        lastError = toError(error)
      }

      // Retry on stall timeouts AND transient connection drops, sharing one
      // retry budget so a flaky link can't retry forever.
      if ((isStallTimeout || isTransient) && attempt < MAX_DOWNLOAD_RETRIES) {
        const delay = getDownloadRetryBaseDelayMs() * 2 ** (attempt - 1)
        logForDebugging(
          `Download ${isStallTimeout ? 'stalled' : 'failed transiently'} on attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} (${lastError.message}), retrying in ${delay}ms...`,
        )
        // Exponential backoff to let the proxy/network recover
        await sleep(delay)
        continue
      }

      // Don't retry non-transient errors (HTTP status errors, checksum mismatches, etc.)
      throw lastError
    }
  }

  // Should not reach here, but just in case
  throw lastError ?? new Error('Download failed after all retries')
}

export async function downloadVersionFromBinaryRepo(
  version: string,
  stagingPath: string,
  baseUrl: string,
  authConfig?: {
    auth?: { username: string; password: string }
    headers?: Record<string, string>
  },
) {
  const fs = getFsImplementation()

  // If we get here, we own the lock and can delete a partial download
  await fs.rm(stagingPath, { recursive: true, force: true })

  // Get platform
  const platform = getPlatform()
  const startTime = Date.now()

  // Log download attempt start
  logEvent('tengu_binary_download_attempt', {})

  // Fetch manifest to get checksum
  let manifest
  try {
    const manifestResponse = await axios.get(
      `${baseUrl}/${version}/manifest.json`,
      {
        timeout: 10000,
        responseType: 'json',
        ...authConfig,
      },
    )
    manifest = manifestResponse.data
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    logEvent('tengu_binary_manifest_fetch_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
    })
    logError(
      new Error(
        `Failed to fetch manifest from ${baseUrl}/${version}/manifest.json: ${errorMessage}`,
      ),
    )
    throw error
  }

  const platformInfo = manifest.platforms[platform]

  if (!platformInfo) {
    logEvent('tengu_binary_platform_not_found', {})
    throw new Error(
      `Platform ${platform} not found in manifest for version ${version}`,
    )
  }

  const expectedChecksum = platformInfo.checksum

  // Both GCS and generic bucket use identical layout: ${baseUrl}/${version}/${platform}/${binaryName}
  const binaryName = getBinaryName(platform)
  const binaryUrl = `${baseUrl}/${version}/${platform}/${binaryName}`

  // Write to staging
  await fs.mkdir(stagingPath)
  const binaryPath = join(stagingPath, binaryName)

  try {
    await downloadAndVerifyBinary(
      binaryUrl,
      expectedChecksum,
      binaryPath,
      authConfig || {},
    )
    const latencyMs = Date.now() - startTime
    logEvent('tengu_binary_download_success', {
      latency_ms: latencyMs,
    })
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    logEvent('tengu_binary_download_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
      is_checksum_mismatch: errorMessage.includes('Checksum mismatch'),
    })
    logError(
      new Error(`Failed to download binary from ${binaryUrl}: ${errorMessage}`),
    )
    throw error
  }
}

export async function downloadVersion(
  version: string,
  stagingPath: string,
): Promise<'npm' | 'binary'> {
  // Test-fixture versions route to the private sentinel bucket. DCE'd in all
  // shipped builds — the string 'claude-code-ci-sentinel' and the gcloud call
  // never exist in compiled binaries. Same gcloud-token pattern as
  // remoteSkillLoader.ts:175-195.
  if (feature('ALLOW_TEST_VERSIONS') && /^99\.99\./.test(version)) {
    const { stdout } = await execFileNoThrowWithCwd('gcloud', [
      'auth',
      'print-access-token',
    ])
    await downloadVersionFromBinaryRepo(
      version,
      stagingPath,
      'https://storage.googleapis.com/claude-code-ci-sentinel',
      { headers: { Authorization: `Bearer ${stdout.trim()}` } },
    )
    return 'binary'
  }

  if (process.env.USER_TYPE === 'ant') {
    // Use Artifactory for ant users
    await downloadVersionFromArtifactory(version, stagingPath)
    return 'npm'
  }

  // Use GCS for external users
  await downloadVersionFromBinaryRepo(version, stagingPath, GCS_BUCKET_URL)
  return 'binary'
}

// Exported for testing
export { StallTimeoutError, MAX_DOWNLOAD_RETRIES }
export const STALL_TIMEOUT_MS = DEFAULT_STALL_TIMEOUT_MS
export const DOWNLOAD_RETRY_BASE_DELAY_MS = DEFAULT_DOWNLOAD_RETRY_BASE_DELAY_MS
export { isTransientConnectionError }
export const _downloadAndVerifyBinaryForTesting = downloadAndVerifyBinary
