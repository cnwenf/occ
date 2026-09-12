/**
 * CC 2.1.268 E63: the "N MCP servers need authentication" startup notice
 * announces each server only ONCE. A server that has been announced in any
 * previous session is not re-announced on the next startup; it re-enters the
 * notice only after it successfully connects (prune) or the session store is
 * reset (/clear). Within the announcing session the notice stays visible (the
 * session set keeps the count stable), matching the official gate:
 *
 *   function net(w,{hasEverConnected:P,connectedThisSession:ee}){
 *     if(w.type!=="needs-auth"||!TEt(w,P,ee))return!1;
 *     return Nt().needsAuthNoticedThisSession.has(w.name)||
 *            !(ne().mcpNeedsAuthNoticed??[]).includes(w.name)}
 *
 * Official 2.1.268 shape (byte-verified from the binary):
 *   - `Z5t=128` — persisted `mcpNeedsAuthNoticed` list capped via slice(-128)
 *   - `dE(e)  = e.type==="failed"&&e.errorCode==="UNCONFIGURED"` (excluded)
 *   - `TEt`   — eligibility filter (claude.ai: excluded when eligible===false
 *               && !connectedThisSession; counted iff hasEverConnected;
 *               local: all except sse-ide/ws-ide)
 *   - `j(n,e){let r=0;for(let t of n)r+=+!!e(t);return r}` — counting helper
 *   - `Kye`   — count of servers to announce (this file: countNeedsAuthToAnnounce)
 *   - `zye`   — mark announced: session Set + persisted config (markNeedsAuthNoticed)
 *   - `Qye`   — count of persisted-noticed servers now connected (prunable)
 *   - `Yye`   — prune persisted list of now-connected servers
 *   - `DH={hasEverConnected:Ykt,connectedThisSession:Vkt}` where
 *     `Ykt(e)=(ne().claudeAiMcpEverConnected??[]).includes(e)` and
 *     `Vkt(e)=Nt().claudeAiConnectedThisSession.has(e)` — OCC equivalents are
 *     `hasClaudeAiMcpEverConnected` / `isClaudeAiMcpCurrentlyConnected`,
 *     exported from services/mcp/claudeai.ts.
 *   - conversation_reset clears the session Set:
 *     `Nt().needsAuthNoticedThisSession.clear()` (wired in commands/clear/caches.ts)
 *
 * The official mark (`kee` component effect → `zye`) fires when the notice is
 * actually rendered; OCC's equivalent moment is right after the
 * `mcp-needs-auth` notification is added (see useMcpConnectivityStatus).
 */
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

/** Official `Z5t` — cap on the persisted announced-server list. */
export const MCP_NEEDS_AUTH_NOTICED_CAP = 128

/**
 * Official `Nt().needsAuthNoticedThisSession` — servers announced during this
 * session. Kept here (not in services/mcp/) because that module is owned
 * elsewhere; semantics are identical to the official session-store field.
 */
const needsAuthNoticedThisSession = new Set<string>()

/** Injected predicates mirroring the official `DH` deps object. */
export type NeedsAuthNoticeDeps = {
  /** Official `Ykt` — persisted claude.ai ever-connected list membership. */
  hasEverConnected: (name: string) => boolean
  /** Official `Vkt` — claude.ai connector connected during this session. */
  connectedThisSession: (name: string) => boolean
}

/**
 * Official conversation_reset side effect:
 * `Nt().needsAuthNoticedThisSession.clear()`.
 */
export function clearNeedsAuthNoticedThisSession(): void {
  needsAuthNoticedThisSession.clear()
}

/** Test-only view of the session set size (official store has no reader). */
export function getNeedsAuthNoticedThisSessionSize(): number {
  return needsAuthNoticedThisSession.size
}

/** Official `dE` — failed-because-unconfigured clients are never surfaced. */
function isFailedUnconfigured(client: MCPServerConnection): boolean {
  return client.type === 'failed' && client.errorCode === 'UNCONFIGURED'
}

