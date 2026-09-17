/**
 * CC 2.1.274 S3a — display sanitizers for model-visible MCP strings.
 *
 * Byte-verified port of the official 2.1.274 linux-x64 binary's sanitizer
 * family used by the MCP auth-stub tool description (binary `D(e,r,n)`):
 *   - `xr(name, max=64)`   server-name sanitizer  (@194523909 region)
 *   - `nPr(url, max=1024)` URL/endpoint sanitizer  (@194523871)
 *   - `Xi(input, max, redact)` shared core         (@194523909)
 *   - `Kin(text, mode)`    bearer/basic + token-family redaction (@194524420)
 *   - `gnr(input)`         invisible/control/surrogate stripping (@187512864)
 *   - `oe(s, n)` / `_e(s)` / `It(s)` surrogate-safe truncation (@187105334)
 * Constants: `oBo=200` (Xi default max), `hIe=2000`, `mvn=512` (redaction
 * scan window = max(hIe, n+mvn)), `gnr` input cap 4096.
 *
 * Why this exists: before 2.1.274 the official (and OCC) embedded the raw
 * env-EXPANDED MCP config URL in the auth-stub tool description, leaking
 * post-expansion secrets (e.g. `https://user:token@host` from an authored
 * `https://user:${TOKEN}@host`) into model-visible context. The 274 fix
 * routes display strings through this family: NFKC normalization, invisible-
 * character stripping (prompt-injection defense), quote/angle-bracket
 * neutralization, secret-pattern redaction, and code-point-safe truncation.
 */

/** Binary `jo` @187512407 — surrogate pairs, lone high, lone low. */
const SURROGATE_PATTERN =
  /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF]|[\uDC00-\uDFFF]/g

/**
 * Binary `sn` @187512539 — control/format chars, line/paragraph separators,
 * default-ignorables, braille blank, and non-space Zs separators.
 */
const INVISIBLE_PATTERN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?!\u0020)\p{Zs}/gu

/** Binary `oBo` @194523909 — `Xi` default max length. */
const DEFAULT_DISPLAY_MAX = 200

/** Binary `hIe` @194524420 region — redaction scan window base. */
const REDACT_SCAN_MAX = 2000

/** Binary `mvn` @194524420 region — slack added to `max` for the scan window. */
const REDACT_SCAN_SLACK = 512

/**
 * Binary `gnr` @187512864: cap input at 4096, replace lone surrogates with a
 * space (well-formed pairs are kept), and every invisible/control character
 * with a space.
 */
export function stripInvisibleForDisplay(input: unknown): string {
  if (typeof input !== 'string') return ''
  return (input.length > 4096 ? input.slice(0, 4096) : input)
    .replace(SURROGATE_PATTERN, match => (match.length === 2 ? match : ' '))
    .replace(INVISIBLE_PATTERN, ' ')
}

/**
 * Binary `It` @187105850 — chunked utf16 round-trip used when `Buffer` is
 * unavailable (non-Node hosts). Best-effort identity in that environment.
 * Note (security review 2026-09-17): measured on bun/Node, the utf16le
 * round-trip PRESERVES lone surrogates rather than replacing them with
 * U+FFFD — it is a belt-and-braces no-op here, not the control. The actual
 * lone-surrogate neutralization is `stripInvisibleForDisplay` (jo pattern →
 * space), which runs earlier in every sanitize pipeline.
 */
function sanitizeLoneSurrogatesFallback(value: string): string {
  const chunks: string[] = []
  for (let i = 0; i < value.length; i += 8192) {
    const end = Math.min(i + 8192, value.length)
    const codes = new Uint16Array(end - i)
    for (let a = i; a < end; a++) codes[a - i] = value.charCodeAt(a)
    chunks.push(String.fromCharCode(...codes))
  }
  return chunks.join('')
}

/** Binary `_e` @187105xxx: utf16le round-trip (identity in practice — see `It` note). */
function sanitizeLoneSurrogates(value: string): string {
  if (typeof Buffer < 'u')
    return Buffer.from(value, 'utf16le').toString('utf16le')
  return sanitizeLoneSurrogatesFallback(value)
}

