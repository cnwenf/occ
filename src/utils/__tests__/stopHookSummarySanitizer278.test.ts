/**
 * CC 2.1.278 (ITEM D12) — stop-hook summary Zod sanitizer (official
 * `s$e`/`T5e`/`XG`/`HEe`, v277 binary @202102832, byte-verified) applied at
 * the fold sites (collapseHookSummaries.ts, collapseReadSearch.ts) and the
 * renderer (SystemTextMessage.tsx `StopHookSummaryMessage`).
 *
 * Changelog: "Fixed a crash when resuming a session whose saved history
 * contains a stop-hook summary without a well-formed hook list."
 *
 * Covers (task spec):
 * - malformed/missing hook list renders (contract level: sanitizer never
 *   throws and always yields array/number/boolean fields the renderer reads)
 * - well-formed summaries pass through unchanged (same-reference fast path —
 *   official HEe, keeps React memo stability)
 * - labeled-summary fold: malformed members can't poison the merged summary;
 *   a non-string hookLabel row is treated as unlabeled (official Xot)
 * - PreToolUse absorb fold contract (collapseReadSearch destructures
 *   {hookCount, hookInfos, totalDurationMs} from the sanitizer)
 */
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { RenderableMessage } from '../../types/message.js'
import { collapseHookSummaries } from '../collapseHookSummaries.js'
import {
  filterBySchema,
  sanitizeHookLabel,
  sanitizeStopHookSummary,
} from '../stopHookSummarySanitizer.js'
import { z } from 'zod'

function summary(fields: Record<string, unknown>): RenderableMessage {
  return {
    type: 'system',
    subtype: 'stop_hook_summary',
    uuid: randomUUID(),
    ...fields,
  } as unknown as RenderableMessage
}

describe('D12: sanitizeStopHookSummary (official s$e)', () => {
  test('well-formed summary: every field survives, hookInfos keeps the SAME reference', () => {
    const hookInfos = [
      { command: 'npm test', durationMs: 1200 },
      { command: 'lint', promptText: 'p', durationMs: 300 },
    ]
    const message = {
      hookCount: 2,
      hookInfos,
      hookErrors: ['err one'],
      hookAdditionalContext: ['ctx'],
      preventedContinuation: true,
      stopReason: 'stopped by hook',
      hookLabel: 'Stop',
      totalDurationMs: 1500,
    }
    const result = sanitizeStopHookSummary(message)
    expect(result.hookCount).toBe(2)
    // Official HEe fast path: every entry passes → the ORIGINAL array ref.
    expect(result.hookInfos).toBe(hookInfos)
    expect(result.hookInfos[0]).toBe(hookInfos[0])
    expect(result.hookErrors).toEqual(['err one'])
    expect(result.hookAdditionalContext).toEqual(['ctx'])
    expect(result.preventedContinuation).toBe(true)
    expect(result.stopReason).toBe('stopped by hook')
    expect(result.hookLabel).toBe('Stop')
    expect(result.totalDurationMs).toBe(1500)
  })

  test('malformed/missing hook list: safe defaults instead of throwing', () => {
    const result = sanitizeStopHookSummary({
      hookCount: -5,
      hookInfos: 'not-an-array',
      hookErrors: null,
      hookLabel: 42,
      preventedContinuation: 'yes',
      stopReason: 7,
      totalDurationMs: '100',
      hookAdditionalContext: 'nope',
    })
    expect(result.hookInfos).toEqual([])
    // hookCount fails z.number().int().nonnegative() → falls back to the
    // sanitized hookInfos length.
    expect(result.hookCount).toBe(0)
    expect(result.hookErrors).toEqual([])
    expect('hookLabel' in result).toBe(false)
    expect(result.preventedContinuation).toBe(false)
    expect('stopReason' in result).toBe(false)
    expect('totalDurationMs' in result).toBe(false)
    expect('hookAdditionalContext' in result).toBe(false)
  })

  test('empty input object: renderer-consumed fields are always present and safe', () => {
    const result = sanitizeStopHookSummary({})
    expect(result.hookCount).toBe(0)
    expect(result.hookInfos).toEqual([])
    expect(result.hookErrors).toEqual([])
    expect(result.preventedContinuation).toBe(false)
  })

  test('hookErrors filtered to strings only', () => {
    const result = sanitizeStopHookSummary({ hookErrors: [1, 'a', null, 'b'] })
    expect(result.hookErrors).toEqual(['a', 'b'])
  })

  test('hookInfos filtered to schema entries, keeping ORIGINAL references', () => {
    const good = { command: 'x', durationMs: 5 }
    const goodNoDuration = { command: 'y' }
    const bad = { nope: true }
    const badCommand = { command: 42 }
    const result = sanitizeStopHookSummary({
      hookInfos: [good, bad, goodNoDuration, badCommand],
    })
    expect(result.hookInfos).toEqual([good, goodNoDuration])
    expect(result.hookInfos[0]).toBe(good)
    expect(result.hookInfos[1]).toBe(goodNoDuration)
    // hookCount missing → falls back to the SANITIZED length, not raw.
    expect(result.hookCount).toBe(2)
  })

  test('hookAdditionalContext: included only for array input, filtered to strings', () => {
    expect(sanitizeStopHookSummary({ hookAdditionalContext: ['a', 2] }).hookAdditionalContext).toEqual(['a'])
    expect(
      'hookAdditionalContext' in sanitizeStopHookSummary({ hookAdditionalContext: 'x' }),
    ).toBe(false)
  })

  test('junk inputs never throw (renderer/fold contract)', () => {
    const junkInputs: unknown[] = [
      {},
      { hookInfos: 0, hookErrors: 'x', hookCount: 'NaN' },
      { hookInfos: [null, undefined, 1, [], {}], hookCount: 1.5 },
      { hookLabel: '', hookErrors: [{}], preventedContinuation: 1 },
      { hookInfos: [{ command: 'a', durationMs: 'slow' }] },
      { totalDurationMs: Number.NaN, stopReason: null },
    ]
    for (const junk of junkInputs) {
      let result!: ReturnType<typeof sanitizeStopHookSummary>
      expect(() => {
        result = sanitizeStopHookSummary(junk as never)
      }).not.toThrow()
      // The renderer does hookErrors.length / hookInfos.reduce / hookCount
      // arithmetic unconditionally — these must always be safe.
      expect(Array.isArray(result.hookErrors)).toBe(true)
      expect(Array.isArray(result.hookInfos)).toBe(true)
      expect(typeof result.hookCount).toBe('number')
      expect(typeof result.preventedContinuation).toBe('boolean')
    }
  })
})

