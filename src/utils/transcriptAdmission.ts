/**
 * Transcript load-time admission validator — port of the official Claude Code
 * 2.1.276 admission subsystem (`Vlr` / `iFs` / `Glr`, binary @200791900).
 *
 * CC 2.1.275 changelog (M2/M3): "Fixed a crash when resuming a conversation
 * with a malformed message entry" / "malformed content block no longer blocks
 * resume/start". Before this gate, a single malformed user/assistant row
 * (message:null, non-array content, junk blocks) flowed unvalidated into
 * render/API prep — or threw inside the load loop and emptied the whole
 * transcript.
 *
 * The validator gates ONLY `user`/`assistant` rows at load time:
 * - `message` not a plain object            → drop the row
 * - `content` a string                      → keep
 * - `content` not an array                  → drop the row
 * - some blocks invalid                     → strip invalid blocks in place,
 *                                             keep the row, count removed
 * - zero valid blocks remaining             → drop the row
 * Any unexpected throw inside admission KEEPS the row (official
 * `catch{return!0}` — admission must never be the reason a transcript fails
 * to load).
 *
 * `finish()` re-chains surviving rows whose `parentUuid` points at a dropped
 * row (walking the dropped-row map to the nearest surviving ancestor,
 * cycle-safe with a visited set + path compression — official `y`), then
 * emits the byte-exact official warn log when anything was stripped/dropped.
 *
 * Fidelity note: like the official `iFs`, `classifyMessagePayload` MUTATES
 * the message's `content` property in place (replaces it with the filtered
 * array) and `finish()` mutates `parentUuid` on surviving rows. This is
 * deliberate — the official algorithm is mirrored 1:1; all other exports are
 * pure.
 */
import type { UUID } from 'crypto'
import { logForDebugging } from './debug.js'

/**
 * Official `te` (@190928642): plain-object check — object, non-null, not an
 * array. Accepts class instances (unlike lodash isPlainObject), matching the
 * binary byte-for-byte.
 */
