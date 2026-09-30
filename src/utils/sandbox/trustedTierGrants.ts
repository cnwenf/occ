/**
 * CC 2.1.285 security fix — "Fixed the sandbox letting project/local settings
 * re-open filesystem read paths or widen the network allowlist that a trusted
 * (managed / --settings / user) tier had denied, and letting project/local
 * `sandbox.filesystem.allowWrite` / `Edit` allow-rules grant write access at all
 * while an admin sandbox mandate is active."
 *
 * Byte-faithful port of the official 2.1.285 linux-x64 ELF sandbox module
 * (JS region ~200.58M–200.68M). The whole subsystem is NEW in 2.1.285 —
 * v2.1.284 has zero hits for `grants restricted to trusted`,
 * `droppedRepoFilesystemGrantsLogged`, or `droppedRepoAllowedDomainsLogged`.
 *
 * Official symbol → this module:
 *   Ua()  → shouldRestrictExcludedCommands()  [existing, reused]  (mandate `_`)
 *   zm()  → shouldEnforceStrictAllowlist()    [existing, reused]  (`T`)
 *   nte() → shouldAllowManagedSandboxDomainsOnly() [existing]      (`b`)
 *   FB()  → hasTrustedReadDenyList()                             (`N` gate leg)
 *   MB()  → getTrustedReadDenyBaseline()                         (`D` when N)
 *   nS()  → getClaudeOwnReadDenyBaseline()                       (`D` when !N)
 *   Gm()  → candidateUnderDeniedRead()
 *   GB()  → anyVariantUnderDenied()
 *   S5e() → matchDenyToCandidate()
 *   jat() → globAncestorMatch()
 *   VE()  → matchGlobCached()
 *   Go()  → pathUnderOrEqual()
 *   $Le() → literalUnderOrEqual()
 *   jee() → segmentEqualFold()
 *   Mo()  → foldCase()
 *   Tu()  → isGlobPattern()
 *   Wm()  → globBase()
 *   Vo()  → resolveDenyPath()
 *   VB()  → realpathVariants()
 *   rte() → realpathExistingPrefix()
 *   bB()  → realpathWithFallback()
 *   Am()  → getTrustedSettingsSources()
 *   Uf()/OO() → getTrustedAllowedDomains()/getTrustedWebFetchAllowRules()
 *   _r→dirname, Cc→basename, Bn→realpathSync, Qe/$r→join, U→uniq, Hm→isUntrustedSource
 *
 * The network-restriction gate `A = _ || T` and the allowance gate `ate()`
 * are composed inline in sandbox-adapter.ts (where `Ua`/`zm` live) to avoid
 * an import cycle — see `restrictNetworkAllowlist` in
 * convertToSandboxRuntimeConfig and `computeTrustedNetworkAllowances` there.
 *
 * NOT ported (no OCC surface — documented, not guessed):
 *   - `sandbox.credentials.files` mask/deny paths in MB()/FB(): OCC has no
 *     credentials.files setting, so that leg contributes nothing.
 *   - HKCU-backfilled-policy untrusted case (`X==='policySettings' && !KUe()`):
 *     OCC composes all managed tiers into a single trusted `policySettings`
 *     source that is null when not composed, so OCC policySettings is always
 *     trusted — the backfill-untrusted branch never fires.
 *   - `CLAUDE_CODE_EVAL_CONFINED` (`h`) eval-confined branches in `jm`: OCC does
 *     not ship that confinement mode, so the `g(X)` additionalDirectories gate
 *     and the eval-confined allowedDomains branches are skipped.
 *   - `r.sessionAllowedHosts` runtime add to allowedDomains: OCC's sandbox
 *     runtime tracks ask-callback approvals internally; the adapter has no
 *     equivalent runtime-state field.
 *   - `rte`'s `BR()` boundary guard: walking to the filesystem root is safe
 *     (realpathSync only resolves existing prefixes), so the guard is dropped.
 */
