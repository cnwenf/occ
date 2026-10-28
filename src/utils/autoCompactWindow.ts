/**
 * Auto-compact window — ported from official Claude Code 2.1.221 (OCC-58),
 * upgraded to the official 2.1.288 PER-MODEL shape (Gap-288 #79).
 *
 * Official 2.1.221 SILENTLY added the `--autocompact <auto|tokens>` CLI flag
 * and the `autoCompactWindow` settings key (no changelog entry). Official
 * 2.1.288 moved the persisted value under `modelSettings[canonicalKey]`
 * (writer `Mqr` with an Object.prototype-pollution guard + top-level
 * fallback; key normalizer `iV` = OCC `getCanonicalName`), aggregates it per
 * settings file with whole-contribution replacement (`WIt`), and resolves it
 * with `Dw` (env → settings(byModel → default, skipping "auto") → auto).
 * Everything below is recovered from the official linux-x64 ELFs (2.1.223 for
 * the parser, 2.1.288 for the per-model cluster — binary offsets in
 * docs/gap-research-288/cluster-c-instructions-resume.md §#79):
 *
 * - The flag argParser (`Jon`): trim + lowercase; "auto" passes through; an
 *   "m" suffix multiplies by 1e6; a "k" suffix by 1e3; a bare number N with
 *   100 <= N <= 1000 is shorthand for N*1000 ("200" -> 200000); anything
 *   else is taken as a raw token count. The value must be finite and within
 *   [100_000, 1_000_000] or the parse yields undefined (Commander then throws
 *   the byte-identical InvalidArgumentError from main.tsx).
 * - Precedence for the effective window (official `Dw`): env
 *   CLAUDE_CODE_AUTO_COMPACT_WINDOW > session/per-model settings > auto. The
 *   CLI value "auto" clears a settings override for the session (`XEo`:
 *   undefined -> settings aggregate; "auto" -> undefined; number -> as-is).
 * - The resolved window is capped by the model's context window at the
 *   consumption site (official: `capped to model limit of M`).
 * - Backwards compatibility: the pre-288 top-level scalar `autoCompactWindow`
 *   still resolves as the aggregate `default` (official `WIt` keeps it).
 *
 * Symbol map (official → OCC):
 *   WIt = aggregateAutoCompactWindow   iV  = getCanonicalName
 *   Dw  = resolveAutoCompactWindow     Mqr = buildAutoCompactWindowPatch
 *   XEo = resolveAutoCompactWindowOverride
 *   TAn = chosenWindowExceedsAutoWindow (2.1.300 #10 warning gate)
 *   Hno = resolveModelAutoWindow       (2.1.300 #10 model auto window)
 *   AGt = MODEL_WINDOW_DEFAULTS        kge = KGE_MODEL_TABLE_DEFAULT
 *   TG  = TG_MODEL_DEFAULT_WINDOW      z$o = resolveModelDefaultWindowConfigured
 *   C0e = resolveWindowTableEntry      gPt = applyTierToWindowLeaf
 *   Bp+oh = isAutoCompactWindowTuningEnabled   q$o = is1mCatalogWindowSuppressed
 *   Rr  = resolveSubscriptionTierContext (staged → undefined)
 *
 * CC 2.1.304 changelog #41 (env k/M suffixes + warnings) symbol map:
 *   j_e = parseAutoCompactWindowSize   yVe = parseAutoCompactWindowEnv
 *   T4t = resolveAutoCompactWindowEnvTokens
 *   E4t = buildAutoCompactWindowEnvMessage (verbatim strings)
 *   XFe = buildAutoCompactWindowEnvWarning (msg-or-null)
 *   ySs = warnAutoCompactWindowEnv       v4t = ENV_WARNING_SANITIZE_MAX (32)
 *   gP  = AUTO_COMPACT_WINDOW_MIN        vN  = AUTO_COMPACT_WINDOW_MAX
 *
 * The official additionally resolves server-driven windows ("experiment" /
 * "clientdata" sources via the bootstrap `auto_compact_windows` cache) and an
 * "unknown-model" default window — Anthropic-backend-bound and staged (see
 * the `resolveModelAutoWindow` docblock and
 * docs/upstream-version-gap-occ58.md / docs/gap-research-288).
 */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { getGlobalConfig } from './config.js'
import { is1mContextDisabled } from './context.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName, normalizeModelSpecifier } from './model/model.js'
import { getEnabledSettingSources } from './settings/constants.js'
import { getSettingsForSource } from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'

export const AUTO_COMPACT_WINDOW_MIN = 100_000
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000

/** Official env-var key (byte-verified; also read by autoCompact.ts). */
export const ENV_WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

export type AutoCompactWindowValue = 'auto' | number

/**
 * Official `WIt` result shape: the top-level scalar default plus the per-model
 * map keyed by canonical model name.
 */
export type AutoCompactWindowAggregate = {
  default: number | undefined
  byModel: Record<string, AutoCompactWindowValue>
}

/**
 * Session/CLI override tri-state (official `XEo` result): undefined = auto,
 * a number = explicit window, an aggregate = "no CLI flag, use settings".
 *
 * 2.1.296 (OCC-154 #002) adds a fourth shape: a per-subagent ceiling wrapper
 * (official `{ceiling, inner}` from `WJn` @223498818) produced when a spawned
 * agent's definition carries `autoCompactWindow`. It only ever LOWERS the
 * window the subagent would otherwise inherit.
 */
export type AutoCompactWindowOverride =
  | AutoCompactWindowAggregate
  | AutoCompactWindowCeiling
  | number
  | undefined

