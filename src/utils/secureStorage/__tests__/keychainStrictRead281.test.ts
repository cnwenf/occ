/**
 * claude-code 2.1.281 #049 (🔒) — secure-storage strict-read classification.
 *
 * Two layers cooperate to make a locked keychain a TRANSIENT (skip-write)
 * signal rather than an "empty" one:
 *
 *  1. `macOsKeychainStorage.readStrict({inaccessibleAs:'failureIfTransient'})`
 *     returns the {@link TRANSIENT_READ_FAILURE} sentinel when the login
 *     keychain is locked (`security show-keychain-info` exit 36), instead of
 *     falling through to `read()` (which reports null/empty). Off darwin there
 *     is no locked-keychain state, so it never classifies as transient.
 *
 *  2. `createFallbackStorage(...).readStrict(...)` PROPAGATES that sentinel
 *     WITHOUT consulting the plaintext secondary. This is the crux: a locked
 *     primary still holds a real entry, so falling back to plaintext (and later
 *     writing there) would fork the credential — exactly what #049 prevents.
 *
 * The fallback tests are pure (fake primary/secondary, no platform mocking).
 * The macOS locked/unlocked tests drive the real `isMacOsKeychainLocked()` with
 * a controllable `security` exit code (execa mocked before the target import) +
 * a scoped process.platform override that is always restored.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

import { createFallbackStorage } from '../fallbackStorage.js'
import {
  isTransientReadFailure,
  TRANSIENT_READ_FAILURE,
} from '../transientRead.js'

// Controllable exit code for the mocked `security show-keychain-info` spawn.
let mockSecurityExitCode = 0

// Capture the real execa BEFORE mocking, then mock execaSync, THEN import the
// keychain module dynamically so it binds the mock (ESM import order: the
// dynamic import below runs after mock.module is registered).
const realExeca = await import('execa')
mock.module('execa', () => ({
  ...realExeca,
  execaSync: (..._args: unknown[]) => ({
    exitCode: mockSecurityExitCode,
    stdout: '',
    stderr: '',
  }),
}))

const {
  macOsKeychainStorage,
  isMacOsKeychainLocked,
  _resetKeychainLockedCacheForTesting,
} = await import('../macOsKeychainStorage.js')

afterAll(() => {
  mock.module('execa', () => realExeca)
})

const originalPlatform = process.platform

/** Run `fn` with process.platform temporarily set to `value` (always restored). */
function withPlatform<T>(value: string, fn: () => T): T {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
      writable: true,
    })
    _resetKeychainLockedCacheForTesting()
  }
}

afterEach(() => {
  mockSecurityExitCode = 0
  _resetKeychainLockedCacheForTesting()
})

// ---------------------------------------------------------------------------
// (2) fallback storage propagation — pure, no platform mocking
// ---------------------------------------------------------------------------