import { realpathSync } from 'fs'
import { basename, dirname, join, normalize } from 'path'
import picomatch from 'picomatch'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { getGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { expandPath } from '../path.js'
import { getPlatform } from '../platform.js'
import {
  isSettingSourceEnabled,
  SETTING_SOURCES,
  type SettingSource,
} from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

// Local copy to avoid a circular dependency (mirrors sandbox-adapter.ts).
function permissionRuleValueFromString(ruleString: string): {
  toolName: string
  ruleContent?: string
} {
  const matches = ruleString.match(/^([^(]+)\(([^)]+)\)$/)
  if (!matches) return { toolName: ruleString }
  const toolName = matches[1]
  const ruleContent = matches[2]
  if (!toolName || !ruleContent) return { toolName: ruleString }
  return { toolName, ruleContent }
}

function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

/** Official `Tu` — does the path contain glob metacharacters? */
export function isGlobPattern(p: string): boolean {
  return p.includes('*') || p.includes('?') || p.includes('[') || p.includes(']')
}

/**
 * Official `Mo` — Unicode case fold used for case-insensitive segment compare.
 * The pre-fold strip set is `Hjr` = new RegExp(CUt,'g') where the binary's
 * `CUt` (@196740394) is the zero-width-joiner / bidi-control / BOM class
 * `[U+200C-U+200F U+202A-U+202E U+206A-U+206F U+FEFF]`. Built from escapes so
 * the invisible code points are never embedded literally in this source file.
 */
const ZERO_WIDTH_BIDI_RE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g
export function foldCase(s: string): string {
  return s
    .replace(ZERO_WIDTH_BIDI_RE, '')
    .normalize('NFD')
    .toLowerCase()
    .toUpperCase()
    .normalize('NFC')
}

/** Official `jee` — case-insensitive single-segment equality. */
function segmentEqualFold(a: string, b: string): boolean {
  return a === b || foldCase(a) === foldCase(b)
}

/**
 * Official `Go(parent, child, nocase=true)` — is `child` under-or-equal to
 * `parent`, compared segment-by-segment? Inputs must already be `/`-normalized
 * (S5e does the Windows `\`→`/` rewrite before calling).
 */
export function pathUnderOrEqual(
  parent: string,
  child: string,
  nocase = true,
): boolean {
  const parentSegs = parent.split('/').filter(Boolean)
  const childSegs = child.split('/').filter(Boolean)
  return (
    parentSegs.length <= childSegs.length &&
    parentSegs.every((seg, i) =>
      nocase
        ? segmentEqualFold(seg, childSegs[i] as string)
        : seg === childSegs[i],
    )
  )
}

/** Official `$Le(parent, child)` — literal (non-glob) under-or-equal prefix. */
export function literalUnderOrEqual(parent: string, child: string): boolean {
  return (
    child === parent ||
    (parent === '/' ? child.startsWith('/') : child.startsWith(`${parent}/`))
  )
}

type GlobMatcher = (s: string) => boolean
type GlobCache = Map<string, GlobMatcher>

/** Official `VE(path, pattern, cache, nocase)` — cached picomatch({dot,nocase}). */
export function matchGlobCached(
  path: string,
  pattern: string,
  cache: GlobCache | undefined,
  nocase = false,
): boolean {
  const key = nocase ? `${pattern}\x00nocase` : pattern
  let matcher = cache?.get(key)
  if (!matcher) {
    try {
      matcher = picomatch(pattern, { dot: true, nocase })
    } catch {
      matcher = () => false
    }
    cache?.set(key, matcher)
  }
  return matcher(path)
}

/**
 * Official `Wm` — the non-glob prefix (base directory) of a glob pattern.
 * Windows: dirname of the base with trailing separators pinned. POSIX: strip
 * trailing slashes, else dirname.
 */
export function globBase(p: string): string {
  const base = p.split(/[*?[\]]/)[0] ?? ''
  if (getPlatform() === 'windows') {
    return dirname(base.replace(/[/\\]+$/, '\\_'))
  }
  return base.endsWith('/') ? base.replace(/\/+$/, '') || '/' : dirname(base)
}

/**
 * Official `jat(pattern, path, cache, nocase)` — non-glob pattern falls back to
 * the literal prefix test; a glob pattern matches if `path` OR any of its
 * ancestor directories matches the glob.
 */
export function globAncestorMatch(
  pattern: string,
  path: string,
  cache: GlobCache | undefined,
  nocase = false,
): boolean {
  if (!isGlobPattern(pattern)) return literalUnderOrEqual(pattern, path)
  let cur = path
  for (;;) {
    if (matchGlobCached(cur, pattern, cache, nocase)) return true
    const parent = dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
}

/**
 * Official `S5e(deny, candidate, cache)` — does `candidate` fall under the
 * `deny` path/pattern? Windows normalizes `\`→`/` first. Non-glob deny uses
 * the segment prefix test; glob deny tries a case-insensitive ancestor match
 * then a case-folded ancestor match.
 */
export function matchDenyToCandidate(
  deny: string,
  candidate: string,
  cache: GlobCache,
): boolean {
  const isWindows = getPlatform() === 'windows'
  const d = isWindows ? deny.replaceAll('\\', '/') : deny
  const c = isWindows ? candidate.replaceAll('\\', '/') : candidate
  if (!isGlobPattern(d)) return pathUnderOrEqual(d, c)
  return (
    globAncestorMatch(d, c, cache, true) ||
    globAncestorMatch(foldCase(d), foldCase(c), cache)
  )
}

/** Official `GB(denyBaseline, candidateVariants)`. */
function anyVariantUnderDenied(
  denyBaseline: string[],
  candidateVariants: string[],
  cache: GlobCache,
): boolean {
  return denyBaseline.some((deny) =>
    candidateVariants.some((v) => matchDenyToCandidate(deny, v, cache)),
  )
}

/**
 * Official `rte` — realpath the longest existing ancestor of `p`, then rejoin
 * the literal (non-existent) tail. The `BR()` boundary guard is dropped (see
 * module header): walking to the root is safe because realpathSync only
 * resolves paths that actually exist.
 */
export function realpathExistingPrefix(p: string): string {
  const popped: string[] = []
  let cur = p
  for (;;) {
    try {
      cur = realpathSync(cur)
      break
    } catch {
      const parent = dirname(cur)
      if (parent === cur) break
      popped.push(basename(cur))
      cur = parent
    }
  }
  return popped.length === 0 ? cur : join(cur, ...popped.reverse())
}

/** Official `bB` — realpath with a one-level-up fallback, else the input. */
export function realpathWithFallback(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p))
    } catch {
      return p
    }
  }
}

