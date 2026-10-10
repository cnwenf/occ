import { writeFile } from 'fs/promises'
import { join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { MCPResultType } from '../services/mcp/client.js'
import { getDefaultFileReadingLimits } from '../tools/FileReadTool/limits.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'

/**
 * Generates a format description string based on the MCP result type and schema.
 */
export function getFormatDescription(
  type: MCPResultType,
  schema?: unknown,
): string {
  switch (type) {
    case 'toolResult':
      return 'Plain text'
    case 'structuredContent':
      return schema ? `JSON with schema: ${schema}` : 'JSON'
    case 'contentArray':
      return schema ? `JSON array with schema: ${schema}` : 'JSON array'
  }
}

/**
 * Line-shape statistics of the content persisted to disk.
 *
 * CC 2.1.287 #29 — official v287 `vsn`'s `g` parameter (`{count, maxLen}`).
 * Only populated for results persisted as PLAIN TEXT; JSON-persisted results
 * leave it undefined so the guidance warns that Read's offset/limit cannot
 * split the file's one long line instead of recommending offset/limit paging.
 */
export type LargeOutputLineStats = {
  count: number
  maxLen: number
}

/**
 * CC 2.1.287 #29 — byte-exact port of the official argv quoter used inside the
 * MCP large-output module (`XK`, aliased `Ur` there; recovered from the v287
 * ELF):
 *
 *   function XK(e){return e.map((r)=>{if(r==="")return"''";
 *     if(/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(r))return r;
 *     return"'"+r.replace(/'/g,`'"'"'`)+"'"}).join(" ")}
 *
 * Safe-charset args pass through bare; anything else is single-quoted with `'`
 * escaped as `'"'"'`. OCC's shell-quote based `quote()` helper is NOT used
 * because it switches to double-quote mode (and escapes `!`), which would not
 * be byte-identical inside the prompt.
 */
function quoteArgvForShell(args: ReadonlyArray<string>): string {
  return args
    .map(arg => {
      if (arg === '') return "''"
      if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) return arg
      return `'${arg.replace(/'/g, `'"'"'`)}'`
    })
    .join(' ')
}

/**
 * CC 2.1.287 #29 — compute the line-shape stats of the content that was
 * persisted, byte-faithful to the official v287 caller:
 *
 *   let ce=j.split("\n");
 *   if(ce.length>1&&ce.at(-1)==="")ce.pop();
 *   let he=0;for(let ae of ce)if(ae.length>he)he=ae.length;
 *   ye={count:ce.length,maxLen:he}
 *
 * A single trailing newline does not add a phantom line. Single pass.
 */
export function computePersistedLineStats(
  content: string,
): LargeOutputLineStats {
  const rawLines = content.split('\n')
  const lines =
    rawLines.length > 1 && rawLines.at(-1) === ''
      ? rawLines.slice(0, -1)
      : rawLines
  let maxLen = 0
  for (const line of lines) {
    if (line.length > maxLen) maxLen = line.length
  }
  return { count: lines.length, maxLen }
}

/**
 * REQUIREMENTS block — official v287 `mio(path, maxReadLength, extraNote)`:
 *
 *   `- You MUST read the content from the file at ${e} in sequential chunks
 *    until 100% of the content has been read.\n` + r + s + `- Before producing
 *    ANY summary or analysis, ...\n`
 *
 * `extraNote` (`r`) is the line-shape bullet, placed between the
 * "read in sequential chunks" bullet and the truncation-warning bullet (`s`).
 * It is the empty string for many-short-lines files.
 */
function buildSummarizationRequirements(
  rawOutputPath: string,
  maxReadLength: number | undefined,
  extraNote: string,
): string {
  const truncationWarning = maxReadLength
    ? `- If you receive truncation warnings when reading the file ("[N lines truncated]"), reduce the chunk size until you have read 100% of the content without truncation ***DO NOT PROCEED UNTIL YOU HAVE DONE THIS***. Bash output is limited to ${maxReadLength.toLocaleString()} chars.\n`
    : `- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n`

  const completionRequirement = `- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n`

  return (
    `- You MUST read the content from the file at ${rawOutputPath} in sequential chunks until 100% of the content has been read.\n` +
    extraNote +
    truncationWarning +
    completionRequirement
  )
}

