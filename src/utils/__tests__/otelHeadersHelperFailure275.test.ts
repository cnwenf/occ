import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 2.1.275 (Item E1): otelHeadersHelper failure capture — when the configured
 * helper fails, the failure message + kind are recorded in module state, the
 * official telemetry event `tengu_otel_headers_helper_failed` fires with
 * {failure_kind, exit_code} (first failure only), and subscribed listeners
 * are notified. Reverse-engineered from the v2.1.276 binary:
 *   - `Qn` typed error class @193206747 (kind + exitCode).
 *   - `CEn()` classification @193207726: timedOut→timeout, numeric
 *     exitCode→exit_code (`exited N`), signal→killed (`was killed by SIG`),
 *     else spawn_failed (`could not be started`); trimmed stderr appended
 *     after ': '. Output kinds: empty_output / invalid_json / not_an_object
 *     / non_string_value (@193208300-193208800).
 *   - catch block @193208900: lastFailure always set; stderr warning
 *     (non-interactive) + listener emit + telemetry only when lastFailure
 *     was null (`h` latch); success resets lastFailure (@193208800).
 *   - `PSt()` getter @193206966 returns null when no helper is configured.
 *   - listener-threw log text @99761856: `otelHeadersHelper failure listener
 *     threw: `.
 * Test fixture pattern mirrors src/services/api/__tests__/apiKeyHelper-retry.test.ts.
 */

// --- telemetry capture (mock.module spread + restore, OCC-97) ---
const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
const actualAnalytics = await import('src/services/analytics/index.js')
mock.module('src/services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown> = {}) => {
    events.push({ name, metadata })
  },
}))
afterAll(() => {
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
})

const SCRIPT_PATH = join(tmpdir(), `occ-otel-helper-test-${process.pid}.sh`)
const PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
let tmpConfigDir: string

function writeScript(content: string): void {
  writeFileSync(SCRIPT_PATH, content)
  chmodSync(SCRIPT_PATH, 0o755)
}

const {
  getOtelHeadersFromHelper,
  getOtelHeadersLastFailure,
  getOtelHeadersLastFailureDetail,
  clearOtelHeadersHelperState,
  subscribeOtelHeadersFailure,
  classifyOtelHeadersExecFailure,
  OtelHeadersHelperError,
} = await import('../auth.js')
const { resetSettingsCache } = await import(
  '../settings/settingsCache.js'
) as typeof import('../settings/settingsCache.js') & {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = await import('../envUtils.js') as {
  getClaudeConfigHomeDir: (() => string) & { cache?: Map<unknown, string> }
}

function otelFailureEvents(): Array<Record<string, unknown>> {
  return events
    .filter(e => e.name === 'tengu_otel_headers_helper_failed')
    .map(e => e.metadata)
}

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-otel-cfg-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()
  writeFileSync(
    join(tmpConfigDir, 'settings.json'),
    JSON.stringify({ otelHeadersHelper: SCRIPT_PATH }),
  )
})

afterAll(() => {
  if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR
  rmSync(tmpConfigDir, { recursive: true, force: true })
  rmSync(SCRIPT_PATH, { force: true })
})

beforeEach(() => {
  clearOtelHeadersHelperState()
  resetSettingsCache()
  events.length = 0
})

