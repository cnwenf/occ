/**
 * CC 2.1.285 — `allowedProviders` managed setting: enforcement decision core.
 *
 * Byte-verified port of the official v2.1.285 linux-x64 ELF enforcement
 * region (@198036300–198055000): tier readers, machine∩slot intersection
 * (`Gye`), override detectors (`$w`/`Gw`/`Ww`/`jw` over the `E` host
 * topology @196623664), provider descriptor (`Wf`) with customEndpoint
 * promotion (`qf`), env-pin machinery (`Yw`/`pl`/`Zf`/`zw`), decision
 * (`MJ`), fail-close throttle (`bl`/`yl`/`HYe`), gates (`B$t`/`nmn`/`Yf`),
 * and the full message builders (`lk`/`Xw`/`Jw` + helpers `_l`/`Qw`/`_n`/
 * `Kr`/`ar`/`gl`/`ok`/`bi`/`yi`).
 *
 * ── OCC source mapping (official symbol → OCC) ─────────────────────────
 *   ge(source)            → getSettingsForSource(source)
 *   ir(source)            → getSettingsFilePathForSource(source)
 *   UA()                  → getCachedAdminPolicyLoadErrors()
 *   Y6()                  → hasNonOsDeniedAdminPolicyLoadFailures()
 *   jo()  (da().invalidateAll) → resetSettingsCache() + getSettingsWithErrors()
 *   BYn() (admin tiers)   → machineTierDocs(): [MDM, managed-settings.json
 *                           (+drop-ins)] — HKCU EXCLUDED: it is user-writable,
 *                           matching official `sc()` (@196328xxx) which zeroes
 *                           user-writable MDM bases from the machine view.
 *   wmt() (machine tier)  → machineTierSettings(): first machine doc carrying
 *                           `allowedProviders` (per-key first-wins ≡ official
 *                           merged admin tier for this key).
 *   UYn() (remote tier)   → remotePolicyState() over
 *                           getRemoteManagedSettingsSyncFromCache().
 *   Pb() (sessionCache===verifiedPayload) → isRemotePolicyVerified(): FALSE.
 *   Ie()                  → currentRawProvider() (getAPIProvider() with the
 *                           'anthropic_aws'→'anthropicAws' name fix-up).
 *   N_e()                 → promotedProvider() (bedrock+mantle → mantle).
 *   Vg                    → sanitizeMessageText (stripVTControlCharacters +
 *                           the official /(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/
 *                           strip, @196628431).
 *   P                     → plural (stringUtils).
 *
 * ── DOCUMENTED DIVERGENCES (all fail-closed / unreachable-in-OCC) ───────
 * 1. REMOTE ENV PINS: official `Yw` honors the remote document's `env` pins
 *    when `(servedSnapshot || Pb())`. OCC's sync cache has a single
 *    sessionCache with no verified/consented/deferred payload states, so it
 *    cannot distinguish a session-served document from a stale user-writable
 *    `remote-settings.json` on disk. Both `servedSnapshot` and `Pb()` map to
 *    FALSE → remote env pins are NEVER honored; a remote-only pin the admin
 *    sanctioned is refused in OCC until a machine source (MDM /
 *    managed-settings.json) pins the same value. Direction: strictly MORE
 *    restrictive than official (safe). The remote allowedProviders LIST still
 *    narrows via the policySettings slot (official: "remote can only narrow
 *    the machine list").
 * 2. GATEWAY arm STAGED: OCC's provider resolver never yields "gateway"
 *    (no Cloud-gateway build surface; forceLoginMethod enum has no "gateway"
 *    member). `zye`/`Qr`/`Ww`/`savedGatewaySignIn` are ported as
 *    always-false/undefined stubs so the message arms stay byte-faithful if
 *    the surface ever lands.
 * 3. WIF arm STAGED: `Gr.wifProfileBaseUrlInUse` stays undefined (OCC has no
 *    WIF profiles); the `zf` setter is ported for structural parity.
 * 4. PARENT tier STAGED: official `Yw` falls back to the parent process's
 *    policy list (`dzt`) only when NEITHER machine NOR remote carries a
 *    list. OCC has the `parentSettingsBehavior` schema key but no parent
 *    settings transport → parentPolicyList() returns null.
 * 5. `Yf.settleRemotePolicy` STAGED: OCC's remote sync is synchronous over
 *    the session cache; the settle hook stays undefined (await resolves).
 * 6. Telemetry `rn("auth_force_login_org","provider_not_allowed",…)` STAGED
 *    (OCC analytics is an empty implementation — same as the 285 item-2
 *    managed-read-denial port).
 * 7. `OYe extends I` (official base carries extra context fields); OCC keeps
 *    the name+message contract via ProviderNotAllowedError (allowedProviders.ts).
 */
import { stripVTControlCharacters } from 'node:util'

import { isEnvTruthy } from '../envUtils.js'
import { getAPIProvider, type APIProvider } from '../model/providers.js'
import { plural } from '../stringUtils.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import {
  ALLOWED_PROVIDER_NAMES,
  MANAGED_UNREADABLE_PROVIDER_TEXT,
  PROVIDER_ENV_VARS,
  PROVIDER_LABELS,
  ProviderNotAllowedError,
  officialProviderName,
  providerDisplayName,
  providerSetupPhrase,
} from './allowedProviders.js'
import { getMdmSettings } from './mdm/settings.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  getSettingsWithErrors,
  hasNonOsDeniedAdminPolicyLoadFailures,
  loadManagedFileSettings,
} from './settings.js'
import {
  getCachedAdminPolicyLoadErrors,
  resetSettingsCache,
} from './settingsCache.js'
import type { SettingsJson } from './types.js'

/** Official `B$t`/`nmn` dispatch kinds (@205945826 Files API passes "files"). */
export type ProviderDispatch = 'inference' | 'files'

/** Official override record (`mi`/`$w`/`Gw`/`Ww`/`jw` element shape). */
export interface ProviderOverride {
  variable: string
  envKey: string | undefined
  value: string
  pinVariables: string[]
  matchesPin?: (pinned: string) => boolean
}

/** Official `Wf` result. */
export interface ProviderDescriptor {
  provider: string
  name: string
  overrides: ProviderOverride[]
  dispatch: ProviderDispatch
}

