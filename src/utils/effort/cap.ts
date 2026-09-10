/**
 * OCC-82 (official 2.1.266 → 2.1.267): settings-side effort cap.
 *
 * Port of the official 2.1.267 cap cluster, byte-verified from the official
 * linux-x64 binary (/tmp/cc267/s267.txt). Symbol map (official → OCC):
 *
 *   Mu = EFFORT_LEVELS          E(e)    = effortLevelIndex
 *   N(e)  = getSettingsEffortCap        Stt(e) = getEffectiveEffortCap
 *   Uhe   = isEffortLevelAllowed        S9(e)  = getAllowedEffortLevels
 *   lF    = clampEffortToCap            K(e,n) = modelSupportsEffortLevel
 *   vur   = hasEffortLevelsAboveCap     Eur    = getEffortCapWarning
 *   zS    = isUltracodeAvailableForModel
 *   E(t)  = formatEffortValidOptions    txr    = buildEffortArgumentHint
 *
 * Documented reductions vs the official binary:
 * - Stt(e) = min(N(e), org-registry cap via drt()). OCC has no organization
 *   policy registry, so the org term is absent and Stt ≡ N.
 * - zS(e) = qc() && (...). qc() is the dynamic-workflows-enabled gate; OCC
 *   ships WORKFLOW_SCRIPTS always live, so the gate reduces to the model
 *   capability + cap check.
 *
 * All top-level statements are function declarations; imports from effort.ts
 * form a safe ESM cycle (bindings are only dereferenced inside calls).
 */
import chalk from 'chalk'
import { logForDebugging } from '../debug.js'
import { getCanonicalName } from '../model/model.js'
import { getEnabledSettingSources } from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type EffortValue,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} from '../effort.js'

/** Official `E(e){return Mu.indexOf(e)}` — rank of a level in the ladder. */
export function effortLevelIndex(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level)
}

/** True when the level is one of the five official Mu strings (CT). */
function isKnownEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === 'string' &&
    EFFORT_LEVELS.includes(value as EffortLevel)
  )
}

/**
 * Official `N(e)` — resolve the settings-side cap for a model.
 *
 * Iterates every enabled settings source. Within one file, if ANY file in the
 * set declares a per-model `maxEffortLevel`, the per-model entries whose key
 * canonicalizes (Bhe/getCanonicalName) to the target model's canonical name
 * are considered; the lowest matching per-model value REPLACES that file's
 * top-level `maxEffortLevel` (`d ??= f.maxEffortLevel`). Across files the
 * lowest non-"max" value wins; a per-file `"max"` exempts that file (and a
 * per-model `"max"` exempts the model from that file's top-level cap).
 */
export function getSettingsEffortCap(model: string): EffortLevel | null {
  const sources = getEnabledSettingSources().map<SettingsJson | null>(source =>
    getSettingsForSource(source),
  )

  // Official `o`: only normalize names when some file actually declares a
  // per-model maxEffortLevel — otherwise skip the per-model scan entirely.
  const canonicalTarget = sources.some(settings =>
    Object.values(settings?.modelSettings ?? {}).some(
      entry => entry?.maxEffortLevel !== undefined,
    ),
  )
    ? getCanonicalName(model)
    : undefined

  let lowest: EffortLevel | null = null
  for (const settings of sources) {
    if (!settings) continue
    let perFile: EffortLevel | undefined
    if (canonicalTarget !== undefined) {
      for (const [key, entry] of Object.entries(settings.modelSettings ?? {})) {
        // Defense-in-depth: the schema preprocess already drops keys owned by
        // Object.prototype; skip them here too so a raw/unparsed settings
        // object can never match on "constructor" etc.
        if (Object.hasOwn(Object.prototype, key)) continue
        const candidate = entry?.maxEffortLevel
        if (
          candidate !== undefined &&
          (perFile === undefined ||
            effortLevelIndex(candidate) < effortLevelIndex(perFile)) &&
          getCanonicalName(key) === canonicalTarget
        ) {
          perFile = candidate
        }
      }
    }
    perFile ??= settings.maxEffortLevel
    if (
      perFile !== undefined &&
      perFile !== 'max' &&
      (lowest === null || effortLevelIndex(perFile) < effortLevelIndex(lowest))
    ) {
      lowest = perFile
    }
  }
  return lowest
}

/**
 * Official `Stt(e)` — effective cap = min(settings cap, org cap). OCC has no
 * organization policy registry, so this reduces to the settings cap. `"max"`
 * is normalized to null (no cap) exactly as the official does.
 */
export function getEffectiveEffortCap(model: string): EffortLevel | null {
  const cap = getSettingsEffortCap(model)
  return cap === 'max' ? null : cap
}

/** Official `Uhe(e,n)` — is `level` at or below the cap for `model`. */
export function isEffortLevelAllowed(
  level: EffortLevel,
  model: string,
): boolean {
  const cap = getEffectiveEffortCap(model)
  return cap === null || effortLevelIndex(level) <= effortLevelIndex(cap)
}

/** Official `S9(e)` — the allowed subset of Mu for `model`. */
export function getAllowedEffortLevels(model: string): EffortLevel[] {
  return EFFORT_LEVELS.filter(level => isEffortLevelAllowed(level, model))
}

/** Official `K(e,n)` — does `model` support `level` at all. */
export function modelSupportsEffortLevel(
  model: string,
  level: EffortLevel,
): boolean {
  if (level === 'xhigh') return modelSupportsXhighEffort(model)
  if (level === 'max') return modelSupportsMaxEffort(model)
  return true
}

