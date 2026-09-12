/**
 * Symlinked-directory spelling equivalences for permission rules.
 *
 * Byte-verified port of the official Claude Code 2.1.268 fix (E13):
 * "Fixed deny and ask permission rules on symlinked directories (/etc, /tmp,
 * /var on macOS; /bin on Linux) not applying when a path was given by its real
 * location, and Bash commands ignoring deny rules written on a symlinked path
 * spelling."
 *
 * Official minified identifiers mapped to the exports below (verified against
 * /tmp/cc-diff-268/s2s.txt, the 2.1.268 bundle strings):
 *   Yp()  → getTrustedSymlinkEquivalences()  physical→symlink pair table
 *   jxt() → toTrustedSymlinkSpelling()       real-location → symlink spelling
 *   zp()  → resolvePhysicalTwinPattern()     rule-pattern → physical twin
 *   jp    → UNESCAPED_GLOB_CHAR              glob-metachar detector
 *   qat() → unescapePatternSegment()         backslash unescaper
 *   Rte() → escapePatternPath()              pattern path escaper
 *   fn()  → collapsePatternSlashes()         slash-collapse / BOM normalizer
 *   qn()  → normalizeTrailingGlobstar()      `/**`-strip normalizer
 *   zo()  → unusablePatternReason()          pattern-usability checker
 *   physicalTwinsByPattern (Bl state) → module-level memo Map below
 *
 * SECURITY: fail-CLOSED. Whenever the physical twin of a rule prefix cannot be
 * resolved unambiguously (nonexistent, already-physical, root, unescapable
 * glob, uncompilable pattern), resolvePhysicalTwinPattern returns null and no
 * twin is registered — the literal rule spelling still applies exactly as
 * before this port.
 */
import { posix } from 'path'
import { logForDebugging } from '../debug.js'
import {
  getFsImplementation,
  resolveDeepestExistingAncestorSync,
} from '../fsOperations.js'
import { validateIgnorePattern } from '../globPatternValidation.js'
import { getPlatform } from '../platform.js'

const DIR_SEP = posix.sep

/**
 * Official `jp=/(?:^|[^\\])(?:\\\\)*[*?[]/` — matches a segment containing an
 * UNESCAPED glob metacharacter (*, ?, or [), i.e. one where the segment is a
 * real glob and not a literal path component. (0 hits in 2.1.267 strings,
 * 1 hit in 2.1.268 — new in this release.)
 */
