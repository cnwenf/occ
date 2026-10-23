import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'

/**
 * CC 2.1.307 (B4): "Fixed a turn sometimes starting without an SDK MCP
 * server's latest tools when a background task was running."
 *
 * Module-level port of the official minified SDK tool-relist state (v2.1.309
 * ELF offsets, byte-verified, never executed; v309 symbol renames vs v307 in
 * parens — `vs`→`wo`, `ka`→`Is`, `Ge`→`$s`, `qs`→`vc`, `Ki`→`wt`,
 * `Vi`→`ia`):
 * - `inFlightSdkRefreshes` = official `Ge`/`$s` counter (incremented around
 *   every updateSdkMcp body and around each kept-previous relist attempt).
 * - `keptPreviousServers` = official `vs`/`wo` — the PENDING set the gate
 *   `vc` iterates (@277789337). OFFICIAL SEMANTICS (v309): the `Vi` relist
 *   loop (@277795447) CONSUMES the set per cycle BEFORE each relist attempt —
 *   `for(let pt of[...wo]){if(!Object.hasOwn(C,pt)){wo.delete(pt);continue}
 *   let Kt=Sn.find((cr)=>cr.name===pt);if(Kt?.type!=="connected")continue;
 *   wo.delete(pt),$s++;try{let cr=await wt(Kt);...}finally{$s--}}` — and the
 *   `wt` kept-previous branch (@277789550 region) re-adds ONLY on
 *   kept_previous: `f("mcp_sdk_tools_refresh","kept_previous"),Is.add(I.name),
 *   wo.add(I.name)`. On gave_up (`if(Is.delete(I.name)){f("mcp_sdk_tools_refresh",
 *   "gave_up");return}`, strings @277789748–277789897) the name is NOT
 *   re-added to `wo`, so after two consecutive kept-previous failures the
 *   official gate DISARMS until a new list_changed notification re-adds the
 *   name (@277884463: `Is.delete(ie.server_name),wo.add(ie.server_name)`
 *   then `ia("skip")`). The official disable path clears both sets
 *   (@277798076: `wo.delete(I),Is.delete(I)`).
 * - `keptAttemptServers` = official `ka`/`Is` — the per-cycle consumption set
 *   the kept-previous branch probes (@277789748 region, quoted above).
 *
 *   DELIBERATE DEVIATION (F-02, v309-verified): OCC's gave_up consumes ONLY
 *   `ka` (keptAttemptServers) and the name STAYS in `vs`
 *   (keptPreviousServers), so OCC's pending gate remains ARMED after gave_up
 *   and successive failures alternate kept_previous/gave_up indefinitely.
 *   This is NOT what the official does — the official `Vi` loop's per-cycle
 *   `wo.delete(pt)` plus the gave_up branch's missing `wo.add` disarm the
 *   official gate until the next list_changed notification. OCC keeps the
 *   gate armed because OCC has NO `Vi` relist runner: nothing re-attempts
 *   the relist between turn starts, so disarming on gave_up would leave a
 *   twice-failed server serving STALE tools with a SILENT gate — the exact
 *   bug class B4 fixed ("a turn sometimes starting without an SDK MCP
 *   server's latest tools"). The conservative cost of staying armed is one
 *   no-op updateSdkMcp + one sdk_mcp_relist_wait diag log per turn start
 *   while the failure persists. (An earlier single-set collapse wrongly
 *   disarmed OCC's gate on gave_up — regression-pinned by
 *   sdkToolRelist307.test.ts.)
 * - `sdkToolRelistPending()` = official `qs`/`vc` (@45784973 / @277789337):
 *   `Ge>0 || [...vs].some(name => configured && connected)`.
 * - `sdkUpdateWaitBudgetMs()` = official `dWe` (@19314170):
 *   `MCP_CONNECT_TIMEOUT_MS > 0 ? Math.min(env, 2147483647) : 5000`.
 * - `raceWithTimeout()` = official `Oe` race helper: resolves `undefined` on
 *   timeout (never rejects); usage evidence @364386 (`await
 *   Oe(n().then(()=>!0),r)===void 0`) and @150132.
 * - `sdkToolRelistJoin()` = official `fi.sdkToolRelistJoin` (@401245),
 *   awaited per queued command in the turn_joins phase.
 *
 * Documented deviations (OCC has no equivalent surface):
 * - No `sdkMcpBackgroundRetry` concept in OCC → treated as false (the join
 *   guard `this.sdkMcpBackgroundRetry` is omitted).
 * - No named-counter telemetry API (`f`/`g` over the official
 *   `mcp_sdk_tools_refresh` counter allowlist) → mapped to
 *   `logEvent('tengu_mcp_sdk_tools_refresh', { action })` with the fixed
 *   protocol strings cast per the listPagination.ts precedent. The official
 *   success path's counter CLEAR (`g()`) has no logEvent equivalent and is
 *   dropped (state clear still happens via sdkToolRelistSuccess).
 * - `updateSdkMcp` in OCC takes no `"skip"`/`"redial"` kind argument.
 */

