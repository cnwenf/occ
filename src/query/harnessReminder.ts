import { createUserMessage, type UserMessage } from '../utils/messages.js'
import { shouldUseSystemRoleForHarnessReminders } from '../utils/model/harnessReminderRole.js'

/**
 * A harness reminder to inject into the API request mid-conversation — e.g. the
 * per-turn "Ultracode is on…" reminder (see getUltracodeSystemReminder in
 * src/context.ts). `isMeta: true` marks it as harness-injected (not human input).
 */
export interface HarnessReminder {
  content: string
  isMeta: true
}

/**
 * Build the per-turn harness-reminder message for the API request.
 *
 * 2.1.201: "Claude Sonnet 5 sessions no longer use the mid-conversation system
 * role for harness reminders." The reminder is injected as a user-role isMeta
 * message — the non-system path — mirroring how other reminders (the context
 * `<system-reminder>` block in prependUserContext, the deferred-tool list, the
 * stop-hook additional context) are attached: NOT as a standalone system-role
 * message.
 *
 * `shouldUseSystemRoleForHarnessReminders(model)` is the model-aware gate. It
 * returns `false` for Sonnet 5 (mandatory, per 2.1.201) and `false` for every
 * other model (OCC mirrors the binary's `ultra_effort_enter` isMeta user-message
 * builder universally). When the gate is `false` the user-meta path below is
 * taken. The system-role path is not implemented in OCC; if a future change made
 * the gate return `true` this function throws (fail-closed) so a standalone
 * system message is never silently injected.
 *
 * @returns a user-role isMeta message — never a standalone system-role message.
 */
export function buildHarnessReminderMessage(
  reminder: HarnessReminder,
  model: string,
): UserMessage {
  if (shouldUseSystemRoleForHarnessReminders(model)) {
    // Not reached in OCC: the non-system (user-meta) path is universal. Kept as
    // a fail-closed guard so the system-role path is never silently taken.
    throw new Error(
      'buildHarnessReminderMessage: the standalone system-role harness-reminder ' +
        'path is not implemented in OCC (2.1.201 mandates the non-system path ' +
        'for Sonnet 5; OCC uses the user-role isMeta path universally). ' +
        `model=${model}`,
    )
  }
  // Non-system path: a user-role isMeta message (NOT a standalone system
  // message), mirroring the binary's ultra_effort_enter reminder builder.
  return createUserMessage({
    content: reminder.content,
    isMeta: true,
  })
}
