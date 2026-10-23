/**
 * CC 2.1.309 item 24 (OCC-131 WP-E, =forensics F-9) — /privacy-settings
 * stale-value + "can't be fetched" fixes.
 *
 * Official command `h(t,s)` @284071377 (BIN309, byte-verified):
 * 1. `Iee.cache.clear?.()` — the session-memoized grove settings are dropped
 *    when the command opens, so the dialog never renders a stale value
 *    (OCC: `getGroveSettings.cache?.clear?.()`).
 * 2. Either fetch failing now reports the NEW `d` message ("Unable to fetch
 *    your privacy settings at this time. Check …") instead of the old
 *    review/manage fallback (`p`), which is now only for the not-qualified
 *    case.
 * 3. The post-toggle refetch failure reports `d` with {display:"system"}.
 * 4. Success text is `"Help improve our AI models" set to <bool>.` (official
 *    string present in BOTH 308 and 309 — OCC had drifted to "Help improve
 *    Claude").
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as React from 'react'
import * as REAL_GROVE_NS from '../../../services/api/grove.js'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them
// in afterAll — Bun's mock.module crosses file boundaries in the same worker.
const REAL_GROVE_SNAPSHOT = { ...REAL_GROVE_NS }

const FALLBACK_MESSAGE =
  'Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls'
const CANNOT_FETCH_MESSAGE =
  'Unable to fetch your privacy settings at this time. Check https://claude.ai/settings/data-privacy-controls'

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
let settingsCacheClears = 0

await mock.module('../../../services/api/grove.js', () => ({
  ...REAL_GROVE_SNAPSHOT,
  isQualifiedForGrove: async () => mockQualified,
  getGroveSettings: Object.assign(async () => mockSettingsResult, {
    cache: { clear: () => { settingsCacheClears += 1 } },
  }),
  getGroveNoticeConfig: async () => mockConfigResult,
}))

const { call } = await import('../privacy-settings.js')

function collectDone(): { calls: unknown[]; onDone: any } {
  const calls: unknown[] = []
  const onDone = ((msg: unknown, options?: unknown) => {
    calls.push(options === undefined ? msg : [msg, options])
  }) as any
  return { calls, onDone }
}

beforeEach(() => {
  mockQualified = true
  settingsCacheClears = 0
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
  mock.module('../../../services/api/grove.js', () => ({
    ...REAL_GROVE_SNAPSHOT,
  }))
})

test('opening the command clears the memoized settings cache (official Iee.cache.clear — no stale dialog value)', async () => {
  // Arrange
  const { onDone } = collectDone()

  // Act
  await call(onDone)

  // Assert
  expect(settingsCacheClears).toBe(1)
})

test('settings fetch fails → new 309 "Unable to fetch" message (not the review/manage fallback), dialog hidden', async () => {
  // Arrange
  mockSettingsResult = { success: false }
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(node).toBeNull()
  expect(doneCalls).toEqual([CANNOT_FETCH_MESSAGE])
})

test('config fetch fails → new 309 "Unable to fetch" message, dialog hidden', async () => {
  // Arrange
  mockConfigResult = { success: false, errorStatus: 500 }
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(node).toBeNull()
  expect(doneCalls).toEqual([CANNOT_FETCH_MESSAGE])
})

test('not qualified → unchanged review/manage fallback (official p)', async () => {
  // Arrange
  mockQualified = false
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(node).toBeNull()
  expect(doneCalls).toEqual([FALLBACK_MESSAGE])
  expect(settingsCacheClears).toBe(0) // official clears only AFTER the qualified gate
})

test('both fetches succeed + grove_enabled decided → dialog renders', async () => {
  // Arrange
  const { calls: doneCalls, onDone } = collectDone()

  // Act
  const node = await call(onDone)

  // Assert
  expect(React.isValidElement(node)).toBe(true)
  expect(doneCalls.length).toBe(0)
})

test('source byte-check: post-toggle refetch failure uses CANNOT_FETCH with display:system; success text is the official "Help improve our AI models"', async () => {
  // The dialog's onDone callbacks are not reachable without a full render
  // harness (same staging rationale as feedbackGitHubIssueUrl287.test.ts),
  // so the two official strings are byte-checked at source level.
  const source = await readFile(
    join(import.meta.dir, '..', 'privacy-settings.tsx'),
    'utf8',
  )
  expect(source).toContain(CANNOT_FETCH_MESSAGE)
  expect(source).toContain(`"Help improve our AI models" set to \${groveStatus}.`)
  expect(source).not.toContain('Unable to retrieve updated privacy settings')
  expect(source).not.toContain('"Help improve Claude" set to')
})
