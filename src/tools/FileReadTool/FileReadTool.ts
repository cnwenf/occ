import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { readdir, readFile as readFileAsync } from 'fs/promises'
import * as path from 'path'
import { posix, win32 } from 'path'
import { z } from 'zod/v4'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/apiLimits.js'
import { hasBinaryExtension } from '../../constants/files.js'
import { memoryFreshnessNote } from '../../memdir/memoryAge.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  getFileExtensionForAnalytics,
} from '../../services/analytics/metadata.js'
import {
  countTokensWithAPI,
  roughTokenCountEstimationForFileType,
} from '../../services/tokenEstimation.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { escapeControlCharsAsEntities } from '../../utils/displayEscape.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import { getErrnoCode, isAbortError, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  type ImageDimensions,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../../utils/imageResizer.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { isAutoMemFile } from '../../utils/memoryFileDetection.js'
import { createUserMessage } from '../../utils/messages.js'
import { getCanonicalName, getMainLoopModel } from '../../utils/model/model.js'
import {
  mapNotebookCellsToToolResult,
  readNotebook,
} from '../../utils/notebook.js'
import {
  macosNetworkMountDenyMessage,
  shouldDenyMacosNetworkMountPath,
} from '../../utils/macosKernelPaths.js'
import { isNtNamespacePath } from '../../utils/ntNamespacePaths.js'
import { validateNullByteFreeFields } from '../../utils/nullByteValidation.js'
import { expandPath } from '../../utils/path.js'
import { extractPDFPages, getPDFPageCount, readPDF } from '../../utils/pdf.js'
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from '../../utils/pdfUtils.js'
import { fileNotTextReadNotice } from '../../utils/permissions/fileStateGuard.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import {
  assertSymlinkResolutionsUnchangedForRead,
  stashCheckTimeResolutions,
} from '../../utils/permissions/symlinkResolutionStash.js'
import {
  FileTooLargeError,
  readFileInRange,
  SelectedRangeTooLargeError,
} from '../../utils/readFileInRange.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { containsVulnerableUncPath } from '../../utils/shell/readOnlyCommandValidation.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import {
  type AllowLargeRoom,
  buildTokenCapPartialView,
  BYTES_PER_TOKEN_FLOOR_DIVISOR,
  computeAllowLargeRoom,
  logAllowLargeEvent,
  ROUGH_LENGTH_TOKEN_RATIO,
  selectAllowLargeMessage,
} from './allowLarge.js'
import { readImageBytesCapped } from './imageRead.js'
import { getDefaultFileReadingLimits, MAX_IMAGE_READ_BYTES } from './limits.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
  renderPromptTemplate,
} from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'

// Device files that would hang the process: infinite output or blocking input.
// Checked by path only (no I/O). Safe devices like /dev/null are intentionally omitted.
const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output — never reach EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // Blocks waiting for input
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // Nonsensical to read
  '/dev/stdout',
  '/dev/stderr',
  // fd aliases for stdin/stdout/stderr
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true
  return false
}

// Narrow no-break space (U+202F) used by some macOS versions in screenshot filenames
const THIN_SPACE = String.fromCharCode(8239)

/**
 * Resolves macOS screenshot paths that may have different space characters.
 * macOS uses either regular space or thin space (U+202F) before AM/PM in screenshot
 * filenames depending on the macOS version. This function tries the alternate space
 * character if the file doesn't exist with the given path.
 *
 * @param filePath - The normalized file path to resolve
 * @returns The path to the actual file on disk (may differ in space character)
 */
/**
 * For macOS screenshot paths with AM/PM, the space before AM/PM may be a
 * regular space or a thin space depending on the macOS version.  Returns
 * the alternate path to try if the original doesn't exist, or undefined.
 */
function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = path.basename(filePath)
  const amPmPattern = /^(.+)([ \u202F])(AM|PM)(\.png)$/
  const match = filename.match(amPmPattern)
  if (!match) return undefined

  const currentSpace = match[2]
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' '
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  )
}

// File read listeners - allows other services to be notified when files are read
type FileReadListener = (filePath: string, content: string) => void
const fileReadListeners: FileReadListener[] = []

export function registerFileReadListener(
  listener: FileReadListener,
): () => void {
  fileReadListeners.push(listener)
  return () => {
    const i = fileReadListeners.indexOf(listener)
    if (i >= 0) fileReadListeners.splice(i, 1)
  }
}