describe('D12: sanitizeHookLabel (official T5e — z.string().min(1))', () => {
  test('non-empty string label survives; everything else is undefined', () => {
    expect(sanitizeHookLabel({ hookLabel: 'PostToolUse' })).toBe('PostToolUse')
    expect(sanitizeHookLabel({ hookLabel: '' })).toBeUndefined()
    expect(sanitizeHookLabel({ hookLabel: 42 })).toBeUndefined()
    expect(sanitizeHookLabel({ hookLabel: null })).toBeUndefined()
    expect(sanitizeHookLabel({})).toBeUndefined()
  })
})

describe('D12: filterBySchema (official HEe)', () => {
  const schema = z.string()
  test('non-array → []; all-valid → SAME reference; partial → filtered copy', () => {
    expect(filterBySchema('nope', schema)).toEqual([])
    expect(filterBySchema(undefined, schema)).toEqual([])
    const allValid = ['a', 'b']
    expect(filterBySchema(allValid, schema)).toBe(allValid)
    expect(filterBySchema(['a', 1, 'b'], schema)).toEqual(['a', 'b'])
  })
})

describe('D12: collapseHookSummaries fold (official Xot/lwe sites)', () => {
  test('a malformed hookLabel row is treated as UNLABELED and passes through unchanged', () => {
    const malformed = summary({
      hookLabel: 42,
      hookCount: 1,
      hookInfos: [{ command: 'x' }],
      hookErrors: [],
    })
    const result = collapseHookSummaries([malformed])
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(malformed)
  })

  test('well-formed single labeled row passes through by reference', () => {
    const lone = summary({
      hookLabel: 'PostToolUse',
      hookCount: 1,
      hookInfos: [{ command: 'x', durationMs: 10 }],
      hookErrors: [],
      totalDurationMs: 10,
    })
    const result = collapseHookSummaries([lone])
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(lone)
  })

  test('merging well-formed labeled rows is unchanged by the sanitizer', () => {
    const a = summary({
      hookLabel: 'PostToolUse',
      hookCount: 2,
      hookInfos: [{ command: 'a', durationMs: 100 }],
      hookErrors: [],
      totalDurationMs: 100,
      hasOutput: false,
    })
    const b = summary({
      hookLabel: 'PostToolUse',
      hookCount: 1,
      hookInfos: [{ command: 'b', durationMs: 250 }],
      hookErrors: ['warn'],
      totalDurationMs: 250,
      hasOutput: true,
    })
    const result = collapseHookSummaries([a, b])
    expect(result).toHaveLength(1)
    const merged = result[0] as unknown as Record<string, unknown>
    expect(merged.hookCount).toBe(3)
    expect(merged.hookInfos).toEqual([
      { command: 'a', durationMs: 100 },
      { command: 'b', durationMs: 250 },
    ])
    expect(merged.hookErrors).toEqual(['warn'])
    expect(merged.totalDurationMs).toBe(250)
    expect(merged.hasOutput).toBe(true)
    expect(merged.hookLabel).toBe('PostToolUse')
  })

  test('malformed group members cannot poison the merge or throw', () => {
    const good = summary({
      hookLabel: 'Stop',
      hookCount: 1,
      hookInfos: [{ command: 'g', durationMs: 40 }],
      hookErrors: [],
      totalDurationMs: 40,
    })
    const malformed = summary({
      hookLabel: 'Stop',
      hookCount: 'many',
      hookInfos: null,
      hookErrors: [3, 'kept'],
      totalDurationMs: 'slow',
      hasOutput: true,
    })
    let result!: RenderableMessage[]
    expect(() => {
      result = collapseHookSummaries([good, malformed])
    }).not.toThrow()
    expect(result).toHaveLength(1)
    const merged = result[0] as unknown as Record<string, unknown>
    // good.hookCount=1 + malformed sanitized hookCount → hookInfos [].length=0
    expect(merged.hookCount).toBe(1)
    expect(merged.hookInfos).toEqual([{ command: 'g', durationMs: 40 }])
    expect(merged.hookErrors).toEqual(['kept'])
    // malformed.totalDurationMs fails z.number() → undefined → ?? 0 in max.
    expect(merged.totalDurationMs).toBe(40)
    // hasOutput is read from the ORIGINAL rows (official Se.some(Ce.hasOutput)).
    expect(merged.hasOutput).toBe(true)
  })

  test('different sanitized labels do not merge', () => {
    const a = summary({
      hookLabel: 'Stop',
      hookCount: 1,
      hookInfos: [],
      hookErrors: [],
    })
    const b = summary({
      hookLabel: 'PostToolUse',
      hookCount: 1,
      hookInfos: [],
      hookErrors: [],
    })
    const result = collapseHookSummaries([a, b])
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(a)
    expect(result[1]).toBe(b)
  })
})

