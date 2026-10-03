import { basename, resolve } from 'path'
import { logForDebugging } from './debug.js'
import { withResolvers } from './withResolvers.js'

/**
 * Transcript load/rewrite coordination — port of the official Claude Code
 * v2.1.288 module @211467183 (window `w288_rwcoord.txt`), recovered verbatim
 * in `docs/gap-research-288/cluster-c-instructions-resume.md` §#12.
 *
 * Fixes #12: "resume occasionally loading a transcript cut short when the same
 * session rewrote the file during the load." A whole-file rewrite (tombstone
 * slow path, remote/CCR-v2 hydrate) that races a `loadTranscriptFile` read of
 * the SAME file can leave the loader observing a truncated file. This registry
 * makes the two sides wait on each other, keyed by resolved path:
 *
 *   - REWRITE side (`acquireRewriteCoordination`, official `wM`): registers the
 *     rewrite, then waits ≤ `loadWaitMs` (5000ms) for in-flight loads of that
 *     path to finish. If they don't, it abandons them (marks them in
 *     `abandonedLoads` so later rewrites don't re-wait) and emits the official
 *     warn log.
 *   - LOAD side (`acquireLoadCoordination`, official `Kyn`): chain-waits every
 *     registered rewrite of that path, then registers the load so a concurrent
 *     rewrite will wait for it.
 *
 * Official shape (byte-faithful in structure; only host-keying simplified):
 *
 *   class Gyn { loads=new Map; rewrites=new Map; abandonedLoads=new WeakSet; loadWaitMs=yCr }
 *   var qyn = new G(() => new Gyn)            // per-host singleton, keyed by U().host
 *   function Vyn(e,n){ ... {[Symbol.dispose]:()=>{...}} }   // deferred-set registry
 *
 * SIMPLIFICATION vs official (@211467183 / @211467560): official keys a
 * per-host singleton `qyn = new G(() => new Gyn)` by `U().host` (multiple
 * storage hosts — local, remote, etc. — each get their own registry). OCC runs
 * as a SINGLE process against a single local storage host, so the host
 * dimension is constant and we collapse to ONE module-level registry. The
 * observable per-path coordination is identical.
 *
 * DISPOSABLE note: official returns `{[Symbol.dispose]: ...}` handles consumed
 * with `using`. OCC's TS config supports `Symbol.dispose` (target ESNext;
 * see src/utils/slowOperations.ts, src/utils/attachments.ts) but the codebase
 * has no `using` declarations, so call sites use try/finally with an explicit
 * `handle[Symbol.dispose]()` — same shape, matching OCC style.
 */

/** Official `yCr = 5000` — rewrite-side max wait for in-flight loads. */
const LOAD_WAIT_MS = 5000

/**
 * Dispose handle returned by both acquisition functions (official `Vyn`'s
 * `{[Symbol.dispose]: ...}`). Disposing removes the deferred from its
 * registry set, deletes the map key when the set empties, and resolves the
 * deferred so any waiter proceeds.
 */
export interface TranscriptCoordinationHandle {
  [Symbol.dispose](): void
}

/** Official `class Gyn`. */
class TranscriptRewriteCoordinator {
  loads = new Map<string, Set<Promise<void>>>()
  rewrites = new Map<string, Set<Promise<void>>>()
  abandonedLoads = new WeakSet<Promise<void>>()
  loadWaitMs = LOAD_WAIT_MS
}

/**
 * Official `qyn` per-host singleton → OCC module-level singleton (single
 * process / single storage host). See SIMPLIFICATION note above.
 */
const coordinator = new TranscriptRewriteCoordinator()

/**
 * Official `lt(promise, ms)`: races `promise` against a `ms` timeout,
 * resolving to the promise's value if it settles in time and `undefined` on
 * timeout (never rejects). The timeout timer is cleared when the race ends.
 */
