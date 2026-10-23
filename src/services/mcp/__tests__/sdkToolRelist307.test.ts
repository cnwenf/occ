import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.307 (B4): "Fixed a turn sometimes starting without an SDK MCP
 * server's latest tools when a background task was running."
 *
 * Covers the SDK tool-relist pending state (official `qs` predicate +
 * `Ge`/`vs` module state), the wait-budget helper (official `dWe`), the
 * race-with-timeout helper (official `Oe` resolve-undefined semantics), the
 * kept-previous bookkeeping (official `Ki` failure branch with the
 * `mcp_sdk_tools_refresh` kept_previous/gave_up counters), and the turn-start
 * join (official `fi.sdkToolRelistJoin`).
 *
 * Telemetry (`logEvent`) is captured via a mocked analytics module (repo
 * template: contentBlockHealing234.test.ts). Diagnostic logs are captured
 * through the REAL logForDiagnosticsNoPII by pointing
 * CLAUDE_CODE_DIAGNOSTICS_FILE at a temp file — this asserts the verbatim
 * log level/key/field contract (`sdk_mcp_relist_wait` with budget_ms,
 * waited_ms, timed_out, tools_change_still_pending).
 */

const events: Array<{ name: string; metadata: Record<string, unknown> }> = []

const actualAnalytics = await import('src/services/analytics/index.js')
mock.module('src/services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    events.push({ name, metadata: metadata ?? {} })
  },
}))

afterAll(() => {
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
})

const {
  beginSdkRefresh,
  endSdkRefresh,
  raceWithTimeout,
  resetSdkToolRelistForTesting,
  sdkToolRelistJoin,
  sdkToolRelistKeptFailure,
  sdkToolRelistPending,
  sdkToolRelistSuccess,
  sdkUpdateWaitBudgetMs,
  setSdkServerRegistry,
} = await import('../sdkToolRelist.js')

type DiagEntry = {
  level: string
  event: string
  data: Record<string, unknown>
}

let diagDir = ''
let diagFile = ''
let savedTimeoutEnv: string | undefined
let savedDiagEnv: string | undefined

function diagEntries(): DiagEntry[] {
  try {
    return readFileSync(diagFile, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as DiagEntry)
  } catch {
    return []
  }
}

beforeEach(() => {
  resetSdkToolRelistForTesting()
  setSdkServerRegistry(undefined)
  events.length = 0
  savedTimeoutEnv = process.env.MCP_CONNECT_TIMEOUT_MS
  savedDiagEnv = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  delete process.env.MCP_CONNECT_TIMEOUT_MS
  diagDir = mkdtempSync(join(tmpdir(), 'sdk-tool-relist-307-'))
  diagFile = join(diagDir, 'diag.log')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = diagFile
})

afterEach(() => {
  if (savedTimeoutEnv === undefined) {
    delete process.env.MCP_CONNECT_TIMEOUT_MS
  } else {
    process.env.MCP_CONNECT_TIMEOUT_MS = savedTimeoutEnv
  }
  if (savedDiagEnv === undefined) {
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  } else {
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = savedDiagEnv
  }
  rmSync(diagDir, { recursive: true, force: true })
})

describe('sdkUpdateWaitBudgetMs (official dWe @19314170)', () => {
  test('returns the 5000ms default when MCP_CONNECT_TIMEOUT_MS is unset', () => {
    // Arrange: beforeEach deleted the env var.

    // Act
    const budget = sdkUpdateWaitBudgetMs()

    // Assert
    expect(budget).toBe(5000)
  })

  test('returns the 5000ms default when MCP_CONNECT_TIMEOUT_MS is 0', () => {
    // Arrange
    process.env.MCP_CONNECT_TIMEOUT_MS = '0'

    // Act
    const budget = sdkUpdateWaitBudgetMs()

    // Assert
    expect(budget).toBe(5000)
  })

  test('returns the env value when MCP_CONNECT_TIMEOUT_MS > 0', () => {
    // Arrange
    process.env.MCP_CONNECT_TIMEOUT_MS = '3000'

    // Act
    const budget = sdkUpdateWaitBudgetMs()

    // Assert
    expect(budget).toBe(3000)
  })

  test('caps the env value at 2147483647 (setTimeout ceiling)', () => {
    // Arrange
    process.env.MCP_CONNECT_TIMEOUT_MS = '99999999999999'

    // Act
    const budget = sdkUpdateWaitBudgetMs()

    // Assert
    expect(budget).toBe(2147483647)
  })

  test('falls back to 5000 for negative values', () => {
    // Arrange
    process.env.MCP_CONNECT_TIMEOUT_MS = '-5'

    // Act & Assert
    expect(sdkUpdateWaitBudgetMs()).toBe(5000)
  })

  test('falls back to 5000 for non-numeric garbage', () => {
    // Arrange
    process.env.MCP_CONNECT_TIMEOUT_MS = 'abc'

    // Act & Assert
    expect(sdkUpdateWaitBudgetMs()).toBe(5000)
  })
})

