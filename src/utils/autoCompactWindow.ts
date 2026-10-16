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
 * The official additionally resolves server-driven windows ("experiment" /
 * "clientdata" sources via the bootstrap `auto_compact_windows` cache) and an
 * "unknown-model" default window — Anthropic-backend-bound and staged (see
 * the `resolveModelAutoWindow` docblock and
 * docs/upstream-version-gap-occ58.md / docs/gap-research-288).
 */
import { getGlobalConfig } from './config.js'
import { is1mContextDisabled } from './context.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
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

// Official `ZHh` (byte-verified): exponent notation must parse to an INTEGER.
const EXPONENT_NOTATION_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/
// Official `W9l` shape (leading pattern byte-verified; grouped-thousands
// layout inferred): comma-separated thousands, e.g. "1,000,000".
const COMMA_SEPARATED_RE = /^[+-]?\d{1,3}(,\d{3})+$/

/**
 * Port of the official bare-number parser `xp` = `eRh(t) ?? parseInt(t, 10)`:
 * exponent notation must yield an integer; comma-grouped numbers are
 * stripped and parseInt'ed; everything else falls through to parseInt
 * (so "200.5" -> 200, matching the official leading-integer semantics).
 */
function parseBareNumber(raw: string): number {
  if (EXPONENT_NOTATION_RE.test(raw)) {
    const value = Number(raw)
    return Number.isInteger(value) ? value : NaN
  }
  if (COMMA_SEPARATED_RE.test(raw)) {
    return parseInt(raw.replace(/,/g, ''), 10)
  }
  return parseInt(raw, 10)
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
      const canonicalKey = getCanonicalName(key)
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
 *
 * DIVERGENCE (documented): env parsing keeps OCC's pre-existing
 * `parseInt > 0` semantics (official `JIe` validation not recovered).
 */
export function resolveAutoCompactWindow(
  model: string,
  contextWindow: number,
  override: AutoCompactWindowOverride,
): ResolvedAutoCompactWindow {
  // Official 2.1.296 ceiling branch (byte-verified, `iv`):
  //   `if(nIt(n)){let _e=iv(e,n.inner,r),{ceiling:ke}=n;
  //     if(_e.source==="env"||_e.window<=ke)return _e;
  //     return{window:Math.min(h,ke),configured:ke,source:"settings"}}`
  // An env-var window is EXEMPT from the subagent ceiling; otherwise the
  // ceiling only applies when the inherited window is larger than it.
  if (isAutoCompactWindowCeiling(override)) {
    const inner = resolveAutoCompactWindow(model, contextWindow, override.inner)
    if (inner.source === 'env' || inner.window <= override.ceiling) return inner
    return {
      window: Math.min(contextWindow, override.ceiling),
      configured: override.ceiling,
      source: 'settings',
    }
  }

  const envRaw = process.env[ENV_WINDOW_KEY]
  if (envRaw) {
    const parsed = parseInt(envRaw, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return {
        window: Math.min(contextWindow, parsed),
        configured: parsed,
        source: 'env',
      }
    }
  }

  const settingsKey = getCanonicalName(model)
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
  const canonical = getCanonicalName(model)
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
  const settingsKey = getCanonicalName(model)
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
