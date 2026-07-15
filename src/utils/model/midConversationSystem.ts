/**
 * 2.1.207 #4 — "Fixed spurious prompt-injection warnings from benign
 * system-generated updates."
 *
 * When a model supports mid-conversation system turns, the harness injects
 * system-generated updates (reminders, rule modifications) into the
 * conversation as system turns. Without clarification the model can mistake
 * these benign system-generated updates for prompt injection and issue a
 * spurious warning. The system prompt therefore includes
 * MID_CONVERSATION_SYSTEM_INSTRUCTION, telling the model these system turns
 * are "system-controlled, unlike function results" — function results / tool
 * outputs remain the untrusted, flaggable channel.
 *
 * This module mirrors the official 2.1.210 binary's gates so the instruction
 * is shown exactly for the models/providers that need it:
 *   - `supportsMidConversationSystem(model)`  ≈ binary `b8t(e)` — does the
 *     model/provider support mid-conversation system turns?
 *   - `shouldUseMidConversationSystemInstruction(model)`  ≈ binary `zkd(e)` =
 *     `b8t(e) && !Vjn(e) && !xic(uo(e))` — should the system prompt use the
 *     mid-conversation-system instruction instead of the regular
 *     `<system-reminder>` explanation?
 *
 * Sonnet 5 and Opus 4.8 are excluded (binary `Vjn` / `xic`): they use the
 * regular `<system-reminder>` instruction. Self-contained (no import from
 * ./model.js) so it cannot enter a module-init cycle and stays fast to unit
 * test — mirroring the lean_prompt helper in ../effort/leanPrompt.js and the
 * harness-reminder gate in ./harnessReminderRole.js.
 */
import { getAPIProvider, type APIProvider } from './providers.js'
import { isEnvTruthy } from '../envUtils.js'
import { isFableModel } from '../fable/isFableModel.js'
import { isSonnet5Model } from './harnessReminderRole.js'

/**
 * The system-prompt instruction substituted for the regular `<system-reminder>`
 * explanation when the active model supports mid-conversation system turns.
 *
 * Binary-verbatim (210.strings, count 2; 0 in 206 — NEW in 207+): the
 * discriminator that fixes 2.1.207 #4. Exact match, never invented.
 */
export const MID_CONVERSATION_SYSTEM_INSTRUCTION =
  'The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results.'

/**
 * Models that predate mid-conversation-system support. Binary `b8t` returns
 * `false` for these via exact canonical-id comparison after `uo(e)` resolution
 * (e.g. `r==="claude-opus-4-5"`); `claude-3-` is matched as a substring
 * (`r.includes("claude-3-")`). The substring check here is unambiguous — no
 * canonical id of a newer model contains any of these as a substring — and
 * mirrors the substring approach already used by isFableModel / isSonnet5Model.
 */
const LEGACY_MODEL_IDS_NO_MID_CONV_SYSTEM: ReadonlyArray<string> = [
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

/**
 * Is `model` a Claude Opus 4.8 model? Substring-safe (case-insensitive) so a
 * versioned or provider-suffixed id (`claude-opus-4-8`, `us.anthropic.claude-opus-4-8`,
 * `claude-opus-4-8[1m]`) still matches. ≈ binary `xic` (`Ds(e)==="claude-opus-4-8"`).
 * No other canonical id contains `claude-opus-4-8` as a substring, so the match
 * is unambiguous.
 */
export function isOpus48Model(model: string | undefined | null): boolean {
  if (!model) return false
  return model.toLowerCase().includes('claude-opus-4-8')
}

/**
 * Providers whose default is to support mid-conversation system turns (binary
 * `EW`: `e==="firstParty" || e==="anthropicAws" || e==="foundry" || e==="mantle"`).
 * Bedrock, Vertex, and Gateway default to unsupported.
 */
function providerSupportsMidConversationSystem(
  provider: APIProvider,
): boolean {
  return (
    provider === 'firstParty' ||
    provider === 'anthropic_aws' ||
    provider === 'foundry' ||
    provider === 'mantle'
  )
}

/**
 * Does the active model/provider support mid-conversation system turns?
 * ≈ binary `b8t(e)` (memoized latch).
 *
 * Decision order (matches `b8t`):
 * 1. Force-override env `CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM` → `true`.
 * 2. Legacy models (claude-3-x, opus 4.0–4.7, sonnet 4.0/4.5/4.6, haiku 4.5) →
 *    `false` (they predate the feature).
 * 3. Fable 5 / Mythos 5 codename → `true` (binary: `r==="claude-mythos-5"`).
 * 4. Fallback: the effective provider supports mid-conversation system.
 *
 * The binary's `Tse("hipaa")` guard (HIPAA-compliance orgs → `false`) has no
 * OCC equivalent — OCC has no runtime HIPAA-policy flag (only comments), so the
 * guard is a no-op here. The binary's per-model `$se(e,"mid_conversation_system")`
 * override and `K8(r,"mid_conv_system")` capability flag likewise have no OCC
 * model-config/capability registry; absent those, the decision falls through to
 * the legacy/fable/provider branches above, exactly as in the binary.
 */
export function supportsMidConversationSystem(model: string): boolean {
  // 1. Force-override env (binary b8t: ut(CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM))
  if (isEnvTruthy(process.env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM)) {
    return true
  }

  const m = model.toLowerCase()

  // 2. Legacy models predate mid-conversation-system support. claude-3-x is a
  //    substring match (binary: r.includes("claude-3-")); the rest are exact.
  if (m.includes('claude-3-')) return false
  if (LEGACY_MODEL_IDS_NO_MID_CONV_SYSTEM.some(id => m.includes(id))) {
    return false
  }

  // 3. Fable 5 / Mythos 5 codename explicitly supports it
  //    (binary b8t: K8(r,"mid_conv_system") || r==="claude-mythos-5").
  if (isFableModel(model)) return true

  // 4. Fallback: provider must support mid-conversation system
  //    (binary b8t: EW(wb(e))).
  return providerSupportsMidConversationSystem(getAPIProvider())
}

/**
 * Should the system prompt use the mid-conversation-system instruction
 * (MID_CONVERSATION_SYSTEM_INSTRUCTION) instead of the regular
 * `<system-reminder>` explanation? ≈ binary `zkd(e)` =
 * `b8t(e) && !Vjn(e) && !xic(uo(e))`.
 *
 * `true` only when the model/provider supports mid-conversation system AND the
 * model is neither Sonnet 5 (binary `Vjn`) nor Opus 4.8 (binary `xic`) — those
 * two keep the regular `<system-reminder>` explanation.
 */
export function shouldUseMidConversationSystemInstruction(
  model: string,
): boolean {
  return (
    supportsMidConversationSystem(model) &&
    !isSonnet5Model(model) &&
    !isOpus48Model(model)
  )
}
