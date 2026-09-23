// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { isClaudeAISubscriber } from '../auth.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import {
  COST_TIER_2_10,
  COST_TIER_3_15,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
  getModelPricingString,
  getOpus5CostTier,
} from '../modelCost.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import {
  getAPIProvider,
  isAnthropicOwnedProvider,
  isFirstPartyAnthropicBaseUrl,
} from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultFableModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  isOpusDefaultTier,
  getOpus46PricingSuffix,
  getOpus55PricingSuffix,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
  resolveAnthropicDefaultModel,
  type ModelName,
  type ModelSetting,
} from './model.js'
import { type ModelAlias, isModelFamilyAlias } from './aliases.js'
import { has1mContext, modelSupports1M } from '../context.js'
import { getGlobalConfig } from '../config.js'
import { readGatewayModelOptions } from './gatewayModelDiscovery.js'
import { ALL_MODEL_CONFIGS, type ModelKey } from './configs.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  if (process.env.USER_TYPE === 'ant') {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const defaultSetting = getDefaultMainLoopModelSetting()
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(defaultSetting)})${getDefaultOptionSuffix(defaultSetting)}`,
  }
}

/**
 * Suffix for the Default (PAYG) picker row.
 *
 * Recovered verbatim from the official 2.1.241 linux-x64 binary — default
 * option builder `Nci` (2.1.245 `se` is shape-identical):
 *
 *   let{setting:t,attribution:r}=wht(),o=e&&Bk(t),
 *   {pricingSuffix:i}=r==="tier"?mSe(o?t:vs(t),o):rIa;   // rIa={pricingSuffix:""}
 *   description:`Use the default model (currently ${gNn(t)})${i}${SHv(r)}`
 *
 * - `wht()` attribution chain: org > env (ANTHROPIC_DEFAULT_MODEL) > enforced
 *   > entitlement > tier (built-in fallback). Pricing appears ONLY for the
 *   "tier" fallback, via `mSe` -> `oNn(fastMode, model)`:
 *     function oNn(e,t){if(!XOn())return"";let r=D4(t),n=e?ght(knr(r)):QFd(r);
 *       if(n===void 0)return"";return` ·${e?` (${LIGHTNING_BOLT})`:""} ${n}`}
 *   XOn() = provider === "firstParty"; QFd = model-catalog tier ->
 *   formatModelPricing, undefined (-> no suffix) for models without a catalog
 *   entry.
 * - `SHv`/`dNn` attribution notes: env -> " · Set by ANTHROPIC_DEFAULT_MODEL",
 *   org -> " · Org default", enforced/entitlement -> " · Set by your
 *   organization", tier -> "".
 * - The fast branch (o = e && Bk(t)) is unreachable where pricing shows: a
 *   fast-capable default (opus-4-8/opus-5) only arrives via
 *   ANTHROPIC_DEFAULT_MODEL (env attribution -> no pricing); the built-in
 *   non-subscriber default is the Sonnet family, which is not fast-capable.
 *
 * OCC has no org/enforced/entitlement subsystems (managed-settings backlog,
 * see OCC-46 staged items), so this mirrors the env-vs-tier split that OCC's
 * getDefaultMainLoopModelSetting can distinguish. The pre-2.1.243 code
 * hardcoded `formatModelPricing(COST_TIER_3_15)` here; the official suffix is
 * the resolved default model's own catalog price (Sonnet 5 -> tier_2_10
 * "$2/$10 per Mtok" since the 2.1.243 repricing).
 */
function getDefaultOptionSuffix(setting: ModelName | ModelAlias): string {
  // env attribution: official shows the note instead of pricing (dNn "env")
  if (resolveAnthropicDefaultModel() !== undefined) {
    return ' · Set by ANTHROPIC_DEFAULT_MODEL'
  }
  // XOn() gate: pricing display is firstParty-only
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = getModelPricingString(parseUserSpecifiedModel(setting))
  return pricing === undefined ? '' : ` · ${pricing}`
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
// Display names + descriptions verified against the official 2.1.200 binary (claude.strings).

/**
 * Pricing suffix for the Opus 5 (`claude-opus-5`) picker rows.
 *
 * Recovered verbatim from the official 2.1.220 linux-x64 binary: the picker
 * option builders `XBc`/`UBc`/`DWi`/`WBc`/`PWi` all source their pricing suffix
 * via `Goe("claude-opus-5", fastMode)`, which returns `_5r(fastMode,
 * "claude-opus-5")` (`getModelPricingSuffix`):
 *   - guard: firstParty only (3P returns "")
 *   - format: ` ·${fastMode ? ` (${LIGHTNING_BOLT})` : ""} ${cost}`
 *   - cost is read dynamically from the opus-5 cost table: base $5/$25,
 *     fast $10/$50 per Mtok (2.1.219 changelog: "fast mode at $10/$50 per Mtok").
 *
 * Local to modelOptions.ts because `getOpus46PricingSuffix` (in model.ts, owned
 * by a separate port) still reads the opus-4-6 cost table; the opus-5 picker
 * rows must read opus-5 cost. Suffix format mirrors `getOpus46PricingSuffix`
 * exactly (same `· (↯) ${pricing}` shape) so row rendering stays consistent.
 */
function getOpus5PricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus5CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

function getSonnet5Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet5 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 5 · Efficient for routine tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_2_10)}`}`,
    descriptionForModel:
      'Sonnet 5 - efficient for routine tasks. Generally recommended for most coding tasks',
  }
}

function getSonnet46Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().sonnet46,
    label: 'Sonnet 4.6',
    description: `Sonnet 4.6 · Previous Sonnet version${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel: 'Sonnet 4.6 - previous Sonnet version',
  }
}

