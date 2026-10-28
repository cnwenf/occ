/**
 * CC 2.1.312 (#22) — "Changed prompt and agent hooks to run at most 24 at a
 * time per session, sub-agents included, plus at most 12 that have waited
 * longer than their event's timeout; a `timeout` under 1 second now counts as
 * 1 second."
 *
 * Supersedes the single-tier v302 merge (promptAgentConcurrencyCap302.ts) at
 * the production call site. Official binary evidence (2.1.312 linux-x64 ELF,
 * READ-ONLY extracted from /tmp/cc-diff-312/v312/package/claude):
 *
 *   @251761428 constants + session state (verbatim):
 *     import{AsyncLocalStorage as cEr}from"async_hooks";
 *     var Wet=12,kvn=24,fEr=12,pEr=1,bvn=1e4;
 *     class Rvn{slots=new byt;holder=new cEr}
 *     var Mvn=new W(()=>new Rvn),Uet="model hooks",mEr="overdue model hooks";
 *     function zB(e){return e.type==="prompt"||e.type==="agent"}
 *     function BM(e,n){return e.timeout?Math.max(e.timeout,pEr)*1000:n}
 *
 *   @250558442 `byt` — named-pool counting semaphore (verbatim):
 *     class byt{#e=new Map;acquire(e,n,r){…}wouldWait(e,n){…}occupy(e){…}
 *       #t(e){while(e.waiters.length>0&&e.active<e.waiters[0].limit){…}}
 *       #n(e){…}}
 *
 *   @250558987 `P0r` — bounded seat wait (verbatim):
 *     async function P0r(e,n,r,s,{waitLimitMs:h,onWait:y}){
 *       if(e.wouldWait(n,r))y?.();
 *       let S=us(s,{timeoutMs:h,refTimer:!0}),w=await e.acquire(n,r,S.signal);
 *       if(S.cleanup(),w===void 0&&s.aborted)return;
 *       let H=()=>{w?.(),w=void 0};
 *       return{seated:w!==void 0,release:H,retake:()=>{w??=e.occupy(n)},
 *              [Symbol.dispose]:H}}
 *
 *   @251761660 `Ovn` — two-tier merge (verbatim):
 *     async function*Ovn(e,n,r){let s=new AbortController,h=e.map((w,H)=>n(H)),
 *       y=e.flatMap(…),S=Promise.resolve();try{yield*y.length<=1
 *         ?lht(e.map((w,H)=>{…wvn(w,G,r,s.signal)…}))
 *         :lht([...e.filter((w,H)=>h[H]===void 0),
 *             lht(y.map(async function*({run:w,limitMs:H}){S=S.then(Cg),
 *               await S,yield*wvn(w,H,r,s.signal)}),Wet)])}finally{s.abort()}}
 *
 *   `wvn` — seating wrapper (verbatim): first next() checks merge abort →
 *     ALS reentrancy guard (`r.holder.getStore()?.isHeld===!0` → run unseated)
 *     → fast path (`!wouldWait(Uet,kvn)` → occupy) → slow path (bounded wait
 *     `P0r(slots,Uet,kvn,H,{waitLimitMs:h})`; `seated===false` → fall back to
 *     `slots.acquire(mEr,fEr,H)`); parent-aborted mid-wait → `e.return()`.
 *
 *   `vvn` — held step (verbatim): `setTimeout(release,
 *     Math.min(s,Bd-bvn)+bvn)` keepalive (Bd=2147483647, bvn=1e4) +
 *     `n.holder.run({isHeld:true},()=>e.next())`; the seat is released when
 *     the first step settles (or when the keepalive fires for a hung step).
 *
 *   @251922088 production call site (verbatim):
 *     Ti=w===void 0||It?lht(yr):Ovn(yr,(Ho)=>{let Ds=cn[Ho];return zB(Ds.hook)
 *       &&Br[Ho]===void 0&&Ds.notTested===void 0
 *       &&!(lt==="PermissionRequest"&&Ds.hook.type==="agent")
 *       &&Lr(Ds,!1).ok?BM(Ds.hook,S):void 0},
 *       {slots:Mvn.of(w.session.host),signal:y,limitMs:S})
 *     (cCr destructures `timeoutMs:S=Hf` — Hf=600000; It=w?.remoteCall!==void 0)
 *
 * Porting notes / documented deviations (never-invent rule):
 * - `lht` = OCC `all(generators, concurrencyCap)` in src/utils/generators.ts
 *   (pinned since the v302 round); `us` = OCC `createCombinedAbortSignal`
 *   (lacks only the official `refTimer` option — OCC always unrefs the timer);
 *   `Cg` microtask deferral = the same `Promise.resolve()` equivalent the
 *   v302 port used.
 * - Session state: official `Mvn.of(w.session.host)` keys one Rvn per host.
 *   OCC runs one session per process and sub-agents execute in-process, so a
 *   lazily created module singleton gives the same session-wide sharing
 *   ("sub-agents included": every dispatch sees the same 24 seats).
 * - waitLimitMs source: the official passes the SESSION ctx `limitMs` (the
 *   event's default timeoutMs, `S`) as the bounded wait, while the per-hook
 *   BM value drives the vvn keepalive timer — mirrored exactly here.
 * - Call-site predicate components with no OCC surface are NOT ported:
 *   `Br[Ho]===void 0` (precomputed skip/dedup markers — OCC dedupes at match
 *   time), `Ds.notTested===void 0` (OCC MatchedHook has no notTested),
 *   `Lr(Ds,!1).ok` (hook-input stringify check — OCC's per-hook generator
 *   fails closed on jsonInput errors instead), `It` (remoteCall mode — OCC
 *   has no served-call surface). The PermissionRequest+agent exclusion IS
 *   ported (OCC agent hooks throw for that event).
 * - Official `wvn` also exposes `[Symbol.asyncDispose]`; OCC has no
 *   async-disposal surface (grep-verified zero usages) so it is omitted.
 * - Official `P0r`'s `[Symbol.dispose]` is omitted for the same reason;
 *   `retake` is kept (verbatim) for parity even though the merge path only
 *   consumes `seated`/`release`.
 * - The remote keepalive stream (`ott`/`nEn`, gated on
 *   CLAUDE_CODE_REMOTE_SEND_KEEPALIVES + tengu_ccr_hook_keepalive_enabled) is
 *   NOT portable — same conclusion as the v302 round.
 * - The official command/callback/http timeout derivations have NO floor
 *   (@251904162 `Ho.timeout?Math.min(zB(Ho)?BM(Ho,S):Ho.timeout*1000,Bd):S`,
 *   @251902451 callback, @251785385 http): the 1s floor applies to
 *   prompt/agent hooks only, wired via hookTimeoutMs (BM).
 */

