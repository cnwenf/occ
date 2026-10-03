import { beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type { Message } from '../../types/message.js'
import {
  getAssistantMessageFromError,
  getImageTooLargeErrorMessage,
  getModelUnsupportedPdfErrorMessage,
  getPdfInvalidErrorMessage,
  isModelUnsupportedPdfError,
} from '../../services/api/errors.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  normalizeMessagesForAPI,
  _resetNormalizationCacheForTesting,
} from '../messages.js'

/**
 * Official Claude Code v288 gap #49 (docs/gap-research-288/
 * cluster-c-instructions-resume.md): Claude 3 Opus/Sonnet sessions failed on
 * EVERY turn after a whole PDF entered the conversation. The API rejects the
 * document block with "…does not support pdf input…" / "…does not support
 * pdfs…", but the v287 strip sanitizer did not recognize those signatures, so
 * the document block was re-sent forever.
 *
 * v288 delta (binary-verbatim):
 * - signature list `kF` = ["does not support pdf input","does not support pdfs"]
 * - predicate `t6n(e){let n=e.toLowerCase();return kF.some((r)=>n.includes(r))}`
 * - model-specific message `TSe()` =
 *   `${Ua}: this model does not accept PDF documents, so a PDF in the conversation was removed. Ask Claude to read specific pages of the file instead (they are sent as images), or switch to a model that reads PDFs.`
 *   with `Ua` = "API Error"
 * - constructor `z8(e,n)`: content = r ? TSe() : K8(e),
 *   apiError = "media_removed",
 *   apiErrorParams = rJe(n) ? {media_reason:"media_budget"}
 *                           : {media:e, media_reason: r ? "unsupported_by_model" : "unprocessable"}
 *   where r = e === "document" && t6n(n)
 *
 * OCC mapping: `z8` ≡ getAssistantMessageFromError's PDF branches +
 * createAssistantAPIErrorMessage; the strip walk-back lives in
 * normalizeMessagesForAPI (unchanged by this port).
 */

const MODEL = 'claude-3-opus-20190528'

// Verbatim TSe() — never paraphrase.
const TSE_TEXT =
  'API Error: this model does not accept PDF documents, so a PDF in the conversation was removed. Ask Claude to read specific pages of the file instead (they are sent as images), or switch to a model that reads PDFs.'

function apiError400(bodyMessage: string): APIError {
  return new APIError(400, { message: bodyMessage }, bodyMessage, undefined)
}

function renderedText(msg: { message?: { content?: unknown } }): string {
  const content = msg.message?.content
  return Array.isArray(content)
    ? content
        .map(block =>
          block && typeof block === 'object' && 'text' in block
            ? String((block as { text?: unknown }).text ?? '')
            : '',
        )
        .join('')
    : ''
}

function allBlocks(msgs: Array<{ message?: { content?: unknown } }>): Array<{
  type: string
}> {
  return msgs.flatMap(m =>
    Array.isArray(m.message?.content)
      ? (m.message!.content as Array<{ type: string }>)
      : [],
  )
}

/** A real user turn. */
function makeUserText(text: string): Message {
  return createUserMessage({ content: text }) as unknown as Message
}

/** The isMeta user message FileReadTool emits for a whole-PDF read (FileReadTool.ts:1364-1378). */
function makeMetaPdfMessage(extraText?: string): Message {
  const content: Array<Record<string, unknown>> = [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERi0xLjQK',
      },
    },
  ]
  if (extraText !== undefined) {
    content.push({ type: 'text', text: extraText })
  }
  return createUserMessage({ content, isMeta: true }) as unknown as Message
}

/** The synthetic API-error assistant message the query loop appends on failure. */
function makeSyntheticApiError(text: string): Message {
  return createAssistantAPIErrorMessage({ content: text }) as unknown as Message
}

describe('isModelUnsupportedPdfError (official t6n predicate)', () => {
  test('matches "does not support pdf input" case-insensitively', () => {
    // Arrange
    const message =
      'messages.3.content: This model does not support PDF input. Use a different model.'

    // Act & Assert
    expect(isModelUnsupportedPdfError(message)).toBe(true)
  })

  test('matches "does not support pdfs" case-insensitively', () => {
    expect(isModelUnsupportedPdfError('The model does not support PDFs')).toBe(
      true,
    )
  })

  test('does not match unrelated errors', () => {
    expect(isModelUnsupportedPdfError('Too much media in the conversation')).toBe(
      false,
    )
    expect(isModelUnsupportedPdfError('The PDF specified was not valid')).toBe(
      false,
    )
    expect(isModelUnsupportedPdfError('image exceeds 5 MB maximum')).toBe(false)
  })
})

describe('getModelUnsupportedPdfErrorMessage (official TSe)', () => {
  test('returns the verbatim model-unsupported message', () => {
    expect(getModelUnsupportedPdfErrorMessage()).toBe(TSE_TEXT)
  })
})