/**
 * Whether the `/model` picker shows the "Custom <tier> model" rows for
 * `ANTHROPIC_DEFAULT_*_MODEL` overrides — binary `xJn` (2.1.220 linux-x64
 * ELF, offset ~249523655):
 *
 *   function xJn(){return!rm()||iW()||!Yd()}
 *   rm(p) = p==="firstParty"||iW(p)||p==="gateway"
 *   iW(p) = p==="anthropicAws"||p==="anthropicGoogleCloud"
 *   Yd()  = _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL || base URL unset ||
 *           base URL host === api.anthropic.com
 *
 * i.e. custom rows appear when the provider is NOT Anthropic-owned
 * (bedrock/vertex/foundry/mantle/…), OR it is anthropicAws/
 * anthropicGoogleCloud, OR `ANTHROPIC_BASE_URL` points away from the
 * first-party API (a firstParty provider behind a proxy — the common
 * LiteLLM/GLM-style setup). OCC's APIProvider folds anthropicGoogleCloud
 * into firstParty; the base-URL clause covers it. OCC-43: this used to gate
 * on provider alone, so a firstParty provider with a custom base URL
 * wrongly showed the stock rows (divergence caught by REPL self-acceptance).
 */
function shouldUseCustomModelOptions(): boolean {
  const provider = getAPIProvider()
  return (
    !isAnthropicOwnedProvider() ||
    provider === 'anthropic_aws' ||
    !isFirstPartyAnthropicBaseUrl()
  )
}

function getCustomFableOption(): ModelOption | undefined {
  const customFableModel = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  // When a custom-model user has a custom fable model string, show it
  // directly (binary NBc: `if(xJn()&&e)`).
  if (shouldUseCustomModelOptions() && customFableModel) {
    return {
      value: 'fable',
      label:
        process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME ?? customFableModel,
      description:
        process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ??
        'Custom Fable model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ?? 'Custom Fable model'} (${customFableModel})`,
    }
  }
}

// 2.1.257 (Fable 5.1 launch): official picker row, binary `WZe` in the
// 2.1.258 ELF (byte-verified):
//   let e=!va(),n=`Fable 5.1 \xB7 ${pxe}${zZe()}`;
//   return{value:e?zl().fable51:"fable",label:"Fable",description:n,
//     descriptionForModel:"Fable 5.1 - most capable for your hardest and
//     longest-running tasks"}
// with pxe="Most capable for your hardest and longest-running tasks".
// zZe() appends " · Requires usage credits" — staged (usage-credits surface
// not in OCC; see docs/upstream-version-gap-occ113.md).
function getFable5Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const customFable = getCustomFableOption()
  if (customFable) {
    return customFable
  }
  return {
    value: is3P ? getModelStrings().fable51 : 'fable',
    label: 'Fable',
    description:
      'Fable 5.1 · Most capable for your hardest and longest-running tasks',
    descriptionForModel:
      'Fable 5.1 - most capable for your hardest and longest-running tasks',
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a custom-model user has a custom sonnet model string, show it
  // directly (binary OBc: `if(xJn()&&e)`).
  if (shouldUseCustomModelOptions() && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a custom-model user has a custom opus model string, show it
  // directly (binary FBc: `if(xJn()&&e)`).
  if (shouldUseCustomModelOptions() && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

function getOpus46Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().opus46,
    label: 'Opus 4.6',
    description: `Opus 4.6 · Previous Opus version${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 - previous Opus version',
  }
}

function getOpus47Option(): ModelOption {
  return {
    value: getModelStrings().opus47,
    label: 'Opus 4.7',
    description: 'Opus 4.7 · Previous Opus version',
    descriptionForModel: 'Opus 4.7 - previous Opus version',
  }
}

// 2.1.219 (1b/1i): Opus 5 is the newest/current Opus. Binary `XBc`:
//   value: opus5 (3P) | "opus" (1P); label: "Opus";
//   description: `Opus 5 · Best for everyday, complex tasks${pricingSuffix}`
//   where pricingSuffix = Goe("claude-opus-5", fastMode) (opus-5 cost, see
//   getOpus5PricingSuffix). The literal "Opus 5" in the description is the
//   highlight target for 1i (see getMergedOpus1MOption comment).
function getOpus5Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus5 : 'opus',
    label: 'Opus',
    description: `Opus 5 · Best for everyday, complex tasks${getOpus5PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 5 - best for everyday, complex tasks',
  }
}

// 2.1.280 (#001 Opus 5.5 launch): Opus 5.5 is the newest/current Opus.
// Binary `Tv` (byte-verified):
//   value: !al() ? kc().opus55 : "opus"; label: "Opus";
//   description: `Opus 5.5 · Best for everyday, complex tasks${In("claude-opus-5-5",e)}`
//   descriptionForModel: "Opus 5.5 - best for everyday, complex tasks"
// with bs="Best for everyday, complex tasks" and In = the pricing suffix
// (hCt: base $4/$20, fast (↯) $8/$40 per Mtok). The literal "Opus 5.5" is
// the 1i highlight target (see getMergedOpus1MOption comment).
export function getOpus55Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus55 : 'opus',
    label: 'Opus',
    description: `Opus 5.5 · Best for everyday, complex tasks${getOpus55PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 5.5 - best for everyday, complex tasks',
  }
}

export function getSonnet5_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet5 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_2_10)}`}`,
    descriptionForModel:
      'Sonnet 5 with 1M context window - for long sessions with large codebases',
  }
}

export function getSonnet46_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().sonnet46 + '[1m]',
    label: 'Sonnet 4.6 (1M context)',
    description: `Sonnet 4.6 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.6 with 1M context window - for long sessions with large codebases',
  }
}

// 2.1.219 (1b/1i): Opus 5 1M row. Binary `UBc`:
//   value: opus5+"[1m]" (3P) | "opus[1m]" (1P); label: "Opus (1M context)";
//   description: `Opus 5 for long sessions${pricingSuffix}` (opus-5 cost).
export function getOpus5_1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus5 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 5 for long sessions${getOpus5PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 5 with 1M context window - for long sessions with large codebases',
  }
}

