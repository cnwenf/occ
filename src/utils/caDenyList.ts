/**
 * Root-certificate deny list (claude-code 2.1.303).
 *
 * Official 2.1.303 added a CLI-side deny list of root certificates that are
 * removed from every trust source (bundled Mozilla store, system store, and
 * NODE_EXTRA_CA_CERTS) before TLS connections are made. The four blocked roots
 * are eMudhra/emSign CAs. All logic here is a faithful port of the official
 * minified implementation recovered from the 2.1.303 linux-x64 binary
 * (offsets ~235,849,000-235,857,000; see docs/gap-research-303/):
 *
 *   official `tt` → BLOCKED_ROOT_CERTIFICATES
 *   official `Ce` → BLOCKED_CERT_HASHES   (SHA-256 of certificate DER)
 *   official `jn` → BLOCKED_KEY_HASHES    (SHA-256 of SPKI public key)
 *   official `Qe` → findPemBlocks
 *   official `me` → MAX_STRIP_PASSES
 *   official `Je` → extraCertsSuffix
 *   official `Ze` → warnIgnoredExtraCerts
 *   official `nt` → collectBlockedBundledRoots
 *   official `Ee` → dropBlockedCertificates
 *   official `qn` → resolveTrustedCertificates
 *
 * User-facing warning texts and the throw message are verbatim from the
 * binary. Do not paraphrase them (byte-alignment discipline).
 */
import type { KeyObject, X509Certificate as X509CertificateType } from 'node:crypto'

import { logForDebugging } from './debug.js'

/** One deny-list entry: SHA-256 of the cert DER + SHA-256 of its SPKI key. */
interface BlockedRootCertificate {
  readonly certificate: string
  readonly key: string
}

/** A blocked root found in the bundled store, with its truncated-DER base64. */
export interface BlockedBundledRoot {
  readonly base64: string
  readonly hash: string
}

/** A PEM entry tagged with the trust source it came from. */
export interface CaCertEntry {
  readonly pem: string
  readonly source: string
}

/** Official `tt` — verbatim from the 2.1.303 binary (order preserved). */
const BLOCKED_ROOT_CERTIFICATES: readonly BlockedRootCertificate[] = [
  {
    certificate:
      '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    key: '8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782',
  },
  {
    certificate:
      'bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3',
    key: 'eabc185c4e82d942b1a5978ba3c0181487d6b3b9974e5c49f72f6d0bd9637150',
  },
  {
    certificate:
      '40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367',
    key: '376a1a7082a593dccc20d561d119e9ab8d30f11cc321d0a37fa41f0df284e01c',
  },
  {
    certificate:
      '125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f',
    key: 'b7408b4d2be0238ba37004dd34e276c6019bd2f24c9db7d4980f5f6c359a4bcc',
  },
]

/** Official `Ce`. */
const BLOCKED_CERT_HASHES = new Set(
  BLOCKED_ROOT_CERTIFICATES.map((entry) => entry.certificate),
)

/** Official `jn`. */
const BLOCKED_KEY_HASHES = new Set(
  BLOCKED_ROOT_CERTIFICATES.map((entry) => entry.key),
)

/** Official `me` — max strip passes before an entry counts as too-nested. */
const MAX_STRIP_PASSES = 8

type NodeCrypto = typeof import('node:crypto')

/** Official `Ue("crypto")` — deferred load, keeps import cost off the hot path. */
function nodeCrypto(): NodeCrypto {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('node:crypto') as NodeCrypto
  /* eslint-enable @typescript-eslint/no-require-imports */
}

function sha256Hex(data: string | Uint8Array): string {
  return nodeCrypto().createHash('sha256').update(data).digest('hex')
}

function tryParseCertificate(pem: string): X509CertificateType | undefined {
  const { X509Certificate } = nodeCrypto()
  try {
    return new X509Certificate(pem)
  } catch {
    return undefined
  }
}

/**
 * Official `Qe` — locate `[start, end)` ranges of complete
 * `-----BEGIN …-----` / `-----END …-----` PEM blocks in a string.
 * The END label must close within 80 chars and contain no newline.
 */
export function findPemBlocks(pem: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let beginIdx = pem.indexOf('-----BEGIN ')
  let endIdx = pem.indexOf('-----END ')
  let pendingBegin = -1
  while (endIdx !== -1) {
    if (beginIdx !== -1 && beginIdx < endIdx) {
      pendingBegin = beginIdx
      beginIdx = pem.indexOf('-----BEGIN ', beginIdx + 1)
      continue
    }
    const labelWindow = pem.slice(endIdx, endIdx + 80)
    const dashOffset = labelWindow.indexOf('-----', 9)
    if (dashOffset === -1 || labelWindow.slice(0, dashOffset).includes('\n')) {
      endIdx = pem.indexOf('-----END ', endIdx + 1)
      continue
    }
    const blockEnd = endIdx + dashOffset + 5
    if (pendingBegin !== -1) {
      ranges.push([pendingBegin, blockEnd])
      pendingBegin = -1
    }
    endIdx = pem.indexOf('-----END ', blockEnd)
  }
  return ranges
}

