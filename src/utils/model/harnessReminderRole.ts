/**
 * 2.1.201: "Claude Sonnet 5 sessions no longer use the mid-conversation system
 * role for harness reminders."
 *
 * Harness reminders (e.g. the per-turn "Ultracode is on…" reminder) are injected
 * as user-role isMeta messages — or `<system-reminder>` blocks attached to the
 * last user message — mirroring how other reminders (the context
 * `<system-reminder>` block, deferred-tool lists, stop-hook additional context)
 * are attached. They must NOT be standalone system-role messages.
 *
 * This module holds the model-aware gate for that decision. It is self-contained
 * (no import from ./model.js) so it cannot enter a module-init cycle and stays
 * fast to unit-test — mirroring the lean_prompt helper in ../effort/leanPrompt.js.
 */

/**
 * Is `model` a Claude Sonnet 5 model?
 *
 * Match is case-insensitive and substring-safe: a versioned or provider-suffixed
 * id (`claude-sonnet-5-20251001`, `us.anthropic.claude-sonnet-5-v1:0`) still
 * matches. No other canonical model id contains `claude-sonnet-5` as a substring
 * (sonnet-4-x does not), so the substring match is unambiguous — the same
 * reasoning used by firstPartyNameToCanonical in ./model.js.
 */
export function isSonnet5Model(model: string): boolean {
  if (!model) return false
  const m = model.toLowerCase()
  return m === 'claude-sonnet-5' || m.includes('claude-sonnet-5')
}

/**
 * Should harness reminders be injected as a standalone system-role message for
 * this model?
 *
 * - Sonnet 5: `false` — the mid-conversation system role is forbidden for
 *   harness reminders (2.1.201, mandatory).
 * - All other models: `false` — OCC mirrors the binary's
 *   `ultra_effort_enter` isMeta user-message builder for every model, so the
 *   standalone system-role path is never taken. (The official binary retained
 *   the system-role path for non-Sonnet-5 models until 2.1.201; OCC adopted the
 *   non-system path universally.)
 *
 * The Sonnet-5 case is checked explicitly so the gate is verifiable against the
 * 2.1.201 changelog. buildHarnessReminderMessage() consults this gate.
 */
export function shouldUseSystemRoleForHarnessReminders(
  model: string,
): boolean {
  // 2.1.201: Sonnet 5 sessions must not use the mid-conversation system role
  // for harness reminders.
  if (isSonnet5Model(model)) {
    return false
  }
  // OCC uses the non-system (user-role isMeta) path for every model.
  return false
}