import { AsyncLocalStorage } from 'async_hooks'
import { all } from '../generators.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { isPromptOrAgentHook } from './promptAgentConcurrencyCap302.js'

export { isPromptOrAgentHook }

// ---------------------------------------------------------------------------
// Constants — official verbatim values (@251761428)
// ---------------------------------------------------------------------------

/** Official `Wet` — per-event stagger cap for prompt/agent hooks (retained from v302 `ant`). */
export const HOOK_STAGGER_CONCURRENCY_CAP = 12

/** Official `kvn` — session-wide cap: at most 24 prompt/agent hooks at a time, sub-agents included. */
export const HOOK_SESSION_CONCURRENCY_CAP = 24

/** Official `fEr` — overdue cap: at most 12 hooks that waited longer than their event's timeout. */
export const HOOK_OVERDUE_CONCURRENCY_CAP = 12

/** Official `pEr` — a `timeout` under 1 second counts as 1 second. */
export const HOOK_TIMEOUT_FLOOR_SECONDS = 1

/** Official `bvn=1e4` — keepalive grace added to the seat release timer. */
export const SLOT_KEEPALIVE_GRACE_MS = 10_000

/** Official `Bd=2147483647` — max setTimeout delay (also caps hook timeouts). */
export const MAX_HOOK_TIMEOUT_MS = 2_147_483_647