/**
 * Official 2.1.296 ceiling wrapper shape (byte-verified @223498818):
 *   `function WJn(e,s){let n=e;return s===void 0?n:{ceiling:s,inner:n}}`
 * `inner` is the inherited override; `ceiling` is the subagent's own
 * autoCompactWindow.
 */
export type AutoCompactWindowCeiling = {
  ceiling: number
  inner: AutoCompactWindowOverride
}

/**
 * Official ceiling predicate `nIt` (byte-verified):
 *   `function nIt(e){return typeof e==="object"&&"ceiling"in e}`
 * (undefined fails typeof==="object"; null is guarded — `"ceiling" in null`
 * would throw, and the official receives only override values.)
 */
export function isAutoCompactWindowCeiling(
  value: AutoCompactWindowOverride,
): value is AutoCompactWindowCeiling {
  return (
    typeof value === 'object' && value !== null && 'ceiling' in value
  )
}

/**
 * Official ceiling wrapper `WJn` (byte-verified @223498818). Identity when
 * the ceiling is undefined, so callers can wrap unconditionally.
 */
export function wrapAutoCompactWindowCeiling(
  inherited: AutoCompactWindowOverride,
  ceiling: number | undefined,
): AutoCompactWindowOverride {
  if (ceiling === undefined) return inherited
  return { ceiling, inner: inherited }
}

/** Official `Dw` result. `configured` is ALWAYS a number (auto → contextWindow). */
export type ResolvedAutoCompactWindow = {
  /** Effective window after capping to the model's context window. */
  window: number
  /** The configured value before capping (auto → the context window). */
  configured: number
  source: 'env' | 'settings' | 'auto'
}

/**
 * CC 2.1.304 #43 (OCC-164 supplement) — bare-number helpers, BYTE-VERIFIED
 * from the v2.1.304 ELF (@236431990–236432800; the pre-304 port had the
 * grouped-thousands layout INFERRED — 304 exposes the real regexes `m`/`E`/`c`
 * and the `u3o`/`qc` pair):
 *
 *   var m=/^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/,
 *       E=/^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/,
 *       c=/[_,\u00A0\u202F ]/g;
 *   function u3o(e){if(e.length<=32){if(m.test(e)){let n=Number(e);
 *     return Number.isInteger(n)?n:NaN}
 *     if(E.test(e))return parseInt(e.replace(c,""),10)}return}
 *   function qc(e){let n=String(e).trim();return u3o(n)??parseInt(n,10)}
 *
 * Grouped thousands accept a CONSISTENT separator (backreference `\1`) from
 * `_`, `,`, U+00A0 NBSP, U+202F NNBSP, or a plain space — but only up to 32
 * chars (longer strings fall straight to parseInt, matching the official).
 * Both the env parser (`yVe`→`j_e`→`qc`) and the /autocompact flag parser
 * (`wQt`→`j_e`→`qc`) share this helper.
 */
// Official `m` VERBATIM — exponent notation must parse to an INTEGER.
const EXPONENT_NOTATION_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/
// Official `E` VERBATIM — grouped thousands with one consistent separator.
const GROUPED_THOUSANDS_RE =
  /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/
// Official `c` VERBATIM — strips the grouped-thousands separator.
const THOUSANDS_SEPARATOR_RE = /[_,\u00A0\u202F ]/g
/** Official `u3o` length guard (`e.length<=32`). */
const BARE_NUMBER_MAX_LENGTH = 32

/** Official `u3o` @236432633 VERBATIM. */
function parseStructuredNumber(value: string): number | undefined {
  if (value.length <= BARE_NUMBER_MAX_LENGTH) {
    if (EXPONENT_NOTATION_RE.test(value)) {
      const parsed = Number(value)
      // NaN is intentional: a non-integer exponent form must NOT fall
      // through to parseInt (`u3o(n)??parseInt` — NaN is not nullish).
      return Number.isInteger(parsed) ? parsed : NaN
    }
    if (GROUPED_THOUSANDS_RE.test(value)) {
      return parseInt(value.replace(THOUSANDS_SEPARATOR_RE, ''), 10)
    }
  }
  return undefined
}

/** Official `qc` @236432785 VERBATIM. */
function parseBareNumber(raw: string): number {
  const trimmed = String(raw).trim()
  return parseStructuredNumber(trimmed) ?? parseInt(trimmed, 10)
}

/**
 * Port of the official `Jon` argParser (byte-verified from the 2.1.223 ELF).
 * Returns 'auto', a rounded token count, or undefined when unparseable /
 * out of range.
 */
export function parseAutoCompactWindowInput(
  raw: string,
): AutoCompactWindowValue | undefined {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'auto') {
    return 'auto'
  }

  let tokens: number
  if (normalized.endsWith('m')) {
    tokens = parseFloat(normalized) * 1_000_000
  } else if (normalized.endsWith('k')) {
    tokens = parseFloat(normalized) * 1_000
  } else {
    const parsed = parseBareNumber(normalized)
    // Official shorthand: a bare value in [100, 1000] means thousands
    // ("200" -> 200000, "1000" -> 1000000); anything else is a raw count.
    tokens = parsed >= 100 && parsed <= 1000 ? parsed * 1000 : parsed
  }

  if (
    !Number.isFinite(tokens) ||
    tokens < AUTO_COMPACT_WINDOW_MIN ||
    tokens > AUTO_COMPACT_WINDOW_MAX
  ) {
    return undefined
  }
  return Math.round(tokens)
}

