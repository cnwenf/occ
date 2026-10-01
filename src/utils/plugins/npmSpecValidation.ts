/**
 * npm spec / registry validation (v2.1.286 security alignment)
 *
 * Port of the official Claude Code 2.1.286 changelog item: "Changed plugin
 * installs to refuse npm sources that are git repositories or folders, and to
 * install plugin dependencies only from registry packages." This module is the
 * VALIDATION half — the dependency-installer half is a no-op in OCC (OCC has
 * no plugin-dependency installer at all).
 *
 * Every string / structure below was recovered byte-for-byte from the official
 * 2.1.286 linux-x64 ELF (`/tmp/cc-diff-286/v286/package/claude`); offsets are
 * cited per-helper and all are in the code region (>195 MB). Each was confirmed
 * ABSENT from 2.1.285 (new in 286). Minified identifiers (`HWe`, `X8t`, `Z8t`,
 * `krr`, `Tje`, `fJe`, `Nue`, `zy`, `Krr`, `Mrr`) are v286-local names.
 *
 * Official pieces ported here:
 *  - `X8t(url, registryOrigin, label)`      → findSpecRejectionReason   (@207632528)
 *  - `HWe(url, registry, origin, label)`    → validateNpmSpecUrl        (@207632383)
 *  - `Z8t(name, options)`                   → validateRegistryOverride  (@207633872)
 *  - `krr` git-host blocklist               → GIT_HOST_BLOCKLIST        (@207630990)
 *  - `Tje`/`HD` host normalizer             → normalizeGitHost          (@196729740/196730013)
 *  - `Err` control-char scan                → containsControlChar       (@207633382)
 *  - `fJe` registry-URL validator           → isValidNpmRegistryUrl     (@197012762)
 *  - `zy`/`Nue` npm-name validator          → isValidNpmPackageName     (@197035581/207643059)
 *  - `Mrr` refusal (registry lane)          → buildRegistryRefusalMessage   (@207635951)
 *  - `Krr` refusal (fallback lane)          → buildFallbackRefusalMessage   (@207643337)
 *  - `bRr` invalid-name refusal             → buildInvalidPackageNameMessage (@207631180)
 *
 * This module is intentionally dependency-free (no npm exec, no imports from
 * npmPluginFetch.ts) so it is unit-testable in isolation; the npm-shelling
 * pieces (`vue` = getDefaultRegistryOrigin, `dY` runner hardening) live in
 * npmPluginFetch.ts and are injected here via callbacks.
 */

/**
 * Official `krr` (v286 @207630990):
 * `new Set([bo, `gist.${bo}`, "gitlab.com", "bitbucket.org", "git.sr.ht"])`
 * where `bo = "github.com"` (@196729547).
 */
export const GIT_HOST_BLOCKLIST: ReadonlySet<string> = new Set([
  'github.com',
  'gist.github.com',
  'gitlab.com',
  'bitbucket.org',
  'git.sr.ht',
])

/** Official `X8t` result — a human-readable rejection clause. */
export type NpmSpecRejectionReason = string

/** Official `HWe` result — reason plus the relative-to-registry `moved` flag. */
export interface NpmSpecRejection {
  reason: NpmSpecRejectionReason
  moved: boolean
}

/** Official `Z8t` result: ok (optionally carrying the default http origin) or a refusal. */
export type RegistryOverrideValidation =
  | { ok: true; origin?: string }
  | { ok: false; message: string; reason: string }

// --- Official reason strings (byte-exact, v286) -----------------------------

/** Official `X8t` reason (@207632564). */
const REASON_NOT_HTTP = 'is not an http or https link'
/** Official `X8t` reason (@207632778). */
const REASON_BAD_CHARS =
  'contains a "#", whitespace, a backslash or a control character'
/** Official `X8t` reason (@207633138). */
const REASON_DOUBLE_SLASH_PATH = 'starts its path with "//"'

/** Official `UWe` = 32 (space) — control-char upper bound (exclusive). */
const CONTROL_CHAR_UPPER_BOUND = 32
/** Official `crr` = 127 (DEL). */
const DELETE_CHAR_CODE = 127

// --- Host normalization (official `Tje` / `HD`) -----------------------------

/**
 * Official `Tje` = strip-www ∘ `HD` (v286 @196730013 / @196729740).
 *
 * `HD` strips `\t\n\r`, lowercases, and — for a clean hostname — round-trips
 * through `new URL('https://'+host)` to adopt WHATWG's IDN→punycode hostname
 * normalization (returning the input unchanged when it carries a username,
 * password, port, path, query or fragment). `HD`'s inner Unicode normalizer
 * (`l`) is idempotent on the ASCII punycode hostnames that WHATWG `URL` already
 * produces, so it is folded into the `URL` round-trip here. `Tje` then strips
 * any leading `www.` labels so `www.github.com` matches the blocklist.
 *
 * In `X8t` the input is already `new URL(spec).hostname` (URL-normalized), so
 * the observable effect is the `www.` strip plus a defensive re-normalization.
 */
