import { afterEach, describe, expect, mock, test } from 'bun:test'

// 2.1.235 item 14: the context-limit error gains the "auto-compact is off"
// hint, keyed off official `kRa()`: true only when the user *explicitly*
// disabled auto-compact — not when an env var disables it, and not when it
// is merely on by default. Byte-verified port in autoCompact.ts
// (isAutoCompactExplicitlyOff).

let mockAutoCompactEnabled: boolean | undefined = true

mock.module('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({ autoCompactEnabled: mockAutoCompactEnabled }),
}))

const { isAutoCompactExplicitlyOff } = await import('../autoCompact.js')

const ENV_KEYS = ['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT'] as const

function withEnv(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

afterEach(() => {
  mockAutoCompactEnabled = true
})

describe('2.1.235 item 14 isAutoCompactExplicitlyOff (official kRa)', () => {
  test('returns false when auto-compact is enabled (default)', () => {
    withEnv({}, () => {
      mockAutoCompactEnabled = true
      expect(isAutoCompactExplicitlyOff()).toBe(false)
    })
  })

  test('returns true when the user explicitly disabled auto-compact', () => {
    withEnv({}, () => {
      mockAutoCompactEnabled = false
      expect(isAutoCompactExplicitlyOff()).toBe(true)
    })
  })

  test('returns false when DISABLE_COMPACT env disables it (official PBp)', () => {
    // Env-disabled sessions get no hint: the primary continue-hint already
    // reflects the env state (official PBp() short-circuit).
    withEnv({ DISABLE_COMPACT: '1' }, () => {
      mockAutoCompactEnabled = false
      expect(isAutoCompactExplicitlyOff()).toBe(false)
    })
  })

  test('returns false when DISABLE_AUTO_COMPACT env disables it (official PBp)', () => {
    withEnv({ DISABLE_AUTO_COMPACT: 'true' }, () => {
      mockAutoCompactEnabled = false
      expect(isAutoCompactExplicitlyOff()).toBe(false)
    })
  })

  test('treats falsy env values as not set (isEnvTruthy parsing)', () => {
    withEnv({ DISABLE_COMPACT: '0', DISABLE_AUTO_COMPACT: 'false' }, () => {
      mockAutoCompactEnabled = false
      expect(isAutoCompactExplicitlyOff()).toBe(true)
    })
  })
})