const UNESCAPED_GLOB_CHAR = /(?:^|[^\\])(?:\\\\)*[*?[]/

/**
 * Official `l=/^[\\[\]!#()|+^$*?\s]$/` (used by `$Bn` inside `qat`) — the
 * characters whose backslash escape means "literal char" in a rule pattern
 * segment. Any other `\x` escape keeps its backslash.
 */
const ESCAPABLE_PATTERN_CHAR = /^[\\[\]!#()|+^$*?\s]$/

/**
 * Official `Qf=/^\s*$|^#|(?:^|[^\\])\\$/` — patterns the `ignore` library
 * skips outright (blank, comment, or trailing unescaped backslash).
 */
const UNUSABLE_IGNORE_PATTERN = /^\s*$|^#|(?:^|[^\\])\\$/

/**
 * Official Yp() table — pairs of [physical location, symlinked spelling].
 * Byte-verified identical in 2.1.267 and 2.1.268 strings:
 * `[["/private/tmp","/tmp"],["/private/var","/var"],["/private/etc","/etc"],
 * ["/usr/bin","/bin"],["/usr/lib","/lib"],["/usr/sbin","/sbin"]]`
 */
const TRUSTED_EQUIVALENCE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['/private/tmp', '/tmp'],
  ['/private/var', '/var'],
  ['/private/etc', '/etc'],
  ['/usr/bin', '/bin'],
  ['/usr/lib', '/lib'],
  ['/usr/sbin', '/sbin'],
]

// Official: module-level `r=new Map` cache built once. OCC adds a test-clear
// hook because tests run in one process against real temp dirs.
let trustedSymlinkEquivalences: Map<string, string> | undefined

/**
 * Official Yp(): builds the physical→symlink map, keeping ONLY pairs where the
 * symlinked spelling actually resolves to the physical location on this
 * machine (`if(o.realpathSync(p)===d)r.set(d,p)`), silently skipping pairs
 * that don't exist or throw.
 */
export function getTrustedSymlinkEquivalences(): Map<string, string> {
  if (trustedSymlinkEquivalences !== undefined) {
    return trustedSymlinkEquivalences
  }
  const equivalences = new Map<string, string>()
  const fsImpl = getFsImplementation()
  for (const [physical, symlinked] of TRUSTED_EQUIVALENCE_PAIRS) {
    try {
      if (fsImpl.realpathSync(symlinked) === physical) {
        equivalences.set(physical, symlinked)
      }
    } catch {
      // Pair not present on this machine (official swallows the error).
    }
  }
  trustedSymlinkEquivalences = equivalences
  return equivalences
}

/** Clear the equivalences cache (test-only). */
export function _clearSymlinkEquivalencesForTesting(): void {
  trustedSymlinkEquivalences = undefined
}

/**
 * Official jxt(): maps a path given by its real (physical) location back to
 * the trusted symlink spelling when the physical prefix is one of the known
 * equivalences (e.g. `/private/etc/passwd` → `/etc/passwd` on macOS).
 * Returns the path unchanged when no equivalence applies.
 *
 * NOTE: exported for completeness/parity with the official bundle; the
 * official 2.1.268 wires this into the INPUT side (pJt) and allow-retry
 * (Dnt) which are unchanged 267↔268 — out of scope for this port.
 */
export function toTrustedSymlinkSpelling(path: string): string {
  for (const [physical, symlinked] of getTrustedSymlinkEquivalences()) {
    if (path === physical || path.startsWith(`${physical}${DIR_SEP}`)) {
      return symlinked + path.slice(physical.length)
    }
  }
  return path
}

/**
 * Official qat(): unescapes backslash escapes in a rule-pattern segment, but
 * only for the known escapable character class (`$Bn` guard); other `\x`
 * sequences keep their backslash.
 */
export function unescapePatternSegment(segment: string): string {
  return segment.replace(
    // `[\s\S]` = any char including newline (same as the official `[^]` scan;
    // written this way to satisfy biome noEmptyCharacterClassInRegex).
    /\\([\s\S])/g,
    (match, char: string) =>
      ESCAPABLE_PATTERN_CHAR.test(char) ? char : match,
  )
}

/**
 * Official Rte(path, {escapeGlobs: true}) — escapes a filesystem path so it
 * can be used as a literal gitignore-style pattern: backslashes, regex-ish
 * chars, glob stars, leading `!`/`#`, and trailing whitespace.
 * (`?` is intentionally NOT escaped by the official — faithful port.)
 */
export function escapePatternPath(path: string): string {
  let escaped = path
    .replaceAll('\\', '\\\\')
    .replace(/[[\]()|+^$]/g, char => `\\${char}`)
  // Official: `if(n?.escapeGlobs)t=t.replaceAll("*","\\*")` — zp always
  // calls Rte with escapeGlobs: true, so the flag is not parameterized here.
  escaped = escaped.replaceAll('*', '\\*')
  if (escaped.startsWith('!') || escaped.startsWith('#')) {
    escaped = `\\${escaped}`
  }
  return escaped.replace(/\s+$/, whitespace =>
    Array.from(whitespace, char => `\\${char}`).join(''),
  )
}

/**
 * Official fn(): collapses repeated slashes and normalizes a leading BOM
 * (`\uFEFF`) so it can't smuggle a pattern past the ignore library.
 */
export function collapsePatternSlashes(pattern: string): string {
  const collapsed = pattern.replace(/\/{2,}/g, '/')
  if (/^\s*(?:\/\*\*)?$/.test(collapsed)) {
    return collapsed
  }
  return collapsed
    .replace(/^\uFEFF([!#]?)/, (_match, marker: string) =>
      marker ? `\\${marker}` : '',
    )
    .replace(/^\uFEFF/, '[\uFEFF]')
}

/**
 * Official qn(pattern, isAllow): strips a trailing `/**` from a pattern
 * unless what remains is empty/slashes-only. Generalized over the official's
 * second parameter (isAllow) — filesystem.ts's existing
 * `normalizeIgnorePattern` is exactly `qn(pattern, false)`.
 */
export function normalizeTrailingGlobstar(
  pattern: string,
  isAllow: boolean,
): string {
  if (pattern.endsWith('/**')) {
    const withoutSuffix = pattern.slice(0, -3)
    if (/[^/]/.test(withoutSuffix)) {
      return withoutSuffix.includes('/') ||
        !isAllow ||
        /^[!#]/.test(withoutSuffix)
        ? withoutSuffix
        : `/${withoutSuffix}`
    }
    return '/**'
  }
  return pattern
}

/**
 * Official zo(): returns a human-readable reason when a pattern can't be used
 * as an ignore rule — either skipped outright by the ignore library (Qf
 * regex) or failing the compile probe (OCC reuses the memoized
 * `validateIgnorePattern` probe, identical semantics to the official uxt).
 * Returns null when the pattern is usable.
 */
export function unusablePatternReason(pattern: string): string | null {
  if (UNUSABLE_IGNORE_PATTERN.test(pattern)) {
    return 'skipped by the ignore library (blank, comment, or trailing backslash)'
  }
  return validateIgnorePattern(pattern)
}

/**
 * Official `physicalTwinsByPattern = new Map` (Bl state) — memoizes the set
 * of physical twin patterns discovered for each `${root}\x00${pattern}` key.
 * The Set persists across matcher recompiles so twins accumulate (never
 * removed during a session), matching official semantics.
 */
const physicalTwinsByPattern = new Map<string, Set<string>>()

/** Official memo key format: `` `${q}\x00${J}` `` (root, pattern). */
export function makePhysicalTwinsKey(root: string, pattern: string): string {
  return `${root}\x00${pattern}`
}

/** Get (or lazily create) the twin Set for a memo key. Official:
 * `let ee=x.get(P);if(ee===void 0)ee=new Set,x.set(P,ee)` */
export function getOrInitPhysicalTwins(key: string): Set<string> {
  let twins = physicalTwinsByPattern.get(key)
  if (twins === undefined) {
    twins = new Set<string>()
    physicalTwinsByPattern.set(key, twins)
  }
  return twins
}

/** Clear the twin memo (test-only). */
export function _clearPhysicalTwinsForTesting(): void {
  physicalTwinsByPattern.clear()
}

/**
 * Official zp(root, pattern): resolves the "physical twin" of a rule pattern
 * whose literal prefix traverses a symlinked directory. Example: a rule
 * `/etc/**` on macOS resolves the prefix `/etc` to `/private/etc`, returning
 * the twin pattern `/private/etc/**` so the rule ALSO matches paths given by
 * their real location.
 *
 * Returns null (fail-CLOSED, no twin) when:
 * - platform is Windows or the pattern isn't root-anchored (`!n.startsWith("/")`)
 * - the literal prefix is empty or starts with a glob segment (jp scan)
 * - the prefix doesn't resolve through any symlink (wC returns undefined
 *   or the resolved path equals the prefix or is the root "/")
 * - the escaped twin pattern would be unusable by the ignore library, or
 *   normalization changes it in a way that wouldn't round-trip (zo/qn guards)
 *
 * wC adaptation: OCC reuses `resolveDeepestExistingAncestorSync` (an existing
 * exact-POSIX analogue of the official component-wise readlink resolver:
 * symlinked ancestor → realpath spelling with the non-existent tail rejoined,
 * dangling link → readlink target spelling, all-physical → undefined).
 * Divergence: the official walks symlink chains up to 64 iterations on ELOOP
 * and applies per-component EPERM/EACCES fallbacks; OCC fails closed to
 * undefined (no twin) on those rare cases — the literal rule still applies.
 */
export function resolvePhysicalTwinPattern(
  root: string,
  rawPattern: string,
): string | null {
  if (getPlatform() === 'windows') {
    return null
  }
  // Official callers pass the already-fn'd normalized pattern; fn is applied
  // here so this entry point honors the same slash-collapse contract.
  const pattern = collapsePatternSlashes(rawPattern)
  if (!pattern.startsWith('/')) {
    return null
  }
  const segments = pattern.slice(1).split('/')
  // Official: `while(o<r.length&&r[o]!==""&&!jp.test(r[o]))o++` — the literal
  // prefix ends at the first empty or glob-metacharacter segment.
  let prefixEnd = 0
  while (
    prefixEnd < segments.length &&
    segments[prefixEnd] !== '' &&
    !UNESCAPED_GLOB_CHAR.test(segments[prefixEnd] as string)
  ) {
    prefixEnd++
  }
  if (prefixEnd === 0) {
    return null
  }
  const prefixPath = posix.join(
    root,
    ...segments.slice(0, prefixEnd).map(unescapePatternSegment),
  )
  let physicalPrefix: string | undefined
  try {
    physicalPrefix = resolveDeepestExistingAncestorSync(
      getFsImplementation(),
      prefixPath,
    )
  } catch (error) {
    // Byte-exact official debug message (new in 2.1.268 strings; 0 hits in
    // 2.1.267): "Could not resolve the physical twin of rule prefix"
    logForDebugging(
      `Could not resolve the physical twin of rule prefix ${prefixPath}: ${error}`,
    )
    return null
  }
  if (
    physicalPrefix === undefined ||
    physicalPrefix === prefixPath ||
    physicalPrefix === DIR_SEP
  ) {
    return null
  }
  const rest = segments.slice(prefixEnd)
  const twin = collapsePatternSlashes(
    escapePatternPath(physicalPrefix) +
      (rest.length > 0 ? `/${rest.join('/')}` : ''),
  )
  const normalized = normalizeTrailingGlobstar(twin, false)
  // Official: `if(zo(x)!==null||x!==L&&x+"/**"!==L)return null` — reject if
  // the normalized twin is unusable or normalization wouldn't round-trip.
  if (unusablePatternReason(normalized) !== null) {
    return null
  }
  if (normalized !== twin && `${normalized}/**` !== twin) {
    return null
  }
  return twin
}
