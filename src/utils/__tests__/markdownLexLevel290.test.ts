import { describe, expect, spyOn, test } from 'bun:test'
import { marked, type Token } from 'marked'
import {
  applyMarkdown,
  configureMarked,
  MARKDOWN_STACK_FALLBACK_MESSAGE,
} from '../markdown.js'
import {
  createLexLevelGuard,
  flattenNestedMarkdown,
  markdownLexGuard,
  MAX_LEX_NESTING,
} from '../markdownLexLevel.js'

/**
 * CC 2.1.290 cluster E item #1 — markdown lexer depth guard.
 *
 * Official binary evidence (v2.1.290 linux-x64, byte-extracted):
 * - Guard `te()`/`w` @216036381: WeakMap keyed by lexer, cap 100,
 *   `finally` restores the previous level so sibling subtrees each get the
 *   full budget.
 * - Flattener `H` @216036381: per-line `[ \t>]+` prefix collapse
 *   (`t.replace(/[ \t]+/g," ").trimStart()`), `\n{3,}` → `\n\n`, trimEnd.
 * - Extension `z` + fallback `B` @216038583: blockquote/list/emStrong
 *   tokenizers wrapped with `w.lexLevel(this.lexer, ...)`; paragraph/text
 *   tokenizers call `B` which — at cap and when src still looks like a
 *   list/blockquote — returns `{raw, text: H(src), tokens: lexer.inline(H(src))}`.
 * - Render catch: official fallback message (verified byte-exact, em-dash
 *   U+2014): "markdown rendering exceeded the stack — input is too deeply
 *   nested".
 *
 * RED baseline (measured pre-port, Bun 1.3.14 + marked 17.0.5):
 * - bq-20000 (`'>' + '> '.repeat(20000) + 'deep'`) → RangeError: Maximum call
 *   stack size exceeded (~3.4s). bq-5000 does NOT throw on this platform
 *   (JSC stacks are deeper than the official build's) but lexes to depth 5000.
 * - list-500 → 3.1s, list-1000 → 23.8s (marked v17 below-cap quadratic
 *   source scan; the guard cuts list-500 to ~1.2s and caps depth at 100).
 */

const THEME = 'dark' as const

/** Doc 测试计划 fixture (verbatim): 5000-deep blockquote. */
const BQ_5000 = '>' + '> '.repeat(5000) + 'deep'
/** Deeper variant that DOES overflow the stack unguarded on Bun (RED proof). */
const BQ_20000 = '>' + '> '.repeat(20000) + 'deep'
/**
 * Nested-list fixture. DEVIATION from the doc's 5000-deep list: marked v17's
 * list tokenizer has a quadratic source scan BELOW the cap that the official
 * guard cannot fix (measured: 21.7s at 2000 deep WITH the guard — the
 * official 2.1.290 has the same characteristic; it's a marked-version
 * difference, not a port gap). 500 deep keeps the test inside the 10s bunfig
 * timeout while still being RED unguarded (depth 500 ≫ cap 100).
 */