export function normalizeGitHost(hostname: string): string {
  let host = hostname.replace(/[\t\n\r]/g, '').toLowerCase()
  // Official `m` = /[:/\\?#@\s]/ — inputs containing these are returned as-is.
  if (host !== '' && !/[:/\\?#@\s]/.test(host)) {
    try {
      const parsed = new URL(`https://${host}`)
      if (
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.port === '' &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      ) {
        host = parsed.hostname
      }
    } catch {
      // keep the pre-parse value (official `catch{return e}`)
    }
  }
  while (host.startsWith('www.')) {
    host = host.slice(4)
  }
  return host
}

// --- Control-character scan (official `Err`) --------------------------------

/**
 * Official `Err` (v286 @207633382): true when any char code is `< UWe (32)` or
 * `=== crr (127)` — i.e. C0 control characters or DEL.
 */
export function containsControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < CONTROL_CHAR_UPPER_BOUND || code === DELETE_CHAR_CODE) {
      return true
    }
  }
  return false
}

// --- Registry-URL validator (official `fJe`) --------------------------------

/**
 * Official `fJe` (v286 @197012762, byte-identical to v285 `byn` @196028402):
 * `/^https?:\/\/[^/\\]/i` (scheme + a first char that is not `/` or `\`), then
 * a `URL` parse whose protocol must be `http:`/`https:`.
 */
export function isValidNpmRegistryUrl(value: string): boolean {
  if (!/^https?:\/\/[^/\\]/i.test(value)) {
    return false
  }
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

// --- npm package-name validator (official `zy` / `Nue`) ---------------------

/** Official `Bp` (v286 @197035581) — scoped package name. */
const SCOPED_PACKAGE_PATTERN = /^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/
/** Official `Wp` (v286 @197035632) — unscoped package name. */
const REGULAR_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9-._]*$/

/**
 * Official `zy` (v286 @207643059) = `Nue(name.toLowerCase())`, where `Nue`
 * (@197035693) = `!includes('..') && !includes('//') && (Bp.test || Wp.test)`.
 * These patterns are byte-identical to OCC's existing `NpmPackageNameSchema`.
 */
export function isValidNpmPackageName(name: string): boolean {
  const lowered = name.replace(/[A-Z]/g, char => char.toLowerCase())
  return (
    !lowered.includes('..') &&
    !lowered.includes('//') &&
    (SCOPED_PACKAGE_PATTERN.test(lowered) || REGULAR_PACKAGE_PATTERN.test(lowered))
  )
}

// --- URL / spec validator (official `X8t`) ----------------------------------

/**
 * Official `X8t(url, registryOrigin, label="npm")` (v286 @207632528). Returns
 * the first matching rejection reason, or `undefined` when the spec is a plain
 * http(s) tarball download on an acceptable host.
 *
 * Order of checks (byte-faithful):
 *  1. not `^https?://` or unparseable           → "is not an http or https link"
 *  2. `[\s#\\]` or a control char               → 'contains a "#", whitespace, a backslash or a control character'
 *  3. host in the git blocklist (`krr`), unless the GitLab package-registry
 *     exception (pathname starts `/api/v4/` and includes `/-/`) → git-host reason
 *  4. pathname starts with `//`                 → 'starts its path with "//"'
 *  5. `http:` on a host other than the registry → unencrypted-http reason
 */
export function findSpecRejectionReason(
  url: string,
  registryOrigin: string | undefined,
  label = 'npm',
): NpmSpecRejectionReason | undefined {
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
    return REASON_NOT_HTTP
  }
  if (/[\s#\\]/.test(url) || containsControlChar(url)) {
    return REASON_BAD_CHARS
  }
  const parsed = new URL(url)
  const host = normalizeGitHost(parsed.hostname)
  const isGitLabPackageRegistry =
    host === 'gitlab.com' &&
    parsed.pathname.startsWith('/api/v4/') &&
    parsed.pathname.includes('/-/')
  if (GIT_HOST_BLOCKLIST.has(host) && !isGitLabPackageRegistry) {
    return `is on GitHub, GitLab, Bitbucket or SourceHut, where ${label} may fetch it as a git repository and run its setup script`
  }
  if (parsed.pathname.startsWith('//')) {
    return REASON_DOUBLE_SLASH_PATH
  }
  if (parsed.protocol === 'http:' && parsed.origin !== registryOrigin) {
    return `is an unencrypted http link on a host other than your npm registry, so ${label} could send your saved registry token to it in the clear`
  }
  return undefined
}

// --- URL validator with relative-to-registry fallback (official `HWe`) ------

/**
 * Official `HWe(url, registry, registryOrigin, label="npm")` (v286 @207632383).
 *
 * First validates the spec as-is (`X8t`). If that passes but a `registry` base
 * is present, it re-validates the spec's pathname resolved against the registry
 * (npm may "move" a relative download address onto the marketplace's registry);
 * a failure there returns `{reason, moved: true}` so the caller can pick the
 * "the marketplace's owner can fix that" refusal variant.
 */
