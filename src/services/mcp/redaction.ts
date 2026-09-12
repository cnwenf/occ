/**
 * CC 2.1.268 E16: MCP `${VAR}` secret redaction — byte-verified port from the
 * official 2.1.268 linux-x64 binary (`/tmp/cc-diff-268/s2s.txt`).
 *
 * Stops `claude mcp list` / `claude mcp get`, the `/mcp` + `/plugin` server
 * detail UI, MCP failure messages, and MCP login errors from showing secrets
 * resolved from `${VAR}` placeholders in MCP configs.
 *
 * Official symbols ported here (binary offsets in s2s.txt):
 *   - `Yce`/`aX`/`Tat`/`Cat`/`vte` @29940100 — env-placeholder primitives
 *   - `bc` @11093579 — regex escaper
 *   - `JGo` @32576205 — recoverExpandedSecrets (NEW in 268, added.txt @24705909)
 *   - `ezo` @32577163 — collectConfigSecrets
 *   - `m`/`bV`/`S`/`M`/`Uun`/`p`/`h`/`f`/`wp` @23569500 — redaction module
 *   - `tQn` @30735025 (signature @32577685) — error-detail redactor
 *   - `KGo`/`YGo`/`XGo` @32575xxx — label-like secret classifier
 *   - `x$e`/`cUn`/`aUn` @32575310 — truncation constants (STAGED, see below)
 *   - `ice`/`K_e`/`NG`/`l0t`/`oe`/`Pst`/`We`/`ie` @20411500 — endpoint display
 *   - `dt`/`Pe`/`Be` @32803400 — display sanitizers
 *
 * Documented divergences from the official (nothing invented; each is a
 * staged or OCC-structural difference):
 *   1. STAGED: the NFKC / percent-decode / invisible-character normalization
 *      engine inside `tQn` (`D = [...P(ot)].filter(!$t=>v($t)).map(O).join("")`
 *      — NFKC fixed-point `P`, combining-mark stripper `O`, invisible-char
 *      predicate `v` via `QGo`, percent-decoder `_`) and the 2512-char
 *      truncation (`aUn = x$e + cUn = 2000 + 512`, `F`/`oe`/`pe`/`me` index
 *      mapping) are NOT ported. `redactMcpErrorText` does plain substring
 *      redaction on the raw error text (normalizer = identity).
 *   2. `JGo`'s final `K(d)` dedupe is not recoverable from the binary —
 *      inferred as `[...new Set(d)]` (dedupe is the only behavior consistent
 *      with the name and call sites).
 *   3. `mw` cliOwned-config registry (`Nt().cliOwnedConfigs`) and its `k$n`/
 *      `sC` bearer-masking branch are not ported — OCC has no cliOwned
 *      registry; `getEndpointForDisplay` is always called with
 *      `cliOwned: false` (the `d = u` path).
 *   4. `Pe`/`Be`'s `h$` secret-scanner pre-pass and the managed-scope `V6`/
 *      `Kc` ("(value set by your organization)") masking are not ported —
 *      OCC has no `h$` scanner and never produces managed-scope servers.
 *   5. The official re-parses each scope at display time via
 *      `fu(scope, {expandVars:!1})` (`S`/`Be`/`Se`). OCC injects an
 *      `UnexpandedScopeResolver` callback instead so this module stays pure
 *      (imports only `types.js`) and cannot create an import cycle with
 *      `config.ts` / `mcpPluginIntegration.ts`. Dynamic-scope servers
 *      (`--mcp-config`, plugin servers) have no re-parseable file, so their
 *      AUTHORED copies are registered in the module-level registry below at
 *      parse time (`registerAuthoredUnexpandedConfig`).
 *   6. claudeai-scope servers (runtime-fetched connectors, never env-expanded)
 *      pass through `deepNormalizeEnvVarRefs` in `getDisplayServers` instead of
 *      the re-parse path — the official's `fu('claudeai', …)` has no OCC
 *      equivalent and the `Pe` fallback would degrade connector URLs to a
 *      bare type label.
 */
