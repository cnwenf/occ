import { execaSync } from 'execa'
import { readFileSync } from 'fs'
import { stripVTControlCharacters } from 'util'
import { logForDebugging } from '../debug.js'
import { whichSync } from '../which.js'

/**
 * CC 2.1.310 changelog item 11 — AppArmor unprivileged-userns diagnostic.
 *
 * Official changelog (verbatim): "Linux: Improved `/sandbox` and the sandbox
 * startup warning to name Ubuntu's AppArmor restriction on user namespaces,
 * and how to lift it, when it keeps bubblewrap from starting the sandbox".
 *
 * When Ubuntu's AppArmor restriction on unprivileged user namespaces
 * (`kernel.apparmor_restrict_unprivileged_userns=1`) keeps bubblewrap from
 * starting, produce the precise remedy message instead of a generic error.
 * Wired into the adapter's memoized `checkDependencies` behind the official
 * `Zde` gate: `(platform linux || wsl) && errors.length === 0 &&
 * !runtimeInitialized`.
 *
 * All constants/messages byte-verified against the official 2.1.310 linux-x64
 * ELF (READ-ONLY, never executed; `grep -aboF` counts BIN310/BIN309):
 *  - `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`: 2 / 0
 *  - `setting up uid map: Permission denied|Failed RTM_NEWADDR`: 2 / 0
 *  - `--unshare-user","--unshare-net","--dev-bind","/","/","/bin/true`: 1 / 0
 *  - `AppArmor restriction on user namespaces stops bubblewrap here`: 2 / 0
 *  - `the bubblewrap trial`: 2 / 0
 *  - `the AppArmor user-namespace check could not be made`: 2 / 0
 *  - `readRestrictionSwitch` / `resolveBubblewrap` / `tryBubblewrap`: 3 each / 0
 *
 * Official decompiled shapes mirrored here:
 *  - `d$` probe — switch `.trim() !== "1"` → undefined; bwrap null →
 *    undefined; trial `!ran || exitCode === 0` → undefined; else warn-log
 *    (raw trimmed stderr), sanitize (`rd`), matcher fail → undefined, else
 *    the verbatim remedy message with first-matching-line extraction
 *    (trim → strip leading `bwrap: ` → `.slice(0, 80)`). Catch-all warn.
 *  - `f$` injector — `{readRestrictionSwitch, resolveBubblewrap, tryBubblewrap}`.
 *  - `Oue` trial — sync spawn, cwd `/`, env `{PATH:"/usr/bin:/bin",
 *    USER_TYPE:"external",NODE_ENV:"production"}` extendEnv false, stdio
 *    ignore/ignore/pipe, reject false, timeout 2000; `ran = !timedOut &&
 *    signal === undefined && typeof exitCode === "number"`.
 *  - `rd` sanitizer @238402828 — lone-surrogate strip (`Nb` @237222391 — NOT
 *    an ANSI stripper as triage glossed) → `stripVTControlCharacters` → drop
 *    `/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu`.
 *
 * OCC mapping deviations (reported, not invented):
 *  - Official `_Sn` @240225161 resolves the configured `sandbox.bwrapPath`
 *    (managed-only setting, describe @238075794) before PATH; OCC has no
 *    `bwrapPath` settings key, so only the PATH leg (`whichSync('bwrap')` ≡
 *    official `EB("bwrap")` = `Bun.which`) is ported.
 *  - Official sync-spawn `Ist` @238555166 (sandbox-runtime execa helper) →
 *    `execaSync` (execa@9.6.1, already an OCC dependency) with identical
 *    options and the same result fields (`timedOut`/`signal`/`exitCode`/
 *    `stderr`).
 */

/** Official `Nue` — Ubuntu's AppArmor unprivileged-userns restriction switch. */
export const APPARMOR_USERNS_SWITCH_PATH =
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

/** Official `l$` — bwrap failure signatures under the restriction. */
export const APPARMOR_USERNS_STDERR_PATTERN =
  /setting up uid map: Permission denied|Failed RTM_NEWADDR/

/** Official `u$` — sandboxed trial argv. */
export const BUBBLEWRAP_TRIAL_ARGS = [
  '--unshare-user',
  '--unshare-net',
  '--dev-bind',
  '/',
  '/',
  '/bin/true',
] as const

/** Official `kue` — trial timeout in ms. */
export const BUBBLEWRAP_TRIAL_TIMEOUT_MS = 2000

/** Official `Oue` result shape. */
export type BubblewrapTrialResult = {
  ran: boolean
  exitCode: number | null
  stderr: string
}

