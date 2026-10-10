/**
 * CC 2.1.296 — non-UTF-8 refusal guards for the file-writing tools.
 *
 * Changelog: "Fixed Edit and NotebookEdit replacing every non-ASCII character
 * in files that are not valid UTF-8 (Windows-1252, Shift-JIS, GBK); such
 * edits are now refused."
 *
 * Ported from the official 2.1.296 binary (aligning-with-official-binary
 * skill; evidence: /tmp/cc296/ev-utf8.txt, 4KB window @208137035). Minified
 * official identifiers kept for traceability:
 *
 *   aen -> NOT_UTF8_REFUSAL_MESSAGE
 *   UTs -> UFFFD_WRITE_REFUSAL_MESSAGE
 *   C8  -> FileStateError (lives in utils/permissions/fileStateGuard.ts —
 *          the official declares aen/UTs right beside that class)
 *
 * Both messages are byte-verbatim from the binary.
 *
 * OCC wiring (documented adaptation — the official check sites are inside the
 * minified tool bodies; OCC places them at the equivalent points):
 *  - FileEditTool.validateInput: raw bytes already read there → aen refusal.
 *  - NotebookEditTool.validateInput + call: byte check before parse → aen.
 *  - FileWriteTool.call: UTs (disk not valid UTF-8 AND new content holds
 *    U+FFFD). The changelog headline names Edit/NotebookEdit; UTs is the
 *    write-path companion guard and Write is its only non-redundant home
 *    (Edit's aen pre-empts every non-UTF-8 disk file before a U+FFFD-content
 *    check could matter).
 *  - utf16le carve-out: OCC's read/write path detects a FF FE BOM and
 *    round-trips such files as utf16le (writeTextContent preserves the
 *    detected encoding), so the messages' premise — "This tool saves the
 *    whole file as UTF-8, which would replace every byte it cannot decode" —
 *    does not hold for them; the guards skip encoding === 'utf16le'. The
 *    official saves everything as UTF-8 and has no such path.
 */

/** aen — Edit/NotebookEdit refusal when the target file is not valid UTF-8. */
export const NOT_UTF8_REFUSAL_MESSAGE =
  'File is not valid UTF-8. It may use a legacy encoding such as Windows-1252, Shift-JIS or GBK, or be binary. This tool saves the whole file as UTF-8, which would replace every byte it cannot decode with U+FFFD. Nothing was written. Make the change with a shell command that reads and writes the file in its own encoding, or ask the user whether to convert the file to UTF-8 first.'

/** UTs — write refusal when disk is not valid UTF-8 and content holds U+FFFD. */
export const UFFFD_WRITE_REFUSAL_MESSAGE =
  'The file on disk is not valid UTF-8, and the new content holds U+FFFD, which is what Read shows for the bytes of that file it cannot decode. If the content came from Read, writing it destroys those characters. Nothing was written. Make the change with a shell command that reads and writes the file in its own encoding, or ask the user whether to convert the file to UTF-8 first.'

/** U+FFFD REPLACEMENT CHARACTER — what a lossy utf8 decode produces. */
export const REPLACEMENT_CHAR = '\uFFFD'

/**
 * True when `bytes` are a valid UTF-8 sequence. Uses a fatal TextDecoder:
 * any invalid byte throws. (Buffer.toString('utf-8') is lossy — it silently
 * maps every undecodable byte to U+FFFD, which is exactly the corruption the
 * official fix refuses to commit.)
 */
export function isValidUtf8Bytes(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * True when `content` holds U+FFFD — the marker Read shows for bytes it
 * could not decode. A write carrying it back to a non-UTF-8 file would
 * destroy the original characters (official UTs condition).
 */
export function containsReplacementChar(content: string): boolean {
  return content.includes(REPLACEMENT_CHAR)
}

/**
 * The aen gate for the Edit/NotebookEdit load path: the tool would save the
 * file as UTF-8 (detected encoding is not utf16le — see header note) and the
 * raw bytes do not decode as UTF-8.
 */
export function shouldRefuseNonUtf8Edit(
  bytes: Uint8Array,
  detectedEncoding: string,
): boolean {
  return detectedEncoding !== 'utf16le' && !isValidUtf8Bytes(bytes)
}

/**
 * The UTs gate for the Write path: the file on disk is not valid UTF-8 (and
 * would be re-saved as UTF-8) while the new content already holds U+FFFD.
 */
export function shouldRefuseUfffdWrite(
  diskBytes: Uint8Array,
  detectedEncoding: string,
  newContent: string,
): boolean {
  return (
    detectedEncoding !== 'utf16le' &&
    !isValidUtf8Bytes(diskBytes) &&
    containsReplacementChar(newContent)
  )
}
