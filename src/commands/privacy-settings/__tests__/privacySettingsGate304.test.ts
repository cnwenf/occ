/**
 * CC 2.1.304 #28 — `/privacy-settings` both-fetch gate
 * (docs/gap-research-304/research-R5-cli-ux.md #28).
 *
 * Official fix: BOTH `getGroveSettings()` and `getGroveNoticeConfig()` must
 * succeed before the dialog renders. Pre-304, a failed CONFIG fetch fell
 * through and rendered PrivacySettingsDialog with `domainExcluded` unknown
 * (undefined) — the gate only checked the settings result. Now either failure
 * → FALLBACK_MESSAGE + null (hide dialog).
 *
 * No pre-existing privacy-settings tests existed — this is the new suite.
 * grove.js is mocked at the module seam and restored in afterAll (OCC-97:
 * Bun's mock.module crosses file boundaries in the same worker).
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import * as React from 'react'
import * as REAL_GROVE_NS from '../../../services/api/grove.js'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them in
// afterAll — Bun's mock.module crosses file boundaries in the same worker.
const REAL_GROVE_SNAPSHOT = { ...REAL_GROVE_NS }

const FALLBACK_MESSAGE =
  'Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls'

let mockQualified = true
let mockSettingsResult: unknown = {
  success: true,
  data: { grove_enabled: true, grove_notice_viewed_at: null },
}
let mockConfigResult: unknown = {
  success: true,
  data: {
    grove_enabled: true,
    domain_excluded: false,
    notice_is_grace_period: false,
    notice_reminder_frequency: null,
  },
}

await mock.module('../../../services/api/grove.js', () => ({
  ...REAL_GROVE_SNAPSHOT,
  isQualifiedForGrove: async () => mockQualified,
  getGroveSettings: async () => mockSettingsResult,
  getGroveNoticeConfig: async () => mockConfigResult,
}))

const { call } = await import('../privacy-settings.js')

function collectDone(): { calls: unknown[]; onDone: any } {
  const calls: unknown[] = []
  const onDone = ((msg: unknown) => {
    calls.push(msg)
  }) as any
  return { calls, onDone }
}

beforeEach(() => {
  mockQualified = true
  mockSettingsResult = {
    success: true,
    data: { grove_enabled: true, grove_notice_viewed_at: null },
  }
  mockConfigResult = {
    success: true,
    data: {
      grove_enabled: true,
      domain_excluded: false,
      notice_is_grace_period: false,
      notice_reminder_frequency: null,
    },
  }
})

afterAll(() => {
  // Restore the real grove module for later test files in this worker.
  mock.module('../../../services/api/grove.js', () => ({
    ...REAL_GROVE_SNAPSHOT,
  }))
})

test('config fetch fails while settings succeeds → FALLBACK_MESSAGE, dialog hidden (the #28 fix — pre-304 rendered with domainExcluded unknown)', async () => {
  // Arrange
  mockConfigResult = { success: false, errorStatus: 500 }
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(node).toBeNull()
  expect(doneCalls).toEqual([FALLBACK_MESSAGE])
})

test('settings fetch fails while config succeeds → FALLBACK_MESSAGE, dialog hidden', async () => {
  // Arrange
  mockSettingsResult = { success: false }
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(node).toBeNull()
  expect(doneCalls).toEqual([FALLBACK_MESSAGE])
})

test('both fetches succeed + grove_enabled decided → PrivacySettingsDialog renders (no fallback)', async () => {
  // Arrange
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(React.isValidElement(node)).toBe(true)
  expect(doneCalls.length).toBe(0)
})

test('not qualified for grove → FALLBACK_MESSAGE (pre-existing behavior unchanged)', async () => {
  // Arrange
  mockQualified = false
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(node).toBeNull()
  expect(doneCalls).toEqual([FALLBACK_MESSAGE])
})
