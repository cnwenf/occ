/**
 * CC 2.1.285 — `allowedProviders` managed setting: leaf vocabulary.
 *
 * Byte-verified against the official v2.1.285 linux-x64 ELF (provider chunk,
 * `export{...,xb,QUe,qYn,t1t,Ie,...,N_e,sc,...}` @196624698 region; enum +
 * validators @195977900):
 *
 *   var L9e=["anthropic","customEndpoint","bedrock","vertex","foundry",
 *             "anthropicAws","mantle","gateway"],
 *       Qc=/^anthropic[A-Z][A-Za-z0-9]*$/,
 *       eu=new Set(L9e);
 *   function Eo(e){return typeof e==="string"&&eu.has(e)}
 *   function Ut(e){return Eo(e)||typeof e==="string"&&Qc.test(e)}
 *
 *   var xb={bedrock:"Amazon Bedrock",vertex:"Google Vertex AI",
 *     foundry:"Microsoft Foundry",anthropicAws:"Claude Platform on AWS",
 *     anthropicGoogleCloud:"Claude Platform on Google Cloud",
 *     mantle:"Amazon Bedrock (Mantle)",gateway:"Cloud gateway"};
 *   var QUe={bedrock:"CLAUDE_CODE_USE_BEDROCK",foundry:"CLAUDE_CODE_USE_FOUNDRY",
 *     anthropicAws:"CLAUDE_CODE_USE_ANTHROPIC_AWS",
 *     anthropicGoogleCloud:"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
 *     mantle:"CLAUDE_CODE_USE_MANTLE",vertex:"CLAUDE_CODE_USE_VERTEX"};
 *   function qYn(e){switch(e){case"firstParty":return"anthropic";
 *     case"bedrock":return"bedrock";case"vertex":return"vertex";
 *     case"foundry":return"foundry";case"anthropicAws":return"anthropicAws";
 *     case"anthropicGoogleCloud":return"anthropicGoogleCloud";
 *     case"mantle":return"mantle";case"gateway":return"gateway"}}
 *   function G(e){return e in xb}
 *   function t1t(e){switch(e){case"anthropic":return"Anthropic API";
 *     case"customEndpoint":return"a custom endpoint (LLM gateway or proxy)";
 *     default:return G(e)?xb[e]:e}}
 *
 * This module is a LEAF: it imports only the `APIProvider` type (type-only,
 * erased at runtime) so `types.ts` can import the enum + validator without a
 * cycle (types.ts → allowedProviders.ts; allowedProviders.ts imports nothing
 * from settings/types). The enforcement decision lives in
 * `allowedProvidersEnforcement.ts`.
 *
 * STAGED vocabulary (present in the official maps but with NO OCC surface —
 * kept in the maps for byte-fidelity of `qYn`/`t1t`/`xb`, never produced by
 * OCC's provider resolver): `anthropicGoogleCloud` (OCC folds it into
 * firstParty) and `gateway` (OCC's getAPIProvider never returns it — no Cloud
 * gateway build surface). See allowedProvidersEnforcement.ts for the staged
 * gateway enforcement arms.
 */
import type { APIProvider } from '../model/providers.js'

/**
 * Official `L9e` — the recognized provider names an `allowedProviders` list
 * may contain. The plain settings schema filters list entries to these; the
 * strict policy parser additionally admits `/^anthropic[A-Z]…/` custom names
 * (official `Qc`, e.g. `anthropicGoogleCloud`) but flags unknown ones.
 */
export const ALLOWED_PROVIDER_NAMES = [
  'anthropic',
  'customEndpoint',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'mantle',
  'gateway',
] as const

/** Official `Qc` — custom Anthropic-family provider name pattern. */
export const CUSTOM_ANTHROPIC_PROVIDER_PATTERN = /^anthropic[A-Z][A-Za-z0-9]*$/

/** Official `eu` — membership set over `L9e`. */
const KNOWN_PROVIDER_NAME_SET = new Set<string>(ALLOWED_PROVIDER_NAMES)

