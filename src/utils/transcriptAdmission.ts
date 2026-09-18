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
