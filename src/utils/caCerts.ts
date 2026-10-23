import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from './debug.js'
import { hasNodeOption } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import {
  collectBlockedBundledRoots,
  dropBlockedCertificates,
  resolveTrustedCertificates,
  type CaCertEntry,
} from './caDenyList.js'

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
 * claude-code 2.1.303: system-store certs are filtered for expiry, and every
 * trust source (bundled/system/NODE_EXTRA_CA_CERTS) is passed through the
 * CLI's root-certificate deny list (see caDenyList.ts). When the system CA API
 * is unavailable the loader now falls back to bundled roots instead of
 * deferring to the runtime.
 *
 * claude-code 2.1.309 (F-20): the loader tracks WHY the system store could not
 * supply trust (`CA_TRUST_FAILURE_REASONS`) and throws the official
 * "No certificate authority to trust: …" diagnostic when the resolved store
 * list is empty (`noCertificateAuthorityMessage`).
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
 * claude-code 2.1.309 (F-20): the official loader `Kr` (BIN309 @241,583,000)
 * tracks WHY the system store could not supply trust in a reason variable `h`,
 * defaulting to `expiredOrDenied` and overwriting it in the empty-store and
 * read-failure branches. All four strings are byte-verbatim from BIN309.
 *
 * Structural deviation: the official keeps `h` as a function-local `let`; OCC
 * exports the reasons as named constants so the message builder below (and the
 * tests) pin them byte-for-byte.
 */
export const CA_TRUST_FAILURE_REASONS = {
  /** Default reason (`h` initializer): the store resolved to nothing usable. */
  expiredOrDenied:
    'every certificate in the system CA store is expired or on the deny list',
  /** System CA API exists but returned an empty list (`l` truthy branch). */
  emptySystemStore:
    "the system CA store is empty: check that this process can read its CA files (SSL_CERT_FILE, SSL_CERT_DIR, or the system's default paths)",
  /** Runtime exposes no system CA API at all (`l` falsy branch). */
  noSystemStore: 'the runtime has no system CA store',
  /** Reading the system store threw (catch branch). */
  readFailed: 'reading the system CA store failed',
} as const

/**
 * claude-code 2.1.309 (F-20): verbatim "No certificate authority to trust"
 * diagnostic thrown by official `Kr` when the resolved store list is empty.
 * The official throws `new R(long, short)` (two-message error class, short =
 * "No certificate authority to trust"); OCC has no such class on this path, so
 * it throws a plain Error carrying the long (user-facing) message.
 */
export function noCertificateAuthorityMessage(reason: string): string {
  return `No certificate authority to trust: CLAUDE_CODE_CERT_STORE=system (or NODE_OPTIONS --use-system-ca or --use-openssl-ca) leaves out the runtime's bundled roots, and ${reason}. NODE_EXTRA_CA_CERTS only adds to the store; it does not count on its own.`
}

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

/**
 * claude-code 2.1.303 (`Mn`) — drop expired certificates from the system
 * store. Unparseable certs and certs with an unparseable `validTo` are kept
 * (official behavior: fail open per-cert, the deny list is the fail-closed
 * layer).
 */
export function filterExpiredCertificates(certificates: string[]): string[] {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { X509Certificate } = require('node:crypto') as typeof import('node:crypto')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const now = Date.now()
  let droppedCount = 0
  const kept = certificates.filter((pem) => {
    try {
      const cert = new X509Certificate(pem)
      const validTo = new Date(cert.validTo).getTime()
      if (Number.isNaN(validTo) || validTo > now) {
        return true
      }
      droppedCount++
      return false
    } catch {
      return true
    }
  })
  if (droppedCount > 0) {
    logForDebugging(
      `CA certs: Dropped ${droppedCount} expired certificate(s) from system store`,
    )
  }
  return kept
}

/**
 * claude-code 2.1.303 (`D`, dd-verified @233,826,026: `D(e)=[...new Set(e)]`)
 * — dedupe the final certificate list. The trust sources overlap in practice:
 * system stores commonly re-ship Mozilla roots that are also in the bundled
 * store, and NODE_EXTRA_CA_CERTS may re-add a root the store already holds.
 * The official loader returns `D([...store, ...extra])`; order is preserved,
 * exact-duplicate PEM strings collapse to the first occurrence.
 */
export function dedupeCerts(certs: readonly string[]): string[] {
  return [...new Set(certs)]
}

/**
 * Dedup set for the NODE_EXTRA_CA_CERTS console warnings (official
 * `warnedExtraCerts` field on the CA-store class) — module-scoped so warnings
 * dedup across cache invalidations within the process, like the official.
 */
