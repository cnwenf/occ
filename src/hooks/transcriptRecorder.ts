import type { UUID } from 'crypto'
import type { Message } from '../types/message.js'
import type { TeamInfo } from '../utils/sessionStorage.js'

/**
 * Transcript recorder — port of the official Claude Code v2.1.288 recorder
 * class `pSe` (@~229547500, window `w288_pw.txt`), recovered in
 * `docs/gap-research-288/cluster-c-instructions-resume.md` §#11.
 *
 * Fixes #11: "a resumed session sometimes not saving the last response of a
 * turn, so the next `--resume` showed the prompt unanswered."
 *
 * The v287 recorder (`SSe`) was fire-and-forget: every render kicked off a
 * `recordTranscript(...)` and a `callSequence` guard DROPPED the result of any
 * write that a newer render overtook. Concurrent writes raced (both read the
 * same on-disk messageSet, both computed a parent chain), and the overtaken
 * write's `lastRecordedUuid` was lost — so the parent chain could be left
 * pointing at a stale uuid and the final assistant turn never landed.
 *
 * v288 replaces that with the `parentWait` state machine, ported here:
 *   - **overtaken hold** — a snapshot arriving while a write is in flight is
 *     HELD (`parentWait.next`, newest-wins coalescing), not raced;
 *   - **replay** — when the in-flight write settles, the held snapshot is
 *     replayed as a fresh episode, so the newest tail is always persisted and
 *     ITS `lastRecordedUuid` becomes the parent hint;
 *   - **compact-boundary-tail skip** (official `Xuo`) — a write whose tail is a
 *     bare compact boundary is skipped (don't persist a transcript that ends on
 *     an unanswered boundary);
 *   - **exit-wait** (official `Zuo`/`FLt`) — the replay is registered with the
 *     graceful-shutdown cleanup set so process exit waits for it;
 *   - **telemetry** — `tengu_transcript_parent_wait` per episode.
 *
 * Official field/flag names are preserved where they are observable
 * (`parentWait`, `next`, `overtaken`, `exitWaited`, `callSequence`,
 * `lastParentUuid`, the telemetry event + field names). The minified internals
 * (`Kt`, `Xt`, `Ge`, `Lt`, `Zuo`, `FLt`, `Xuo`) are given readable OCC names.
 *
 * DIVERGENCES vs official (both justified, neither observable in the contract):
 *   1. **exit-wait also flushes.** Official `FLt(()=>(E.exitWaited=!0,h))`
 *      returns the replay write promise `h`; awaiting it is enough upstream
 *      because the official writer is durable on resolve. OCC's
 *      `recordTranscript` resolves BEFORE durability — `insertMessageChain`
 *      enqueues via a fire-and-forget `enqueueWrite` drained on a 100ms timer
 *      (`sessionStorage.ts` flush/drain). So the OCC exit-wait awaits the
 *      replay AND `flushSessionStorage()` to guarantee the bytes hit disk.
 *   2. **`lastParentUuid` lives on the recorder, and the hook keeps its
 *      synchronous parent-hint walk.** Official updates `lastParentUuid`
 *      solely from the write result. OCC additionally runs a synchronous
 *      "last chain participant" walk in `useLogMessages` for the incremental /
 *      first-render / same-head-shrink cases (an existing optimization that
 *      keeps the hint fresh without waiting on the write). The recorder keeps
 *      the official result-based update gated to the non-incremental
 *      (compaction / full-array) case — exactly the v287 `.then()` gate
 *      (`io && !Ge`) — so the two mechanisms coexist without fighting.
 */

/** Official `i("tengu_transcript_parent_wait", …)` event name — verbatim. */
export const TRANSCRIPT_PARENT_WAIT_EVENT = 'tengu_transcript_parent_wait'

/** Metadata shape accepted by OCC's `logEvent` (`LogEventMetadata`). */
export type TranscriptTelemetryMetadata = {
  [key: string]: boolean | number | undefined
}

