import { resolve } from 'path'
import {
  envAboveProjectSettings,
  isTelemetryOffOnlyException,
  TELEMETRY_PROJECT_SCOPE_BLOCKED_ENV_KEYS,
} from '../managedEnv.js'
import { getEnabledSettingSources } from './constants.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
  getSettingsForSource,
} from './settings.js'
import type { ValidationError } from './validation.js'

/**
 * CC 2.1.282 (UI leg): derivable status entries for the project/local
 * settings telemetry env-var blocklist — port of the official `etr()`
 * (@210567300-210569900, `export{Une,etr,U_t,G1e}` module).
 *
 * The official implementation is NOT a mutation-time collector: `etr()`
 * re-inspects the project-scoped settings sources on demand and classifies
 * each blocked telemetry key via `Vcn` (the off-only exception):
 *
 *   for (let o of ts()) {                       // enabled setting sources
 *     if (!RLt(o)) continue                     // project/local scope only
 *     if (o === "projectSettings" && r.includes("userSettings") && VT())
 *       continue                                // same-file dedupe
 *     let n = ye(o)?.env ?? {}                  // raw settings env
 *     for (let a of Object.keys(n)) {
 *       let f = a.toUpperCase()
 *       if (!c.has(f)) continue                 // c = new Set(Gcn) — 48 names
 *       if (Vcn(a, n[a], aCr)) s.push(a)        // kept → turnedOff
 *       else e.push(a)                          // dropped → ignored
 *     }
 *     ...pushes one ValidationError per source per class,
 *        {file: Er(o), path: "env", message: <template>, severity: "warning",
 *         statusOnly: true}
 *   }
 *   return {ignored: t, turnedOff: i}
 *
 * Consumers (all byte-verified in the 2.1.282 ELF):
 *  - startup notice plugin `C7e`/`Nao` @222520299 (remote-gated by `Lt()`,
 *    fires only when ignored or turnedOff is non-empty),
 *  - `Une()` settings-error aggregate → `oBe()` statusOnly split →
 *    doctor CLI bare `- message` lines @217202498 and `qqr()` doctor-screen /
 *    /status diagnostics messages @217299046,
 *  - `G1e()` (invalid-settings dialog) EXCLUDES them (`severity!=="warning"`
 *    filter), as does the official settings-errors count
 *    (`$7e(){return oBe(Une().errors).invalidEntries}` @222527300).
 */

/** Notification key — official `key:"project-telemetry-env"` @222520512 region. */
export const PROJECT_TELEMETRY_ENV_NOTICE_KEY = 'project-telemetry-env'

/**
 * Startup notice text — byte-exact from the 2.1.282 ELF @93470892/@222520512
 * (absent from the 2.1.281 ELF). Official payload: kind/color "warning",
 * priority "medium", timeoutMs 15000.
 */
export const PROJECT_TELEMETRY_ENV_NOTICE_TEXT =
  "This project's settings set telemetry environment variables. Run /status to see which ones Claude Code ignored and which turned telemetry off."

/** Official `timeoutMs:15000` from the `Nao` notification payload. */
export const PROJECT_TELEMETRY_ENV_NOTICE_TIMEOUT_MS = 15000

/** Official `var c = new Set(Gcn)` — the 48 telemetry names, as a Set. */
const TELEMETRY_BLOCKED_UPPERCASE = new Set<string>(
  TELEMETRY_PROJECT_SCOPE_BLOCKED_ENV_KEYS,
)

/**
 * Official `VT()`: true when the project settings file and the user settings
 * file resolve to the same path (`ar` = `path.resolve`, binary import binding
 * `resolve as ar` @195165725). Used to skip the projectSettings pass when
 * userSettings is also enabled — the same file is then reported once, via the
 * user scope (which is not project-scoped, so nothing is reported at all).
 */
function projectSettingsResolveToUserSettingsFile(
  enabledSources: readonly string[],
): boolean {
  if (!enabledSources.includes('userSettings')) return false
  const projectPath = getSettingsFilePathForSource('projectSettings')
  const userPath = getSettingsFilePathForSource('userSettings')
  return (
    Boolean(projectPath) &&
    Boolean(userPath) &&
    resolve(projectPath as string) === resolve(userPath as string)
  )
}