/* ----------------------------------------------------------------------
 * CC 2.1.304 changelog #41 — CLAUDE_CODE_AUTO_COMPACT_WINDOW k/M suffixes
 * + clamp-to-bounds + user-facing warnings. Everything below is byte-
 * verified from the official 2.1.304 linux-x64 ELF (offsets in
 * docs/gap-research-304/research-R3-session-api.md §#41):
 *   j_e @246816065 (core parser), yVe (env parse = j_e bareThousands:false),
 *   T4t @246816476 (env resolver/clamper), E4t @246817300 (warning
 *   builder), XFe (msg-or-null), ySs @246816655 (emitter + telemetry
 *   `compact_window_env`), v4t=32 (sanitize cap), gP=1e5 / vN=1e6.
 * ---------------------------------------------------------------------- */

/** Official `j_e` result shape (discriminated on `kind`). */
export type AutoCompactWindowSizeParse =
  | { kind: 'unusable' }
  | { kind: 'below_minimum'; tokens: number }
  | { kind: 'above_maximum' }
  | { kind: 'in_range'; tokens: number; suffixed: boolean }

/**
 * Port of the official core size parser `j_e` (byte-verified @246816065):
 *   `function j_e(e,{bareThousands:n}){let r=e.trim(),s=r.slice(-1).toLowerCase(),
 *    h=s==="m"?1e6:s==="k"?1000:void 0,y=h===void 0?qc(r):parseFloat(r)*h,
 *    w=n&&h===void 0&&y>=100&&y<=1000?y*1000:y;
 *    if(Number.isNaN(w)||w<1)return{kind:"unusable"};
 *    if(w<gP)return{kind:"below_minimum",tokens:Math.min(gP-1,Math.round(w))};
 *    if(w>vN)return{kind:"above_maximum"};
 *    return{kind:"in_range",tokens:Math.round(w),suffixed:h!==void 0}}`
 * `qc` is the same bare-number integer parser as `xp` (OCC `parseBareNumber`:
 * exponent → integer-only, comma-grouped stripped, parseInt fallback).
 *
 * `bareThousands: true` is the /autocompact flag variant (`wQt`: bare
 * "200"→200000); the ENV variant (`yVe`) passes `bareThousands: false`, so a
 * bare env "200" reads as 200 tokens → below_minimum → clamped to 100k.
 */
export function parseAutoCompactWindowSize(
  raw: string,
  { bareThousands }: { bareThousands: boolean },
): AutoCompactWindowSizeParse {
  const trimmed = raw.trim()
  const suffix = trimmed.slice(-1).toLowerCase()
  const multiplier =
    suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1000 : undefined
  const parsed =
    multiplier === undefined
      ? parseBareNumber(trimmed)
      : parseFloat(trimmed) * multiplier
  const tokens =
    bareThousands &&
    multiplier === undefined &&
    parsed >= 100 &&
    parsed <= 1000
      ? parsed * 1000
      : parsed
  if (Number.isNaN(tokens) || tokens < 1) {
    return { kind: 'unusable' }
  }
  if (tokens < AUTO_COMPACT_WINDOW_MIN) {
    return {
      kind: 'below_minimum',
      tokens: Math.min(AUTO_COMPACT_WINDOW_MIN - 1, Math.round(tokens)),
    }
  }
  if (tokens > AUTO_COMPACT_WINDOW_MAX) {
    return { kind: 'above_maximum' }
  }
  return { kind: 'in_range', tokens: Math.round(tokens), suffixed: multiplier !== undefined }
}

/** Official `yVe` (byte-verified): `yVe(e)=j_e(e,{bareThousands:!1})`. */
export function parseAutoCompactWindowEnv(
  raw: string,
): AutoCompactWindowSizeParse {
  return parseAutoCompactWindowSize(raw, { bareThousands: false })
}

/**
 * Port of the official env resolver `T4t` (byte-verified @246816476):
 *   `function T4t(e){if(e===void 0)return;let n=yVe(e);switch(n.kind){
 *    case"in_range":return n.tokens;case"below_minimum":return gP;
 *    case"above_maximum":return vN;case"unusable":return}}`
 * in_range → as-is; below_minimum → clamp UP to 100k; above_maximum → clamp
 * DOWN to 1M; unusable → undefined (env IGNORED, resolver falls through to
 * settings/auto).
 */
export function resolveAutoCompactWindowEnvTokens(
  rawEnv: string | undefined,
): number | undefined {
  if (rawEnv === undefined) {
    return undefined
  }
  const parsed = parseAutoCompactWindowEnv(rawEnv)
  switch (parsed.kind) {
    case 'in_range':
      return parsed.tokens
    case 'below_minimum':
      return AUTO_COMPACT_WINDOW_MIN
    case 'above_maximum':
      return AUTO_COMPACT_WINDOW_MAX
    case 'unusable':
      return undefined
  }
}

/** Official `v4t=32` — the env-warning value sanitize cap. */
const ENV_WARNING_SANITIZE_MAX = 32

/**
 * Official `I(e,n,r=n+"s")` (@191972157) — minimal pluralize helper (same
 * shape as transcriptAdmission.ts `pluralizeForResumeWarn`).
 */
function pluralizeWindowToken(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return count === 1 ? singular : plural
}