describe('sdkToolRelistPending (official qs @45784973)', () => {
  test('returns false when nothing is pending', () => {
    // Act & Assert
    expect(sdkToolRelistPending()).toBe(false)
  })

  test('returns true while an SDK refresh is in flight', () => {
    // Act
    beginSdkRefresh()

    // Assert
    expect(sdkToolRelistPending()).toBe(true)

    // Act: refresh completes
    endSdkRefresh()

    // Assert
    expect(sdkToolRelistPending()).toBe(false)
  })

  test('returns true when a kept-previous server is configured and connected', () => {
    // Arrange
    setSdkServerRegistry({
      isConfigured: name => name === 'srv',
      isConnected: name => name === 'srv',
    })
    sdkToolRelistKeptFailure('srv')
    events.length = 0

    // Act & Assert
    expect(sdkToolRelistPending()).toBe(true)
  })

  test('returns false when the kept-previous server is not connected', () => {
    // Arrange
    setSdkServerRegistry({
      isConfigured: () => true,
      isConnected: () => false,
    })
    sdkToolRelistKeptFailure('srv')

    // Act & Assert
    expect(sdkToolRelistPending()).toBe(false)
  })

  test('returns false when the kept-previous server is no longer configured', () => {
    // Arrange
    setSdkServerRegistry({
      isConfigured: () => false,
      isConnected: () => true,
    })
    sdkToolRelistKeptFailure('srv')

    // Act & Assert
    expect(sdkToolRelistPending()).toBe(false)
  })

  test('returns false for a kept-previous server when no registry is wired', () => {
    // Arrange: no setSdkServerRegistry call (registry undefined).
    sdkToolRelistKeptFailure('srv')

    // Act & Assert
    expect(sdkToolRelistPending()).toBe(false)
  })
})

describe('kept-previous bookkeeping (official Ki failure branch @45785250)', () => {
  test('first refresh failure counts kept_previous and marks the server', () => {
    // Arrange
    setSdkServerRegistry({ isConfigured: () => true, isConnected: () => true })

    // Act
    sdkToolRelistKeptFailure('srv')

    // Assert
    expect(events).toEqual([
      {
        name: 'tengu_mcp_sdk_tools_refresh',
        metadata: { action: 'kept_previous' },
      },
    ])
    expect(sdkToolRelistPending()).toBe(true)
  })

  test('repeated failure counts gave_up but the pending gate STAYS ARMED (F-02)', () => {
    // Arrange — official Ki kept-previous branch (@276495801 region):
    // `if(...,ka.delete(I.name)){f("mcp_sdk_tools_refresh","gave_up");return}
    //  f("mcp_sdk_tools_refresh","kept_previous"),ka.add(I.name),vs.add(I.name)`
    // gave_up consumes ONLY ka; the name STAYS in vs, and qs() iterates vs —
    // so the turn-start gate must remain armed for the next relist cycle.
    setSdkServerRegistry({ isConfigured: () => true, isConnected: () => true })
    sdkToolRelistKeptFailure('srv')
    events.length = 0

    // Act
    sdkToolRelistKeptFailure('srv')

    // Assert
    expect(events).toEqual([
      {
        name: 'tengu_mcp_sdk_tools_refresh',
        metadata: { action: 'gave_up' },
      },
    ])
    expect(sdkToolRelistPending()).toBe(true)
  })

  test('successive failures alternate kept_previous / gave_up while the gate stays armed (F-02)', () => {
    // Arrange — because gave_up only consumes ka, the official alternates on
    // every consecutive failure: kept_previous, gave_up, kept_previous, ...
    // (a permanent disarm — the F-02 bug — would emit gave_up never again
    // and drop pending to false).
    setSdkServerRegistry({ isConfigured: () => true, isConnected: () => true })

    // Act & Assert — cycle 1: kept_previous.
    sdkToolRelistKeptFailure('srv')
    expect(events.map(e => e.metadata.action)).toEqual(['kept_previous'])
    expect(sdkToolRelistPending()).toBe(true)

    // Act & Assert — cycle 2: gave_up, still armed.
    events.length = 0
    sdkToolRelistKeptFailure('srv')
    expect(events.map(e => e.metadata.action)).toEqual(['gave_up'])
    expect(sdkToolRelistPending()).toBe(true)

    // Act & Assert — cycle 3: ka was consumed by gave_up, so this is a fresh
    // kept_previous, still armed.
    events.length = 0
    sdkToolRelistKeptFailure('srv')
    expect(events.map(e => e.metadata.action)).toEqual(['kept_previous'])
    expect(sdkToolRelistPending()).toBe(true)

    // Act & Assert — cycle 4: gave_up again.
    events.length = 0
    sdkToolRelistKeptFailure('srv')
    expect(events.map(e => e.metadata.action)).toEqual(['gave_up'])
    expect(sdkToolRelistPending()).toBe(true)
  })

  test('success after gave_up clears BOTH sets: gate disarmed and the cycle restarts at kept_previous (F-02)', () => {
    // Arrange — official success consumes ka in Ki (`ka.delete(I.name),
    // g("mcp_sdk_tools_refresh")` @276496000 region) and vs in the Vi
    // relist loop / disable path (`vs.delete(mt)` @276501515,
    // `vs.delete(I),ka.delete(I)` @276504004). OCC folds both consumptions
    // into sdkToolRelistSuccess (no Vi loop).
    setSdkServerRegistry({ isConfigured: () => true, isConnected: () => true })
    sdkToolRelistKeptFailure('srv')
    sdkToolRelistKeptFailure('srv') // gave_up; vs retains 'srv'
    events.length = 0

    // Act
    sdkToolRelistSuccess('srv')

    // Assert — gate disarmed.
    expect(sdkToolRelistPending()).toBe(false)
    expect(events).toEqual([])

    // Act — a NEW failure after the success starts a fresh ka cycle.
    sdkToolRelistKeptFailure('srv')

    // Assert — kept_previous (not gave_up: the success cleared ka too).
    expect(events.map(e => e.metadata.action)).toEqual(['kept_previous'])
    expect(sdkToolRelistPending()).toBe(true)
  })

  test('a later success clears the kept mark without counter telemetry', () => {
    // Arrange
    setSdkServerRegistry({ isConfigured: () => true, isConnected: () => true })
    sdkToolRelistKeptFailure('srv')
    events.length = 0

    // Act
    sdkToolRelistSuccess('srv')

    // Assert
    expect(sdkToolRelistPending()).toBe(false)
    expect(events).toEqual([])
  })
})

