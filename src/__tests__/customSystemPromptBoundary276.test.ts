import { describe, expect, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../constants/prompts.js'
import { splitCustomSystemPromptAtBoundary } from '../QueryEngine.js'
import { splitSysPromptPrefix } from '../utils/api.js'
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js'
import { splitCustomSystemPromptAtBoundary as splitFromNeutralModule } from '../utils/systemPromptBoundary.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'

/**
 * CC 2.1.276 (ITEM S): "Fixed `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` in a custom
 * `--system-prompt` not being honored for global prompt caching."
 *
 * Official v276 `sfe` (byte-extracted @198043890):
 *   `function sfe(e){let n=e.split("\n"),r=n.findIndex((h)=>h.trim()===$N);
 *    if(r===-1)return[e];
 *    let s=n.slice(0,r).join("\n")+"\n",g="\n"+n.slice(r+1).join("\n");
 *    return[...s.trim()?[s]:[],$N,...g.trim()?[g]:[]]}`
 *
 * v274 assembled the prompt as `typeof s==="string"?[s]:…` (@211578729);
 * v276 uses `typeof s==="string"?sfe(s):…` (@211903676). Without the split the
 * custom prompt is ONE array element, and `splitSysPromptPrefix` only matches
 * the boundary as a STANDALONE element — so the entire custom prompt landed in
 * the uncached dynamic bucket.
 */

const BOUNDARY = SYSTEM_PROMPT_DYNAMIC_BOUNDARY

/** Boundary on its own line between a static and a dynamic section. */
function customPromptWithBoundary(): string {
  return [
    'You are a concise assistant.',
    'Always answer in one sentence.',
    BOUNDARY,
    'Today the user is in /tmp/project.',
  ].join('\n')
}

describe('2.1.276 ITEM S — splitCustomSystemPromptAtBoundary', () => {
  test('returns a single unchanged element when the prompt has no boundary', () => {
    // Arrange
    const prompt = 'You are a concise assistant.\nNo marker here.'

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert
    expect(parts).toEqual([prompt])
  })

  test('does not split on a boundary that is only a substring of a line', () => {
    // Arrange — `splitSysPromptPrefix` matches standalone elements only, and
    // the official `sfe` matches whole trimmed lines only.
    const prompt = `prefix ${BOUNDARY} suffix\nsecond line`

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert
    expect(parts).toEqual([prompt])
  })

  test('splits text above and below the boundary into [static, BOUNDARY, dynamic]', () => {
    // Arrange
    const prompt = customPromptWithBoundary()

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert — official keeps the trailing/leading newline on each side.
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('You are a concise assistant.\nAlways answer in one sentence.\n')
    expect(parts[1]).toBe(BOUNDARY)
    expect(parts[2]).toBe('\nToday the user is in /tmp/project.')
  })

  test('drops the static part when the boundary is the first line', () => {
    // Arrange
    const prompt = `${BOUNDARY}\ndynamic section only`

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert
    expect(parts).toEqual([BOUNDARY, '\ndynamic section only'])
  })

  test('drops the dynamic part when the boundary is the last line', () => {
    // Arrange
    const prompt = `static section only\n${BOUNDARY}`

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert
    expect(parts).toEqual(['static section only\n', BOUNDARY])
  })

  test('drops whitespace-only sides', () => {
    // Arrange
    const prompt = `   \n${BOUNDARY}\n  \n\t\n`

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert — both sides are blank, so only the marker survives.
    expect(parts).toEqual([BOUNDARY])
  })

  test('splits on an indented boundary line (trimmed comparison)', () => {
    // Arrange — the official uses `h.trim()===$N`.
    const prompt = `static text\n   ${BOUNDARY}   \ndynamic text`

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert
    expect(parts).toEqual(['static text\n', BOUNDARY, '\ndynamic text'])
  })

  test('splits at the FIRST boundary when the prompt contains several', () => {
    // Arrange — `findIndex`, not `findLastIndex`.
    const prompt = `static\n${BOUNDARY}\nmid\n${BOUNDARY}\ntail`

    // Act
    const parts = splitCustomSystemPromptAtBoundary(prompt)

    // Assert — the second marker stays inside the dynamic half verbatim.
    expect(parts).toEqual([
      'static\n',
      BOUNDARY,
      `\nmid\n${BOUNDARY}\ntail`,
    ])
  })
})

describe('2.1.276 ITEM S — split output feeds the global cache split', () => {
  test('static half takes cacheScope "global" and dynamic half stays uncached', () => {
    // Arrange
    const parts = splitCustomSystemPromptAtBoundary(customPromptWithBoundary())

    // Act
    const blocks = splitSysPromptPrefix(asSystemPrompt(parts))

    // Assert
    const globalBlocks = blocks.filter(b => b.cacheScope === 'global')
    expect(globalBlocks).toHaveLength(1)
    expect(globalBlocks[0]!.text).toBe(
      'You are a concise assistant.\nAlways answer in one sentence.\n',
    )
    expect(blocks.some(b => b.text.includes('Today the user is in /tmp/project.'))).toBe(
      true,
    )
    // The marker itself never becomes a prompt block.
    expect(blocks.some(b => b.text === BOUNDARY)).toBe(false)
  })

  test('an unsplit custom prompt yields no "global" block (the 2.1.274 behavior)', () => {
    // Arrange — regression guard: without `sfe` the boundary is invisible to
    // splitSysPromptPrefix, so nothing is globally cacheable.
    const prompt = customPromptWithBoundary()

    // Act
    const unsplitBlocks = splitSysPromptPrefix(asSystemPrompt([prompt]))

    // Assert
    expect(unsplitBlocks.filter(b => b.cacheScope === 'global')).toHaveLength(0)
  })
})

describe('2.1.276 ITEM S — second embedding site (buildEffectiveSystemPrompt)', () => {
  // Official v276 applies `sfe` at EVERY custom-system-prompt embedding site
  // (@198045791 analysis, @211625532 analysisOnly, @211903676 main). OCC's
  // second site is buildEffectiveSystemPrompt in src/utils/systemPrompt.ts.

  const DEFAULT_PROMPT = ['default system prompt section']

  function build(customSystemPrompt: string | undefined, appendSystemPrompt?: string) {
    return buildEffectiveSystemPrompt({
      mainThreadAgentDefinition: undefined,
      toolUseContext: { options: {} },
      customSystemPrompt,
      defaultSystemPrompt: DEFAULT_PROMPT,
      appendSystemPrompt,
    })
  }

  test('the neutral module and the QueryEngine re-export are the same function', () => {
    expect(splitFromNeutralModule).toBe(splitCustomSystemPromptAtBoundary)
  })

  test('splits a custom prompt containing the boundary into [static, BOUNDARY, dynamic]', () => {
    // Act
    const result = build(customPromptWithBoundary())

    // Assert
    expect(result).toEqual([
      'You are a concise assistant.\nAlways answer in one sentence.\n',
      BOUNDARY,
      '\nToday the user is in /tmp/project.',
    ])
  })

  test('keeps appendSystemPrompt after the split parts', () => {
    // Act
    const result = build(customPromptWithBoundary(), 'APPENDED')

    // Assert
    expect(result).toEqual([
      'You are a concise assistant.\nAlways answer in one sentence.\n',
      BOUNDARY,
      '\nToday the user is in /tmp/project.',
      'APPENDED',
    ])
  })

  test('a custom prompt WITHOUT the boundary stays one element (unchanged behavior)', () => {
    // Arrange
    const prompt = 'plain custom prompt\nno marker'

    // Act
    const result = build(prompt)

    // Assert
    expect(result).toEqual([prompt])
  })

  test('the split output of buildEffectiveSystemPrompt feeds the global cache split', () => {
    // Act
    const blocks = splitSysPromptPrefix(asSystemPrompt(build(customPromptWithBoundary())))

    // Assert
    const globalBlocks = blocks.filter(b => b.cacheScope === 'global')
    expect(globalBlocks).toHaveLength(1)
    expect(globalBlocks[0]!.text).toBe(
      'You are a concise assistant.\nAlways answer in one sentence.\n',
    )
  })
})
