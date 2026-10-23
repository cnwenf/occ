/**
 * Shared internal git-env builder — ported from the official Claude Code
 * 2.1.309 hardened git-env module (BIN309 @240284681..240287300, recovered
 * byte-verbatim via read-only forensics; the official binary was never
 * executed).
 *
 * WHY: every git subprocess Claude Code spawns must be insulated from the
 * ambient environment so a malicious repo / inherited env cannot redirect git
 * (GIT_DIR/GIT_CONFIG_*), prompt on a terminal (GIT_TERMINAL_PROMPT), fetch
 * over an arbitrary transport (GIT_ALLOW_PROTOCOL), lazy-fetch missing objects
 * (GIT_NO_LAZY_FETCH), substitute replace-refs (GIT_NO_REPLACE_OBJECTS), run
 * hooks/fsmonitor, or resolve `git` off a relative PATH. This module is the
 * single place that assembles that environment.
 *
 * OFFICIAL SYMBOL → OCC NAME (BIN309 byte offsets):
 *   _n   (@240284681) → GIT_HOOKS_DISABLED_ARGS
 *   oir  (@240284911) → GIT_LFS_SKIP_SMUDGE_ENV
 *   jRe  (@240284946) → GIT_ALLOW_PROTOCOL_NONE  ("/")
 *   d    (@240284951) → GIT_CONFIG_ALIAS_NEUTRALIZERS
 *   p    (@240285057) → GIT_CONFIG_PARAMETERS_BASE  (d.join(" "))
 *   M    (@240285063) → GIT_HARDENED_ENV
 *   b    (@240285228) → GIT_C_LOCALE_ENV
 *   F    (@240285269) → GIT_SSH_DISABLED_ENV
 *   vTt  (@240285325) → GIT_HARDENED_ARG_PREFIX  ([..._n, bareRepository, file-protocol])
 *   Cot  (@240285455) → GIT_REDIRECT_SCRUB_KEYS
 *   wZ   (@240285697) → GIT_ENV_SCRUB_KEYS  (Cot + GIT_CONFIG_* family)
 *   K    (@240285905) → GIT_ENV_SCRUB_SET  (new Set(wZ))
 *   Rot  (@240285836) → GIT_CONFIG_INDEX_RE  (/^GIT_CONFIG_(KEY|VALUE)_\d+$/i)
 *   Ts   (@240285945) → buildHardenedGitEnv
 *   air  (@240286082) → buildMergedGitEnv
 *   U    (@240286204) → GIT_MERGED_SCRUB_KEYS  (["GIT_LFS_SKIP_SMUDGE","GIT_NO_LAZY_FETCH"])
 *   E    (@240286242) → mergeAndScrubGitEnv  (internal)
 *   Y    (@240286617) → applyGitAllowProtocol  (internal)
 *   B    (@240287095) → sanitizeGitEnvPath  (internal)
 *
 * 308 → 309 DELTA (changelog item 10): the merge-builder was `aor`
 * (BIN308 @239467549) and SCRUBBED GIT_NO_REPLACE_OBJECTS to undefined; 309
 * renames it `air` (BIN309 @240286082), DEFAULT-INJECTS
 * `GIT_NO_REPLACE_OBJECTS:"1"` (marker @240286112, absent from BIN308) and
 * drops it from the scrub list `U`. That is the entire item-10 change and it
 * is reproduced faithfully in buildMergedGitEnv below.
 *
 * DECLARED DEVIATIONS (structure only — behavior is byte-faithful):
 *  1. Official `B` maps each PATH entry through an identity fn `o=(t)=>t`
 *     before filtering; the identity map is a no-op and is omitted here.
 *  2. Official scalars `sir=2000` (@240285308) and regex `iir=/^GIT_(?:SSL|
 *     PROXY)_/i` (@240285871) are exported by the official module but their
 *     consumers live OUTSIDE the recovered region. They are NOT ported (no
 *     invented semantics); declared here per the STOP-on-ambiguous rule.
 *  3. Official `air` mutates the freshly-built object in place
 *     (`n[o]=void 0`); OCC builds the same result immutably (spread) per the
 *     repo immutability rule. Observably identical.
 */

/** A git subprocess environment: keys map to string values, or undefined to
 *  mark "explicitly unset" (execa omits undefined-valued keys from the child). */
export type GitEnv = Record<string, string | undefined>

/** Resolved repository locations the official `UF(e)` feeds into `E` so the
 *  child git process is pinned to an exact dir/work-tree instead of relying on
 *  cwd discovery. `workTree: null` → pin GIT_IMPLICIT_WORK_TREE=0 (bare). */
export interface GitRepositoryInfo {
  readonly gitDir: string
  readonly commonDir: string
  readonly workTree: string | null
}

export interface GitEnvOptions {
  /** Official `r.userLocale`: when true, do NOT force LC_ALL/LANGUAGE=C
   *  (changelog item 44 opt-out). Default false → C locale injected. */
  readonly userLocale?: boolean
  /** Base environment to merge over. Official default `process.env`. */
  readonly base?: NodeJS.ProcessEnv
  /** Optional repository pin (official `repository` / `UF(e)`). */
  readonly repository?: GitRepositoryInfo
}