/** Official `MJ` refused element. */
export interface RefusedProvider extends ProviderDescriptor {
  reason: 'not_listed' | 'endpoint'
  override?: ProviderOverride
}

/** Official `MJ` result. */
export interface ProviderDecision {
  refused: RefusedProvider[]
  allowed: string[]
  message: string
}

/** Official refusal-detail (`Xw`/`Jw`) result. */
interface RefusalDetail {
  cause: string
  steps: string[]
  admin: string[]
}

/** Result shape of official `nmn` (subset of auth.ts OrgValidationResult). */
export type ProviderValidationResult = {
  valid: false
  message: string
  reason: string
  policyUnreadable?: boolean
}

/** Official `bl` retry throttle window (@198043xxx: `e-Vf.failedAt<60000`). */
const POLICY_UNREADABLE_RETRY_MS = 60_000

// ───────────────────────── official `Gr` module cell ─────────────────────────
/**
 * Official @198037xxx: `var Gr={wifProfileBaseUrlInUse:void 0,
 * settleRemotePolicy:void 0}` with setters `zf`/`sLo`. Both stay unset in
 * OCC (divergences 3 + 5); the cell + setters are ported for structural
 * parity so a future WIF/remote-settle surface registers here.
 */
const providerPolicyHooks: {
  wifProfileBaseUrlInUse: (() => string | undefined) | undefined
  settleRemotePolicy: (() => Promise<void>) | undefined
} = {
  wifProfileBaseUrlInUse: undefined,
  settleRemotePolicy: undefined,
}

/** Official `zf`. */
export function setWifProfileBaseUrlInUse(
  fn: (() => string | undefined) | undefined,
): void {
  providerPolicyHooks.wifProfileBaseUrlInUse = fn
}

/** Official `sLo`. */
export function setSettleRemotePolicy(
  fn: (() => Promise<void>) | undefined,
): void {
  providerPolicyHooks.settleRemotePolicy = fn
}

// ───────────────────────── leaf helpers (byte-exact) ─────────────────────────

/** Official `Vg` @196628431: strip VT sequences, then control/format chars. */
function sanitizeMessageText(text: string): string {
  return stripVTControlCharacters(text).replace(
    /(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    '',
  )
}

/** Official `U`: order-preserving uniq. */
function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

/** Official `N` (is-plain-object guard used by `Yw` on `dzt().env`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Official `Si`: env reader — undefined for unset/empty/false. */
function envValue(name: string): string | undefined {
  const value = process.env[name] as string | undefined
  return value === undefined ||
    value === '' ||
    (value as unknown) === false
    ? undefined
    : String(value)
}

/** Official `vh`: first-party host check (@196623268). */
function isFirstPartyHostUrl(url: string): boolean {
  try {
    const host = new URL(url).host
    return ['api.anthropic.com'].includes(host)
  } catch {
    return false
  }
}

/** Official `hi`: https + trailing-dot strip + first-party host. */
function isFirstPartyHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    parsed.hostname = parsed.hostname.replace(/\.$/, '')
    return isFirstPartyHostUrl(parsed.href)
  } catch {
    return false
  }
}

// ───────────── official `E` host topology @196623664 (byte-exact) ─────────────

const AWS_REGION_SEGMENT = '[a-z]{2,4}(?:-[a-z]{2,5})?-[a-z]+-\\d+'
const AWS_OWN_SEGMENT = '[a-z]+(?:-[a-z]+\\d+)?'
const AWS_TRUSTED_DOMAINS =
  '(?:amazonaws\\.(?:com(?:\\.cn)?|eu)|api\\.aws|c2s\\.ic\\.gov|sc2s\\.sgov\\.gov|cloud\\.adc-e\\.uk|csp\\.hci\\.ic\\.gov)'

/** Official `v(e)`: vpce-aware own-host matcher over the AWS domains. */
function awsOwnHostPattern(service: string): RegExp {
  return new RegExp(
    `^(?:vpce-[a-z0-9-]+\\.)?${service}(?:-fips)?\\.${AWS_REGION_SEGMENT}\\.(?:vpce\\.)?${AWS_TRUSTED_DOMAINS}$`,
  )
}

interface ProviderTopologyEntry {
  variables: { name: string; urlOf?: (value: string) => string }[]
  ownHost: RegExp
}

/** Official `var E` — per-provider base-URL variables and own-host patterns. */
const PROVIDER_ENDPOINT_TOPOLOGY: Record<
  string,
  ProviderTopologyEntry | undefined