/** The `recordTranscript` write the recorder serializes. */
export type TranscriptWriteFn = (
  messages: Message[],
  teamInfo: TeamInfo | undefined,
  startingParentUuidHint: UUID | undefined,
  allMessages: readonly Message[],
) => Promise<UUID | null>

/**
 * One render's worth of transcript state handed to {@link TranscriptRecorder.record}.
 * `parentHint` is captured at record time (the tail of the previously written
 * slice) so a HELD snapshot replays against the correct parent even if later
 * renders advance the live hint.
 */
export interface TranscriptSnapshot {
  messages: Message[]
  options: TeamInfo
  parentHint: UUID | undefined
  allMessages: readonly Message[]
  /** True when `messages` is a pure new-tail slice (chains to `parentHint`). */
  isIncremental: boolean
  /** True when the head uuid changed (compaction rebuilt the array). */
  isHeadReset: boolean
}

/** Official `Kt={startedAt,overtaken,next,exitWaited}` wait-state record. */
interface ParentWaitState {
  startedAt: number
  overtaken: number
  next: TranscriptSnapshot | undefined
  exitWaited: boolean
}

/** Injected so the recorder is unit-testable without React / disk / analytics. */
export interface TranscriptRecorderDeps {
  writeFn: TranscriptWriteFn
  /** OCC equivalent of official `FLt` — `registerCleanup` from cleanupRegistry. */
  registerExitWait: (fn: () => Promise<void>) => () => void
  /** OCC equivalent of official `i(...)` — `logEvent`. */
  emitTelemetry: (name: string, metadata: TranscriptTelemetryMetadata) => void
  /** `flushSessionStorage` — see DIVERGENCE (1). */
  flush: () => Promise<void>
  /** `Date.now` — injected for deterministic `write_ms` in tests. */
  now: () => number
  /**
   * Official `ii(N)` — the compact-boundary predicate (`isCompactBoundaryMessage`
   * from `utils/messages.js`). Injected rather than imported so this module
   * stays runtime-import-free: `messages.js` sits in a circular-init chain with
   * `sendNowCut.ts` that can hit a TDZ (`Cannot access 'INTERRUPT_MESSAGE'
   * before initialization`) when an isolated test loads it in an unlucky order.
   */
  isCompactBoundary: (m: Message) => boolean
}

/**
 * Official `Xuo(h)`: `let E=h.findLast((N)=>N.type==="user"||N.type==="assistant"||ii(N));
 * return E!==void 0&&ii(E)` — true when the last user/assistant/compact-boundary
 * entry is a compact boundary, i.e. the tail is a bare boundary with no
 * following turn. Such a write is skipped.
 */
export function isBareCompactBoundaryTail(
  messages: readonly Message[],
  isCompactBoundary: (m: Message) => boolean,
): boolean {
  const last = messages.findLast(
    m =>
      m.type === 'user' ||
      m.type === 'assistant' ||
      isCompactBoundary(m),
  )
  return last !== undefined && isCompactBoundary(last)
}

/** Official recorder class `pSe`. */
export class TranscriptRecorder {
  /** Official `parentWait` — undefined when no write is in flight. */
  private parentWait: ParentWaitState | undefined = undefined
  /** Official `callSequence`. */
  private callSequence = 0
  /** Official `lastParentUuid` — the parent hint for the next incremental write. */
  lastParentUuid: UUID | undefined = undefined
  private readonly deps: TranscriptRecorderDeps

  constructor(deps: TranscriptRecorderDeps) {
    this.deps = deps
  }

  /**
   * Entry point (official `record`→`write` split). Synchronous: it either
   * skips, holds the snapshot on the in-flight episode, or kicks off a new
   * write episode (fire-and-forget — the UI is never blocked).
   */
  record(snapshot: TranscriptSnapshot): void {
    // Official `if(Xuo(h))return` — skip a bare compact-boundary tail.
    if (isBareCompactBoundaryTail(snapshot.messages, this.deps.isCompactBoundary))
      return