describe('D12: PreToolUse absorb fold contract (collapseReadSearch site)', () => {
  test('sanitized fields feed the accumulator arithmetic safely', () => {
    // The official fold destructures {hookCount, hookInfos, totalDurationMs}
    // from s$e(Ee) and does:
    //   O.hookCount += Ie
    //   O.hookTotalMs += De ?? Ne.reduce((He,ze)=>He+(ze.durationMs??0),0)
    //   O.hookInfos.push(...Ne)
    // Mirror that arithmetic on a malformed row: no throw, safe numbers.
    const malformed = {
      hookCount: 'many',
      hookInfos: 'junk',
      totalDurationMs: null,
    }
    const group = { hookCount: 0, hookTotalMs: 0, hookInfos: [] as Array<{ durationMs?: number }> }
    expect(() => {
      const { hookCount, hookInfos, totalDurationMs } =
        sanitizeStopHookSummary(malformed)
      group.hookCount += hookCount
      group.hookTotalMs +=
        totalDurationMs ?? hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
      group.hookInfos.push(...hookInfos)
    }).not.toThrow()
    expect(group).toEqual({ hookCount: 0, hookTotalMs: 0, hookInfos: [] })

    // Well-formed row: same arithmetic accumulates real values.
    const { hookCount, hookInfos, totalDurationMs } = sanitizeStopHookSummary({
      hookCount: 2,
      hookInfos: [{ command: 'a', durationMs: 30 }],
      totalDurationMs: 55,
    })
    group.hookCount += hookCount
    group.hookTotalMs +=
      totalDurationMs ?? hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
    group.hookInfos.push(...hookInfos)
    expect(group.hookCount).toBe(2)
    expect(group.hookTotalMs).toBe(55)
    expect(group.hookInfos).toEqual([{ command: 'a', durationMs: 30 }])
  })
})
