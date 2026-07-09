// Unit tests for the 2.1.201 harness-reminder gating: "Claude Sonnet 5 sessions
// no longer use the mid-conversation system role for harness reminders."
//
// The real-model e2e (occ -p) runs against the GLM proxy (not Sonnet 5), so it
// cannot exercise the Sonnet-5 gate directly — these unit tests are the done-gate
// for the gating LOGIC, plus the wiring in src/query.ts (buildHarnessReminderMessage
// replaces the inline createUserMessage at the ultracode-reminder injection site).

import { test, expect } from 'bun:test'
import {
  isSonnet5Model,
  shouldUseSystemRoleForHarnessReminders,
} from '../../utils/model/harnessReminderRole.js'
import {
  buildHarnessReminderMessage,
  type HarnessReminder,
} from '../harnessReminder.js'

const SONNET5_REMINDER: HarnessReminder = {
  content: "Ultracode is on: optimize for the most exhaustive, correct answer.",
  isMeta: true,
}

// -- isSonnet5Model ----------------------------------------------------------

test('isSonnet5Model: true for the canonical id and versioned/provider-suffixed variants', () => {
  expect(isSonnet5Model('claude-sonnet-5')).toBe(true)
  // Versioned display name still matches (substring-safe).
  expect(isSonnet5Model('claude-sonnet-5-20251001')).toBe(true)
  // Bedrock/vertex provider-suffixed ids still match.
  expect(isSonnet5Model('us.anthropic.claude-sonnet-5')).toBe(true)
  expect(isSonnet5Model('us.anthropic.claude-sonnet-5-v1:0')).toBe(true)
  // Case-insensitive.
  expect(isSonnet5Model('Claude-Sonnet-5')).toBe(true)
})

test('isSonnet5Model: false for non-Sonnet-5 and older models', () => {
  // claude-sonnet-4-6 must NOT match (sonnet-5 is not a substring of sonnet-4-6).
  expect(isSonnet5Model('claude-sonnet-4-6')).toBe(false)
  expect(isSonnet5Model('claude-sonnet-4-5')).toBe(false)
  expect(isSonnet5Model('claude-sonnet-4')).toBe(false)
  expect(isSonnet5Model('claude-opus-4-8')).toBe(false)
  expect(isSonnet5Model('claude-haiku-4-5')).toBe(false)
  expect(isSonnet5Model('claude-3-5-sonnet')).toBe(false)
  expect(isSonnet5Model('glm-5.2')).toBe(false)
  expect(isSonnet5Model('')).toBe(false)
})

// -- shouldUseSystemRoleForHarnessReminders ---------------------------------

test('shouldUseSystemRoleForHarnessReminders: false for Sonnet 5 (2.1.201 mandate)', () => {
  expect(shouldUseSystemRoleForHarnessReminders('claude-sonnet-5')).toBe(false)
  expect(shouldUseSystemRoleForHarnessReminders('claude-sonnet-5-20251001')).toBe(false)
  expect(shouldUseSystemRoleForHarnessReminders('us.anthropic.claude-sonnet-5')).toBe(false)
})

test('shouldUseSystemRoleForHarnessReminders: false universally in OCC (non-system path is the default)', () => {
  // OCC mirrors the binary's ultra_effort_enter isMeta user-message builder for
  // every model, so the standalone system-role path is never taken.
  expect(shouldUseSystemRoleForHarnessReminders('claude-opus-4-8')).toBe(false)
  expect(shouldUseSystemRoleForHarnessReminders('claude-sonnet-4-6')).toBe(false)
  expect(shouldUseSystemRoleForHarnessReminders('glm-5.2')).toBe(false)
})

// -- buildHarnessReminderMessage (the injection) ----------------------------

test('buildHarnessReminderMessage: for a Sonnet-5 model the reminder is NOT a standalone system message', () => {
  // Arrange — a Sonnet 5 model.
  const model = 'claude-sonnet-5'

  // Act — build the harness-reminder message that gets prepended to the API
  // request mid-conversation.
  const msg = buildHarnessReminderMessage(SONNET5_REMINDER, model)

  // Assert — it is a user-role isMeta message (the non-system path), NOT a
  // standalone system-role message.
  expect(msg.type).toBe('user')
  expect(msg.type).not.toBe('system')
  expect(msg.message.role).toBe('user')
  expect(msg.message.role).not.toBe('system')
  expect(msg.isMeta).toBe(true)
  expect(msg.message.content).toBe(SONNET5_REMINDER.content)
})

test('buildHarnessReminderMessage: does not throw for Sonnet 5', () => {
  // The fail-closed system-role guard must not fire for Sonnet 5 (the gate is
  // false → non-system path taken).
  expect(() =>
    buildHarnessReminderMessage(SONNET5_REMINDER, 'claude-sonnet-5'),
  ).not.toThrow()
})

test('buildHarnessReminderMessage: for a Sonnet-5 variant id the reminder is a user-role isMeta message', () => {
  // A versioned/Bedrock id still routes through the non-system path.
  const msg = buildHarnessReminderMessage(
    SONNET5_REMINDER,
    'us.anthropic.claude-sonnet-5-v1:0',
  )
  expect(msg.type).toBe('user')
  expect(msg.message.role).toBe('user')
  expect(msg.isMeta).toBe(true)
})

test('buildHarnessReminderMessage: non-Sonnet models also get the non-system path (OCC universal)', () => {
  // OCC uses the user-role isMeta path for every model — the standalone system
  // message is never produced.
  for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6', 'glm-5.2']) {
    const msg = buildHarnessReminderMessage(SONNET5_REMINDER, model)
    expect(msg.type).toBe('user')
    expect(msg.message.role).toBe('user')
    expect(msg.isMeta).toBe(true)
    expect(msg.type).not.toBe('system')
  }
})

test('buildHarnessReminderMessage: the returned message carries the reminder content verbatim', () => {
  const msg = buildHarnessReminderMessage(SONNET5_REMINDER, 'claude-sonnet-5')
  expect(msg.message.content).toBe(SONNET5_REMINDER.content)
})
