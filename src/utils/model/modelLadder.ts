/**
 * CC 2.1.286 (item-B): previous-model-of-same-tier fallback ladder.
 *
 * Official changelog: "Fixed every turn failing when the Anthropic API
 * refuses the model your default or a model alias resolves to: Claude Code
 * now retries once on the previous model of the same tier."
 *
 * When the API refuses the resolved model (404 `model:` not-found / 403
 * `model:` permission-denied) at the TAIL of the refusal-retry chain, and the
 * model was NOT explicitly chosen by the user (CLI/settings) and did NOT come
 * from a raw ANTHROPIC_DEFAULT_*_MODEL env value, the ladder computes the
 * previous model of the same tier from the chronological catalog — suffix
 * ([1m]) preserving, cutting at the first deprecated model — and threads it
 * as `accessFallbackModel` so withRetry can fall back without a CLI
 * `--fallback-model`.
 *
 * Binary references (v286 ELF, byte-verified; ladder region dumped to
 * /tmp/cc-diff-286/w286_ladder*.txt, catalog `fo`/`Hu` @197605159):
 *   - `Bu(e)` tier by catalog-key prefix; `Dm(e)` id→catalog key;
 *     `gNe(e,n)` walk `Hu` BACKWARDS collecting same-tier keys;
 *     `CCo(e)` = Dm→Bu→gNe→firstParty ids.
 *   - `oPr(e)` @199362534-region: gates `xa()` (firstParty + 1P base URL),
 *     `!d9e()` (no fallback-disable env), `R("tengu_nifty_finch",!0)`;
 *     `let n=kt(e),r=e.slice(n.length),s=[n,...CCo(n)],
 *      h=s.findIndex((S)=>d7(S)||Wgn(S)),
 *      g=(h<0?s:s.slice(0,h)).slice(1).find((S)=>(r===""||cj(S))&&!hNe(S,e));
 *      return g===void 0?void 0:g+r`
 *   - `GBn(e,n,r)` chain guard @212168274 call site; `zRe(e)` env-default
 *     check; `GYn(e)` @199418005 user-explicit check; `OI(e)` @199417435
 *     subagent-model check; `oIe(e)` alias-or-single-1m-alias;
 *     `hNe(e,n)`/`ere(e,n)` @199394813 skip-if-not-allowed-or-smaller-window;
 *     `cI(e,n)` suffix-insensitive equality; `d9e()` @199387813.
 *
 * STAGED (recovered, not ported — query-engine/compaction wiring is outside
 * the retry modules): the two consumption sites — main query engine @212168274
 * `let A=GBn(Ze,st,ce)` threaded as `accessFallbackModel:A` @212172692, and
 * the compaction loop @205984812 `Fe=rre(Ie,ze),Ge=0;while(!0){let yt=mt??
 * Fe[Ge],gt=GBn(Fe,Ge,yt),…}`.
 */
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getContextWindowForModel, modelSupports1M } from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { isModelAlias } from './aliases.js'
import { type ModelKey, ALL_MODEL_CONFIGS } from './configs.js'
import { isModelDeprecated } from './deprecation.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  firstPartyNameToCanonical,
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
} from './model.js'
import { stripTrailing1mTag } from './modelOptions.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

/** Binary `Bu(e)` — tier by catalog-key prefix (fable/other → undefined). */
export function modelTier(
  catalogKey: string,
): 'sonnet' | 'opus' | 'haiku' | undefined {
  if (catalogKey.startsWith('sonnet')) return 'sonnet'
  if (catalogKey.startsWith('opus')) return 'opus'
  if (catalogKey.startsWith('haiku')) return 'haiku'
  return undefined
}

/**
 * Binary `Hu = Object.keys(fo)` — the catalog keys in insertion
 * (chronological) order. OCC's ALL_MODEL_CONFIGS key order is byte-aligned
 * with the official catalog order (verified against w286_fo.txt @197605159).
 */
export function catalogKeysChronological(): ModelKey[] {
  return Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]
}

/**
 * Binary `Dm(e)` — resolve a model id to its catalog key. The official walks
 * `Hu` comparing `Fb(config.firstParty)===Fb(id)` (normalizer); OCC's
 * established pure normalizer is `firstPartyNameToCanonical` (strips
 * provider prefixes/dates via the canonical substring table).
 */