/** Official `Uet="model hooks"` — the session seat pool name. */
export const SESSION_HOOKS_POOL = 'model hooks'

/** Official `mEr="overdue model hooks"` — the overdue admission pool name. */
export const OVERDUE_HOOKS_POOL = 'overdue model hooks'

/**
 * Official `BM` (@251761660, verbatim):
 *   function BM(e,n){return e.timeout?Math.max(e.timeout,pEr)*1000:n}
 * The truthiness branch is verbatim too: `timeout: 0` falls back to the
 * event default instead of flooring to 1s.
 */
export function hookTimeoutMs(
  hook: { timeout?: number },
  defaultMs: number,
): number {
  return hook.timeout
    ? Math.max(hook.timeout, HOOK_TIMEOUT_FLOOR_SECONDS) * 1000
    : defaultMs
}

/**
 * Official `vvn` keepalive delay: `Math.min(s,Bd-bvn)+bvn`. Exported as a
 * pure function so the formula is unit-testable without a 10s+ real timer.
 */
export function seatKeepaliveDelayMs(limitMs: number): number {
  return (
    Math.min(limitMs, MAX_HOOK_TIMEOUT_MS - SLOT_KEEPALIVE_GRACE_MS) +
    SLOT_KEEPALIVE_GRACE_MS
  )
}

/** Official `Yg`/`Cg` — microtask deferral staggering the capped stream's starts (same equivalent as the v302 port). */
const yieldMicrotask = (): Promise<void> => Promise.resolve()

// ---------------------------------------------------------------------------
// HookSlotSemaphore — official `byt` (@250558442)
// ---------------------------------------------------------------------------

type SlotWaiter = {
  limit: number
  signal: AbortSignal
  grant: () => void
  cancel: () => void
}

type SlotPool = {
  active: number
  waiters: SlotWaiter[]
}

/** Seat release callback returned by acquire/occupy. */
export type SlotRelease = () => void

/**
 * Official `byt` — named-pool counting semaphore. Each pool tracks
 * {active, waiters[]}; waiters are granted FIFO by the pump (`#t`) when a
 * seat frees, and abort-linked (an aborted waiter resolves undefined and is
 * removed from the queue).
 */
export class HookSlotSemaphore {
  readonly #pools = new Map<string, SlotPool>()

  /**
   * Official `acquire(e,n,r)`: resolve a release fn when seated, or undefined
   * if the signal aborted before/while queued. Grants immediately only when
   * below the limit AND nobody is queued (strict FIFO).
   */
  acquire(
    poolName: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<SlotRelease | undefined> {
    const pool = this.#pool(poolName)
    const release: SlotRelease = () => {
      pool.active -= 1
      this.#pump(pool)
    }
    if (signal.aborted) {
      return Promise.resolve(undefined)
    }
    if (pool.active < limit && pool.waiters.length === 0) {
      pool.active += 1
      return Promise.resolve(release)
    }
    return new Promise<SlotRelease | undefined>(resolve => {
      const waiter: SlotWaiter = {
        limit,
        signal,
        grant: () => {
          signal.removeEventListener('abort', onAbort)
          resolve(release)
        },
        cancel: () => resolve(undefined),
      }
      // Official `w`: abort removes the waiter from the queue, resolves
      // undefined, and re-pumps so the next waiter can be granted.
      function onAbort(): void {
        const index = pool.waiters.indexOf(waiter)
        if (index !== -1) {
          pool.waiters.splice(index, 1)
        }
        resolve(undefined)
        pump()
      }
      const pump = (): void => this.#pump(pool)
      pool.waiters.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      pump()
    })
  }

  /** Official `wouldWait(e,n)`: saturated OR anyone already queued. */
  wouldWait(poolName: string, limit: number): boolean {
    const pool = this.#pool(poolName)
    return pool.active >= limit || pool.waiters.length > 0
  }

  /** Official `occupy(e)`: take a seat unconditionally (fast path), returns its release. */
  occupy(poolName: string): SlotRelease {
    const pool = this.#pool(poolName)
    pool.active += 1
    return () => {
      pool.active -= 1
      this.#pump(pool)
    }
  }

  /**
   * Test seam (OCC deviation — the official exposes no introspection):
   * current active-seat count of a pool.
   */
  activeCount(poolName: string): number {
    return this.#pool(poolName).active
  }

  /** Official `#t(e)` — FIFO grant pump, skipping (cancelling) aborted waiters. */
  #pump(pool: SlotPool): void {
    while (pool.waiters.length > 0 && pool.active < pool.waiters[0]!.limit) {
      const waiter = pool.waiters.shift()!
      if (waiter.signal.aborted) {
        waiter.cancel()
        continue
      }
      pool.active += 1
      waiter.grant()
    }
  }

