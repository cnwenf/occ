import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.295 changelog #017: "Fixed `claude -p` text output dropping earlier
 * responses when background work started another turn; each turn's response
 * now prints when the turn ends."
 *
 * Unit tests for the ported official v295 printer (`hg`/`vT` →
 * PrintTextResults/isEmptySuccessResult, src/cli/printTextResults.ts — see
 * that file's header for binary evidence offsets: v295 class @ ~241577450,
 * wiring @ ~241654050/241654205/241654784; all symbols absent from v294).
 * v296 re-verified UNCHANGED at this site (class `Ig` @ 233508506, wiring @
 * 233583727/233585825/233586406 — identifier-canonicalized byte comparison
 * identical; renames only hg→Ig / vT→BT / BGn→j2n).
 */

process.env.NODE_ENV = 'test'
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.294',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

// -- Mock leaf collaborators (spread-real keeps every other export intact;
// pattern: headlessCostRestore277.test.ts). Snapshot real exports BEFORE
// mocking — `await import()` namespaces are live bindings.

const realProcess = { ...(await import('../../utils/process.js')) }
const stdoutWrites: string[] = []
let throwOnWrite = false
mock.module('../../utils/process.js', () => ({
  ...realProcess,
  writeToStdout: (data: string) => {
    if (throwOnWrite) {
      throw new Error('simulated stdout write failure')
    }
    stdoutWrites.push(data)
  },
}))

const realAnalytics = { ...(await import('../../services/analytics/index.js')) }
const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
mock.module('../../services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    events.push({ name, metadata })
  },
}))

const realGrowthbook = {
  ...(await import('../../services/analytics/growthbook.js')),
}
let jazzyPuddleEnabled = true
mock.module('../../services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (
    feature: string,
    defaultValue: unknown,
  ) => (feature === 'tengu_jazzy_puddle' ? jazzyPuddleEnabled : defaultValue),
}))

const { PrintTextResults, isEmptySuccessResult } = await import(
  '../printTextResults.js'
)

// -- Fixtures ---------------------------------------------------------------

const LIMITS = { maxTurns: 5, maxBudgetUsd: 1.5 }

const successResult = (result: string) => ({
  type: 'result',
  subtype: 'success',
  result,
})

const errorResult = (
  subtype: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'result',
  subtype,
  ...extra,
})

beforeEach(() => {
  stdoutWrites.length = 0
  events.length = 0
  throwOnWrite = false
  jazzyPuddleEnabled = true
})

// -- Tests ------------------------------------------------------------------