/**
 * Generates instruction text for Claude to read from a saved output file.
 *
 * CC 2.1.287 #29 — port of the official v287 `vsn` builder, legacy
 * (`!QMt()`) branch only. The guidance is now line-shape aware: a
 * JSON-persisted result (or any result whose line shape was not measured) no
 * longer tells Claude to page the file with Read's offset/limit, which cannot
 * split one long line.
 *
 * @param rawOutputPath - Path to the saved output file
 * @param contentLength - Length of the content in characters
 * @param formatDescription - Description of the content format
 * @param maxReadLength - Optional max chars for Read tool (for Bash output context)
 * @param lineStats - Optional line-shape stats of the persisted content
 *   (`{count, maxLen}`); pass only when the content was persisted as plain text
 * @returns Instruction text to include in the tool result
 */
export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
  maxReadLength?: number,
  lineStats?: LargeOutputLineStats,
): string {
  // Official `w` header. The line-count phrasing is added only when the
  // line-shape stats are known; with lineStats omitted the header is
  // byte-identical to the pre-287 text.
  const sizeDescription =
    lineStats !== undefined
      ? `${contentLength.toLocaleString()} characters across ${lineStats.count.toLocaleString()} ${lineStats.count === 1 ? 'line' : 'lines'}`
      : `${contentLength.toLocaleString()} characters`

  const header =
    `Error: result (${sizeDescription}) exceeds maximum allowed tokens. Output has been saved to ${rawOutputPath}.\n` +
    `Format: ${formatDescription}\n`

  // Official `j=Math.floor(OQ().maxTokens*4*0.8)` — OQ() is the Read tool's
  // default file-reading limits (OCC: getDefaultFileReadingLimits(), default
  // maxTokens 25000 → 80000 chars).
  const maxChunkChars = Math.floor(
    getDefaultFileReadingLimits().maxTokens * 4 * 0.8,
  )
  // Official `K=g!==void 0&&g.count>1&&g.maxLen<=j` — "many short lines".
  const hasChunkableLines =
    lineStats !== undefined &&
    lineStats.count > 1 &&
    lineStats.maxLen <= maxChunkChars
  // Official `_e`.
  const jqProbeHint = `first probe the structure (e.g., jq 'type, length, keys?' ${quoteArgvForShell([rawOutputPath])}), then extract slices with jq or python`

  let readStrategy: string
  let shapeNote: string
  if (lineStats === undefined) {
    // JSON / unmeasured shape: never recommend offset/limit paging.
    readStrategy = `Use jq to make structured queries (find a value, filter by field).\n`
    shapeNote = `- Note: this file is JSON, so a long value (or the whole file) is a single line. ${FILE_READ_TOOL_NAME}'s offset/limit cannot split a line, so reading in chunks works only if every line is short. If a shell tool is available, ${jqProbeHint}.\n`
  } else if (!hasChunkableLines) {
    readStrategy = `Search within the file for specific content, and use jq if the content is JSON.\n`
    shapeNote = `- Note: this file's lines are too long for ${FILE_READ_TOOL_NAME}'s offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.\n`
  } else {
    readStrategy = `Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\n`
    shapeNote = ''
  }

  return (
    header +
    readStrategy +
    `REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n` +
    buildSummarizationRequirements(rawOutputPath, maxReadLength, shapeNote)
  )
}