/**
 * Port of the official `E4t` warning builder (byte-verified @246817300).
 * Returns the message for a parsed env value, or null when in_range (no
 * warning). Official:
 *   `s=\`CLAUDE_CODE_AUTO_COMPACT_WINDOW="${re(e,32).replace(/[^\w.,+ $%{}=;-]+/g,"?")}${e.length>32?"…":""}"\``
 *   `h=\`${gP/1000}k\`` ("100k"); `y=\`${vN/1e6}M\`` ("1M")
 *   `S=\`Set it to a size from ${h} to ${y}, such as 200k or 200000, or unset it.\``
 *   below_minimum → `${s} reads as ${tokens.toLocaleString("en-US")} ${I(tokens,"token")}, so Claude Code treats it as the ${h} minimum. ${S}`
 *   above_maximum → `${s} is too large, so Claude Code treats it as the ${y} maximum. ${S}`
 *   unusable      → `${s} isn't a usable size, so Claude Code ignores it. ${S}`
 * `re(e,32)` truncates the raw value to 32 chars BEFORE the char filter; the
 * "…" suffix is appended when the ORIGINAL value is longer than 32.
 */
export function buildAutoCompactWindowEnvMessage(
  rawEnv: string,
  parsed: AutoCompactWindowSizeParse,
): string | null {
  if (parsed.kind === 'in_range') {
    return null
  }
  const truncated =
    rawEnv.length > ENV_WARNING_SANITIZE_MAX
      ? rawEnv.slice(0, ENV_WARNING_SANITIZE_MAX)
      : rawEnv
  const sanitized = truncated.replace(/[^\w.,+ $%{}=;-]+/g, '?')
  const ellipsis = rawEnv.length > ENV_WARNING_SANITIZE_MAX ? '…' : ''
  const value = `${ENV_WINDOW_KEY}="${sanitized}${ellipsis}"`
  const minLabel = `${AUTO_COMPACT_WINDOW_MIN / 1000}k`
  const maxLabel = `${AUTO_COMPACT_WINDOW_MAX / 1e6}M`
  const advice = `Set it to a size from ${minLabel} to ${maxLabel}, such as 200k or 200000, or unset it.`
  switch (parsed.kind) {
    case 'below_minimum':
      return `${value} reads as ${parsed.tokens.toLocaleString('en-US')} ${pluralizeWindowToken(parsed.tokens, 'token')}, so Claude Code treats it as the ${minLabel} minimum. ${advice}`
    case 'above_maximum':
      return `${value} is too large, so Claude Code treats it as the ${maxLabel} maximum. ${advice}`
    case 'unusable':
      return `${value} isn't a usable size, so Claude Code ignores it. ${advice}`
  }
}

/**
 * Official `XFe` (msg-or-null convenience wrapper around `E4t`): parse the
 * raw env value and return the warning message, or null when the value is
 * in range. Callers: `/config` auto-compact-window display (official
 * `p=XFe(...);if(p!==null)u.push(p)` @260148727 region) and the
 * /autocompact non-interactive describe builder.
 */
export function buildAutoCompactWindowEnvWarning(
  rawEnv: string | undefined,
): string | null {
  if (rawEnv === undefined) {
    return null
  }
  return buildAutoCompactWindowEnvMessage(rawEnv, parseAutoCompactWindowEnv(rawEnv))
}

/**
 * Port of the official startup emitter `ySs` (@246816655). Official wiring
 * (@255784526):
 *   `if(!Qt)ySs(a.CLAUDE_CODE_AUTO_COMPACT_WINDOW,{interactive:!L,
 *    headless:(s)=>_ot(s,{key:"auto-compact-window-env",outputFormat:V,
 *    debugLine:\`[autocompact] ${s}\`})})`
 * Logs the `compact_window_env` telemetry event for the warn-worthy kinds
 * (below_minimum/above_maximum/unusable — the kinds the official event
 * enumerates), then surfaces the message: interactive → `[autocompact] <msg>`
 * on stderr (OCC's startup-warning precedent, main.tsx `process.stderr.write`);
 * headless → the provided callback (official `_ot` routes by outputFormat).
 *
 * `below_minimum_flag_accepts` records whether the /autocompact FLAG parser
 * (`wQt` = bareThousands:true → OCC parseAutoCompactWindowInput) would accept
 * the same raw value — the env "200" case warns (below_minimum) even though
 * `/autocompact 200` is valid shorthand, and the flag distinguishes it.
 *
 * EXPORTED for main.tsx startup wiring (Leader applies the one-liner; see
 * docs/gap-research-304/impl-WP5.md §Integration wiring).
 */
export function warnAutoCompactWindowEnv(
  rawEnv: string | undefined,
  options: {
    interactive?: boolean
    headless?: (message: string) => void
  },
): void {
  if (rawEnv === undefined) {
    return
  }
  const parsed = parseAutoCompactWindowEnv(rawEnv)
  if (parsed.kind === 'in_range') {
    return
  }
  logEvent('compact_window_env', {
    kind: parsed.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(parsed.kind === 'below_minimum' && {
      below_minimum_flag_accepts: parseAutoCompactWindowInput(rawEnv) !== undefined,
    }),
  })
  const message = buildAutoCompactWindowEnvMessage(rawEnv, parsed)
  if (message === null) {
    return
  }
  if (options.interactive) {
    process.stderr.write(`[autocompact] ${message}\n`)
  } else {
    options.headless?.(message)
  }
}

/**
 * Port of the official `WIt` aggregation (byte-verified from the 2.1.288 ELF
 * @216490426). Walks the enabled settings sources in priority order:
 *
 * - Per-file, every defined `modelSettings[key].autoCompactWindow` is folded
 *   onto the canonical key (`iV`); an exact-key spelling wins over a
 *   canonical collision within the same file (`d===n||!Object.hasOwn(e,n)`).
 * - A file WITHOUT a top-level `autoCompactWindow` MERGES its per-model map
 *   into the accumulation and keeps the prior default.
 * - A file WITH a top-level scalar REPLACES the whole contribution: default
 *   becomes that scalar and byModel becomes exactly this file's map.
 *
 * Prototype-key safety: a hostile `modelSettings.__proto__` entry assigns
 * through the plain object's setter exactly like the official `{}` map — it
 * never becomes an own key of the aggregate and never touches
 * Object.prototype (the schema preprocess strips such keys in production).
 */