export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
    // CC 2.1.296 #006: official `$de` gained a 3rd ctor arg (default "") whose
    // text is appended to the message — the allow_large selector suffix
    // (Aws/Bgo/Cws) added by the official `_hn` error transformer.
    suffix: string = '',
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.${suffix}`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

/**
 * Side-channel from call() to mapToolResultToToolResultBlockParam: the
 * PARTIAL-view notice for a truncated text read, keyed by the `data`
 * object identity. Keeps the notice out of the output schema (which
 * flows into SDK types) while still prepending it to the model-facing
 * tool_result content. Auto-GCs when the data object becomes unreachable.
 *
 * CC 2.1.296 #006: the official delivers this notice as a separate
 * `read_truncation_notice` attachment; OCC keeps the prepend channel
 * (documented divergence — see allowLarge.ts header).
 */
const partialViewNotices = new WeakMap<object, string>()

function partialViewNoticePrefix(data: object): string {
  return partialViewNotices.get(data) ?? ''
}

/**
 * CC 2.1.299 #126 — official BTn WeakMap (@227168072). When the fast-path
 * read classified the bytes as notText, the Read result carries the nHs
 * notice, APPENDED after the content (official
 * `fWr(e)=[BTn.get(e),$Tn.get(e)].filter(...).map(n=>`\n\n${n}`).join("")`).
 * Same identity-keyed side-channel as partialViewNotices — keeps the notice
 * out of the SDK output schema while delivering it to the model.
 */
const notTextNotices = new WeakMap<object, string>()

function notTextNoticeSuffix(data: object): string {
  const notice = notTextNotices.get(data)
  return notice === undefined ? '' : `\n\n${notice}`
}

/**
 * CC 2.1.296 #006 — official `_hn` @219149198 (verbatim):
 *   `function _hn(e,{room:n,optedIn:r,readMaxSizeBytes:s,ext:h}){
 *      let y,S,w;
 *      if(e instanceof r0e&&e.maxSizeBytes===s)
 *        w=n(),y=new r0e(e.sizeInBytes,e.maxSizeBytes,
 *                        Ave(w,r,{bytes:e.sizeInBytes})),
 *        S={totalBytes:e.sizeInBytes};
 *      else if(e instanceof LVe)
 *        w=n(),y=new LVe(e.selectedBytes,e.maxSelectedBytes,
 *                        Ave(w,r,{bytes:e.selectedBytes})),
 *        S={totalBytes:e.selectedBytes};
 *      else if(e instanceof $de)
 *        w=n(),y=new $de(e.tokenCount,e.maxTokens,
 *                        Ave(w,r,{tokens:e.tokenCount})),
 *        S={tokens:e.tokenCount};
 *      else return e;
 *      if(r){let H=w.roomTokens===void 0?"unavailable":"too_large";
 *            Chn(w,d(H),S,h)}
 *      return y}`
 *
 * Rebuilds the three read-limit error classes with the allow_large message
 * suffix and logs `tengu_file_read_allow_large` when the read was opted in.
 * `d` = fromEnum = identity, so outcome strings pass through raw.
 */
export function transformReadError(
  error: unknown,
  opts: {
    room: () => AllowLargeRoom
    optedIn: boolean
    readMaxSizeBytes: number
    ext?: string
  },
): unknown {
  let room: AllowLargeRoom
  let transformed: Error
  let extra: Record<string, unknown>
  if (
    error instanceof FileTooLargeError &&
    error.maxSizeBytes === opts.readMaxSizeBytes
  ) {
    room = opts.room()
    transformed = new FileTooLargeError(
      error.sizeInBytes,
      error.maxSizeBytes,
      selectAllowLargeMessage(room, opts.optedIn, { bytes: error.sizeInBytes }),
    )
    extra = { totalBytes: error.sizeInBytes }
  } else if (error instanceof SelectedRangeTooLargeError) {
    room = opts.room()
    transformed = new SelectedRangeTooLargeError(
      error.selectedBytes,
      error.maxSelectedBytes,
      selectAllowLargeMessage(room, opts.optedIn, {
        bytes: error.selectedBytes,
      }),
    )
    extra = { totalBytes: error.selectedBytes }
  } else if (error instanceof MaxFileReadTokenExceededError) {
    room = opts.room()
    transformed = new MaxFileReadTokenExceededError(
      error.tokenCount,
      error.maxTokens,
      selectAllowLargeMessage(room, opts.optedIn, { tokens: error.tokenCount }),
    )
    extra = { tokens: error.tokenCount }
  } else {
    return error
  }
  if (opts.optedIn) {
    const outcome = room.roomTokens === undefined ? 'unavailable' : 'too_large'
    logAllowLargeEvent(room, outcome, extra, opts.ext)
  }
  return transformed
}

/**
 * CC 2.1.296 #006 — official `khn` @219149776 (verbatim):
 *   `async function khn(e,n,r,s,h=!1,y=!1){
 *      let S=r??qW().maxTokens,w=uit(e,n),
 *          H=y&&w?Math.max(w,Math.ceil(Buffer.byteLength(e)/iOr)):w;
 *      if(!H||H<=S/4)return H||void 0;
 *      if(!h&&e.length>S*jgo)throw new $de(H,S);
 *      let V=await Wgt(e,s)??H;
 *      if(V>S)throw new $de(V,S);
 *      return V}`
 *
 * e=content, n=ext, r=maxTokens cap (already raised when applicable),
 * h=wholeFile, y=raised. uit ≡ roughTokenCountEstimationForFileType,
 * Wgt ≡ countTokensWithAPI. DIVERGENCE: the official passes credentials as
 * `s` to Wgt — OCC's countTokensWithAPI takes content only.
 */
export async function countReadTokensForRead(
  content: string,
  ext: string,
  maxTokens: number | undefined,
  wholeFile: boolean,
  raised: boolean,
): Promise<number | undefined> {
  const cap = maxTokens ?? getDefaultFileReadingLimits().maxTokens
  const rough = roughTokenCountEstimationForFileType(content, ext)
  const estimate =
    raised && rough
      ? Math.max(
          rough,
          Math.ceil(Buffer.byteLength(content) / BYTES_PER_TOKEN_FLOOR_DIVISOR),
        )
      : rough
  if (!estimate || estimate <= cap / 4) {
    return estimate || undefined
  }
  if (!wholeFile && content.length > cap * ROUGH_LENGTH_TOKEN_RATIO) {
    throw new MaxFileReadTokenExceededError(estimate, cap)
  }
  const counted = (await countTokensWithAPI(content)) ?? estimate
  if (counted > cap) {
    throw new MaxFileReadTokenExceededError(counted, cap)
  }
  return counted
}

// Common image extensions
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * Detects if a file path is a session-related file for analytics logging.
 * Only matches files within the Claude config directory (e.g., ~/.claude).
 * Returns the type of session file or null if not a session file.
 */
function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  const configDir = getClaudeConfigHomeDir()

  // Only match files within the Claude config directory
  if (!filePath.startsWith(configDir)) {
    return null
  }

  // Normalize path to use forward slashes for consistent matching across platforms
  const normalizedPath = filePath.split(win32.sep).join(posix.sep)

  // Session memory files: ~/.claude/session-memory/*.md (including summary.md)
  if (
    normalizedPath.includes('/session-memory/') &&
    normalizedPath.endsWith('.md')
  ) {
    return 'session_memory'
  }

  // Session JSONL transcript files: ~/.claude/projects/*/*.jsonl
  if (
    normalizedPath.includes('/projects/') &&
    normalizedPath.endsWith('.jsonl')
  ) {
    return 'session_transcript'
  }

  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
    pages: z
      .preprocess(
        // CC 2.1.295 changelog: "Fixed the Read tool rejecting calls with an
        // empty `pages` parameter instead of treating it as omitted" —
        // official schema field verbatim:
        // `pages:Yi((e)=>typeof e==="string"&&e.trim()===""?void 0:e,o().optional())`
        // (Yi ≡ z.preprocess): an empty/whitespace-only string is coerced to
        // undefined at the schema layer, BEFORE validateInput runs, so the
        // strict `if (pages !== undefined)` parse below never sees it.
        value =>
          typeof value === 'string' && value.trim() === '' ? undefined : value,
        z.string().optional(),
      )
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
    // CC 2.1.296 #006: official schema field @219133376 (verbatim, after
    // `pages`): `[hue]:$w(M().optional()).describe("Set to true to read a
    // text file, ...")`. $w ≡ semanticBoolean (z.preprocess 'true'/'false'
    // coercion with the optional INSIDE).
    allow_large: semanticBoolean(z.boolean().optional()).describe(
      'Set to true to read a text file, or a line range of one, that is over the usual size limits, up to what still fits in your context. Only use this when you genuinely need all of it or the user asked for the whole file; otherwise read it in parts with offset and limit, or search it.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => {
  // Define the media types supported for images
  const imageMediaTypes = z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ])

  return z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      file: z.object({
        filePath: z.string().describe('The path to the file that was read'),
        content: z.string().describe('The content of the file'),
        numLines: z
          .number()
          .describe('Number of lines in the returned content'),
        startLine: z.number().describe('The starting line number'),
        totalLines: z.number().describe('Total number of lines in the file'),
        // CC 2.1.296 #006: set when the text path fell back to a token-cap
        // PARTIAL view. NOTE: the official output object does NOT carry this
        // field (its notice travels via the read_truncation_notice attachment)
        // — OCC keeps it as a documented divergence for the prepend channel.
        truncatedByTokenCap: z
          .boolean()
          .optional()
          .describe('True when the content is a token-cap truncated page'),
      }),
    }),
    z.object({
      type: z.literal('image'),
      file: z.object({
        base64: z.string().describe('Base64-encoded image data'),
        type: imageMediaTypes.describe('The MIME type of the image'),
        originalSize: z.number().describe('Original file size in bytes'),
        dimensions: z
          .object({
            originalWidth: z
              .number()
              .optional()
              .describe('Original image width in pixels'),
            originalHeight: z
              .number()
              .optional()
              .describe('Original image height in pixels'),
            displayWidth: z
              .number()
              .optional()
              .describe('Displayed image width in pixels (after resizing)'),
            displayHeight: z
              .number()
              .optional()
              .describe('Displayed image height in pixels (after resizing)'),
          })
          .optional()
          .describe('Image dimension info for coordinate mapping'),
      }),
    }),
    z.object({
      type: z.literal('notebook'),
      file: z.object({
        filePath: z.string().describe('The path to the notebook file'),
        cells: z.array(z.any()).describe('Array of notebook cells'),
      }),
    }),
    z.object({
      type: z.literal('pdf'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        base64: z.string().describe('Base64-encoded PDF data'),
        originalSize: z.number().describe('Original file size in bytes'),
      }),
    }),
    z.object({
      type: z.literal('parts'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        originalSize: z.number().describe('Original file size in bytes'),
        count: z.number().describe('Number of pages extracted'),
        outputDir: z
          .string()
          .describe('Directory containing extracted page images'),
      }),
    }),
    z.object({
      type: z.literal('file_unchanged'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
      }),
    }),
  ])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// ── CC 2.1.292 §C5: Read stray-parameter coercion (official `_7n` port) ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Official `z6e` @214910800 (verbatim semantics): finite number → itself;
 * integer string (optional sign, surrounding whitespace tolerated) →
 * Number(value); anything else → undefined.
 */