// ── Frozen constant sets (verbatim from BIN309) ─────────────────────────────

/** Official `_n` @240284681 — arg prefix disabling hooks + fsmonitor. */
export const GIT_HOOKS_DISABLED_ARGS: readonly string[] = Object.freeze([
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
])

/** Official `oir` @240284911. */
export const GIT_LFS_SKIP_SMUDGE_ENV: Readonly<GitEnv> = Object.freeze({
  GIT_LFS_SKIP_SMUDGE: '1',
})

/** Official `jRe` @240284946 — the "no transport allowed" sentinel value. */
export const GIT_ALLOW_PROTOCOL_NONE = '/'

/** Official `d` @240284951 — GIT_CONFIG_PARAMETERS entries that neutralize
 *  `remote-*` aliases / bundleURI / autocorrect so a malicious repo config
 *  cannot smuggle a command through a transport alias. */
const GIT_CONFIG_ALIAS_NEUTRALIZERS: readonly string[] = Object.freeze([
  "'alias.remote-none=version'",
  "'alias.remote-none.command=version'",
  "'alias.remote-/.command=version'",
  "'fetch.bundleURI='",
  "'help.autocorrect=0'",
])

/** Official `p` @240285057 — `d.join(" ")`. */
export const GIT_CONFIG_PARAMETERS_BASE: string =
  GIT_CONFIG_ALIAS_NEUTRALIZERS.join(' ')

/** Official `M` @240285063 — the hardened base env every git spawn gets. */
export const GIT_HARDENED_ENV: Readonly<GitEnv> = Object.freeze({
  GIT_ALLOW_PROTOCOL: GIT_ALLOW_PROTOCOL_NONE,
  GIT_CONFIG_PARAMETERS: GIT_CONFIG_PARAMETERS_BASE,
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  ...GIT_LFS_SKIP_SMUDGE_ENV,
})

/** Official `b` @240285228 — C locale, injected unless `userLocale:true`
 *  (changelog item 44). */
export const GIT_C_LOCALE_ENV: Readonly<GitEnv> = Object.freeze({
  LC_ALL: 'C',
  LANGUAGE: 'C',
})

/** Official `F` @240285269 — disables ssh unless the allow-list permits it. */
export const GIT_SSH_DISABLED_ENV: Readonly<GitEnv> = Object.freeze({
  GIT_SSH_COMMAND: 'false',
})

/** Official `vTt` @240285325 — `[..._n, safe.bareRepository=explicit,
 *  protocol.file.allow=never]`. Prepended to git argv by the official spawn
 *  wrapper; exported so OCC git call sites can share the exact prefix. */
export const GIT_HARDENED_ARG_PREFIX: readonly string[] = Object.freeze([
  ...GIT_HOOKS_DISABLED_ARGS,
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'protocol.file.allow=never',
])

/** Official `Cot` @240285455 — env vars that redirect git's repo discovery. */
const GIT_REDIRECT_SCRUB_KEYS: readonly string[] = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SHALLOW_FILE',
  'GIT_NAMESPACE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_REFERENCE_BACKEND',
])

/** Official `wZ` @240285697 — `Cot` + the GIT_CONFIG_* family. Every one of
 *  these inherited from the base env is scrubbed unless explicitly provided. */
const GIT_ENV_SCRUB_KEYS: readonly string[] = Object.freeze([
  ...GIT_REDIRECT_SCRUB_KEYS,
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG',
])

/** Official `K` @240285905 — `new Set(wZ)`. */
const GIT_ENV_SCRUB_SET: ReadonlySet<string> = new Set(GIT_ENV_SCRUB_KEYS)

/** Official `Rot` @240285836 — matches `GIT_CONFIG_KEY_<n>` /
 *  `GIT_CONFIG_VALUE_<n>` (case-insensitive). */
const GIT_CONFIG_INDEX_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i

/** Official `U` @240286204 — the reduced 309 merge scrub list (item 10 dropped
 *  GIT_NO_REPLACE_OBJECTS from the 308 list `K`). */
const GIT_MERGED_SCRUB_KEYS: readonly string[] = Object.freeze([
  'GIT_LFS_SKIP_SMUDGE',
  'GIT_NO_LAZY_FETCH',
])

// ── Internal builders (official Y / E / B) ──────────────────────────────────

/**
 * Official `Y` @240286617 — validate GIT_ALLOW_PROTOCOL and rebuild
 * GIT_CONFIG_PARAMETERS with `remote-<transport>` alias neutralizers.
 *
 * Throws the official verbatim message on a non-transport token.
 */
