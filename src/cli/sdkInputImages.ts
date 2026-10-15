/**
 * CC 2.1.299 #068 — resize base64 image blocks injected mid-session via SDK
 * stream-json input.
 *
 * Official changelog (2.1.299): "Fixed images attached while Claude is
 * working (VS Code, desktop app, SDK) being sent at full size, which led to
 * repeated image errors in long conversations."
 *
 * SDK user messages pass through `APIUserMessagePlaceholder()` (arbitrary
 * content blocks). Before this fix nothing resized image blocks on the
 * print.ts input path — `maybeResizeAndDownsampleImageBuffer` was only wired
 * into FileReadTool, BashTool, mcp/client and interactive imagePaste — so a
 * mid-session SDK attachment went to the API full-size and long conversations
 * re-sent the oversized image on every turn (repeated image errors).
 *
 * Mirrors the mcp/client.ts image-content path (unconditional resize call;
 * the resizer is a pass-through for already-small images: it returns the
 * input buffer by identity when `originalSize <= IMAGE_TARGET_RAW_SIZE` and
 * the dimensions are within the model's image limits).
 */

import { logForDebugging } from '../utils/debug.js'
import { maybeResizeAndDownsampleImageBuffer } from '../utils/imageResizer.js'

type Base64ImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

function isBase64ImageBlock(block: unknown): block is Base64ImageBlock {
  if (typeof block !== 'object' || block === null) return false
  const candidate = block as { type?: unknown; source?: unknown }
  if (candidate.type !== 'image') return false
  if (typeof candidate.source !== 'object' || candidate.source === null) {
    return false
  }
  const source = candidate.source as { type?: unknown; data?: unknown }
  return source.type === 'base64' && typeof source.data === 'string'
}

async function downsizeImageBlock(block: unknown): Promise<unknown> {
  if (!isBase64ImageBlock(block)) return block
  const imageBuffer = Buffer.from(block.source.data, 'base64')
  try {
    const ext = block.source.media_type?.split('/')[1] || 'png'
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      ext,
    )
    // Pass-through: the resizer returns the input buffer by identity when
    // the image is already within size and dimension limits — keep the
    // original block untouched (same base64, same media_type).
    if (resized.buffer === imageBuffer) return block
    return {
      ...block,
      source: {
        ...block.source,
        media_type: `image/${resized.mediaType}`,
        data: resized.buffer.toString('base64'),
      },
    }
  } catch (error) {
    // Never drop the user's message because a resize failed (corrupt or
    // exotic image data). Send the block as-is — the pre-fix behavior — and
    // let the API surface a precise error if the image is truly unusable.
    logForDebugging(
      `[sdk-input] image resize skipped, sending original: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { level: 'warn' },
    )
    return block
  }
}

/**
 * Apply the image resizer to every base64 image block in SDK user-message
 * content. Non-array content (plain string prompts) and non-image blocks are
 * returned untouched; when nothing changed, the original array is returned
 * by identity (immutable — no in-place mutation of the inbound message).
 */
export async function downsizeSdkInputImageBlocks<T>(content: T): Promise<T> {
  if (!Array.isArray(content)) return content
  let changed = false
  const nextBlocks: unknown[] = []
  for (const block of content) {
    const next = await downsizeImageBlock(block)
    if (next !== block) changed = true
    nextBlocks.push(next)
  }
  return changed ? (nextBlocks as T) : content
}
