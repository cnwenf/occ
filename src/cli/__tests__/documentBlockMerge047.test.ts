import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import { describe, expect, test } from 'bun:test'
import { joinPromptValues } from '../print.js'

/**
 * CC 2.1.299 (#047): "Fixed document blocks being dropped from your own
 * message sent while Claude is working."
 *
 * Verification for the OCC queued-message merge surface
 * (`joinPromptValues`, src/cli/print.ts:465). The merge preserves every
 * non-text block: the text/text boundary path pushes `blocks.slice(1)`
 * (src/cli/print.ts:482) and the non-text-boundary path pushes `...blocks`
 * (src/cli/print.ts:487), so `document` blocks survive intact. This file is
 * complementary to queuedPromptMerge299.test.ts (#093, which covers the
 * text newline-join + image preservation) — here we assert specifically on
 * `document` blocks, the block type named in #047.
 */

function text(t: string): ContentBlockParam {
  return { type: 'text', text: t }
}

function doc(source: string): ContentBlockParam {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: source },
  } as unknown as ContentBlockParam
}

describe('joinPromptValues — document-block preservation (CC 2.1.299 #047)', () => {
  test('a lone queued document value is returned by identity', () => {
    const value = [doc('PDF1')]
    expect(joinPromptValues([value])).toBe(value)
  })

  test('document block is preserved when merged with a queued text prompt', () => {
    const document = doc('PDF1')
    const merged = joinPromptValues([[document], [text('summary please')]]) as ContentBlockParam[]
    expect(merged[0]).toBe(document) // document survives, same object
    expect(merged.some(b => b.type === 'document')).toBe(true)
    expect(merged[merged.length - 1]).toEqual(text('summary please'))
  })

  test('document block trailing a text value is preserved (slice(1) path)', () => {
    const document = doc('PDF2')
    const merged = joinPromptValues([
      [text('here is a file'), document],
      [text('thanks')],
    ]) as ContentBlockParam[]
    expect(merged.some(b => b.type === 'document')).toBe(true)
    // The document object itself is carried through, not dropped or cloned away.
    expect(merged).toContain(document)
  })

  test('multiple documents across queued values are all preserved in order', () => {
    const d1 = doc('PDF-A')
    const d2 = doc('PDF-B')
    const merged = joinPromptValues([[d1, text('a')], [d2, text('b')]]) as ContentBlockParam[]
    const docs = merged.filter(b => b.type === 'document')
    expect(docs).toHaveLength(2)
    expect(docs[0]).toBe(d1)
    expect(docs[1]).toBe(d2)
  })

  test('no document block is ever dropped regardless of merge boundaries', () => {
    const document = doc('PDF3')
    // Boundary is text/document (non-text next) → standalone separator path.
    const merged = joinPromptValues([[text('lead')], [document]]) as ContentBlockParam[]
    expect(merged.some(b => b.type === 'document')).toBe(true)
    expect(merged).toContain(document)
  })
})
