import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from './debug.js'
import { hasNodeOption } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * Load CA certificates for TLS connections.
 *
 * Since setting `ca` on an HTTPS agent replaces the default certificate store,
 * we must always include base CAs (system or bundled Mozilla) when returning.
 *
 * Returns undefined when no custom CA configuration is needed, allowing the
 * runtime's default certificate handling to apply.
 *
 * claude-code 2.1.101: the OS CA certificate store is trusted by default
 * (default stores = ["bundled", "system"]) so enterprise TLS proxies work
 * without extra setup. Set `CLAUDE_CODE_CERT_STORE=bundled` to use only the
 * bundled Mozilla CAs, or `=system` for OS-only, or `bundled,system` (default).
 *
 * Memoized for performance. Call clearCACertsCache() to invalidate after
 * environment variable changes (e.g., after trust dialog applies settings.json).
 *
 * Reads ONLY `process.env.NODE_EXTRA_CA_CERTS` + `CLAUDE_CODE_CERT_STORE`.
 * `caCertsConfig.ts` populates NODE_EXTRA_CA_CERTS from settings.json at init;
 * this module stays config-free so `proxy.ts`/`mtls.ts` don't pull the registry.
 */

/** Default CA stores (claude-code 2.1.101: trust OS store by default). */
export const DEFAULT_CERT_STORES = ['bundled', 'system'] as const

/**
 * Resolve the CA store list (mirrors claude-code 2.1.101's fd5()):
 * - CLAUDE_CODE_CERT_STORE set: parse comma-separated "bundled"/"system"
 *   (unknown values logged + ignored; falls back to default if none valid).
 * - Otherwise: --use-system-ca/--use-openssl-ca → ["system"]; else default.
 */
export function resolveCertStores(): string[] {
  const raw = process.env.CLAUDE_CODE_CERT_STORE
  if (raw) {
    const stores: string[] = []
    for (const part of raw.split(',')) {
      const s = part.trim().toLowerCase()
      if (s === 'bundled' || s === 'system') {
        if (!stores.includes(s)) {
          stores.push(s)
        }
      } else if (s) {
        logForDebugging(
          `CA certs: unrecognized CLAUDE_CODE_CERT_STORE source '${s}', ignoring`,
          { level: 'warn' },
        )
      }
    }
    return stores.length > 0 ? stores : [...DEFAULT_CERT_STORES]
  }
  if (hasNodeOption('--use-system-ca') || hasNodeOption('--use-openssl-ca')) {
    return ['system']
  }
  return [...DEFAULT_CERT_STORES]
}

export const getCACertificates = memoize((): string[] | undefined => {
  const stores = resolveCertStores()
  const useBundled = stores.includes('bundled')
  const useSystem = stores.includes('system')
  const extraCertsPath = process.env.NODE_EXTRA_CA_CERTS

  logForDebugging(
    `CA certs: stores=${stores.join(',')}, extraCertsPath=${extraCertsPath}`,
  )

  // Under Node.js (not Bun) with no extra certs and no explicit
  // CLAUDE_CODE_CERT_STORE, defer to the runtime's native handling.
  if (
    typeof Bun === 'undefined' &&
    !extraCertsPath &&
    !process.env.CLAUDE_CODE_CERT_STORE
  ) {
    return undefined
  }

  // Deferred load: Bun's node:tls module eagerly materializes ~150 Mozilla
  // root certificates (~750KB heap) on import. Most users hit the early return
  // above, so we only pay this cost when custom CA handling is actually needed.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tls = require('tls') as typeof import('tls')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const getCACerts = (
    tls as typeof tls & { getCACertificates?: (type: string) => string[] }
  ).getCACertificates

  if (!useBundled && useSystem && !getCACerts) {
    logForDebugging(
      'CA certs: stores=system but system CA API unavailable, deferring to runtime',
    )
    return undefined
  }

  const certs: string[] = []

  if (useBundled) {
    certs.push(...tls.rootCertificates)
    logForDebugging(
      `CA certs: Loaded ${tls.rootCertificates.length} bundled root certificates`,
    )
  }

  if (useSystem) {
    try {
      const systemCAs = getCACerts?.('system')
      if (systemCAs && systemCAs.length > 0) {
        certs.push(...systemCAs)
        logForDebugging(
          `CA certs: Loaded ${systemCAs.length} system CA certificates`,
        )
      } else {
        logForDebugging(
          `CA certs: system store ${getCACerts ? 'returned empty' : 'unavailable'}`,
        )
        // Fall back to bundled root certs if bundled wasn't already included.
        if (!useBundled) {
          certs.push(...tls.rootCertificates)
        }
      }
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to load system CA certificates: ${error}`,
        { level: 'error' },
      )
      if (!useBundled) {
        certs.push(...tls.rootCertificates)
      }
    }
  }

  // Append extra certs from file
  if (extraCertsPath) {
    try {
      const extraCert = getFsImplementation().readFileSync(extraCertsPath, {
        encoding: 'utf8',
      })
      certs.push(extraCert)
      logForDebugging(
        `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (${extraCertsPath})`,
      )
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to read NODE_EXTRA_CA_CERTS file (${extraCertsPath}): ${error}`,
        { level: 'error' },
      )
    }
  }

  return certs.length > 0 ? certs : undefined
})

/**
 * Clear the CA certificates cache.
 * Call this when environment variables that affect CA certs may have changed
 * (e.g., NODE_EXTRA_CA_CERTS, NODE_OPTIONS, CLAUDE_CODE_CERT_STORE).
 */
export function clearCACertsCache(): void {
  getCACertificates.cache.clear?.()
  logForDebugging('Cleared CA certificates cache')
}
