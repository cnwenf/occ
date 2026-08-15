import { parseEnvInt } from '../../utils/envValidation.js'
import { pluralize } from '../../utils/oauthLoginExpiry.js'

/**
 * 2.1.233 alignment (OCC-95): the WebFetch URL-cache TTL became configurable
 * via `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`, and the tool description reports
 * the effective TTL instead of a hardcoded "15-minute".
 *
 * Ported from the official 2.1.233 linux-x64 ELF (byte-verified):
 *
 *   var WJ_=9e5                       // default TTL — 15 minutes
 *   var Mwd                           // memo for AVs
 *   function AVs(){return Mwd??=Rjc()}
 *   function Rjc(){                   // Ge.int({min:1,digitsOnly:!0}) parse
 *     let e=V.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS;
 *     if(e===void 0)return WJ_;
 *     // digitsOnly: the env schema rejects anything that is not an integer
 *     // literal — non-digits, non-finite, or <1 fall back to the default
 *     let t=kg(e);                    // ≡ OCC parseEnvInt
 *     if(t===void 0||!Number.isFinite(t)||t<1)return WJ_;
 *     return t}
 *   function $wd(){let e=Math.max(1,Math.round(AVs()/6e4));
 *     return `${e} ${Pluralize(e,"minute")}`}
 *
 * Lives in its own module (rather than utils.ts) because the tool
 * description in prompt.ts needs `getWebFetchCacheTtlDescription()` while
 * utils.ts imports prompt.ts — a direct import would be circular.
 */

const DEFAULT_WEBFETCH_CACHE_TTL_MS = 900_000 // binary WJ_ — 15 minutes
let cachedWebFetchCacheTtlMs: number | undefined // binary Mwd memo

/** Effective URL-cache TTL in ms (binary `AVs`/`Rjc`). Memoized per process. */
export function getWebFetchCacheTtlMs(): number {
  return (cachedWebFetchCacheTtlMs ??= (() => {
    const raw = process.env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS
    if (raw === undefined) {
      return DEFAULT_WEBFETCH_CACHE_TTL_MS
    }
    // digitsOnly: reject anything that is not an integer literal
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      return DEFAULT_WEBFETCH_CACHE_TTL_MS
    }
    const parsed = parseEnvInt(raw)
    if (parsed === undefined || !Number.isFinite(parsed)) {
      return DEFAULT_WEBFETCH_CACHE_TTL_MS
    }
    if (parsed < 1) {
      return DEFAULT_WEBFETCH_CACHE_TTL_MS // min: 1
    }
    return parsed
  })())
}

/** Human-readable TTL for the tool description (binary `$wd`). */
export function getWebFetchCacheTtlDescription(): string {
  const minutes = Math.max(1, Math.round(getWebFetchCacheTtlMs() / 60_000))
  return `${minutes} ${pluralize(minutes, 'minute')}`
}

/** Test-only: drop the memo so a changed env value is re-read. */
export function resetWebFetchCacheTtlForTesting(): void {
  cachedWebFetchCacheTtlMs = undefined
}
