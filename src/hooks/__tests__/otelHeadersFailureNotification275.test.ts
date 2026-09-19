import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.275 (Item E1): startup notification when the configured
 * otelHeadersHelper fails. Port of the official notification service `HGt`
 * (v2.1.276 binary @217401542):
 *   - key `otel-headers-helper-failed` (@92371252 / @217401542)
 *   - text prefix @92748384 / @217401830:
 *     `otelHeadersHelper failed; telemetry is not being exported. See /status: `
 *   - `timeoutMs:30000` (@217401880), 120-char message cap `wn(te,120)`
 *     (@217401930)
 *   - fire-once latch + check-existing-then-subscribe (@217401620)
 * Official `kind:"warning"` maps onto OCC's `color:"warning"` (OCC's
 * TextNotification has no `kind` field).
 * mock.module pattern per OCC-97: spread the real module, restore in afterAll.
 */

let currentFailure: string | null = null
const listeners = new Set<(message: string) => void>()
// While true the module mock below serves test-local state; the afterAll flips
// it off. bun's mock.module registration survives the whole process (neither a
// spread re-mock nor mock.restore() un-installs it in bun 1.3.14), so a later
// test file importing 'src/utils/auth.js' (e.g.
// src/utils/__tests__/otelHeadersHelperFailure275.test.ts) would otherwise
// bind these stubs forever — getOtelHeadersLastFailure() would return null
// even after a real failure was recorded. Delegating to the real module once
// mockActive is false makes the surviving mock behave exactly like the real
// module for every subsequent file.
let mockActive = true

const actualAuth = await import('src/utils/auth.js')
// Capture the real functions BY VALUE before mock.module: bun patches the
// live bindings of the already-loaded namespace, so reading
// actualAuth.getOtelHeadersLastFailure AFTER the mock installs would return
// the delegate itself (infinite recursion).
const realGetLastFailure = actualAuth.getOtelHeadersLastFailure
const realSubscribe = actualAuth.subscribeOtelHeadersFailure
mock.module('src/utils/auth.js', () => ({
  ...actualAuth,
  getOtelHeadersLastFailure: () =>
    mockActive ? currentFailure : realGetLastFailure(),
  subscribeOtelHeadersFailure: (listener: (message: string) => void) => {
    if (!mockActive) return realSubscribe(listener)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}))
afterAll(() => {
  mockActive = false
})

// Imported AFTER the auth mock so the hook module binds the mocked functions.
const {
  OTEL_HEADERS_HELPER_FAILED_NOTIFICATION_KEY,
  buildOtelHeadersFailureNotification,
  createOtelHeadersFailureNotifier,
} = await import('../notifs/useOtelHeadersFailureNotification.js')

const PREFIX =
  'otelHeadersHelper failed; telemetry is not being exported. See /status: '

beforeEach(() => {
  currentFailure = null
  listeners.clear()
})

describe('buildOtelHeadersFailureNotification', () => {
  test('builds the byte-exact official notification object', () => {
    // Arrange
    const message = 'exited 3: boom'

    // Act
    const notification = buildOtelHeadersFailureNotification(message)

    // Assert
    expect(notification).toEqual({
      key: 'otel-headers-helper-failed',
      color: 'warning',
      priority: 'high',
      timeoutMs: 30_000,
      text: `${PREFIX}exited 3: boom`,
    })
    expect(OTEL_HEADERS_HELPER_FAILED_NOTIFICATION_KEY).toBe(
      'otel-headers-helper-failed',
    )
  })

  test('truncates the message to 120 display chars with the ellipsis marker', () => {
    // Arrange — 200 chars, over the official `wn(te,120)` cap
    const message = 'x'.repeat(200)

    // Act
    const { text } = buildOtelHeadersFailureNotification(message)

    // Assert — OCC's truncate(): 119 chars + '…' = 120 total width
    const rendered = text.slice(PREFIX.length)
    expect(rendered).toBe(`${'x'.repeat(119)}…`)
    expect(rendered.length).toBe(120)
  })

  test('passes short messages through unchanged', () => {
    // Arrange
    const message = 'timed out'

    // Act
    const { text } = buildOtelHeadersFailureNotification(message)

    // Assert
    expect(text).toBe(`${PREFIX}timed out`)
  })
})

describe('createOtelHeadersFailureNotifier (official HGt fire-once latch)', () => {
  test('fires immediately when a failure was already recorded', () => {
    // Arrange
    currentFailure = 'exited 3: boom'
    const added: unknown[] = []

    // Act
    const cleanup = createOtelHeadersFailureNotifier(n => added.push(n))

    // Assert
    expect(added).toEqual([buildOtelHeadersFailureNotification('exited 3: boom')])
    cleanup()
  })

  test('notifies on a later failure when none was recorded at setup', () => {
    // Arrange
    const added: unknown[] = []
    const cleanup = createOtelHeadersFailureNotifier(n => added.push(n))
    expect(added).toEqual([])

    // Act
    const [listener] = [...listeners]
    listener?.('could not be started')

    // Assert
    expect(added).toEqual([
      buildOtelHeadersFailureNotification('could not be started'),
    ])
    cleanup()
  })

  test('notifies only once per notifier instance (fire-once latch)', () => {
    // Arrange
    const added: unknown[] = []
    const cleanup = createOtelHeadersFailureNotifier(n => added.push(n))
    const [listener] = [...listeners]

    // Act
    listener?.('exited 4')
    listener?.('exited 5')
    listener?.('exited 6')

    // Assert
    expect(added).toHaveLength(1)
    expect((added[0] as { text: string }).text).toBe(`${PREFIX}exited 4`)
    cleanup()
  })

  test('an already-recorded failure also consumes the once-only latch', () => {
    // Arrange
    currentFailure = 'exited 7'
    const added: unknown[] = []
    const cleanup = createOtelHeadersFailureNotifier(n => added.push(n))
    const [listener] = [...listeners]

    // Act — later failures must not re-notify
    listener?.('exited 8')

    // Assert
    expect(added).toHaveLength(1)
    expect((added[0] as { text: string }).text).toBe(`${PREFIX}exited 7`)
    cleanup()
  })

  test('cleanup unsubscribes so later failures are not delivered', () => {
    // Arrange
    const added: unknown[] = []
    const cleanup = createOtelHeadersFailureNotifier(n => added.push(n))
    expect(listeners.size).toBe(1)

    // Act
    cleanup()

    // Assert — subscription removed, nothing delivered afterwards
    expect(listeners.size).toBe(0)
    expect(added).toEqual([])
  })
})