const warnedExtraCerts = new Set<string>()

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
  // (OCC dev fast-path; the shipped build is Bun where the filter always runs.)
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

  // claude-code 2.1.303: no longer returns here — falls through with an empty
  // entry list so resolveTrustedCertificates() falls back to the (deny-list
  // filtered) bundled roots.
  if (!useBundled && useSystem && !getCACerts) {
    logForDebugging(
      'CA certs: stores=system but system CA API unavailable, using bundled roots',
    )
  }

  const entries: CaCertEntry[] = []
  const pushEntries = (source: string, pems: readonly string[]): void => {
    for (const pem of pems) {
      entries.push({ pem, source })
    }
  }
  let extraCerts: string[] = []
  let appendedExtra = false

  // claude-code 2.1.309 (official `h` in `Kr`, BIN309 @241,583,9xx): why the
  // system store could not supply trust — consumed by the empty-resolve guard
  // below.
  let systemStoreReason: string = CA_TRUST_FAILURE_REASONS.expiredOrDenied

  if (useBundled) {
    pushEntries('bundled', tls.rootCertificates)
    logForDebugging(
      `CA certs: Loaded ${tls.rootCertificates.length} bundled root certificates`,
    )
  }

  if (useSystem) {
    try {
      const systemCAs = getCACerts?.('system')
      if (systemCAs && systemCAs.length > 0) {
        const validSystemCAs = filterExpiredCertificates(systemCAs)
        pushEntries('system', validSystemCAs)
        logForDebugging(
          `CA certs: Loaded ${validSystemCAs.length} system CA certificates`,
        )
      } else {
        logForDebugging(
          `CA certs: system store ${getCACerts ? 'returned empty' : 'unavailable'}`,
        )
        systemStoreReason = getCACerts
          ? CA_TRUST_FAILURE_REASONS.emptySystemStore
          : CA_TRUST_FAILURE_REASONS.noSystemStore
        // Fall back to bundled root certs if bundled wasn't already included.
        if (!useBundled) {
          pushEntries('bundled', tls.rootCertificates)
        }
      }
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to load system CA certificates: ${error}`,
        { level: 'error' },
      )
      systemStoreReason = CA_TRUST_FAILURE_REASONS.readFailed
      if (!useBundled) {
        pushEntries('bundled', tls.rootCertificates)
      }
    }
  }

  // claude-code 2.1.303: deny-list filtering of the store entries, with the
  // bundled-only retry + throw when nothing is left to trust.
  const blockedRoots = collectBlockedBundledRoots(tls.rootCertificates)
  const storeCerts = resolveTrustedCertificates(
    entries,
    tls.rootCertificates,
    blockedRoots,
    warnedExtraCerts,
  )

  // claude-code 2.1.309 (official `if(P.length===0)throw` in `Kr`): when the
  // resolved store list is empty, surface the reason it could not supply
  // trust. In the shipped official CLI this guard is defensive — the empty
  // resolve is gated by `refusesBundledFallback` (class default false
  // @241,573,710; never set true in the binary — host-provided config only),
  // and official `qr` (@241,581,524 ≡ resolveTrustedCertificates) throws the
  // older 303 "No root certificates are left to trust" message before it can
  // return []. OCC has no host/refusesBundledFallback surface, so the guard
  // mirrors the official structure without inventing a new trigger.
  if (storeCerts.length === 0) {
    throw new Error(noCertificateAuthorityMessage(systemStoreReason))
  }

  // Append extra certs from file (deny-list filtered per 2.1.303)
  if (extraCertsPath) {
    try {
      const extraContent = getFsImplementation().readFileSync(extraCertsPath, {
        encoding: 'utf8',
      })
      extraCerts = dropBlockedCertificates(
        [{ pem: extraContent, source: 'NODE_EXTRA_CA_CERTS' }],
        blockedRoots,
        warnedExtraCerts,
      )
      appendedExtra = extraCerts.length > 0
      logForDebugging(
        appendedExtra
          ? `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (${extraCertsPath})`
          : `CA certs: Nothing from NODE_EXTRA_CA_CERTS (${extraCertsPath}) is left to append`,
      )
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to read NODE_EXTRA_CA_CERTS file (${extraCertsPath}): ${error}`,
        { level: 'error' },
      )
    }
  }

  // claude-code 2.1.303 (`Xn` tail): `y = D([...store, ...extra])` — the
  // final list is deduped (trust sources overlap in practice).
  return dedupeCerts([...storeCerts, ...extraCerts])
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