    // Official head-pending reset: a compaction rebuilt the array, so a snapshot
    // held from the PRE-compaction array is stale. Drop it and report cut_short.
    if (snapshot.isHeadReset && this.parentWait?.next !== undefined) {
      this.parentWait.next = undefined
      this.deps.emitTelemetry(TRANSCRIPT_PARENT_WAIT_EVENT, {
        cut_short: true,
        replayed: false,
      })
    }

    // Official overtaken hold: `if(this.parentWait!==void 0){...next=...;return}`.
    if (this.parentWait !== undefined) {
      this.parentWait.overtaken += 1
      this.parentWait.next = snapshot
      return
    }

    const state: ParentWaitState = {
      startedAt: this.deps.now(),
      overtaken: 0,
      next: undefined,
      exitWaited: false,
    }
    this.parentWait = state
    void this.runEpisode(snapshot, state)
  }

  /**
   * Runs one write episode and, on settle, replays any held snapshot
   * (official `write` body + `endParentWait`). Returns a promise that resolves
   * only once this episode AND every chained replay have settled — that is the
   * promise the exit-wait awaits.
   */
  private async runEpisode(
    snapshot: TranscriptSnapshot,
    state: ParentWaitState,
  ): Promise<void> {
    const seq = ++this.callSequence
    let writeRejected = false
    let lastRecordedUuid: UUID | null = null
    try {
      lastRecordedUuid = await this.deps.writeFn(
        snapshot.messages,
        snapshot.options,
        snapshot.parentHint,
        snapshot.allMessages,
      )
    } catch {
      writeRejected = true
    }

    // Official `.then((io)=>{if(Xt===this.callSequence&&io&&!Ge)this.lastParentUuid=io})`.
    // `!Ge` maps to OCC's `!isIncremental` gate (the incremental hint is kept
    // fresh by the hook's synchronous walk — see DIVERGENCE (2)).
    if (seq === this.callSequence && lastRecordedUuid && !snapshot.isIncremental) {
      this.lastParentUuid = lastRecordedUuid
    }

    const writeMs = this.deps.now() - state.startedAt
    const held = state.next
    if (this.parentWait === state) this.parentWait = undefined

    if (held === undefined) {
      this.deps.emitTelemetry(TRANSCRIPT_PARENT_WAIT_EVENT, {
        write_ms: writeMs,
        snapshots_overtaken: state.overtaken,
        exit_waited: state.exitWaited,
        replayed: false,
        write_rejected: writeRejected,
      })
      return
    }

    // Replay path.
    state.next = undefined
    this.deps.emitTelemetry(TRANSCRIPT_PARENT_WAIT_EVENT, {
      write_ms: writeMs,
      snapshots_overtaken: state.overtaken,
      exit_waited: state.exitWaited,
      replayed: true,
      write_rejected: writeRejected,
    })

    const replayState: ParentWaitState = {
      startedAt: this.deps.now(),
      overtaken: 0,
      next: undefined,
      exitWaited: false,
    }
    this.parentWait = replayState
    const replayPromise = this.runEpisode(held, replayState)

    // Official `Zuo(Lt,Kt)` = `FLt(()=>(E.exitWaited=!0,h));h.finally(N)`:
    // register the replay with the exit-wait set, mark `exitWaited` the moment
    // exit invokes us (so the replay's own telemetry can still report it), and
    // deregister once the replay chain settles. OCC also flushes — DIVERGENCE (1).
    const deregister = this.deps.registerExitWait(() => {
      replayState.exitWaited = true
      return (async () => {
        try {
          await replayPromise
        } finally {
          await this.deps.flush()
        }
      })()
    })
    replayPromise.then(deregister, deregister)

    await replayPromise
  }
}