describe('getAssistantMessageFromError — model-unsupported PDF (official z8 document+t6n arm)', () => {
  test('API 400 "does not support pdf input" surfaces TSe verbatim with apiError media_removed / unsupported_by_model', () => {
    // Arrange
    const error = apiError400(
      'messages.3.content: This model does not support PDF input. Use a different model to read PDFs.',
    )

    // Act
    const msg = getAssistantMessageFromError(error, MODEL)

    // Assert
    expect(renderedText(msg)).toBe(TSE_TEXT)
    expect(msg.apiError).toBe('media_removed')
    expect(msg.apiErrorParams).toEqual({
      media: 'document',
      media_reason: 'unsupported_by_model',
    })
  })

  test('plain Error "does not support pdfs" variant surfaces TSe verbatim too', () => {
    // Arrange
    const error = new Error('The model does not support pdfs in messages')

    // Act
    const msg = getAssistantMessageFromError(error, MODEL)

    // Assert
    expect(renderedText(msg)).toBe(TSE_TEXT)
    expect(msg.apiError).toBe('media_removed')
    expect(msg.apiErrorParams).toEqual({
      media: 'document',
      media_reason: 'unsupported_by_model',
    })
  })

  test('image errors keep the existing generic message (unchanged K8 arm)', () => {
    // Arrange
    const error = apiError400('image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes')

    // Act
    const msg = getAssistantMessageFromError(error, MODEL)

    // Assert
    const text = renderedText(msg)
    expect(text).toContain('Image was too large')
    expect(text).not.toBe(TSE_TEXT)
    expect(msg.apiError).not.toBe('media_removed')
  })

  test('"too much media" errors keep existing behavior (no media_budget arm in OCC)', () => {
    // Arrange
    const error = apiError400('There is too much media in this conversation.')

    // Act
    const msg = getAssistantMessageFromError(error, MODEL)

    // Assert — falls through to the generic API Error rendering, as before.
    const text = renderedText(msg)
    expect(text).not.toBe(TSE_TEXT)
    expect(text).toContain('too much media')
    expect(msg.apiError).not.toBe('media_removed')
  })

  test('non-PDF errors are untouched', () => {
    // Arrange
    const error = apiError400('The PDF specified was not valid')

    // Act
    const msg = getAssistantMessageFromError(error, MODEL)

    // Assert — still the pre-existing invalid-PDF message.
    expect(msg.apiError).not.toBe('media_removed')
    expect(renderedText(msg)).toContain('The PDF file was not valid')
  })
})

describe('normalizeMessagesForAPI — document strip for model-unsupported PDF errors (#49)', () => {
  beforeEach(() => {
    _resetNormalizationCacheForTesting()
  })

  test('TSe synthetic error strips the PDF document block from the preceding isMeta user message', () => {
    // Arrange
    const messages: Message[] = [
      makeUserText('read this pdf'),
      makeMetaPdfMessage(),
      makeSyntheticApiError(TSE_TEXT),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert — synthetic error filtered out; no document block re-sent.
    expect(result.some(m => m.type === 'assistant')).toBe(false)
    expect(allBlocks(result).some(b => b.type === 'document')).toBe(false)
  })

  test('raw "does not support pdf input" signature strips the document block (t6n substring predicate)', () => {
    // Arrange — e.g. a transcript persisted before the TSe composition existed.
    const messages: Message[] = [
      makeUserText('read this pdf'),
      makeMetaPdfMessage(),
      makeSyntheticApiError(
        'API Error: 400 messages.3.content: This model does not support PDF input.',
      ),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert
    expect(allBlocks(result).some(b => b.type === 'document')).toBe(false)
  })

  test('raw "does not support pdfs" signature strips the document block', () => {
    // Arrange
    const messages: Message[] = [
      makeUserText('read this pdf'),
      makeMetaPdfMessage(),
      makeSyntheticApiError('API Error: 400 The model does not support pdfs.'),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert
    expect(allBlocks(result).some(b => b.type === 'document')).toBe(false)
  })

  test('exact-match keying still works: getPdfInvalidErrorMessage strips documents (regression)', () => {
    // Arrange
    const messages: Message[] = [
      makeUserText('read this pdf'),
      makeMetaPdfMessage(),
      makeSyntheticApiError(getPdfInvalidErrorMessage()),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert
    expect(allBlocks(result).some(b => b.type === 'document')).toBe(false)
  })

  test('image too large error strips only image blocks, never documents', () => {
    // Arrange
    const meta = createUserMessage({
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'JVBERi0xLjQK',
          },
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aVZCT1I=' } },
      ],
      isMeta: true,
    }) as unknown as Message
    const messages: Message[] = [
      makeUserText('look at these'),
      meta,
      makeSyntheticApiError(getImageTooLargeErrorMessage()),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert — image gone, document untouched.
    const types = allBlocks(result).map(b => b.type)
    expect(types).not.toContain('image')
    expect(types).toContain('document')
  })

  test('"too much media" synthetic error preserves existing behavior: document NOT stripped', () => {
    // Arrange — OCC has no media_budget strip arm (official rJe/Q9e detector
    // not ported); this pins that the new predicate does not change that.
    const messages: Message[] = [
      makeUserText('look at these'),
      makeMetaPdfMessage(),
      makeSyntheticApiError('API Error: 400 There is too much media in this conversation.'),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert
    expect(allBlocks(result).some(b => b.type === 'document')).toBe(true)
  })

  test('non-PDF synthetic errors leave the document block untouched', () => {
    // Arrange
    const messages: Message[] = [
      makeUserText('read this pdf'),
      makeMetaPdfMessage(),
      makeSyntheticApiError('API Error: 500 Internal server error'),
    ]

    // Act
    const result = normalizeMessagesForAPI(messages, [])

    // Assert
    expect(allBlocks(result).some(b => b.type === 'document')).toBe(true)
  })
})