export function aggregateAutoCompactWindow(): AutoCompactWindowAggregate {
  let aggregate: AutoCompactWindowAggregate = {
    default: undefined,
    byModel: {},
  }
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (!settings) {
      continue
    }
    const perModel: Record<string, AutoCompactWindowValue> = {}
    for (const [key, entry] of Object.entries(settings.modelSettings ?? {})) {
      const value = (entry as { autoCompactWindow?: AutoCompactWindowValue } | undefined)
        ?.autoCompactWindow
      if (value === undefined) {
        continue
      }
      // CC 2.1.302 #07: alias-conditional normalize (official dFt) BEFORE
      // canonicalize — a bare 'opus' settings key resolves to the concrete
      // default Opus; a concrete (incl. gateway-prefixed) key passes through
      // untouched.
      const canonicalKey = getCanonicalName(normalizeModelSpecifier(key))
      if (key === canonicalKey || !Object.hasOwn(perModel, canonicalKey)) {
        perModel[canonicalKey] = value
      }
    }
    aggregate =
      settings.autoCompactWindow === undefined
        ? {
            default: aggregate.default,
            byModel: { ...aggregate.byModel, ...perModel },
          }
        : { default: settings.autoCompactWindow, byModel: perModel }
  }
  return aggregate
}

/**
 * Port of the official `Dw` resolver (env / settings / auto branches — the
 * staged "experiment"/"clientdata"/"unknown-model"/"model-default" branches
 * are Anthropic-backend-bound). Official settings branch:
 *   `H = typeof n!=="object" ? n : Object.hasOwn(n.byModel,settingsKey)
 *        ? n.byModel[settingsKey] : n.default`
 *   `if (H!==undefined && H!=="auto")
 *        return {window:min(ctx,H), configured:H, source:"settings"}`
 * An explicit per-model "auto" therefore BLOCKS fallback to the default.
 * Final auto branch: `{window:ctx, configured:ctx, source:"auto"}` —
 * `configured` is always a number.
 */
export function resolveAutoCompactWindow(
  model: string,
  contextWindow: number,
  override: AutoCompactWindowOverride,
): ResolvedAutoCompactWindow {
  // Official ceiling branch, as amended by CC 2.1.312 (item 23, byte-verified):
  //   v311 `US` @249997782: `if(S.source==="env"||S.window<=w)return S`
  //   v312 `VS` @249961062: `if(S.window<=w)return S`
  // The env-var window is NO LONGER exempt from the subagent ceiling; the
  // ceiling applies whenever the inherited window is larger than it.
  if (isAutoCompactWindowCeiling(override)) {
    const inner = resolveAutoCompactWindow(model, contextWindow, override.inner)
    if (inner.window <= override.ceiling) return inner
    return {
      window: Math.min(contextWindow, override.ceiling),
      configured: override.ceiling,
      source: 'settings',
    }
  }

  // CC 2.1.304 #41: official `Yb` env branch (@246820905) —
  //   `let h=T4t(env);if(h!==void 0)return{window:Math.min(s,h),configured:h,source:"env"}`
  // k/M suffixes are honored, below-minimum clamps UP to 100k, above-maximum
  // clamps DOWN to 1M, and an unusable value is IGNORED (falls through to
  // settings/auto). Replaces OCC's pre-304 `parseInt > 0` divergence (the
  // "200k"→parseInt→200→window=min(ctx,200) bug).
  const envTokens = resolveAutoCompactWindowEnvTokens(
    process.env[ENV_WINDOW_KEY],
  )
  if (envTokens !== undefined) {
    return {
      window: Math.min(contextWindow, envTokens),
      configured: envTokens,
      source: 'env',
    }
  }

  // CC 2.1.302 #07: alias-conditional normalize (official dFt) BEFORE
  // canonicalize — a raw specifier ('opus') resolves first; concrete model
  // strings are identity here, so resolved-model callers are unaffected.
  const settingsKey = getCanonicalName(normalizeModelSpecifier(model))
  // Official: `H = typeof n!=="object" ? n : Object.hasOwn(n.byModel,key)
  //   ? n.byModel[key] : n.default`
  let configured: AutoCompactWindowValue | undefined
  if (typeof override === 'object' && override !== null) {
    configured = Object.hasOwn(override.byModel, settingsKey)
      ? override.byModel[settingsKey]
      : override.default
  } else {
    // The override tri-state is aggregate | number | undefined — the
    // non-object cases pass through (undefined stays undefined → auto).
    configured = typeof override === 'number' ? override : undefined
  }
  // Official: `if(H!==void 0&&H!=="auto")` — H is 'auto'|number|undefined, so
  // the guard is exactly `typeof H === 'number'`.
  if (typeof configured === 'number') {
    return {
      window: Math.min(contextWindow, configured),
      configured,
      source: 'settings',
    }
  }

  return { window: contextWindow, configured: contextWindow, source: 'auto' }
}