  /** Official `#n(e)` — lazy per-name pool creation. */
  #pool(poolName: string): SlotPool {
    const existing = this.#pools.get(poolName)
    if (existing) {
      return existing
    }
    const created: SlotPool = { active: 0, waiters: [] }
    this.#pools.set(poolName, created)
    return created
  }
}

// ---------------------------------------------------------------------------
// Session state — official `Rvn` + `Mvn` (@251761428)
// ---------------------------------------------------------------------------

/** Official holder store shape: `vvn` runs each held step with `{isHeld:!0}`. */
export type HeldStepStore = { isHeld: boolean }

/**
 * Official `Rvn` (verbatim): `class Rvn{slots=new byt;holder=new cEr}` —
 * one semaphore + one AsyncLocalStorage holder per session.
 */
export class HookSessionSlots {
  readonly slots = new HookSlotSemaphore()
  readonly holder = new AsyncLocalStorage<HeldStepStore>()
}

let sessionSlotsSingleton: HookSessionSlots | undefined

/**
 * Official `Mvn.of(w.session.host)` — lazily created per-host singleton.
 * OCC deviation: one session per process (sub-agents execute in-process), so
 * a module singleton provides the same session-wide sharing; every hook
 * dispatch, main agent or sub-agent, seats against the SAME 24 slots.
 */
export function getHookSessionSlots(): HookSessionSlots {
  sessionSlotsSingleton ??= new HookSessionSlots()
  return sessionSlotsSingleton
}

/** Test-only: drop the singleton so each test gets fresh session state. */
export function resetHookSessionSlotsForTest(): void {
  sessionSlotsSingleton = undefined
}

// ---------------------------------------------------------------------------
// Bounded seat wait — official `P0r` (@250558987)
// ---------------------------------------------------------------------------

/** Official `P0r` result: `seated:false` means "waited past waitLimitMs". */
export type BoundedSeat = {
  seated: boolean
  release: () => void
  retake: () => void
}

/**
 * Official `P0r` — wait at most `waitLimitMs` for a pool seat. Resolves
 * undefined only when the outer signal aborted AND no seat was taken;
 * otherwise {seated, release, retake}. `seated:false` is the changelog's
 * "waited longer than their event's timeout" trigger for the overdue pool.
 *
 * Deviation: the official combines with `us(s,{timeoutMs:h,refTimer:!0})`;
 * OCC's createCombinedAbortSignal has no refTimer option and always unrefs
 * the timer. The official `[Symbol.dispose]` alias of release is omitted
 * (no OCC async-disposal surface).
 */
export async function acquireBoundedSeat(
  slots: HookSlotSemaphore,
  poolName: string,
  limit: number,
  signal: AbortSignal,
  options: { waitLimitMs: number; onWait?: () => void },
): Promise<BoundedSeat | undefined> {
  const { waitLimitMs, onWait } = options
  if (slots.wouldWait(poolName, limit)) {
    onWait?.()
  }
  const { signal: waitSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: Math.min(waitLimitMs, MAX_HOOK_TIMEOUT_MS),
  })
  const acquired = await slots.acquire(poolName, limit, waitSignal)
  cleanup()
  if (acquired === undefined && signal.aborted) {
    return undefined
  }
  let current = acquired
  const releaseOnce = (): void => {
    current?.()
    current = undefined
  }
  return {
    seated: acquired !== undefined,
    release: releaseOnce,
    retake: () => {
      current ??= slots.occupy(poolName)
    },
  }
}

