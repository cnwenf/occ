/**
 * Sync file-read path, extracted from file.ts.
 *
 * file.ts sits in the settings SCC via log.ts → types/logs.ts → types/message.ts →
 * Tool.ts → commands.ts → … Anything that needs readFileSync from file.ts
 * pulls in the whole chain. This leaf imports only fsOperations and debug,
 * both of which terminate in Node builtins.
 *
 * detectFileEncoding/detectLineEndings stay in file.ts — they call logError
 * (log.ts → SCC) on unexpected failures. The -ForResolvedPath/-ForString
 * helpers here are the pure parts; callers who need the logging wrappers
 * import from file.ts.
 */

import { isUtf8 } from 'buffer'
import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

export type LineEndingType = 'CRLF' | 'LF'

/**
 * CC 2.1.299 #126 — official notText categories (vA keys @216803634):
 * - `not_utf8`: bytes are not valid UTF-8 (legacy encodings such as
 *   Windows-1252 / Shift-JIS / GBK, or binary).
 * - `nul`: NUL bytes in the first 8 KB (binary data, UTF-16/UTF-32 without a
 *   BOM, or text with embedded NULs).
 * - `utf16be`: file starts FE FF — UTF-16 big-endian, which the tools cannot
 *   write.
 * Edit/Write refuse these files (FileStateError with the official Zpt
 * message); Read attaches the official nHs notice instead of refusing.
 */
export type NotTextCategory = 'not_utf8' | 'nul' | 'utf16be'

/** Official `f` — BOM-sniff sample size (rae runs on the first 4096 bytes). */
const ENCODING_SNIFF_BYTES = 4096

/** Official `b` — NUL-scan window (zMo checks the first 8000 bytes). */
const NUL_SCAN_BYTES = 8000

/**
 * Official `rae` (@215108500) — pure BOM sniff on an already-read head slice:
 * FF FE → utf16le; everything else (incl. EF BB BF and empty) → utf8.
 */
export function detectEncodingFromBytes(head: Buffer): BufferEncoding {
  if (head.byteLength === 0) return 'utf8'
  if (head.byteLength >= 2 && head[0] === 255 && head[1] === 254) {
    return 'utf16le'
  }
  return 'utf8'
}

/**
 * Official `Rgt` (@215109534) — classify a whole-file buffer:
 *
 *   function Rgt(n){let e=rae(n.subarray(0,f));if(e!=="utf8")return{encoding:e};
 *     if(n.byteLength>=2&&n[0]===254&&n[1]===255)return{encoding:e,notText:"utf16be"};
 *     if(zMo(n))return{encoding:e,notText:"nul"};
 *     return p(n)?{encoding:e}:{encoding:e,notText:"not_utf8"}}
 *
 * `p` is Buffer.isUtf8, `zMo(n)` is `n.subarray(0,b).includes(0)`. UTF-16LE
 * (BOM-detected) content is never flagged — the tools read and write it
 * behind its BOM.
 */
export function classifyFileBytes(buffer: Buffer): {
  encoding: BufferEncoding
  notText?: NotTextCategory
} {
  const encoding = detectEncodingFromBytes(
    buffer.subarray(0, ENCODING_SNIFF_BYTES),
  )
  if (encoding !== 'utf8') return { encoding }
  if (
    buffer.byteLength >= 2 &&
    buffer[0] === 254 &&
    buffer[1] === 255
  ) {
    return { encoding, notText: 'utf16be' }
  }
  if (buffer.subarray(0, NUL_SCAN_BYTES).includes(0)) {
    return { encoding, notText: 'nul' }
  }
  return isUtf8(buffer) ? { encoding } : { encoding, notText: 'not_utf8' }
}

/**
 * Official `UMr` (@215111300 region) — BOM preservation on rewrite:
 *
 *   function UMr(n,e){return e!==""&&n?.charCodeAt(0)===65279&&
 *     e.charCodeAt(0)!==65279?`\uFEFF${e}`:e}
 *
 * When the old on-disk content started with a BOM and the new content does
 * not, re-prefix the BOM so Write/Edit never silently drop it.
 */
export function preserveBomOnRewrite(
  oldContent: string | null | undefined,
  newContent: string,
): string {
  return newContent !== '' &&
    oldContent?.charCodeAt(0) === 0xfeff &&
    newContent.charCodeAt(0) !== 0xfeff
    ? `\uFEFF${newContent}`
    : newContent
}

export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, {
    length: 4096,
  })

  // Empty files should default to utf8, not ascii
  // This fixes a bug where writing emojis/CJK to empty files caused corruption
  if (bytesRead === 0) {
    return 'utf8'
  }

  if (bytesRead >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  }

  if (
    bytesRead >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf8'
  }

  // For non-empty files, default to utf8 since it's a superset of ascii
  // and handles all Unicode characters properly
  return 'utf8'
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0
  let lfCount = 0

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++
      } else {
        lfCount++
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * CC 2.1.296 #032 (official IAo, encoding chunk @208689628):
 * `IAo(n,e)=e==="utf8"&&!isUtf8(n)` — a utf8-decoded buffer whose bytes are
 * NOT valid UTF-8 decodes lossily (every undecodable byte becomes U+FFFD).
 * The gate is encoding-conditional: utf16le (BOM-detected) content is never
 * flagged, matching the official `e==="utf8"&&` guard exactly.
 */
export function isLossyUtf8Decode(
  bytes: Buffer,
  encoding: BufferEncoding,
): boolean {
  return encoding === 'utf8' && !isUtf8(bytes)
}

/**
 * Like readFileSync but also returns the detected encoding, original line
 * ending style, and a lossy-decode flag in one filesystem pass. Callers
 * writing the file back (e.g. FileEditTool) can reuse these instead of
 * calling detectFileEncoding / detectLineEndings separately, which would
 * each redo safeResolvePath + readSync(4KB).
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  lossyDecode: boolean
  /** CC 2.1.299 #126 — official `notText` from Rgt (classifyFileBytes). */
  notText?: NotTextCategory
} {
  const fs = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fs, filePath)

  if (isSymlink) {
    logForDebugging(`Reading through symlink: ${filePath} -> ${resolvedPath}`)
  }

  // CC 2.1.296 #032 (official nwe): read the raw bytes ONCE, then derive
  // encoding (BOM sniff), the decoded content, and the lossy flag from the
  // same buffer — mirroring `{content,encoding,lineEndings,...IAo(i,s)&&
  // {lossyDecode:!0}}`. Reading a string directly would discard the bytes
  // needed by isUtf8.
  // CC 2.1.299 #126 (official sEe @215110800): the same single buffer also
  // feeds Rgt → `{encoding, notText}`; notText rides along
  // (`...s&&{notText:s}`) for the Edit/Write refusal gates.
  const bytes = fs.readFileBytesSync(resolvedPath)
  const { encoding, notText } = classifyFileBytes(bytes)
  const raw = bytes.toString(encoding)
  // Detect line endings from the raw head before CRLF normalization erases
  // the distinction. 4096 code units is ≥ detectLineEndings's 4096-byte
  // readSync sample (line endings are ASCII, so the unit mismatch is moot).
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096))
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings,
    lossyDecode: isLossyUtf8Decode(bytes, encoding),
    ...(notText ? { notText } : {}),
  }
}

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