describe('CC 2.1.295 #017 PrintTextResults', () => {
  test('single-turn result prints once — printAtExit dedupes by object identity', () => {
    // Arrange
    const printer = new PrintTextResults(LIMITS)
    const result = successResult('Hello')

    // Act
    printer.printAtTurnEnd(result, undefined)
    printer.printAtExit(result, undefined)

    // Assert — official v295: `e!==this.lastPrinted` identity check skips
    // the already-printed final result, so single-turn output is unchanged.
    expect(stdoutWrites).toEqual(['Hello\n'])
    expect(printer.printedCount).toBe(1)
    expect(events).toEqual([])
  })

  test('multi-turn run prints EVERY turn response at turn end (#017 regression)', () => {
    // Arrange — v294 dropped r1 here: only the final result printed at exit.
    const printer = new PrintTextResults(LIMITS)
    const r1 = successResult('First turn')
    const r2 = successResult('Second turn')

    // Act
    printer.printAtTurnEnd(r1, undefined)
    printer.printAtTurnEnd(r2, undefined)
    printer.printAtExit(r2, undefined)

    // Assert — separator is '\n' when the previous print ended with newline
    // (official: `s=this.printedCount===0?"":this.endsWithNewline?"\n":"\n\n"`).
    expect(stdoutWrites).toEqual(['First turn\n', '\nSecond turn\n'])
    expect(printer.printedCount).toBe(2)
  })

  test('flag off (tengu_jazzy_puddle=false): turn-end no-ops, exit prints once — v294 behavior', () => {
    // Arrange
    jazzyPuddleEnabled = false
    const printer = new PrintTextResults(LIMITS)
    const r1 = successResult('dropped by flag')
    const r2 = successResult('Final')

    // Act
    printer.printAtTurnEnd(r1, undefined)
    printer.printAtTurnEnd(r2, undefined)
    printer.printAtExit(r2, undefined)

    // Assert — printedCount===0 at exit forces the single v294-style print.
    expect(stdoutWrites).toEqual(['Final\n'])
    expect(printer.printedCount).toBe(1)
  })

  test('result already ending with newline is not doubled', () => {
    const printer = new PrintTextResults(LIMITS)
    printer.printAtTurnEnd(successResult('Line\n'), undefined)
    expect(stdoutWrites).toEqual(['Line\n'])
  })

  test('empty success result skipped at turn end but printed at exit when nothing was printed', () => {
    // Arrange — official `vT`: success + no partial + result.trim()===''
    const printer = new PrintTextResults(LIMITS)
    const empty = successResult('')

    // Act
    printer.printAtTurnEnd(empty, undefined)
    printer.printAtExit(empty, undefined)

    // Assert — v294-parity: the empty final result still gets its '\n' at
    // exit because printedCount===0 short-circuits the vT skip.
    expect(stdoutWrites).toEqual(['\n'])
  })

  test('empty success result suppressed at exit when another result already printed', () => {
    // Arrange
    const printer = new PrintTextResults(LIMITS)
    const r1 = successResult('kept')
    const empty = successResult('   ')

    // Act
    printer.printAtTurnEnd(r1, undefined)
    printer.printAtExit(empty, undefined)

    // Assert — printedCount>0 && vT(empty) → no second print, no telemetry.
    expect(stdoutWrites).toEqual(['kept\n'])
    expect(printer.printedCount).toBe(1)
    expect(events).toEqual([])
  })

  test('error subtype texts match official v295 print() switch', () => {
    // error_max_turns interpolates limits.maxTurns
    const p1 = new PrintTextResults(LIMITS)
    p1.printAtExit(errorResult('error_max_turns'), undefined)
    expect(stdoutWrites[0]).toBe('Error: Reached max turns (5)')

    // error_max_budget_usd interpolates limits.maxBudgetUsd
    stdoutWrites.length = 0
    const p2 = new PrintTextResults(LIMITS)
    p2.printAtExit(errorResult('error_max_budget_usd'), undefined)
    expect(stdoutWrites[0]).toBe('Error: Exceeded USD budget (1.5)')

    // error_during_execution — official v295 additionally drains the BGn()
    // autoModeUnavailableStopNotice latch to stderr; unported in OCC (no-op).
    stdoutWrites.length = 0
    const p3 = new PrintTextResults(LIMITS)
    p3.printAtExit(errorResult('error_during_execution'), undefined)
    expect(stdoutWrites[0]).toBe('Execution error')

    // error_max_structured_output_retries — v295 added `errors[0]??` prefix.
    stdoutWrites.length = 0
    const p4 = new PrintTextResults(LIMITS)
    p4.printAtExit(
      errorResult('error_max_structured_output_retries', {
        errors: ['Invalid schema at $.field'],
      }),
      undefined
    )
    expect(stdoutWrites[0]).toBe('Error: Invalid schema at $.field')

    stdoutWrites.length = 0
    const p5 = new PrintTextResults(LIMITS)
    p5.printAtExit(
      errorResult('error_max_structured_output_retries', { errors: [] }),
      undefined
    )
    expect(stdoutWrites[0]).toBe(
      'Error: Failed to provide valid structured output after maximum retries'
    )
  })

  test('separator is blank line when previous print did not end with newline', () => {
    // Arrange — error texts have no trailing '\n' (official), so endsWithNewline
    // is false and the next print is prefixed with '\n\n'.
    const printer = new PrintTextResults(LIMITS)

    // Act
    printer.printAtTurnEnd(errorResult('error_max_turns'), undefined)
    printer.printAtTurnEnd(successResult('Done'), undefined)

    // Assert
    expect(stdoutWrites).toEqual([
      'Error: Reached max turns (5)',
      '\n\nDone\n',
    ])
    expect(printer.endsWithNewline).toBe(true)
  })

  test('printAtExit emits results_printed telemetry when more than one result printed', () => {
    // Arrange
    const printer = new PrintTextResults(LIMITS)
    const r1 = successResult('one')
    const r2 = successResult('two')
    const r3 = successResult('three')

    // Act
    printer.printAtTurnEnd(r1, undefined)
    printer.printAtTurnEnd(r2, undefined)
    printer.printAtExit(r3, undefined)

    // Assert — official: `if(this.printedCount>1)g("print_text_results",
    // {results_printed:this.printedCount})`
    expect(stdoutWrites).toEqual(['one\n', '\ntwo\n', '\nthree\n'])
    expect(events).toEqual([
      { name: 'print_text_results', metadata: { results_printed: 3 } },
    ])
  })

  test('printAtTurnEnd swallows write failures and logs print_failed (official catch)', () => {
    // Arrange — official: `catch(r){c(r),m("print_text_results","print_failed")}`
    // (captureError has no OCC surface; m() → logEvent stage mapping per
    // ultrareview.ts precedent).
    throwOnWrite = true
    const printer = new PrintTextResults(LIMITS)

    // Act / Assert — must not throw out of the drain loop
    expect(() =>
      printer.printAtTurnEnd(successResult('boom'), undefined)
    ).not.toThrow()
    expect(events).toEqual([
      { name: 'print_text_results', metadata: { stage: 'print_failed' } },
    ])
    // Failed print did not advance printer state (official comma-expression
    // order: Ar() throws before lastPrinted/printedCount updates).
    expect(printer.printedCount).toBe(0)
    expect(printer.lastPrinted).toBeUndefined()
  })

  test('partialForResult prefix: partial + newline + result (official n!==void 0 branch)', () => {
    // OCC callers currently always pass undefined (tracker unported, identical
    // v294↔v295 — pre-existing gap), but the printer must keep the official
    // prefix branch byte-faithful for when the tracker lands.
    const printer = new PrintTextResults(LIMITS)
    printer.printAtTurnEnd(successResult('world'), 'hello')
    expect(stdoutWrites).toEqual(['hello\nworld\n'])
  })

  test('isEmptySuccessResult matches official vT truth table', () => {
    // v295: `e.subtype==="success"&&n===void 0&&e.result.trim()===""`
    expect(isEmptySuccessResult(successResult('  '), undefined)).toBe(true)
    expect(isEmptySuccessResult(successResult(''), undefined)).toBe(true)
    expect(isEmptySuccessResult(successResult('x'), undefined)).toBe(false)
    // partial prefix present → not "empty" even when result is blank
    expect(isEmptySuccessResult(successResult(''), 'partial')).toBe(false)
    // non-success subtypes are never "empty"
    expect(isEmptySuccessResult(errorResult('error_max_turns'), undefined)).toBe(
      false
    )
  })
})

// E-9/P2: restore every module-level mock.module() so the shared-process
// `bun test` run does not leak these fakes into later test files. Bun's
// mock.restore() does NOT undo mock.module — re-mock with the load-time real
// snapshots (same pattern as headlessCostRestore277.test.ts).
afterAll(() => {
  mock.module('../../utils/process.js', () => ({ ...realProcess }))
  mock.module('../../services/analytics/index.js', () => ({ ...realAnalytics }))
  mock.module('../../services/analytics/growthbook.js', () => ({
    ...realGrowthbook,
  }))
})