const LIST_500 = Array.from({ length: 500 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')

function nestList(depth: number): string {
  return Array.from({ length: depth }, (_, i) => `${'  '.repeat(i)}- item-${i}`).join('\n')
}

function nestBlockquote(depth: number): string {
  return Array.from({ length: depth }, (_, i) => `${'>'.repeat(i + 1)} quote-${i}`).join('\n')
}

/** Max nesting depth over `blockquote`/`list` containers in a token tree. */
function maxContainerDepth(tokens: Token[]): number {
  let max = 0
  const walk = (toks: Token[] | undefined, depth: number): void => {
    for (const t of toks ?? []) {
      const isContainer = t.type === 'blockquote' || t.type === 'list'
      const next = isContainer ? depth + 1 : depth
      if (isContainer && next > max) max = next
      const withChildren = t as Token & { tokens?: Token[]; items?: Token[] }
      walk(withChildren.tokens, next)
      walk(withChildren.items, next)
    }
  }
  walk(tokens, 0)
  return max
}

/** True when any `text` token's raw holds multiple list lines (B flattening). */
function hasFlattenedListTail(tokens: Token[]): boolean {
  let found = false
  const walk = (toks: Token[] | undefined): void => {
    for (const t of toks ?? []) {
      if (
        t.type === 'text' &&
        t.raw.includes('\n') &&
        (t.raw.match(/^- /gm)?.length ?? 0) >= 2
      ) {
        found = true
      }
      const withChildren = t as Token & { tokens?: Token[]; items?: Token[] }
      walk(withChildren.tokens)
      walk(withChildren.items)
    }
  }
  walk(tokens)
  return found
}

describe('2.1.290 lex-level guard primitives (official te()/H @216036381)', () => {
  test('cap is the official 100', () => {
    expect(MAX_LEX_NESTING).toBe(100)
  })

  test('lexLevel increments, runs the callback, and restores in finally', () => {
    const guard = createLexLevelGuard()
    const lexer = {}
    let observedInner = -1
    const result = guard.lexLevel(lexer, () => {
      observedInner = guard.isAtMaxNesting(lexer) ? 100 : 1
      return 'inner'
    })
    expect(result).toBe('inner')
    expect(observedInner).toBe(1)
    // finally restored the counter — a sibling subtree starts fresh.
    expect(guard.isAtMaxNesting(lexer)).toBe(false)
    expect(
      guard.lexLevel(lexer, () => 'again'),
    ).toBe('again')
  })

  test('at cap: lexLevel returns undefined WITHOUT running the callback', () => {
    const guard = createLexLevelGuard()
    const lexer = {}
    let ran = 0
    let capObservedAtDepth = -1
    let blockedCallbackRan = false
    const recurse = (): void => {
      guard.lexLevel(lexer, () => {
        ran++
        if (guard.isAtMaxNesting(lexer)) {
          capObservedAtDepth = ran
          // At cap, a further lexLevel must NOT run its callback (official:
          // `if(t(n))return;` — check happens BEFORE the increment/run).
          const blocked = guard.lexLevel(lexer, () => {
            blockedCallbackRan = true
            return 'should-not-run'
          })
          expect(blocked).toBeUndefined()
          return
        }
        recurse()
      })
    }
    recurse()
    // Check-then-increment: exactly 100 callbacks run; the 100th sees the cap.
    expect(ran).toBe(MAX_LEX_NESTING)
    expect(capObservedAtDepth).toBe(MAX_LEX_NESTING)
    expect(blockedCallbackRan).toBe(false)
    // finally-restore on unwind: after the recursion the counter is back to 0.
    expect(guard.isAtMaxNesting(lexer)).toBe(false)
    expect(guard.lexLevel(lexer, () => 'ok')).toBe('ok')
  })

  test('counters are per-lexer (WeakMap keyed)', () => {
    const guard = createLexLevelGuard()
    const a = {}
    const b = {}
    // Drive `a` to the cap with real nesting; while a is at the cap, b must
    // be unaffected (separate WeakMap entries). The cap is observable only
    // INSIDE the recursion — finally restores a to 0 on unwind.
    let bUnaffectedWhileAAtCap = false
    const nest = (): void => {
      guard.lexLevel(a, () => {
        if (guard.isAtMaxNesting(a)) {
          bUnaffectedWhileAAtCap = !guard.isAtMaxNesting(b)
          return
        }
        nest()
      })
    }
    nest()
    expect(bUnaffectedWhileAAtCap).toBe(true)
    expect(guard.isAtMaxNesting(a)).toBe(false)
    expect(guard.isAtMaxNesting(b)).toBe(false)
  })

  test('a throwing callback still restores the counter (finally semantics)', () => {
    const guard = createLexLevelGuard()
    const lexer = {}
    expect(() =>
      guard.lexLevel(lexer, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(guard.isAtMaxNesting(lexer)).toBe(false)
    expect(guard.lexLevel(lexer, () => 'ok')).toBe('ok')
  })

  test('singleton guard is exported for configureMarked', () => {
    expect(markdownLexGuard).toBeDefined()
    expect(typeof markdownLexGuard.lexLevel).toBe('function')
    expect(typeof markdownLexGuard.isAtMaxNesting).toBe('function')
  })

  test('flattenNestedMarkdown (official H) matches the verbatim transform', () => {
    // H: per-line [ \t>]+ prefix → collapse [ \t]+ runs to one space then
    // trimStart; \n{3,} → \n\n; trimEnd.
    expect(flattenNestedMarkdown('    - a\n      - b')).toBe('- a\n- b')
    // '>' chars are NOT stripped by H (trimStart can't remove a leading '>'):
    expect(flattenNestedMarkdown('> > deep')).toBe('> > deep')
    expect(flattenNestedMarkdown('  > a')).toBe('> a')
    expect(flattenNestedMarkdown('a\n\n\n\nb')).toBe('a\n\nb')
    expect(flattenNestedMarkdown('a  \n')).toBe('a')
    expect(flattenNestedMarkdown('')).toBe('')
  })
})

describe('2.1.290 guard applied through marked (official z extension @216038583)', () => {
  test('doc fixture: 5000-deep blockquote does not throw and is capped/flattened', () => {
    configureMarked()
    const tokens = marked.lexer(BQ_5000)
    expect(maxContainerDepth(tokens)).toBeLessThanOrEqual(MAX_LEX_NESTING)
    const out = applyMarkdown(BQ_5000, THEME)
    expect(out).toContain('deep')
  })

  test('20000-deep blockquote (unguarded RED: RangeError) does not throw', () => {
    configureMarked()
    expect(() => marked.lexer(BQ_20000)).not.toThrow()
    const out = applyMarkdown(BQ_20000, THEME)
    expect(out).toContain('deep')
  })

  test('500-deep nested list: depth capped at 100 with a flattened tail', () => {
    configureMarked()
    const tokens = marked.lexer(LIST_500)
    expect(maxContainerDepth(tokens)).toBeLessThanOrEqual(MAX_LEX_NESTING)
    expect(hasFlattenedListTail(tokens)).toBe(true)
    expect(() => applyMarkdown(LIST_500, THEME)).not.toThrow()
  })

  test('depth ≤ 100 renders normally (guard invisible below the cap)', () => {
    configureMarked()
    const bq = nestBlockquote(50)
    expect(maxContainerDepth(marked.lexer(bq))).toBe(50)
    expect(applyMarkdown(bq, THEME)).toContain('quote-49')

    const list = nestList(50)
    const tokens = marked.lexer(list)
    expect(maxContainerDepth(tokens)).toBe(50)
    expect(hasFlattenedListTail(tokens)).toBe(false)
    const out = applyMarkdown(list, THEME)
    // Every level still renders its bullet.
    for (let i = 0; i < 50; i++) expect(out).toContain(`item-${i}`)
  })

  test('two sibling 99-deep lists in one message BOTH render at full depth (finally restore)', () => {
    configureMarked()
    // A paragraph between the two chains keeps them as two separate list
    // tokens (blank-line-adjacent `- ` lines would merge into one list).
    const twoLists = `${nestList(99)}\n\nsep\n\n${nestList(99)}`
    const tokens = marked.lexer(twoLists)
    const lists = tokens.filter(t => t.type === 'list')
    expect(lists.length).toBe(2)
    for (const l of lists) {
      expect(maxContainerDepth([l])).toBe(99)
    }
    expect(hasFlattenedListTail(tokens)).toBe(false)
    const out = applyMarkdown(twoLists, THEME)
    expect(out).toContain('item-98')
  })

  test('emphasis below the cap still parses (emStrong wrapper transparent)', () => {
    configureMarked()
    expect(applyMarkdown('**bold** and *em* text', THEME)).toContain('bold')
    // Pathological emphasis input must not throw either.
    expect(() =>
      applyMarkdown('*'.repeat(4000) + 'x' + '*'.repeat(4000), THEME),
    ).not.toThrow()
  })

  test('strikethrough stays disabled (existing configureMarked behavior kept)', () => {
    configureMarked()
    const out = applyMarkdown('~~not-strike~~ ~100', THEME)
    expect(out).toContain('~~not-strike~~')
    expect(out).toContain('~100')
  })
})

describe('2.1.290 render-catch fallback (official message, byte-exact)', () => {
  test('fallback message is the official string with em-dash U+2014', () => {
    expect(MARKDOWN_STACK_FALLBACK_MESSAGE).toBe(
      'markdown rendering exceeded the stack — input is too deeply nested',
    )
  })

  test('applyMarkdown returns the fallback message on RangeError from the lexer', () => {
    configureMarked()
    const spy = spyOn(marked, 'lexer').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    try {
      expect(applyMarkdown('# anything\n\nsome *markdown*', THEME)).toBe(
        MARKDOWN_STACK_FALLBACK_MESSAGE,
      )
    } finally {
      spy.mockRestore()
    }
  })

  test('applyMarkdown rethrows non-RangeError lexer failures', () => {
    configureMarked()
    const spy = spyOn(marked, 'lexer').mockImplementation(() => {
      throw new TypeError('unrelated bug')
    })
    try {
      expect(() => applyMarkdown('# anything', THEME)).toThrow(TypeError)
    } finally {
      spy.mockRestore()
    }
  })
})
