/**
 * CC 2.1.299 #068 — base64 image blocks injected mid-session via SDK
 * stream-json input must be resized before entering the conversation.
 *
 * Official changelog (2.1.299): "Fixed images attached while Claude is
 * working (VS Code, desktop app, SDK) being sent at full size, which led to
 * repeated image errors in long conversations."
 *
 * Exercises src/cli/sdkInputImages.ts (wired into the print.ts user-message
 * enqueue path) against the REAL maybeResizeAndDownsampleImageBuffer with a
 * mocked sharp (same fixture pattern as imageTokenLimits299.test.ts):
 *   - oversized (dimension-limit) image → block replaced with resized data
 *   - already-small image → pass-through, original array/block by identity
 *   - string content, text blocks, non-base64 image sources → untouched
 *   - resize failure (empty data) → original block kept, no throw
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

const actualImageProcessor = {
  ...(await import('../../tools/FileReadTool/imageProcessor.js')),
}

let mockMetadata: { width?: number; height?: number; format?: string } = {
  width: 100,
  height: 80,
  format: 'png',
}
let mockOutputBuffer: Buffer = Buffer.alloc(100, 7)
let lastResizeArgs: [number, number] | null = null

const makeFakeInstance = (): Record<string, unknown> => {
  const instance: Record<string, unknown> = {
    metadata: async () => mockMetadata,
    resize: (width: number, height: number) => {
      lastResizeArgs = [width, height]
      return instance
    },
    jpeg: () => instance,
    png: () => instance,
    webp: () => instance,
    toBuffer: async () => mockOutputBuffer,
  }
  return instance
}

// Superset-safe: spread the real module so a shared bun mock.module registry
// (mocks are process-global across test files in one run) still resolves the
// other imageProcessor exports.
mock.module('../../tools/FileReadTool/imageProcessor.js', () => ({
  ...actualImageProcessor,
  getImageProcessor: async () => (_input: Buffer) => makeFakeInstance(),
}))

const { downsizeSdkInputImageBlocks } = await import('../sdkInputImages.js')

afterAll(() => {
  mock.module(
    '../../tools/FileReadTool/imageProcessor.js',
    () => actualImageProcessor,
  )
})

function imageBlock(data: string, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

describe('CC 2.1.299 #068 — downsizeSdkInputImageBlocks', () => {
  test('oversized image block is resized (data + media_type replaced)', async () => {
    mockMetadata = { width: 2500, height: 2400, format: 'png' }
    mockOutputBuffer = Buffer.alloc(100, 7)
    lastResizeArgs = null

    const originalData = Buffer.alloc(1000, 1).toString('base64')
    const block = imageBlock(originalData)
    const content = [{ type: 'text', text: 'look at this' }, block]

    const result = await downsizeSdkInputImageBlocks(content)

    expect(Array.isArray(result)).toBe(true)
    const resultBlocks = result as Array<Record<string, unknown>>
    // Text block untouched (identity), image block replaced.
    expect(resultBlocks[0]).toBe(content[0])
    expect(resultBlocks[1]).not.toBe(block)
    const resized = resultBlocks[1] as {
      type: string
      source: { type: string; media_type: string; data: string }
    }
    expect(resized.type).toBe('image')
    expect(resized.source.type).toBe('base64')
    expect(resized.source.media_type).toBe('image/png')
    expect(resized.source.data).toBe(mockOutputBuffer.toString('base64'))
    expect(resized.source.data).not.toBe(originalData)
    // The physical resize ran through the dimension limits.
    expect(lastResizeArgs).not.toBeNull()
    // Input message not mutated (immutable contract).
    expect(content[1]).toBe(block)
    expect((block.source as { data: string }).data).toBe(originalData)
  })

  test('already-small image passes through by identity', async () => {
    mockMetadata = { width: 100, height: 80, format: 'png' }
    lastResizeArgs = null

    const block = imageBlock(Buffer.alloc(50, 2).toString('base64'))
    const content = [block]
    const result = await downsizeSdkInputImageBlocks(content)
    expect(result).toBe(content)
    expect(lastResizeArgs).toBeNull()
  })

  test('string content (plain-text prompt) is returned untouched', async () => {
    const content = 'just a prompt'
    expect(await downsizeSdkInputImageBlocks(content)).toBe(content)
  })

  test('non-base64 image sources and other blocks are untouched', async () => {
    mockMetadata = { width: 5000, height: 5000, format: 'png' }
    const urlImage = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/big.png' },
    }
    const doc = { type: 'document', source: { type: 'base64', data: 'AAA=' } }
    const content = [urlImage, doc, { type: 'text', text: 'hi' }]
    const result = await downsizeSdkInputImageBlocks(content)
    expect(result).toBe(content)
  })

  test('resize failure (empty image data) keeps the original block, no throw', async () => {
    const block = imageBlock('')
    const content = [block]
    const result = await downsizeSdkInputImageBlocks(content)
    expect(result).toBe(content)
  })

  test('jpeg media type is normalized on the resized block', async () => {
    mockMetadata = { width: 3000, height: 3000, format: 'jpg' }
    mockOutputBuffer = Buffer.alloc(80, 3)
    lastResizeArgs = null

    const block = imageBlock(Buffer.alloc(900, 4).toString('base64'), 'image/jpg')
    const result = (await downsizeSdkInputImageBlocks([block])) as Array<{
      source: { media_type: string; data: string }
    }>
    expect(result[0].source.media_type).toBe('image/jpeg')
    expect(result[0].source.data).toBe(mockOutputBuffer.toString('base64'))
  })
})