> = {
  firstParty: undefined,
  gateway: undefined,
  bedrock: {
    variables: [
      { name: 'ANTHROPIC_BEDROCK_BASE_URL' },
      { name: 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME' },
      { name: 'AWS_ENDPOINT_URL_BEDROCK' },
      { name: 'AWS_ENDPOINT_URL' },
    ],
    ownHost: awsOwnHostPattern('bedrock(?:-runtime)?'),
  },
  mantle: {
    variables: [{ name: 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL' }],
    ownHost: awsOwnHostPattern('bedrock-mantle'),
  },
  anthropicAws: {
    variables: [{ name: 'ANTHROPIC_AWS_BASE_URL' }],
    ownHost: awsOwnHostPattern('aws-external-anthropic'),
  },
  vertex: {
    variables: [{ name: 'ANTHROPIC_VERTEX_BASE_URL' }],
    ownHost: new RegExp(
      `^(?:aiplatform|${AWS_OWN_SEGMENT}-aiplatform|aiplatform\\.${AWS_OWN_SEGMENT}\\.rep|[a-z0-9-]+\\.p)\\.googleapis\\.com$`,
    ),
  },
  anthropicGoogleCloud: {
    variables: [{ name: 'ANTHROPIC_GOOGLE_CLOUD_BASE_URL' }],
    ownHost: new RegExp(
      `^(?:claude|claude\\.${AWS_OWN_SEGMENT}\\.rep|[a-z0-9-]+\\.p)\\.googleapis\\.com$`,
    ),
  },
  foundry: {
    variables: [
      { name: 'ANTHROPIC_FOUNDRY_BASE_URL' },
      {
        name: 'ANTHROPIC_FOUNDRY_RESOURCE',
        urlOf: (value: string) => `https://${value}.services.ai.azure.com`,
      },
    ],
    ownHost:
      /^[a-z0-9-]{2,64}\.(?:services\.ai|cognitiveservices|openai)\.azure\.(?:com|us|cn)$/,
  },
}

/** Official `KYn`. */
function endpointVariablesFor(
  provider: string,
): { name: string; urlOf?: (value: string) => string }[] {
  return PROVIDER_ENDPOINT_TOPOLOGY[provider]?.variables ?? []
}

/** Official `k`: URL verdict — unparsable / foreign / own / insecure. */
export type EndpointVerdict = 'unparsable' | 'foreign' | 'own' | 'insecure'

export function endpointVerdict(provider: string, url: string): EndpointVerdict {
  const entry = PROVIDER_ENDPOINT_TOPOLOGY[provider]
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unparsable'
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (entry === undefined || !entry.ownHost.test(host)) return 'foreign'
  return parsed.protocol === 'https:' ? 'own' : 'insecure'
}

/** Official `YYn`: foreign/insecure/unparsable endpoint overrides per provider. */
function detectForeignEndpoints(
  provider: string,
  readEnv: (name: string) => string | undefined,
): { variable: string; url: string; verdict: EndpointVerdict }[] {
  const detected: { variable: string; url: string; verdict: EndpointVerdict }[] =
    []
  for (const { name, urlOf } of endpointVariablesFor(provider)) {
    const raw = readEnv(name)
    if (!raw) continue
    const url = urlOf === undefined ? raw : urlOf(raw)
    const verdict = endpointVerdict(provider, url)
    if (verdict !== 'own') detected.push({ variable: name, url, verdict })
  }
  return detected
}

// ───────────────── official override detectors ($w/Gw/Ww/jw/Vw) ─────────────────

/** Official `mi`. */
function pinEntry(
  variable: string,
  value: string | undefined,
): ProviderOverride[] {
  return value
    ? [{ variable, envKey: variable, value, pinVariables: [variable] }]
    : []
}

/** Official `$w`. */
function unixSocketOverrides(): ProviderOverride[] {
  return process.env.ANTHROPIC_UNIX_SOCKET
    ? [
        {
          variable: 'ANTHROPIC_UNIX_SOCKET',
          envKey: 'ANTHROPIC_UNIX_SOCKET',
          value: process.env.ANTHROPIC_UNIX_SOCKET,
          pinVariables: [],
        },
      ]
    : []
}

/** Official `Gw`. */
function firstPartyOverrides(
  baseUrl?: string,
  dispatch: ProviderDispatch = 'inference',
): ProviderOverride[] {
  if (process.env.ANTHROPIC_UNIX_SOCKET) return []
  const anthropicBase = process.env.ANTHROPIC_BASE_URL
  const filesBase = process.env.CLAUDE_CODE_API_BASE_URL
  if (baseUrl !== undefined) {
    if (isFirstPartyHttpsUrl(baseUrl)) return []
    if (baseUrl === anthropicBase) return pinEntry('ANTHROPIC_BASE_URL', anthropicBase)
    if (baseUrl === providerPolicyHooks.wifProfileBaseUrlInUse?.())
      return [
        {
          variable: 'the base_url of the active WIF profile',
          envKey: undefined,
          value: baseUrl,
          pinVariables: ['ANTHROPIC_BASE_URL'],
        },
      ]
    if (baseUrl === filesBase)
      return dispatch === 'files'
        ? pinEntry('CLAUDE_CODE_API_BASE_URL', filesBase)
        : [
            {
              variable: 'CLAUDE_CODE_API_BASE_URL',
              envKey: 'CLAUDE_CODE_API_BASE_URL',
              value: filesBase as string,
              pinVariables: ['ANTHROPIC_BASE_URL'],
            },
          ]
    return [
      {
        variable: 'the API base URL this request uses',
        envKey: undefined,
        value: baseUrl,
        pinVariables:
          dispatch === 'inference'
            ? ['ANTHROPIC_BASE_URL']
            : ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_API_BASE_URL'],
      },
    ]
  }
  if (anthropicBase)
    return isFirstPartyHttpsUrl(anthropicBase)
      ? []
      : pinEntry('ANTHROPIC_BASE_URL', anthropicBase)
  const overrides: ProviderOverride[] = []
  if (filesBase && !isFirstPartyHttpsUrl(filesBase))
    overrides.push(...pinEntry('CLAUDE_CODE_API_BASE_URL', filesBase))
  const wifBase = providerPolicyHooks.wifProfileBaseUrlInUse?.()
  if (wifBase && !isFirstPartyHttpsUrl(wifBase))
    overrides.push({
      variable: 'the base_url of the active WIF profile',
      envKey: undefined,
      value: wifBase,
      pinVariables: ['ANTHROPIC_BASE_URL'],
    })
  return overrides
}

/**
 * Official `Qr` (saved gateway sign-in reader) — STAGED: OCC has no Cloud
 * gateway surface (divergence 2), so no saved gateway sign-in can exist.
 */
function savedGatewaySignIn():
  | { url: string; unpinned?: boolean }
  | undefined {
  return undefined
}

/**
 * Official `zye`: managed settings force the gateway sign-in. OCC's
 * forceLoginMethod enum has no "gateway" member and forceLoginGatewayUrl is
 * not an OCC schema key — both reads stay possible through the passthrough
 * slot but are never produced by OCC policy parsing (divergence 2).
 */
function isGatewayForcedByPolicy(): boolean {
  const policy = getSettingsForSource('policySettings') as
    | Record<string, unknown>
    | null
  return (
    policy?.forceLoginMethod === 'gateway' ||
    policy?.forceLoginGatewayUrl !== undefined
  )
}

/** Official `Ww` — gateway sign-in override (STAGED inputs, faithful shape). */
function gatewayOverrides(): ProviderOverride[] {
  const signIn = savedGatewaySignIn()
  if (!signIn) return []
  /* c8 -- the forceLoginGatewayUrl equality exemption is unreachable while
     savedGatewaySignIn() is undefined; kept structurally for parity. */
  return [
    {
      variable: signIn.unpinned
        ? 'ANTHROPIC_BASE_URL'
        : 'the saved gateway sign-in',
      envKey: signIn.unpinned ? 'ANTHROPIC_BASE_URL' : undefined,
      value: signIn.url,
      pinVariables: ['ANTHROPIC_BASE_URL'],
      matchesPin: (pinned: string) => {
        try {
          return new URL(pinned).origin === signIn.url
        } catch {
          return false
        }
      },
    },
  ]
}

/** Official `jw`. */
function cloudProviderOverrides(provider: string): ProviderOverride[] {
  return detectForeignEndpoints(provider, envValue).map(entry => ({
    variable: entry.variable,
    envKey: entry.variable,
    value: envValue(entry.variable) ?? entry.url,
    pinVariables: [entry.variable],
  }))
}

/** Official `Vw`. */
function overridesFor(
  provider: string,
  baseUrl?: string,
  dispatch: ProviderDispatch = 'inference',
): ProviderOverride[] {
  const unix = unixSocketOverrides()
  switch (provider) {
    case 'firstParty':
      return [...unix, ...firstPartyOverrides(baseUrl, dispatch)]
    case 'gateway':
      return [...unix, ...gatewayOverrides()]
    default:
      return [...unix, ...cloudProviderOverrides(provider)]
  }
}

/** Official `qf`: which overrides promote the descriptor to customEndpoint. */
function promotesToCustomEndpoint(
  override: ProviderOverride,
  dispatch: ProviderDispatch,
): boolean {
  if (override.variable === 'ANTHROPIC_UNIX_SOCKET') return false
  if (override.envKey?.startsWith('AWS_ENDPOINT_URL')) return false
  return override.envKey !== 'CLAUDE_CODE_API_BASE_URL' || dispatch === 'files'
}

/** Official `Wf`. */
function describeProvider(
  provider: string,
  baseUrl?: string,
  dispatch: ProviderDispatch = 'inference',
): ProviderDescriptor {
  const overrides = overridesFor(provider, baseUrl, dispatch)
  const isCustom =
    provider !== 'gateway' &&
    overrides.some(override => promotesToCustomEndpoint(override, dispatch))
  return {
    provider,
    name: isCustom
      ? 'customEndpoint'
      : provider === 'firstParty'
        ? 'anthropic'
        : officialProviderName(provider as APIProvider),
    overrides,
    dispatch,
  }
}

// ───────────────────── official tier readers (BYn/wmt/UYn/Pb) ─────────────────────

/**
 * Official `BYn()` mapped to OCC's flat model (divergence notes in header):
 * the machine/admin tier documents in precedence order — MDM (HKLM/plist,
 * admin-only) then managed-settings.json + drop-ins. HKCU is EXCLUDED
 * (user-writable; official `sc()` zeroes user-writable bases from this view).
 */
function machineTierDocs(): SettingsJson[] {
  const docs: SettingsJson[] = []
  const mdm = getMdmSettings()
  if (Object.keys(mdm.settings).length > 0) docs.push(mdm.settings)
  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings && Object.keys(fileSettings).length > 0)
    docs.push(fileSettings)
  return docs
}

/**
 * Official `wmt()` for the keys this module reads: the machine tier's
 * `allowedProviders` is the first defined list across the machine docs
 * (per-key first-wins ≡ the official merged admin tier for this key).
 */
function machineTierSettings(): SettingsJson | null {
  for (const doc of machineTierDocs()) {
    if (doc.allowedProviders !== undefined) return doc
  }
  return null
}

/**
 * Official `UYn()`: the remote tier's settings + served-snapshot flag.
 * servedSnapshot maps to FALSE (divergence 1): OCC's sessionCache cannot
 * distinguish a session-served document from the stale user-writable
 * remote-settings.json disk load, so it never vouches for remote pins.
 */
function remotePolicyState(): {
  settings: SettingsJson | null
  servedSnapshot: boolean
} {
  const remote = getRemoteManagedSettingsSyncFromCache()
  return {
    settings:
      remote && Object.keys(remote).length > 0 ? (remote as SettingsJson) : null,
    servedSnapshot: false,
  }
}

/** Official `Pb()` — FALSE (divergence 1: no verified-payload state in OCC). */
function isRemotePolicyVerified(): boolean {
  return false
}

/** Official `dzt()` — parent process policy list; STAGED (divergence 4). */
function parentPolicyList(): { allowedProviders?: string[]; env?: unknown } | null {
  return null
}

/** Official `Kw()` — {machine, slot} with the identity-keyed `cl` cache. */
let machineSlotCache:
  | { slot: SettingsJson | null; machine: SettingsJson | null }
  | undefined

function machineAndSlot(): {
  machine: SettingsJson | null
  slot: SettingsJson | null
} {
  const slot = getSettingsForSource('policySettings')
  if (machineSlotCache === undefined || machineSlotCache.slot !== slot)
    machineSlotCache = { slot, machine: machineTierSettings() }
  return { machine: machineSlotCache.machine, slot: machineSlotCache.slot }
}

/** Official `Gye()`: machine ∩ slot (remote can only narrow the machine list). */
export function effectiveAllowedProviders(): string[] | undefined {
  const { machine, slot } = machineAndSlot()
  const machineList = machine?.allowedProviders
  const slotList = slot?.allowedProviders
  if (machineList === undefined) return slotList
  if (slotList === undefined) return machineList
  return machineList.filter(name => slotList.includes(name))
}

/** Official `hl(e=BYn())`: does any machine source carry the list? */
function machineCarriesList(docs: SettingsJson[] = machineTierDocs()): boolean {
  return docs.some(doc => doc.allowedProviders !== undefined)
}

/** Official `yi()`: which managed source can vouch for env pins. */
function pinSourcePhrase(): string {
  return machineCarriesList()
    ? "this machine's managed settings (MDM or managed-settings.json: a machine source carries an allowedProviders list, so only its env can pin here)"
    : 'the same managed source that sets the list'
}

// ───────────────────── official pin machinery (Yw/pl/Zf/zw) ─────────────────────

/** Official `pl`: union a settings doc's `env` string values into the pins. */
function addEnvPins(
  pins: Map<string, Set<string>>,
  env: Record<string, string> | undefined,
): void {
  for (const [variable, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') {
      const set = pins.get(variable) ?? new Set<string>()
      set.add(value.trim())
      pins.set(variable, set)
    }
  }
}

/** Official `Yw`: compute the pin map (undefined when no list is in force). */
function computePins(): Map<string, Set<string>> | undefined {
  if (effectiveAllowedProviders() === undefined) return undefined
  const pins = new Map<string, Set<string>>()
  const docs = machineTierDocs()
  for (const doc of docs) addEnvPins(pins, doc.env)
  const machineHasList = machineCarriesList(docs)
  const { settings: remote, servedSnapshot } = remotePolicyState()
  if (
    remote !== null &&
    (servedSnapshot || isRemotePolicyVerified()) &&
    !machineHasList &&
    remote.allowedProviders !== undefined
  )
    addEnvPins(pins, remote.env)
  if (machineHasList || remote?.allowedProviders !== undefined) return pins
  const parent = parentPolicyList()
  if (parent !== null && parent.allowedProviders !== undefined)
    addEnvPins(pins, isRecord(parent.env) ? (parent.env as Record<string, string>) : undefined)
  return pins
}

/** Official `zw()` with the identity-keyed `jf` cache ({slot, verified}). */
let pinCache:
  | {
      slot: SettingsJson | null
      verified: boolean
      pins: Map<string, Set<string>> | undefined
    }
  | undefined

function getPins(): Map<string, Set<string>> | undefined {
  const slot = getSettingsForSource('policySettings')
  const verified = isRemotePolicyVerified()
  if (
    pinCache !== undefined &&
    pinCache.slot === slot &&
    pinCache.verified === verified
  )
    return pinCache.pins
  const pins = computePins()
  pinCache = { slot, verified, pins }
  return pins
}

/** Official `Zf`: is this override sanctioned by a managed env pin? */
function isPinned(override: ProviderOverride): boolean {
  const pins = getPins()
  if (pins === undefined) return false
  const matches = override.matchesPin ?? ((pinned: string) => pinned === override.value)
  return override.pinVariables.some(variable =>
    [...(pins.get(variable) ?? [])].some(matches),
  )
}

// ───────────────────── official decision core (Ie/N_e/MJ) ─────────────────────

/**
 * Official `Ie()` mapped to OCC: the raw provider name (NOT the
 * allowedProviders entry name — `Wf` does that mapping). OCC's
 * getAPIProvider() never returns "gateway" and has no anthropicGoogleCloud
 * branch (folded into firstParty); 'anthropic_aws' is fixed up to the
 * official 'anthropicAws'. The official gateway pre-checks (`Qr()||uzt()||
 * pzt()`) are STAGED (divergence 2).
 */
function currentRawProvider(): string {
  const provider = getAPIProvider()
  return provider === 'anthropic_aws' ? 'anthropicAws' : provider
}

/** Official `N_e()`: bedrock + CLAUDE_CODE_USE_MANTLE (raw truthy) → mantle. */
function promotedProvider(provider: string): string | null {
  if (provider === 'bedrock' && process.env.CLAUDE_CODE_USE_MANTLE)
    return 'mantle'
  return null
}

/** Official `MJ`. */
export function decideProviderAllowance(
  provider: string = currentRawProvider(),
  baseUrl?: string,
  dispatch: ProviderDispatch = 'inference',
): ProviderDecision | undefined {
  const allowed = effectiveAllowedProviders()
  if (allowed === undefined) return undefined
  const descriptors = [describeProvider(provider, baseUrl, dispatch)]
  const promoted = promotedProvider(provider)
  if (promoted !== null && promoted !== provider)
    descriptors.push(describeProvider(promoted))
  const refused: RefusedProvider[] = []
  for (const descriptor of descriptors) {
    if (!allowed.includes(descriptor.name)) {
      refused.push({
        ...descriptor,
        reason: 'not_listed',
        override: descriptor.overrides[0],
      })
      continue
    }
    const unpinned = descriptor.overrides.find(
      override => !isPinned(override),
    )
    if (unpinned !== undefined)
      refused.push({ ...descriptor, reason: 'endpoint', override: unpinned })
  }
  if (refused.length === 0) return undefined
  return {
    refused,
    allowed,
    message: buildProviderRefusalMessage(refused, allowed),
  }
}

// ───────────────── official fail-close throttle (Vf/bl/yl/HYe) ─────────────────

/** Official `Vf` cell. */
let policyUnreadableFailedAt = 0

/**
 * Official `bl()`: within 60 s of a failed policy read → stay fail-closed
 * without re-reading; otherwise invalidate the settings caches (`jo()` ≡
 * resetSettingsCache + a fresh load) and re-check `Y6()`.
 */
function isPolicyUnreadableThrottled(): boolean {
  const now = Date.now()
  if (now - policyUnreadableFailedAt < POLICY_UNREADABLE_RETRY_MS) return true
  resetSettingsCache()
  getSettingsWithErrors()
  const failed = hasNonOsDeniedAdminPolicyLoadFailures()
  policyUnreadableFailedAt = failed ? now : 0
  return failed
}

/** Official `yl()`. */
function managedPolicyUnreadableText(): string | undefined {
  return hasNonOsDeniedAdminPolicyLoadFailures() && isPolicyUnreadableThrottled()
    ? MANAGED_UNREADABLE_PROVIDER_TEXT
    : undefined
}

/** Official `HYe(e)`: the refusal (or unreadable-policy) message, if any. */
export function providerAllowanceMessage(
  provider: string = 'firstParty',
): string | undefined {
  return managedPolicyUnreadableText() ?? decideProviderAllowance(provider)?.message
}

/** Official `Yf`: settle the remote policy before deciding (divergence 5). */
async function settleRemotePolicyCheck(provider: string): Promise<void> {
  const { settings: remote, servedSnapshot } = remotePolicyState()
  if (remote?.allowedProviders === undefined || servedSnapshot || isRemotePolicyVerified())
    return
  if (machineCarriesList()) return
  const decision = decideProviderAllowance(provider)
  if (
    decision !== undefined &&
    decision.refused.every(refusal => refusal.reason === 'endpoint')
  )
    await (providerPolicyHooks.settleRemotePolicy?.() ?? Promise.resolve())
}

/** Official `nmn`: the startup/login auth-validity gate. */
export async function validateProviderAllowed(
  provider: string = currentRawProvider(),
): Promise<ProviderValidationResult | undefined> {
  const unreadable = managedPolicyUnreadableText()
  if (unreadable !== undefined)
    return {
      valid: false,
      reason: 'managed_settings_invalid',
      policyUnreadable: true,
      message: unreadable,
    }
  await settleRemotePolicyCheck(provider)
  const decision = decideProviderAllowance(provider)
  if (decision === undefined) return undefined
  // Telemetry rn("auth_force_login_org","provider_not_allowed",{api_provider})
  // is STAGED — OCC analytics is an empty implementation (divergence 6).
  return {
    valid: false,
    reason: 'provider_not_allowed',
    message: decision.message,
  }
}

/** Official `B$t`: the per-request gate — throws ProviderNotAllowedError. */
export function assertProviderAllowed(
  provider: string = currentRawProvider(),
  baseUrl?: string,
  dispatch: ProviderDispatch = 'inference',
): void {
  if (hasNonOsDeniedAdminPolicyLoadFailures() && isPolicyUnreadableThrottled())
    throw new ProviderNotAllowedError(MANAGED_UNREADABLE_PROVIDER_TEXT)
  const decision = decideProviderAllowance(provider, baseUrl, dispatch)
  if (decision !== undefined)
    throw new ProviderNotAllowedError(decision.message)
}

// ───────────────── official message helpers (bi/_n/Kr/ar/gl/ok/qw) ─────────────────

/** Official `bi`: where an env variable's value came from. */
interface EnvProvenance {
  managed: boolean
  files: string[]
  shell: boolean
}

function envProvenance(variable: string | undefined): EnvProvenance {
  if (variable === undefined) return { managed: false, files: [], shell: false }
  const files: string[] = []
  for (const source of [
    'flagSettings',
    'localSettings',
    'projectSettings',
    'userSettings',
  ] as const) {
    if (getSettingsForSource(source)?.env?.[variable]) {
      const path = getSettingsFilePathForSource(source)
      files.push(
        path === undefined
          ? source === 'flagSettings'
            ? '--settings'
            : source
          : sanitizeMessageText(path).replace(/[\t\n\r]+/g, ' '),
      )
    }
  }
  const managed = !!getSettingsForSource('policySettings')?.env?.[variable]
  return {
    managed,
    files,
    shell: !!process.env[variable] && !managed && files.length === 0,
  }
}

/** Official `_n`. */
function provenancePhrase(provenance: EnvProvenance): string {
  if (provenance.managed) return ' in your organization\'s managed settings'
  const sources = [
    ...(provenance.shell ? ['your shell environment'] : []),
    ...provenance.files.map(file => `the "env" block of ${file}`),
  ]
  return sources.length > 0 ? ` in ${sources.join(' and ')}` : ''
}

/** Official `Kr`. */
function removalHint(provenance: EnvProvenance): string {
  return provenance.files.length > 0
    ? ` (remove it from ${provenance.files.join(', ')}${
        provenance.shell ? ' and your shell' : ''
      })`
    : ''
}

/** Official `ar`. */
function urlHostLabel(url: string): string {
  try {
    return url ? new URL(url).host : 'a custom endpoint'
  } catch {
    return 'a custom endpoint'
  }
}

/** Official `gl`. */
function urlOriginPathLabel(url: string): string {
  try {
    if (!url) return 'a custom endpoint'
    const parsed = new URL(url)
    return sanitizeMessageText(`${parsed.origin}${parsed.pathname}`)
  } catch {
    return 'a custom endpoint'
  }
}

/** Official `ok`: unrecognized allowedProviders entries from the parse layer. */
function unrecognizedEntryNotice(): { count: number; file?: string } {
  const records =
    getCachedAdminPolicyLoadErrors()?.filter(
      record =>
        typeof record.path === 'string' &&
        record.path.startsWith('allowedProviders['),
    ) ?? []
  return { count: records.length, file: records[0]?.file }
}

/** Official `qw`: setup hints for allowed providers. */
const PROVIDER_SETUP_HINTS: Record<string, string> = {
  bedrock:
    'Amazon Bedrock: set CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials (https://code.claude.com/docs/en/amazon-bedrock)',
  vertex:
    'Google Vertex AI: set CLAUDE_CODE_USE_VERTEX=1 with Google Cloud credentials (https://code.claude.com/docs/en/google-vertex-ai)',
  foundry:
    'Microsoft Foundry: set CLAUDE_CODE_USE_FOUNDRY=1 (https://code.claude.com/docs/en/microsoft-foundry)',
  anthropicAws:
    'Claude Platform on AWS: set CLAUDE_CODE_USE_ANTHROPIC_AWS=1 (https://code.claude.com/docs/en/claude-platform-on-aws)',
  gateway:
    'the Cloud gateway: start claude on a machine whose policy requires the gateway sign-in (forceLoginMethod "gateway") and sign in with /login',
}

/** Official `Qw`. */
function providerEnvDescriptor(
  provider: string,
): { label: string; variable: string } | undefined {
  switch (provider) {
    case 'firstParty':
    case 'gateway':
      return undefined
    default:
      return {
        label: PROVIDER_LABELS[provider],
        variable: PROVIDER_ENV_VARS[provider],
      }
  }
}

// ───────────────── official message builders (lk/Xw/Jw) ─────────────────

/** Official `lk`. */
export function buildProviderRefusalMessage(
  refused: RefusedProvider[],
  allowed: string[],
): string {
  const notice = unrecognizedEntryNotice()
  const noticeLines =
    notice.count > 0
      ? [
          `Admins: ${notice.count} allowedProviders ${plural(
            notice.count,
            'entry',
            'entries',
          )}${notice.file ? ` in ${notice.file}` : ''} ${
            notice.count === 1 ? 'is' : 'are'
          } not a known provider name and ${
            notice.count === 1 ? 'was' : 'were'
          } ignored; known names: ${ALLOWED_PROVIDER_NAMES.join(', ')}.`,
        ]
      : []
  const details = refused.map(entry => refusalDetail(entry, allowed))
  const cause = details.map(detail => detail.cause).join(' ')
  if (allowed.length === 0)
    return [
      `Your organization's managed settings allow Claude Code to use no API provider at all (allowedProviders ${
        notice.count > 0 ? 'lists only unrecognized entries' : 'is an empty list'
      }), so it cannot start on this machine.`,
      cause,
      '',
      'To continue: ask your administrator to list at least one provider in allowedProviders.',
      ...noticeLines,
    ].join('\n')
  const steps = uniq(details.flatMap(detail => detail.steps))
  const admin = uniq(details.flatMap(detail => detail.admin))
  return [
    `Your organization's managed settings allow Claude Code to use: ${allowed
      .map(providerDisplayName)
      .join(', ')}.`,
    cause,
    '',
    `To continue: ${steps.join(' Or: ')}`,
    ...admin.map(line => `Admins: ${line}`),
    ...noticeLines,
  ].join('\n')
}

/** Official `Xw` (@198045xxx, byte-exact message texts). */
function refusalDetail(
  refusal: RefusedProvider,
  allowed: string[],
): RefusalDetail {
  const { provider, name, reason } = refusal
  const override =
    name === 'customEndpoint' && reason === 'not_listed'
      ? refusal.overrides.find(entry => promotesToCustomEndpoint(entry, refusal.dispatch))
      : refusal.override

  // Arm 1: tunnelled session (ANTHROPIC_UNIX_SOCKET).
  if (override?.variable === 'ANTHROPIC_UNIX_SOCKET')
    return {
      cause:
        'This session sends every request through a local socket (ANTHROPIC_UNIX_SOCKET) — as a `claude ssh` session does, or to a forwarder of your own — to a destination this machine cannot verify.',
      steps: [
        'run claude on this machine directly (without ANTHROPIC_UNIX_SOCKET) and sign in here, or ask your administrator.',
      ],
      admin: [
        'no allowedProviders entry admits a tunnelled session, because its destination cannot be verified or pinned; machines that must accept `claude ssh` need allowedProviders unset.',
      ],
    }

  // Arm 2: cloud provider with a foreign/insecure endpoint → Jw.
  if (
    override !== undefined &&
    provider !== 'firstParty' &&
    provider !== 'gateway' &&
    (name === 'customEndpoint' ||
      (reason === 'endpoint' && override.envKey !== 'ANTHROPIC_UNIX_SOCKET'))
  )
    return cloudEndpointDetail(refusal, override, allowed)

  // Arm 3: listed provider, endpoint differs from the managed pin.
  if (reason === 'endpoint' && override !== undefined && name !== 'customEndpoint') {
    const setupPhrase = providerSetupPhrase(provider)
    const provenance = envProvenance(override.envKey)
    if (override.envKey === undefined)
      return {
        cause: `This session is signed in to the ${setupPhrase} at ${urlHostLabel(
          override.value,
        )}, which is not the gateway your organization's managed settings name.`,
        steps: [
          'run: claude auth logout, then sign in again with /login, or ask your administrator.',
        ],
        admin: [
          'under allowedProviders, a gateway sign-in is admitted only for forceLoginGatewayUrl or an ANTHROPIC_BASE_URL pinned in a managed env block this machine can vouch for (its own administrator sources; the served document only when no machine source sets the list).',
        ],
      }
    return {
      cause: `This session is set up for ${setupPhrase} with ${
        override.variable
      } pointing at ${urlOriginPathLabel(override.value)}${provenancePhrase(
        provenance,
      )}, which differs from any value your organization's managed settings pin.`,
      steps: provenance.managed
        ? ['ask your administrator.']
        : [
            `unset ${override.variable}${removalHint(
              provenance,
            )} to use ${setupPhrase}'s own endpoints, then run claude again.`,
          ],
      admin: [
        `under allowedProviders, ${override.variable} is honored only when the "env" block of ${pinSourcePhrase()} pins the same value; set it there to sanction this endpoint.`,
      ],
    }
  }

  // Arm 4: direct Anthropic API session.
  if (name === 'anthropic') {
    const hints = allowed
      .map(entry => PROVIDER_SETUP_HINTS[entry])
      .filter((hint): hint is string => hint !== undefined)
    const unpinnedEnv = refusal.overrides.find(
      entry => entry.envKey !== undefined && !isPinned(entry),
    )
    return {
      cause:
        'This session would go to the Anthropic API directly (a claude.ai or Console sign-in, or an Anthropic API key).',
      steps:
        hints.length > 0
          ? [
              `configure an allowed provider — ${hints.join(
                '; ',
              )} — then run claude again, or ask your administrator.`,
            ]
          : ['ask your administrator.'],
      admin: [
        'add "anthropic" to allowedProviders to permit it.',
        ...(unpinnedEnv
          ? [
              `${unpinnedEnv.variable} (${urlOriginPathLabel(
                unpinnedEnv.value,
              )}) is also set and not pinned: pin it in the "env" block of ${pinSourcePhrase()} or have it unset, or it is refused next.`,
            ]
          : []),
      ],
    }
  }

  // Arm 5: customEndpoint (listed or not) with a concrete override.
  if (name === 'customEndpoint' && override !== undefined) {
    const hostLabel = `${urlHostLabel(override.value)}${
      /^http:/i.test(override.value) ? ' over plain http' : ''
    }`
    const isWif = override.envKey === undefined
    const provenance = envProvenance(override.envKey)
    const becausePhrase = isWif
      ? ` because ${override.variable} points there`
      : ` because ${override.variable} is set${provenancePhrase(provenance)}`
    const canUseAnthropic = !provenance.managed && allowed.includes('anthropic')
    const unsetStep = isWif
      ? 'remove base_url from that WIF profile'
      : `unset ${override.variable}${removalHint(provenance)}`
    const pinSource = pinSourcePhrase()
    const pinStep = isWif
      ? `set ANTHROPIC_BASE_URL to it in the "env" block of ${pinSource} (it outranks a profile's base_url)`
      : `pin ${override.variable} in the "env" block of ${pinSource}`
    if (reason === 'endpoint')
      return {
        cause: `This session sends requests to ${urlOriginPathLabel(
          override.value,
        )}${becausePhrase}, which differs from the value your organization's managed settings pin (or that pin comes from a source this session cannot vouch for yet).`,
        steps: canUseAnthropic
          ? [
              `${unsetStep} to use the Anthropic API directly, then run claude again, or ask your administrator.`,
            ]
          : ['ask your administrator.'],
        admin: [
          `allowedProviders lists "customEndpoint", but this endpoint is not pinned: ${pinStep} so only your endpoint is admitted.`,
        ],
      }
    return {
      cause: `This session sends requests to ${hostLabel}${becausePhrase}.`,
      steps: canUseAnthropic
        ? [`${unsetStep} to use the Anthropic API directly, then run claude again.`]
        : ['ask your administrator.'],
      admin: provenance.managed
        ? [
            `managed settings set ${override.variable} but allowedProviders does not list "customEndpoint"; add it or remove the env entry.`,
          ]
        : [
            `to sanction this endpoint, add "customEndpoint" to allowedProviders and ${pinStep}.`,
          ],
    }
  }

  // Arm 6: gateway (STAGED inputs — unreachable in OCC, divergence 2).
  if (name === 'gateway') {
    const label = PROVIDER_LABELS.gateway
    if (isGatewayForcedByPolicy())
      return {
        cause: `This session is set up for the ${label} because managed settings on this machine require the gateway sign-in (forceLoginMethod "gateway" / forceLoginGatewayUrl).`,
        steps: [
          'ask your administrator — this policy cannot be satisfied from here.',
        ],
        admin: [
          'managed settings require the Cloud gateway sign-in but allowedProviders does not list "gateway"; add it or remove the gateway requirement.',
        ],
      }
    const signIn = savedGatewaySignIn()
    return {
      cause: signIn?.unpinned
        ? `This session is set up for a ${label} because CLAUDE_CODE_USE_GATEWAY is set with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.`
        : `This session is set up for a ${label} because you are signed in to one.`,
      steps: [
        signIn?.unpinned
          ? 'unset CLAUDE_CODE_USE_GATEWAY, then run claude again.'
          : 'run: claude auth logout, then run claude again.',
      ],
      admin: ['add "gateway" to allowedProviders to permit it.'],
    }
  }

  // Arm 7: cloud provider selected by its env variable.
  const descriptor = providerEnvDescriptor(provider)
  if (descriptor === undefined)
    return {
      cause: `This session is set up for ${providerSetupPhrase(provider)}.`,
      steps: ['ask your administrator.'],
      admin: [`add "${name}" to allowedProviders to permit it.`],
    }
  const { label, variable } = descriptor
  const provenance = envProvenance(variable)
  return {
    cause: `This session is set up for ${label} because ${variable} is set${provenancePhrase(
      provenance,
    )}.`,
    steps: provenance.managed
      ? ['ask your administrator — nothing on this machine can change it.']
      : [`unset ${variable}${removalHint(provenance)}, then run claude again.`],
    admin: provenance.managed
      ? [
          `managed settings select ${label} (env.${variable}) but allowedProviders does not list "${name}"; add it or remove the env entry.`,
        ]
      : [`add "${name}" to allowedProviders to permit it.`],
  }
}

/** Official `Jw` (@198049xxx–198052xxx, byte-exact message texts). */
function cloudEndpointDetail(
  refusal: RefusedProvider,
  override: ProviderOverride,
  allowed: string[],
): RefusalDetail {
  const { provider, name, reason } = refusal
  const setupPhrase = providerSetupPhrase(provider)
  const variable = override.variable
  const detected = detectForeignEndpoints(provider, envValue).find(
    entry => entry.variable === variable,
  )
  const url = detected?.url ?? override.value
  const verdict = detected?.verdict ?? 'foreign'
  const provenance = envProvenance(override.envKey)
  const cause =
    verdict === 'unparsable'
      ? `${variable} is set${provenancePhrase(
          provenance,
        )} to a value that is not a URL, so where this session's ${setupPhrase} requests would go cannot be told.`
      : verdict === 'insecure'
        ? `This session sends its ${setupPhrase} requests to ${urlHostLabel(
            url,
          )} over plain http because ${variable} is set${provenancePhrase(
            provenance,
          )}; ${setupPhrase} is only reached over https.`
        : variable.startsWith('AWS_ENDPOINT_URL')
          ? `${variable} is set${provenancePhrase(
              provenance,
            )} and points the AWS SDK's ${setupPhrase} clients at ${urlHostLabel(
              url,
            )}; that is not one of ${setupPhrase}'s own service hosts.`
          : variable === 'ANTHROPIC_FOUNDRY_RESOURCE'
            ? `ANTHROPIC_FOUNDRY_RESOURCE is set${provenancePhrase(
                provenance,
              )} to a value that makes the ${setupPhrase} endpoint ${urlHostLabel(
                url,
              )}; that is not one of ${setupPhrase}'s own service hosts.`
            : `This session sends its ${setupPhrase} requests to ${urlHostLabel(
                url,
              )} because ${variable} is set${provenancePhrase(
                provenance,
              )}; that is not one of ${setupPhrase}'s own service hosts.`
  const canUseOwnProvider =
    !provenance.managed && allowed.includes(officialProviderName(provider as APIProvider))
  const unsetStep =
    variable === 'ANTHROPIC_FOUNDRY_RESOURCE'
      ? 'set ANTHROPIC_FOUNDRY_RESOURCE to the bare resource name (such as my-resource), not a URL or host, then run claude again.'
      : variable === 'ANTHROPIC_FOUNDRY_BASE_URL' &&
          !envValue('ANTHROPIC_FOUNDRY_RESOURCE')
        ? `replace ANTHROPIC_FOUNDRY_BASE_URL${removalHint(
            provenance,
          )} with ANTHROPIC_FOUNDRY_RESOURCE set to your Foundry resource name, then run claude again.`
        : `unset ${variable}${removalHint(
            provenance,
          )} to use ${setupPhrase}'s own endpoint, then run claude again.`
  const steps = canUseOwnProvider ? [unsetStep] : ['ask your administrator.']
  const pinStep = `pin ${variable} to it in the "env" block of ${pinSourcePhrase()}`
  if (reason === 'endpoint')
    return {
      cause: `${cause} It differs from the value your organization's managed settings pin (or that pin comes from a source this session cannot vouch for yet).`,
      steps,
      admin: [
        name === 'customEndpoint'
          ? `allowedProviders lists "customEndpoint", but this endpoint is not pinned: ${pinStep} so only your endpoint is admitted.`
          : `under allowedProviders, ${variable} is honored only when pinned: ${pinStep}, or have it unset.`,
      ],
    }
  return {
    cause,
    steps,
    admin: provenance.managed
      ? [
          `managed settings set ${variable} but allowedProviders does not list "customEndpoint"; add it (the managed value is then the pin) or correct the env entry.`,
        ]
      : [
          `under allowedProviders, ${variable} may only name ${setupPhrase}'s own service over https unless "customEndpoint" is listed and the endpoint is pinned; to sanction it, add "customEndpoint" and ${pinStep}.`,
        ],
  }
}

/** Test/reset hook — clears the `cl`/`jf`/`Vf` cells (official ct registry). */
export function resetAllowedProvidersCaches(): void {
  machineSlotCache = undefined
  pinCache = undefined
  policyUnreadableFailedAt = 0
}
