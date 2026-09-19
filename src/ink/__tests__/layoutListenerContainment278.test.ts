import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// ink.tsx reads MACRO.VERSION transitively (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill before importing.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Capture the REAL log/debug modules first, then mock them spreading the real
// exports and overriding only the two sinks ink.tsx's fault path calls. Bun's
// mock.module leaks across files in one worker, so restore both in afterAll
// (same discipline as src/utils/__tests__/ripgrepOutputCap276.test.ts).
const actualLog = { ...(await import('src/utils/log.js')) }
const actualDebug = { ...(await import('src/utils/debug.js')) }

const logErrorMessages: string[] = []
const debugLines: { msg: string; opts?: unknown }[] = []

mock.module('src/utils/log.js', () => ({
  ...actualLog,
  logError: (error: unknown) => {
    logErrorMessages.push(error instanceof Error ? error.message : String(error))
  },
}))
mock.module('src/utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (msg: string, opts?: unknown) => {
    debugLines.push({ msg, opts })
  },
}))

const { default: Ink } = await import('../ink.js')

afterAll(() => {
  mock.module('src/utils/log.js', () => ({ ...actualLog }))
  mock.module('src/utils/debug.js', () => ({ ...actualDebug }))
})

// The full Ink constructor is heavy (backpressure monitor, reconciler
// container, screen-reader state). The containment logic lives entirely on the
// prototype + five plain fields, so build a bare instance and seed them.
type InkLike = {
  selectionListeners: Set<() => void>
  selectionListenersPaused: boolean
  reportedSelectionListenerFault: boolean
  selectionListenerFaultDebugLines: number
  reportedSelectionFaultMessages: Set<string>
  notifySelectionListeners(): void
}
function makeInk(): InkLike {
  const ink = Object.create(Ink.prototype) as InkLike
  ink.selectionListeners = new Set<() => void>()
  ink.selectionListenersPaused = false
  ink.reportedSelectionListenerFault = false
  ink.selectionListenerFaultDebugLines = 0
  ink.reportedSelectionFaultMessages = new Set<string>()
  return ink
}

/** Let the queued microtask (pause release) run. */
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * CC 2.1.278 (D6) — screen stops updating after an internal render error.
 *
 * Ported from the official ink layout-listener containment (binary
 * `notifyLayoutListeners` + `Pwe.describeLayoutFault`, caps `lb`=5 / `JC`=16).
 * A throwing listener is now contained: it pauses the listener set for the
 * current flush (released on a microtask), reports once, and logs a capped warn
 * line — so one bad listener can no longer wedge the render loop. All strings
 * below are byte-copied from src/ink/ink.tsx (verified against the v278 ELF).
 */