import {
  type ConfigScope,
  ConfigScopeSchema,
  type McpServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants (binary-verified strings)
// ---------------------------------------------------------------------------

/** `tQn`'s `d = r ?? "[mcp-endpoint]"` fallback (@32577685). */
export const MCP_ENDPOINT_PLACEHOLDER = '[mcp-endpoint]'

/** `wp`'s catch fallback (@23569500) — used ONLY where the official wraps. */
export const MCP_ERROR_REDACTION_FAILED =
  '[mcp error detail unavailable: redaction failed]'

/** `JGo` guards (@32576205): `n.length>2000||r.length>9` and `P.length<=64`. */
const MAX_RECOVER_EXPANDED_LENGTH = 2000
const MAX_RECOVER_SEGMENTS = 9
const MAX_MIDDLE_OCCURRENCES = 64

/**
 * Resolver for the AUTHORED (unexpanded) servers of a scope — the injected
 * equivalent of the official's `fu(scope, {expandVars:!1}).servers`
 * (`S`/`Be` @23569500/@32803400). Returns undefined when the scope cannot be
 * re-parsed unexpanded.
 */
export type UnexpandedScopeResolver = (
  scope: ConfigScope,
) => Record<string, ScopedMcpServerConfig> | undefined

// ---------------------------------------------------------------------------
// Env-placeholder primitives — `Yce`/`aX`/`Tat`/`Cat`/`vte` @29940100
// ---------------------------------------------------------------------------

/**
 * Binary `Yce`:
 *   var Yce=String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}`
 */
export const ENV_VAR_PATTERN = String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}`

/** Binary `aX`: `return new RegExp(Yce).test(e)` */
export function hasEnvVarRefs(value: string): boolean {
  return new RegExp(ENV_VAR_PATTERN).test(value)
}

/**
 * Binary `Tat`: splits a template into the literal segments BETWEEN `${VAR}`
 * placeholders (`n` segments for `n-1` placeholders).
 *   function Tat(e){let n=[],o=0;for(let r of e.matchAll(new RegExp(Yce,"g")))
 *     n.push(e.slice(o,r.index)),o=r.index+r[0].length;return n.push(e.slice(o)),n}
 */
export function splitEnvVarSegments(template: string): string[] {
  const segments: string[] = []
  let cursor = 0
  for (const match of template.matchAll(new RegExp(ENV_VAR_PATTERN, 'g'))) {
    segments.push(template.slice(cursor, match.index))
    cursor = match.index + match[0].length
  }
  segments.push(template.slice(cursor))
  return segments
}

/**
 * Binary `Cat`: masks each placeholder with `x` of the SAME length —
 *   function Cat(e){return e.replace(new RegExp(Yce,"g"),(n)=>"x".repeat(n.length))}
 */
export function redactEnvVarPlaceholders(value: string): string {
  return value.replace(
    new RegExp(ENV_VAR_PATTERN, 'g'),
    match => 'x'.repeat(match.length),
  )
}

/**
 * Binary `vte`: normalizes `${VAR:-default}` → `${VAR}` (drops defaults so
 * authored templates compare/display canonically) —
 *   function vte(e){return e.replace(new RegExp(Yce,"g"),(n,o)=>`\${${o}}`)}
 */
export function normalizeEnvVarRefs(value: string): string {
  return value.replace(
    new RegExp(ENV_VAR_PATTERN, 'g'),
    (_match, name: string) => `\${${name}}`,
  )
}

/**
 * Binary `bc` @11093579:
 *   function bc(e){return e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Secret recovery — `JGo` @32576205 (NEW in 268) + `ezo` @32577163
// ---------------------------------------------------------------------------

/**
 * Binary `JGo(template, expanded)`: recovers the secret values that `${VAR}`
 * placeholders expanded to by aligning the authored template's literal
 * segments against the expanded string. Guards: empty inputs / no `${` /
 * <2 segments → []; expanded >2000 chars or >9 segments → []; the ≥4-segment
 * regex path bails when two placeholders are adjacent (empty middle segment);
 * the 3-segment path caps middle-segment occurrences at 64 (falling back to
 * first+last occurrence).
 *
 * Divergence: the trailing `K(d)` dedupe is inferred as `[...new Set(d)]`.
 */
export function recoverExpandedSecrets(
  template: string,
  expanded: string,
): string[] {
  if (!template || !expanded || !template.includes('${')) return []
  const segments = splitEnvVarSegments(template)
  if (segments.length < 2) return []
  if (
    expanded.length > MAX_RECOVER_EXPANDED_LENGTH ||
    segments.length > MAX_RECOVER_SEGMENTS
  )
    return []
  const escapedSegments = segments.map(escapeRegExp)
  const secrets: string[] = []
  if (segments.length === 2) {
    const [prefix = '', suffix = ''] = segments
    if (
      expanded.length >= prefix.length + suffix.length &&
      expanded.startsWith(prefix) &&
      expanded.endsWith(suffix)
    )
      secrets.push(expanded.slice(prefix.length, expanded.length - suffix.length))
  } else if (segments.length === 3) {
    const [prefix = '', middle = '', suffix = ''] = segments
    if (expanded.startsWith(prefix) && expanded.endsWith(suffix)) {
      const inner = expanded.slice(prefix.length, expanded.length - suffix.length)
      if (middle === '') secrets.push(inner)
      else {
        const positions: number[] = []
        for (
          let idx = inner.indexOf(middle);
          idx !== -1 && positions.length <= MAX_MIDDLE_OCCURRENCES;
          idx = inner.indexOf(middle, idx + 1)
        )
          positions.push(idx)
        const chosen =
          positions.length > MAX_MIDDLE_OCCURRENCES
            ? [positions[0] ?? 0, inner.lastIndexOf(middle)]
            : positions
        for (const position of chosen)
          secrets.push(
            inner.slice(0, position),
            inner.slice(position + middle.length),
          )
      }
    }
  } else {
    for (let i = 1; i < segments.length - 1; i++)
      if (segments[i] === '') return []
    let pattern = '^'
    for (let i = 0; i < escapedSegments.length; i++) {
      pattern += escapedSegments[i]
      if (i < escapedSegments.length - 1) {
        const next = segments[i + 1] ?? ''
        if (next === '') pattern += '([\\s\\S]*)'
        else {
          const firstChar = next
            .charAt(0)
            .replace(/[.*+?^${}()|[\]-]/g, '\\$&')
          pattern += `([^${firstChar}]*)`
        }
      }
    }
    const match = expanded.match(new RegExp(`${pattern}$`))
    if (match) secrets.push(...match.slice(1).filter(secret => secret !== ''))
  }
  return [...new Set(secrets)]
}

/**
 * Binary `ezo(authored, expanded)` @32577163: collects recovered secrets from
 * the url / command+args / headers / env pairs of an authored↔expanded config
 * pair.
 */
export function collectConfigSecrets(
  authored: McpServerConfig | undefined,
  resolved: McpServerConfig,
): string[] {
  if (!authored) return []
  const secrets: string[] = []
  const collect = (template: unknown, expanded: unknown): void => {
    if (typeof template === 'string' && typeof expanded === 'string')
      secrets.push(...recoverExpandedSecrets(template, expanded))
  }
  if ('url' in authored && 'url' in resolved) collect(authored.url, resolved.url)
  if ('command' in authored && 'command' in resolved) {
    collect(authored.command, resolved.command)
    const authoredArgs = Array.isArray(authored.args) ? authored.args : []
    const resolvedArgs = Array.isArray(resolved.args) ? resolved.args : []
    for (let i = 0; i < Math.min(authoredArgs.length, resolvedArgs.length); i++)
      collect(authoredArgs[i], resolvedArgs[i])
  }
  for (const field of ['headers', 'env'] as const) {
    const authoredRecord =
      field in authored
        ? (authored as Record<string, unknown>)[field]
        : undefined
    const resolvedRecord =
      field in resolved ? (resolved as Record<string, unknown>)[field] : undefined
    if (
      authoredRecord &&
      resolvedRecord &&
      typeof authoredRecord === 'object' &&
      typeof resolvedRecord === 'object'
    )
      for (const [key, value] of Object.entries(authoredRecord))
        collect(value, (resolvedRecord as Record<string, unknown>)[key])
  }
  return secrets
}

// ---------------------------------------------------------------------------
// Template equivalence — `f`/`p`/`h`/`M`/`Uun` @23569500
// ---------------------------------------------------------------------------

/**
 * Binary `f(template, expanded)`: true when `expanded` can be produced from
 * `template` by substituting each `${VAR}` placeholder with some (possibly
 * empty) value — literal segments must appear in order without overlapping
 * the reserved suffix.
 */
export function matchesEnvVarTemplate(
  template: string,
  expanded: string,
): boolean {
  const segments = splitEnvVarSegments(template)
  if (segments.length === 1) return template === expanded
  const prefix = segments[0] ?? ''
  const suffix = segments.at(-1) ?? ''
  if (!expanded.startsWith(prefix) || !expanded.endsWith(suffix)) return false
  let cursor = prefix.length
  const limit = expanded.length - suffix.length
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i] ?? ''
    const idx = expanded.indexOf(segment, cursor)
    if (idx === -1 || idx + segment.length > limit) return false
    cursor = idx + segment.length
  }
  return cursor <= limit
}

/** Binary `p(config, field)`: record-valued field or undefined. */
function recordField(
  config: McpServerConfig,
  field: 'headers' | 'env',
): Record<string, unknown> | undefined {
  const value = (config as Record<string, unknown>)[field]
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

/** Binary `h(authoredRecord, expandedRecord)`: same keys, template-matching values. */
function recordFieldsMatch(
  authored: Record<string, unknown> | undefined,
  expanded: Record<string, unknown> | undefined,
): boolean {
  const authoredEntries = Object.entries(authored ?? {})
  const expandedRecord = expanded ?? {}
  if (authoredEntries.length !== Object.keys(expandedRecord).length) return false
  return authoredEntries.every(
    ([key, value]) =>
      typeof expandedRecord[key] === 'string' &&
      matchesEnvVarTemplate(value as string, expandedRecord[key] as string),
  )
}

/** Binary `M(url)`: parseable http/https/ws/wss URL. */
function isWebUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol } = new URL(url)
  return (
    protocol === 'http:' ||
    protocol === 'https:' ||
    protocol === 'ws:' ||
    protocol === 'wss:'
  )
}

/** Binary `ice`: `"url" in e ? e.url : null`. */
export function getServerUrl(config: McpServerConfig): string | null {
  return 'url' in config ? config.url : null
}

/**
 * Binary `K_e`: stdio command+args parts, or null for non-stdio.
 * Hardened `!('command' in config) → null` (the official indexes `.command`
 * unconditionally after the type check, relying on validated shapes).
 */
export function getStdioCommandParts(config: McpServerConfig): string[] | null {
  if (config.type !== undefined && config.type !== 'stdio') return null
  if (!('command' in config)) return null
  return [config.command, ...(config.args ?? [])]
}

/** Binary `NG`: `e.type ?? ("command" in e ? "stdio" : "unknown")`. */
export function getServerTypeLabel(config: McpServerConfig): string {
  return config.type ?? ('command' in config ? 'stdio' : 'unknown')
}

/**
 * Binary `Pst(url, maskedUrl = url)` @20411500: splits a (possibly
 * placeholder-bearing) URL into scheme / authority / rest. Delimiter positions
 * are located in the `Cat`-masked copy so placeholder contents can't shift
 * them; slices are taken from the ORIGINAL.
 */
export function splitUrlParts(
  url: string,
  maskedUrl: string = url,
): { scheme: string; authority: string; rest: string } {
  const findSplit = (from: number): number => {
    let end = url.length
    for (const delimiter of ['/', '?', '#', '\\']) {
      const idx = maskedUrl.indexOf(delimiter, from)
      if (idx !== -1 && idx < end) end = idx
    }
    return end
  }
  const schemeSeparator = maskedUrl.indexOf('://')
  const start =
    schemeSeparator !== -1 &&
    schemeSeparator < findSplit(0) &&
    /^[A-Za-z][A-Za-z0-9+.-]*$/.test(maskedUrl.slice(0, schemeSeparator))
      ? schemeSeparator + 3
      : 0
  const end = findSplit(start)
  return {
    scheme: url.slice(0, start),
    authority: url.slice(start, end),
    rest: url.slice(end),
  }
}

/** Binary `We`: `Pst(e, Cat(e)).authority.includes("${")`. */
function authorityHasEnvVarRef(url: string): boolean {
  return splitUrlParts(url, redactEnvVarPlaceholders(url)).authority.includes(
    '${',
  )
}

/**
 * Binary `Uun(authored, expanded)` @23569500: structural template-equivalence
 * between an unexpanded (authored) config and its expanded counterpart —
 * type, url (via the inner scheme/authority/rest matcher), command+args,
 * headers and env records.
 */
export function authoredMatchesExpanded(
  authored: McpServerConfig,
  expanded: McpServerConfig,
): boolean {
  if ((authored.type ?? 'stdio') !== (expanded.type ?? 'stdio')) return false
  const authoredUrl = getServerUrl(authored)
  const expandedUrl = getServerUrl(expanded)
  if (authoredUrl !== null || expandedUrl !== null) {
    // The official's inner IIFE, lifted to a named local for readability —
    // logic byte-for-byte equivalent (returns false when either side is null).
    const urlsMatchTemplate = (a: string, r: string): boolean => {
      const masked = redactEnvVarPlaceholders(a)
      const authoredParts = splitUrlParts(a, masked)
      const expandedParts = splitUrlParts(r)
      const isAllPlaceholder = (value: string): boolean =>
        splitEnvVarSegments(value).every(segment => segment === '')
      if (isAllPlaceholder(a)) return true
      if (authoredParts.scheme === '' && isAllPlaceholder(authoredParts.authority))
        return matchesEnvVarTemplate(a, r)
      const maskedAt = splitUrlParts(masked).authority.lastIndexOf('@')
      const expandedAt = expandedParts.authority.lastIndexOf('@')
      if ((maskedAt === -1) !== (expandedAt === -1)) return false
      if (authoredParts.scheme === '')
        return (
          expandedParts.scheme === '' &&
          !isWebUrl(r) &&
          matchesEnvVarTemplate(a, r)
        )
      if (expandedParts.scheme === '') return false
      return (
        matchesEnvVarTemplate(
          authoredParts.scheme.toLowerCase(),
          expandedParts.scheme.toLowerCase(),
        ) &&
        (maskedAt === -1 ||
          matchesEnvVarTemplate(
            authoredParts.authority.slice(0, maskedAt),
            expandedParts.authority.slice(0, expandedAt),
          )) &&
        matchesEnvVarTemplate(
          authoredParts.authority.slice(maskedAt + 1),
          expandedParts.authority.slice(expandedAt + 1),
        ) &&
        matchesEnvVarTemplate(authoredParts.rest, expandedParts.rest)
      )
    }
    if (authoredUrl === null || expandedUrl === null) return false
    if (!urlsMatchTemplate(authoredUrl, expandedUrl)) return false
  }
  const authoredCommand = getStdioCommandParts(authored)
  const expandedCommand = getStdioCommandParts(expanded)
  if (authoredCommand !== null || expandedCommand !== null) {
    if (
      authoredCommand === null ||
      expandedCommand === null ||
      authoredCommand.length !== expandedCommand.length ||
      !authoredCommand.every((part, i) =>
        matchesEnvVarTemplate(part, expandedCommand[i] ?? ''),
      )
    )
      return false
  }
  return (
    recordFieldsMatch(
      recordField(authored, 'headers'),
      recordField(expanded, 'headers'),
    ) &&
    recordFieldsMatch(recordField(authored, 'env'), recordField(expanded, 'env'))
  )
}

// ---------------------------------------------------------------------------
// Endpoint display — `l0t`/`oe`/`ie` @20411500
// ---------------------------------------------------------------------------

/** Binary `oe`: URL origin, undefined for unparseable/opaque ("null") origins. */
export function getUrlOrigin(url: string): string | undefined {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * Binary `ie` @20411500: strips the userinfo (where `${USER}:${PW}@` secrets
 * live) from a placeholder-bearing URL, keeping scheme + post-`@` authority;
 * an `@` OUTSIDE the authority yields `[unparseable-authority]`.
 */
export function maskUrlUserinfo(url: string): string | undefined {
  const masked = redactEnvVarPlaceholders(url)
  const { scheme, authority } = splitUrlParts(masked)
  const schemeLength = scheme.length
  const authorityEnd = schemeLength + authority.length
  if (masked.includes('@', authorityEnd))
    return `${normalizeEnvVarRefs(url.slice(0, schemeLength))}[unparseable-authority]`
  const at = authority.lastIndexOf('@')
  const userinfo = url.slice(at === -1 ? schemeLength : schemeLength + at + 1, authorityEnd)
  if (userinfo === '') return undefined
  return normalizeEnvVarRefs(url.slice(0, schemeLength) + userinfo)
}

/**
 * Binary `l0t({authoredUnexpanded, expanded, cliOwned, detail})` @20411500.
 * Authored present → normalized authored url (`detail: 'endpoint'`), origin or
 * userinfo-masked url (`detail: 'origin'`), normalized `command args` join, or
 * the type label. Authored absent → origin of the expanded url, else type
 * label for `detail: 'endpoint'`.
 *
 * Divergence: the `cliOwned && sC(u) → k$n(u)` bearer-masking branch is not
 * ported (no cliOwned registry in OCC) — callers pass `cliOwned: false`.
 */
export function getEndpointForDisplay(params: {
  authoredUnexpanded: McpServerConfig | undefined
  expanded: McpServerConfig
  cliOwned: boolean
  detail?: 'origin' | 'endpoint'
}): string | undefined {
  const { authoredUnexpanded: authored, expanded } = params
  const detail = params.detail ?? 'endpoint'
  if (authored) {
    const url = getServerUrl(authored)
    if (url) {
      if (detail === 'endpoint') return normalizeEnvVarRefs(url)
      if (authorityHasEnvVarRef(url)) return maskUrlUserinfo(url)
      return getUrlOrigin(url) ?? maskUrlUserinfo(url)
    }
    const commandParts = getStdioCommandParts(authored)
    if (commandParts)
      return detail === 'endpoint'
        ? normalizeEnvVarRefs(commandParts.join(' '))
        : undefined
    return detail === 'endpoint' ? getServerTypeLabel(authored) : undefined
  }
  const expandedUrl = getServerUrl(expanded)
  if (expandedUrl) {
    const origin = getUrlOrigin(expandedUrl)
    if (origin !== undefined) return origin
  }
  return detail === 'endpoint' ? getServerTypeLabel(expanded) : undefined
}

// ---------------------------------------------------------------------------
// Display sanitizers — `dt`/`Pe`/`Be` @32803400
// ---------------------------------------------------------------------------

/**
 * Binary `dt` @32803400: deep `vte` normalization — every string in a value
 * has `${VAR:-default}` collapsed to `${VAR}`; structure is rebuilt (never
 * mutated). `Ns` (object map) is `Object.fromEntries`.
 */
export function deepNormalizeEnvVarRefs<T>(value: T): T {
  const walk = (current: unknown): unknown =>
    typeof current === 'string'
      ? normalizeEnvVarRefs(current)
      : Array.isArray(current)
        ? current.map(walk)
        : current && typeof current === 'object'
          ? Object.fromEntries(
              Object.entries(current as Record<string, unknown>).map(
                ([key, child]) => [key, walk(child)],
              ),
            )
          : current
  return walk(value) as T
}

/**
 * Binary `Pe` @32803400: field-level display fallback when no authored
 * unexpanded copy matches — url/command degrade to the type label, header/env
 * values to `[REDACTED]`, args to `[]`.
 *
 * Divergence: the official pre-passes through the `h$` secret scanner; OCC has
 * no `h$` — the raw config is used as the pre-scan result.
 */
export function sanitizeConfigForDisplay<T extends McpServerConfig>(
  config: T,
): T {
  const typeLabel = getServerTypeLabel(config)
  if ('url' in config) {
    return {
      ...config,
      url: typeLabel,
      ...('headers' in config &&
        config.headers && {
          headers: Object.fromEntries(
            Object.keys(config.headers).map(key => [key, '[REDACTED]']),
          ),
        }),
    }
  }
  if ('command' in config) {
    return {
      ...config,
      command: typeLabel,
      ...('args' in config && config.args && { args: [] }),
      ...('env' in config &&
        config.env && {
          env: Object.fromEntries(
            Object.keys(config.env).map(key => [key, '[REDACTED]']),
          ),
        }),
    }
  }
  return config
}

/**
 * Binary `m` @23569500: the config's scope when it is a known ConfigScope
 * (`OD.find((n)=>n===e)` — `OD` inferred as the ConfigScope enum list, cf.
 * `GUn` @29940100), else undefined.
 */
function getKnownScope(
  config: McpServerConfig,
): ConfigScope | undefined {
  if (!('scope' in config)) return undefined
  const scope = (config as ScopedMcpServerConfig).scope
  return ConfigScopeSchema().options.find(known => known === scope)
}

/**
 * Binary `Be` @32803400: builds the DISPLAY copy of a server map — per-scope
 * unexpanded re-parse (injected resolver, memoized per scope), `dt(authored)`
 * when the authored copy template-matches the expanded one, `Pe(expanded)`
 * otherwise.
 *
 * Divergences: claudeai passthrough (see header, #6); no managed-scope
 * `V6` masking (OCC never produces managed servers, see header, #4);
 * unknown-scope servers pass through unchanged (`h$` absent).
 */
export function getDisplayServers(
  servers: Record<string, ScopedMcpServerConfig>,
  resolveUnexpanded: UnexpandedScopeResolver,
): Record<string, ScopedMcpServerConfig> {
  const resolverCache = new Map<
    ConfigScope,
    Record<string, ScopedMcpServerConfig> | undefined
  >()
  const display: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    const scope = getKnownScope(config)
    if (scope === undefined) {
      display[name] = config
      continue
    }
    if (scope === 'claudeai') {
      display[name] = deepNormalizeEnvVarRefs(config)
      continue
    }
    if (!resolverCache.has(scope))
      resolverCache.set(scope, resolveUnexpanded(scope))
    const authored = resolverCache.get(scope)?.[name]
    display[name] =
      authored && authoredMatchesExpanded(authored, config)
        ? deepNormalizeEnvVarRefs(authored)
        : sanitizeConfigForDisplay(config)
  }
  return display
}

/**
 * Single-server display copy — the official `Wr` (mcpGetHandler) line
 * `h = Be({[s]:i})[s] ?? Pe(i)` @32803400.
 */
export function getDisplayConfig(
  name: string,
  config: ScopedMcpServerConfig,
  resolveUnexpanded: UnexpandedScopeResolver,
): ScopedMcpServerConfig {
  return (
    getDisplayServers({ [name]: config }, resolveUnexpanded)[name] ??
    sanitizeConfigForDisplay(config)
  )
}

// ---------------------------------------------------------------------------
// Authored lookup — `S` @23569500 (resolver-injected) + dynamic registry
// ---------------------------------------------------------------------------

/**
 * Registry of AUTHORED (unexpanded) dynamic-scope configs — the OCC
 * equivalent of the official's `fu('dynamic', {expandVars:!1})` re-parse,
 * which OCC cannot perform (dynamic servers come from `--mcp-config` JSON /
 * plugin manifests with no re-parseable on-disk form at display time).
 * Registered at parse time; see module header divergence #5.
 */
const authoredUnexpandedRegistry = new Map<string, ScopedMcpServerConfig>()

export function registerAuthoredUnexpandedConfig(
  name: string,
  config: ScopedMcpServerConfig,
): void {
  authoredUnexpandedRegistry.set(name, config)
}

export function getAuthoredUnexpandedRegistry(): ReadonlyMap<
  string,
  ScopedMcpServerConfig
> {
  return authoredUnexpandedRegistry
}

export function clearAuthoredUnexpandedRegistry(): void {
  authoredUnexpandedRegistry.clear()
}

/**
 * Binary `S(name, config)` @23569500: the scope's unexpanded server when it
 * template-matches the expanded config, else undefined (try/catch swallowed —
 * a broken config file must not break display).
 */
export function getAuthoredUnexpanded(
  name: string,
  config: McpServerConfig,
  resolveUnexpanded: UnexpandedScopeResolver,
): ScopedMcpServerConfig | undefined {
  const scope = getKnownScope(config)
  if (scope === undefined) return undefined
  try {
    const authored = resolveUnexpanded(scope)?.[name]
    return authored && authoredMatchesExpanded(authored, config)
      ? authored
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Binary `bV(name, config, options)` @23569500: the displayable endpoint for
 * error messages. Known scope with no authored match → undefined for
 * `detail: 'origin'`, the bare type label otherwise (never the expanded URL);
 * everything else routes through `l0t`.
 *
 * Divergence: `mw(config)` cliOwned check not ported — always false (#3).
 */
export function getMcpErrorEndpoint(
  name: string,
  config: ScopedMcpServerConfig,
  options: { detail?: 'origin' | 'endpoint' } | undefined,
  resolveUnexpanded: UnexpandedScopeResolver,
): string | undefined {
  const authored = getAuthoredUnexpanded(name, config, resolveUnexpanded)
  if (authored === undefined && getKnownScope(config) !== undefined)
    return options?.detail === 'origin'
      ? undefined
      : getServerTypeLabel(config)
  return getEndpointForDisplay({
    authoredUnexpanded: authored,
    expanded: config,
    cliOwned: false,
    detail: options?.detail,
  })
}

// ---------------------------------------------------------------------------
// Error-detail redaction — `XGo` @32575xxx + `tQn` @30735025 + `wp` @23569500
// ---------------------------------------------------------------------------

/** Binary `KGo` — exact label-like secret names. */
const LABEL_EXACT_PATTERN =
  /^(?:bearer|basic|(?:access|refresh|id|client|api|x[-_]api|session|auth)?[-_ ]?(?:token|key|secret|password|authorization|credential)s?)$/i

/** Binary `YGo` — suffix-style label detection (`-token`, ` key`, …). */
const LABEL_SUFFIX_PATTERN =
  /(?:^|[^A-Za-z0-9_\s])(?:bearer|basic|token|key|secret|password|authorization|credential)s?$/i

/**
 * Binary `XGo` @32575xxx: true when a candidate "secret" is really a
 * label-like string (`token`, `X-Api-Key: `, `-H Authorization`…) that must
 * NOT be blanket-replaced with `[redacted]`.
 */
export function isLabelLikeSecret(candidate: string): boolean {
  const parts = candidate
    .split(/[:=\uFF1A\uFF1D]+/)
    .map(part => part.trim())
  let matched = 0
  for (const [index, part] of parts.entries()) {
    if (part === '') continue
    const isNonFinalOrFlag = index < parts.length - 1 || part.startsWith('-')
    if (
      !LABEL_EXACT_PATTERN.test(part) &&
      !(isNonFinalOrFlag && LABEL_SUFFIX_PATTERN.test(part))
    )
      return false
    matched++
  }
  return matched > 0
}

/**
 * Binary `tQn(errorText, expandedConfig, endpoint, authoredConfig)` @30735025
 * — PLAIN SUBSTRING port (see module header divergence #1: the NFKC /
 * percent-decode / invisible-char normalizer `D` is the identity here and the
 * 2512-char truncation is not applied).
 *
 * Registers every recoverable secret + config field (with `+`/space/word
 * variants and full URL decomposition) and replaces occurrences in the error
 * text — longest-first, word-boundary-anchored for bare word-like commands,
 * overlap-merged — with `[redacted]` or the field's display endpoint.
 */
export function redactMcpErrorText(
  errorText: string,
  expanded: McpServerConfig,
  endpoint: string | undefined,
  authored: McpServerConfig | undefined,
): string {
  const endpointDisplay = endpoint ?? MCP_ENDPOINT_PLACEHOLDER
  const registrations: Array<
    [secret: string, replacement: string, wordBoundary: boolean]
  > = []

  // Binary `be` — ≥4-char guard; skip when the replacement already contains
  // the secret (D() normalization staged → identity).
  const registerSecret = (
    secret: string | undefined,
    replacement: string,
    options?: { wordBoundary?: boolean },
  ): void => {
    if (secret === undefined) return
    if (secret.length < 4) return
    if (replacement !== '[redacted]' && replacement.includes(secret)) return
    registrations.push([secret, replacement, options?.wordBoundary === true])
  }

  // Binary `Te` — skip secrets contained in the endpoint or label-like ones.
  const registerRedacted = (
    secret: string | undefined,
    replacement: string = endpointDisplay,
  ): void => {
    if (secret === undefined) return
    if (replacement.includes(secret) || isLabelLikeSecret(secret.trim())) return
    registerSecret(secret, '[redacted]')
  }

  // Binary `xe` — also register `+`↔space and per-word variants.
  const registerWithVariants = (
    secret: string | undefined,
    replacement: string = endpointDisplay,
  ): void => {
    if (!secret) return
    registerRedacted(secret, replacement)
    if (secret.includes('+'))
      registerRedacted(secret.replaceAll('+', ' '), replacement)
    if (secret.includes(' '))
      registerRedacted(secret.replaceAll(' ', '+'), replacement)
    for (const variant of [secret, secret.replaceAll('+', ' ')]) {
      const words = variant.split(/\s+/)
      if (words.length > 1)
        for (const word of words) registerRedacted(word, replacement)
    }
  }

  // Binary `Pe` (tQn-local) — full URL decomposition registration.
  const registerUrl = (
    url: string | undefined,
    replacement: string,
  ): void => {
    if (url === undefined) return
    registerSecret(url, replacement)
    try {
      const parsed = new URL(url)
      registerSecret(parsed.href, replacement)
      if (parsed.origin !== 'null') registerSecret(parsed.origin, replacement)
      registerSecret(parsed.host, replacement)
      registerSecret(parsed.hostname, replacement)
      const bareHostname = parsed.hostname.replace(/^\[|\]$/g, '')
      if (bareHostname !== parsed.hostname)
        registerSecret(bareHostname, replacement)
      registerWithVariants(parsed.username, replacement)
      registerWithVariants(parsed.password, replacement)
      registerRedacted(
        parsed.pathname !== '/' ? parsed.pathname : undefined,
        replacement,
      )
      for (const segment of parsed.pathname.split('/'))
        registerWithVariants(segment, replacement)
      registerRedacted(parsed.search, replacement)
      for (const [key, value] of parsed.searchParams.entries()) {
        registerWithVariants(key, replacement)
        registerWithVariants(value, replacement)
      }
      for (const pair of parsed.search.replace(/^\?/, '').split('&')) {
        const eq = pair.indexOf('=')
        if (eq === -1) registerWithVariants(pair, replacement)
        else {
          registerWithVariants(pair.slice(0, eq), replacement)
          registerWithVariants(pair.slice(eq + 1), replacement)
        }
      }
    } catch {
      // not a URL — only the raw string was registered
    }
  }

  // Config walk (n = expanded, o = authored, d = endpoint).
  for (const secret of collectConfigSecrets(authored, expanded))
    registerWithVariants(secret)
  if ('url' in expanded && typeof expanded.url === 'string')
    registerUrl(expanded.url, endpointDisplay)
  if (
    'oauth' in expanded &&
    typeof expanded.oauth?.authServerMetadataUrl === 'string'
  ) {
    const metadataUrl = expanded.oauth.authServerMetadataUrl
    let replacement = '[redacted]'
    try {
      const origin = new URL(metadataUrl).origin
      if (origin !== 'null') replacement = origin
    } catch {
      // keep '[redacted]'
    }
    registerUrl(metadataUrl, replacement)
  }
  if ('command' in expanded && typeof expanded.command === 'string') {
    const authoredCommand =
      authored && 'command' in authored && typeof authored.command === 'string'
        ? normalizeEnvVarRefs(authored.command)
        : undefined
    registerSecret(expanded.command, authoredCommand ?? endpointDisplay, {
      wordBoundary: true,
    })
    if (Array.isArray(expanded.args))
      for (const arg of expanded.args) registerWithVariants(arg)
  }
  if ('headers' in expanded && expanded.headers)
    for (const value of Object.values(expanded.headers))
      registerWithVariants(value)
  if ('env' in expanded && expanded.env)
    for (const value of Object.values(expanded.env))
      registerWithVariants(value)
  if ('authToken' in expanded && typeof expanded.authToken === 'string')
    registerWithVariants(expanded.authToken)

  if (registrations.length === 0) return errorText

  registrations.sort((a, b) => b[0].length - a[0].length)

  // Binary dedupe Map: prefer a non-`[redacted]` replacement for the same secret.
  const deduped = new Map<
    string,
    { replacement: string; wordBoundary: boolean }
  >()
  for (const [secret, replacement, wordBoundary] of registrations) {
    const existing = deduped.get(secret)
    if (!existing) deduped.set(secret, { replacement, wordBoundary })
    else if (existing.replacement === '[redacted]' && replacement !== '[redacted]')
      deduped.set(secret, {
        replacement,
        wordBoundary: existing.wordBoundary && wordBoundary,
      })
  }

  const spans: Array<{ start: number; end: number; replacement: string }> = []
  for (const [secret, entry] of deduped) {
    const escaped = escapeRegExp(secret)
    const pattern =
      entry.wordBoundary && /^[\w-]+$/.test(secret)
        ? `(?<![\\w:.-])${escaped}(?![\\w:.-])`
        : escaped
    const regex = new RegExp(pattern, 'gi')
    for (
      let match = regex.exec(errorText);
      match !== null;
      match = regex.exec(errorText)
    ) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: entry.replacement,
      })
      regex.lastIndex = match.index + 1
    }
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number; replacement: string }> = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }

  let result = ''
  let cursor = 0
  for (const span of merged) {
    result += errorText.slice(cursor, span.start) + span.replacement
    cursor = span.end
  }
  result += errorText.slice(cursor)
  return result
}

/**
 * Binary `wp(name, config, errorText)` @23569500: redact an MCP error detail,
 * falling back to `"[mcp error detail unavailable: redaction failed]"` when
 * redaction itself throws — the ONLY site the official wraps this way.
 */
export function redactMcpErrorDetail(
  name: string,
  config: ScopedMcpServerConfig,
  errorText: string,
  resolveUnexpanded: UnexpandedScopeResolver,
): string {
  try {
    return redactMcpErrorText(
      errorText,
      config,
      getMcpErrorEndpoint(name, config, { detail: 'origin' }, resolveUnexpanded) ??
        getServerTypeLabel(config),
      getAuthoredUnexpanded(name, config, resolveUnexpanded),
    )
  } catch {
    return MCP_ERROR_REDACTION_FAILED
  }
}