/** Official `Eo`: exact membership in the recognized provider-name enum. */
export function isKnownProviderName(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_PROVIDER_NAME_SET.has(value)
}

/**
 * Official `Ut`: a valid `allowedProviders` entry — either a recognized enum
 * name (`Eo`) or a custom `anthropic<Camel>` name (`Qc`). Used by the strict
 * policy parser; unknown entries are dropped with a statusOnly notice.
 */
export function isValidProviderEntry(value: unknown): value is string {
  return (
    isKnownProviderName(value) ||
    (typeof value === 'string' &&
      CUSTOM_ANTHROPIC_PROVIDER_PATTERN.test(value))
  )
}

/** Official `xb`: human label per provider (absent for anthropic/customEndpoint). */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  anthropicAws: 'Claude Platform on AWS',
  anthropicGoogleCloud: 'Claude Platform on Google Cloud',
  mantle: 'Amazon Bedrock (Mantle)',
  gateway: 'Cloud gateway',
}

/** Official `QUe`: the env variable that selects each cloud provider. */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
  bedrock: 'CLAUDE_CODE_USE_BEDROCK',
  foundry: 'CLAUDE_CODE_USE_FOUNDRY',
  anthropicAws: 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  anthropicGoogleCloud: 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  mantle: 'CLAUDE_CODE_USE_MANTLE',
  vertex: 'CLAUDE_CODE_USE_VERTEX',
}

/** Official `G`: does this provider name have a label in `xb`? */
export function hasProviderLabel(name: string): boolean {
  return name in PROVIDER_LABELS
}

/**
 * Official `qYn` composed with OCC's snake_case→camelCase provider fix-up.
 * OCC's `APIProvider` uses `anthropic_aws`; the official enum name is
 * `anthropicAws`. Every other OCC provider name already matches the official
 * `Ie()` output, so `qYn` maps it to its `allowedProviders` entry name
 * (`firstParty`→`anthropic`, the rest identity).
 */
export function officialProviderName(provider: APIProvider): string {
  const officialInput =
    provider === 'anthropic_aws' ? 'anthropicAws' : provider
  switch (officialInput) {
    case 'firstParty':
      return 'anthropic'
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
      return 'vertex'
    case 'foundry':
      return 'foundry'
    case 'anthropicAws':
      return 'anthropicAws'
    case 'anthropicGoogleCloud':
      return 'anthropicGoogleCloud'
    case 'mantle':
      return 'mantle'
    case 'gateway':
      return 'gateway'
    default:
      return officialInput
  }
}

/** Official `t1t`: display name for an allowed-provider entry in messages. */
export function providerDisplayName(name: string): string {
  switch (name) {
    case 'anthropic':
      return 'Anthropic API'
    case 'customEndpoint':
      return 'a custom endpoint (LLM gateway or proxy)'
    default:
      return hasProviderLabel(name) ? PROVIDER_LABELS[name] : name
  }
}

/** Official `_l`: the "set up for X" phrase — firstParty → "the Anthropic API". */
export function providerSetupPhrase(officialName: string): string {
  return officialName === 'firstParty'
    ? 'the Anthropic API'
    : (PROVIDER_LABELS[officialName] ?? officialName)
}

/**
 * Official `tp` (@198043xxx): the fail-close text used when managed policy
 * settings could not be read (so the allowedProviders list is unknown) and a
 * provider check would otherwise run. Reuses the 2.1.285 OS-denial machinery:
 * only NON-OS-denied unreadable records fail closed here (see `yl`/`bl` in
 * allowedProvidersEnforcement.ts).
 */
export const MANAGED_UNREADABLE_PROVIDER_TEXT =
  'Unable to read managed policy settings, which may restrict the API providers this machine may use (allowedProviders). Contact your administrator.'

/**
 * Official `OYe` (@198038xxx): the error thrown by the per-request /
 * startup provider gate (`B$t`). `name` is set to "ProviderNotAllowedError".
 */
export class ProviderNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderNotAllowedError'
  }
}
