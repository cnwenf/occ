import { beforeEach, describe, expect, test } from 'bun:test'

import {
  consumePlanModeBypassNotice,
  PLAN_MODE_BYPASS_NOTICE_DELAY_MS,
  PLAN_MODE_BYPASS_NOTICE_EVENT,
  PLAN_MODE_BYPASS_NOTICE_KEY,
  PLAN_MODE_BYPASS_NOTICE_TEXT,
  resetPlanModeBypassNoticeForTesting,
  shouldShowPlanModeBypassNotice,
} from '../planModeBypassNotice.js'

/**
 * PORT TEST (CC 2.1.299, gap entry #011): one-time plan-mode bypass notice.
 *
 * Official v299 byte-exact references (linux-x64 ELF @101543100-101543286,
 * strings/dd only): notice id `plan-mode-bypass-notice`; text `jRo` =
 * "Session was started with bypass permissions, so plan mode won't ask
 * before most edits or commands. Start a new session without bypass
 * permissions for prompts in plan mode."; delay `URo` = 800; telemetry
 * `mode_plan_bypass_notice`; session-local fire-once flag `h` (never
 * persisted); gate `PU(permissionMode, isBypassPermissionsModeAvailable)`.
 *
 * WP acceptance: emits once; second entry into plan mode does not re-emit;
 * default mode does not emit.
 */

beforeEach(() => {
  resetPlanModeBypassNoticeForTesting()
})

describe('official constants — byte-exact', () => {
  test('notice key is "plan-mode-bypass-notice"', () => {
    expect(PLAN_MODE_BYPASS_NOTICE_KEY).toBe('plan-mode-bypass-notice')
  })

  test('notice text is byte-exact (jRo @101543100 region)', () => {
    expect(PLAN_MODE_BYPASS_NOTICE_TEXT).toBe(
      "Session was started with bypass permissions, so plan mode won't ask before most edits or commands. Start a new session without bypass permissions for prompts in plan mode.",
    )
  })

  test('delay is 800ms (URo)', () => {
    expect(PLAN_MODE_BYPASS_NOTICE_DELAY_MS).toBe(800)
  })

  test('telemetry event name is mode_plan_bypass_notice', () => {
    expect(PLAN_MODE_BYPASS_NOTICE_EVENT).toBe('mode_plan_bypass_notice')
  })
})

describe('shouldShowPlanModeBypassNotice — official PU gate', () => {
  test('plan mode + bypass available → true', () => {
    expect(shouldShowPlanModeBypassNotice('plan', true)).toBe(true)
  })

  test('plan mode without bypass available → false', () => {
    expect(shouldShowPlanModeBypassNotice('plan', false)).toBe(false)
    expect(shouldShowPlanModeBypassNotice('plan', undefined)).toBe(false)
  })

  test('non-plan modes never fire, even with bypass available', () => {
    expect(shouldShowPlanModeBypassNotice('default', true)).toBe(false)
    expect(shouldShowPlanModeBypassNotice('acceptEdits', true)).toBe(false)
    expect(shouldShowPlanModeBypassNotice('bypassPermissions', true)).toBe(false)
    expect(shouldShowPlanModeBypassNotice(undefined, true)).toBe(false)
  })
})

describe('consumePlanModeBypassNotice — one-time-per-session semantics', () => {
  test('first entry into plan mode with bypass available emits the notice once', () => {
    const notice = consumePlanModeBypassNotice('plan', true)
    expect(notice).not.toBeNull()
    expect(notice?.key).toBe('plan-mode-bypass-notice')
    expect(notice?.text).toBe(PLAN_MODE_BYPASS_NOTICE_TEXT)
  })

  test('second entry into plan mode in the same session does NOT re-emit', () => {
    expect(consumePlanModeBypassNotice('plan', true)).not.toBeNull()
    // Leave plan mode and come back — still once per session.
    expect(consumePlanModeBypassNotice('default', true)).toBeNull()
    expect(consumePlanModeBypassNotice('plan', true)).toBeNull()
    expect(consumePlanModeBypassNotice('plan', true)).toBeNull()
  })

  test('default mode does not emit and does not consume the one-shot latch', () => {
    expect(consumePlanModeBypassNotice('default', true)).toBeNull()
    expect(consumePlanModeBypassNotice('default', false)).toBeNull()
    // The gate never fired, so a later real plan-mode entry still emits.
    expect(consumePlanModeBypassNotice('plan', true)).not.toBeNull()
  })

  test('plan mode without bypass available does not emit or consume the latch', () => {
    expect(consumePlanModeBypassNotice('plan', false)).toBeNull()
    expect(consumePlanModeBypassNotice('plan', true)).not.toBeNull()
  })

  test('reset (new session) re-arms the notice', () => {
    expect(consumePlanModeBypassNotice('plan', true)).not.toBeNull()
    expect(consumePlanModeBypassNotice('plan', true)).toBeNull()
    resetPlanModeBypassNoticeForTesting()
    expect(consumePlanModeBypassNotice('plan', true)).not.toBeNull()
  })
})