describe('classifyOtelHeadersExecFailure (official CEn classification @193207726)', () => {
  test('returns null when the exec did not fail', () => {
    // Arrange
    const result = { failed: false, timedOut: false, exitCode: 0 }

    // Act
    const failure = classifyOtelHeadersExecFailure(result)

    // Assert
    expect(failure).toBeNull()
  })

  test('classifies a timed-out exec as kind timeout with message "timed out"', () => {
    // Arrange
    const result = { failed: true, timedOut: true }

    // Act
    const failure = classifyOtelHeadersExecFailure(result)

    // Assert
    expect(failure).toBeInstanceOf(OtelHeadersHelperError)
    expect(failure?.kind).toBe('timeout')
    expect(failure?.message).toBe('timed out')
    expect(failure?.exitCode).toBeUndefined()
  })

  test('classifies a numeric exit code as kind exit_code and carries the code', () => {
    // Arrange
    const result = { failed: true, timedOut: false, exitCode: 3 }

    // Act
    const failure = classifyOtelHeadersExecFailure(result)

    // Assert
    expect(failure?.kind).toBe('exit_code')
    expect(failure?.message).toBe('exited 3')
    expect(failure?.exitCode).toBe(3)
  })

  test('classifies a signal death as kind killed with message "was killed by SIG"', () => {
    // Arrange
    const result = { failed: true, timedOut: false, signal: 'SIGKILL' }

    // Act
    const failure = classifyOtelHeadersExecFailure(result)

    // Assert
    expect(failure?.kind).toBe('killed')
    expect(failure?.message).toBe('was killed by SIGKILL')
  })

  test('classifies a non-spawnable command as kind spawn_failed', () => {
    // Arrange
    const result = { failed: true, timedOut: false }

    // Act
    const failure = classifyOtelHeadersExecFailure(result)

    // Assert
    expect(failure?.kind).toBe('spawn_failed')
    expect(failure?.message).toBe('could not be started')
  })

  test('appends trimmed stderr after ": " (timeout takes precedence over exit code)', () => {
    // Arrange
    const result = {
      failed: true,
      timedOut: true,
      stderr: '  helper blew up \n',
    }

    // Act
    const failure = classifyOtelHeadersExecFailure(result)

    // Assert
    expect(failure?.kind).toBe('timeout')
    expect(failure?.message).toBe('timed out: helper blew up')
  })
})