function applyGitAllowProtocol(env: GitEnv): GitEnv {
  const allowProtocol = env.GIT_ALLOW_PROTOCOL
  if (allowProtocol === undefined) {
    return { ...env }
  }
  const transports = allowProtocol
    .split(':')
    .filter(token => token !== GIT_ALLOW_PROTOCOL_NONE)
  if (
    transports.find(token => !/^[A-Za-z0-9-]*$/.test(token)) !== undefined
  ) {
    throw new Error(
      'GIT_ALLOW_PROTOCOL may list only transport names made of letters, digits and "-"',
    )
  }
  const aliases = [
    ...new Set([
      ...GIT_CONFIG_ALIAS_NEUTRALIZERS,
      ...transports.flatMap(transport => [
        `'alias.remote-${transport}=version'`,
        `'alias.remote-${transport}.command=version'`,
      ]),
    ]),
  ]
  const existing = env.GIT_CONFIG_PARAMETERS
  return {
    ...env,
    GIT_CONFIG_PARAMETERS: [
      ...(existing === undefined ||
      existing === '' ||
      existing === GIT_CONFIG_PARAMETERS_BASE
        ? []
        : [existing]),
      ...aliases,
    ].join(' '),
  }
}

/**
 * Official `E` @240286242 — merge defaults + repository pin + overrides, then
 * scrub every inherited GIT_* redirect / config var from `base` unless the
 * caller explicitly provided it (case-insensitive collision aware).
 */
function mergeAndScrubGitEnv(
  defaults: GitEnv,
  overrides: GitEnv,
  { base = process.env, repository }: GitEnvOptions = {},
): GitEnv {
  const intended = applyGitAllowProtocol({
    ...defaults,
    ...(repository !== undefined && {
      GIT_DIR: repository.gitDir,
      GIT_COMMON_DIR: repository.commonDir,
    }),
    ...(repository !== undefined &&
      (repository.workTree !== null
        ? { GIT_WORK_TREE: repository.workTree }
        : { GIT_IMPLICIT_WORK_TREE: '0' })),
    ...overrides,
  })

  const scrub: GitEnv = {}
  for (const key of GIT_ENV_SCRUB_KEYS) {
    scrub[key] = undefined
  }

  const intendedKeys = new Set(Object.keys(intended).map(key => key.toUpperCase()))
  for (const key of Object.keys(base)) {
    const upper = key.toUpperCase()
    if (
      GIT_ENV_SCRUB_SET.has(upper) ||
      GIT_CONFIG_INDEX_RE.test(key) ||
      (intendedKeys.has(upper) && !(key in intended))
    ) {
      scrub[key] = undefined
    }
  }

  return { ...base, ...scrub, ...intended }
}

/**
 * Official `B` @240287095 — sanitize PATH so `git` (and its helpers) can only
 * resolve from absolute directories. Relative entries (`.`, `bin`) are dropped;
 * an empty result becomes `/dev/null`.
 */
function sanitizeGitEnvPath(env: GitEnv): GitEnv {
  const isAbsolute = (entry: string): boolean => entry.startsWith('/')
  const sanitize = (value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined
    }
    const entries = value
      .split(':')
      .filter(entry => entry !== '' && isAbsolute(entry))
    return entries.length > 0 ? entries.join(':') : '/dev/null'
  }
  const pathKeys = Object.keys(env).filter(key => key === 'PATH')
  return {
    ...env,
    ...Object.fromEntries(pathKeys.map(key => [key, sanitize(env[key])])),
  }
}

// ── Public builders (official Ts / air) ─────────────────────────────────────

/**
 * Official `Ts` @240285945 — the FULL hardened builder. Layers the frozen
 * hardened set `M`, the C locale `b` (unless `userLocale:true`, item 44), and
 * `GIT_SSH_COMMAND:"false"` (unless the caller's GIT_ALLOW_PROTOCOL lists
 * `ssh`), merges over `env`, scrubs inherited redirect/config vars, and
 * sanitizes PATH.
 */
export function buildHardenedGitEnv(
  env?: GitEnv,
  options: GitEnvOptions = {},
): GitEnv {
  const sshAllowed =
    env?.GIT_ALLOW_PROTOCOL?.split(':').includes('ssh') ?? false
  return sanitizeGitEnvPath(
    mergeAndScrubGitEnv(
      {
        ...GIT_HARDENED_ENV,
        ...(options.userLocale === true ? {} : GIT_C_LOCALE_ENV),
        ...(sshAllowed ? {} : GIT_SSH_DISABLED_ENV),
      },
      env ?? {},
      options,
    ),
  )
}

/**
 * Official `air` @240286082 — the 309 MERGE builder used by the worktree /
 * branch-checkout spawn path (changelog item 10). Default-injects
 * `GIT_NO_REPLACE_OBJECTS:"1"` (so worktrees ignore replace refs like every
 * other git op) and scrubs `GIT_LFS_SKIP_SMUDGE` / `GIT_NO_LAZY_FETCH` to
 * undefined unless the caller explicitly provided them. Lighter than `Ts`:
 * no locale / ssh / hardened-set layering and no PATH sanitization.
 */
export function buildMergedGitEnv(
  overrides: GitEnv = {},
  options: GitEnvOptions = {},
): GitEnv {
  const merged = mergeAndScrubGitEnv(
    { GIT_NO_REPLACE_OBJECTS: '1' },
    overrides,
    options,
  )
  const absentScrubs: GitEnv = {}
  for (const key of GIT_MERGED_SCRUB_KEYS) {
    if (!(key in merged)) {
      absentScrubs[key] = undefined
    }
  }
  return { ...merged, ...absentScrubs }
}