export function isPlainObjectValue(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Official `Glr(e){return te(e)&&typeof e.type==="string"}` — a content block
 * is structurally valid when it is a plain object with a string `type`.
 */
export function isValidContentBlock(block: unknown): boolean {
  return isPlainObjectValue(block) && typeof block.type === 'string'
}

/**
 * Verdict of `classifyMessagePayload`:
 * - `'keep'`   — payload is structurally sound, admit the row unchanged
 * - `'drop'`   — payload is unreadable, the row must not be admitted
 * - `number`   — that many invalid blocks were stripped (in place) from a
 *                content array that still has valid blocks; admit the row
 */
export type MessagePayloadVerdict = 'keep' | 'drop' | number

/**
 * Official `iFs` (@200792540). Classifies a transcript row's `message`
 * payload. When some content blocks are invalid, replaces `message.content`
 * with the filtered array IN PLACE (official `e.content=r`) and returns the
 * removed-block count.
 */
export function classifyMessagePayload(
  message: unknown,
): MessagePayloadVerdict {
  if (!isPlainObjectValue(message)) return 'drop'
  const content = message.content
  if (typeof content === 'string') return 'keep'
  if (!Array.isArray(content)) return 'drop'
  if (content.every(isValidContentBlock)) return 'keep'
  const kept = content.filter(isValidContentBlock)
  if (kept.length === 0) return 'drop'
  message.content = kept
  return content.length - kept.length
}

/** Minimal structural shape of a transcript row candidate for admission. */
export interface TranscriptAdmissionCandidate {
  type: string
  uuid: UUID
  parentUuid: UUID | null
  message?: unknown
}

/**
 * The uuid-keyed messages map being built during load. `finish()` mutates
 * `parentUuid` on surviving rows (official does the same on `w.values()`),
 * so the value type only requires the chain field.
 */
export type TranscriptAdmissionMessagesMap = ReadonlyMap<
  UUID,
  { parentUuid: UUID | null }
>

export interface TranscriptAdmissionValidator {
  /**
   * Official `Vlr.admit` (`g`): returns true when the row may be admitted.
   * Gates only `user`/`assistant` rows; records dropped uuid→parentUuid for
   * the `finish()` re-chain. Any unexpected throw KEEPS the row.
   */
  admit(
    entry: TranscriptAdmissionCandidate,
    messagesMap: TranscriptAdmissionMessagesMap,
  ): boolean
  /**
   * OCC wiring addition (not in the official `Vlr` surface): the load loop
   * skips non-object/null JSONL rows BEFORE admission (official `Qcr` gate) —
   * a bare `null` line otherwise throws inside isTranscriptMessage and the
   * outer catch empties the whole transcript. Call this for each skipped row
   * so it is counted in the official warn log's "unreadable row(s)" total.
   */
  noteUnreadableRow(): void
  /**
   * Official `Vlr.finish` (`h`): re-chains survivors whose parentUuid points
   * at a dropped row, then emits the byte-exact warn log when anything was
   * removed/dropped. Swallows its own errors (official `catch{}`).
   */
  finish(messagesMap: TranscriptAdmissionMessagesMap): void
}

/**
 * Official `Vlr()` (@200791900) — creates one admission validator per
 * transcript load. Closure state mirrors the official:
 * `e` = droppedParents, `r` = removedBlockCount, `n` = strippedRowCount,
 * `s` = droppedRowCount.
 */
export function createTranscriptAdmissionValidator(): TranscriptAdmissionValidator {
  const droppedParents = new Map<UUID, UUID | null>()
  let removedBlockCount = 0
  let strippedRowCount = 0
  let droppedRowCount = 0

  /**
   * Official `y(w,O)` — walks the dropped-row chain from `startUuid` to the
   * nearest surviving ancestor (a uuid present in messagesMap, or the chain
   * end). Cycle-safe via the visited set; path-compresses every visited uuid
   * to the resolved ancestor (official `for(let U of L)e.set(U,B)`).
   */
  function resolveNearestSurvivingAncestor(
    startUuid: UUID,
    messagesMap: TranscriptAdmissionMessagesMap,
  ): UUID | null {
    const visited = new Set<UUID>()
    let current: UUID | null = startUuid
    while (
      current !== null &&
      !messagesMap.has(current) &&
      droppedParents.has(current)
    ) {
      if (visited.has(current)) {
        current = null
        break
      }
      visited.add(current)
      current = droppedParents.get(current) ?? null
    }
    for (const uuid of visited) {
      droppedParents.set(uuid, current)
    }
    return current
  }

  function admit(
    entry: TranscriptAdmissionCandidate,
    messagesMap: TranscriptAdmissionMessagesMap,
  ): boolean {
    try {
      if (entry.type !== 'user' && entry.type !== 'assistant') return true
      const verdict = classifyMessagePayload(entry.message)
      if (verdict === 'keep') return true
      if (typeof verdict === 'number') {
        removedBlockCount += verdict
        strippedRowCount += 1
        return true
      }
      droppedRowCount += 1
      // Official guard `!O.has(w.uuid)`: a duplicate uuid already admitted
      // wins — do not let the dropped twin poison the re-chain map.
      if (!messagesMap.has(entry.uuid)) {
        droppedParents.set(entry.uuid, entry.parentUuid ?? null)
      }
      return false
    } catch {
      // Official `catch{return!0}` — admission never drops a row on an
      // unexpected internal error.
      return true
    }
  }

  function noteUnreadableRow(): void {
    droppedRowCount += 1
  }

  function finish(messagesMap: TranscriptAdmissionMessagesMap): void {
    try {
      if (droppedParents.size > 0) {
        for (const row of messagesMap.values()) {
          const parent = row.parentUuid
          if (
            parent !== null &&
            !messagesMap.has(parent) &&
            droppedParents.has(parent)
          ) {
            row.parentUuid = resolveNearestSurvivingAncestor(
              parent,
              messagesMap,
            )
          }
        }
      }
      if (strippedRowCount === 0 && droppedRowCount === 0) return
      // Byte-exact official template (v276 binary @200792324). The "(s)"
      // suffixes are literal in the official — there is NO pluralization
      // helper on this string (verified against the binary).
      logForDebugging(
        `transcript load: removed ${removedBlockCount} malformed content block(s) from ${strippedRowCount} row(s) and dropped ${droppedRowCount} unreadable row(s)`,
        { level: 'warn' },
      )
    } catch {
      // Official `finish` is wrapped in `try{...}catch{}` — a re-chain or
      // logging failure must never abort the load.
    }
  }

  return { admit, noteUnreadableRow, finish }
}

/* -------------------------------------------------------------------------
 * Resume-path row sanitizer — port of the official Claude Code 2.1.277
 * `Gln` / `jln` / `Hln` / `Wln` / `zln` cluster (D4 fix).
 *
 * CC 2.1.278 changelog: "Fixed a crash when resuming a session whose saved
 * history contains an assistant message stored as a plain string". The
 * official resume pipeline (`ocn`) runs `Gln` over the WHOLE loaded message
 * array BEFORE attachment-drop (`iG`) and interrupted-turn handling:
 * `y=Dmt(e)` → `w=iMo(iG(Gln(y)),s)`.
 *
 * Unlike the load-time admission above (`iFs`-derived, which mutates
 * `message.content` in place), `jln`/`Gln` are PURE — a changed row is
 * rebuilt as `{...row, message:{...message, content}}`.
 * ---------------------------------------------------------------------- */

/**
 * Official `I(e,n,r=n+"s")` (@191972157) — minimal pluralize helper used by
 * the resume warn message (`I(r,"block")`, `I(s,"row")`). Same shape as the
 * module-local `pluralize` in attachments.ts (official `P`).
 */
function pluralizeForResumeWarn(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return count === 1 ? singular : plural
}

/**
 * Official `Wln(e){return e==="user"||e==="assistant"}` — the resume
 * sanitizer only gates user/assistant rows.
 */
function isUserOrAssistantRole(role: unknown): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant'
}

