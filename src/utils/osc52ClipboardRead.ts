/**
 * Read the clipboard image via OSC 52.
 *
 * OSC 52 read is the only mechanism that can pull a *local* clipboard image
 * to a remote process over a plain SSH session. Bracketed paste cannot
 * carry image bytes; OSC 52 asks the terminal directly and the terminal
 * replies inline on stdin (parsed by `parse-keypress.ts` as an
 * `{type:'osc',code:52,data}` response).
 *
 * Support is terminal-dependent and often security-gated:
 *   - iTerm2 / kitty / wezterm: supported (usually opt-in).
 *   - Alacritty / Windows Terminal: read not supported.
 *   - tmux: requires `allow-passthrough on` for the outer terminal to see
 *     the query (the querier writes raw, so under tmux this may not reach
 *     the outer terminal — known limitation).
 *
 * When the clipboard holds text (not an image), the terminal returns text
 * bytes; we reject those (no image magic bytes) and return null so callers
 * fall through to the no-image hint.
 *
 * Never throws — callers show the no-image hint on null.
 */
import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { osc52Read } from '../ink/terminal-querier.js'
import { detectImageFormatFromBase64 } from './imageResizer.js'
import { logError } from './log.js'

export type OSC52ReadResult = {
  /** Raw image bytes (PNG/JPEG/GIF/WebP/BMP). */
  buffer: Buffer
  /** Detected media type, e.g. `image/png`. */
  mediaType: string
}

/**
 * Parse an OSC 52 response data string (`<selection>;<base64>`) into the
 * raw clipboard bytes, or null if the payload is missing/malformed.
 *
 * Exported for unit testing — the querier is mocked at the call site.
 */
export function parseOSC52ResponseData(data: string | undefined): Buffer | null {
  if (!data) return null
  // Response shape: `c;<base64>` (selection `c` = clipboard). The base64
  // payload itself never contains `;`, so split on the FIRST `;` only —
  // some terminals emit additional fields before the payload.
  const sep = data.indexOf(';')
  const b64 = sep >= 0 ? data.slice(sep + 1) : data
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    // `Buffer.from` of a non-base64 string yields garbage, not a throw;
    // empty/decoded-zero-length means nothing to read.
    return buf.length > 0 ? buf : null
  } catch (e) {
    logError(e as Error)
    return null
  }
}

/**
 * Returns true iff the buffer starts with a recognized image magic-byte
 * signature. Used to reject text clipboard contents (OSC 52 read returns
 * whatever is in the clipboard — text or image).
 */
export function looksLikeImageBytes(buf: Buffer): boolean {
  if (buf.length < 4) return false
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true
  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true
  return false
}

/**
 * Send an OSC 52 clipboard-read query and await the terminal's reply.
 *
 * Resolves with `{buffer, mediaType}` when the terminal supports OSC 52
 * read AND the clipboard holds an image. Resolves `null` when:
 *  - the terminal ignores the query (DA1 sentinel arrives first →
 *    `send()` resolves `undefined`),
 *  - the clipboard holds text (no image magic bytes),
 *  - the response payload is empty/malformed.
 *
 * `querier` is the `internal_querier` from `StdinContext`. Null when not
 * inside the Ink tree (tests) — returns null immediately.
 */
export async function readClipboardImageViaOSC52(
  querier: TerminalQuerier | null | undefined,
): Promise<OSC52ReadResult | null> {
  if (!querier) return null
  try {
    // send() writes the OSC 52 query; flush() writes the DA1 sentinel.
    // The DA1 sentinel is the universal "terminal didn't answer your
    // query" signal — send() resolves undefined when DA1 arrives first.
    const [response] = await Promise.all([
      querier.send(osc52Read()),
      querier.flush(),
    ])
    if (!response || response.type !== 'osc' || response.code !== 52) {
      return null
    }
    const buf = parseOSC52ResponseData(response.data)
    if (!buf || !looksLikeImageBytes(buf)) {
      return null
    }
    const mediaType = detectImageFormatFromBase64(buf.toString('base64'))
    return { buffer: buf, mediaType }
  } catch (e) {
    logError(e as Error)
    return null
  }
}
