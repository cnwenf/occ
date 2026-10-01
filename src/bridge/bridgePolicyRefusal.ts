/**
 * Connected-bridge org-policy refusal (2.1.286 port).
 *
 * Official changelog: "Fixed Remote Control sessions (including
 * `claude remote-control`) staying connected after your organization's
 * policy turns Remote Control off; they now disconnect with a notice."
 *
 * Byte-verified against the official v286 linux-x64 binary (v285 has ZERO
 * hits for every string in this file):
 * - `WAe` = connectedBridgePolicyRefusal @202356353 (export map @218688688)
 * - notice `JDr` = "Remote Control was turned off by your organization's
 *   policy." and the allow_remote_sessions notice (both inside WAe)
 * - `Lb` per-policy verdict fn @200084227 (null / cache_miss / route_missing
 *   / latched / org_denied)
 * - `D0` verdictChanged subscription @200064192 → OCC onPolicyLimitsChange
 *   (src/services/policyLimits/index.ts)
 * - `jne`/`I3n`/`T` auth-mode gate @200064675–200064850 with
 *   `k = new Set(["prosumer_oauth","third_party_provider","custom_base_url"])`
 * - lanes: standalone @219444200+, sdk_host @222650000+, repl @225854300+
 */

import { getPolicyRestrictionFromCache } from '../services/policyLimits/index.js'
import type { Message } from '../types/message.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  getConfiguredApiKeyHelper,
} from '../utils/auth.js'
import { CLAUDE_AI_INFERENCE_SCOPE } from '../constants/oauth.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../utils/model/providers.js'
import { createSystemMessage } from '../utils/messages.js'

/** Official `JDr` — byte-verified inside WAe @202356353 (v286). */
export const BRIDGE_POLICY_REMOTE_CONTROL_NOTICE =
  "Remote Control was turned off by your organization's policy."

/** Official session-mirroring notice — byte-verified inside WAe (v286). */
export const BRIDGE_POLICY_SESSIONS_NOTICE =
  "Session mirroring was turned off by your organization's policy (allow_remote_sessions)."

export type BridgePolicyRefusal = {
  policy: string
  kind: 'org_denied'
  detail: string
}

/**
 * Auth-mode surface for the gate (official `T()` @200064850's `k` set).
 * Values are the exact strings official `jne()`/`I3n()` return.
 */
export type BridgePolicyAuthMode =
  | 'third_party_provider'
  | 'custom_base_url'
  | 'no_auth'
  | 'oauth_no_inference_scope'
  | 'prosumer_oauth'

const BRIDGE_POLICY_AUTH_MODE_SCOPE: ReadonlySet<BridgePolicyAuthMode> =
  new Set<BridgePolicyAuthMode>([
    'prosumer_oauth',
    'third_party_provider',
    'custom_base_url',
  ])

/**
 * Tunnel-socket check — coarse OCC map of official `L0()` @200064336, which
 * memoizes an `eGo({ANTHROPIC_UNIX_SOCKET, CLAUDE_CODE_OAUTH_TOKEN, ...})`
 * validation. OCC maps it to env presence (coarser; documented divergence —
 * the full eGo validation set was not dumped).
 */
function hasTunnelSocket(): boolean {
  return Boolean(process.env.ANTHROPIC_UNIX_SOCKET)
}

/**
 * Port of official `jne()` @200064850 + `I3n()` @200064675 (flattened; I3n
 * is jne's first two arms). Returns undefined when no auth mode applies.
 *
 * Coarse maps (documented):
 * - official `Us()` (custom-base-url predicate, chunk-local symbol not
 *   dumped) → `isFirstPartyAnthropicBaseUrl()` — the semantics are forced by
 *   the "custom_base_url" return string.
 * - official `Wc()` @199671241 (apiKeyHelper detection with extra
 *   profile-implicit/n8n conditions not ported) → `getConfiguredApiKeyHelper()`.
 */
