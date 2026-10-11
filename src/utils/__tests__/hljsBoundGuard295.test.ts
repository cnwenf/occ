import { describe, expect, test } from 'bun:test'
import { HighlightBoundError, installHighlightBounds } from '../hljsBound.js'
import { HighlightLimitError } from '../hljsLimit.js'

/**
 * OCC-154 fix-round C-item t-04 — installHighlightBounds dual-guard wiring
 * (CC 2.1.289 #2 budget guard + CC 2.1.295 #091 Layer A limit guard).
 *
 * Why this file exists: the 验收员 t-04 mutation recipes showed the INSTALL
 * wiring in hljsBound.ts was uncovered —
 *   M-A: disable the long-line/limit guard install (drop the
 *        `hljs.addPlugin(makeHighlightLimitPlugin(hljs))` line) → existing
 *        suites stay green (hljsBound289's deep-nesting test accepts a weak
 *        value|Bound|Limit disjunction).
 *   M-B: remove the `'isBounded' in ctor` early-return guard → existing
 *        idempotency test only compares highlight OUTPUT, which duplicate
 *        plugins don't change.
 * This suite pins the guards exactly:
 *   1. A 55,000-char catastrophic `'${` input MUST throw
 *      HighlightLimitError (not merely "some guard error") through the
 *      full installed stack — under M-A the limit plugin is absent and the
 *      input either succeeds or trips HighlightBoundError instead → RED.
 *   2. The wrapped emitter class carries the `static isBounded` marker, the
 *      first install adds exactly 2 plugins (limit + budget), and a second
 *      install is a true no-op (0 further addPlugin calls, identical
 *      emitter ctor) — under M-B the re-install stacks a duplicate limit
 *      plugin → RED.
 *   3. Control: an under-cap multi-line variant of the same catastrophic
 *      content completes without throwing (guards don't over-fire).
 *
 * Mutation-verify results (this round): M-A → tests 1+2+control RED…
 * see commit message for the exact fail matrix.
 */

type HljsInst = {
  highlight(
    code: string,
    opts?: { language?: string; ignoreIllegals?: boolean },
  ): { value: string }
  highlightAuto(code: string, subset?: string[]): {
    _emitter?: { constructor?: unknown }
    emitter?: { constructor?: unknown }
  }
  addPlugin(plugin: Record<string, unknown>): void
  configure(options: Record<string, unknown>): void
}

async function freshHljs(languages: string[]): Promise<HljsInst> {
  const full = (await import('highlight.js')).default as unknown as {
    newInstance: () => HljsInst
  }
  const inst = full.newInstance()
  for (const name of languages) {
    const mod = (await import(`highlight.js/lib/languages/${name}`)) as {
      default: unknown
    }
    ;(inst as unknown as { registerLanguage: (n: string, g: unknown) => void })
      .registerLanguage(name, mod.default)
  }
  return inst
}

const GUARD_LANGS = ['xml', 'javascript', 'handlebars']

describe('hljsBound install wiring — Layer A limit guard (t-04 M-A target)', () => {
  test('55000-char catastrophic ${ input throws HighlightLimitError exactly', async () => {
    const inst = await freshHljs(GUARD_LANGS)
    installHighlightBounds(inst as never)
    // 验收员 probe input: 18333 × `'${` (54999) + trailing `'` = 55000 chars,
    // over the 50000 default cap → the before:highlight limit plugin must
    // reject it BEFORE any emitter work.
    const code = '\'${'.repeat(18333) + "'"
    expect(code.length).toBe(55_000)
    const t0 = Date.now()
    // M-A RED point: without the limit plugin this does NOT throw
    // HighlightLimitError (it succeeds or trips the budget guard instead).
    expect(() =>
      inst.highlight(code, { language: 'javascript', ignoreIllegals: true }),
    ).toThrow(HighlightLimitError)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  test('control: under-cap multi-line ${ content completes without throwing', async () => {
    const inst = await freshHljs(GUARD_LANGS)
    installHighlightBounds(inst as never)
    // 192 lines × 250 chars + 191 newlines = 48191 ≤ 50000, every token
    // ≤ 256 chars → long-line excess 0 → Layer A passes; emitter budget is
    // ample for plain string text → no throw. Pins that the guards don't
    // over-fire (and that the 55000 rejection above is length-driven).
    const code = Array.from({ length: 192 }, () => '\'${'.repeat(83) + "'").join(
      '\n',
    )
    expect(code.length).toBeLessThanOrEqual(50_000)
    expect(() =>
      inst.highlight(code, { language: 'javascript', ignoreIllegals: true }),
    ).not.toThrow()
  })
})

describe('hljsBound install wiring — isBounded early-return guard (t-04 M-B target)', () => {
  test('static isBounded marker + exactly 2 plugins + re-install is a no-op', async () => {
    const inst = await freshHljs(GUARD_LANGS)
    let added = 0
    const rawAddPlugin = inst.addPlugin.bind(inst)
    inst.addPlugin = (plugin: Record<string, unknown>) => {
      added += 1
      rawAddPlugin(plugin)
    }

    installHighlightBounds(inst as never)
    // First install: Layer A limit plugin + budget plugin, in that order.
    expect(added).toBe(2)

    // The 验收员 assertion: the swapped-in emitter class carries the
    // `static isBounded` marker (official `te`/`ne` idempotency contract).
    const probe = inst.highlightAuto('', [])
    const ctor = (probe._emitter ?? probe.emitter)?.constructor as
      | { isBounded?: boolean }
      | undefined
    expect(ctor).toBeDefined()
    expect(ctor?.isBounded).toBe(true)

    // M-B RED point: removing the `'isBounded' in ctor` early return makes
    // the second install stack a duplicate limit plugin (added → 3) and can
    // re-wrap the emitter (ctor identity change).
    installHighlightBounds(inst as never)
    expect(added).toBe(2)
    const probe2 = inst.highlightAuto('', [])
    const ctor2 = (probe2._emitter ?? probe2.emitter)?.constructor
    expect(ctor2).toBe(ctor)
  })

  test('budget guard still trips HighlightBoundError on the <script> cascade', async () => {
    // Companion pin for the v289 half of the dual guard through the same
    // install path: Layer A passes (short input, no long lines) but the
    // unclosed-<script> grammar cascade exhausts the emitter budget.
    const inst = await freshHljs(GUARD_LANGS)
    installHighlightBounds(inst as never)
    const code = '<script>'.repeat(24)
    expect(code.length).toBeLessThan(8_000) // Layer A fast path: passes
    const t0 = Date.now()
    expect(() =>
      inst.highlight(code, { language: 'xml', ignoreIllegals: true }),
    ).toThrow(HighlightBoundError)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})
