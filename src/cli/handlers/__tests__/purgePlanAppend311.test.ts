import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { PurgeItem } from '../projectPurge.js'
import { printPlan } from '../projectPurge.js'

/**
 * CC 2.1.311 item 76 (WP30) — `claude purge` plan appends the data-locality
 * disclaimer. Official `ne` (binary @128068013 / @269429458) ends the plan
 * print with `P(`\nPurging deletes data only on this computer, not anything
 * stored by Anthropic.`)` — verbatim. v310 OCC `printPlan` stopped after the
 * items/warnings and never emitted the disclaimer. This pins the verbatim
 * string and that it follows the plan.
 */

const APPEND_TEXT =
  'Purging deletes data only on this computer, not anything stored by Anthropic.'

describe('CC 2.1.311 item 76 — purge plan appends the data-locality disclaimer', () => {
  let logSpy: ReturnType<typeof spyOn>
  let logCalls: string[]

  beforeEach(() => {
    logCalls = []
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logCalls.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
      return undefined
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  test('appends the verbatim disclaimer after a non-empty plan', () => {
    const items: PurgeItem[] = [{ kind: 'dir', path: '/home/u/.claude/projects/x' }]
    printPlan('myproj', items, [])

    const joined = logCalls.join('\n')
    expect(joined).toContain('Purge plan for myproj')
    expect(joined).toContain(APPEND_TEXT)
    // The disclaimer is the LAST line printed (it trails the plan).
    expect(logCalls[logCalls.length - 1]).toContain(APPEND_TEXT)
  })

  test('appends the disclaimer even when warnings are present', () => {
    const items: PurgeItem[] = [{ kind: 'config-key', path: 'config: projects["/p"]', configKey: '/p' }]
    printPlan('/p', items, ['transcript dir missing'])

    const joined = logCalls.join('\n')
    expect(joined).toContain('warning: transcript dir missing')
    expect(joined).toContain(APPEND_TEXT)
    expect(logCalls[logCalls.length - 1]).toContain(APPEND_TEXT)
  })

  test('the disclaimer text is byte-exact (no typo / rewording)', () => {
    printPlan('x', [{ kind: 'dir', path: '/d' }], [])
    // Exact-match against the official string, not a substring guess.
    expect(
      logCalls.some(c => c.replace(/^\n+/, '') === APPEND_TEXT),
    ).toBe(true)
  })
})