async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout(undefined), ms)
    if (typeof timer === 'object') timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Official `Vyn(e, n)`: add a fresh deferred to the registry set at `key`,
 * returning a dispose handle that removes it (deleting the now-empty map key)
 * and resolves the deferred.
 */
function registerDeferred(
  registry: Map<string, Set<Promise<void>>>,
  key: string,
): TranscriptCoordinationHandle {
  let set = registry.get(key)
  if (set === undefined) {
    set = new Set()
    registry.set(key, set)
  }
  const theSet = set
  const { promise, resolve } = withResolvers<void>()
  theSet.add(promise)
  return {
    [Symbol.dispose](): void {
      theSet.delete(promise)
      if (theSet.size === 0 && registry.get(key) === theSet) {
        registry.delete(key)
      }
      resolve()
    },
  }
}

/**
 * REWRITE side — official `wM(e)`. Acquire BEFORE any whole-file rewrite of
 * `filePath` (tombstone slow path, remote/CCR-v2 hydrate). Registers the
 * rewrite so concurrent loads wait for it, then waits ≤ `loadWaitMs` for
 * in-flight loads to drain; on timeout, abandons them and warns. Dispose the
 * returned handle (try/finally) once the rewrite is complete.
 */
export async function acquireRewriteCoordination(
  filePath: string,
): Promise<TranscriptCoordinationHandle> {
  const key = resolve(filePath)
  // Snapshot in-flight, non-abandoned loads BEFORE registering the rewrite
  // (official evaluates `s` before `g` in the same `let`).
  const inFlightLoads = [...(coordinator.loads.get(key) ?? [])].filter(
    load => !coordinator.abandonedLoads.has(load),
  )
  const handle = registerDeferred(coordinator.rewrites, key)
  if (inFlightLoads.length > 0) {
    const settled = await raceTimeout(
      Promise.all(inFlightLoads).then(() => true),
      coordinator.loadWaitMs,
    )
    if (settled === undefined) {
      for (const load of inFlightLoads) {
        coordinator.abandonedLoads.add(load)
      }
      // Official warn message — byte-exact (@99524452 / @211467560):
      // `Transcript rewrite stopped waiting after ${loadWaitMs}ms for ${n} load(s) of file ${basename}`
      logForDebugging(
        `Transcript rewrite stopped waiting after ${coordinator.loadWaitMs}ms for ${inFlightLoads.length} load(s) of file ${basename(key)}`,
        { level: 'warn' },
      )
    }
  }
  return handle
}

/**
 * LOAD side — official `Kyn(e)`. Acquire BEFORE the whole-file read in
 * `loadTranscriptFile`. Chain-waits every registered rewrite of `filePath`
 * (looping, since a rewrite may register while we wait), then registers the
 * load so a concurrent rewrite waits for it. Dispose the returned handle
 * (try/finally) once the read is complete.
 */
export async function acquireLoadCoordination(
  filePath: string,
): Promise<TranscriptCoordinationHandle> {
  const key = resolve(filePath)
  for (
    let set = coordinator.rewrites.get(key);
    set !== undefined;
    set = coordinator.rewrites.get(key)
  ) {
    await Promise.all(set)
  }
  return registerDeferred(coordinator.loads, key)
}

/**
 * @internal Test-only accessor for the module-level singleton, so tests can
 * inspect `loads` / `rewrites` map state (e.g. the empty-set-deletes-key
 * dispose behavior) without reaching into private module scope.
 */
export function getTranscriptRewriteCoordinatorForTesting(): TranscriptRewriteCoordinator {
  return coordinator
}

/**
 * @internal Test-only reset: clear the registry maps and restore the default
 * `loadWaitMs`. `abandonedLoads` is a WeakSet (no clear()); its entries are
 * GC'd with the load promises they reference, so a fresh test's promises are
 * never pre-abandoned.
 */
export function resetTranscriptRewriteCoordinatorForTesting(): void {
  coordinator.loads.clear()
  coordinator.rewrites.clear()
  coordinator.loadWaitMs = LOAD_WAIT_MS
}
