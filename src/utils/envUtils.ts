import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

// Memoized: 150+ callers, many on hot paths. Keyed off CLAUDE_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * CC 2.1.286 (item 57/--bare): central background-tasks gate.
 *
 * Official v286 `yl` @202370763 (offsets into
 * /tmp/cc-diff-286/v286/package/claude):
 *   `function yl(){return GM().backgroundTasksDisabled||
 *    a.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS||Rr()}`
 * — TRUE-NEW `||Rr()` (isBareMode) vs v285 `El` @201263733:
 *   `function El(){return LH().backgroundTasksDisabled||
 *    a.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS}`
 * i.e. --bare now disables background tasks everywhere the central gate is
 * consulted (auto-backgrounding, explicit run_in_background, schema
 * stripping, agent/skill background spawns, SDK background_tasks control
 * requests). The `backgroundTasksDisabled` settings key has no OCC
 * counterpart (pre-existing divergence, not part of the 286 delta).
 */
export function areBackgroundTasksDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) ||
    isBareMode()
  )
}

/**
 * CC 2.1.299 (#001): `CLAUDE_CODE_DISABLE_FILE_MENTIONS` — @-mentioned files
 * are passed to the model as PATHS (an `at_mention_reference` block) instead
 * of being read and attached as contents.
 *
 * Official v299 resolver gate (@227272610, offsets into
 * /tmp/cc-diff-299/v299/package/claude):
 *   `Ydn()||a.CLAUDE_CODE_DISABLE_FILE_MENTIONS ? TGr(e,n) : RGr(e,be,…)`
 * `Ydn()` reads the host `disableFileMentions()` launch option — OCC has no
 * such launch option, so the env var is the only gate here. The env var is
 * TRUE-NEW in v299 (0 hits in v296; v296 gated the sync paths-only variant
 * `mLr` on the launch option alone) and is a member of the official
 * subprocess/bg-session env passthrough set `N1r` (@228916621) — OCC has no
 * N1r counterpart list, so registration is this gate function only.
 */
export function isFileMentionsDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS)
}

/**
 * --safe-mode / CLAUDE_CODE_SAFE_MODE — disables all plugins, bundled skills,
 * and hook execution for troubleshooting ("is a plugin/hook causing my
 * problem?"). Prints restart-without-safe-mode guidance on startup.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SAFE_MODE=1 from
 * --safe-mode — notably hooks.ts executeHooks() and pluginLoader.ts which
 * fire during setup before the action handler runs.
 */
export function isSafeMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SAFE_MODE) ||
    process.argv.includes('--safe-mode')
  )
}

/**
 * CC 2.1.299 (#085): mode-exit hint helpers, byte-verified from the v299 ELF
 * (offsets into /tmp/cc-diff-299/v299/package/claude):
 *
 *   @214758800 region (envUtils chunk):
 *     `function i(e){let n=process.argv.indexOf("--");
 *       return(n===-1?process.argv:process.argv.slice(0,n)).includes(e)}`
 *     `function f(e){return process.env.CLAUDE_CODE_SESSION_KIND==="bg"?
 *       "run /stop, then claude --resume from your shell":`restart without ${e}`}`
 *     `function Jg(){return i("--safe-mode")?f("--safe-mode"):
 *       "unset CLAUDE_CODE_SAFE_MODE"}`
 *     `function vht(){return i("--bare")?f("--bare"):"unset CLAUDE_CODE_SIMPLE"}`
 *
 * vs v296 (@207257780): `Ng(){return i("--safe-mode")?"restart without
 * --safe-mode":"unset CLAUDE_CODE_SAFE_MODE"}` — the 2.1.299 fix routes the
 * restart text through `f`, so BACKGROUND sessions (where a restart re-runs the
 * same command line and keeps the mode) are told to `/stop` + `claude --resume`
 * from a shell instead.
 *
 * OCC adaptation: official consumers of `vht()` are the hooks-disabled reason
 * resolver, the /hooks menu `bareMode.exitHint`, and the bare-mode /login
 * notice — none of those surfaces exist in OCC today, so `bareModeExitHint`
 * currently has no in-tree consumer; it is kept byte-exact for parity.
 * `safeModeExitHint` is wired into the startup safe-mode warning (main.tsx).
 */
export function isBackgroundSessionKind(): boolean {
  return process.env.CLAUDE_CODE_SESSION_KIND === 'bg'
}

/** Official `i`: flag present in process.argv before any `--` separator. */
export function wasFlagPassedOnCli(flag: string): boolean {
  const separatorIndex = process.argv.indexOf('--')
  const argv =
    separatorIndex === -1 ? process.argv : process.argv.slice(0, separatorIndex)
  return argv.includes(flag)
}

/** Official `f`: bg-session-aware restart hint for a mode flag. */
export function restartHintForFlag(flag: string): string {
  return isBackgroundSessionKind()
    ? 'run /stop, then claude --resume from your shell'
    : `restart without ${flag}`
}

/** Official `Jg`: how to leave safe mode. */
export function safeModeExitHint(): string {
  return wasFlagPassedOnCli('--safe-mode')
    ? restartHintForFlag('--safe-mode')
    : 'unset CLAUDE_CODE_SAFE_MODE'
}

/** Official `vht`: how to leave bare mode. */
export function bareModeExitHint(): string {
  return wasFlagPassedOnCli('--bare')
    ? restartHintForFlag('--bare')
    : 'unset CLAUDE_CODE_SIMPLE'
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether Claude Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 *
 * 2.1.257/2.1.258: the official implements this lookup catalog-driven (each
 * catalog entry carries `vertex_region_env_var`), so at 2.1.258 every catalog
 * model has a region override.
 *
 * 2.1.284 (OCC-101): this table now mirrors the official 2.1.284 linux-x64
 * ELF `d` map byte-for-byte in content AND order (dumped @197641200 region):
 * added `claude-sonnet-5-5` → VERTEX_REGION_CLAUDE_5_5_SONNET (the v284
 * catalog `vertex_region_env_var`) and `claude-opus-5-5` →
 * VERTEX_REGION_CLAUDE_5_5_OPUS (present since the 2.1.280 launch — OCC-134
 * drift fixed here). The official orders the -5-5 entries BEFORE their -5
 * counterparts (substring-prefix hazard with startsWith matching).
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-5-5', 'VERTEX_REGION_CLAUDE_5_5_SONNET'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-fable-5-1', 'VERTEX_REGION_CLAUDE_FABLE_5_1'],
  // 2.1.293 (OCC-111): v293 catalog `vertex_region_env_var` for claude-haiku-5-5
  // (@204773604, byte-verified). Before claude-haiku-4-5 by convention (neither
  // is a prefix of the other under startsWith matching, so no hazard).
  ['claude-haiku-5-5', 'VERTEX_REGION_CLAUDE_HAIKU_5_5'],
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4-5', 'VERTEX_REGION_CLAUDE_4_5_OPUS'],
  ['claude-opus-4-6', 'VERTEX_REGION_CLAUDE_4_6_OPUS'],
  ['claude-opus-4-7', 'VERTEX_REGION_CLAUDE_4_7_OPUS'],
  ['claude-opus-4-8', 'VERTEX_REGION_CLAUDE_4_8_OPUS'],
  ['claude-opus-5-5', 'VERTEX_REGION_CLAUDE_5_5_OPUS'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
  ['claude-sonnet-5', 'VERTEX_REGION_CLAUDE_5_SONNET'],
  ['claude-fable-5', 'VERTEX_REGION_CLAUDE_FABLE_5'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-opus-5', 'VERTEX_REGION_CLAUDE_5_OPUS'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
