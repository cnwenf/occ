import { describe, expect, spyOn, test } from 'bun:test'
import {
  formatSecurityWarningRow,
  resolveStartupWarningChannel,
  routeStartupPermissionWarnings,
  sanitizeWarningText,
} from '../startupSecurityWarnings.js'

/**
 * CC 2.1.305 — startup permission-warning routing (the "warnings go to the
 * debug log instead of raw text above the logo" fix). All shapes byte-verified
 * against the v306 binary: `fd` @238646126, `vn` @237692316, `Zo` @257109508,
 * `UB` @242376611, `cz` @257109508, emission gate @257152404.
 */

describe('resolveStartupWarningChannel — official emission gate', () => {
  test('interactive TTY → debug-log regardless of output format', () => {
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: false,
        outputFormat: undefined,
        sessionKind: undefined,
      }),
    ).toBe('debug-log')
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: false,
        outputFormat: 'json',
        sessionKind: undefined,
      }),
    ).toBe('debug-log')
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: false,
        outputFormat: 'stream-json',
        sessionKind: 'bg',
      }),
    ).toBe('debug-log')
  })

  test('headless print-text → stderr', () => {
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: undefined,
        sessionKind: undefined,
      }),
    ).toBe('stderr')
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: 'text',
        sessionKind: undefined,
      }),
    ).toBe('stderr')
  })

  test('headless json/stream-json → permissions-debug-log', () => {
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: 'json',
        sessionKind: undefined,
      }),
    ).toBe('permissions-debug-log')
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: 'stream-json',
        sessionKind: undefined,
      }),
    ).toBe('permissions-debug-log')
  })

  test('bg session kind → permissions-debug-log even for print-text', () => {
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: 'text',
        sessionKind: 'bg',
      }),
    ).toBe('permissions-debug-log')
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: undefined,
        sessionKind: 'bg',
      }),
    ).toBe('permissions-debug-log')
  })

  test('non-bg session kind does not divert print-text', () => {
    expect(
      resolveStartupWarningChannel({
        isNonInteractiveSession: true,
        outputFormat: 'text',
        sessionKind: 'fg',
      }),
    ).toBe('stderr')
  })
})

describe('sanitizeWarningText — official fd', () => {
  test('strips ANSI escapes', () => {
    expect(sanitizeWarningText('\u001b[31mred\u001b[39m text')).toBe('red text')
  })

  test('keeps \\t and \\n, drops other control/format chars', () => {
    expect(sanitizeWarningText('a\u0000b\tc\nd')).toBe('ab\tc\nd')
    expect(sanitizeWarningText('a\u200bb')).toBe('ab')
    expect(sanitizeWarningText('a\u2028b\u2029c')).toBe('abc')
  })
})

describe('formatSecurityWarningRow — official Zo', () => {
  test('strips ANSI, collapses control runs to single spaces, trims', () => {
    expect(formatSecurityWarningRow('  \u001b[33mx\u001b[39m\ny\tz  ')).toBe(
      'x y z',
    )
  })

  test('drops NUL before collapsing (fd runs first)', () => {
    expect(formatSecurityWarningRow('a\u0000b')).toBe('ab')
  })

  test('already-clean single line is unchanged', () => {
    expect(
      formatSecurityWarningRow('Deny rule Glob(path:src/**) never matches'),
    ).toBe('Deny rule Glob(path:src/**) never matches')
  })
})

describe('routeStartupPermissionWarnings — official emission site', () => {
  test('headless print-text writes each warning to stderr and returns banner rows', () => {
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )
    try {
      const rows = routeStartupPermissionWarnings({
        warnings: ['line one', 'line\ntwo'],
        securityWarnings: ['Deny rule X never matches'],
        isNonInteractiveSession: true,
        outputFormat: 'text',
        sessionKind: undefined,
      })
      expect(writeSpy).toHaveBeenCalledTimes(2)
      const first = String(writeSpy.mock.calls[0]?.[0])
      expect(first).toContain('line one')
      expect(first.endsWith('\n')).toBe(true)
      const second = String(writeSpy.mock.calls[1]?.[0])
      // Zo collapses the newline to a single space.
      expect(second).toContain('line two')
      expect(rows).toEqual(['Deny rule X never matches'])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('interactive writes nothing to stderr (debug-log channel) and returns banner rows', () => {
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )
    try {
      const rows = routeStartupPermissionWarnings({
        warnings: ['should not hit stderr'],
        securityWarnings: ['Ask rule Y matches no tool · check for typos'],
        isNonInteractiveSession: false,
        outputFormat: undefined,
        sessionKind: undefined,
      })
      expect(writeSpy).toHaveBeenCalledTimes(0)
      expect(rows).toEqual(['Ask rule Y matches no tool · check for typos'])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('json/stream-json/bg routes to permissions debug-log: no stderr, empty banner rows', () => {
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )
    try {
      const rows = routeStartupPermissionWarnings({
        warnings: ['json mode warning'],
        securityWarnings: ['Deny rule Z never matches'],
        isNonInteractiveSession: true,
        outputFormat: 'stream-json',
        sessionKind: undefined,
      })
      expect(writeSpy).toHaveBeenCalledTimes(0)
      // The official only pushes `rs` banner rows in the first branch.
      expect(rows).toEqual([])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('banner rows are formatted and deduped (official D(…map(Zo)))', () => {
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )
    try {
      const rows = routeStartupPermissionWarnings({
        warnings: [],
        securityWarnings: [
          'Deny rule A never matches',
          'Deny rule A never matches',
          '  Deny rule\nB never matches  ',
        ],
        isNonInteractiveSession: true,
        outputFormat: 'text',
        sessionKind: undefined,
      })
      expect(rows).toEqual([
        'Deny rule A never matches',
        'Deny rule B never matches',
      ])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('empty inputs produce no output and no writes', () => {
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    )
    try {
      const rows = routeStartupPermissionWarnings({
        warnings: [],
        securityWarnings: [],
        isNonInteractiveSession: false,
        outputFormat: undefined,
        sessionKind: undefined,
      })
      expect(rows).toEqual([])
      expect(writeSpy).toHaveBeenCalledTimes(0)
    } finally {
      writeSpy.mockRestore()
    }
  })
})
