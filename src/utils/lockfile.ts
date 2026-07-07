/**
 * Lazy accessor for proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). Static imports of proper-lockfile pull this
 * cost into the startup path even when no locking happens (e.g. `--help`).
 *
 * Import this module instead of `proper-lockfile` directly. The underlying
 * package is only loaded the first time a lock function is actually called.
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'
import { logForDebugging } from './debug.js'

type Lockfile = typeof import('proper-lockfile')

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}

/**
 * Builds an `onCompromised` handler for proper-lockfile that catches the
 * ECOMPROMISED error and recovers (log + continue) instead of crashing.
 *
 * proper-lockfile's default `onCompromised` throws the ECOMPROMISED error from
 * a setTimeout callback, which surfaces as an unhandled rejection and can
 * crash the process. Every lock-write path must install a handler returned
 * here so a compromised lock (e.g. after a 10s event-loop stall, or another
 * process deleting the lock directory) is logged and recovered (2.1.133).
 *
 * The thrown error carries `error.code === 'ECOMPROMISED'`; this handler is
 * the catch-and-recover for that code.
 */
export function lockCompromisedHandler(
  context: string,
): (err: Error) => void {
  return (err: Error) => {
    logForDebugging(`${context} lock compromised: ${err}`, {
      level: 'error',
    })
  }
}
