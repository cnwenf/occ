/**
 * Query the terminal and await responses without timeouts.
 *
 * Terminal queries (DECRQM, DA1, OSC 11, etc.) share the stdin stream
 * with keyboard input. Response sequences are syntactically
 * distinguishable from key events, so the input parser recognizes them
 * and dispatches them here.
 *
 * To avoid timeouts, each query batch is terminated by a DA1 sentinel
 * (CSI c) — every terminal since VT100 responds to DA1, and terminals
 * answer queries in order. So: if your query's response arrives before
 * DA1's, the terminal supports it; if DA1 arrives first, it doesn't.
 *
 * Usage:
 *   const [sync, grapheme] = await Promise.all([
 *     querier.send(decrqm(2026)),
 *     querier.send(decrqm(2027)),
 *     querier.flush(),
 *   ])
 *   // sync and grapheme are DECRPM responses or undefined if unsupported
 */

import type { TerminalResponse } from './parse-keypress.js'
import { csi } from './termio/csi.js'
import { osc, OSC } from './termio/osc.js'

/** A terminal query: an outbound request sequence paired with a matcher
 *  that recognizes the expected inbound response. Built by `decrqm()`,
 *  `oscColor()`, `kittyKeyboard()`, etc. */
export type TerminalQuery<T extends TerminalResponse = TerminalResponse> = {
  /** Escape sequence to write to stdout */
  request: string
  /** Recognizes the expected response in the inbound stream */
  match: (r: TerminalResponse) => r is T
}

type DecrpmResponse = Extract<TerminalResponse, { type: 'decrpm' }>
type Da1Response = Extract<TerminalResponse, { type: 'da1' }>
type Da2Response = Extract<TerminalResponse, { type: 'da2' }>
type KittyResponse = Extract<TerminalResponse, { type: 'kittyKeyboard' }>
type CursorPosResponse = Extract<TerminalResponse, { type: 'cursorPosition' }>
type OscResponse = Extract<TerminalResponse, { type: 'osc' }>
type XtversionResponse = Extract<TerminalResponse, { type: 'xtversion' }>

// -- Query builders --

/** DECRQM: request DEC private mode status (CSI ? mode $ p).
 *  Terminal replies with DECRPM (CSI ? mode ; status $ y) or ignores. */
export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === 'decrpm' && r.mode === mode,
  }
}

/** Primary Device Attributes query (CSI c). Every terminal answers this —
 *  used internally by flush() as a universal sentinel. Call directly if
 *  you want the DA1 params. */
export function da1(): TerminalQuery<Da1Response> {
  return {
    request: csi('c'),
    match: (r): r is Da1Response => r.type === 'da1',
  }
}

/** Secondary Device Attributes query (CSI > c). Returns terminal version. */
export function da2(): TerminalQuery<Da2Response> {
  return {
    request: csi('>c'),
    match: (r): r is Da2Response => r.type === 'da2',
  }
}

/** Query current Kitty keyboard protocol flags (CSI ? u).
 *  Terminal replies with CSI ? flags u or ignores. */
export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return {
    request: csi('?u'),
    match: (r): r is KittyResponse => r.type === 'kittyKeyboard',
  }
}

/** DECXCPR: request cursor position with DEC-private marker (CSI ? 6 n).
 *  Terminal replies with CSI ? row ; col R. The `?` marker is critical —
 *  the plain DSR form (CSI 6 n → CSI row;col R) is ambiguous with
 *  modified F3 keys (Shift+F3 = CSI 1;2 R, etc.). */
export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi('?6n'),
    match: (r): r is CursorPosResponse => r.type === 'cursorPosition',
  }
}

/** OSC dynamic color query (e.g. OSC 11 for bg color, OSC 10 for fg).
 *  The `?` data slot asks the terminal to reply with the current value. */
export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === code,
  }
}

/** OSC 52 clipboard read query (ESC ] 52 ; c ; ? ST/BEL).
 *  Asks the terminal to reply with the clipboard contents as
 *  `ESC ] 52 ; c ; <base64> ST`. The terminal must support OSC 52 *read*
 *  (iTerm2/kitty/wezterm, usually opt-in; Alacritty/Windows Terminal do
 *  not). When the clipboard holds an image, supporting terminals return
 *  the raw image bytes base64-encoded. Resolves `undefined` when the
 *  terminal ignores the query (detected via the DA1 sentinel in flush()).
 *  This is the only mechanism that can pull a *local* clipboard image to a
 *  remote process over a plain SSH session — bracketed paste cannot carry
 *  image bytes. SSH-survives: the query/reply goes through the pty, not the
 *  environment. */
export function osc52Read(): TerminalQuery<OscResponse> {
  return {
    request: osc(OSC.CLIPBOARD, 'c', '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === OSC.CLIPBOARD,
  }
}

/** XTVERSION: request terminal name/version (CSI > 0 q).
 *  Terminal replies with DCS > | name ST (e.g. "xterm.js(5.5.0)") or ignores.
 *  This survives SSH — the query goes through the pty, not the environment,
 *  so it identifies the *client* terminal even when TERM_PROGRAM isn't
 *  forwarded. Used to detect xterm.js for wheel-scroll compensation. */
export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
  }
}

// -- Querier --

/** Sentinel request sequence (DA1). Kept internal; flush() writes it. */
const SENTINEL = csi('c')