describe('raceWithTimeout (official Oe resolve-undefined semantics)', () => {
  test('resolves with the promise value when it settles before the timeout', async () => {
    // Act
    const result = await raceWithTimeout(Promise.resolve(true), 1000)

    // Assert
    expect(result).toBe(true)
  })

  test('resolves undefined on timeout (never rejects)', async () => {
    // Arrange
    const never = new Promise<boolean>(() => {})

    // Act
    const result = await raceWithTimeout(never, 20)

    // Assert
    expect(result).toBeUndefined()
  })
})

describe('sdkToolRelistJoin (official fi.sdkToolRelistJoin @401245)', () => {
  test('returns null when shouldQuery === false', () => {
    // Arrange
    beginSdkRefresh()
    let updateCalled = false

    // Act
    const join = sdkToolRelistJoin({ shouldQuery: false }, async () => {
      updateCalled = true
    })

    // Assert
    expect(join).toBeNull()
    expect(updateCalled).toBe(false)
    endSdkRefresh()
  })

  test('returns null when no relist is pending', () => {
    // Arrange
    let updateCalled = false

    // Act
    const join = sdkToolRelistJoin({}, async () => {
      updateCalled = true
    })

    // Assert
    expect(join).toBeNull()
    expect(updateCalled).toBe(false)
  })

  test('success path awaits the update and logs info sdk_mcp_relist_wait', async () => {
    // Arrange
    setSdkServerRegistry({ isConfigured: () => true, isConnected: () => true })
    sdkToolRelistKeptFailure('srv')
    diagEntries() // touch: diag file created lazily by first append

    // Act
    const join = sdkToolRelistJoin({}, async () => {
      sdkToolRelistSuccess('srv')
    })
    expect(join).not.toBeNull()
    await join

    // Assert
    const entries = diagEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.level).toBe('info')
    expect(entries[0]!.event).toBe('sdk_mcp_relist_wait')
    expect(entries[0]!.data.budget_ms).toBe(5000)
    expect(typeof entries[0]!.data.waited_ms).toBe('number')
    expect(entries[0]!.data.timed_out).toBe(false)
    expect(entries[0]!.data.tools_change_still_pending).toBe(false)
  })

  test('timeout path logs warn with timed_out:true and resolves anyway (turn proceeds)', async () => {
    // Arrange: tiny budget; pending stays true via the in-flight counter.
    process.env.MCP_CONNECT_TIMEOUT_MS = '20'
    beginSdkRefresh()

    // Act: the update never settles within the budget.
    const lateUpdate = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('late failure')), 150)
    })
    const join = sdkToolRelistJoin({}, () => lateUpdate)
    expect(join).not.toBeNull()
    await join

    // Assert: warn logged with the verbatim field contract; turn proceeds.
    const entries = diagEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.level).toBe('warn')
    expect(entries[0]!.event).toBe('sdk_mcp_relist_wait')
    expect(entries[0]!.data.budget_ms).toBe(20)
    expect(typeof entries[0]!.data.waited_ms).toBe('number')
    expect(entries[0]!.data.timed_out).toBe(true)
    expect(entries[0]!.data.tools_change_still_pending).toBe(true)

    // The join attached .catch to the update promise: the late rejection
    // must not surface as an unhandled rejection (bun would fail the run).
    await new Promise(resolve => setTimeout(resolve, 250))
    endSdkRefresh()
  })
})