// 2.1.280 (#001 Opus 5.5 launch): Opus 5.5 1M row. Binary `_v` (byte-verified):
//   value: !al() ? kc().opus55+"[1m]" : "opus[1m]"; label: "Opus (1M context)";
//   description: `Opus 5.5 for long sessions${In("claude-opus-5-5",e)}`
//   descriptionForModel: "Opus 5.5 with 1M context window - for long sessions
//     with large codebases"
export function getOpus55_1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus55 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 5.5 for long sessions${getOpus55PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 5.5 with 1M context window - for long sessions with large codebases',
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().opus46 + '[1m]',
    label: 'Opus 4.6 (1M context)',
    description: `Opus 4.6 for long sessions${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 4.6 with 1M context window - for long sessions with large codebases',
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  // When a custom-model user has a custom haiku model string, show it
  // directly (binary OBc-haiku: `if(xJn()&&e)`).
  if (shouldUseCustomModelOptions() && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

// 2.1.280 (#001): Max/Standard current Opus row. Binary `Og` (byte-verified):
//   value: "opus"; label: "Opus";
//   description: `Opus 5.5 · Best for everyday, complex tasks${Cg()}${e?In("claude-opus-5-5",!1):""}`
//   (Cg = "~2× usage vs Sonnet" pro-gate; OCC omits it — preserved as-is).
function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 5.5 · Best for everyday, complex tasks${fastMode ? getOpus55PricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet5_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_2_10)}`}`,
  }
}

export function getMaxSonnet46_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

// 2.1.219 (1b/1i): Max/Standard Opus 5 1M row. Binary `WBc`:
//   value: "opus[1m]"; label: "Opus (1M context)";
//   description: `Opus 5 with 1M context${LWi()}${drawsFromCredits}${pricingSuffix}`.
//   OCC preserves its "Billed as extra usage" billing line (binary uses
//   "Draws from usage credits"); the model-version + pricing suffix are
//   updated to opus-5.
export function getMaxOpus5_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 5 with 1M context${billingInfo}${getOpus5PricingSuffix(fastMode)}`,
  }
}

// 2.1.280 (#001): Max/Standard Opus 5.5 1M row. Binary `kv` (byte-verified):
//   value: "opus[1m]"; label: "Opus (1M context)";
//   description: `Opus 5.5 with 1M context${Cg()}${drawsFromCredits}${pricingSuffix}`.
//   OCC preserves its "Billed as extra usage" billing line (binary uses
//   "Draws from usage credits"); the model-version + pricing suffix are
//   updated to opus-5-5 ($4/$20 base, (↯) $8/$40 fast).
export function getMaxOpus55_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 5.5 with 1M context${billingInfo}${getOpus55PricingSuffix(fastMode)}`,
  }
}

export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context${billingInfo}${getOpus46PricingSuffix(fastMode)}`,
  }
}