// ---------------------------------------------------------------------------
// Held step — official `vvn`
// ---------------------------------------------------------------------------

/**
 * Official `vvn` (verbatim):
 *   function vvn(e,n,r,s){if(r===void 0)return e.next();
 *     let h={isHeld:!0},y=()=>{if(h.isHeld)h.isHeld=!1,r()},
 *     S=setTimeout(y,Math.min(s,Bd-bvn)+bvn);S.unref?.();
 *     let w=()=>{clearTimeout(S),y()},H=n.holder.run(h,()=>e.next());
 *     return H.then(w,w),H}
 *
 * Runs one generator step inside the ALS holder (nested dispatches see
 * isHeld and skip seating — reentrancy guard), holding the seat until the
 * step settles. The keepalive timer releases a seat whose step hangs past
 * limitMs + 10s grace. `release === undefined` → unseated passthrough.
 */
function runHeldStep<A>(
  run: AsyncGenerator<A, void>,
  session: HookSessionSlots,
  release: SlotRelease | undefined,
  limitMs: number,
): Promise<IteratorResult<A, void>> {
  if (release === undefined) {
    return run.next()
  }
  const held: HeldStepStore = { isHeld: true }
  const releaseOnce = (): void => {
    if (held.isHeld) {
      held.isHeld = false
      release()
    }
  }
  const keepalive = setTimeout(releaseOnce, seatKeepaliveDelayMs(limitMs))
  keepalive.unref?.()
  const settle = (): void => {
    clearTimeout(keepalive)
    releaseOnce()
  }
  const step = session.holder.run(held, () => run.next())
  step.then(settle, settle)
  return step
}

// ---------------------------------------------------------------------------
// Seating wrapper — official `wvn`
// ---------------------------------------------------------------------------

/** Official call-site third argument: `{slots:Mvn.of(w.session.host),signal:y,limitMs:S}`. */
export type HookSeatContext = {
  /** Official property name is `slots` (holding the whole Rvn); renamed for OCC clarity. */
  session: HookSessionSlots
  /** Official `y` — the event dispatch's parent abort signal. */
  signal?: AbortSignal
  /** Official `S` — the event's default timeoutMs (bounded-wait limit). */
  limitMs: number
}

/**
 * Official `wvn` — wraps one per-hook generator with session seating. Not an
 * async generator (the official returns a custom iterator object): the first
 * next() performs seat acquisition, later next() calls pass through.
 *
 * Seat flow (verbatim): merge-aborted → `e.return()`; inside a held step
 * (ALS isHeld) → run unseated; fast path (no wait predicted) → `occupy`;
 * slow path → bounded wait up to ctx.limitMs, then either the granted seat
 * or (seated:false) the overdue pool (`acquire(mEr,fEr)`, unbounded wait);
 * parent-aborted after the wait → release + `e.return()`.
 *
 * Deviation: `[Symbol.asyncDispose]` passthrough omitted (no OCC surface).
 */