/** Verdict of `classifyResumedRowPayload` (official `jln` return shapes). */
export type ResumedRowPayloadVerdict =
  | 'keep'
  | 'drop'
  | {
      message: Record<string, unknown>
      content: unknown[]
      droppedBlocks: number
      wrapped: boolean
    }

/**
 * Official `jln(e,n)` — per-row payload classification on the resume path.
 * The D4 delta vs the load-time `classifyMessagePayload` above: a STRING
 * content on an ASSISTANT row is no longer kept raw — a non-blank string is
 * wrapped into `[{type:'text',text:<string>}]` (the official wrap block has
 * NO `citations` field), a blank/whitespace-only string drops the row.
 * Block validation reuses `isValidContentBlock` — official `Hln` is
 * byte-identical in semantics to `Glr` (`ee(e)&&typeof e.type==="string"`).
 */
export function classifyResumedRowPayload(
  role: 'user' | 'assistant',
  message: unknown,
): ResumedRowPayloadVerdict {
  if (!isPlainObjectValue(message)) return 'drop'
  const content = message.content
  if (typeof content === 'string') {
    if (role !== 'assistant') return 'keep'
    if (content.trim() === '') return 'drop'
    return {
      message,
      content: [{ type: 'text', text: content }],
      droppedBlocks: 0,
      wrapped: true,
    }
  }
  if (!Array.isArray(content)) return 'drop'
  if (content.every(isValidContentBlock)) return 'keep'
  const kept = content.filter(isValidContentBlock)
  if (kept.length === 0) return 'drop'
  return {
    message,
    content: kept,
    droppedBlocks: content.length - kept.length,
    wrapped: false,
  }
}

/** Official `Gln` counters object (destructured by `zln`). */
export interface ResumeSanitizeCounts {
  droppedBlocks: number
  cleanedRows: number
  wrappedRows: number
  droppedRows: number
}

/**
 * Official `zln(e,n)` — builds the resume sanitize warn message. Byte-exact
 * template; each clause is emitted only when its gating counter is non-zero.
 * Fidelity note: the first clause is gated on `cleanedRows > 0` but prints
 * the TOTAL `droppedBlocks` — exactly as in the official.
 */
export function formatResumeSanitizeWarn(
  prefix: string,
  counts: ResumeSanitizeCounts,
): string {
  const { droppedBlocks, cleanedRows, wrappedRows, droppedRows } = counts
  const parts = [
    cleanedRows > 0
      ? `removed ${droppedBlocks} malformed content ${pluralizeForResumeWarn(droppedBlocks, 'block')} from ${cleanedRows} ${pluralizeForResumeWarn(cleanedRows, 'row')}`
      : undefined,
    wrappedRows > 0
      ? `wrapped the string content of ${wrappedRows} assistant ${pluralizeForResumeWarn(wrappedRows, 'row')} in a text block`
      : undefined,
    droppedRows > 0
      ? `dropped ${droppedRows} unreadable ${pluralizeForResumeWarn(droppedRows, 'row')}`
      : undefined,
  ].filter((part): part is string => part !== undefined)
  return `${prefix}: ${parts.join(', ')}`
}

/**
 * Official `Gln(e)` — sanitize pass over the whole loaded message array on
 * resume. Non-user/assistant rows pass through untouched; a per-row throw
 * KEEPS the original row (official `catch{return[y]}`). When nothing changed
 * the input array reference is returned (identity fast path) and NO warn is
 * logged; otherwise `zln("resume", counts)` is emitted at warn level inside
 * its own try/catch (official `try{t(...)}catch{}`).
 */
export function sanitizeResumedRows<
  T extends { type: string; message?: unknown },
>(rows: T[]): T[] {
  const counts: ResumeSanitizeCounts = {
    droppedBlocks: 0,
    cleanedRows: 0,
    wrappedRows: 0,
    droppedRows: 0,
  }
  const result = rows.flatMap((row): T[] => {
    try {
      const role = row.type
      if (!isUserOrAssistantRole(role)) return [row]
      const verdict = classifyResumedRowPayload(role, row.message)
      if (verdict === 'keep') return [row]
      if (verdict === 'drop') {
        counts.droppedRows += 1
        return []
      }
      counts.droppedBlocks += verdict.droppedBlocks
      if (verdict.wrapped) {
        counts.wrappedRows += 1
      } else {
        counts.cleanedRows += 1
      }
      return [
        {
          ...row,
          message: { ...verdict.message, content: verdict.content },
        },
      ]
    } catch {
      // Official `catch{return[y]}` — an unexpected per-row failure must
      // never drop the row or abort the resume.
      return [row]
    }
  })
  const { cleanedRows, wrappedRows, droppedRows } = counts
  if (cleanedRows === 0 && wrappedRows === 0 && droppedRows === 0) {
    return rows
  }
  try {
    logForDebugging(formatResumeSanitizeWarn('resume', counts), {
      level: 'warn',
    })
  } catch {
    // Official wraps the warn log in try/catch — logging failure must never
    // abort the resume.
  }
  return result
}
