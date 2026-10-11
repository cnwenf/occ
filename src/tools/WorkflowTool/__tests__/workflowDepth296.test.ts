import { describe, expect, test } from 'bun:test'
import {
  PRETTY_BLOWUP_MULTIPLIER,
  PRETTY_INDENT,
  prettyPrintFits,
} from '../prettyFits.js'
// Init-order guard: preload the app-state module graph so src/tools.ts's
// lazy WorkflowTool require completes BEFORE the test's direct ESM import
// (same cycle-break the pre-split file got via its scriptLoader import).
import 'src/state/AppStateStore.js'
import { type Output, WorkflowTool } from '../WorkflowTool.js'

/**
 * Claude Code 2.1.296 (OCC-154 #023):
 *
 * #023 — changelog entry 23: "Fixed workflow scripts silently truncating
 * results, agent options and other values nested deeper than about 20,000
 * levels, and deeply nested results writing huge task output files."
 * Official v296 (ELF md5 3c8749470f70a26efadf982b587e1548) replaced the
 * unconditional pretty writer `Hjr` (v295: `_(…,null,2)`) with `ajr`
 * @225609040: `c=_(d); Hps(c,2,c.length*z) ? _(d,null,2) : c` — a cheap
 * pretty-size ESTIMATOR (`Hps` + string-skipper `R`, verbatim @215076527)
 * gating indent-2 expansion at `z=8` × compact length (`var D=500,z=8`
 * @225605959). Empirically on Bun: a 20k-deep nested array serializes to
 * ~40 KB compact but ~800 MB at indent 2. The truncation half of entry 23
 * (recursive VM-boundary walkers → iterative `ws()`) is N/A for OCC —
 * OCC's node:vm sandbox shares the heap (no boundary copy walker) and its
 * recursive paths fail loudly (see ledger §7.6).
 *
 */

// WorkflowTool's import graph reads MACRO.VERSION (bundled-skills root probe);
// mirror the cli.tsx polyfill like scriptPathGate251.test.ts does.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/** Iteratively build a depth-`depth` nested array: [[[…]]] (no recursion). */
function makeDeepArray(depth: number): unknown[] {
  let current: unknown[] = []
  for (let i = 0; i < depth; i++) {
    current = [current]
  }
  return current
}

function mapResult(result: unknown): string {
  const data = {
    result,
    agentCount: 1,
    logs: [],
    failures: [],
    durationMs: 5,
  } as Output
  const block = WorkflowTool.mapToolResultToToolResultBlockParam(
    data,
    'toolu_depth296',
  )
  const content = block.content as Array<{ type: 'text'; text: string }>
  return content[0]!.text
}

// ── #023: Hps estimator (prettyPrintFits) ──

describe('2.1.296 #023: prettyPrintFits estimator (official Hps verbatim)', () => {
  test('exposes the official constants (z=8 blowup multiplier, indent 2)', () => {
    expect(PRETTY_BLOWUP_MULTIPLIER).toBe(8)
    expect(PRETTY_INDENT).toBe(2)
  })

  test('estimates {"a":1} pretty length exactly at 12 (hand-computed)', () => {
    // Pretty form is `{\n  "a": 1\n}` — 12 chars. Hps adds 1+i*depth per
    // bracket/comma at current depth, 1 per colon; the estimate is EXACT for
    // objects whose strings/numbers carry no surprises.
    const compact = '{"a":1}'
    expect(JSON.stringify({ a: 1 }, null, 2).length).toBe(12)
    expect(prettyPrintFits(compact, 2, 12)).toBe(true)
    expect(prettyPrintFits(compact, 2, 11)).toBe(false)
  })

  test('empty containers add nothing (official next-char skip)', () => {
    // `[[],{}]` pretty: `[\n  [],\n  {}\n]` = 14 chars; the `[]`/`{}` pairs
    // hit the charCodeAt(o+1)===93/125 skip, only the comma pays 1+i*r.
    const compact = '[[],{}]'
    expect(JSON.stringify([[], {}], null, 2).length).toBe(14)
    expect(prettyPrintFits(compact, 2, 14)).toBe(true)
    expect(prettyPrintFits(compact, 2, 13)).toBe(false)
  })

  test('skips bracket/comma/colon characters INSIDE strings', () => {
    const value = { k: '[,:{}]' }
    const compact = JSON.stringify(value)
    const prettyLength = JSON.stringify(value, null, 2).length
    expect(compact).toBe('{"k":"[,:{}]"}')
    expect(prettyLength).toBe(19)
    expect(prettyPrintFits(compact, 2, prettyLength)).toBe(true)
    expect(prettyPrintFits(compact, 2, prettyLength - 1)).toBe(false)
  })

  test('skips escaped quotes inside strings (official R backslash parity)', () => {
    const value = { k: 'a"b' }
    const compact = JSON.stringify(value) // {"k":"a\"b"}
    const prettyLength = JSON.stringify(value, null, 2).length
    expect(compact).toBe('{"k":"a\\"b"}')
    // R walks to the NEXT quote and counts preceding backslashes; an odd
    // count means the quote is escaped and the scan continues.
    expect(prettyPrintFits(compact, 2, prettyLength)).toBe(true)
    expect(prettyPrintFits(compact, 2, prettyLength - 1)).toBe(false)
  })

  test('returns false for a 20k-deep compact string at the official budget', () => {
    const compact = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
    expect(prettyPrintFits(compact, 2, compact.length * 8)).toBe(false)
  })

  test('returns true for shallow payloads at the official budget', () => {
    const compact = JSON.stringify({ ok: true, items: [1, 2, 3] })
    expect(prettyPrintFits(compact, 2, compact.length * 8)).toBe(true)
  })
})

// ── #023: WorkflowTool.ts mapper gate (official ajr shape) ──

describe('2.1.296 #023: workflow result mapper pretty-print gate', () => {
  test('shallow object results stay pretty-printed at indent 2', () => {
    const result = { ok: true, items: [1, 2, 3] }
    const text = mapResult(result)
    expect(text).toContain(JSON.stringify(result, null, 2))
  })

  test('string results pass through without re-serialization', () => {
    const text = mapResult('plain "string" result')
    expect(text).toContain('Result:\nplain "string" result')
  })

  test('20k-deep results fall back to compact — bounded text, no 800 MB blowup', () => {
    // Arrange: depth 20,000 is the changelog's cited blowup point — Bun's
    // indent-2 stringify of this shape produces ~800 MB (verified
    // empirically during forensics) while compact is ~40 KB.
    const deep = makeDeepArray(20_000)
    const compact = JSON.stringify(deep)

    // Act
    const text = mapResult(deep)

    // Assert: the mapper must not expand — text stays within a small
    // multiple of the compact form and contains it verbatim.
    expect(text).toContain(compact)
    expect(text.length).toBeLessThan(compact.length * 4)
  })

  test('non-serializable top-level result keeps the pre-296 "undefined" text', () => {
    // JSON.stringify(undefined) === undefined. The official ajr has no
    // undefined guard (it would crash on c.length), but the official payload
    // is always an object literal — OCC's payload can be undefined, so the
    // gate preserves OCC's prior template-literal output instead of
    // crashing. Documented micro-divergence, ledger §7.6.
    const text = mapResult(undefined)
    expect(text).toContain('Result:\nundefined')
  })
})