export function catalogKeyForModel(model: string): ModelKey | undefined {
  const canonical = firstPartyNameToCanonical(model)
  for (const key of catalogKeysChronological()) {
    if (firstPartyNameToCanonical(ALL_MODEL_CONFIGS[key].firstParty) === canonical) {
      return key
    }
  }
  return undefined
}

/**
 * Binary `CCo(e)` (= Dm→Bu→gNe→map): older same-tier catalog entries'
 * firstParty ids, walking the chronological key list BACKWARDS from the
 * model's own key (so nearest-older first).
 */
export function olderSameTierFirstPartyIds(model: string): string[] {
  const key = catalogKeyForModel(model)
  const tier = key === undefined ? undefined : modelTier(key)
  if (key === undefined || tier === undefined) {
    return []
  }
  const keys = catalogKeysChronological()
  const startIndex = keys.indexOf(key)
  const older: string[] = []
  for (let i = startIndex - 1; i >= 0; i--) {
    if (modelTier(keys[i]) === tier) {
      older.push(ALL_MODEL_CONFIGS[keys[i]].firstParty)
    }
  }
  return older
}

/**
 * Binary `d9e()` @199387813 (byte-verified):
 *   return a.CLAUDE_CODE_NO_MODEL_FALLBACK===!0||
 *          a.CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK===!0
 */
export function isModelFallbackDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_NO_MODEL_FALLBACK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK)
  )
}

/** Binary `xa(){return Pe()==="firstParty"&&Us()}` — 1P provider + 1P base URL. */
export function isFirstPartyModelLadderEnabled(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Binary `ere(e,n)` @199394813: `um(n,Cf())<um(e,Cf())` — does the resolved
 * candidate have a SMALLER context window than the current model?
 * Documented simplification: the official passes sdk betas (`Cf()`) into the
 * window lookup; OCC's pure-util callers have no beta list at this layer, so
 * the betas argument is omitted (`getContextWindowForModel` treats it as
 * optional; `[1m]`-suffixed candidates still resolve to 1M via has1mContext).
 */
function hasSmallerContextWindow(current: string, candidate: string): boolean {
  return getContextWindowForModel(candidate) < getContextWindowForModel(current)
}

/**
 * Binary `hNe(e,n)` (e=candidate, n=current):
 *   let r=n.slice(kt(n).length);
 *   return !Hr(e+r)||ere(n,kt(e)+r)
 * Skip a candidate when it (with the current suffix re-appended) is not an
 * allowed model, or when it would shrink the context window.
 */
function isSkippedLadderCandidate(candidate: string, current: string): boolean {
  const currentBase = stripTrailing1mTag(current)
  const suffix = current.slice(currentBase.length)
  if (!isModelAllowed(candidate + suffix)) {
    return true
  }
  return hasSmallerContextWindow(current, stripTrailing1mTag(candidate) + suffix)
}

/**
 * Binary `oPr(e)` — THE FIX. The previous model of the same tier, suffix
 * preserving, cut at the first deprecated/remapped entry. Returns undefined
 * when the ladder is gated off or no eligible older model exists.
 */
export function previousModelOfSameTier(model: string): string | undefined {
  if (
    !isFirstPartyModelLadderEnabled() ||
    isModelFallbackDisabled() ||
    !getFeatureValue_CACHED_MAY_BE_STALE('tengu_nifty_finch', true)
  ) {
    return undefined
  }
  const base = stripTrailing1mTag(model) // binary `kt(e)`
  const suffix = model.slice(base.length) // binary `r` (e.g. "[1m]")
  const candidates = [base, ...olderSameTierFirstPartyIds(base)] // binary `s`
  // Binary `h=s.findIndex((S)=>d7(S)||Wgn(S))` — stop at the first
  // deprecated/remapped model. Documented simplification: OCC's
  // isModelDeprecated covers both arms (see deprecation.ts note).
  const cutIndex = candidates.findIndex(candidate => isModelDeprecated(candidate))
  const eligible = (cutIndex < 0 ? candidates : candidates.slice(0, cutIndex))
    .slice(1) // drop self
    // Binary `(r===""||cj(S))&&!hNe(S,e)` — a "[1m]" suffix only lands on
    // 1M-capable models (cj ≡ modelSupports1M); skip disallowed/shrinking.
    .find(
      candidate =>
        (suffix === '' || modelSupports1M(candidate)) &&
        !isSkippedLadderCandidate(candidate, model),
    )
  return eligible === undefined ? undefined : eligible + suffix
}

/** Binary `cI(e,n)`: `kt(e).toLowerCase()===kt(n).toLowerCase()`. */
function modelsEqualIgnoringSuffix(a: string, b: string): boolean {
  return (
    stripTrailing1mTag(a).toLowerCase() === stripTrailing1mTag(b).toLowerCase()
  )
}

/**
 * Binary `zRe(e)` (byte-verified): the model came from a raw
 * ANTHROPIC_DEFAULT_*_MODEL env value → the user pinned it, no ladder.
 */
export function isModelFromEnvDefault(model: string): boolean {
  return [
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ].some(value => value !== undefined && modelsEqualIgnoringSuffix(value, model))
}

/**
 * Binary `oIe(e)`: `if($g(e))return!0;let n=kt(e);return n!==e&&kt(n)===n&&
 * $g(n)}` — a model alias, or an alias carrying exactly one stable `[1m]`
 * tag.
 */
function isModelAliasSetting(value: string): boolean {
  if (isModelAlias(value)) {
    return true
  }
  const stripped = stripTrailing1mTag(value)
  return (
    stripped !== value &&
    stripTrailing1mTag(stripped) === stripped &&
    isModelAlias(stripped)
  )
}

/**
 * Binary `OI(e)` @199417435 (byte-verified): CLAUDE_CODE_SUBAGENT_MODEL is
 * explicitly set (not inherit/default/alias) and resolves to this model —
 * the bedrock-style `xx.anthropic.` prefix is normalized on the comparison
 * side that lacks it (`g=/^[a-z-]+\.(?=anthropic\.)/`).
 */
function isSubagentModelExplicit(model: string): boolean {
  const raw = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim().toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'default' || isModelAliasSetting(raw)) {
    return false
  }
  const resolved = stripTrailing1mTag(
    parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL as string),
  )
  const target = stripTrailing1mTag(model)
  const bedrockPrefix = /^[a-z-]+\.(?=anthropic\.)/
  return bedrockPrefix.test(resolved)
    ? resolved === target
    : resolved === target.replace(bedrockPrefix, '')
}