/** Official `Je`. */
function extraCertsSuffix(source: string): string {
  return source === 'NODE_EXTRA_CA_CERTS' ? ' (the whole file)' : ''
}

/** Official `Ze` warning kinds. */
export type IgnoredExtraCertsKind = 'block' | 'file' | 'nested'

/**
 * Official `Ze` — deduped user-facing console.error for ignored
 * NODE_EXTRA_CA_CERTS content. Messages verbatim from the binary.
 */
export function warnIgnoredExtraCerts(
  kind: IgnoredExtraCertsKind,
  hash: string,
  warned: Set<string>,
): void {
  const dedupeKey = `${kind}:${hash}`
  if (warned.has(dedupeKey)) {
    return
  }
  warned.add(dedupeKey)
  const message = {
    block: "Claude Code ignored a block in the NODE_EXTRA_CA_CERTS file: the block holds a root certificate on the CLI's deny list, in a form Claude Code could not read. The other certificates in the file are still used.",
    file: "Claude Code ignored all of the NODE_EXTRA_CA_CERTS file: it holds a root certificate on the CLI's deny list, in a form Claude Code could not read. Run Claude Code with --debug to write its SHA-256 fingerprint to the debug log, then remove that certificate from the file.",
    nested: "Claude Code ignored all of the NODE_EXTRA_CA_CERTS file: it holds root certificates on the CLI's deny list nested too deeply to cut out. Remove them so the rest of the file is used.",
  }[kind]
  console.error(message)
}

/**
 * Official `nt` — find which bundled roots are on the deny list, returning
 * their truncated-DER base64 (used to substring-match unparseable blocks).
 */
export function collectBlockedBundledRoots(
  rootCertificates: readonly string[],
): BlockedBundledRoot[] {
  const { X509Certificate, createHash } = nodeCrypto()
  return rootCertificates.flatMap((pem) => {
    let der: Uint8Array
    try {
      der = new X509Certificate(pem).raw
    } catch (error) {
      logForDebugging(`CA certs: A bundled root does not parse: ${error}`, {
        level: 'error',
      })
      return []
    }
    const hash = createHash('sha256').update(der).digest('hex')
    if (!BLOCKED_CERT_HASHES.has(hash)) {
      return []
    }
    return [
      {
        base64: Buffer.from(der)
          .subarray(0, der.length - (der.length % 3))
          .toString('base64'),
        hash,
      },
    ]
  })
}

/**
 * Official `f` — for a parsed certificate, return its cert hash if the cert
 * DER is deny-listed, else its cert hash if the SPKI public-key hash is
 * deny-listed (catches re-issued certs sharing a blocked key), else undefined.
 */
function blockedHashOfParsedCertificate(
  cert: X509CertificateType,
): string | undefined {
  const { createPublicKey } = nodeCrypto()
  const certHash = sha256Hex(cert.raw)
  if (BLOCKED_CERT_HASHES.has(certHash)) {
    return certHash
  }
  try {
    let publicKey: KeyObject = cert.publicKey
    try {
      publicKey = createPublicKey({
        key: publicKey.export({ format: 'jwk' }),
        format: 'jwk',
      })
    } catch {
      // keep the original key object if the JWK round-trip fails
    }
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    return BLOCKED_KEY_HASHES.has(sha256Hex(spki)) ? certHash : undefined
  } catch {
    return undefined
  }
}

/**
 * Official `l` — match an UNPARSEABLE block by substring: its whitespace-
 * stripped text still contains a blocked root's base64 DER.
 */
function findBlockedByBase64(
  blockText: string,
  blocked: readonly BlockedBundledRoot[],
): BlockedBundledRoot | undefined {
  const compact = blockText.replace(/\s+/g, '')
  return blocked.find(({ base64 }) => compact.includes(base64))
}

/**
 * Official `h` — match an UNPARSEABLE block by manually walking DER framing:
 * decode the body, validate the outer SEQUENCE length, hash the first framed
 * element, then check cert hash / parse + key hash.
 */
function detectBlockedDerFraming(blockText: string): string | undefined {
  const { X509Certificate } = nodeCrypto()
  const body = blockText.slice(
    blockText.indexOf('-----', 5) + 5,
    blockText.lastIndexOf('-----END'),
  )
  const der = Buffer.from(body.replace(/[^A-Za-z0-9+/]/g, ''), 'base64')
  if (der[0] !== 0x30 || der.length < 2) {
    return undefined
  }
  const isLongForm = (der[1] & 0x80) !== 0
  const lengthBytes = isLongForm ? der[1] & 0x7f : 0
  if (
    (isLongForm && (lengthBytes === 0 || lengthBytes > 4)) ||
    der.length < 2 + lengthBytes
  ) {
    return undefined
  }
  const contentLength = isLongForm ? der.readUIntBE(2, lengthBytes) : der[1]
  if (2 + lengthBytes + contentLength > der.length) {
    return undefined
  }
  const framed = der.subarray(0, 2 + lengthBytes + contentLength)
  const framedHash = sha256Hex(framed)
  if (BLOCKED_CERT_HASHES.has(framedHash)) {
    return framedHash
  }
  let parsed: X509CertificateType
  try {
    parsed = new X509Certificate(framed)
  } catch {
    return undefined
  }
  return blockedHashOfParsedCertificate(parsed)
}