describe('2.1.278 D6 — ink layout-listener fault containment', () => {
  beforeEach(() => {
    logErrorMessages.length = 0
    debugLines.length = 0
  })

  test('a throwing listener is contained (no re-throw) and pauses the set', () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      throw new Error('boom')
    })

    // Act — must not throw out of the notify loop
    expect(() => ink.notifySelectionListeners()).not.toThrow()

    // Assert
    expect(ink.selectionListenersPaused).toBe(true)
    expect(ink.reportedSelectionListenerFault).toBe(true)
    expect(ink.selectionListenerFaultDebugLines).toBe(1)
  })

  test('reports the fault error then the byte-exact "paused" error once', () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      throw new Error('boom')
    })

    // Act
    ink.notifySelectionListeners()

    // Assert — reportSelectionFaultErrorOnce(fault) then reportSelectionListenersPaused()
    expect(logErrorMessages).toEqual([
      'boom',
      'ink layout listener threw; layout listeners paused until this flush unwinds',
    ])
  })

  test('logs the byte-exact capped warn line with { level: "warn" }', () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      throw new Error('boom')
    })

    // Act
    ink.notifySelectionListeners()

    // Assert
    expect(debugLines).toHaveLength(1)
    expect(debugLines[0].msg).toBe(
      'ink layout listener threw (contained; layout listeners paused until this flush unwinds): Error: boom',
    )
    expect(debugLines[0].opts).toEqual({ level: 'warn' })
  })

  test('the pause releases on a microtask so the next flush resumes', async () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      throw new Error('boom')
    })

    // Act
    ink.notifySelectionListeners()
    expect(ink.selectionListenersPaused).toBe(true)
    await flushMicrotasks()

    // Assert
    expect(ink.selectionListenersPaused).toBe(false)
  })

  test('while paused, notify is a no-op (does not re-run listeners)', () => {
    // Arrange
    const ink = makeInk()
    let calls = 0
    ink.selectionListeners.add(() => {
      calls++
    })
    ink.selectionListenersPaused = true

    // Act
    ink.notifySelectionListeners()

    // Assert — early return before the loop
    expect(calls).toBe(0)
  })

  test('the "paused" report fires once across repeated faults', async () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      throw new Error('boom')
    })

    // Act — two faults, releasing the pause between them
    ink.notifySelectionListeners()
    await flushMicrotasks()
    ink.notifySelectionListeners()

    // Assert
    const pausedReports = logErrorMessages.filter(
      m => m === 'ink layout listener threw; layout listeners paused until this flush unwinds',
    )
    expect(pausedReports).toHaveLength(1)
    expect(ink.reportedSelectionListenerFault).toBe(true)
  })

  test('a repeated identical fault message is reported to logError only once', async () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      throw new Error('boom')
    })

    // Act
    ink.notifySelectionListeners()
    await flushMicrotasks()
    ink.notifySelectionListeners()

    // Assert — reportSelectionFaultErrorOnce dedups on fault.message
    const boomReports = logErrorMessages.filter(m => m === 'boom')
    expect(boomReports).toHaveLength(1)
  })

  test('warn lines are capped at 5; the 5th carries the byte-exact suffix and the 6th is suppressed', async () => {
    // Arrange
    const ink = makeInk()

    // Act — six DISTINCT faults (distinct messages bypass the logError dedup so
    // each reaches the debug-line counter)
    for (let i = 1; i <= 6; i++) {
      ink.selectionListeners.clear()
      const n = i
      ink.selectionListeners.add(() => {
        throw new Error(`fault-${n}`)
      })
      ink.notifySelectionListeners()
      await flushMicrotasks()
    }

    // Assert
    expect(debugLines).toHaveLength(5)
    expect(debugLines[4].msg).toBe(
      'ink layout listener threw (contained; layout listeners paused until this flush unwinds): Error: fault-5 — further layout listener faults in this session are not logged',
    )
    // The first four carry no suffix.
    expect(debugLines[0].msg.endsWith('Error: fault-1')).toBe(true)
  })

  test('a non-Error throw with name+message is described via those fields', () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      // eslint-disable-next-line no-throw-literal
      throw { name: 'CustomFault', message: 'oops' }
    })

    // Act
    ink.notifySelectionListeners()

    // Assert — describeLayoutFault rebuilds an Error carrying name+message
    expect(debugLines[0].msg).toBe(
      'ink layout listener threw (contained; layout listeners paused until this flush unwinds): CustomFault: oops',
    )
  })

  test('an indescribable throw falls back to the generic descriptor', () => {
    // Arrange
    const ink = makeInk()
    ink.selectionListeners.add(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'just a string'
    })

    // Act
    ink.notifySelectionListeners()

    // Assert
    expect(debugLines[0].msg).toBe(
      'ink layout listener threw (contained; layout listeners paused until this flush unwinds): Error: ink layout pass threw a value that cannot be described',
    )
  })

  test('healthy listeners still run when none throw', () => {
    // Arrange
    const ink = makeInk()
    const seen: number[] = []
    ink.selectionListeners.add(() => seen.push(1))
    ink.selectionListeners.add(() => seen.push(2))

    // Act
    ink.notifySelectionListeners()

    // Assert — no pause, no fault reporting, both ran in order
    expect(seen).toEqual([1, 2])
    expect(ink.selectionListenersPaused).toBe(false)
    expect(logErrorMessages).toEqual([])
    expect(debugLines).toEqual([])
  })
})