/** Official `f$` injectable-deps shape (testability without spawning bwrap). */
export type ApparmorUsernsProbeDeps = {
  readRestrictionSwitch: () => string | undefined
  resolveBubblewrap: () => string | null
  tryBubblewrap: (bwrapPath: string) => BubblewrapTrialResult
}

/** Official `Nb` inner pattern — lone (unpaired) UTF-16 surrogates. */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Official `Nb` @237222391 — isWellFormed fast path, else strip lone surrogates. */
function stripLoneSurrogates(text: string): string {
  if (typeof text.isWellFormed === 'function' && text.isWellFormed()) {
    return text
  }
  return text.replace(LONE_SURROGATE_PATTERN, '')
}

/** Official `rd` @238402828 — surrogate strip → VT strip → Cc/Cf drop (keep \t \n). */
function sanitizeTrialStderr(text: string): string {
  return stripVTControlCharacters(stripLoneSurrogates(text)).replace(
    /(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    '',
  )
}

/** Official `Due` — read the restriction switch; undefined when absent/unreadable. */
export function readApparmorRestrictionSwitch(): string | undefined {
  try {
    return readFileSync(APPARMOR_USERNS_SWITCH_PATH, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Official `_Sn` @240225161 (PATH leg only — see deviation note above).
 * Returns the resolved bwrap path, or null when bubblewrap is unavailable.
 */
export function resolveBubblewrapPath(): string | null {
  return whichSync('bwrap')
}

/** Official `Oue` — sandboxed trial run; never throws (catch → not-ran). */
export function runBubblewrapTrial(bwrapPath: string): BubblewrapTrialResult {
  try {
    const result = execaSync(bwrapPath, [...BUBBLEWRAP_TRIAL_ARGS], {
      cwd: '/',
      env: {
        PATH: '/usr/bin:/bin',
        USER_TYPE: 'external',
        NODE_ENV: 'production',
      },
      extendEnv: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      reject: false,
      timeout: BUBBLEWRAP_TRIAL_TIMEOUT_MS,
    })
    return {
      ran:
        !result.timedOut &&
        result.signal === undefined &&
        typeof result.exitCode === 'number',
      exitCode: result.exitCode ?? null,
      stderr: result.stderr,
    }
  } catch {
    return { ran: false, exitCode: null, stderr: '' }
  }
}

/** Official `f$` — build the production deps around an injected resolver. */
export function createApparmorUsernsProbe(
  resolveBubblewrap: () => string | null,
): ApparmorUsernsProbeDeps {
  return {
    readRestrictionSwitch: readApparmorRestrictionSwitch,
    resolveBubblewrap,
    tryBubblewrap: runBubblewrapTrial,
  }
}

/**
 * Official `d$` — the probe. Returns the verbatim remedy message when the
 * AppArmor restriction is blocking bubblewrap, undefined in every other case
 * (switch off/missing, no bwrap, trial succeeded or did not run, stderr does
 * not match, or any internal error — never throws).
 */
export function checkApparmorUsernsBlock(
  deps: ApparmorUsernsProbeDeps,
): string | undefined {
  try {
    if (deps.readRestrictionSwitch()?.trim() !== '1') {
      return undefined
    }
    const bwrapPath = deps.resolveBubblewrap()
    if (bwrapPath === null) {
      return undefined
    }
    const trial = deps.tryBubblewrap(bwrapPath)
    if (!trial.ran || trial.exitCode === 0) {
      return undefined
    }
    logForDebugging(
      `[sandbox] kernel.apparmor_restrict_unprivileged_userns=1 and the bubblewrap trial (${bwrapPath} ${BUBBLEWRAP_TRIAL_ARGS.join(' ')}) exited ${trial.exitCode}: ${trial.stderr.trim()}`,
      { level: 'warn' },
    )
    const sanitized = sanitizeTrialStderr(trial.stderr)
    if (!APPARMOR_USERNS_STDERR_PATTERN.test(sanitized)) {
      return undefined
    }
    const excerpt = sanitized
      .split('\n')
      .map(line => line.trim().replace(/^bwrap: /, ''))
      .find(line => APPARMOR_USERNS_STDERR_PATTERN.test(line))
      ?.slice(0, 80)
    return `Ubuntu's AppArmor restriction on user namespaces stops bubblewrap here ("${excerpt}"). Add bubblewrap's AppArmor profile from https://code.claude.com/docs/en/sandboxing, or run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\` (holds until reboot), then restart Claude Code`
  } catch (error) {
    logForDebugging(
      `[sandbox] the AppArmor user-namespace check could not be made: ${error}`,
      { level: 'warn' },
    )
    return undefined
  }
}