/**
 * Official `lF(e,n)` — clamp a value down to the cap. Strings above the cap
 * become the cap; everything else (numbers, unknown strings, no cap) passes
 * through unchanged.
 */
export function clampEffortToCap<T extends EffortValue>(
  value: T,
  model: string,
): EffortValue {
  const cap = getEffectiveEffortCap(model)
  if (cap !== null && isKnownEffortLevel(value)) {
    return effortLevelIndex(value) > effortLevelIndex(cap) ? cap : value
  }
  return value
}

/**
 * Official `P(e,n)` clamp tail — after the cap clamp, "max"/"xhigh" that the
 * model cannot run downgrade to "high". Kept separate from clampEffortToCap
 * so callers can apply the exact official order (cap first, then capability).
 */
export function applyEffortCapabilityDowngrade(
  value: EffortValue,
  model: string,
): EffortValue {
  let result = value
  if (result === 'max' && !modelSupportsMaxEffort(model)) result = 'high'
  if (result === 'xhigh' && !modelSupportsXhighEffort(model)) result = 'high'
  return result
}

/** Cap clamp + capability downgrade composed in the official P(e,n) order. */
export function clampEffortValue(
  value: EffortValue,
  model: string,
): EffortValue {
  return applyEffortCapabilityDowngrade(clampEffortToCap(value, model), model)
}

/**
 * Official `vur(e)` — true when some level the model CAN run sits above the
 * cap (used to decide whether the picker shows the "capped" note, `wr`).
 */
export function hasEffortLevelsAboveCap(model: string): boolean {
  const cap = getEffectiveEffortCap(model)
  if (cap === null) return false
  return EFFORT_LEVELS.some(
    level =>
      effortLevelIndex(level) > effortLevelIndex(cap) &&
      modelSupportsEffortLevel(model, level),
  )
}

/**
 * Official `Eur(e,n)` — byte-verified startup/inline warning when a requested
 * effort exceeds the cap. Returns null when no clamp applies.
 */
export function getEffortCapWarning(
  requested: unknown,
  model: string,
): string | null {
  if (!isKnownEffortLevel(requested)) return null
  const cap = getEffectiveEffortCap(model)
  if (cap === null || effortLevelIndex(requested) <= effortLevelIndex(cap)) {
    return null
  }
  // Official `r = kE(n,e) ?? o`: under an active cap kE always resolves (the
  // cap makes its early-undefined branch unreachable), so this is the full
  // P(e,n) clamp of the requested level.
  const using = clampEffortValue(requested, model)
  return `Effort '${requested}' exceeds the cap for ${model} set by your settings or organization; using '${using}'.`
}

/**
 * Official startup call site (byte-verified @6248479):
 * `{let Oe=rl({...Uje(P.effort),mainLoopModel:xo}),Ve=Eur(Oe,xo);
 *   if(Ve!==null)Zf(Ve,{key:"model-effort-cap",outputFormat:Kt,
 *   debugLine:`[effort] ${Ve}`})}`
 * with `Zf` (@4997267): when the output format is not json/stream-json and
 * the session is not a bg session → `pS(w)` (yellow warning on stderr);
 * otherwise a debug-level log line. The official stream-json `notification`
 * system event (`cc({type:"system",subtype:"notification",key,...})`) has no
 * OCC emitter — documented reduction: json modes degrade to the debug line,
 * exactly like the official's non-notification fallback.
 */
export function emitStartupEffortCapWarning(
  requestedEffort: unknown,
  model: string,
  outputFormat: string | undefined,
): void {
  const warning = getEffortCapWarning(requestedEffort, model)
  if (warning === null) return
  if (
    outputFormat !== 'json' &&
    outputFormat !== 'stream-json' &&
    process.env.CLAUDE_CODE_SESSION_KIND !== 'bg'
  ) {
    console.warn(chalk.yellow(warning))
    return
  }
  logForDebugging(`[effort] ${warning}`)
}

/**
 * Official `zS(e)` reduced — ultracode needs an xhigh-capable model and
 * xhigh must be within the cap. (The dynamic-workflows gate qc() is always
 * live in OCC; see header.)
 */
export function isUltracodeAvailableForModel(model?: string): boolean {
  return (
    model === undefined ||
    (modelSupportsXhighEffort(model) && isEffortLevelAllowed('xhigh', model))
  )
}

/**
 * Official valid-options builder `E(t)` — used in the "Invalid argument"
 * message. Comma-joined allowed levels, plus ", ultracode" when available,
 * plus ", auto".
 */
export function formatEffortValidOptions(model: string): string {
  const levels = getAllowedEffortLevels(model)
  const ultracode = isUltracodeAvailableForModel(model) ? ', ultracode' : ''
  return `${levels.join(', ')}${ultracode}, auto`
}

/**
 * Official argumentHint builder `txr(e,n)` — pipe-joined allowed levels
 * wrapped in the given brackets, plus "|ultracode" when available, plus
 * "|auto".
 */
export function buildEffortArgumentHint(
  open: string,
  close: string,
  model: string,
): string {
  const levels = getAllowedEffortLevels(model)
  const ultracode = isUltracodeAvailableForModel(model) ? '|ultracode' : ''
  return `${open}${levels.join('|')}${ultracode}|auto${close}`
}