/** Official `VB` — [path, realpath-variant-of-its-glob-base-or-self]. */
export function realpathVariants(p: string): string[] {
  const base = isGlobPattern(p) ? globBase(p) : p
  return p.startsWith(base)
    ? [p, realpathExistingPrefix(base) + p.slice(base.length)]
    : [p]
}

/**
 * Official `Vo` — resolve a spelling against cwd and normalize (Windows strips
 * a trailing star-star). OCC adaptation: `expandPath` runs first so `~` and
 * bare relative spellings from permission rules become absolute before
 * comparison (the official `Vo` assumes its input was already expanded by
 * `Wat`/`Ple`).
 */
export function resolveDenyPath(p: string, cwd: string): string | undefined {
  try {
    const expanded = expandPath(p, cwd)
    return getPlatform() === 'windows'
      ? expanded.replace(/(?:[/\\]\*\*)+$/, '')
      : normalize(expanded)
  } catch {
    return undefined
  }
}

/**
 * Official `Gm(denyBaseline, candidate, cache)` — is `candidate` (or its
 * realpath variant, or — when it is a glob — its glob base or that base's
 * realpath variant) under-or-equal to any entry of the deny baseline? Empty
 * baseline or an unresolvable candidate is never "under".
 */
export function candidateUnderDeniedRead(
  denyBaseline: string[],
  candidate: string,
  cwd: string,
  cache: GlobCache,
): boolean {
  const resolved = resolveDenyPath(candidate, cwd)
  if (resolved === undefined || denyBaseline.length === 0) return false
  if (isGlobPattern(resolved)) {
    const base = globBase(resolved)
    const variants = uniq([base, realpathExistingPrefix(base)])
    return denyBaseline.some((deny) => {
      const denyNorm = isGlobPattern(deny) ? globBase(deny) : deny
      return variants.some(
        (v) =>
          matchDenyToCandidate(denyNorm, v, cache) ||
          matchDenyToCandidate(v, denyNorm, cache),
      )
    })
  }
  return anyVariantUnderDenied(
    denyBaseline,
    uniq([resolved, realpathExistingPrefix(resolved)]),
    cache,
  )
}

/** Official `Hm` — project/local settings are the untrusted sources. */
export function isUntrustedSource(source: SettingSource): boolean {
  return source === 'projectSettings' || source === 'localSettings'
}

/**
 * Official `Am()` — the trusted settings tiers, in priority order:
 * composed managed policy (null when absent), `--settings` flag, and user
 * settings when that source is enabled.
 */
export function getTrustedSettingsSources(): (SettingsJson | null)[] {
  return [
    getSettingsForSource('policySettings'),
    getSettingsForSource('flagSettings'),
    isSettingSourceEnabled('userSettings')
      ? getSettingsForSource('userSettings')
      : null,
  ]
}

/**
 * Official `FB()` — does a trusted (managed policy or `--settings`) tier carry
 * a filesystem read-deny list? (The `sandbox.credentials.files` leg is omitted
 * — OCC has no such setting.)
 */
export function hasTrustedReadDenyList(): boolean {
  return [
    getSettingsForSource('policySettings'),
    getSettingsForSource('flagSettings'),
  ].some(
    (s) =>
      (s?.sandbox?.filesystem?.denyRead?.length ?? 0) > 0 ||
      (s?.permissions?.deny ?? []).some((rule) => {
        const parsed = permissionRuleValueFromString(rule)
        return (
          parsed.toolName === FILE_READ_TOOL_NAME &&
          parsed.ruleContent !== undefined
        )
      }),
  )
}