export type ProjectTelemetryEnvStatus = {
  /** Entries for blocked keys that were dropped (binary `e`/`t` arrays). */
  ignored: ValidationError[]
  /** Entries for blocked keys kept via the off-only exception (binary `s`/`i`). */
  turnedOff: ValidationError[]
}

/**
 * Port of the official `etr()` — derivable, no collector state to reset
 * (the only module state in the official is the immutable `new Set(Gcn)`).
 */
export function getProjectTelemetryEnvStatus(): ProjectTelemetryEnvStatus {
  const ignored: ValidationError[] = []
  const turnedOff: ValidationError[] = []
  const enabledSources = getEnabledSettingSources()
  for (const source of enabledSources) {
    // Official `RLt`: Bd = new Set(["projectSettings", "localSettings"]).
    if (source !== 'projectSettings' && source !== 'localSettings') continue
    if (
      source === 'projectSettings' &&
      projectSettingsResolveToUserSettingsFile(enabledSources)
    ) {
      continue
    }
    const env = getSettingsForSource(source)?.env ?? {}
    const ignoredKeys: string[] = []
    const turnedOffKeys: string[] = []
    for (const key of Object.keys(env)) {
      if (!TELEMETRY_BLOCKED_UPPERCASE.has(key.toUpperCase())) continue
      // Official: `if(Vcn(a,n[a],aCr))s.push(a);else e.push(a)` — aCr is
      // `S.envAboveProjectSettings`.
      if (isTelemetryOffOnlyException(key, env[key], envAboveProjectSettings)) {
        turnedOffKeys.push(key)
      } else {
        ignoredKeys.push(key)
      }
    }
    const file = getSettingsFilePathForSource(source)
    // Official `nP(o)`: ".claude/settings.json" / ".claude/settings.local.json".
    const displayPath = getRelativeSettingsFilePathForSource(source)
    if (ignoredKeys.length > 0) {
      ignored.push({
        file,
        path: 'env',
        // Byte-exact template from the 2.1.282 ELF @96706768/@210568653.
        message: `Claude Code ignores these telemetry variables in ${displayPath}: ${ignoredKeys.join(', ')}. A project's settings files can only turn telemetry off: set OTEL_LOGS_EXPORTER, OTEL_METRICS_EXPORTER, or OTEL_TRACES_EXPORTER to none, or a content variable such as OTEL_LOG_USER_PROMPTS to 0, with the name in upper case. That doesn't work for a variable that managed settings, a --settings file, or the environment you start Claude Code from already sets. If you set them on purpose, set them in your shell, your user settings (~/.claude/settings.json), or managed settings instead.`,
        severity: 'warning',
        statusOnly: true,
      })
    }
    if (turnedOffKeys.length > 0) {
      turnedOff.push({
        file,
        path: 'env',
        // Byte-exact template from the 2.1.282 ELF @96707325/@210569300.
        message: `${displayPath} turns telemetry off with these variables: ${turnedOffKeys.join(', ')}. Claude Code uses these values unless managed settings or a --settings file sets the same variable. Your user settings don't override this file. To keep one on, set it in the environment you start Claude Code from, in a --settings file, or in managed settings.`,
        severity: 'warning',
        statusOnly: true,
      })
    }
  }
  return { ignored, turnedOff }
}

/**
 * The statusOnly notice messages in official aggregate order
 * (`Une()` appends `...etr().ignored, ...etr().turnedOff`; `qqr()` pushes
 * `l.message` for each). Consumed by the /status System Diagnostics builder
 * and the doctor screen.
 */
export function getProjectTelemetryEnvStatusMessages(): string[] {
  const { ignored, turnedOff } = getProjectTelemetryEnvStatus()
  return [...ignored, ...turnedOff].map((entry) => entry.message)
}

/**
 * Official `Nao` trigger condition (minus the `Lt()` remote gate, which the
 * notification hook applies via getIsRemoteMode): returns the byte-exact
 * notice text when at least one project-scope telemetry key was ignored or
 * kept-as-off, otherwise null.
 */
export function getProjectTelemetryEnvNoticeText(): string | null {
  const { ignored, turnedOff } = getProjectTelemetryEnvStatus()
  if (ignored.length === 0 && turnedOff.length === 0) return null
  return PROJECT_TELEMETRY_ENV_NOTICE_TEXT
}