function readNumericParam(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())) {
    return Number(value)
  }
  return undefined
}

/**
 * Official 2.1.292 Read coercer `_7n` @214910800 (docs/gap-research-293/
 * cluster-c-h-carryover.md §C5):
 *   - single-element offset/limit arrays are unwrapped (offset_array/limit_array)
 *   - negative offset is dropped (offset_neg)
 *   - non-positive limit is dropped (limit_dropped)
 *   - legacy `length` migrates to `limit` when limit is absent, and is always
 *     deleted (length)
 *   - a stray `description` parameter is dropped (drop_description)
 * offset/limit are only READ through z6e for the sign checks — raw values are
 * preserved (numeric strings are coerced later by the schema's
 * semanticNumber); only the `length` migration writes a z6e number.
 * Returns null when nothing changed; operates on a shallow copy so the
 * API-bound input is never mutated. Official wiring @214918706:
 * `coerceInput:_7n` — direct, no pH safeParse gate, no feature flag, no
 * resultNote (silent coercion; shapeClass telemetry only, via
 * tengu_tool_input_coerced in toolExecution.ts).
 */
export function coerceReadInput(raw: unknown): {
  input: Record<string, unknown>
  shapeClass: string
} | null {
  if (!isRecord(raw)) return null
  const n: Record<string, unknown> = { ...raw }
  const shapeClasses: string[] = []
  if (Array.isArray(n.offset) && n.offset.length === 1) {
    n.offset = n.offset[0]
    shapeClasses.push('offset_array')
  }
  if (Array.isArray(n.limit) && n.limit.length === 1) {
    n.limit = n.limit[0]
    shapeClasses.push('limit_array')
  }
  const offset = readNumericParam(n.offset)
  if (offset !== undefined && offset < 0) {
    delete n.offset
    shapeClasses.push('offset_neg')
  }
  const limit = readNumericParam(n.limit)
  if (limit !== undefined && limit <= 0) {
    delete n.limit
    shapeClasses.push('limit_dropped')
  }
  if ('length' in n) {
    const length = readNumericParam(n.length)
    // Checked AFTER limit_dropped: official reads `!("limit"in n)` at this
    // point, so {limit:0,length:5} migrates to limit:5.
    if (!('limit' in n) && length !== undefined && length > 0) {
      n.limit = length
    }
    delete n.length
    shapeClasses.push('length')
  }
  if (Object.hasOwn(n, 'description')) {
    delete n.description
    shapeClasses.push('drop_description')
  }
  return shapeClasses.length
    ? { input: n, shapeClass: shapeClasses.join(',') }
    : null
}

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: 'read files, images, PDFs, notebooks',
  // Output is bounded by maxTokens (validateContentTokens). Persisting to a
  // file the model reads back with Read is circular — never persist.
  maxResultSizeChars: Infinity,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    const limits = getDefaultFileReadingLimits()
    const maxSizeInstruction = limits.includeMaxSizeInPrompt
      ? `. Files larger than ${formatFileSize(limits.maxSizeBytes)} will return an error; use offset and limit for larger files`
      : ''
    const offsetInstruction = limits.targetedRangeNudge
      ? OFFSET_INSTRUCTION_TARGETED
      : OFFSET_INSTRUCTION_DEFAULT
    return renderPromptTemplate(
      pickLineFormatInstruction(),
      maxSizeInstruction,
      offsetInstruction,
    )
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Official v2.1.292 Read tool def @214918706 (verbatim): `coerceInput:_7n`
  // — wired DIRECT: no pH safeParse gate, no feature flag, and no
  // coerceInputBeforePluginHooks flag (unlike the Write tool, which uses all
  // three). Silent coercion; shapeClass telemetry only, no resultNote.
  coerceInput: coerceReadInput,
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Reading ${summary}` : 'Reading file'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.file_path
  },
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  getPath({ file_path }): string {
    return file_path || getCwd()
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    // CC 2.1.251 (Gap-109a): stash the check-time symlink resolutions of
    // the target path, read lane (binary FileReadTool NI/FI stash site).
    stashCheckTimeResolutions(context, FileReadTool.getPath(input), 'read')
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      FileReadTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  // UI.tsx:140 — ALL types render summary chrome only: "Read N lines",
  // "Read image (42KB)". Never the content itself. The model-facing
  // serialization (below) sends content + CYBER_RISK_MITIGATION_REMINDER
  // + line prefixes; UI shows none of it. Nothing to index. Caught by
  // the render-fidelity test when this initially claimed file.content.
  extractSearchText() {
    return ''
  },
  renderToolUseErrorMessage,
  async validateInput({ file_path, pages }, toolUseContext: ToolUseContext) {
    // CC 2.1.281 #040 (official fy(lt,[["file_path",g]]) @201304178): the
    // null-byte check runs FIRST (before the pages validation), returning a
    // per-call validation error (errorCode 2) — the expandPath throw would
    // otherwise end the whole turn.
    const nullByteCheck = validateNullByteFreeFields(FILE_READ_TOOL_NAME, [
      ['file_path', file_path],
    ])
    if (nullByteCheck !== null) {
      return nullByteCheck
    }
    // Validate pages parameter (pure string parsing, no I/O)
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        return {
          result: false,
          message: `Invalid pages parameter: "${pages}". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.`,
          errorCode: 7,
        }
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        return {
          result: false,
          message: `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
          errorCode: 8,
        }
      }
    }

    // Path expansion + deny rule check (no I/O)
    const fullFilePath = expandPath(file_path)

    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule !== null) {
      // Official 2.1.269 (E29): binary v269 FileReadTool
      // `{result:!1,message:Iit,errorCode:1,deniedByPermissionRule:!0}`.
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
        deniedByPermissionRule: true,
      }
    }

    // CC 2.1.281 #033 (security): on macOS, deny automount (/net, /Network)
    // and kernel-resolved (/.vol, /.file, /.nofollow, /.resolve) prefixes
    // before any filesystem operation — stat/lstat on these can trigger a
    // directory-service lookup and mount to a remote host. Darwin-gated no-op
    // elsewhere. Official deny sentence @97322030.
    if (shouldDenyMacosNetworkMountPath(fullFilePath)) {
      return {
        result: false,
        message: macosNetworkMountDenyMessage(file_path),
        errorCode: 1,
      }
    }

    // SECURITY (CC 2.1.292, official changelog): "Fixed PreToolUse hook
    // approvals and auto mode bypassing the permission prompt for file reads
    // from network (UNC) paths." Official fix = a hard pre-I/O REJECT inside
    // read_file (binary `rtn` gate, `kr.untrusted_unc` reason map) emitting the
    // verbatim reason string below. A validateInput reject cannot be
    // short-circuited by a PreToolUse hook 'allow' or by auto/bypass mode, and
    // no filesystem access (stat/open that could leak NTLM credentials) ever
    // happens. Detection = the prefix checks (platform-independent, keeps
    // POSIX `//host` coverage) + containsVulnerableUncPath (Windows-gated
    // anywhere-match: DavWWWRoot, @SSL@ ports, mixed separators — same
    // platform gating as the official detection).
    // Documented divergence from official (security-cluster-292.md §1.3 KISS
    // option (ii)): OCC has no trustedNetworkDirectories settings field, so
    // ALL UNC reads are rejected here — no trusted-network allowance lane.
    const isUncPath =
      fullFilePath.startsWith('\\\\') ||
      fullFilePath.startsWith('//') ||
      containsVulnerableUncPath(fullFilePath)
    if (isUncPath) {
      return {
        result: false,
        message:
          'read_file: untrusted UNC path rejected before filesystem access',
        errorCode: 1,
      }
    }

    // SECURITY: NT-namespace device paths (\??\..., \Device\..., etc.) are
    // rejected before any filesystem access (CC 2.1.234, byte-verified). They
    // resolve through the Windows kernel object manager rather than normal
    // path resolution and can bypass string-based path checks.
    if (isNtNamespacePath(fullFilePath)) {
      return {
        result: false,
        message: 'read_file: NT-namespace path rejected before filesystem access',
        errorCode: 1,
      }
    }

    // Binary extension check (string check on extension only, no I/O).
    // PDF, images, and SVG are excluded - this tool renders them natively.
    const ext = path.extname(fullFilePath).toLowerCase()
    if (
      hasBinaryExtension(fullFilePath) &&
      !isPDFExtension(ext) &&
      !IMAGE_EXTENSIONS.has(ext.slice(1))
    ) {
      return {
        result: false,
        // CC 2.1.291 (G#5): byte-verified official 291 wording — the tail now
        // points at a skill / shell command instead of the 289 "Please use
        // appropriate tools for binary file analysis." errorCode (4), the first
        // sentence, and the ${ext} interpolation are unchanged.
        message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Use a skill for this file type if one is available, or a shell command or script that can read the format.`,
        errorCode: 4,
      }
    }

    // Block specific device files that would hang (infinite output or blocking input).
    // This is a path-based check with no I/O — safe special files like /dev/null are allowed.
    if (isBlockedDevicePath(fullFilePath)) {
      return {
        result: false,
        // CC 2.1.291 (G#9): the interpolated path is escaped — byte-verified
        // official `Cannot read '${ad(g)}': this device file…` (ad =
        // escapeControlCharsAsEntities), so a control char in the path cannot
        // break the single-line message. Identity for normal device paths.
        message: `Cannot read '${escapeControlCharsAsEntities(file_path)}': this device file would block or produce infinite output.`,
        errorCode: 9,
      }
    }

    return { result: true }
  },
  async call(
    { file_path, offset = 1, limit = undefined, pages, allow_large },
    context,
    _canUseTool?,
    parentMessage?,
  ) {
    const { readFileState, fileReadingLimits } = context

    const defaults = getDefaultFileReadingLimits()
    const maxSizeBytes =
      fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
    const maxTokens = fileReadingLimits?.maxTokens ?? defaults.maxTokens

    // CC 2.1.296 #006: official `nOr` entry @219145200 —
    //   `Fe=()=>lOr(y,S,{maxSizeBytes:Re,maxTokens:Pe}),He=h?Fe():void 0`
    // The room closure is computed lazily (fresh each call — the room
    // shrinks as sibling reads claim tokens); `allowLarge` is the opt-in
    // snapshot taken ONCE at entry and carried into the text path.
    const computeRoom = (): AllowLargeRoom =>
      computeAllowLargeRoom(context, parentMessage, { maxSizeBytes, maxTokens })
    const allowLarge = allow_large ? computeRoom() : undefined

    // Telemetry: track when callers override default read limits.
    // Only fires on override (low volume) — event count = override frequency.
    if (fileReadingLimits !== undefined) {
      logEvent('tengu_file_read_limits_override', {
        hasMaxTokens: fileReadingLimits.maxTokens !== undefined,
        hasMaxSizeBytes: fileReadingLimits.maxSizeBytes !== undefined,
      })
    }

    const ext = path.extname(file_path).toLowerCase().slice(1)
    // Use expandPath for consistent path normalization with FileEditTool/FileWriteTool
    // (especially handles whitespace trimming and Windows path separators)
    const fullFilePath = expandPath(file_path)

    // CC 2.1.251 (Gap-109a): TOCTOU gate — the symlink resolution set must
    // be unchanged since checkPermissions stashed it (binary Uzt first gate).
    assertSymlinkResolutionsUnchangedForRead(context, fullFilePath)

    // Dedup: if we've already read this exact range and the file hasn't
    // changed on disk, return a stub instead of re-sending the full content.
    // The earlier Read tool_result is still in context — two full copies
    // waste cache_creation tokens on every subsequent turn. BQ proxy shows
    // ~18% of Read calls are same-file collisions (up to 2.64% of fleet
    // cache_creation). Only applies to text/notebook reads — images/PDFs
    // aren't cached in readFileState so won't match here.
    //
    // Ant soak: 1,734 dedup hits in 2h, no Read error regression.
    // Killswitch pattern: GB can disable if the stub message confuses
    // the model externally.
    // 3P default: killswitch off = dedup enabled. Client-side only — no
    // server support needed, safe for Bedrock/Vertex/Foundry.
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_read_dedup_killswitch',
      false,
    )
    const existingState = dedupKillswitch
      ? undefined
      : readFileState.get(fullFilePath)
    // Only dedup entries that came from a prior Read (offset is always set
    // by Read). Edit/Write store offset=undefined — their readFileState
    // entry reflects post-edit mtime, so deduping against it would wrongly
    // point the model at the pre-edit Read content.
    // CC 2.1.295: official gate is verbatim
    // `if(Je&&!Je.isPartialView&&!Je.contentNotInModelContext&&Je.offset!==void 0)`
    // — entries seeded from a Bash read the model never saw (grep-family or
    // persisted/truncated output) must NOT produce the file_unchanged stub;
    // the content is re-sent instead.
    if (
      existingState &&
      !existingState.isPartialView &&
      !existingState.contentNotInModelContext &&
      existingState.offset !== undefined
    ) {
      const rangeMatch =
        existingState.offset === offset && existingState.limit === limit
      if (rangeMatch) {
        try {
          const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
          if (mtimeMs === existingState.timestamp) {
            const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
            logEvent('tengu_file_read_dedup', {
              ...(analyticsExt !== undefined && { ext: analyticsExt }),
            })
            return {
              data: {
                type: 'file_unchanged' as const,
                file: { filePath: file_path },
              },
            }
          }
        } catch {
          // stat failed — fall through to full read
        }
      }
    }

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          context.dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([fullFilePath], cwd)
    }

    try {
      return await callInner(
        file_path,
        fullFilePath,
        fullFilePath,
        ext,
        offset,
        limit,
        pages,
        maxSizeBytes,
        maxTokens,
        readFileState,
        context,
        parentMessage?.message.id,
        computeRoom,
        allowLarge,
      )
    } catch (error) {
      // Handle file-not-found: suggest similar files
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        // macOS screenshots may use a thin space or regular space before
        // AM/PM — try the alternate before giving up.
        const altPath = getAlternateScreenshotPath(fullFilePath)
        if (altPath) {
          try {
            return await callInner(
              file_path,
              fullFilePath,
              altPath,
              ext,
              offset,
              limit,
              pages,
              maxSizeBytes,
              maxTokens,
              readFileState,
              context,
              parentMessage?.message.id,
              computeRoom,
              allowLarge,
            )
          } catch (altError) {
            if (!isENOENT(altError)) {
              throw altError
            }
            // Alt path also missing — fall through to friendly error
          }
        }

        const similarFilename = findSimilarFile(fullFilePath)
        const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
        if (cwdSuggestion) {
          message += ` Did you mean ${cwdSuggestion}?`
        } else if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
        // CC 2.1.291 (G#9): the official escapes the WHOLE assembled message
        // once at the throw boundary — byte-verified `new P(ad(Wt),"File does
        // not exist")` — so a control char reaching the message via a suggested
        // path cannot forge extra lines. Identity for control-char-free text.
        throw new Error(escapeControlCharsAsEntities(message))
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    switch (data.type) {
      case 'image': {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                data: data.file.base64,
                media_type: data.file.type,
              },
            },
          ],
        }
      }
      case 'notebook':
        return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
      case 'pdf':
        // Return PDF metadata only - the actual content is sent as a supplemental DocumentBlockParam
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF file read: ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'parts':
        // Extracted page images are read and sent as image blocks in mapToolResultToAPIMessage
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF pages extracted: ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'file_unchanged':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: FILE_UNCHANGED_STUB,
        }
      case 'text': {
        // 2.1.208 #14a / 2.1.210: 4-case mapper (was 2-case). Distinguishes
        // a file with blank lines (case 2) from an empty file (case 3) from a
        // file shorter than the requested offset (case 4).
        let content: string

        if (data.file.content) {
          content =
            partialViewNoticePrefix(data) +
            memoryFileFreshnessPrefix(data) +
            formatFileLines(data.file) +
            (shouldIncludeFileReadMitigation()
              ? CYBER_RISK_MITIGATION_REMINDER
              : '') +
            notTextNoticeSuffix(data)
        } else if (data.file.numLines >= 1 && data.file.totalLines > 1) {
          // Case 2: the range has ≥1 line but content is empty (blank lines).
          // Show a single line-numbered empty line: jxn("", startLine, "\t").
          content =
            partialViewNoticePrefix(data) +
            memoryFileFreshnessPrefix(data) +
            `${data.file.startLine}\t` +
            notTextNoticeSuffix(data)
        } else if (data.file.numLines >= 1 || data.file.totalLines === 0) {
          // Case 3: empty file (0 bytes → numLines≥1 via final fragment, or
          // totalLines===0). Previously reported "shorter than offset" for
          // empty files read with the default offset — the #14a bug.
          content =
            '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
        } else {
          // Case 4: offset beyond the file's line count.
          content = `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} lines.</system-reminder>`
        }

        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content,
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function pickLineFormatInstruction(): string {
  return LINE_FORMAT_INSTRUCTION
}

/** Format file content with line numbers. */
function formatFileLines(file: { content: string; startLine: number }): string {
  return addLineNumbers(file)
}

// 2.1.126: Removed the per-file malware-assessment system-reminder that was
// appended to every file read. It caused spurious refusals and "this is not
// malware" commentary on legacy models. The constant is kept (empty) for
// backward-compat with any code that references it.
export const CYBER_RISK_MITIGATION_REMINDER = ''

// Models where cyber risk mitigation should be skipped
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6'])

function shouldIncludeFileReadMitigation(): boolean {
  // 2.1.126: Always skip — the reminder is no longer appended.
  return false
}

/**
 * Side-channel from call() to mapToolResultToToolResultBlockParam: mtime
 * of auto-memory files, keyed by the `data` object identity. Avoids
 * adding a presentation-only field to the output schema (which flows
 * into SDK types) and avoids sync fs in the mapper. WeakMap auto-GCs
 * when the data object becomes unreachable after rendering.
 */
const memoryFileMtimes = new WeakMap<object, number>()

function memoryFileFreshnessPrefix(data: object): string {
  const mtimeMs = memoryFileMtimes.get(data)
  if (mtimeMs === undefined) return ''
  return memoryFreshnessNote(mtimeMs)
}

async function validateContentTokens(
  content: string,
  ext: string,
  maxTokens?: number,
): Promise<void> {
  const effectiveMaxTokens =
    maxTokens ?? getDefaultFileReadingLimits().maxTokens

  const tokenEstimate = roughTokenCountEstimationForFileType(content, ext)
  if (!tokenEstimate || tokenEstimate <= effectiveMaxTokens / 4) return

  const tokenCount = await countTokensWithAPI(content)
  const effectiveCount = tokenCount ?? tokenEstimate

  if (effectiveCount > effectiveMaxTokens) {
    throw new MaxFileReadTokenExceededError(effectiveCount, effectiveMaxTokens)
  }
}

type ImageResult = {
  type: 'image'
  file: {
    base64: string
    type: Base64ImageSource['media_type']
    originalSize: number
    dimensions?: ImageDimensions
  }
}

function createImageResponse(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
  dimensions?: ImageDimensions,
): ImageResult {
  return {
    type: 'image',
    file: {
      base64: buffer.toString('base64'),
      type: `image/${mediaType}` as Base64ImageSource['media_type'],
      originalSize,
      dimensions,
    },
  }
}

/**
 * 2.1.281 #031: kill-switch gating the whole-document pdftoppm pre-render for
 * large/unsupported-model PDFs. Upstream: `jn=(!lRt()||yn.size>OTo)&&
 * !x("tengu_deep_starlight",!0)` (v281 @201315570) — the flag defaults ON,
 * so the whole-doc render (up to a 2-minute stall before the first token) is
 * SKIPPED by default; only explicit page-range reads render. Flipping the
 * gate OFF (remote eval / CLAUDE_INTERNAL_FC_OVERRIDES) restores the v280
 * unconditional pre-render.
 */
const TENGU_DEEP_STARLIGHT_GATE = 'tengu_deep_starlight'
const DEEP_STARLIGHT_GATE_DEFAULT = true

/**
 * 2.1.281 #031/#032: PDF-read outcome telemetry. Mirrors upstream
 * `YR(start,{request,render,outcome,fileBytes,documentPages,pagesRendered})`
 * → `q("info","cli_pdf_read",{...})` (v281 @201310256). OCC routes it through
 * the diagnostics logger — the fields are enums/counts/byte sizes, never
 * paths or content, so the NoPII contract holds.
 */
const PDF_READ_OUTCOME_LOG_EVENT = 'cli_pdf_read'

type PdfReadOutcome = {
  request: 'whole_file' | 'page_range'
  render: string
  outcome: string
  fileBytes: number | null
  documentPages: number | null
  pagesRendered: number | null
}

function logPdfReadOutcome(startedAt: number, o: PdfReadOutcome): void {
  logForDiagnosticsNoPII('info', PDF_READ_OUTCOME_LOG_EVENT, {
    request: o.request,
    render: o.render,
    outcome: o.outcome,
    file_bytes: o.fileBytes,
    document_pages: o.documentPages,
    pages_rendered: o.pagesRendered,
    duration_ms: Date.now() - startedAt,
  })
}

/**
 * Inner implementation of call, separated to allow ENOENT handling in the outer call.
 */
async function callInner(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
  maxSizeBytes: number,
  maxTokens: number,
  readFileState: ToolUseContext['readFileState'],
  context: ToolUseContext,
  messageId: string | undefined,
  // CC 2.1.296 #006: official `Ft` object @219147380 carries `room:Fe`
  // (lazy fresh-room closure) + `allowLarge:He` (entry snapshot) into the
  // text path — flattened to two trailing params here.
  room: () => AllowLargeRoom,
  allowLarge: AllowLargeRoom | undefined,
): Promise<{
  data: Output
  newMessages?: ReturnType<typeof createUserMessage>[]
}> {
  // --- Notebook ---
  if (ext === 'ipynb') {
    const cells = await readNotebook(resolvedFilePath)
    const cellsJson = jsonStringify(cells)

    const cellsJsonBytes = Buffer.byteLength(cellsJson)
    if (cellsJsonBytes > maxSizeBytes) {
      throw new Error(
        `Notebook content (${formatFileSize(cellsJsonBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
          `Use ${BASH_TOOL_NAME} with jq to read specific portions:\n` +
          `  cat "${file_path}" | jq '.cells[:20]' # First 20 cells\n` +
          `  cat "${file_path}" | jq '.cells[100:120]' # Cells 100-120\n` +
          `  cat "${file_path}" | jq '.cells | length' # Count total cells\n` +
          `  cat "${file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`,
      )
    }

    await validateContentTokens(cellsJson, ext, maxTokens)

    // Get mtime via async stat (single call, no prior existence check)
    const stats = await getFsImplementation().stat(resolvedFilePath)
    readFileState.set(fullFilePath, {
      content: cellsJson,
      timestamp: Math.floor(stats.mtimeMs),
      offset,
      limit,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    const data = {
      type: 'notebook' as const,
      file: { filePath: file_path, cells },
    }

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: cellsJson,
    })

    return { data }
  }

  // --- Image (single read, no double-read) ---
  if (IMAGE_EXTENSIONS.has(ext)) {
    // Images have their own size limits (token budget + compression) —
    // don't apply the text maxSizeBytes cap.
    const data = await readImageWithTokenBudget(resolvedFilePath, maxTokens)
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: data.file.base64,
    })

    const metadataText = data.file.dimensions
      ? createImageMetadataText(data.file.dimensions)
      : null

    return {
      data,
      ...(metadataText && {
        newMessages: [
          createUserMessage({ content: metadataText, isMeta: true }),
        ],
      }),
    }
  }

  // --- PDF ---
  if (isPDFExtension(ext)) {
    // 2.1.281 #031: outcome-telemetry clock (upstream `So=Date.now()`
    // @201312908) — every cli_pdf_read entry carries duration_ms from here.
    const pdfReadStartedAt = Date.now()
    if (pages) {
      const parsedRange = parsePDFPageRange(pages)
      // 2.1.281 #032: per-PDF-read abort child derived from the tool-call
      // abort signal (upstream: `pdfAbortParent` → deriveChild →
      // `pdfRenderSignal`, renders use `pdfRenderSignal ?? signal`, v281
      // @203617282). On tool interrupt the pdftoppm child is killed
      // immediately instead of running up to its 120s timeout ceiling.
      const { signal: pdfRenderSignal, cleanup: cleanupPdfRenderSignal } =
        createCombinedAbortSignal(context.abortController.signal)
      let extractResult: Awaited<ReturnType<typeof extractPDFPages>>
      try {
        extractResult = await extractPDFPages(resolvedFilePath, {
          ...(parsedRange ?? {}),
          signal: pdfRenderSignal,
        })
      } catch (error) {
        // v281 @201312794: catch → outcome log (aborted vs threw) → rethrow.
        const render = isAbortError(error) ? 'aborted' : 'threw'
        logPdfReadOutcome(pdfReadStartedAt, {
          request: 'page_range',
          render,
          outcome: render,
          fileBytes: null,
          documentPages: null,
          pagesRendered: null,
        })
        throw error
      } finally {
        cleanupPdfRenderSignal()
      }
      if (!extractResult.success) {
        // strictNullChecks is off in this repo, so the false-branch of the
        // PDFResult union doesn't narrow — pin the failure variant explicitly.
        const failure = extractResult as Extract<
          typeof extractResult,
          { success: false }
        >
        const reason = failure.error.reason
        logPdfReadOutcome(pdfReadStartedAt, {
          request: 'page_range',
          render: reason === 'aborted' ? 'aborted' : `failed_${reason}`,
          outcome: reason,
          fileBytes: null,
          documentPages: null,
          pagesRendered: null,
        })
        throw new Error(failure.error.message)
      }
      logEvent('tengu_pdf_page_extraction', {
        success: true,
        pageCount: extractResult.data.file.count,
        fileSize: extractResult.data.file.originalSize,
        hasPageRange: true,
      })
      logPdfReadOutcome(pdfReadStartedAt, {
        request: 'page_range',
        render: 'ok',
        outcome: 'ok',
        fileBytes: extractResult.data.file.originalSize,
        documentPages: null,
        pagesRendered: extractResult.data.file.count,
      })
      logFileOperation({
        operation: 'read',
        tool: 'FileReadTool',
        filePath: fullFilePath,
        content: `PDF pages ${pages}`,
      })
      // const binding: keeps the success-variant narrowing valid inside the
      // image-mapping closure below (`let extractResult` would lose it).
      const extractedPages = extractResult.data
      const entries = await readdir(extractedPages.file.outputDir)
      const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
      const imageBlocks = await Promise.all(
        imageFiles.map(async f => {
          const imgPath = path.join(extractedPages.file.outputDir, f)
          const imgBuffer = await readFileAsync(imgPath)
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imgBuffer,
            imgBuffer.length,
            'jpeg',
          )
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              data: resized.buffer.toString('base64'),
            },
          }
        }),
      )
      return {
        data: extractedPages,
        ...(imageBlocks.length > 0 && {
          newMessages: [
            createUserMessage({ content: imageBlocks, isMeta: true }),
          ],
        }),
      }
    }

    const pageCount = await getPDFPageCount(resolvedFilePath)
    if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      throw new Error(
        `This PDF has ${pageCount} pages, which is too many to read at once. ` +
          `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
          `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      )
    }

    const fs = getFsImplementation()
    const stats = await fs.stat(resolvedFilePath)
    // 2.1.281 #031 (v281 @201315570): the whole-document pre-render is gated
    // behind the tengu_deep_starlight kill-switch — upstream
    // `jn=(!lRt()||yn.size>OTo)&&!x("tengu_deep_starlight",!0)`. The flag
    // defaults ON ⇒ whole-doc render SKIPPED by default (v280 @198493712
    // rendered unconditionally — up to a 2-minute stall before responding on
    // >3MB PDFs). render/pagesRendered track the `Nn`/`fn` telemetry state.
    let wholeDocRender = 'none'
    let wholeDocPagesRendered: number | null = null
    const shouldExtractPages =
      (!isPDFSupported() || stats.size > PDF_EXTRACT_SIZE_THRESHOLD) &&
      !getFeatureValue_CACHED_MAY_BE_STALE(
        TENGU_DEEP_STARLIGHT_GATE,
        DEEP_STARLIGHT_GATE_DEFAULT,
      )

    if (shouldExtractPages) {
      // #032: same per-read abort child as the page-range path — render uses
      // `pdfRenderSignal ?? signal` upstream (v281 @201315789).
      const { signal: pdfRenderSignal, cleanup: cleanupPdfRenderSignal } =
        createCombinedAbortSignal(context.abortController.signal)
      try {
        const extractResult = await extractPDFPages(resolvedFilePath, {
          signal: pdfRenderSignal,
        })
        if (extractResult.success) {
          wholeDocRender = 'ok'
          wholeDocPagesRendered = extractResult.data.file.count
          logEvent('tengu_pdf_page_extraction', {
            success: true,
            pageCount: extractResult.data.file.count,
            fileSize: extractResult.data.file.originalSize,
          })
        } else {
          // strictNullChecks off: false-branch doesn't narrow — pin it.
          const failure = extractResult as Extract<
            typeof extractResult,
            { success: false }
          >
          const reason = failure.error.reason
          wholeDocRender =
            reason === 'aborted' ? 'aborted' : `failed_${reason}`
          logEvent('tengu_pdf_page_extraction', {
            success: false,
            available: reason !== 'unavailable',
            fileSize: stats.size,
          })
          if (reason === 'aborted') {
            // Abort-family: log the outcome and re-run the fallback path
            // (whole-doc readPDF below) instead of failing the read.
            logPdfReadOutcome(pdfReadStartedAt, {
              request: 'whole_file',
              render: 'aborted',
              outcome: 'aborted',
              fileBytes: stats.size,
              documentPages: pageCount,
              pagesRendered: null,
            })
          }
        }
      } catch (error) {
        // v281 @201315570 catch: classify abort-family vs threw + outcome log.
        // Upstream rethrows; OCC re-runs the fallback for abort-family errors
        // (the outer at-mention handler upstream does the same re-run) and
        // rethrows anything else.
        wholeDocRender = isAbortError(error) ? 'aborted' : 'threw'
        logPdfReadOutcome(pdfReadStartedAt, {
          request: 'whole_file',
          render: wholeDocRender,
          outcome: wholeDocRender,
          fileBytes: stats.size,
          documentPages: pageCount,
          pagesRendered: null,
        })
        if (wholeDocRender !== 'aborted') {
          throw error
        }
      } finally {
        cleanupPdfRenderSignal()
      }
    }

    if (!isPDFSupported()) {
      // v281 @201315789: outcome log before the unsupported-model throw.
      logPdfReadOutcome(pdfReadStartedAt, {
        request: 'whole_file',
        render: wholeDocRender,
        outcome: 'unsupported_model',
        fileBytes: stats.size,
        documentPages: pageCount,
        pagesRendered: wholeDocPagesRendered,
      })
      throw new Error(
        'Reading full PDFs is not supported with this model. Use a newer model (Sonnet 3.5 v2 or later), ' +
          `or use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
          'Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.',
      )
    }

    let readResult: Awaited<ReturnType<typeof readPDF>>
    try {
      readResult = await readPDF(resolvedFilePath)
    } catch (error) {
      // v281 @201316222: whole-file read failure outcome log, then rethrow.
      logPdfReadOutcome(pdfReadStartedAt, {
        request: 'whole_file',
        render: wholeDocRender,
        outcome: 'threw',
        fileBytes: stats.size,
        documentPages: pageCount,
        pagesRendered: wholeDocPagesRendered,
      })
      throw error
    }
    // v281 @201316807: final outcome log (ok | error reason).
    // strictNullChecks off: false-branch doesn't narrow — pin it.
    const readFailure = readResult as Extract<
      typeof readResult,
      { success: false }
    >
    logPdfReadOutcome(pdfReadStartedAt, {
      request: 'whole_file',
      render: wholeDocRender,
      outcome: readResult.success ? 'ok' : readFailure.error.reason,
      fileBytes: stats.size,
      documentPages: pageCount,
      pagesRendered: wholeDocPagesRendered,
    })
    if (!readResult.success) {
      throw new Error(readFailure.error.message)
    }
    const pdfData = readResult.data
    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: pdfData.file.base64,
    })

    return {
      data: pdfData,
      newMessages: [
        createUserMessage({
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfData.file.base64,
              },
            },
          ],
          isMeta: true,
        }),
      ],
    }
  }

  // --- Text file (single async read via readFileInRange) ---
  // CC 2.1.296 #006: official text path `dOr` @219156400-219161350. Locals
  // map to the minified names: Pe=raisedMaxSizeBytes, Fe=raisedMaxTokens,
  // He=analyticsExt, Ve=errorTransformOpts, an=wholeFile, Wt=content,
  // Vt=finalContent, dt=lineCount→shownLines, Ze=totalLines, ut=totalBytes,
  // Rt=readBytes, vt=mtimeMs, Sn=countedTokens, Cn=partialNotice, Y=allowLarge.
  const raisedMaxSizeBytes = allowLarge?.raised?.maxSizeBytes ?? maxSizeBytes
  const raisedMaxTokens = allowLarge?.raised?.maxTokens ?? maxTokens
  const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
  const errorTransformOpts = {
    room,
    optedIn: allowLarge !== undefined,
    readMaxSizeBytes: raisedMaxSizeBytes,
    ext: analyticsExt,
  }
  const lineOffset = offset === 0 ? 0 : offset - 1
  // 2.1.208 #30 + CC 2.1.296 #006: for ranged reads (limit defined), pass
  // maxSelectedBytes so readFileInRange can reject a single extremely long
  // line (no newline) that would otherwise balloon memory. Official v296:
  // `{maxSelectedBytes:Math.max(G*jgo,Y?.raised?.maxSizeBytes??0)}` — the
  // raised byte cap widens the range budget when allow_large opted in.
  const readOptions =
    limit === undefined
      ? undefined
      : {
          maxSelectedBytes: Math.max(
            maxTokens * ROUGH_LENGTH_TOKEN_RATIO,
            allowLarge?.raised?.maxSizeBytes ?? 0,
          ),
        }
  const {
    content,
    lineCount,
    totalLines,
    totalBytes,
    readBytes,
    mtimeMs,
    notText,
  } = await readFileInRange(
      resolvedFilePath,
      lineOffset,
      limit,
      limit === undefined ? raisedMaxSizeBytes : undefined,
      context.abortController.signal,
      readOptions,
    ).catch((error: unknown) => {
      throw transformReadError(error, errorTransformOpts)
    })

  // Official `an=(y??1)<=1&&S===void 0&&w===void 0` — the token-cap PARTIAL
  // view only applies to whole-file reads; ranged reads keep the throw path
  // (via transformReadError → suffix + telemetry).
  const wholeFile = offset <= 1 && limit === undefined && pages === undefined

  let countedTokens: number | undefined
  let finalContent = content
  let shownLines = lineCount
  let paged = false
  let partialNotice: string | undefined
  try {
    // Official: `khn(Y?.raised?Q5e({content:Wt,startLine:Math.max(1,y),
    // tabAwareSeparator:VYe()}):Wt,h,Fe,he.credentials,an,Y?.raised!==void 0)`
    // — when the caps were raised, the token count is measured on the
    // LINE-NUMBERED content (that is what the model receives). OCC
    // divergence: addLineNumbers has no tabAwareSeparator param and
    // countTokensWithAPI takes no credentials.
    countedTokens = await countReadTokensForRead(
      allowLarge?.raised
        ? addLineNumbers({ content, startLine: Math.max(1, offset) })
        : content,
      ext,
      raisedMaxTokens,
      wholeFile,
      allowLarge?.raised !== undefined,
    )
    if (allowLarge?.raised && countedTokens !== undefined) {
      // Official: `let mo=V().raised?.maxTokens??G;if(Sn>mo)throw new $de(Sn,
      // mo);he.contextRoom()?.claim(Sn)` — re-check against FRESH room
      // (sibling large reads in the same turn share it), then claim.
      const freshCap = room().raised?.maxTokens ?? maxTokens
      if (countedTokens > freshCap) {
        throw new MaxFileReadTokenExceededError(countedTokens, freshCap)
      }
      context.contextRoom?.()?.claim(countedTokens)
    }
  } catch (error) {
    if (error instanceof MaxFileReadTokenExceededError && wholeFile) {
      // Official `dOr` catch branch — build the best-fitting first page
      // instead of failing the whole read.
      countedTokens = error.tokenCount
      const view = buildTokenCapPartialView({
        filePath: fullFilePath,
        content,
        tokenCount: error.tokenCount,
        baseMaxTokens: maxTokens,
        errorMaxTokens: error.maxTokens,
        raisedMaxTokens: allowLarge?.raised?.maxTokens,
        room: room(),
        optedIn: allowLarge !== undefined,
        totalLines,
      })
      finalContent = view.content
      shownLines = view.shownLines
      paged = true
      // OCC divergence: the official delivers `Cn` as a separate
      // read_truncation_notice attachment; OCC prepends via the
      // partialViewNotices channel, so it keeps the system-reminder wrapper.
      partialNotice = `<system-reminder>${view.notice}</system-reminder>`
    } else {
      throw transformReadError(error, errorTransformOpts)
    }
  }

  // Official: `be.set(r,{content:Vt,timestamp:Math.floor(vt),offset:y,
  // limit:on,...Cn!==void 0&&{isPartialView:!0}})` — RAW final content (no
  // notice prepend; v296 changed this from OCC's 2.1.145-era behavior) and
  // the paged line count becomes the recorded limit so a follow-up Read
  // resumes where the page ended.
  readFileState.set(fullFilePath, {
    content: finalContent,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit: paged ? shownLines : limit,
    ...(paged && { isPartialView: true }),
  })
  context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

  // Snapshot before iterating — a listener that unsubscribes mid-callback
  // would splice the live array and skip the next listener.
  for (const listener of fileReadListeners.slice()) {
    listener(resolvedFilePath, finalContent)
  }

  const data = {
    type: 'text' as const,
    file: {
      filePath: file_path,
      content: finalContent,
      numLines: shownLines,
      // Official: `startLine:Cn!==void 0?Math.max(1,y):y`
      startLine: paged ? Math.max(1, offset) : offset,
      totalLines,
      // OCC divergence (documented): official output object has no
      // truncatedByTokenCap field — its notice travels via the attachment.
      ...(paged && { truncatedByTokenCap: true }),
    },
  }
  if (paged && partialNotice !== undefined) {
    partialViewNotices.set(data, partialNotice)
  }
  // CC 2.1.299 #126 (official `if(rt.notText!==void 0)BTn.set(fo,nHs(rt.notText))`):
  // the notText notice rides on the data object and is APPENDED to the
  // model-facing content by the mapper (official fWr joiner).
  if (notText !== undefined) {
    notTextNotices.set(data, fileNotTextReadNotice(notText))
  }
  if (isAutoMemFile(fullFilePath)) {
    memoryFileMtimes.set(data, mtimeMs)
  }

  // Official: `ov({operation:"read",tool:"FileReadTool",filePath:r,
  // content:Vt})` — logs the FINAL (possibly paged) content.
  logFileOperation({
    operation: 'read',
    tool: 'FileReadTool',
    filePath: fullFilePath,
    content: finalContent,
  })

  const sessionFileType = detectSessionFileType(fullFilePath)
  logEvent('tengu_session_file_read', {
    totalLines,
    readLines: shownLines,
    totalBytes,
    // Official: `readBytes:Cn!==void 0?Buffer.byteLength(Vt,"utf8"):Rt`
    readBytes: paged ? Buffer.byteLength(finalContent, 'utf8') : readBytes,
    offset,
    ...(paged && { truncatedByTokenCap: true }),
    ...(limit !== undefined && { limit }),
    ...(analyticsExt !== undefined && { ext: analyticsExt }),
    ...(messageId !== undefined && {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    // OCC divergence (documented): official v296 has no is_session_memory /
    // truncatedByTokenCap keys here — OCC keeps both.
    is_session_memory: sessionFileType === 'session_memory',
    is_session_transcript: sessionFileType === 'session_transcript',
    ...(allowLarge !== undefined && { allow_large: true }),
  })

  // Official tail: `if(Y)Chn(Y,d(Cn===void 0?"fit":"paged"),{totalBytes:ut,
  // totalLines:Ze,readLines:qt,...Sn!==void 0&&{tokens:Sn}},He)`
  if (allowLarge) {
    logAllowLargeEvent(
      allowLarge,
      paged ? 'paged' : 'fit',
      {
        totalBytes,
        totalLines,
        readLines: shownLines,
        ...(countedTokens !== undefined && { tokens: countedTokens }),
      },
      analyticsExt,
    )
  }

  return { data }
}

/**
 * Reads an image file and applies token-based compression if needed.
 * Reads the file ONCE, then applies standard resize. If the result exceeds
 * the token limit, applies aggressive compression from the same buffer.
 *
 * @param filePath - Path to the image file
 * @param maxTokens - Maximum token budget for the image
 * @returns Image data with appropriate compression applied
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = getDefaultFileReadingLimits().maxTokens,
  maxBytes?: number,
): Promise<ImageResult> {
  // Read file ONCE — capped to the 128 MiB image limit (CC 2.1.302 #06).
  // Regular files over the cap are refused by stat (never read into memory);
  // pipes/devices named like an image are read in 64 KiB chunks and refused
  // past the cap. Port of the official `qXr`/`oOn` limiter.
  const imageBuffer = await readImageBytesCapped(
    filePath,
    maxBytes ?? MAX_IMAGE_READ_BYTES,
  )
  const originalSize = imageBuffer.length

  if (originalSize === 0) {
    throw new Error(`Image file is empty: ${filePath}`)
  }

  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer)
  const detectedFormat = detectedMediaType.split('/')[1] || 'png'

  // Try standard resize
  let result: ImageResult
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    )
    result = createImageResponse(
      resized.buffer,
      resized.mediaType,
      originalSize,
      resized.dimensions,
    )
  } catch (e) {
    if (e instanceof ImageResizeError) throw e
    logError(e)
    result = createImageResponse(imageBuffer, detectedFormat, originalSize)
  }

  // Check if it fits in token budget
  const estimatedTokens = Math.ceil(result.file.base64.length * 0.125)
  if (estimatedTokens > maxTokens) {
    // Aggressive compression from the SAME buffer (no re-read)
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        maxTokens,
        detectedMediaType,
      )
      return {
        type: 'image',
        file: {
          base64: compressed.base64,
          type: compressed.mediaType,
          originalSize,
        },
      }
    } catch (e) {
      logError(e)
      // Fallback: heavily compressed version from the SAME buffer
      try {
        const sharpModule = await import('sharp')
        const sharp =
          (
            sharpModule as unknown as {
              default?: typeof sharpModule
            } & typeof sharpModule
          ).default || sharpModule

        const fallbackBuffer = await (sharp as any)(imageBuffer)
          .resize(400, 400, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 20 })
          .toBuffer()

        return createImageResponse(fallbackBuffer, 'jpeg', originalSize)
      } catch (error) {
        logError(error)
        return createImageResponse(imageBuffer, detectedFormat, originalSize)
      }
    }
  }

  return result
}
