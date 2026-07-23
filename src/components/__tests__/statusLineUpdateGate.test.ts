import { test, expect, describe } from 'bun:test'
import {
  shouldStatusLineUpdateForMessageChange,
  initStatusLinePreviousMessageId,
} from '../statusLineUpdateGate.js'

// CC 2.1.216 #6 (c): statusline runs twice on resume. The change-detection
// effect must NOT fire on mount when lastAssistantMessageId is already
// non-null (resumed session). The fix initializes previousStateRef.messageId
// to the initial prop value (not null) so the effect's condition is false.

describe('shouldStatusLineUpdateForMessageChange', () => {
  test('returns false when message IDs match (no update needed)', () => {
    expect(shouldStatusLineUpdateForMessageChange('msg-1', 'msg-1')).toBe(false)
  })

  test('returns true when message ID changed', () => {
    expect(shouldStatusLineUpdateForMessageChange('msg-2', 'msg-1')).toBe(true)
  })

  test('returns false when both are null (no messages)', () => {
    expect(shouldStatusLineUpdateForMessageChange(null, null)).toBe(false)
  })

  // The bug: messageId initialized to null, prop non-null on resume → true
  // → spurious second update on mount.
  test('BUG CASE: non-null prop vs null init → true (causes double-run)', () => {
    expect(shouldStatusLineUpdateForMessageChange('msg-1', null)).toBe(true)
  })

  // The fix: messageId initialized to the initial prop → false → no
  // double-run on mount.
  test('FIX CASE: non-null prop vs same non-null init → false (no double-run)', () => {
    expect(shouldStatusLineUpdateForMessageChange('msg-1', 'msg-1')).toBe(false)
  })

  test('returns true when message goes from non-null to null', () => {
    expect(shouldStatusLineUpdateForMessageChange(null, 'msg-1')).toBe(true)
  })
})

describe('initStatusLinePreviousMessageId', () => {
  test('returns the initial prop value (not null)', () => {
    expect(initStatusLinePreviousMessageId('msg-1')).toBe('msg-1')
  })

  test('returns null when initial prop is null (fresh session)', () => {
    expect(initStatusLinePreviousMessageId(null)).toBe(null)
  })

  test('initializing to prop value prevents double-run on resume', () => {
    // On resume: prop = 'msg-1', ref init = initStatusLinePreviousMessageId('msg-1') = 'msg-1'
    // → shouldStatusLineUpdateForMessageChange('msg-1', 'msg-1') = false → no double-run
    const init = initStatusLinePreviousMessageId('msg-1')
    expect(shouldStatusLineUpdateForMessageChange('msg-1', init)).toBe(false)
  })
})