/**
 * Official `ate()` network-deny leg — does a trusted (managed policy or
 * `--settings`) tier carry a network deny list (`sandbox.network.deniedDomains`
 * or a WebFetch `domain:` deny rule)? Combined with the mandate/strictAllowlist
 * gate this forms `ate()`, which decides whether the network ALLOWANCES
 * (proxy ports / unix sockets / local binding — see `dB`) are restricted to the
 * trusted tiers so a project may not replace the filtering proxy.
 */
export function hasTrustedNetworkDenyList(): boolean {
  return [
    getSettingsForSource('policySettings'),
    getSettingsForSource('flagSettings'),
  ].some(
    (s) =>
      (s?.sandbox?.network?.deniedDomains?.length ?? 0) > 0 ||
      (s?.permissions?.deny ?? []).some((rule) => {
        const parsed = permissionRuleValueFromString(rule)
        return (
          parsed.toolName === WEB_FETCH_TOOL_NAME &&
          parsed.ruleContent?.startsWith('domain:') === true
        )
      }),
  )
}

/**
 * Official `nS()` — Claude Code's OWN read-deny baseline: the config dir
 * (`~/.claude`), the global config file (`~/.claude.json`), and the IDE lock
 * dir (`~/.claude/ide`), each with its realpath variant. The official `ein()`
 * adds CLAUDE_CONFIG_DIR/WSL IDE-lock variants; OCC's `getClaudeConfigHomeDir`
 * already honors CLAUDE_CONFIG_DIR, and the WSL USERPROFILE lock is not ported.
 */
export function getClaudeOwnReadDenyBaseline(cwd: string): string[] {
  const configDir = getClaudeConfigHomeDir()
  const raw = [configDir, getGlobalClaudeFile(), join(configDir, 'ide')]
  return uniq(
    raw
      .flatMap((p) => [p, realpathWithFallback(p)])
      .map((p) => resolveDenyPath(p, cwd))
      .filter((p): p is string => p !== undefined),
  )
}

/**
 * Official `MB()` — the full trusted read-deny baseline: Claude Code's own
 * baseline (`nS()`) plus every Read deny-rule and `sandbox.filesystem.denyRead`
 * entry from the trusted sources (project/local skipped, disabled sources
 * skipped), each resolved and expanded to its realpath variant.
 *
 * `resolveReadDenyRule` / `resolveFilesystemPath` are injected by the caller
 * (sandbox-adapter) so the exact OCC permission-rule and sandbox.filesystem
 * resolvers are reused — keeping the baseline consistent with the candidates.
 */
export function getTrustedReadDenyBaseline(
  cwd: string,
  resolvers: {
    resolveReadDenyRule: (ruleContent: string, source: SettingSource) => string
    resolveFilesystemPath: (p: string, source: SettingSource) => string
  },
): string[] {
  const collected: string[] = []
  for (const source of SETTING_SOURCES) {
    if (isUntrustedSource(source)) continue
    const s = getSettingsForSource(source)
    // (credentials.files paths omitted — no OCC surface.)
    if (!isSettingSourceEnabled(source)) continue
    for (const rule of s?.permissions?.deny ?? []) {
      const parsed = permissionRuleValueFromString(rule)
      if (parsed.toolName === FILE_READ_TOOL_NAME && parsed.ruleContent) {
        collected.push(
          resolvers.resolveReadDenyRule(parsed.ruleContent, source),
        )
      }
    }
    for (const p of s?.sandbox?.filesystem?.denyRead ?? []) {
      collected.push(resolvers.resolveFilesystemPath(p, source))
    }
  }
  const resolved = collected
    .map((p) => resolveDenyPath(p, cwd))
    .filter((p): p is string => p !== undefined)
    .flatMap(realpathVariants)
  return uniq([...getClaudeOwnReadDenyBaseline(cwd), ...resolved])
}

/**
 * Official `Uf((ne)=>ne.network?.allowedDomains)` — allowedDomains collected
 * from the trusted tiers only (deduped).
 */
export function getTrustedAllowedDomains(): string[] {
  return uniq(
    getTrustedSettingsSources().flatMap(
      (s) => s?.sandbox?.network?.allowedDomains ?? [],
    ),
  )
}

/**
 * Official `OO()` filtered to WebFetch `domain:` allow-rules — the trusted
 * tiers' WebFetch domain allow-rule strings (deduped), used when the network
 * restriction gate (`A`) is open.
 */
export function getTrustedWebFetchAllowRules(): string[] {
  return uniq(
    getTrustedSettingsSources().flatMap((s) => s?.permissions?.allow ?? []),
  )
}

/** Convenience: the WebFetch tool name, re-exported for the adapter's use. */
export { WEB_FETCH_TOOL_NAME }