/**
 * CC 2.1.300 changelog #10 — port of the official model auto-window resolver
 * `Hno` (byte-verified from the v300 linux-x64 ELF @225877589, offsets into
 * /tmp/cc-fix-300/package/claude). This is the DENOMINATOR of the official
 * warn gate `TAn`: `Math.min(e.contextWindow,o) > Hno(e).window`.
 *
 * CRITICAL: the official `Hno` NEVER reads CLAUDE_CODE_AUTO_COMPACT_WINDOW
 * (no env symbol in the byte-recovered body) — neither do this port. The
 * env/settings override participates only in the NUMERATOR (the user's
 * chosen window), which is what makes the v300 gate meaningful.
 *
 * PORTED (statically recoverable) branches, in official order:
 * 1. The `TG` model-default arm's statically-decidable predicate parts:
 *    `s<1e6` and `q$o` (@225876899:
 *    `function q$o(e,n){if(!uI())return!1;return e||n!==void 0&&n>TG}`,
 *    `uI` = env CLAUDE_CODE_DISABLE_1M_CONTEXT @219025737 → OCC
 *    is1mContextDisabled). Its data inputs (`unclampedButBilledPast200k`
 *    billing history, `native1mInCatalog`/`declared` from the model catalog
 *    via `MGt`→`pRo`, and `fRo` @219027322 = `gBt()&&yv()===void 0&&
 *    bv(e,n)>TG` auth/tier+catalog chain) have NO OCC equivalents — staged
 *    as undefined/false below, so the arm is shape-faithful but inert until
 *    a model catalog lands.
 * 2. The `z$o` model-default table arm (@225876788:
 *    `function z$o(e){if(!Bp())return;if(!Object.hasOwn(AGt,e))return;
 *    return C0e(AGt[e])}`) with `AGt` (@225876600:
 *    `var kge=1e6,AGt={"claude-sonnet-5":{surfaces:{remote_cowork:
 *    {default:500000},"local-agent":{default:500000}},default:kge}}`),
 *    `C0e` entrypoint-surface resolution (@225168460) and `gPt` tier
 *    lookup (@225168388: `function gPt(e,n){if(n&&Object.hasOwn(e,n))
 *    return e[n];return e.default}`). `Bp` (@220257629:
 *    `function Bp(){if(oh())return!1;return Es("autoCompactEnabled",!0)
 *    .value}`) with `oh` (@220257543: `Boolean($e(process.env.
 *    DISABLE_COMPACT)||a.DISABLE_AUTO_COMPACT)`).
 * 3. The final auto fallback `{window:s,configured:s,source:"auto"}`.
 *
 * STAGED (Anthropic-backend-bound; each documented at its skip point):
 * - clientdata arm — `e.clientDataAutoCompactWindow` comes from the
 *   bootstrap server-driven cache (`cho`/`Y0s`/`X0s` rowan_thicket
 *   plumbing); OCC has no such cache → `w` is always
 *   `{window:null,replacesDefault:false}` (arm cannot fire; the
 *   replacesDefault=false value keeps the z$o arm unsuppressed).
 * - experiment arm — `qGe` = `PGt(e.canonical)??G$o(e)` (experiment/
 *   growthbook plumbing); OCC has no experiment store → undefined.
 * - native1mHere arm — `e.native1mHere` is a catalog/bootstrap field OCC
 *   model descriptors do not carry.
 * - unknown-model arm — `IGt(e,S)` consumes catalog fields
 *   (`recognized`, `optIn1mHonored`, `d1e`) OCC lacks.
 * - `Rr` tier context inside C0e/gPt — `Rr` (@219110899) resolves the
 *   account subscription type ("max"/"pro"/"team") from OAuth account
 *   state; OCC carries no subscription state → staged undefined, and
 *   `gPt` collapses to `leaf.default` exactly as the official does for a
 *   falsy tier (`n&&Object.hasOwn(e,n)` guard).
 */
export type ModelAutoWindowInput = {
  readonly model: string
  readonly contextWindow: number
  readonly canonical: string
}

export type ResolvedModelAutoWindow = {
  readonly window: number
  readonly configured: number
  readonly source:
    | 'clientdata'
    | 'experiment'
    | 'model-default'
    | 'unknown-model'
    | 'auto'
}

/** Official `TG` (byte-verified @219025550: `var v9e=200000,TG=200000,…`). */
export const TG_MODEL_DEFAULT_WINDOW = 200_000

/** Official `kge` (byte-verified @225876612: `var kge=1e6,…`). */
export const KGE_MODEL_TABLE_DEFAULT = 1_000_000

/** Official AGt surface default (byte-verified @225876625: `{default:500000}`). */
const SURFACE_DEFAULT_WINDOW = 500_000

/** A `gPt`-shaped leaf: `.default` plus optional per-subscription-tier keys. */
type WindowTableLeaf = {
  readonly default?: number
  readonly [tier: string]: number | undefined
}

/** A `C0e`-shaped AGt entry: a bare number, or `{surfaces?, default?}`. */
type WindowTableEntry =
  | number
  | {
      readonly surfaces?: Record<string, WindowTableLeaf>
      readonly default?: number
    }

/**
 * Official `AGt` (byte-verified @225876600) — the static per-model default
 * window table keyed by CANONICAL model name.
 */
const MODEL_WINDOW_DEFAULTS: Record<string, WindowTableEntry> = {
  'claude-sonnet-5': {
    surfaces: {
      remote_cowork: { default: SURFACE_DEFAULT_WINDOW },
      'local-agent': { default: SURFACE_DEFAULT_WINDOW },
    },
    default: KGE_MODEL_TABLE_DEFAULT,
  },
}

/**
 * Official `Bp` (@220257629) + `oh` (@220257543). OCC analogs: the env
 * truthy parse `$e` = isEnvTruthy (the same helper services/compact/
 * autoCompact.ts uses for these two vars); `Es("autoCompactEnabled",!0)
 * .value` = getGlobalConfig().autoCompactEnabled (boolean, default true —
 * config.ts; the `!== false` keeps the official default-true semantics for
 * a missing/loosely-typed config value).
 */
