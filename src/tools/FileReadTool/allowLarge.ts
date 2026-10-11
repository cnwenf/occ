import { logEvent } from '../../services/analytics/index.js'
import { bytesPerTokenForModel } from '../../services/tokenEstimation.js'
import type { AssistantMessage } from '../../types/message.js'
import { normalizeUsage, sumInputTokens, type UsageShape } from '../../utils/tokens.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { FILE_READ_TOOL_NAME } from './prompt.js'
import type { ToolUseContext } from '../../Tool.js'

/**
 * Claude Code 2.1.296 (OCC-154 #006 Slice B): the Read tool's `allow_large`
 * mode — sizing an oversized text read to the tokens that still fit in the
 * current turn's context room, with byte-exact messages, telemetry, and the
 * token-cap PARTIAL-view pagination.
 *
 * Official surface (v296 ELF, md5 3c8749470f70a26efadf982b587e1548):
 *   constants `rt`/`hue` @209662501, coefficients `sOr`/`iOr`/`aOr` @219148327
 *   + `Ugo=25000`/`jgo=128` @210495482, messages `Aws`/`Bgo`/`Cws`
 *   @210495482-210496323, schema field @219133376, room calc `lOr` @219148327,
 *   telemetry `Chn` @219148814, msg selector `Ave` @219148986, error
 *   transformer `_hn` @219149198, token counter `khn` @219149776, text path
 *   `dOr` @219156400-219161350.
 *
 * Symbol map (official → OCC):
 *   sOr = ROOM_FRACTION                 iOr = BYTES_PER_TOKEN_FLOOR_DIVISOR
 *   aOr = RAISED_BYTES_PER_TOKEN_MULTIPLIER
 *   jgo = ROUGH_LENGTH_TOKEN_RATIO      hue = ALLOW_LARGE_FIELD_NAME
 *   lOr = computeAllowLargeRoom         Ave = selectAllowLargeMessage
 *   Chn = logAllowLargeEvent            (_hn = transformReadError, in
 *   (khn = countReadTokensForRead, in FileReadTool.ts — both need the local
 *   error classes)
 *
 * DOCUMENTED DIVERGENCES:
 *   - `lOr` early-returns on `remoteCall`/`inputFromAnotherMachine` — OCC has
 *     neither surface (no remote-execution tool context), so those guards are
 *     omitted.
 *   - Official telemetry wrapper `d` = fromEnum = identity at runtime
 *     (chunk-wkmq9ht0.js @207051783) — outcome strings pass through raw.
 *   - The official delivers the PARTIAL-view notice as a separate
 *     `read_truncation_notice` attachment; OCC keeps its existing prepend
 *     channel (partialViewNotices WeakMap → mapper), wrapping the notice in
 *     <system-reminder> as before.
 */

// ── Official coefficients (byte-verified) ──

/** Official `sOr=0.7` @219148327 — share of free room a large read may take. */
export const ROOM_FRACTION = 0.7
/** Official `iOr=2` @219148327 — raised-mode bytes-per-token floor divisor. */
export const BYTES_PER_TOKEN_FLOOR_DIVISOR = 2
/** Official `aOr=3` @219148327 — raised byte cap = room × bpt × 3. */
export const RAISED_BYTES_PER_TOKEN_MULTIPLIER = 3
/** Official `jgo=128` @210495482 — chars-per-token ratio for length guards. */
export const ROUGH_LENGTH_TOKEN_RATIO = 128
/** Official `hue="allow_large"` @209662501. */
export const ALLOW_LARGE_FIELD_NAME = 'allow_large'

/** Official `Djt`/`ENe` — kept here so the notice builder owns it. */
export const PARTIAL_VIEW_PREFIX = '[Truncated: PARTIAL view — '

// ── Official messages @210495482-210496323 (byte-exact) ──

/** Official `Aws` — appended when the read would fit after raising the caps. */
export const ALLOW_LARGE_FITS_MESSAGE = ` To read it anyway, up to what still fits in your context, call ${FILE_READ_TOOL_NAME} again with ${ALLOW_LARGE_FIELD_NAME}: true — only if you genuinely need all of it or the user asked for the whole file.`

/** Official `Bgo` — appended when even the raised caps cannot hold it. */
export const ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE = ` Even with ${ALLOW_LARGE_FIELD_NAME}, this is more than fits in the context you have left this turn (other large reads in the same turn share that room).`

/** Official `Cws` — appended when no context room is available at all. */
export const ALLOW_LARGE_UNAVAILABLE_MESSAGE = ` ${ALLOW_LARGE_FIELD_NAME} is not available where this read runs; read it in parts with offset and limit.`

// ── Types ──

/** Official raised caps: `{maxTokens:H,maxSizeBytes:Math.max(r.maxSizeBytes,H*G*aOr)}`. */
export type RaisedLimits = {
  maxTokens: number
  maxSizeBytes: number
}

/** Official `lOr` result — `roomTokens` undefined means "room unavailable". */
export type AllowLargeRoom = {
  roomTokens: number | undefined
  raised: RaisedLimits | undefined
}

