import { withTimeout } from './sleep.js'

function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      stream.destroy()
    }
  }
}

// Prevents memory leak when pipe is broken (e.g., `claude -p | head -1`)
export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
  // CC 2.1.299 (#029), official `mDo`: on stderr error the unflushed
  // accounting is abandoned (the reader is gone — those bytes will never
  // flush, and a pending dropped-note would otherwise never be emitted).
  process.stderr.on('error', () => {
    giveUpOnUnflushedStderr()
  })
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return
  }

  // Note: we don't handle backpressure (write() returning false) per-write.
  // Instead, drainStdoutBeforeExit() flushes the whole buffer (via stdout.end)
  // right before process.exit so piped `claude -p` output — including the final
  // result message — is not truncated on large responses (CC 2.1.208 #10).
  stream.write(data)
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data)
}

// ── CC 2.1.299 (#029): bounded stderr writer ──────────────────────────────
//
// "Fixed memory growing without bound when debug output goes to stderr and
// the parent process stops reading it." Official `Fj`/class `f` (byte-verified
// @214764000–214765700 region in /tmp/cc-diff-299/v299/package/claude; the
// `mayDrop` option and this whole bounded writer are v299-NEW — 0 `mayDrop`
// hits in v296). The debug manager wires its stderr arm as
// `writeToStderr:(r)=>{Fj(r,{mayDrop:!0})}` (@214836201).
//
// Official constants (verbatim): `m=1048576` (1 MiB unflushed cap),
// `O=1e4` (10 s staleness). Drop rule (class `f.write`):
//   `t && unflushed.length>=m && (droppedCount>0 || now-since>=O)`
// Once the reader has fallen over 1 MiB AND 10 s behind, mayDrop writes are
// counted and skipped; when the backlog drains under 1 MiB a single WARN note
// (verbatim `reportDropped` text) is emitted to mark the gap.

/** Official `m` — max unflushed stderr bytes before dropping. */
export const STDERR_UNFLUSHED_MAX_BYTES = 1048576

/** Official `O` — reader staleness before dropping starts. */
export const STDERR_DROP_STALE_MS = 10_000

/** Official `reportDropped` note text (verbatim). */
export function stderrDroppedNote(droppedCount: number): string {
  return `[stderr messages dropped before this line: ${droppedCount}. Whatever reads this stderr had not caught up for over 10 s and 1 MiB of output.]\n`
}

type StreamWriteResult = 'dropped' | 'backed-up' | 'accepted'

/** Official `C(e,t,n)`: destroyed/ended → dropped; write()===false → backed-up. */
function writeToStream(
  stream: NodeJS.WriteStream,
  data: string,
  onFlush: () => void,
): StreamWriteResult {
  if (stream.destroyed || stream.writableEnded) return 'dropped'
  return stream.write(data, onFlush) === false ? 'backed-up' : 'accepted'
}

export type BoundedStderrWriter = {
  write: (data: string, mayDrop: boolean) => void
  /** Official `giveUpOnUnflushed` — reset accounting (e.g. on stderr error). */
  giveUpOnUnflushed: () => void
  getUnflushedBytes: () => number
  getDroppedCount: () => number
}

