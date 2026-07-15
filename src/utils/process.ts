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

export function writeToStderr(data: string): void {
  writeOut(process.stderr, data)
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