function isAutoCompactWindowTuningEnabled(): boolean {
  if (
    isEnvTruthy(process.env.DISABLE_COMPACT) ||
    isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)
  ) {
    return false
  }
  return getGlobalConfig().autoCompactEnabled !== false
}

/**
 * Official `Rr` (@219110899) — subscription-tier resolver, STAGED: it reads
 * OAuth account state (`Mn()` / `$E()` → "max"/"pro"/"team"); OCC carries no
 * subscription state, so the tier context is undefined and `gPt` returns the
 * leaf `.default` (byte-faithful for a falsy tier).
 */
function resolveSubscriptionTierContext(): string | undefined {
  return undefined
}

/**
 * Official `gPt` (byte-verified @225168388):
 *   `function gPt(e,n){if(n&&Object.hasOwn(e,n))return e[n];return e.default}`
 */
function applyTierToWindowLeaf(
  leaf: WindowTableLeaf,
  tier: string | undefined,
): number | undefined {
  if (tier && Object.hasOwn(leaf, tier)) {
    return leaf[tier]
  }
  return leaf.default
}

/**
 * Official `C0e` (byte-verified @225168460): number → as-is; object →
 * entrypoint-surface leaf first (CLAUDE_CODE_ENTRYPOINT is a key of
 * `surfaces`), then the table-level rest; each leaf through `gPt` with the
 * (staged) `Rr()` tier context.
 */
function resolveWindowTableEntry(
  entry: WindowTableEntry,
): number | undefined {
  if (typeof entry === 'number') {
    return entry
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return undefined
  }
  const { surfaces, ...rest } = entry
  const tier = resolveSubscriptionTierContext()
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  const surfaceEntry =
    entrypoint && surfaces && Object.hasOwn(surfaces, entrypoint)
      ? surfaces[entrypoint]
      : undefined
  if (surfaceEntry) {
    const value = applyTierToWindowLeaf(surfaceEntry, tier)
    if (value !== undefined) {
      return value
    }
  }
  return applyTierToWindowLeaf(rest, tier)
}

/**
 * Official `z$o` (byte-verified @225876788):
 *   `function z$o(e){if(!Bp())return;if(!Object.hasOwn(AGt,e))return;
 *    return C0e(AGt[e])}`
 * (`e` is the CANONICAL model name.)
 */
function resolveModelDefaultWindowConfigured(
  canonical: string,
): number | undefined {
  if (!isAutoCompactWindowTuningEnabled()) {
    return undefined
  }
  if (!Object.hasOwn(MODEL_WINDOW_DEFAULTS, canonical)) {
    return undefined
  }
  return resolveWindowTableEntry(MODEL_WINDOW_DEFAULTS[canonical])
}

/**
 * Official `q$o` (byte-verified @225876899):
 *   `function q$o(e,n){if(!uI())return!1;return e||n!==void 0&&n>TG}`
 * (`uI` @219025737 = env CLAUDE_CODE_DISABLE_1M_CONTEXT → OCC
 * is1mContextDisabled). Both data inputs are backend catalog values OCC
 * does not carry — callers stage them as undefined.
 */
function is1mCatalogWindowSuppressed(
  native1mInCatalog: boolean | undefined,
  declaredWindow: number | undefined,
): boolean {
  if (!is1mContextDisabled()) {
    return false
  }
  return Boolean(
    native1mInCatalog ||
      (declaredWindow !== undefined &&
        declaredWindow > TG_MODEL_DEFAULT_WINDOW),
  )
}

/** Port of the official `Hno` static subset — see the big docblock above. */
export function resolveModelAutoWindow(
  input: ModelAutoWindowInput,
): ResolvedModelAutoWindow {
  const { contextWindow, canonical } = input

  // STAGED clientdata arm: `w = Bp() ? e.clientDataAutoCompactWindow :
  // {window:null,replacesDefault:!1}` — OCC has no bootstrap cache, so
  // w.window===null (arm inert) and w.replacesDefault===false (z$o arm
  // unsuppressed).
  const clientDataReplacesDefault = false

  // STAGED experiment arm: `qGe(e)` = `PGt(e.canonical)??G$o(e)` — no
  // experiment store in OCC → undefined.

  // TG arm (@225877589 third branch). Staged data inputs (no OCC model
  // descriptor carries them): unclampedButBilledPast200k (billing history),
  // native1mInCatalog/declaredWindow (catalog via MGt→pRo), fRo (auth/tier
  // backend chain gBt/yv/bv → staged false). Shape-faithful, inert in OCC.
  const unclampedButBilledPast200k: boolean | undefined = undefined
  const native1mInCatalog: boolean | undefined = undefined
  const declaredWindow: number | undefined = undefined
  if (
    contextWindow < KGE_MODEL_TABLE_DEFAULT &&
    (unclampedButBilledPast200k === true ||
      is1mCatalogWindowSuppressed(native1mInCatalog, declaredWindow))
  ) {
    return {
      window: Math.min(contextWindow, TG_MODEL_DEFAULT_WINDOW),
      configured: TG_MODEL_DEFAULT_WINDOW,
      source: 'model-default',
    }
  }

  // z$o model-default table arm: `K = w.replacesDefault ? void 0 : z$o(h)`.
  const modelDefault = clientDataReplacesDefault
    ? undefined
    : resolveModelDefaultWindowConfigured(canonical)
  if (modelDefault !== undefined) {
    return {
      window: Math.min(contextWindow, modelDefault),
      configured: modelDefault,
      source: 'model-default',
    }
  }

  // STAGED native1mHere arm (`s>=kge && !w.replacesDefault && Bp() &&
  // e.native1mHere`) and STAGED unknown-model arm (`Bp() &&
  // !CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT && IGt(e,S)`) —
  // both consume backend catalog fields OCC lacks.

  // Final auto fallback: `{window:s,configured:s,source:"auto"}`.
  return { window: contextWindow, configured: contextWindow, source: 'auto' }
}