export function validateNpmSpecUrl(
  url: string,
  registry: string | undefined,
  registryOrigin: string | undefined,
  label = 'npm',
): NpmSpecRejection | undefined {
  const direct = findSpecRejectionReason(url, registryOrigin, label)
  if (direct !== undefined) {
    return { reason: direct, moved: false }
  }
  if (registry === undefined) {
    return undefined
  }
  const { pathname } = new URL(url)
  const resolved = URL.canParse(pathname, registry)
    ? findSpecRejectionReason(new URL(pathname, registry).href, registryOrigin, label)
    : REASON_NOT_HTTP
  return resolved === undefined ? undefined : { reason: resolved, moved: true }
}

// --- Registry-override validator (official `Z8t`) ---------------------------

/**
 * Official `Z8t(name, options)` (v286 @207633872). Validates a per-source
 * `registry` override before any npm invocation:
 *  - absent registry → ok
 *  - not a valid http(s) URL (`fJe`) → "the npm registry set for it is not a valid address."
 *  - `http:` registry whose origin differs from the default npm registry origin
 *    (`vue`) → the unencrypted-registry refusal
 *  - `http:` registry equal to the default → ok, carrying that origin
 *
 * `getDefaultOrigin` is the injected `vue` equivalent (`npm config get registry
 * --workspaces=false`, origin kept only when `http:`); it is called lazily, only
 * when the override is `http:`. `displayName` is the already-sanitized name the
 * official renders via `Nh(_C(name))`.
 */
export async function validateRegistryOverride(
  displayName: string,
  registry: string | undefined,
  getDefaultOrigin: () => Promise<string | undefined>,
): Promise<RegistryOverrideValidation> {
  if (registry === undefined) {
    return { ok: true }
  }
  if (!isValidNpmRegistryUrl(registry)) {
    return {
      ok: false,
      message: `"${displayName}" was not fetched: the npm registry set for it is not a valid address.`,
      reason: 'npm registry override is not a URL',
    }
  }
  const { origin, protocol } = new URL(registry)
  if (protocol !== 'http:') {
    return { ok: true }
  }
  const defaultOrigin = await getDefaultOrigin()
  if (origin !== defaultOrigin) {
    return {
      ok: false,
      message: `"${displayName}" was not fetched: its npm registry, ${origin}, is unencrypted and isn't your default npm registry, so npm could send your saved registry token to it in the clear. It works once the registry uses https (for a marketplace plugin, the marketplace's owner sets it) or is your default npm registry (npm config set registry <url>).`,
      reason: 'npm registry override is http',
    }
  }
  return { ok: true, origin: defaultOrigin }
}

// --- User-facing refusal builders -------------------------------------------

/**
 * Official `Mrr` refusal (registry lane, v286 @207635951). `displayName` is the
 * resolved `name@version` (official `Nh(r)`); `rejection` is the `HWe` result.
 */
export function buildRegistryRefusalMessage(
  displayName: string,
  rejection: NpmSpecRejection,
): string {
  return (
    `"${displayName}" was not installed: ` +
    (rejection.moved
      ? `npm may move this package's download address onto the npm registry the marketplace sets, and there it ${rejection.reason}. The marketplace's owner can fix that.`
      : `its registry lists a download address that ${rejection.reason}. The package's publisher can fix that.`)
  )
}

/**
 * Official `Krr` refusal (fallback lane, v286 @207643337). `displayName` is the
 * raw spec (official `Nh(_C(g))`); `rejection` is the `HWe` result.
 *
 * NOTE: OCC's `installNpmPluginPackage` is the marketplace lane only
 * (`isNpmMarketplaceLane`), which routes through `Mrr` — the `Krr` fallback
 * fires only on the official non-marketplace lane (a direct URL/git spec passed
 * to `oXt` without a prior `npm view`). OCC has no such lane today, so this
 * builder is ported for parity + tests and is not wired into a live path.
 */
export function buildFallbackRefusalMessage(
  displayName: string,
  rejection: NpmSpecRejection,
): string {
  return (
    `"${displayName}" was not installed: ` +
    (rejection.moved
      ? `npm may move this link onto the npm registry the marketplace sets, and there it ${rejection.reason}. The marketplace's owner can fix that.`
      : `it ${rejection.reason}. An npm plugin source must name a registry package (name or name@version) or link to a tarball file. For a plugin in a git repository, use a "github", "url" or "git-subdir" source.`)
  )
}

/**
 * Official `bRr` invalid-name refusal (v286 @207631180). `displayName` is the
 * raw package name (official `Nh(_C(e))`).
 */
export function buildInvalidPackageNameMessage(displayName: string): string {
  return `"${displayName}" was not fetched: it is not a valid npm package name. Valid names look like "my-plugin" or "@scope/my-plugin".`
}