export function getBridgePolicyAuthMode(): BridgePolicyAuthMode | undefined {
  // I3n arm 1: non-first-party provider
  if (getAPIProvider() !== 'firstParty') {
    return 'third_party_provider'
  }
  // I3n arm 2: first-party provider behind a custom base URL (no tunnel)
  if (!hasTunnelSocket() && !isFirstPartyAnthropicBaseUrl()) {
    return 'custom_base_url'
  }
  // jne: tunnel socket → no auth mode
  if (hasTunnelSocket()) {
    return undefined
  }
  // jne: raw API key (skipping apiKeyHelper) → no auth mode
  try {
    const { key } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (key) {
      return undefined
    }
  } catch {
    // official wraps the key read in try/catch and falls through
  }
  // jne: apiKeyHelper configured (Wc()) → no auth mode
  if (getConfiguredApiKeyHelper()) {
    return undefined
  }
  // jne: OAuth token inspection
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    return 'no_auth'
  }
  if (!tokens.scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE)) {
    return 'oauth_no_inference_scope'
  }
  if (tokens.subscriptionType == null) {
    return undefined
  }
  if (
    tokens.subscriptionType !== 'enterprise' &&
    tokens.subscriptionType !== 'team'
  ) {
    return 'prosumer_oauth'
  }
  return undefined
}

/** Port of official `T()` @200064850: mode !== undefined && k.has(mode). */
export function isBridgePolicyAuthModeInScope(): boolean {
  const mode = getBridgePolicyAuthMode()
  return mode !== undefined && BRIDGE_POLICY_AUTH_MODE_SCOPE.has(mode)
}

/**
 * Port of official `WAe(outboundOnly)` @202356353 (v286).
 *
 * Returns the first explicit org-policy denial across the checked policies,
 * or null when nothing refuses. NEVER returns a refusal on unknown/not-loaded
 * state — official maps null / cache_miss / route_missing verdicts to
 * `continue`, and wraps the whole scan in `catch{return null}`.
 *
 * Policies: outboundOnly ? ['allow_remote_control', 'allow_remote_sessions']
 *                        : ['allow_remote_control']  (byte-verified order).
 *
 * NO 'latched' arm: official Lb can return 'latched' from a process-wide
 * HIPAA policy lock (bmn()/policyLocks disableRemoteControl), which OCC has
 * not ported — staged (see gap-research-286/plugin-remotecontrol.md).
 */
export function connectedBridgePolicyRefusal(
  outboundOnly: boolean,
): BridgePolicyRefusal | null {
  const policies = outboundOnly
    ? ['allow_remote_control', 'allow_remote_sessions']
    : ['allow_remote_control']
  try {
    for (const policy of policies) {
      const restriction = getPolicyRestrictionFromCache(policy)
      // undefined → cache unavailable ('cache_miss'), null → policy absent
      // ('route_missing'): both continue — never disconnect on unknown.
      if (restriction === undefined || restriction === null) {
        continue
      }
      if (restriction.allowed) {
        continue
      }
      // restriction.allowed === false ⇔ official 'org_denied' verdict.
      // Official WAe org_denied continue-guard (byte-faithful structure):
      //   if (hS()?.restrictions[p]?.allowed !== false && !$3n() && !T()) continue
      // The first clause is false here (allowed === false), so the official
      // refuses unconditionally on explicit denial — the auth-mode gate T()
      // and $3n() (sessionFromServerFetch — NO OCC surface, staged) only
      // rescue verdicts whose raw cache disagrees, which OCC's
      // cache-as-verdict mapping cannot produce. The gate stays implemented
      // and exported (isBridgePolicyAuthModeInScope) for structural parity
      // and future verdict-store ports.
      return {
        policy,
        kind: 'org_denied',
        detail:
          policy === 'allow_remote_control'
            ? BRIDGE_POLICY_REMOTE_CONTROL_NOTICE
            : BRIDGE_POLICY_SESSIONS_NOTICE,
      }
    }
    return null
  } catch {
    // Official: `catch{return null}` — an error must never disconnect.
    return null
  }
}

/**
 * Official REPL-lane transcript dedup rule (byte-verified @225854300+):
 *   v.replace(Wr=>{let Si=Wr.at(-1);return Si?.type==="system"&&
 *     Si.subtype==="informational"&&Si.content===En?Wr:[...Wr,Dt(En,"notice")]})
 * i.e. skip the append when the LAST transcript entry is already an
 * informational system message with the identical content; otherwise append
 * createSystemMessage(detail, 'notice').
 *
 * Pure helper: returns the original array when deduped, a new array
 * otherwise. Wiring it into the REPL transcript store requires
 * useReplBridge.tsx/REPL changes (owned elsewhere) — staged.
 */
export function appendBridgePolicyNotice(
  messages: Message[],
  detail: string,
): Message[] {
  const last = messages.at(-1)
  if (
    last?.type === 'system' &&
    last.subtype === 'informational' &&
    last.content === detail
  ) {
    return messages
  }
  return [...messages, createSystemMessage(detail, 'notice')]
}