export function createBoundedStderrWriter(
  stream: NodeJS.WriteStream,
  now: () => number = Date.now,
): BoundedStderrWriter {
  let unflushedBytes = 0
  let unflushedSince = 0
  let droppedCount = 0

  function reportDropped(): void {
    if (droppedCount > 0 && unflushedBytes < STDERR_UNFLUSHED_MAX_BYTES) {
      const note = stderrDroppedNote(droppedCount)
      droppedCount = 0
      writer.write(note, false)
    }
  }

  const writer: BoundedStderrWriter = {
    write(data: string, mayDrop: boolean): void {
      if (
        mayDrop &&
        unflushedBytes >= STDERR_UNFLUSHED_MAX_BYTES &&
        (droppedCount > 0 || now() - unflushedSince >= STDERR_DROP_STALE_MS)
      ) {
        droppedCount++
        return
      }
      let state: 'writing' | 'unflushed' | 'flushed' = 'writing'
      const onFlush = (): void => {
        const wasUnflushed = state === 'unflushed'
        state = 'flushed'
        if (wasUnflushed) {
          unflushedBytes = Math.max(0, unflushedBytes - data.length)
          reportDropped()
        }
      }
      const result = writeToStream(stream, data, onFlush)
      if (result === 'backed-up' && state === 'writing') {
        state = 'unflushed'
        if (unflushedBytes === 0) unflushedSince = now()
        unflushedBytes += data.length
      }
    },
    giveUpOnUnflushed(): void {
      unflushedBytes = 0
      unflushedSince = 0
      reportDropped()
    },
    getUnflushedBytes: () => unflushedBytes,
    getDroppedCount: () => droppedCount,
  }
  return writer
}

const boundedStderr = createBoundedStderrWriter(process.stderr)

/**
 * Write to stderr through the bounded writer (official `Fj`). `mayDrop`
 * defaults false (important messages always attempt a write); the debug→stderr
 * path passes true so a stalled reader cannot grow memory without bound.
 */
export function writeToStderr(
  data: string,
  { mayDrop = false }: { mayDrop?: boolean } = {},
): void {
  boundedStderr.write(data, mayDrop)
}

/** Reset the process-stderr bounded writer accounting (testing only). */
export function giveUpOnUnflushedStderr(): void {
  boundedStderr.giveUpOnUnflushed()
}

// Per-stream cached drain promise (mirrors CC 2.1.210 `oti`), so a second call
// reuses the in-flight drain rather than calling end() twice.
const stdoutDrainPromises = new WeakMap<NodeJS.WriteStream, Promise<void>>()

/**
 * Flush stdout before process.exit so large piped `claude -p` responses are not
 * truncated and the final result message is delivered (CC 2.1.208 #10).
 *
 * When stdout is a pipe (non-TTY) and the response is large, `process.exit()`
 * kills the event loop before the OS drains the write buffer — dropping the tail
 * (the result message). `stream.end(cb)` flushes the buffer and resolves once
 * drained, capped by `timeoutMs` so a dead pipe can't hang shutdown.
 *
 * No-op for TTY (interactive), already-destroyed, or already-ended stdout.
 * Mirrors CC 2.1.210 binary `drainStdoutBeforeExit` (`S_t`):
 *   if (t.isTTY || t.destroyed || t.writableEnded) return;
 *   await Ha(new Promise(r => t.end(r)), e, "stdout drain timeout (exit)").catch(()=>{})
 */
export async function drainStdoutBeforeExit(
  timeoutMs = 2000,
  stream: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  let drain = stdoutDrainPromises.get(stream)
  if (drain === undefined) {
    if (stream.isTTY || stream.destroyed || stream.writableEnded) {
      drain = Promise.resolve()
    } else {
      drain = new Promise<void>(resolve => {
        stream.end(() => resolve())
      })
    }
    stdoutDrainPromises.set(stream, drain)
  }
  // withTimeout rejects on expiry; swallow so a dead pipe never blocks exit.
  await withTimeout(drain, timeoutMs, 'stdout drain timeout (exit)').catch(
    () => {},
  )
}

// Write error to stderr and exit with code 1. Consolidates the
// console.error + process.exit(1) pattern used in entrypoint fast-paths.
export function exitWithError(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

// Wait for a stdin-like stream to close, but give up after ms if no data ever
// arrives. First data chunk cancels the timeout — after that, wait for end
// unconditionally (caller's accumulator needs all chunks, not just the first).
// Returns true on timeout, false on end. Used by -p mode to distinguish a
// real pipe producer from an inherited-but-idle parent stdin.
export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    const onEnd = () => done(false)
    const onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: races timeout against stream end/data events
    const peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
