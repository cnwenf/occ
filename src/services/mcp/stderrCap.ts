/**
 * Capped stderr accumulator for stdio MCP server processes.
 *
 * A chatty or faulty stdio MCP server can flood its stderr stream until Node's
 * child_process maxBuffer is exceeded (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER` /
 * `" maxBuffer length exceeded"`), crashing the MCP connection and leaking
 * memory. This caps the captured stderr so a runaway server cannot exhaust
 * memory.
 *
 * Matches the official claude-code 2.1.208 #29 mechanism exactly:
 *   handler = (Q) => { if (g.length < 67108864) try { g += Q.toString() } catch {} }
 *
 * - Cap value: `64 * 1024 * 1024` (67108864 bytes).
 * - Retention: head-retention with a SOFT cap — `g.length < cap` is checked
 *   BEFORE appending the whole chunk, so appending stops once the cap is
 *   reached. The chunk that crosses the boundary is appended in full, so the
 *   retained string may exceed the cap by up to one chunk; all subsequent
 *   chunks are dropped (memory is bounded, not unbounded). The most recent
 *   *connect-time* output that fit is retained; later bytes are dropped.
 * - `toString()` conversion + `try/catch` swallow errors from exceeding the
 *   max safe string length.
 *
 * After a successful connection the caller detaches the listener and resumes
 * the stream (see `client.ts`), so this only bounds the connect-time window.
 */

/** Maximum bytes of stderr retained from a stdio MCP server. */
export const MAX_MCP_STDERR_BYTES = 64 * 1024 * 1024

export interface CappedStderrAccumulator {
  /** Stable 'data' listener to attach to a stderr Readable stream. */
  readonly handler: (data: Buffer) => void
  /** The currently accumulated stderr string (soft cap: at most `capBytes` + one chunk in length). */
  getOutput: () => string
  /** Release the accumulated string to free memory. */
  reset: () => void
}

/**
 * Create a capped stderr accumulator. Head-retention: once the accumulated
 * string reaches `capBytes` in length, further chunks are dropped so the
 * retained string never exceeds the cap.
 */
export function createCappedStderrAccumulator(
  capBytes: number = MAX_MCP_STDERR_BYTES,
): CappedStderrAccumulator {
  let output = ''
  return {
    handler: (data: Buffer) => {
      // Stop appending once the cap is reached (head-retention). Matches the
      // binary's `if (g.length < 67108864) try { g += Q.toString() } catch {}`.
      if (output.length < capBytes) {
        try {
          output += data.toString()
        } catch {
          // Ignore errors from exceeding max string length
        }
      }
    },
    getOutput: () => output,
    reset: () => {
      output = ''
    },
  }
}