/** Official `Ge`: number of updateSdkMcp / kept-relist attempts in flight. */
let inFlightSdkRefreshes = 0

/** Official `vs`: servers whose relist is still PENDING (qs() iterates this). */
const keptPreviousServers = new Set<string>()

/**
 * Official `ka`/`Is`: servers whose CURRENT kept-previous cycle has been
 * consumed. OCC DELIBERATE DEVIATION (see module header): gave_up deletes
 * from here ONLY — `vs` retains the name so the gate stays armed for the
 * next cycle, whereas the official `Vi` loop's per-cycle `wo.delete`
 * disarms the gate on gave_up until a new list_changed notification.
 */
const keptAttemptServers = new Set<string>()

/**
 * Official `qs` consults `Object.hasOwn(P, name)` (sdkMcpConfigs) and
 * `hn.some(c => c.name === name && c.type === "connected")` (sdkClients).
 * Those live in print.ts's closure, so the registry is injected from there.
 */
export type SdkServerRegistry = {
  isConfigured: (name: string) => boolean
  isConnected: (name: string) => boolean
}

let serverRegistry: SdkServerRegistry | undefined

export function setSdkServerRegistry(
  registry: SdkServerRegistry | undefined,
): void {
  serverRegistry = registry
}

/** Official `Ge++` — call at the top of the updateSdkMcp body. */
export function beginSdkRefresh(): void {
  inFlightSdkRefreshes++
}

/** Official `finally { Ge-- }` — call in updateSdkMcp's finally block. */
export function endSdkRefresh(): void {
  inFlightSdkRefreshes--
}

/**
 * Official `vc` (v307 `qs`) (@45784973 / @277789337, verbatim semantics):
 * `()=>{if(Ge>0)return!0;for(let I of vs)if(Object.hasOwn(P,I)&&hn.some(
 * (Q)=>Q.name===I&&Q.type==="connected"))return!0;return!1}`
 */
export function sdkToolRelistPending(): boolean {
  if (inFlightSdkRefreshes > 0) {
    return true
  }
  for (const name of keptPreviousServers) {
    if (serverRegistry?.isConfigured(name) && serverRegistry?.isConnected(name)) {
      return true
    }
  }
  return false
}

/**
 * Official `wt` (v307 `Ki`) kept-previous branch (@277789550 region;
 * strings @277789748–277789897, byte-verified in the v2.1.309 ELF):
 * `if(Is.delete(I.name)){f("mcp_sdk_tools_refresh","gave_up");return}
 *  f("mcp_sdk_tools_refresh","kept_previous"),Is.add(I.name),wo.add(I.name)`
 *
 * F-02 (DELIBERATE DEVIATION — see module header for the official disarm
 * semantics and OCC's rationale): gave_up consumes ONLY `ka`
 * (keptAttemptServers). The name STAYS in `vs` (keptPreviousServers), so
 * `vc()`/sdkToolRelistPending() remains armed and successive failures
 * alternate kept_previous/gave_up until a success (sdkToolRelistSuccess)
 * clears both sets. Officially the `Vi` loop's per-cycle `wo.delete(pt)`
 * (@277795447) plus the gave_up branch's missing `wo.add` instead DISARM
 * the gate until a new list_changed notification re-adds the name
 * (@277884463). OCC has no `Vi` runner, so it keeps the gate armed —
 * conservative superset; regression-pinned by sdkToolRelist307.test.ts.
 */
