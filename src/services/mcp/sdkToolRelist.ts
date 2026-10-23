import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'

/**
 * CC 2.1.307 (B4): "Fixed a turn sometimes starting without an SDK MCP
 * server's latest tools when a background task was running."
 *
 * Module-level port of the official minified SDK tool-relist state:
 * - `inFlightSdkRefreshes` = official `Ge` counter (incremented around every
 *   updateSdkMcp body and around each kept-previous relist attempt).
 * - `keptPreviousServers` = official `vs` (kept-previous server set) merged
 *   with `ka` (kept-attempt tracking). The official keeps two sets because
 *   its `Vi` redial loop deletes from `vs` before re-invoking `Ki`; OCC's
 *   updateSdkMcp has no redial loop, so one set carries both roles. The
 *   observable contract is unchanged: first failure → kept_previous,
 *   repeated failure → gave_up + cleared, success → cleared.
 * - `sdkToolRelistPending()` = official `qs` (@45784973):
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

/** Official `vs` (+`ka`): servers whose last list_changed refresh failed. */
const keptPreviousServers = new Set<string>()

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
 * Official `qs` (@45784973, verbatim semantics):
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
 * Official `Ki` kept-previous branch (@45785250):
 * `if(ka.delete(I.name)){f("mcp_sdk_tools_refresh","gave_up");return}
 *  f("mcp_sdk_tools_refresh","kept_previous"),ka.add(I.name),vs.add(I.name)`
 * (ka/vs collapsed into keptPreviousServers — see module header).
 */
export function sdkToolRelistKeptFailure(serverName: string): void {
  // Fixed protocol strings from the official counter allowlist — never user
  // data, verified not code or filepaths (listPagination.ts precedent).
  if (keptPreviousServers.delete(serverName)) {
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
  keptPreviousServers.add(serverName)
}

/**
 * Official `Ki` success path: `ka.delete(I.name), g("mcp_sdk_tools_refresh")`
 * — clears the kept mark (the counter-clear `g()` has no OCC equivalent; see
 * module header). Also mirrors `Vi`'s post-setup relist `vs.delete(mt)`.
 */
export function sdkToolRelistSuccess(serverName: string): void {
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
  serverRegistry = undefined
}