/**
 * Official `Ee` — strip deny-listed certificates out of each PEM entry.
 * Iterates up to MAX_STRIP_PASSES so blocks exposed by earlier cuts (nesting)
 * are removed too. Returns the surviving entry texts; entries that still
 * contain blocked content, or that nested too deeply, are dropped (with the
 * official debug logs + NODE_EXTRA_CA_CERTS console warnings).
 */
export function dropBlockedCertificates(
  entries: readonly CaCertEntry[],
  blocked: readonly BlockedBundledRoot[],
  warned: Set<string> = new Set(),
): string[] {
  const kept: string[] = []
  for (const { pem, source } of entries) {
    let current = pem
    let passes = 0
    let droppedUnreadableBlock = false
    for (; passes <= MAX_STRIP_PASSES; passes++) {
      const pieces: string[] = []
      let cutStart = 0
      let prevBlockEnd = 0
      let droppedAny = false
      for (const [blockStart, blockEnd] of findPemBlocks(current)) {
        const blockText = current.slice(blockStart, blockEnd)
        const parsed = tryParseCertificate(blockText)
        let dropMessage: string | undefined
        if (parsed) {
          const hash = blockedHashOfParsedCertificate(parsed)
          dropMessage = hash
            ? `Dropped blocked certificate ${hash} from ${source}`
            : undefined
        } else {
          const hash =
            findBlockedByBase64(blockText, blocked)?.hash ??
            detectBlockedDerFraming(blockText)
          if (hash) {
            droppedUnreadableBlock = true
            dropMessage = `Dropped an unreadable block from ${source}: the block contains blocked certificate ${hash}`
          }
        }
        const keepEnd = Math.max(blockStart, prevBlockEnd)
        prevBlockEnd = blockEnd
        if (dropMessage && keepEnd >= cutStart) {
          logForDebugging(`CA certs: ${dropMessage}`)
          pieces.push(current.slice(cutStart, keepEnd))
          cutStart = blockEnd
          droppedAny = true
        }
      }
      if (!droppedAny) {
        break
      }
      pieces.push(current.slice(cutStart))
      current = pieces.join('')
    }
    if (passes > MAX_STRIP_PASSES) {
      logForDebugging(
        `CA certs: Ignored an entry from ${source}${extraCertsSuffix(source)}: blocked certificates are nested in it more than ${MAX_STRIP_PASSES} deep`,
      )
      if (source === 'NODE_EXTRA_CA_CERTS') {
        warnIgnoredExtraCerts('nested', sha256Hex(pem), warned)
      }
      continue
    }
    const residual = findBlockedByBase64(current, blocked)
    const isUsable =
      !residual &&
      (passes === 0 ||
        findPemBlocks(current).some(
          ([start, end]) =>
            tryParseCertificate(current.slice(start, end)) !== undefined,
        ))
    if (residual) {
      logForDebugging(
        `CA certs: Ignored an entry from ${source}${extraCertsSuffix(source)}: it still contains blocked certificate ${residual.hash}`,
      )
    }
    if (source === 'NODE_EXTRA_CA_CERTS' && (residual || droppedUnreadableBlock)) {
      warnIgnoredExtraCerts(isUsable ? 'block' : 'file', sha256Hex(pem), warned)
    }
    if (isUsable) {
      kept.push(current)
    }
  }
  return kept
}

/**
 * Official `qn` — resolve the trusted store certificates: filter the collected
 * entries; if that leaves nothing, retry with just the (filtered) bundled
 * roots; if even those are all deny-listed, throw (verbatim message).
 */
export function resolveTrustedCertificates(
  entries: readonly CaCertEntry[],
  rootCertificates: readonly string[],
  blocked: readonly BlockedBundledRoot[] = collectBlockedBundledRoots(
    rootCertificates,
  ),
  warned: Set<string> = new Set(),
): string[] {
  const filtered = dropBlockedCertificates(entries, blocked, warned)
  if (filtered.length > 0) {
    return filtered
  }
  const bundledEntries: CaCertEntry[] = rootCertificates.map((pem) => ({
    pem,
    source: 'bundled',
  }))
  const bundledOnly = dropBlockedCertificates(bundledEntries, blocked)
  if (bundledOnly.length > 0) {
    return bundledOnly
  }
  throw new Error(
    "No root certificates are left to trust: every root built into this runtime is on the CLI's deny list. Update Claude Code.",
  )
}