/**
 * Binary `GYn(e)` @199418005 (byte-verified): the user explicitly chose this
 * model (subagent env, CLI --model, or settings) → no ladder fallback.
 * `Oh()` ≡ getUserSpecifiedModelSetting; `Pt` ≡ parseUserSpecifiedModel.
 */
export function isModelUserExplicit(model: string): boolean {
  if (isSubagentModelExplicit(model)) {
    return true
  }
  const setting = getUserSpecifiedModelSetting()
  if (
    setting == null ||
    String(setting).trim().toLowerCase() === 'default' ||
    isModelAliasSetting(String(setting).trim().toLowerCase())
  ) {
    return false
  }
  // Binary: `return kt(Pt(n))===kt(e)` — exact (case-sensitive) compare.
  return (
    stripTrailing1mTag(parseUserSpecifiedModel(setting)) ===
    stripTrailing1mTag(model)
  )
}

/**
 * Binary `GBn(e,n,r)` — the chain guard. Computes the access-fallback model
 * for the TAIL of a refusal-retry chain, or undefined:
 *   - only at the chain tail (`n!==e.length-1` → no),
 *   - only when the chain agrees with the current model (`r!==e[n]` → no),
 *   - never for a user-explicit model (`GYn`) or raw env default (`zRe`),
 *   - never when the current model is already the ladder result of the
 *     previous chain entry (`oPr(s)===r` — one retry only, then give up),
 *   - never when the candidate's family is already in the chain.
 * Wrapped in try/catch → undefined (byte-faithful).
 */
export function accessFallbackForChain(
  chain: string[],
  step: number,
  current: string,
): string | undefined {
  try {
    const previous = chain[step - 1]
    if (
      step !== chain.length - 1 ||
      current !== chain[step] ||
      isModelUserExplicit(current) ||
      isModelFromEnvDefault(current) ||
      (previous !== undefined && previousModelOfSameTier(previous) === current)
    ) {
      return undefined
    }
    const candidate = previousModelOfSameTier(current)
    return candidate !== undefined &&
      !chain.some(entry => stripTrailing1mTag(entry) === stripTrailing1mTag(candidate))
      ? candidate
      : undefined
  } catch (error) {
    logError(error)
    return undefined
  }
}