export function wrapHookGeneratorWithSessionSeat<A>(
  run: AsyncGenerator<A, void>,
  limitMs: number,
  ctx: HookSeatContext,
  mergeSignal: AbortSignal,
): AsyncGenerator<A, void> {
  const { session, signal: parentSignal, limitMs: waitLimitMs } = ctx
  let seated = false
  const wrapper = {
    next: (): Promise<IteratorResult<A, void>> => {
      if (seated) {
        return run.next()
      }
      seated = true
      if (mergeSignal.aborted) {
        return run.return(undefined as never)
      }
      if (session.holder.getStore()?.isHeld === true) {
        return run.next()
      }
      if (
        !session.slots.wouldWait(SESSION_HOOKS_POOL, HOOK_SESSION_CONCURRENCY_CAP)
      ) {
        return runHeldStep(
          run,
          session,
          session.slots.occupy(SESSION_HOOKS_POOL),
          limitMs,
        )
      }
      // Official: us(s,{signalB:y}) — parent dispatch signal + per-merge signal.
      const { signal: combined, cleanup } = createCombinedAbortSignal(
        parentSignal,
        { signalB: mergeSignal },
      )
      return acquireBoundedSeat(
        session.slots,
        SESSION_HOOKS_POOL,
        HOOK_SESSION_CONCURRENCY_CAP,
        combined,
        { waitLimitMs },
      )
        .then(waiter =>
          waiter?.seated === false
            ? session.slots.acquire(
                OVERDUE_HOOKS_POOL,
                HOOK_OVERDUE_CONCURRENCY_CAP,
                combined,
              )
            : waiter?.release,
        )
        .then((release): Promise<IteratorResult<A, void>> => {
          cleanup()
          if (mergeSignal.aborted) {
            release?.()
            return run.return(undefined as never)
          }
          return runHeldStep(run, session, release, limitMs)
        })
    },
    return: (value?: unknown): Promise<IteratorResult<A, void>> =>
      run.return(value as never),
    throw: (error?: unknown): Promise<IteratorResult<A, void>> =>
      run.throw(error),
    [Symbol.asyncIterator]: () => wrapper as AsyncGenerator<A, void>,
  }
  return wrapper as AsyncGenerator<A, void>
}

// ---------------------------------------------------------------------------
// Two-tier merge — official `Ovn` (@251761660)
// ---------------------------------------------------------------------------

/**
 * Official `Ovn` — merge per-event hook generators under the two-tier cap:
 * - ≤1 seat-eligible generator → plain uncapped merge of individually
 *   wrapped generators (wrapper still seats it against the session pool).
 * - Otherwise → outer uncapped merge of [non-eligible generators, inner
 *   staggered merge capped at HOOK_STAGGER_CONCURRENCY_CAP (Wet=12, the
 *   v302 per-event cap)]. Every eligible generator additionally seats
 *   against the session-wide pool (24) with overdue fallback (12).
 * - The per-merge AbortController is aborted in `finally`, cancelling any
 *   seat wait still queued when the merged stream closes.
 *
 * @param generators per-hook result generators, in matched-hook order
 * @param limitAtIndex official predicate `n(H)`: per-hook timeout ms
 *   (BM value) when the hook is seat-eligible, undefined otherwise
 * @param ctx official `{slots,signal,limitMs}` session context
 */
export async function* mergeHookGeneratorsWithSessionSlots<A>(
  generators: AsyncGenerator<A, void>[],
  limitAtIndex: (index: number) => number | undefined,
  ctx: HookSeatContext,
): AsyncGenerator<A, void> {
  const mergeController = new AbortController()
  const limits = generators.map((_generator, index) => limitAtIndex(index))
  const capped = generators.flatMap((generator, index) => {
    const limitMs = limits[index]
    return limitMs === undefined ? [] : [{ run: generator, limitMs }]
  })
  let staggerChain = Promise.resolve()
  try {
    yield* capped.length <= 1
      ? all(
          generators.map((generator, index) => {
            const limitMs = limits[index]
            return limitMs === undefined
              ? generator
              : wrapHookGeneratorWithSessionSeat(
                  generator,
                  limitMs,
                  ctx,
                  mergeController.signal,
                )
          }),
        )
      : all([
          ...generators.filter((_generator, index) => limits[index] === undefined),
          all(
            capped.map(
              ({ run, limitMs }) =>
                (async function* (): AsyncGenerator<A, void> {
                  staggerChain = staggerChain.then(yieldMicrotask)
                  await staggerChain
                  yield* wrapHookGeneratorWithSessionSeat(
                    run,
                    limitMs,
                    ctx,
                    mergeController.signal,
                  )
                })(),
            ),
            HOOK_STAGGER_CONCURRENCY_CAP,
          ),
        ])
  } finally {
    mergeController.abort()
  }
}
