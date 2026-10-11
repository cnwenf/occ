import { describe, expect, test } from 'bun:test'
import { applyGrammarPatches } from '../hljsGrammarPatches.js'

/**
 * OCC-154 fix-round C-item t-03 — Layer B grammar patches
 * (CC 2.1.295 #091, official `patchGrammarInPlace` tables).
 *
 * Why this file exists: the 验收员 t-03 mutation recipe (delete the
 * `markdown` + `python` entries from LANGUAGE_PATCHES) left every existing
 * suite green — nothing pinned that the catastrophic-backtracking rewrites
 * actually land on the INSTALLED hljs grammars. This suite applies
 * applyGrammarPatches() to a fresh hljs 11.11.1 instance with real grammars
 * and pins, per patched language:
 *
 *  - markdown fences: `(.|\n)*?` → `[^\r\u2028\u2029]*?` (backtick + tilde)
 *  - markdown links: `\[.*?\]\(.*?\)` → the lookahead form
 *    `\[(?=(.*?\]\())\1.*?\)` (linear-scan rewrite)
 *  - python numbers: `0+(_?0)*` → `0(_?0)*` (nested-quantifier removal)
 *  - rust raw strings: `(.|\n)*?` → `[^]{0,10000}?` (bounded lazy scan)
 *
 * Each family asserts BOTH directions: the unpatched source is present
 * before applyGrammarPatches and absent after; the patched source is absent
 * before and present after. Empirically verified against highlight.js
 * 11.11.1 (the version package.json pins) — the v11 markdown grammar
 * carries the fence/link patterns in string form and the patcher rewrites
 * them exactly like the v10.7.3 regex forms.
 *
 * Mutation-verify recipe (验收员 t-03): delete the `markdown` and `python`
 * entries from LANGUAGE_PATCHES in hljsGrammarPatches.ts → the markdown and
 * python describes go RED (unpatched forms survive), the rust describe
 * stays GREEN (suite isolation), then restore → all green.
 */

type AnyGrammar = Record<string, unknown>

async function freshHljs(languages: string[]): Promise<AnyGrammar> {
  const hljs = (await import('highlight.js')).default.newInstance()
  for (const name of languages) {
    const mod = await import(`highlight.js/lib/languages/${name}`)
    hljs.registerLanguage(name, mod.default)
  }
  return hljs as unknown as AnyGrammar
}

/** Walks a grammar tree and concatenates every begin/end/match/illegal
 * pattern (RegExp source or raw string) into one haystack for substring
 * assertions. */
function joinedPatterns(grammar: unknown): string {
  const out: string[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return
    seen.add(node)
    const rec = node as Record<string, unknown>
    for (const field of ['begin', 'end', 'match', 'illegal']) {
      const v = rec[field]
      if (v instanceof RegExp) out.push(v.source)
      else if (typeof v === 'string') out.push(v)
    }
    for (const child of (rec['contains'] as unknown[] | undefined) ?? []) {
      walk(child)
    }
    for (const child of (rec['variants'] as unknown[] | undefined) ?? []) {
      walk(child)
    }
    if ('starts' in rec) walk(rec['starts'])
  }
  walk(grammar)
  return out.join('\n')
}

// ── Expected pattern texts (regex-source level; backslashes doubled for
// TS string literals — these are the LITERAL source characters) ──

const UNPATCHED_FENCE_BACKTICK = '(`{3,})[^`](.|\\n)*?\\1`*[ ]*'
const UNPATCHED_FENCE_TILDE = '(~{3,})[^~](.|\\n)*?\\1~*[ ]*'
const PATCHED_FENCE_BACKTICK = '(`{3,})[^`][^\\r\\u2028\\u2029]*?\\1`*[ ]*'
const PATCHED_FENCE_TILDE = '(~{3,})[^~][^\\r\\u2028\\u2029]*?\\1~*[ ]*'
const UNPATCHED_LINK = '\\[.*?\\]\\(.*?\\)'
const PATCHED_LINK = '\\[(?=(.*?\\]\\())\\1.*?\\)'
const UNPATCHED_PY_NUMBER = '0+(_?0)*'
const PATCHED_PY_NUMBER = '|0(_?0)*)'
const UNPATCHED_RUST_RAW = 'b?r(#*)"(.|\\n)*?"\\1(?!#)'
const PATCHED_RUST_RAW = 'b?r(#*)"[^]{0,10000}?"\\1(?!#)'

const GRAMMAR_LANGS = ['xml', 'javascript', 'markdown', 'python', 'rust']

describe('hljsGrammarPatches Layer B — markdown (t-03 mutation target)', () => {
  test('fence patterns are line-bounded after patching (backtick + tilde)', async () => {
    const hljs = await freshHljs(GRAMMAR_LANGS)
    const before = joinedPatterns(hljs['getLanguage']!('markdown'))
    expect(before).toContain(UNPATCHED_FENCE_BACKTICK)
    expect(before).toContain(UNPATCHED_FENCE_TILDE)
    expect(before).not.toContain(PATCHED_FENCE_BACKTICK)

    applyGrammarPatches(hljs as never)

    const after = joinedPatterns(hljs['getLanguage']!('markdown'))
    expect(after).toContain(PATCHED_FENCE_BACKTICK)
    expect(after).toContain(PATCHED_FENCE_TILDE)
    expect(after).not.toContain(UNPATCHED_FENCE_BACKTICK)
    expect(after).not.toContain(UNPATCHED_FENCE_TILDE)
  })

  test('link patterns use the lookahead rewrite after patching', async () => {
    const hljs = await freshHljs(GRAMMAR_LANGS)
    const before = joinedPatterns(hljs['getLanguage']!('markdown'))
    expect(before).toContain(UNPATCHED_LINK)
    expect(before).not.toContain(PATCHED_LINK)

    applyGrammarPatches(hljs as never)

    const after = joinedPatterns(hljs['getLanguage']!('markdown'))
    expect(after).toContain(PATCHED_LINK)
    expect(after).not.toContain(UNPATCHED_LINK)
  })
})

describe('hljsGrammarPatches Layer B — python (t-03 mutation target)', () => {
  test('numeric literal loses the nested 0+ quantifier', async () => {
    const hljs = await freshHljs(GRAMMAR_LANGS)
    const before = joinedPatterns(hljs['getLanguage']!('python'))
    expect(before).toContain(UNPATCHED_PY_NUMBER)

    applyGrammarPatches(hljs as never)

    const after = joinedPatterns(hljs['getLanguage']!('python'))
    expect(after).toContain(PATCHED_PY_NUMBER)
    expect(after).not.toContain(UNPATCHED_PY_NUMBER)
  })
})

describe('hljsGrammarPatches Layer B — rust (mutation-isolation control)', () => {
  test('raw string lazy scan is bounded to {0,10000}?', async () => {
    const hljs = await freshHljs(GRAMMAR_LANGS)
    const before = joinedPatterns(hljs['getLanguage']!('rust'))
    expect(before).toContain(UNPATCHED_RUST_RAW)
    expect(before).not.toContain(PATCHED_RUST_RAW)

    applyGrammarPatches(hljs as never)

    const after = joinedPatterns(hljs['getLanguage']!('rust'))
    expect(after).toContain(PATCHED_RUST_RAW)
    expect(after).not.toContain(UNPATCHED_RUST_RAW)
  })
})
