import type { UUID } from 'crypto'
import { useEffect, useRef } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { isCompactBoundaryMessage } from '../utils/messages.js'
import {
  cleanMessagesForLogging,
  flushSessionStorage,
  isChainParticipant,
  recordTranscript,
} from '../utils/sessionStorage.js'
import {
  TranscriptRecorder,
  type TranscriptSnapshot,
} from './transcriptRecorder.js'

/**
 * Hook that logs messages to the transcript
 * conversation ID that only changes when a new conversation is started.
 *
 * @param messages The current conversation messages
 * @param ignore When true, messages will not be recorded to the transcript
 */
export function useLogMessages(messages: Message[], ignore: boolean = false) {
  const teamContext = useAppState(s => s.teamContext)

  // messages is append-only between compactions, so track where we left off
  // and only pass the new tail to recordTranscript. Avoids O(n) filter+scan
  // on every setMessages (~20x/turn, so n=3000 was ~120k wasted iterations).
  const lastRecordedLengthRef = useRef(0)
  // First-uuid change = compaction or /clear rebuilt the array; length alone
  // can't detect this since post-compact [CB,summary,...keep,new] may be longer.
  const firstMessageUuidRef = useRef<UUID | undefined>(undefined)

  // CC 2.1.288 #11: the recorder owns the `parentWait` state machine that
  // replaces the v287 fire-and-forget write + `callSequence` drop (which lost
  // an overtaken write's `lastRecordedUuid` and left the last turn unsaved).
  // It serializes writes, holds the newest snapshot while one is in flight,
  // replays it on settle, registers the replay with the exit-wait set, skips
  // bare-compact-boundary tails, and emits `tengu_transcript_parent_wait`.
  // Persisted across renders in a ref; `lastParentUuid` (the parent hint) now
  // lives on the recorder instead of a standalone ref.
  const recorderRef = useRef<TranscriptRecorder | undefined>(undefined)
  if (recorderRef.current === undefined) {
    recorderRef.current = new TranscriptRecorder({
      writeFn: recordTranscript,
      registerExitWait: registerCleanup,
      emitTelemetry: logEvent,
      flush: flushSessionStorage,
      now: () => Date.now(),
      isCompactBoundary: isCompactBoundaryMessage,
    })
  }
  const recorder = recorderRef.current

  useEffect(() => {
    if (ignore) return

    const currentFirstUuid = messages[0]?.uuid as UUID | undefined
    const prevLength = lastRecordedLengthRef.current

    // First-render: firstMessageUuidRef is undefined. Compaction: first uuid changes.
    // Both are !isIncremental, but first-render sync-walk is safe (no messagesToKeep).
    const wasFirstRender = firstMessageUuidRef.current === undefined
    const isIncremental =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength <= messages.length
    // Same-head shrink: tombstone filter, rewind, snip, partial-compact.
    // Distinguished from compaction (first uuid changes) because the tail
    // is either an existing on-disk message or a fresh message that this
    // same effect's recordTranscript(fullArray) will write — see sync-walk
    // guard below.
    const isSameHeadShrink =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength > messages.length
    // Head reset = compaction / `/clear` rebuilt the array (head uuid changed).
    // The recorder uses this to drop a held snapshot from the stale array.
    const isHeadReset =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid !== firstMessageUuidRef.current

    const startIndex = isIncremental ? prevLength : 0
    if (startIndex === messages.length) return

    // Full array on first call + after compaction: recordTranscript's own
    // O(n) dedup loop handles messagesToKeep interleaving correctly there.
    const slice = startIndex === 0 ? messages : messages.slice(startIndex)
    const parentHint = isIncremental ? recorder.lastParentUuid : undefined

    const snapshot: TranscriptSnapshot = {
      messages: slice,
      options: isAgentSwarmsEnabled()
        ? {
            teamName: teamContext?.teamName,
            agentName: teamContext?.selfAgentName,
          }
        : {},
      // Captured now (before the sync-walk below advances it) so a snapshot
      // held by the recorder replays against the correct parent.
      parentHint,
      allMessages: messages,
      isIncremental,
      isHeadReset,
    }
    // Fire-and-forget at the UI level, but serialized inside the recorder.
    recorder.record(snapshot)

    // Sync-walk safe for: incremental (pure new-tail slice), first-render
    // (no messagesToKeep interleaving), and same-head shrink. Shrink is the
    // subtle one: the picked uuid is either already on disk (tombstone/rewind
    // — survivors were written before) or is being written by THIS effect's
    // recordTranscript(fullArray) call (snip boundary / partial-compact tail
    // — enqueueWrite ordering guarantees it lands before any later write that
    // chains to it). Without this, the ref stays stale at a tombstoned uuid:
    // the async .then() correction is raced out by the next effect's seq bump
    // on large sessions where recordTranscript(fullArray) is slow. Only the
    // compaction case (first uuid changed) remains unsafe — tail may be
    // messagesToKeep whose last-actually-recorded uuid differs, so the recorder
    // corrects it from the write result there.
    if (isIncremental || wasFirstRender || isSameHeadShrink) {
      // Match EXACTLY what recordTranscript persists: cleanMessagesForLogging
      // applies both the isLoggableMessage filter and (for external users) the
      // REPL-strip + isVirtual-promote transform. Using the raw predicate here
      // would pick a UUID that the transform drops, leaving the parent hint
      // pointing at a message that never reached disk. Pass full messages as
      // replId context — REPL tool_use and its tool_result land in separate
      // render cycles, so the slice alone can't pair them.
      const last = cleanMessagesForLogging(slice, messages).findLast(
        isChainParticipant,
      )
      if (last) recorder.lastParentUuid = last.uuid as UUID
    }

    lastRecordedLengthRef.current = messages.length
    firstMessageUuidRef.current = currentFirstUuid
  }, [messages, ignore, teamContext?.teamName, teamContext?.selfAgentName])
}