/**
 * Official `TEt(e,n,r)`:
 *   if(dE(e))return!1;
 *   if(e.config.type==="claudeai-proxy"){
 *     if(e.config.eligible===!1&&!r(e.name))return!1;
 *     return n(e.name)}
 *   return e.config.type!=="sse-ide"&&e.config.type!=="ws-ide"
 */
function isEligibleForNeedsAuthNotice(
  client: MCPServerConnection,
  { hasEverConnected, connectedThisSession }: NeedsAuthNoticeDeps,
): boolean {
  if (isFailedUnconfigured(client)) return false
  if (client.config.type === 'claudeai-proxy') {
    const eligible = (client.config as { eligible?: boolean }).eligible
    if (eligible === false && !connectedThisSession(client.name)) return false
    return hasEverConnected(client.name)
  }
  return client.config.type !== 'sse-ide' && client.config.type !== 'ws-ide'
}

/**
 * Official `net` — should this client be announced right now? Needs-auth and
 * eligible, and either already announced this session (keeps the count stable
 * within the session) or never persisted as announced before.
 */
export function shouldAnnounceNeedsAuth(
  client: MCPServerConnection,
  deps: NeedsAuthNoticeDeps,
): boolean {
  if (client.type !== 'needs-auth' || !isEligibleForNeedsAuthNotice(client, deps)) {
    return false
  }
  return (
    needsAuthNoticedThisSession.has(client.name) ||
    !(getGlobalConfig().mcpNeedsAuthNoticed ?? []).includes(client.name)
  )
}

/** Official `Kye(w,P)=j(w,(ee)=>net(ee,P))` with `j` the counting helper. */
export function countNeedsAuthToAnnounce(
  clients: readonly MCPServerConnection[],
  deps: NeedsAuthNoticeDeps,
): number {
  let count = 0
  for (const client of clients) {
    count += +!!shouldAnnounceNeedsAuth(client, deps)
  }
  return count
}

/**
 * Official `zye(w,P,ee)` — record announcement: add every not-yet-marked
 * announceable server to the session Set, then persist the new names into
 * `mcpNeedsAuthNoticed`, capped to the last `Z5t` (128) entries.
 */
export function markNeedsAuthNoticed(
  clients: readonly MCPServerConnection[],
  deps: NeedsAuthNoticeDeps,
): void {
  const newlyNoticed: string[] = []
  for (const client of clients) {
    if (
      shouldAnnounceNeedsAuth(client, deps) &&
      !needsAuthNoticedThisSession.has(client.name)
    ) {
      needsAuthNoticedThisSession.add(client.name)
      newlyNoticed.push(client.name)
    }
  }
  if (newlyNoticed.length === 0) return
  saveGlobalConfig(current => {
    const noticed = current.mcpNeedsAuthNoticed ?? []
    const fresh = newlyNoticed.filter(name => !noticed.includes(name))
    if (fresh.length === 0) return current
    const merged = [...noticed, ...fresh]
    return {
      ...current,
      mcpNeedsAuthNoticed: merged.slice(-MCP_NEEDS_AUTH_NOTICED_CAP),
    }
  })
}

/**
 * Official `Qye(w)` — how many persisted-noticed servers are connected right
 * now (i.e. prunable). Zero means the prune below can be skipped entirely.
 */
export function countNoticedServersNowConnected(
  clients: readonly MCPServerConnection[],
): number {
  const noticed = getGlobalConfig().mcpNeedsAuthNoticed
  if (noticed === undefined || noticed.length === 0) return 0
  let count = 0
  for (const client of clients) {
    count += +!!(client.type === 'connected' && noticed.includes(client.name))
  }
  return count
}

/**
 * Official `Yye(w,P)` — drop persisted entries whose server is now connected,
 * so a future auth expiry re-announces it. No-op write when nothing changes.
 */
export function pruneNoticedServersNowConnected(
  clients: readonly MCPServerConnection[],
): void {
  saveGlobalConfig(current => {
    const noticed = current.mcpNeedsAuthNoticed
    if (noticed === undefined || noticed.length === 0) return current
    const remaining = noticed.filter(
      name => !clients.some(client => client.name === name && client.type === 'connected'),
    )
    if (remaining.length === noticed.length) return current
    return { ...current, mcpNeedsAuthNoticed: remaining }
  })
}