/**
 * Binary `oe` @187105334: head-truncate to `max` UTF-16 code units, dropping
 * a trailing high surrogate so the result never ends mid-pair, then
 * round-trip to neutralize any lone surrogate the cut exposed.
 */
export function truncateToDisplayLength(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  const head = value.slice(0, max)
  const lastUnit = head.charCodeAt(max - 1)
  return sanitizeLoneSurrogates(
    lastUnit >= 55296 && lastUnit <= 56319 ? head.slice(0, -1) : head,
  )
}

/**
 * Binary `Kin` @194524420: redact `bearer <secret>` / `basic <secret>` and
 * token-family `label: secret` / `label=secret` pairs (incl. JSON-escaped
 * forms) when the secret body looks secret-bearing. `mode: 'none'` skips
 * redaction entirely (used for server names).
 */
export function redactSecretsForDisplay(
  value: string,
  mode: 'all' | 'none' = 'all',
): string {
  function replacer(match: string, label: string, secret: string): string {
    return /[0-9._~+/=%-]/.test(secret) ? `${label} [redacted]` : match
  }
  if (mode === 'none') return value
  return value
    .replace(
      /(?:\b|(?<=\\[A-Za-z"']))(bearer|basic)[\s:=\uFF1A\uFF1D]+(?:(?:\\*["']|\\+)\s*)?([A-Za-z0-9._~+/=%-]{8,})/gi,
      replacer,
    )
    .replace(
      /(?:\b|(?<=\\[A-Za-z"']))((?:access[-_ ]?|refresh[-_ ]?|id[-_ ]?|client[-_ ]?|api[-_ ]?|x[-_]api[-_ ]?|session[-_ ]?|auth[-_ ]?)?(?:token|key|secret|password|authorization|credential)s?)(?:\\*["']|\\+)?\s*[:=\uFF1A\uFF1D]\s*(?:\\*["']|\\+)?\s*([A-Za-z0-9._~+/=%-]{8,})/gi,
      replacer,
    )
}

/**
 * Binary `Xi` @194523909: NFKC-normalize, strip invisibles (`gnr`),
 * neutralize angle brackets / directional + CJK quotes / double-quote /
 * semicolon, collapse whitespace, redact secrets over a scan window of
 * `max(REDACT_SCAN_MAX, max + REDACT_SCAN_SLACK)`, then truncate with an
 * ellipsis when the input overflowed the window or the redacted text
 * exceeds `max`.
 */
export function sanitizeForDisplay(
  input: unknown,
  max: number = DEFAULT_DISPLAY_MAX,
  redact: 'all' | 'none' = 'all',
): string {
  if (typeof input !== 'string') return ''
  const cleaned = stripInvisibleForDisplay(input.normalize('NFKC'))
    .replaceAll(
      /[<>";\u2018\u2019\u201A\u201C\u201D\u201E\u00AB\u20BB\u2039\u203A\u2329\u232A\u27E8\u27E9\u27EA\u27EB\u3008\u3009\u300A\u300B]/g,
      ' ',
    )
    .replaceAll(/\s+/g, ' ')
    .trim()
  const scanMax = Math.max(REDACT_SCAN_MAX, max + REDACT_SCAN_SLACK)
  const overflow = cleaned.length > scanMax
  const redacted = redactSecretsForDisplay(
    overflow ? truncateToDisplayLength(cleaned, scanMax) : cleaned,
    redact,
  )
  return overflow || redacted.length > max
    ? `${truncateToDisplayLength(redacted, max)}\u2026`
    : redacted
}

/** Binary `nPr` @194523871: URL/endpoint display sanitizer (redact on). */
export function sanitizeDisplayUrl(url: string, max = 1024): string {
  return sanitizeForDisplay(url, max)
}

/**
 * Binary `xr` @194523909 region: server-name display sanitizer — NFKC,
 * quotes/backticks become spaces (they delimit the name inside the
 * description template), redaction off (names are not secret carriers).
 */
export function sanitizeServerNameForDisplay(name: unknown, max = 64): string {
  if (typeof name !== 'string') return ''
  return sanitizeForDisplay(
    name.normalize('NFKC').replace(/['`]/g, ' '),
    max,
    'none',
  )
}
