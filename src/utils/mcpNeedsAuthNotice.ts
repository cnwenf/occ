/**
 * CC 2.1.268 E63: the "N MCP servers need authentication" startup notice
 * announces each server only ONCE. A server that has been announced in any
 * previous session is not re-announced on the next startup; it re-enters the
 * notice only after it successfully connects (prune) or the session store is
 * reset (/clear). Within the announcing session the notice stays visible (the
 * session set keeps the count stable), matching the official 2.1.276 gate:
 *
 *   function cet(h,{hasEverConnected:v,connectedThisSession:O}){
 *     if(h.type!=="needs-auth"||!o1t(h,v,O))return!1;
 *     return Ut().needsAuthNoticedThisSession.has(h.name)||
 *            !pee(ie()).includes(h.name)}
 *
 * Official 2.1.268 shape (byte-verified from the binary), as updated by
 * 2.1.276 — every raw `mcpNeedsAuthNoticed` read now goes through the `pee`
 * accessor + `nl` normalizer (byte-verified from the v276 binary; fixes a
 * launch crash when a hand-edited/corrupted ~/.claude.json persists a
 * non-array or mixed-type value):
 *   - `I6t=128` (2.1.268: `Z5t=128`) — persisted list capped via slice(-128)
 *   - `nl(n)`  — normalizer: `if(!Array.isArray(n))return[];return n.every(
 *                 (e)=>typeof e==="string")?n:n.filter((e)=>typeof e==="string")`
 *   - `pee(h)` — accessor: `return nl(h.mcpNeedsAuthNoticed)`
 *   - `dE(e)  = e.type==="failed"&&e.errorCode==="UNCONFIGURED"` (excluded)
 *   - `TEt`   — eligibility filter (claude.ai: excluded when eligible===false
 *               && !connectedThisSession; counted iff hasEverConnected;
 *               local: all except sse-ide/ws-ide)
 *   - `j(n,e){let r=0;for(let t of n)r+=+!!e(t);return r}` — counting helper
 *   - `Kye`   — count of servers to announce (this file: countNeedsAuthToAnnounce)
 *   - `zye`   — mark announced: session Set + persisted config (markNeedsAuthNoticed)
 *   - `Qye`   — count of persisted-noticed servers now connected (prunable)
 *   - `Yye`   — prune persisted list of now-connected servers
 *   - 2.1.276 renames the four consumers: `cet` (shouldAnnounce, reads
 *     `!pee(ie()).includes(h.name)`), `qbe` (mark, `let ve=pee(Se)` — the
 *     write path normalizes BEFORE merging/slicing, so a malformed value
 *     self-heals on the next persist), `Vbe` (count, `let v=pee(ie());
 *     if(v.length===0)return 0`), `Gbe` (prune, `let Q=pee(O);
 *     if(Q.length===0)return O`).
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

/** Official `Z5t` (2.1.276: `I6t`) — cap on the persisted announced-server list. */
export const MCP_NEEDS_AUTH_NOTICED_CAP = 128

/**
 * Official 2.1.276 `nl` (byte-verified): tolerate a malformed persisted
 * `mcpNeedsAuthNoticed` value (hand-edited/corrupted ~/.claude.json). A
 * non-array normalizes to []; an array keeps only its string entries (the
 * `every` fast path returns the original array unchanged). Without this, a
 * value like `{}` or `123` reaches `.includes`/`.filter` and throws a
 * TypeError inside the useMcpConnectivityStatus React effect at launch.
 */
export function normalizeMcpNeedsAuthNoticed(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.every(entry => typeof entry === 'string')
    ? value
    : value.filter((entry): entry is string => typeof entry === 'string')
}

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
 * Official `net` (2.1.276: `cet`) — should this client be announced right
 * now? Needs-auth and eligible, and either already announced this session
 * (keeps the count stable within the session) or never persisted as announced
 * before. 2.1.276 reads the persisted list via `pee` (normalized).
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
    !normalizeMcpNeedsAuthNoticed(getGlobalConfig().mcpNeedsAuthNoticed).includes(
      client.name,
    )
  )
}

/** Official `Kye(w,P)=j(w,(ee)=>net(ee,P))` (2.1.276: `Wbe`/`cet`) with `j` the counting helper. */
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
 * Official `zye(w,P,ee)` (2.1.276: `qbe`) — record announcement: add every
 * not-yet-marked announceable server to the session Set, then persist the new
 * names into `mcpNeedsAuthNoticed`, capped to the last `Z5t`/`I6t` (128)
 * entries. 2.1.276 normalizes the persisted list BEFORE merging/slicing, so a
 * malformed value self-heals into a clean string[] on this write.
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
    const noticed = normalizeMcpNeedsAuthNoticed(current.mcpNeedsAuthNoticed)
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
 * Official `Qye(w)` (2.1.276: `Vbe`) — how many persisted-noticed servers are
 * connected right now (i.e. prunable). Zero means the prune below can be
 * skipped entirely. 2.1.276: `let v=pee(ie());if(v.length===0)return 0`.
 */
export function countNoticedServersNowConnected(
  clients: readonly MCPServerConnection[],
): number {
  const noticed = normalizeMcpNeedsAuthNoticed(
    getGlobalConfig().mcpNeedsAuthNoticed,
  )
  if (noticed.length === 0) return 0
  let count = 0
  for (const client of clients) {
    count += +!!(client.type === 'connected' && noticed.includes(client.name))
  }
  return count
}

/**
 * Official `Yye(w,P)` (2.1.276: `Gbe`) — drop persisted entries whose server
 * is now connected, so a future auth expiry re-announces it. No-op write when
 * nothing changes. 2.1.276: `let Q=pee(O);if(Q.length===0)return O`.
 */
export function pruneNoticedServersNowConnected(
  clients: readonly MCPServerConnection[],
): void {
  saveGlobalConfig(current => {
    const noticed = normalizeMcpNeedsAuthNoticed(current.mcpNeedsAuthNoticed)
    if (noticed.length === 0) return current
    const remaining = noticed.filter(
      name => !clients.some(client => client.name === name && client.type === 'connected'),
    )
    if (remaining.length === noticed.length) return current
    return { ...current, mcpNeedsAuthNoticed: remaining }
  })
}