type Pending =
  | {
      kind: 'query'
      match: (r: TerminalResponse) => boolean
      resolve: (r: TerminalResponse | undefined) => void
    }
  | { kind: 'sentinel'; resolve: () => void }
  /**
   * Resync barrier (CC 2.1.275 #15). After a stdout backpressure episode
   * the terminal's response stream may contain stale bytes written before
   * the stall. `resync({probe:true})` pushes a barrier and writes a DA1
   * sentinel; every response arriving while the barrier is at the front of
   * the queue is swallowed until that DA1 comes back — everything after it
   * is post-resync and trustworthy. Official v276:
   * `resync({probe:e}){...if(e&&this.isInputAttached)this.queue.push(
   * {kind:"barrier"}),this.stdout.write(k)}` @202543231 + onResponse guard
   * `if(this.queue[0]?.kind==="barrier"){if(e.type==="da1")this.queue.shift();return}`.
   */
  | { kind: 'barrier' }

export class TerminalQuerier {
  /**
   * Interleaved queue of queries and sentinels in send order. Terminals
   * respond in order, so each flush() barrier only drains queries queued
   * before it — concurrent batches from independent callers stay isolated.
   */
  private queue: Pending[] = []

  /**
   * Whether the stdin parser is currently routing responses here. The
   * renderer clears this while stdin is suspended (official
   * `isInputAttached` guard on the resync probe — probing while input is
   * detached would leave a barrier nobody can shift).
   */
  isInputAttached = true

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * Number of callers still owed a resolution (queries + sentinels).
   * Official `owed()` used by `drainStdin()`: when a shutdown races
   * in-flight queries, resync (without probe) resolves them all so
   * `await querier.send(...)` callers can't hang the exit path.
   */
  owed(): number {
    return this.queue.reduce(
      (n, p) => (p.kind === 'query' || p.kind === 'sentinel' ? n + 1 : n),
      0,
    )
  }

  /**
   * Resolve every pending query/sentinel immediately — callers get
   * `undefined` (query) / plain resolution (sentinel) — optionally
   * installing a resync barrier so subsequent stale responses are
   * swallowed until a fresh DA1 round-trip completes.
   *
   * Called by the renderer when a stdout backpressure episode ends
   * (`handleStdoutBackpressure` → `querier.resync({probe: endedBy==='drain'})`,
   * official @202889122) and by `drainStdin()` with `{probe:false}`.
   */
  resync({ probe }: { probe: boolean }): void {
    for (const pending of this.queue.splice(0)) {
      if (pending.kind === 'query') pending.resolve(undefined)
      else if (pending.kind === 'sentinel') pending.resolve()
    }
    if (probe && this.isInputAttached) {
      this.queue.push({ kind: 'barrier' })
      this.stdout.write(SENTINEL)
    }
  }

  /**
   * Send a query and wait for its response.
   *
   * Resolves with the response when `query.match` matches an incoming
   * TerminalResponse, or with `undefined` when a flush() sentinel arrives
   * before any matching response (meaning the terminal ignored the query).
   *
   * Never rejects; never times out on its own. If you never call flush()
   * and the terminal doesn't respond, the promise remains pending.
   */
  send<T extends TerminalResponse>(
    query: TerminalQuery<T>,
  ): Promise<T | undefined> {
    return new Promise(resolve => {
      this.queue.push({
        kind: 'query',
        match: query.match,
        resolve: r => resolve(r as T | undefined),
      })
      this.stdout.write(query.request)
    })
  }

  /**
   * Send the DA1 sentinel. Resolves when DA1's response arrives.
   *
   * As a side effect, all queries still pending when DA1 arrives are
   * resolved with `undefined` (terminal didn't respond → doesn't support
   * the query). This is the barrier that makes send() timeout-free.
   *
   * Safe to call with no pending queries — still waits for a round-trip.
   */
  flush(): Promise<void> {
    return new Promise(resolve => {
      this.queue.push({ kind: 'sentinel', resolve })
      this.stdout.write(SENTINEL)
    })
  }

  /**
   * Dispatch a response parsed from stdin. Called by App.tsx's
   * processKeysInBatch for every `kind: 'response'` item.
   *
   * Matching strategy:
   * - First, try to match a pending query (FIFO, first match wins).
   *   This lets callers send(da1()) explicitly if they want the DA1
   *   params — a separate DA1 write means the terminal sends TWO DA1
   *   responses. The first matches the explicit query; the second
   *   (unmatched) fires the sentinel.
   * - Otherwise, if this is a DA1, fire the FIRST pending sentinel:
   *   resolve any queries queued before that sentinel with undefined
   *   (the terminal answered DA1 without answering them → unsupported)
   *   and signal its flush() completion. Only draining up to the first
   *   sentinel keeps later batches intact when multiple callers have
   *   concurrent queries in flight.
   * - Unsolicited responses (no match, no sentinel) are silently dropped.
   */
  onResponse(r: TerminalResponse): void {
    // While a resync barrier is at the front, swallow every response —
    // they may be stale bytes from before the backpressure episode. The
    // barrier's own DA1 reply clears it; everything after is post-resync.
    if (this.queue[0]?.kind === 'barrier') {
      if (r.type === 'da1') this.queue.shift()
      return
    }

    const idx = this.queue.findIndex(p => p.kind === 'query' && p.match(r))
    if (idx !== -1) {
      const [q] = this.queue.splice(idx, 1)
      if (q?.kind === 'query') q.resolve(r)
      return
    }

    if (r.type === 'da1') {
      const s = this.queue.findIndex(p => p.kind === 'sentinel')
      if (s === -1) return
      for (const p of this.queue.splice(0, s + 1)) {
        if (p.kind === 'query') p.resolve(undefined)
        else if (p.kind === 'sentinel') p.resolve()
        // A 'barrier' swept up here is simply discarded — its DA1 was
        // consumed elsewhere; there is nothing to resolve.
      }
    }
  }
}