export function sdkToolRelistKeptFailure(serverName: string): void {
  // Fixed protocol strings from the official counter allowlist — never user
  // data, verified not code or filepaths (listPagination.ts precedent).
  if (keptAttemptServers.delete(serverName)) {
    logEvent('tengu_mcp_sdk_tools_refresh', {
      action:
        'gave_up' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return
  }
  logEvent('tengu_mcp_sdk_tools_refresh', {
    action:
      'kept_previous' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  keptAttemptServers.add(serverName)
  keptPreviousServers.add(serverName)
}

/**
 * Official `wt` (v307 `Ki`) success path: `Is.delete(I.name),
 * g("mcp_sdk_tools_refresh")` (@277789900 region) — clears the per-cycle
 * kept mark (the counter-clear `g()` has no OCC equivalent; see module
 * header). Because OCC has no `Vi` relist loop, this ALSO folds in the
 * official `wo` consumption that `Vi` performs per cycle (`wo.delete(pt)`
 * @277795447) and that the disable path pairs with `Is`
 * (`wo.delete(I),Is.delete(I)` @277798076) — a successful relist disarms
 * the pending gate (official AND OCC agree here; the gave_up branch is the
 * deliberate deviation, see sdkToolRelistKeptFailure).
 */
export function sdkToolRelistSuccess(serverName: string): void {
  keptAttemptServers.delete(serverName)
  keptPreviousServers.delete(serverName)
}

/**
 * Official `dWe` (@19314170, verbatim):
 * `function dWe(){let _=a.MCP_CONNECT_TIMEOUT_MS;return _&&_>0?Math.min(_,2147483647):5000}`
 *
 * OCC's official `sdkUpdateWaitBudgetMs()` wrapper additionally maxes against
 * a prewait relay deadline; OCC has no mcpPrewait relay state, so the budget
 * is exactly `dWe()`.
 */
export function sdkUpdateWaitBudgetMs(): number {
  const raw = Number(process.env.MCP_CONNECT_TIMEOUT_MS)
  return raw && raw > 0 ? Math.min(raw, 2147483647) : 5000
}

/**
 * Official `Oe` race helper: resolves with the promise's value, or with
 * `undefined` once `ms` elapses (NEVER rejects on timeout). The timer is
 * cleared when either side settles and unref'd so it can't hold the process
 * open. (src/utils/sleep.ts withTimeout is unusable here: it REJECTS.)
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
    if (typeof timer === 'object') timer.unref?.()
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Official `l`: noop catch so a detached update can't reject unhandled. */
function noopCatch(): void {}

/**
 * Official `fi.sdkToolRelistJoin` (@401245, verbatim semantics):
 * `if(e.shouldQuery===!1||this.sdkMcpBackgroundRetry||
 *   !this.sdkToolRelistPending())return null;
 *  let n=this.sdkUpdateWaitBudgetMs(),r=performance.now(),
 *      s=this.updateSdkMcp("skip");
 *  return Oe(s.then(()=>!0),n).then((h)=>{let S=h!==!0;
 *    if(S)s.catch(l);
 *    X(S?"warn":"info","sdk_mcp_relist_wait",{budget_ms:n,
 *      waited_ms:Math.round(performance.now()-r),timed_out:S,
 *      tools_change_still_pending:this.sdkToolRelistPending()})}).catch(l)`
 *
 * OCC deviations: QueuedCommand has no `shouldQuery` field (structural
 * optional param — the guard never trips for OCC queued commands), no
 * `sdkMcpBackgroundRetry` (treated as false), and `updateSdkMcp` takes no
 * kind argument. X → logForDiagnosticsNoPII.
 */
export function sdkToolRelistJoin(
  // The Record intersection keeps the param from being a TS "weak type" so
  // OCC's QueuedCommand (which has no shouldQuery field — documented
  // deviation) is structurally accepted without a call-site cast.
  command: { shouldQuery?: boolean } & Record<string, unknown>,
  updateSdkMcp: () => Promise<void>,
): Promise<void> | null {
  if (command.shouldQuery === false || !sdkToolRelistPending()) {
    return null
  }
  const budgetMs = sdkUpdateWaitBudgetMs()
  const start = performance.now()
  const update = updateSdkMcp()
  return raceWithTimeout(update.then(() => true), budgetMs)
    .then(completed => {
      const timedOut = completed !== true
      if (timedOut) {
        // Start the turn anyway; detach so a late rejection can't go
        // unhandled (official `if(S)s.catch(l)`).
        update.catch(noopCatch)
      }
      logForDiagnosticsNoPII(
        timedOut ? 'warn' : 'info',
        'sdk_mcp_relist_wait',
        {
          budget_ms: budgetMs,
          waited_ms: Math.round(performance.now() - start),
          timed_out: timedOut,
          tools_change_still_pending: sdkToolRelistPending(),
        },
      )
    })
    .catch(noopCatch)
}

/**
 * Test-only reset (bun runs test files in one shared process; mirrors the
 * resetDirFallbackLogPathForTesting convention in src/utils/debug.ts).
 */
export function resetSdkToolRelistForTesting(): void {
  inFlightSdkRefreshes = 0
  keptPreviousServers.clear()
  keptAttemptServers.clear()
  serverRegistry = undefined
}