/**
 * Map a mime type to a file extension. Conservative: known types get their
 * proper extension; unknown types get 'bin'. The extension matters because
 * the Read tool dispatches on it (PDFs, images, etc. need the right ext).
 *
 * CC 2.1.295 (item 4): the official ext→mime map (`R` in the binary,
 * evidence /tmp/cc295/ev/ext_map_css.txt) gained CSS/JS/XML, fonts, icons,
 * AVIF and WASM entries — so those payloads no longer persist as .bin:
 *   ".css":"text/css", ".js"/".mjs":"text/javascript",
 *   ".xml":"application/xml", ".avif":"image/avif",
 *   ".ico":"image/vnd.microsoft.icon", ".woff":"font/woff",
 *   ".woff2":"font/woff2", ".ttf":"font/ttf", ".otf":"font/otf",
 *   ".wasm":"application/wasm"
 * This reverse (mime→ext) mapping mirrors exactly those entries.
 */
export function extensionForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return 'bin'
  // Strip any charset/boundary parameter
  const mt = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
  switch (mt) {
    case 'application/pdf':
      return 'pdf'
    case 'application/json':
      return 'json'
    case 'text/csv':
      return 'csv'
    case 'text/plain':
      return 'txt'
    case 'text/html':
      return 'html'
    case 'text/markdown':
      return 'md'
    case 'text/css':
      return 'css'
    case 'text/javascript':
      return 'js'
    case 'application/xml':
      return 'xml'
    case 'application/zip':
      return 'zip'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx'
    case 'application/msword':
      return 'doc'
    case 'application/vnd.ms-excel':
      return 'xls'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
      return 'wav'
    case 'audio/ogg':
      return 'ogg'
    case 'video/mp4':
      return 'mp4'
    case 'video/webm':
      return 'webm'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    case 'image/avif':
      return 'avif'
    case 'image/vnd.microsoft.icon':
      return 'ico'
    case 'font/woff':
      return 'woff'
    case 'font/woff2':
      return 'woff2'
    case 'font/ttf':
      return 'ttf'
    case 'font/otf':
      return 'otf'
    case 'application/wasm':
      return 'wasm'
    default:
      return 'bin'
  }
}

/**
 * Heuristic for whether a content-type header indicates binary content that
 * should be saved to disk rather than put into the model context.
 * Text-ish types (text/*, json, xml, form data) are treated as non-binary.
 */
export function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false
  const mt = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mt.startsWith('text/')) return false
  // Structured text formats delivered with an application/ type. Use suffix
  // or exact match rather than substring so 'openxmlformats' (docx/xlsx) stays binary.
  if (mt.endsWith('+json') || mt === 'application/json') return false
  if (mt.endsWith('+xml') || mt === 'application/xml') return false
  if (mt.startsWith('application/javascript')) return false
  if (mt === 'application/x-www-form-urlencoded') return false
  return true
}

export type PersistBinaryResult =
  | { filepath: string; size: number; ext: string }
  | { error: string }

/**
 * Write raw binary bytes to the tool-results directory with a mime-derived
 * extension. Unlike persistToolResult (which stringifies), this writes the
 * bytes as-is so the resulting file can be opened with native tools (Read
 * for PDFs, pandas for xlsx, etc.).
 */
export async function persistBinaryContent(
  bytes: Buffer,
  mimeType: string | undefined,
  persistId: string,
): Promise<PersistBinaryResult> {
  await ensureToolResultsDir()
  const ext = extensionForMimeType(mimeType)
  const filepath = join(getToolResultsDir(), `${persistId}.${ext}`)

  try {
    await writeFile(filepath, bytes)
  } catch (error) {
    const err = toError(error)
    logError(err)
    return { error: err.message }
  }

  // mime type and extension are safe fixed-vocabulary strings (not paths/code)
  logEvent('tengu_binary_content_persisted', {
    mimeType: (mimeType ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sizeBytes: bytes.length,
    ext: ext as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return { filepath, size: bytes.length, ext }
}

/**
 * Build a short message telling Claude where binary content was saved.
 * Just states the path — no prescriptive hint, since what the model can
 * actually do with the file depends on provider/tooling.
 */
export function getBinaryBlobSavedMessage(
  filepath: string,
  mimeType: string | undefined,
  size: number,
  sourceDescription: string,
): string {
  const mt = mimeType || 'unknown type'
  return `${sourceDescription}Binary content (${mt}, ${formatFileSize(size)}) saved to ${filepath}`
}
