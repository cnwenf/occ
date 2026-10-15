import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import { describe, expect, test } from 'bun:test'
import { joinPromptValues } from '../print.js'

// Official 2.1.299 changelog (#093): "Fixed queued prompts sent as content
// blocks over --input-format stream-json running together without a line
// break when merged into one turn."

function text(t: string): ContentBlockParam {
  return { type: 'text', text: t }
}

function concatText(blocks: ContentBlockParam[]): string {
  return blocks
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
}

describe('joinPromptValues — queued content-block merge (2.1.299 #093)', () => {
  test('single prompt value is returned unchanged (identity)', () => {
    const blocks = [text('hello')]
    expect(joinPromptValues([blocks])).toBe(blocks)
    expect(joinPromptValues(['solo'])).toBe('solo')
  })

  test('two queued string prompts are newline-joined (pre-existing path)', () => {
    expect(joinPromptValues(['first', 'second'])).toBe('first\nsecond')
  })

  test('two queued text-block prompts are separated by a newline when merged', () => {
    const merged = joinPromptValues([[text('first')], [text('second')]])
    expect(Array.isArray(merged)).toBe(true)
    expect(concatText(merged as ContentBlockParam[])).toBe('first\nsecond')
  })

  test('three queued block prompts keep one newline between each pair', () => {
    const merged = joinPromptValues([
      [text('a')],
      [text('b')],
      [text('c')],
    ]) as ContentBlockParam[]
    expect(concatText(merged)).toBe('a\nb\nc')
  })

  test('mixed string + block queue values are newline-separated', () => {
    const merged = joinPromptValues(['plain', [text('blocks')]]) as ContentBlockParam[]
    expect(concatText(merged)).toBe('plain\nblocks')
  })

  test('non-text merge boundary inserts a standalone newline text block', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    } as unknown as ContentBlockParam
    const merged = joinPromptValues([[image], [text('caption')]]) as ContentBlockParam[]
    // image preserved, separator between values, caption last
    expect(merged[0]).toBe(image)
    expect(merged[1]).toEqual(text('\n'))
    expect(merged[2]).toEqual(text('caption'))
  })

  test('trailing non-text blocks within a value are preserved in order', () => {
    const merged = joinPromptValues([
      [text('one'), text('two')],
      [text('three')],
    ]) as ContentBlockParam[]
    // Only the merge BOUNDARY is joined; inner blocks stay separate.
    expect(merged.map(b => (b.type === 'text' ? b.text : '?'))).toEqual([
      'one',
      'two\nthree',
    ])
  })

  test('input arrays and blocks are never mutated (immutable merge)', () => {
    const first = [text('a')]
    const second = [text('b')]
    const merged = joinPromptValues([first, second]) as ContentBlockParam[]
    expect(first).toEqual([text('a')])
    expect(second).toEqual([text('b')])
    expect(merged).not.toBe(first)
    expect(merged).not.toBe(second)
    // Boundary blocks are new objects, not the originals
    expect(merged[0]).not.toBe(first[0])
    expect(merged[1]).not.toBe(second[0])
  })

  test('empty block arrays contribute nothing and no stray separators', () => {
    const merged = joinPromptValues([[], [text('only')], []]) as ContentBlockParam[]
    expect(merged).toEqual([text('only')])
  })
})
