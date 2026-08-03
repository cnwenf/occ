// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  isClaudeAISubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import {
  COST_TIER_3_15,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
  getOpus5CostTier,
} from '../modelCost.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
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
  getOpus46PricingSuffix,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext } from '../context.js'
import { getGlobalConfig } from '../config.js'
import { readGatewayModelOptions } from './gatewayModelDiscovery.js'

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
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
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
    description: `Sonnet 5 · Efficient for routine tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
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
  const isAnthropicOwned =
    provider === 'firstParty' ||
    provider === 'anthropic_aws' ||
    provider === 'gateway'
  const isAwsOrGoogleCloud = provider === 'anthropic_aws'
  return (
    !isAnthropicOwned || isAwsOrGoogleCloud || !isFirstPartyAnthropicBaseUrl()
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

function getFable5Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const customFable = getCustomFableOption()
  if (customFable) {
    return customFable
  }
  return {
    value: is3P ? getModelStrings().fable5 : 'fable',
    label: 'Fable',
    description: 'Fable 5 - most capable for your hardest and longest-running tasks',
    descriptionForModel:
      'Fable 5 - most capable for your hardest and longest-running tasks',
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

export function getSonnet5_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet5 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
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

// 2.1.219 (1b/1i): Max/Standard current Opus row. Binary `DWi`:
//   value: "opus"; label: "Opus";
//   description: `Opus 5 · Best for everyday, complex tasks${LWi()}${pricingSuffix}`
//   (LWi = "~2x usage vs Sonnet" pro-gate; OCC omits it — preserved as-is).
function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 5 · Best for everyday, complex tasks${fastMode ? getOpus5PricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet5_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
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
//   equivalent, offset 262593244) does a literal string replace on each
//   option's description:
//     .replaceAll("Opus 5", to("claude", MYo)("Opus 5"))
//   i.e. the newest model's NAME ("Opus 5") is highlighted wherever it
//   appears. So "only the newest is highlighted" reduces to: only the
//   opus-5 rows carry the literal "Opus 5" in their description. Legacy
//   rows ("Opus 4.8", "Opus 4.6", ...) do not match "Opus 5" and are not
//   highlighted. This row carries "Opus 5" → it is the highlighted one.
//   (The picker-UI replace itself lives in ModelPicker.tsx, outside this
//   file's edit scope; this data layer ensures the target string is present
//   on exactly the opus-5 rows and absent elsewhere.)
function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus5 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    // Binary `PWi` form: `${Opus 5} with 1M context · Best for everyday,
    // complex tasks${pricingSuffix}` (opus-5 cost). "Opus 5" present → 1i
    // highlight target (see header comment).
    description: `Opus 5 with 1M context · Best for everyday, complex tasks${!is3P && fastMode ? getOpus5PricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      'Opus 5 with 1M context - best for everyday, complex tasks',
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

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus in plan mode, Sonnet otherwise',
  }
}

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
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Opus is default, show Sonnet as alternative
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      if (!isOpus1mMergeEnabled() && checkOpus1mAccess()) {
        premiumOptions.push(getMaxOpus5_1MOption(fastMode))
      }

      premiumOptions.push(MaxSonnet5Option)
      if (checkSonnet1mAccess()) {
        premiumOptions.push(getMaxSonnet5_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: Sonnet is default, show Opus as alternative
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      standardOptions.push(getMaxSonnet5_1MOption())
    }

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess()) {
        standardOptions.push(getMaxOpus5_1MOption(fastMode))
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
    // Binary: `let c=NBc();if(c!==void 0)$Qt(s,c);else if(iW()&&
    // M_e("fable5"))$Qt(s,HWi())` — the stock Fable 5 row only appears for
    // anthropicAws/anthropicGoogleCloud (iW), which never enter this
    // firstParty branch; a firstParty picker gets Fable only via
    // ANTHROPIC_DEFAULT_FABLE_MODEL (live-verified: no Fable row otherwise).
    const customFable = getCustomFableOption()
    if (customOpus || customSonnet || customHaiku || customFable) {
      const customOptions = [getDefaultOptionForUser(fastMode)]
      if (customOpus !== undefined) {
        customOptions.push(customOpus)
      } else if (isOpus1mMergeEnabled()) {
        customOptions.push(getMergedOpus1MOption(fastMode))
      } else {
        customOptions.push(getOpus5Option(fastMode))
        if (checkOpus1mAccess()) {
          customOptions.push(getOpus5_1MOption(fastMode))
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
      payg1POptions.push(getOpus5Option(fastMode))
      if (checkOpus1mAccess()) {
        payg1POptions.push(getOpus5_1MOption(fastMode))
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

  // Opus family
  if (canonical.includes('claude-opus-4')) {
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

  // Append models discovered from a gateway's /v1/models endpoint (binary `oIn()`).
  for (const opt of readGatewayModelOptions()) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
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
