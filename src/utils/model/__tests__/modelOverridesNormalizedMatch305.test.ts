/**
 * CC 2.1.305 (research-api.md item 4 / official `Ja` @240936093):
 * the settings `modelOverrides` VALUE-side match in `resolveOverriddenModel`
 * changed from v304's strict `h===n` (`fi`) to the always-normalized `CA(s,n)`
 * comparison — case-insensitive + trailing `[1m]`-suffix-insensitive
 * (`Mt(e){return e.replace(/\[1m\]$/i,"")}`, `CA(e,n){return Mt(e).toLowerCase()===Mt(n).toLowerCase()}`).
 *
 * This is the fix for /effort and /autocompact silently not applying when the
 * settings modelOverrides value differs from the requested model name only by
 * case or a `[1m]` tag (getCanonicalName → resolveOverriddenModel is the
 * settings-key resolution entry for both commands).
 *
 * Mock discipline follows threePFallback284.test.ts: real settings exports are
 * captured in beforeAll and re-registered in afterAll (Bun mock.restore() does
 * not undo mock.module registrations).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'

const SETTINGS_PATH = '../../settings/settings.js'

let actualSettingsExports: Record<string, unknown> = {}

/** Per-test override map returned by the mocked getInitialSettings. */
let currentOverrides: Record<string, string> | undefined

beforeAll(async () => {
  actualSettingsExports = { ...((await import(SETTINGS_PATH)) as object) }
  mock.module(SETTINGS_PATH, () => ({
    ...actualSettingsExports,
    getInitialSettings: () =>
      currentOverrides === undefined ? {} : { modelOverrides: currentOverrides },
  }))
})

afterAll(() => {
  mock.module(SETTINGS_PATH, () => ({ ...actualSettingsExports }))
  mock.restore()
})

const { resolveOverriddenModel } = await import('../modelStrings.js')

describe('CC 2.1.305 #4 — resolveOverriddenModel normalized match (official Ja/CA)', () => {
  test('exact override value still resolves to its canonical key', () => {
    // Arrange
    currentOverrides = { 'claude-opus-5-5': 'us.anthropic.claude-opus-5-5' }

    // Act & Assert
    expect(resolveOverriddenModel('us.anthropic.claude-opus-5-5')).toBe(
      'claude-opus-5-5',
    )
  })

  test('case-differing override value applies (v304 strict === missed this)', () => {
    // Arrange: the changelog case — settings value spelled differently in
    // case than the requested model string.
    currentOverrides = { 'claude-opus-5-5': 'Claude-Opus-5-5' }

    // Act & Assert: request name differs from the override value by case only.
    expect(resolveOverriddenModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(resolveOverriddenModel('CLAUDE-OPUS-5-5')).toBe('claude-opus-5-5')
  })

  test('`[1m]`-tagged override value matches untagged request (and reverse)', () => {
    // Arrange
    currentOverrides = { 'claude-sonnet-5-5': 'claude-sonnet-5-5[1m]' }

    // Act & Assert: Mt strips ONE trailing [1m] (case-insensitive) on BOTH
    // sides before the lowercase compare.
    expect(resolveOverriddenModel('claude-sonnet-5-5')).toBe(
      'claude-sonnet-5-5',
    )

    // Reverse direction: untagged override value, `[1M]`-tagged request.
    currentOverrides = { 'claude-sonnet-5-5': 'claude-sonnet-5-5' }
    expect(resolveOverriddenModel('claude-sonnet-5-5[1M]')).toBe(
      'claude-sonnet-5-5',
    )
  })

  test('non-matching model is returned unchanged', () => {
    // Arrange
    currentOverrides = { 'claude-opus-5-5': 'us.anthropic.claude-opus-5-5' }

    // Act & Assert
    expect(resolveOverriddenModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(resolveOverriddenModel('my-unrelated-arn')).toBe('my-unrelated-arn')
  })

  test('no overrides configured → identity', () => {
    currentOverrides = undefined
    expect(resolveOverriddenModel('claude-opus-5-5')).toBe('claude-opus-5-5')
  })
})

describe('CC 2.1.305 #4 — getCanonicalName settings-key path (/effort, /autocompact)', () => {
  test('case-differing override resolves to the same canonical name as the exact id', async () => {
    // Arrange
    currentOverrides = { 'claude-opus-5-5': 'Claude-Opus-5-5' }
    const { getCanonicalName } = await import('../model.js')

    // Act
    const viaOverride = getCanonicalName('Claude-Opus-5-5')
    const viaExact = getCanonicalName('us.anthropic.claude-opus-5-5')

    // Assert: both routes land on the same canonical key — before the fix the
    // case-differing value fell through and produced a divergent key.
    expect(viaOverride).toBe(viaExact)
  })
})