// 2.1.219 1b (label fix) + 1i (highlight-newest): the merged Opus 1M row.
//
// 1b — official changelog: "Fixed the /model picker showing the merged Opus
//   row as plain \"Opus\" instead of \"Opus (1M context)\"". Binary 2.1.220
//   `UBc`/`PWi` both render label:"Opus (1M context)" (verified at offset
//   249528843 and 249530691). Description is `Opus 5 for long sessions` +
//   opus-5 pricing suffix (`UBc` form) — the merged row is the Opus 5 row.
//
// 1i — official changelog: "Changed the /model picker to highlight only the
//   newest model's name". The binary does NOT flag newest via a boolean
//   field on ModelOption. Instead the picker UI (`ModelPicker.tsx`
//   equivalent, offset 262593244 in 2.1.220) does a literal string replace
//   on each option's description:
//     .replaceAll("Opus 5", to("claude", MYo)("Opus 5"))
//   i.e. the newest model's NAME is highlighted wherever it appears. So
//   "only the newest is highlighted" reduces to: only the newest opus rows
//   carry the literal newest name in their description. Legacy rows
//   ("Opus 4.8", "Opus 4.6", ...) do not match and are not highlighted.
//   2.1.280 (#001): the newest name is now "Opus 5.5" — this data layer
//   carries "Opus 5.5" on exactly the opus-5-5 rows. STAGED UI NOTE
//   (corrected this round against the 2.1.280 binary): the official
//   render-layer highlight lives in the picker component's description memo
//   (`Sfe` `tn` @217541095 region) as
//     .replaceAll("Opus 5.5", Et("claude",uo)("Opus 5.5"))
//     .replace(/\$[\d.]+\/\$[\d.]+ per Mtok/, …promo strikethrough…)
//   plus a `c7` override note appended as `${description} · ${qs}`. OCC's
//   ModelPicker.tsx has NO live replaceAll at all (verified by grep), so the
//   render-layer highlight stays staged; the earlier note claiming the UI
//   "still targets Opus 5" was wrong — there is no UI target to update.
function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus55 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    // Binary `Pg` form (2.1.280, byte-verified): `${g} with 1M context ·
    // Best for everyday, complex tasks${Cg()}${h}` with g="Opus 5.5" and h =
    // opus-5-5 pricing suffix. "Opus 5.5" present → 1i highlight target
    // (see header comment).
    description: `Opus 5.5 with 1M context · Best for everyday, complex tasks${!is3P && fastMode ? getOpus55PricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      'Opus 5.5 with 1M context - best for everyday, complex tasks',
  }
}

const MaxSonnet5Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 5 · Efficient for routine tasks',
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

// NOTE: the pre-2.1.280 OCC tail appended an "Opus Plan Mode" row when the
// user's setting was 'opusplan'. The official 2.1.280 `wj` tail (byte-verified
// @196278861-196281300) has NO opusplan branch: opusplan falls through to the
// zr-probe else branch, where `kt("opusplan")` (parsed to the default Sonnet)
// makes it match the Sonnet row, so no extra row appears. The row builder was
// removed with the tail rewrite.

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))

    return [
      getDefaultOptionForUser(),
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getFable5Option(),
      getSonnet5Option(),
      getSonnet5_1MOption(),
      getHaiku45Option(),
    ]
  }

  if (isClaudeAISubscriber()) {
    // 2.1.280 #078: binary `fj` (byte-verified) gates the premium picker on
    // `if(ft()){if(K7t()){...opus rows...}else{...sonnet rows...}}` — ft =
    // isClaudeAISubscriber, K7t = isOpusDefaultTier. With #078 the K7t tier
    // set now includes Team Standard and Pro, so they get the Opus-default
    // (premium) picker list too.
    if (isOpusDefaultTier()) {
      // Opus-default tiers (Max, Team Premium, Team Standard, Pro): Opus is
      // default, show Sonnet as alternative
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      if (!isOpus1mMergeEnabled() && checkOpus1mAccess()) {
        premiumOptions.push(getMaxOpus55_1MOption(fastMode))
      }

      premiumOptions.push(MaxSonnet5Option)
      if (checkSonnet1mAccess()) {
        premiumOptions.push(getMaxSonnet5_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      return premiumOptions
    }

    // Remaining subscribers (Enterprise; Team/Pro under the active 3P sonnet
    // probe `tv`): Sonnet is default, show Opus as alternative
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      standardOptions.push(getMaxSonnet5_1MOption())
    }

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess()) {
        standardOptions.push(getMaxOpus55_1MOption(fastMode))
      }
    }

    standardOptions.push(MaxHaiku45Option)
    return standardOptions
  }

  // PAYG 1P API: Default (Sonnet 5) + Sonnet 5 1M + Fable 5 + Opus 5 + Opus 1M + Haiku
  // Binary `Fug` rm()-branch (2.1.220): the Anthropic-owned-provider path
  // consults the custom `ANTHROPIC_DEFAULT_*_MODEL` options FIRST (FBc/OBc/
  // NBc/jBc, each gated on xJn — see shouldUseCustomModelOptions) and only
  // falls back to the stock rows. A firstParty provider behind a custom
  // ANTHROPIC_BASE_URL (xJn true) therefore shows "Custom Opus/Sonnet/Haiku
  // model" rows, not the stock ones (live-verified against the official
  // 2.1.220 picker in OCC-43). When any custom row is active the binary's
  // row order is Default → Opus → [Fable] → Sonnet → Haiku.
  if (getAPIProvider() === 'firstParty') {
    const customOpus = getCustomOpusOption()
    const customSonnet = getCustomSonnetOption()
    const customHaiku = getCustomHaikuOption()
    // 2.1.280 correction (was a pre-2.1.280 note claiming the stock Fable row
    // only appears for anthropicAws/anthropicGoogleCloud): the official `wj`
    // Fable post-step (`if(r===null&&y==="firstParty"&&NSe()&&!s.some(fi))
    // ui(s,VG(OHe(),e))`, byte-verified @196280400 region) adds the STOCK
    // Fable row on firstParty too — after this base list is built — whenever
    // no fable-family row is present. The base list itself still carries
    // Fable only via ANTHROPIC_DEFAULT_FABLE_MODEL (customFable); the
    // post-step in getModelOptions covers the stock case.
    const customFable = getCustomFableOption()
    if (customOpus || customSonnet || customHaiku || customFable) {
      const customOptions = [getDefaultOptionForUser(fastMode)]
      if (customOpus !== undefined) {
        customOptions.push(customOpus)
      } else if (isOpus1mMergeEnabled()) {
        customOptions.push(getMergedOpus1MOption(fastMode))
      } else {
        customOptions.push(getOpus55Option(fastMode))
        if (checkOpus1mAccess()) {
          customOptions.push(getOpus55_1MOption(fastMode))
        }
      }
      if (customFable !== undefined) {
        customOptions.push(customFable)
      }
      if (customSonnet !== undefined) {
        customOptions.push(customSonnet)
      } else if (checkSonnet1mAccess()) {
        customOptions.push(getSonnet5_1MOption())
      }
      customOptions.push(customHaiku ?? getHaiku45Option())
      return customOptions
    }
    // Stock firstParty layout (no ANTHROPIC_DEFAULT_*_MODEL overrides).
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      payg1POptions.push(getSonnet5_1MOption())
    }
    payg1POptions.push(getFable5Option())
    if (isOpus1mMergeEnabled()) {
      payg1POptions.push(getMergedOpus1MOption(fastMode))
    } else {
      payg1POptions.push(getOpus55Option(fastMode))
      if (checkOpus1mAccess()) {
        payg1POptions.push(getOpus55_1MOption(fastMode))
      }
    }
    payg1POptions.push(getHaiku45Option())
    return payg1POptions
  }

  // PAYG 3P: Default (Sonnet 4.5) + Sonnet (3P custom) or Sonnet 4.6/1M + Opus (3P custom) or Opus 4.1/Opus 4.6/Opus1M + Haiku
  // 3P providers lag firstParty — newest models (Sonnet 5 / Opus 4.8) aren't available yet,
  // so the 3P picker shows the legacy explicit options (Sonnet 4.6, Opus 4.6).
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  const customSonnet = getCustomSonnetOption()
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet)
  } else {
    // Add Sonnet 4.6 since Sonnet 4.5 is the default
    payg3pOptions.push(getSonnet46Option())
    if (checkSonnet1mAccess()) {
      payg3pOptions.push(getSonnet46_1MOption())
    }
  }

  const customOpus = getCustomOpusOption()
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus)
  } else {
    // Add Opus 4.1, Opus 4.6 and Opus 4.6 1M
    payg3pOptions.push(getOpus41Option()) // This is the default opus
    payg3pOptions.push(getOpus46Option(fastMode))
    if (checkOpus1mAccess()) {
      payg3pOptions.push(getOpus46_1MOption(fastMode))
    }
  }
  const customHaiku = getCustomHaikuOption()
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  return payg3pOptions
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family — 2.1.280: 'claude-opus-5' also covers 'claude-opus-5-5'
  // (substring), so pinned Opus 5 / Opus 5.5 users get the "newer version
  // available" hint against getDefaultOpusModel() (now claude-opus-5-5).
  if (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-opus-5')
  ) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Fable family
  if (canonical.includes('claude-fable-5')) {
    const currentName = getMarketingNameForModel(getDefaultFableModel())
    if (currentName) {
      return { alias: 'Fable', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

// ---------------------------------------------------------------------------
// 2.1.280 picker row machinery (byte-verified against the official linux-x64
// ELF; minified names in comments). These helpers implement the official
// family-aware row identity (`zr`), Fable-row key (`Rv`), family classifier
// (`Pc`), 1M-variant resolution (`F7t`/`r7`/`Pv`), sorted insertion (`ui`),
// gateway-row decoration (`pj`), Fable availability (`NSe`), and the Fable
// row builders (`vv`/`VG`/`YG`/`F5t`). Documented simplifications:
// - `sessionTail:!0` (telemetry-only marker) is never set — OCC has no
//   session-tail telemetry consumer (bn() @206369033 not ported).
// - Official `ui`'s `fF()` (managed-settings rows) and `soe()?.picker.options`
//   (managed picker) candidate sources are omitted — OCC has no managed
//   picker surface (staged, docs/upstream-version-gap-occ113.md).
// - Official `Ov()` also checks `iF().size===0` (managed-models set) —
//   omitted for the same reason.
// - Official `F7t` additionally excludes `yde(s)`/`AS(s)` (internal
//   deprecated/coming-soon predicates) — OCC's ALL_MODEL_CONFIGS has no
//   such flags; every registered config is live.
// ---------------------------------------------------------------------------

/** Official `qt` (@191976200 region): strip ONE trailing `[1m]` tag. */
export function stripTrailing1mTag(value: string): string {
  return value.replace(/\[1m]$/i, '')
}

/**
 * Official `Xn` (@193417215 region): strip ALL context-window tags. The
 * official regex covers `[1m]` and `[2m]`; OCC has no `[2m]` surface, so only
 * `[1m]` is stripped (documented simplification).
 */
export function stripAll1mTags(value: string): string {
  return value.replace(/\[1m\]/gi, '')
}

/** Official `Ag` (@193423934 region): the Fable wildcard row key. */
const FABLE_WILDCARD = 'fable:*'

/**
 * Official `Pc` (@196285950, byte-verified): classify a picker row value into
 * its model family by substring, or null when it is a custom (non-Claude)
 * value.
 *   let n=e.toLowerCase();if(n.includes("fable"))return"fable";
 *   if(n.includes("opus"))return"opus";if(n.includes("sonnet"))return"sonnet";
 *   if(n.includes("haiku"))return"haiku";return null
 */
export function pickerFamily(
  value: string,
): 'fable' | 'opus' | 'sonnet' | 'haiku' | null {
  const n = value.toLowerCase()
  if (n.includes('fable')) return 'fable'
  if (n.includes('opus')) return 'opus'
  if (n.includes('sonnet')) return 'sonnet'
  if (n.includes('haiku')) return 'haiku'
  return null
}

/**
 * Official `fi` (@196281300 region): `e==="fable"||e==="fable[1m]"||noe(e)`
 * with `noe(e)=e.includes("claude-fable-")`.
 */
export function isFableModelValue(value: string): boolean {
  return (
    value === 'fable' || value === 'fable[1m]' || value.includes('claude-fable-')
  )
}

/**
 * Official `Rv` (@196284300, byte-verified): the Fable identity key used by
 * `zr`. Alias values (`fable`/`fable[1m]`) key on the resolved default Fable
 * model (or the `fable:*` wildcard when the default does not resolve to a
 * fable-family config); concrete values key on the firstParty ID captured by
 * the fable-ID regex. Returns undefined for non-fable values.
 *
 * The official family check is `pc(s)?.family==="fable"` (canonical config
 * lookup); OCC uses the `claude-fable-` substring — exactly the official
 * `noe` predicate, equivalent because only fable configs carry that prefix.
 */
export function fableRowKey(value: string): string | undefined {
  if (value === 'fable' || value === 'fable[1m]') {
    const resolved = stripTrailing1mTag(
      resolveOverriddenModel(getDefaultFableModel()),
    )
    return resolved.includes('claude-fable-') ? resolved : FABLE_WILDCARD
  }
  const fableIds = (Object.keys(ALL_MODEL_CONFIGS) as ModelKey[])
    .map(key => ALL_MODEL_CONFIGS[key].firstParty)
    .filter(id => id.includes('fable'))
    .sort((a, b) => b.length - a.length)
  return new RegExp(
    `(?:^|[./])(${fableIds.join('|')})(?:[-@]\\d{8})?(?:-v\\d+(?::\\d+)?)?(?:\\[[12]m\\])?$`,
    'i',
  ).exec(value)?.[1]
    ?.toLowerCase()
}

/**
 * Official `zr` (@196283926, byte-verified): family-aware row identity.
 *   if(e.value===n.value)return!0;
 *   if(typeof e.value!=="string"||typeof n.value!=="string")return!1;
 *   let r=Rv(e.value),s=Rv(n.value);
 *   if(r!==void 0&&s!==void 0&&(r===s||r===Ag||s===Ag))return!0;
 *   let g=kt(e.value);
 *   if(Xn(g)!==Xn(kt(n.value)))return!1;
 *   return su(e.value)===su(n.value)||Bh(g)
 * kt = parseUserSpecifiedModel, Xn = stripAll1mTags, su = has1mContext,
 * Bh = modelSupports1M.
 */
export function modelRowsValueEqual(
  a: ModelOption,
  b: ModelOption,
): boolean {
  if (a.value === b.value) return true
  if (typeof a.value !== 'string' || typeof b.value !== 'string') return false
  const keyA = fableRowKey(a.value)
  const keyB = fableRowKey(b.value)
  if (
    keyA !== undefined &&
    keyB !== undefined &&
    (keyA === keyB || keyA === FABLE_WILDCARD || keyB === FABLE_WILDCARD)
  ) {
    return true
  }
  const parsedA = parseUserSpecifiedModel(a.value)
  if (stripAll1mTags(parsedA) !== stripAll1mTags(parseUserSpecifiedModel(b.value))) {
    return false
  }
  return has1mContext(a.value) === has1mContext(b.value) || modelSupports1M(parsedA)
}

/**
 * Official `F5t` (@196282164 region, byte-verified): find the value of the
 * row a setting actually lands on — strict match first, then the `zr`
 * family-aware probe. Returns undefined when no row matches.
 *   if(e.some((g)=>g.value===n))return n;
 *   let r={value:n,label:"",description:""},s=e.find((g)=>zr(g,r));
 *   return typeof s?.value==="string"?s.value:void 0
 */
export function findMatchingOptionValue(
  options: ModelOption[],
  value: string,
): string | undefined {
  if (options.some(opt => opt.value === value)) return value
  const probe: ModelOption = { value, label: '', description: '' }
  const match = options.find(opt => modelRowsValueEqual(opt, probe))
  return typeof match?.value === 'string' ? match.value : undefined
}

/**
 * Official `Ov()`: the availableModels allowlist is inactive (no
 * `availableModels` key in settings). The official also requires the
 * managed-models set to be empty (`iF().size===0`) — omitted, OCC has no
 * managed-models surface.
 */
function isModelAllowlistInactive(): boolean {
  return !(getSettings_DEPRECATED() || {}).availableModels
}

/** Official `Oo`: word-boundary (non-alphanumeric delimited) substring test. */
function matchesFamilyWordBoundary(modelId: string, family: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${family}([^a-z0-9]|$)`, 'i').test(modelId)
}

/**
 * Official `F7t` (@193414468, byte-verified): resolve a family alias to the
 * NEWEST allowed concrete firstParty ID by reverse-scanning the model config
 * table (insertion order = launch order, so the last match is the newest —
 * `opus` → claude-opus-5-5, `fable` → claude-fable-5-1). `Ge` is the
 * modelOverrides identity resolver; `qr` is isModelAllowed.
 */
function resolveFamilyConcreteModel(familyAlias: string): string | null {
  const keys = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]
  for (let i = keys.length - 1; i >= 0; i--) {
    const canonical = resolveOverriddenModel(
      ALL_MODEL_CONFIGS[keys[i]]!.firstParty,
    )
    if (
      matchesFamilyWordBoundary(canonical, familyAlias) &&
      isModelAllowed(canonical)
    ) {
      return canonical
    }
  }
  return null
}

/**
 * Official `r7` (@193438310, byte-verified, `q7t` pre-check omitted — it
 * probes Anthropic-internal beta headers OCC does not send):
 *   let r=uS(Tx(e).trim());if(!r.startsWith("claude-"))return!0;
 *   return r.includes("opus")&&al()?jk():!0
 * i.e. non-Claude (custom gateway) IDs always merge; Claude Opus IDs on an
 * Anthropic-owned provider merge only when the 1M-merge flag `jk()` is on.
 */
function shouldMerge1mVariant(concreteModel: string): boolean {
  const normalized = concreteModel.trim().toLowerCase()
  if (!normalized.startsWith('claude-')) return true
  if (normalized.includes('opus') && isAnthropicOwnedProvider()) {
    return isOpus1mMergeEnabled()
  }
  return true
}

/**
 * Official `Pv` (@196282900 region, byte-verified): given a picker row whose
 * value is a family alias (`opus`, `sonnet`, …), compute the concrete model
 * ID that alias resolves to for the current user — including the merged
 * `[1m]` variant when the alias row carries a 1M tag, the user has 1M access,
 * and `r7` allows the merge. Returns null when the row is not an alias on an
 * Anthropic-owned provider, the family has no concrete ID, another row
 * already materializes the same variant, or the result has no known picker
 * option (`sl` = getKnownModelOption).
 */
function resolve1mVariantForRow(
  options: ModelOption[],
  row: ModelOption,
): string | null {
  if (typeof row.value !== 'string') return null
  const stripped = stripTrailing1mTag(row.value)
  if (!isModelFamilyAlias(stripped) || !isAnthropicOwnedProvider()) return null
  const concrete = resolveFamilyConcreteModel(stripped)
  if (concrete === null) return null
  const hadTag = row.value !== stripped
  const hasAccess =
    stripped === 'opus'
      ? checkOpus1mAccess()
      : stripped === 'sonnet'
        ? checkSonnet1mAccess()
        : true
  const merged =
    hadTag && hasAccess && shouldMerge1mVariant(concrete)
      ? `${concrete}[1m]`
      : concrete
  const canonicalConcrete = resolveOverriddenModel(concrete)
  const mergedHasTag = merged !== concrete
  // Official dedup: another row already spells out this exact variant.
  const alreadyPresent = options.some(
    other =>
      other !== row &&
      typeof other.value === 'string' &&
      stripTrailing1mTag(other.value) !== other.value === mergedHasTag &&
      resolveOverriddenModel(stripTrailing1mTag(other.value)) ===
        canonicalConcrete &&
      isModelAllowed(other.value),
  )
  if (alreadyPresent) return null
  if (getKnownModelOption(merged) === null) return null
  return merged
}

/**
 * Official `ui` (@196284994, byte-verified): insert a picker row in family
 * order. Non-Fable rows append at the end. Fable rows insert after the
 * Default row and after any rows belonging to the default family / the
 * resolved family of the row that follows Default (so the Fable row lands
 * between the Opus and Sonnet rows for an Opus-default user, matching the
 * official 2.1.280 capture order Default → Opus → Fable → Sonnet → Haiku).
 */
function insertModelOptionSorted(
  options: ModelOption[],
  row: ModelOption,
): void {
  if (!(typeof row.value === 'string' && isFableModelValue(row.value))) {
    options.push(row)
    return
  }
  const defaultIdx = options.findIndex(opt => opt.value === null)
  if (defaultIdx === -1) {
    options.splice(0, 0, row)
    return
  }
  // Official `s = Pc(Ll())` — family of the parsed default-model setting.
  const defaultFamily = pickerFamily(
    parseUserSpecifiedModel(getDefaultMainLoopModelSetting()),
  )
  const nextValue = options[defaultIdx + 1]?.value
  const nextRow = options[defaultIdx + 1]
  // Official `y`: the concrete resolution of the row after Default.
  const resolvedNext =
    typeof nextValue === 'string' && nextRow !== undefined
      ? resolve1mVariantForRow(options, nextRow)
      : null
  // Official `w`: candidate matches `y` by override-resolved identity AND
  // 1M-tag state AND is allowlisted.
  const matchesResolvedNext = (candidate: string): boolean =>
    resolvedNext !== null &&
    resolveOverriddenModel(stripTrailing1mTag(candidate)) ===
      resolveOverriddenModel(stripTrailing1mTag(resolvedNext)) &&
    stripTrailing1mTag(candidate) !== candidate ===
      (stripTrailing1mTag(resolvedNext) !== resolvedNext) &&
    isModelAllowed(candidate)
  // Official `E = Ng() ?? _0() ?? null` and `T` (any tail/allowlist/gateway
  // candidate matching `y`; managed-settings terms omitted — see header).
  const tailSetting =
    getUserSpecifiedModelSetting() ?? getInitialMainLoopModel() ?? null
  const hasTailCandidateMatch =
    (typeof tailSetting === 'string' && matchesResolvedNext(tailSetting)) ||
    ((getSettings_DEPRECATED()?.availableModels ?? []) as string[]).some(m =>
      matchesResolvedNext(m.trim()),
    ) ||
    readGatewayModelOptions().some(
      opt => typeof opt.value === 'string' && matchesResolvedNext(opt.value),
    )
  // Official `A`: the row after Default is a concrete (or merged) model row.
  const nextConcreteOrMerged =
    typeof nextValue === 'string' &&
    (isModelAllowlistInactive() ||
      isModelAllowed(nextValue) ||
      (resolvedNext !== null && !hasTailCandidateMatch))
  // Official `M`: family of the row after Default when its value is an alias.
  const nextFamily =
    typeof nextValue === 'string' &&
    isModelFamilyAlias(stripTrailing1mTag(nextValue))
      ? pickerFamily(nextValue)
      : null
  const skipFamilies = new Set<string>()
  if (nextFamily !== null) {
    skipFamilies.add(nextFamily)
    if (!nextConcreteOrMerged && defaultFamily !== null) {
      skipFamilies.add(defaultFamily)
    }
  } else if (defaultFamily !== null) {
    skipFamilies.add(defaultFamily)
  }
  let insertIdx = defaultIdx + 1
  while (insertIdx < options.length) {
    const value = options[insertIdx]?.value
    if (typeof value !== 'string') break
    const family = pickerFamily(value)
    if ((family !== null && skipFamilies.has(family)) || isFableModelValue(value)) {
      insertIdx++
    } else {
      break
    }
  }
  options.splice(insertIdx, 0, row)
}

/**
 * Official `pj` (@196278861 region, byte-verified): decorate a gateway-
 * discovered row — when its label is still the raw model ID (`nMn`:
 * `typeof e.value==="string"&&e.label===eA(e.value)`, i.e. undecorated),
 * relabel with the marketing name (`Ztt`) and fold the old label into the
 * description.
 */
function decorateGatewayOption(option: ModelOption): ModelOption {
  if (typeof option.value !== 'string' || option.label !== option.value) {
    return option
  }
  const marketingName = getMarketingNameForModel(option.value)
  if (!marketingName) return option
  return {
    ...option,
    label: marketingName,
    description: `${option.description} (${option.label})`,
  }
}

/**
 * Official `NSe` (@193423400 region, byte-verified): whether the picker can
 * offer Fable at all. `Ml()`/`XS()` (internal gates) are always false in
 * OCC's build; `ZN(noe)` is the gateway-model scan.
 *   if(a.ANTHROPIC_DEFAULT_FABLE_MODEL)return!0;
 *   switch(Oe()){case"firstParty":return!0;
 *     case"gateway":return ZN(noe);default:return!1}
 */
function isFableAvailableForPicker(): boolean {
  if (process.env.ANTHROPIC_DEFAULT_FABLE_MODEL) return true
  switch (getAPIProvider()) {
    case 'firstParty':
      return true
    case 'gateway':
      return readGatewayModelOptions().some(
        opt => typeof opt.value === 'string' && opt.value.includes('claude-fable-'),
      )
    default:
      return false
  }
}

/**
 * Official `vv` (@196266015 region): the Fable marketing name for a model
 * value, restricted to the fable family (`pc(qt(Ge(e,{identity:!0})))?.family
 * ==="fable"?display_name:void 0`).
 */
function getFableMarketingName(model: string): string | undefined {
  const resolved = stripTrailing1mTag(resolveOverriddenModel(model))
  const canonical = getCanonicalName(resolved)
  if (!canonical.includes('claude-fable-')) return undefined
  return getMarketingNameForModel(resolved) ?? undefined
}

/**
 * Official `In`/`hCt` (@193447571 region): the firstParty-gated pricing
 * suffix ` ·${fastMode ? ` (↯)` : ''} ${pricing}` — same shape as
 * getOpus55PricingSuffix, but priced off the given model's cost table
 * (`Hh` base tier; the official fast arm `hde(Tze(r))` reads the fast tier —
 * OCC's MODEL_COSTS has no per-model fast tier for fable, so both arms use
 * the base table, matching the official capture "· $10/$50 per Mtok").
 */
function getFablePricingSuffix(model: string, fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = getModelPricingString(model)
  if (pricing === undefined) return ''
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

/**
 * Official `VG` (@196267100 region, byte-verified): the stock Fable row for
 * the picker's post-step. `cl` is the blurb; `Bc()` (usage-credits suffix)
 * is staged-empty (docs/upstream-version-gap-occ113.md); subscribers get no
 * pricing suffix (`ft()?"":In(e,n)`).
 */
function getFablePickerRow(model: string, fastMode = false): ModelOption {
  const name = getFableMarketingName(model) ?? 'Fable 5.1'
  const blurb = 'Most capable for your hardest and longest-running tasks'
  const pricingSuffix = isClaudeAISubscriber()
    ? ''
    : getFablePricingSuffix(model, fastMode)
  return {
    value: model,
    label: 'Fable',
    description: `${name} · ${blurb}${pricingSuffix}`,
    descriptionForModel: `${name} - most capable for your hardest and longest-running tasks`,
  }
}

/**
 * Official `YG` (@196266500 region, byte-verified): the Fable row for a
 * tail-inserted user value — marketing-name label when the value resolves
 * into the fable family, otherwise the stock Fable row re-valued.
 */
function getFableRowForValue(value: string): ModelOption {
  const name = getFableMarketingName(value)
  if (name === undefined) {
    return { ...getFable5Option(), value }
  }
  const blurb = 'Most capable for your hardest and longest-running tasks'
  return {
    value,
    label: name,
    description: `${name} · ${blurb}`,
    descriptionForModel: `${name} - most capable for your hardest and longest-running tasks`,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Official `wj` head/tail machinery (2.1.280, byte-verified @196278861
  // region). `r` is the availableModels setting — gateway rows and the Fable
  // post-step only run when the allowlist is INACTIVE (`r===null`).
  const allowlistInactive = isModelAllowlistInactive()

  // Gateway-discovered models (binary `oIn()` rows). Official:
  //   let h=r===null?IHe():[];
  //   for(let M of h)if(!s.some(L=>zr(L,M)))ui(s,pj(M))
  // — family-aware `zr` dedup (not strict value equality), sorted `ui`
  // insertion, and `pj` marketing-name decoration.
  if (allowlistInactive) {
    for (const opt of readGatewayModelOptions()) {
      if (!options.some(existing => modelRowsValueEqual(existing, opt))) {
        insertModelOptionSorted(options, decorateGatewayOption(opt))
      }
    }
  }

  // Official Fable post-step (@196280400 region):
  //   if(r===null&&y==="firstParty"&&NSe()&&
  //      !s.some(M=>typeof M.value==="string"&&fi(M.value)))
  //     ui(s,VG(OHe(),e))
  // — the stock Fable row is offered on firstParty whenever no fable-family
  // row is present yet (this supersedes the pre-2.1.280 note that claimed
  // firstParty pickers only get Fable via ANTHROPIC_DEFAULT_FABLE_MODEL).
  if (
    allowlistInactive &&
    getAPIProvider() === 'firstParty' &&
    isFableAvailableForPicker() &&
    !options.some(
      opt => typeof opt.value === 'string' && isFableModelValue(opt.value),
    )
  ) {
    insertModelOptionSorted(
      options,
      getFablePickerRow(getDefaultFableModel(), fastMode),
    )
  }

  // Tail: make sure the user's current/initial model has a row. Official:
  //   E = Ng() ?? _0() ?? null
  // (getUserSpecifiedModelSetting() ?? getInitialMainLoopModel() ?? null);
  // when E is null or strictly present → bo(s,n) (allowlist filter).
  // `sessionTail:!0` markers are telemetry-only and omitted in OCC.
  const customModel: ModelSetting =
    getUserSpecifiedModelSetting() ?? getInitialMainLoopModel() ?? null
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  }
  const probe: ModelOption = { value: customModel, label: '', description: '' }

  if (isFableModelValue(customModel)) {
    // Official fi(E) branch: rewrite the family-matched row's value in place
    // (keeping its label/description), else sorted-insert the YG(E) row.
    const matchIdx = options.findIndex(opt => modelRowsValueEqual(opt, probe))
    if (matchIdx !== -1) {
      options[matchIdx] = { ...options[matchIdx]!, value: customModel }
    } else {
      insertModelOptionSorted(options, getFableRowForValue(customModel))
    }
    return filterModelOptionsByAllowlist(options)
  }

  if (customModel === 'opus') {
    if (!isAnthropicOwnedProvider()) {
      // Official !al() branch: rewrite rows pinned to the default Opus ID
      // back to the 'opus' alias so the user's setting matches a row.
      const defaultOpus = getDefaultOpusModel()
      return filterModelOptionsByAllowlist(
        options.map(opt =>
          opt.value === defaultOpus ? { ...opt, value: 'opus' } : opt,
        ),
      )
    }
    // Official al() branch: append the Og row unless a tagless row already
    // matches it under zr.
    const maxOpus = getMaxOpusOption(fastMode)
    const alreadyListed = options.some(
      opt =>
        typeof opt.value === 'string' &&
        stripTrailing1mTag(opt.value) === opt.value &&
        modelRowsValueEqual(opt, maxOpus),
    )
    if (!alreadyListed) {
      options.push(maxOpus)
    }
    return filterModelOptionsByAllowlist(options)
  }

  if (customModel === 'opus[1m]' && isAnthropicOwnedProvider()) {
    // Official: append the Pg row unless a tagged row already matches under zr.
    const merged = getMergedOpus1MOption(fastMode)
    const alreadyListed = options.some(
      opt =>
        typeof opt.value === 'string' &&
        stripTrailing1mTag(opt.value) !== opt.value &&
        modelRowsValueEqual(opt, merged),
    )
    if (!alreadyListed) {
      options.push(merged)
    }
    return filterModelOptionsByAllowlist(options)
  }

  // Official else branch: `let M={value:E,label:"",description:""};
  // if(s.some((L)=>zr(L,M)))return bo(s,n);
  // return s.push({...sl(E)??{value:E,label:E,description:"Custom model"},
  //   sessionTail:!0}),bo(s,n)`
  // NOTE: there is NO 'opusplan' branch in the official 2.1.280 tail —
  // opusplan falls through to here, where zr usually matches the Sonnet row
  // (kt("opusplan")→Sonnet default); only when no row matches does a plain
  // {value,label,description:'Custom model'} row get pushed.
  if (options.some(opt => modelRowsValueEqual(opt, probe))) {
    return filterModelOptionsByAllowlist(options)
  }
  options.push(
    getKnownModelOption(customModel) ?? {
      value: customModel,
      label: customModel,
      description: 'Custom model',
    },
  )
  return filterModelOptionsByAllowlist(options)
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