// ── lOr: room computation ──

/**
 * Official `lOr` @219148327 (verbatim):
 *   `function lOr(e,n,r){let s=e.contextRoom();
 *      if(s===void 0||e.remoteCall!==void 0||e.inputFromAnotherMachine===!0)
 *        return{roomTokens:void 0,raised:void 0};
 *      let h=n?.message.usage,y=h?O5(h):void 0,
 *          S=y&&VRt(y)>0?VRt(y)+y.output_tokens:0,
 *          w=Math.max(S,s.held())+s.claimed(),
 *          H=Math.max(0,Math.floor((s.threshold-w)*sOr));
 *      if(H<=r.maxTokens)return{roomTokens:H,raised:void 0};
 *      let{bytesPerToken:G}=Xd(e.model());
 *      return{roomTokens:H,
 *             raised:{maxTokens:H,maxSizeBytes:Math.max(r.maxSizeBytes,H*G*aOr)}}}`
 *
 * O5 ≡ normalizeUsage, VRt ≡ sumInputTokens (on the normalized usage),
 * Xd ≡ bytesPerTokenForModel (OCC returns the number directly).
 */
export function computeAllowLargeRoom(
  context: ToolUseContext,
  parentMessage: AssistantMessage | undefined,
  base: { maxSizeBytes: number; maxTokens: number },
): AllowLargeRoom {
  const room = context.contextRoom?.()
  if (room === undefined) {
    return { roomTokens: undefined, raised: undefined }
  }
  const usage = parentMessage?.message.usage as UsageShape | undefined
  const normalized = usage ? normalizeUsage(usage) : undefined
  const usageTokens =
    normalized && sumInputTokens(normalized) > 0
      ? sumInputTokens(normalized) + normalized.output_tokens
      : 0
  const taken = Math.max(usageTokens, room.held()) + room.claimed()
  const roomTokens = Math.max(
    0,
    Math.floor((room.threshold - taken) * ROOM_FRACTION),
  )
  if (roomTokens <= base.maxTokens) {
    return { roomTokens, raised: undefined }
  }
  const bytesPerToken = bytesPerTokenForModel(context.options.mainLoopModel)
  return {
    roomTokens,
    raised: {
      maxTokens: roomTokens,
      maxSizeBytes: Math.max(
        base.maxSizeBytes,
        roomTokens * bytesPerToken * RAISED_BYTES_PER_TOKEN_MULTIPLIER,
      ),
    },
  }
}

// ── Ave: message selector ──

/**
 * Official `Ave` @219148986 (verbatim):
 *   `function Ave(e,n,r){if(e.roomTokens===void 0)return n?Cws:"";
 *      if(n||e.raised===void 0)return Bgo;
 *      return(r.bytes===void 0||r.bytes<=e.raised.maxSizeBytes)&&
 *            (r.tokens===void 0||r.tokens<=e.raised.maxTokens)?Aws:Bgo}`
 */
export function selectAllowLargeMessage(
  room: AllowLargeRoom,
  optedIn: boolean,
  actual: { bytes?: number; tokens?: number },
): string {
  if (room.roomTokens === undefined) {
    return optedIn ? ALLOW_LARGE_UNAVAILABLE_MESSAGE : ''
  }
  if (optedIn || room.raised === undefined) {
    return ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE
  }
  const fits =
    (actual.bytes === undefined || actual.bytes <= room.raised.maxSizeBytes) &&
    (actual.tokens === undefined || actual.tokens <= room.raised.maxTokens)
  return fits ? ALLOW_LARGE_FITS_MESSAGE : ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE
}

// ── Chn: telemetry ──

/**
 * Official `Chn` @219148814 (verbatim):
 *   `function Chn(e,n,r,s){i("tengu_file_read_allow_large",{outcome:n,
 *      lifted:e.raised!==void 0,
 *      ...e.roomTokens!==void 0&&{roomTokens:e.roomTokens},...r,
 *      ...s!==void 0&&{ext:s}})}`
 *
 * `outcome` passes through the official `d` wrapper, which is fromEnum =
 * identity at runtime — raw strings: "unavailable" | "too_large" | "fit" |
 * "paged".
 */
export function logAllowLargeEvent(
  room: AllowLargeRoom,
  outcome: 'unavailable' | 'too_large' | 'fit' | 'paged',
  extra: Record<string, unknown>,
  ext?: string,
): void {
  logEvent('tengu_file_read_allow_large', {
    outcome,
    lifted: room.raised !== undefined,
    ...(room.roomTokens !== undefined && { roomTokens: room.roomTokens }),
    ...extra,
    ...(ext !== undefined && { ext }),
  } as Parameters<typeof logEvent>[1])
}

// ── dOr catch branch: token-cap PARTIAL view ──

/** Official `Lt(text, "\n")` — newline occurrence count. */
export function countNewlines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      count++
    }
  }
  return count
}