describe('#049 createFallbackStorage.readStrict — sentinel propagation', () => {
  test('propagates the transient sentinel WITHOUT reading the plaintext secondary', () => {
    let secondaryReads = 0
    const primary = {
      name: 'primary',
      readStrict: (_options?: unknown) => TRANSIENT_READ_FAILURE,
      read: () => {
        throw new Error('primary.read() must not run when readStrict is present')
      },
      update: () => ({ success: true }),
      delete: () => true,
    }
    const secondary = {
      name: 'secondary',
      read: () => {
        secondaryReads += 1
        return { leaked: 'plaintext-credential' }
      },
      update: () => ({ success: true }),
      delete: () => true,
    }

    const fb = createFallbackStorage(primary, secondary)
    const result = fb.readStrict({ inaccessibleAs: 'failureIfTransient' })

    expect(result).toBe(TRANSIENT_READ_FAILURE)
    expect(isTransientReadFailure(result)).toBe(true)
    // The crux of #049: the secondary is NEVER consulted, so no plaintext fork.
    expect(secondaryReads).toBe(0)
  })

  test('returns a non-null primary blob without consulting the secondary', () => {
    let secondaryReads = 0
    const blob = { claudeAiOauth: { accessToken: 'from-primary' } }
    const primary = {
      name: 'primary',
      readStrict: (_options?: unknown) => blob,
      read: () => blob,
      update: () => ({ success: true }),
      delete: () => true,
    }
    const secondary = {
      name: 'secondary',
      read: () => {
        secondaryReads += 1
        return {}
      },
      update: () => ({ success: true }),
      delete: () => true,
    }

    const fb = createFallbackStorage(primary, secondary)
    const result = fb.readStrict({ inaccessibleAs: 'failureIfTransient' })

    expect(result).toBe(blob)
    expect(secondaryReads).toBe(0)
  })

  test('falls back to the secondary when the primary is genuinely empty (null)', () => {
    const secondaryBlob = { claudeAiOauth: { accessToken: 'from-secondary' } }
    const primary = {
      name: 'primary',
      readStrict: (_options?: unknown) => null,
      read: () => null,
      update: () => ({ success: true }),
      delete: () => true,
    }
    const secondary = {
      name: 'secondary',
      read: () => secondaryBlob,
      update: () => ({ success: true }),
      delete: () => true,
    }

    const fb = createFallbackStorage(primary, secondary)
    const result = fb.readStrict({ inaccessibleAs: 'failureIfTransient' })

    expect(result).toBe(secondaryBlob)
  })

  test('degrades to read() for a primary without strict support', () => {
    const blob = { claudeAiOauth: { accessToken: 'plain-backend' } }
    const primary = {
      name: 'primary',
      // NO readStrict — e.g. a backend that predates #049.
      read: () => blob,
      update: () => ({ success: true }),
      delete: () => true,
    }
    const secondary = {
      name: 'secondary',
      read: () => null,
      update: () => ({ success: true }),
      delete: () => true,
    }

    const fb = createFallbackStorage(primary, secondary)
    const result = fb.readStrict({ inaccessibleAs: 'failureIfTransient' })

    expect(result).toBe(blob)
  })
})

// ---------------------------------------------------------------------------
// (1) macOS keychain classification
// ---------------------------------------------------------------------------

describe('#049 macOsKeychainStorage.readStrict — locked-keychain classification', () => {
  test('off darwin, a strict read is never transient (no locked-keychain state)', () => {
    // This container is linux; isMacOsKeychainLocked() short-circuits false
    // BEFORE any `security` spawn, so readStrict delegates to read().
    const locked = withPlatform('linux', () => {
      _resetKeychainLockedCacheForTesting()
      return isMacOsKeychainLocked()
    })
    expect(locked).toBe(false)

    const result = withPlatform('linux', () => {
      _resetKeychainLockedCacheForTesting()
      return macOsKeychainStorage.readStrict({
        inaccessibleAs: 'failureIfTransient',
      })
    })
    expect(isTransientReadFailure(result)).toBe(false)
  })

  test('on darwin with a locked keychain (exit 36), readStrict returns the sentinel', () => {
    mockSecurityExitCode = 36
    const result = withPlatform('darwin', () => {
      _resetKeychainLockedCacheForTesting()
      return macOsKeychainStorage.readStrict({
        inaccessibleAs: 'failureIfTransient',
      })
    })
    expect(result).toBe(TRANSIENT_READ_FAILURE)
    expect(isTransientReadFailure(result)).toBe(true)
  })

  test('on darwin with an unlocked keychain (exit 0), readStrict is not transient', () => {
    mockSecurityExitCode = 0
    const result = withPlatform('darwin', () => {
      _resetKeychainLockedCacheForTesting()
      return macOsKeychainStorage.readStrict({
        inaccessibleAs: 'failureIfTransient',
      })
    })
    expect(isTransientReadFailure(result)).toBe(false)
  })

  test('without the failureIfTransient opt-in, even a locked keychain is not transient', () => {
    mockSecurityExitCode = 36 // locked...
    const result = withPlatform('darwin', () => {
      _resetKeychainLockedCacheForTesting()
      return macOsKeychainStorage.readStrict() // ...but no opt-in option
    })
    // The sentinel is strictly opt-in; readStrict() degrades to read().
    expect(isTransientReadFailure(result)).toBe(false)
  })

  test('isMacOsKeychainLocked maps security exit 36 => locked, 0 => unlocked (darwin)', () => {
    mockSecurityExitCode = 36
    expect(
      withPlatform('darwin', () => {
        _resetKeychainLockedCacheForTesting()
        return isMacOsKeychainLocked()
      }),
    ).toBe(true)

    mockSecurityExitCode = 0
    expect(
      withPlatform('darwin', () => {
        _resetKeychainLockedCacheForTesting()
        return isMacOsKeychainLocked()
      }),
    ).toBe(false)
  })
})