/**
 * CC 2.1.300 changelog #10 — port of the official warning gate `TAn`
 * (byte-verified from the v300 linux-x64 ELF @239116220, offsets into
 * /tmp/cc-fix-300/package/claude):
 *
 *   `function TAn(e,o){return Math.min(e.contextWindow,o)>Hno(e).window}`
 *
 * The v300 `/autocompact` describe builder gates the "Overriding auto may
 * result in high token usage…" warning behind `cCt(u)&&TAn(r,s)`
 * (@239116094; `cCt` = source is env/settings @225878936, `s` = the chosen
 * window) — v299 warned on ANY override (@237779900: `if(dTt(t))…`), so
 * choosing a SMALLER window than auto wrongly warned about high token usage.
 *
 * @param model          the model whose auto window is resolved
 * @param contextWindow  the model's context window (official `e.contextWindow`)
 * @param chosenWindow   the user-chosen window (official `o`)
 * @returns true only when the capped chosen window EXCEEDS the model's auto
 *          window (`Hno(e).window` — canonicalized via getCanonicalName for
 *          the AGt table lookup, mirroring the official `e.canonical`)
 *
 * ALIGNMENT (2.1.300 P1-1 fix): the denominator is `resolveModelAutoWindow`
 * (the official `Hno` static subset), which IGNORES
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW exactly like the official. The previous
 * OCC denominator `resolveAutoCompactWindow(model, ctx, undefined)` was
 * env-aware, so with the env var set the denominator collapsed to the chosen
 * value and without it the auto branch returned ctx ≥ min(ctx, chosen) —
 * the warning branch was structurally dead under every reachable config.
 */
export function chosenWindowExceedsAutoWindow(
  model: string,
  contextWindow: number,
  chosenWindow: number,
): boolean {
  // CC 2.1.302 #07: alias-conditional normalize (official dFt) BEFORE
  // canonicalize — the AGt table lookup key must match the writer's key when
  // the model arrives as a raw specifier.
  const canonical = getCanonicalName(normalizeModelSpecifier(model))
  return (
    Math.min(contextWindow, chosenWindow) >
    resolveModelAutoWindow({ model, contextWindow, canonical }).window
  )
}

/**
 * Port of the official `Mqr` writer (byte-verified @203106890):
 *   `let s=iV(e); return Object.hasOwn(Object.prototype,s)
 *      ? r : {modelSettings:{[s]:n}}`
 * A model whose canonical key collides with an Object.prototype property
 * ("__proto__", "constructor", …) falls back to the TOP-LEVEL patch instead
 * of writing a prototype-polluting modelSettings key.
 *
 * @param model           the raw model id (normalized via getCanonicalName)
 * @param perModelValue   `n.autoCompactWindow` — parsed value or 'auto'
 * @param topLevelValue   `r.autoCompactWindow` — number, or undefined to
 *                        DELETE the top-level key (auto reset)
 */
export function buildAutoCompactWindowPatch(
  model: string,
  perModelValue: AutoCompactWindowValue,
  topLevelValue: number | undefined,
): SettingsJson {
  // CC 2.1.302 #07: alias-conditional normalize (official dFt) BEFORE
  // canonicalize (official v302 key builder = Ke ∘ dFt) — a raw 'opus'
  // specifier resolves to the concrete default Opus instead of leaking the
  // literal alias as the settings key; a gateway-prefixed concrete name
  // (anthropic/claude-opus-4-1) passes through untouched and keys under its
  // own canonical name. The Object.prototype guard below is kept as-is
  // (≡ official ETo/Mqr).
  const settingsKey = getCanonicalName(normalizeModelSpecifier(model))
  if (Object.hasOwn(Object.prototype, settingsKey)) {
    return { autoCompactWindow: topLevelValue }
  }
  return {
    modelSettings: { [settingsKey]: { autoCompactWindow: perModelValue } },
  }
}

/**
 * Port of the official `XEo` session-override mapper (2.1.288; replaces the
 * 2.1.221 `Fju` scalar merge): undefined (no CLI flag) → the settings
 * aggregate so per-model windows resolve; "auto" → undefined (explicitly
 * cleared — auto even if settings say otherwise); number → as-is.
 */
export function resolveAutoCompactWindowOverride(
  cliValue: AutoCompactWindowValue | undefined,
): AutoCompactWindowOverride {
  if (cliValue === undefined) {
    return aggregateAutoCompactWindow()
  }
  return cliValue === 'auto' ? undefined : cliValue
}

// Session-scoped resolved window override. Set once from main.tsx after CLI
// options are parsed (and refreshed by the /autocompact setter); read by the
// compaction threshold math in services/compact/autoCompact.ts. Mirrors the
// official flow where the bootstrap computes `XEo(options.autocompact)` and
// threads it through the query options.
let sessionAutoCompactWindow: AutoCompactWindowOverride

export function setSessionAutoCompactWindow(
  window: AutoCompactWindowOverride,
): void {
  sessionAutoCompactWindow = window
}

export function getSessionAutoCompactWindow(): AutoCompactWindowOverride {
  return sessionAutoCompactWindow
}