export type TokenCapPartialView = {
  /** The truncated content to return to the model. */
  content: string
  /** Lines covered by `content` (official `qt`); recorded as the new limit. */
  shownLines: number
  /** True when the file could not be paginated by line (official `$n`). */
  charMode: boolean
  /** Official `Cn` — bare notice text (caller wraps in system-reminder). */
  notice: string
}

/**
 * Official `dOr` catch branch @219156400-219161350 — when a WHOLE-file read
 * blows the token cap, build the best-fitting first page instead of throwing.
 *
 * Verbatim algorithm:
 *   `no=Y?.raised&&mo.maxTokens>G?`${hue} had room for ${mo.maxTokens} tokens
 *        this turn`:`cap ${G}``
 *   `Hn=Math.max(0.5,Wt.length/Math.max(1,mo.tokenCount))` (chars per token)
 *   `Eo=Math.max(1,Math.min(tn.length,Math.floor(tn.length*G/Math.max(1,
 *        mo.tokenCount)*0.85)))` then ≤6 shrink rounds at ×0.7 while the
 *        estimated tokens stay over the cap
 *   fallback char-mode: `fo=Math.max(1,Math.floor(G*Hn*0.85))` + ≤6 ×0.7
 *        shrink rounds; a cut ending on a high surrogate (0xD800-0xDBFF)
 *        drops that char
 *   `qt=$n?Lt(No,"\n")+1:Eo`
 */
export function buildTokenCapPartialView(opts: {
  filePath: string
  content: string
  /** Official `mo.tokenCount` — the measured size of the FULL content. */
  tokenCount: number
  /** Official `G` — the base per-read token cap. */
  baseMaxTokens: number
  /** Official `mo.maxTokens` — the cap the error was thrown against. */
  errorMaxTokens: number
  /** Official `Y?.raised?.maxTokens`. */
  raisedMaxTokens: number | undefined
  /** Official `V()` — freshly computed room for the suffix selector. */
  room: AllowLargeRoom
  /** Official `Y!==void 0`. */
  optedIn: boolean
  totalLines: number
}): TokenCapPartialView {
  const {
    filePath,
    content,
    tokenCount,
    baseMaxTokens,
    errorMaxTokens,
    raisedMaxTokens,
    room,
    optedIn,
    totalLines,
  } = opts

  const capLabel =
    raisedMaxTokens !== undefined && errorMaxTokens > baseMaxTokens
      ? `${ALLOW_LARGE_FIELD_NAME} had room for ${errorMaxTokens} tokens this turn`
      : `cap ${baseMaxTokens}`
  const suffix = selectAllowLargeMessage(room, optedIn, { tokens: tokenCount })

  const lines = content.split('\n')
  const charsPerToken = Math.max(0.5, content.length / Math.max(1, tokenCount))
  const estimateTokens = (text: string): number => text.length / charsPerToken

  let shownLines = Math.max(
    1,
    Math.min(
      lines.length,
      Math.floor((lines.length * baseMaxTokens) / Math.max(1, tokenCount) * 0.85),
    ),
  )
  let shown = lines.slice(0, shownLines).join('\n')
  for (let round = 0; round < 6; round++) {
    if (estimateTokens(shown) <= baseMaxTokens || shownLines <= 1) {
      break
    }
    shownLines = Math.max(1, Math.floor(shownLines * 0.7))
    shown = lines.slice(0, shownLines).join('\n')
  }

  let charMode = false
  if (estimateTokens(shown) > baseMaxTokens || shown.trim() === '') {
    let charCount = Math.max(1, Math.floor(baseMaxTokens * charsPerToken * 0.85))
    for (let round = 0; round < 6; round++) {
      shown = content.slice(0, charCount)
      if (estimateTokens(shown) <= baseMaxTokens) {
        break
      }
      charCount = Math.max(1, Math.floor(charCount * 0.7))
    }
    // Never split a surrogate pair — official `if(dr>=55296&&dr<=56319)`.
    const lastCode = shown.charCodeAt(shown.length - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      shown = shown.slice(0, -1)
    }
    charMode = true
  }

  const finalShownLines = charMode ? countNewlines(shown) + 1 : shownLines
  const notice =
    !charMode && finalShownLines < totalLines
      ? PARTIAL_VIEW_PREFIX +
        `${filePath}: showing lines 1-${finalShownLines} of ${totalLines} total (${tokenCount} tokens, ${capLabel}). Call ${FILE_READ_TOOL_NAME} with offset=${finalShownLines + 1} limit=${finalShownLines} for the next page, or ${GREP_TOOL_NAME} to find a specific section.${suffix} Do NOT answer from this page alone if the answer may be further in the file.]`
      : PARTIAL_VIEW_PREFIX +
        `${filePath}: showing the first ${shown.length} of ${content.length} characters (${tokenCount} tokens, ${capLabel}); this file has very long lines and cannot be paginated by line. Use ${GREP_TOOL_NAME} to find a specific section, or ${FILE_READ_TOOL_NAME} with offset/limit to page through it.${suffix} Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]`

  return { content: shown, shownLines: finalShownLines, charMode, notice }
}