describe('getOtelHeadersFromHelper failure capture (2.1.275)', () => {
  test('records an exit_code failure with byte-exact message, kind, and telemetry', () => {
    // Arrange
    writeScript('#!/bin/sh\necho "boom" >&2\nexit 3\n')
    const seen: string[] = []
    const unsubscribe = subscribeOtelHeadersFailure(m => seen.push(m))

    // Act
    const call = () => getOtelHeadersFromHelper()

    // Assert
    expect(call).toThrow(OtelHeadersHelperError)
    expect(getOtelHeadersLastFailure()).toBe('exited 3: boom')
    expect(getOtelHeadersLastFailureDetail()).toEqual({
      message: 'exited 3: boom',
      kind: 'exit_code',
      exitCode: 3,
    })
    expect(seen).toEqual(['exited 3: boom'])
    expect(otelFailureEvents()).toEqual([
      { failure_kind: 'exit_code', exit_code: 3 },
    ])
    unsubscribe()
  })

  test('classifies a silent successful exit as empty_output', () => {
    // Arrange
    writeScript('#!/bin/sh\nexit 0\n')

    // Act
    const call = () => getOtelHeadersFromHelper()

    // Assert
    expect(call).toThrow('otelHeadersHelper did not return a valid value')
    expect(getOtelHeadersLastFailureDetail()?.kind).toBe('empty_output')
    expect(otelFailureEvents()).toEqual([
      { failure_kind: 'empty_output', exit_code: undefined },
    ])
  })

  test('classifies non-JSON output as invalid_json', () => {
    // Arrange
    writeScript('#!/bin/sh\necho hi\n')

    // Act
    const call = () => getOtelHeadersFromHelper()

    // Assert
    expect(call).toThrow('otelHeadersHelper did not return valid JSON')
    expect(getOtelHeadersLastFailureDetail()?.kind).toBe('invalid_json')
  })

  test('classifies a JSON array as not_an_object', () => {
    // Arrange
    writeScript("#!/bin/sh\necho '[1,2]'\n")

    // Act
    const call = () => getOtelHeadersFromHelper()

    // Assert
    expect(call).toThrow(
      'otelHeadersHelper must return a JSON object with string key-value pairs',
    )
    expect(getOtelHeadersLastFailureDetail()?.kind).toBe('not_an_object')
  })

  test('classifies a numeric header value as non_string_value', () => {
    // Arrange
    writeScript('#!/bin/sh\necho \'{"a":1}\'\n')

    // Act
    const call = () => getOtelHeadersFromHelper()

    // Assert
    expect(call).toThrow(
      'otelHeadersHelper returned non-string value for key "a": number',
    )
    expect(getOtelHeadersLastFailureDetail()?.kind).toBe('non_string_value')
  })

  test('emits telemetry and notifies listeners only on the first failure', () => {
    // Arrange
    writeScript('#!/bin/sh\nexit 4\n')
    const seen: string[] = []
    const unsubscribe = subscribeOtelHeadersFailure(m => seen.push(m))

    // Act
    expect(() => getOtelHeadersFromHelper()).toThrow()
    expect(() => getOtelHeadersFromHelper()).toThrow()

    // Assert — state still set, but listener + telemetry fired exactly once
    expect(getOtelHeadersLastFailure()).toBe('exited 4')
    expect(seen).toEqual(['exited 4'])
    expect(otelFailureEvents()).toHaveLength(1)
    unsubscribe()
  })

  test('resets the failure state on success and re-arms the first-failure latch', () => {
    // Arrange
    writeScript('#!/bin/sh\nexit 5\n')
    const seen: string[] = []
    const unsubscribe = subscribeOtelHeadersFailure(m => seen.push(m))
    expect(() => getOtelHeadersFromHelper()).toThrow()
    expect(getOtelHeadersLastFailure()).toBe('exited 5')

    // Act — helper recovers
    writeScript('#!/bin/sh\necho \'{"x":"y"}\'\n')
    clearOtelHeadersHelperState()
    const headers = getOtelHeadersFromHelper()

    // Assert
    expect(headers).toEqual({ x: 'y' })
    expect(getOtelHeadersLastFailure()).toBeNull()

    // A later failure notifies again (official resets lastFailure on success)
    writeScript('#!/bin/sh\nexit 6\n')
    clearOtelHeadersHelperState()
    expect(() => getOtelHeadersFromHelper()).toThrow()
    expect(seen).toEqual(['exited 5', 'exited 6'])
    expect(otelFailureEvents()).toHaveLength(2)
    unsubscribe()
  })

  test('unsubscribe stops listener delivery', () => {
    // Arrange
    writeScript('#!/bin/sh\nexit 7\n')
    const seen: string[] = []
    const unsubscribe = subscribeOtelHeadersFailure(m => seen.push(m))
    unsubscribe()

    // Act
    expect(() => getOtelHeadersFromHelper()).toThrow()

    // Assert
    expect(seen).toEqual([])
    expect(getOtelHeadersLastFailure()).toBe('exited 7')
  })

  test('a throwing listener does not break the failure path', () => {
    // Arrange
    writeScript('#!/bin/sh\nexit 8\n')
    const unsubscribe = subscribeOtelHeadersFailure(() => {
      throw new Error('listener exploded')
    })

    // Act
    const call = () => getOtelHeadersFromHelper()

    // Assert — the helper error (not the listener error) propagates
    expect(call).toThrow('exited 8')
    expect(getOtelHeadersLastFailureDetail()?.kind).toBe('exit_code')
    unsubscribe()
  })

  test('the last-failure getter returns null when no helper is configured (official PSt gating)', () => {
    // Arrange — record a failure while configured
    writeScript('#!/bin/sh\nexit 9\n')
    expect(() => getOtelHeadersFromHelper()).toThrow()
    expect(getOtelHeadersLastFailure()).toBe('exited 9')

    // Act — remove the helper from settings
    writeFileSync(join(tmpConfigDir, 'settings.json'), JSON.stringify({}))
    resetSettingsCache()

    // Assert
    expect(getOtelHeadersLastFailure()).toBeNull()
    expect(getOtelHeadersLastFailureDetail()).toBeNull()

    // Restore for any later tests
    writeFileSync(
      join(tmpConfigDir, 'settings.json'),
      JSON.stringify({ otelHeadersHelper: SCRIPT_PATH }),
    )
    resetSettingsCache()
  })

  test('clearOtelHeadersHelperState resets both the failure and the header cache', () => {
    // Arrange
    writeScript('#!/bin/sh\necho \'{"h":"v"}\'\n')
    expect(getOtelHeadersFromHelper()).toEqual({ h: 'v' })
    writeScript('#!/bin/sh\nexit 10\n')

    // Act — cached success masks the now-failing helper until cleared
    expect(getOtelHeadersFromHelper()).toEqual({ h: 'v' })
    clearOtelHeadersHelperState()
    expect(() => getOtelHeadersFromHelper()).toThrow('exited 10')
    clearOtelHeadersHelperState()

    // Assert
    expect(getOtelHeadersLastFailure()).toBeNull()
  })
})
