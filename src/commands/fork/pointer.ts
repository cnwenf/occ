import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import {
  getTranscriptPathForSession,
  loadTranscriptFile,
} from '../../utils/sessionStorage.js'

/**
 * claude-code 2.1.118: /fork writes a POINTER + hydrates on demand.
 *
 * Instead of copying the full parent conversation into the fork's session file
 * (the pre-2.1.118 full-copy behavior), /fork writes a small `fork-context-ref`
 * pointer entry that references the parent session + the last parent message
 * UUID. The fork's conversation prefix is hydrated on demand from the parent
 * session file when the fork is loaded — so a fork stays cheap to create
 * regardless of parent conversation size.
 *
 * Pointer entry shape (one JSONL line appended to the fork's session file):
 *   {"type":"fork-context-ref","parentSessionId":"<uuid>","parentLastUuid":"<uuid>","agentId":"<agentId>"?}
 *
 * Grep-verified against the 2.1.200 binary: the official appendEntry dispatch
 * routes `fork-context-ref` via the `route-by-agent` policy, and the hydrate
 * path walks the parent parentUuid chain from parentLastUuid, filters
 * sidechain entries, and strips parentUuid/isSidechain before returning.
 */

export type ForkContextRef = {
  type: 'fork-context-ref'
  parentSessionId: string
  parentLastUuid: string
  agentId?: string
}

export type WriteForkPointerArgs = {
  /** The new fork session's id (the file the pointer is written to). */
  forkedSessionId: string
  /** The parent session the fork inherits context from. */
  parentSessionId: string
  /** UUID of the last parent message the fork branches from. */
  parentLastUuid: string
  agentId?: string
}

/**
 * Write a `fork-context-ref` pointer to the fork's session file. The fork's
 * conversation prefix is NOT copied — it is hydrated on demand by
 * `hydrateForkPrefix` when the fork is loaded. Creates the parent directory
 * and the session file lazily (the file is created on the first append).
 */
export async function writeForkPointer(
  args: WriteForkPointerArgs,
): Promise<void> {
  const forkPath = getTranscriptPathForSession(args.forkedSessionId)
  const entry: ForkContextRef = {
    type: 'fork-context-ref',
    parentSessionId: args.parentSessionId,
    parentLastUuid: args.parentLastUuid,
    ...(args.agentId ? { agentId: args.agentId } : {}),
  }
  await mkdir(dirname(forkPath), { recursive: true })
  await appendFile(forkPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

// Small LRU for hydrated prefixes, keyed by parentLastUuid. Mirrors the
// official EQe cache (capped, evicts oldest on overflow).
const HYDRATE_CACHE = new Map<string, unknown[]>()
const HYDRATE_CACHE_MAX = 64

type HydrateableMessage = {
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  type?: string
  [k: string]: unknown
}

/**
 * Hydrate the fork's conversation prefix on demand from the parent session.
 * Walks the parent parentUuid chain backwards from `parentLastUuid` to the
 * root, filters out sidechain entries, and strips parentUuid/isSidechain (the
 * fork owns its own chain). Returns an empty array when the parent message is
 * not found (matching the official "[fork-context-ref] parent uuid ... not
 * found ... returning empty prefix" warn path).
 */
export async function hydrateForkPrefix(args: {
  parentSessionId: string
  parentLastUuid: string
}): Promise<unknown[]> {
  const cached = HYDRATE_CACHE.get(args.parentLastUuid)
  if (cached) {
    // Move-to-end (LRU recency refresh).
    HYDRATE_CACHE.delete(args.parentLastUuid)
    HYDRATE_CACHE.set(args.parentLastUuid, cached)
    return cached
  }
  const parentPath = getTranscriptPathForSession(args.parentSessionId)
  let loaded: { messages: Map<string, HydrateableMessage> }
  try {
    loaded = (await loadTranscriptFile(parentPath)) as unknown as {
      messages: Map<string, HydrateableMessage>
    }
  } catch {
    return []
  }
  const messages = loaded.messages
  const leaf = messages.get(args.parentLastUuid)
  if (!leaf) {
    // Official: "[fork-context-ref] parent uuid <uuid> not found in <path>;
    // returning empty prefix" (warn).
    return []
  }
  // Walk the parentUuid chain from leaf back to root.
  const chain: HydrateableMessage[] = []
  let cursor: HydrateableMessage | undefined = leaf
  const seen = new Set<string>()
  while (cursor && cursor.uuid && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid)
    chain.push(cursor)
    const parent = cursor.parentUuid
    cursor = parent ? messages.get(parent) : undefined
  }
  chain.reverse()
  // Filter sidechain, strip parentUuid/isSidechain (fork owns its chain).
  const prefix = chain
    .filter((m) => !m.isSidechain)
    .map(({ parentUuid: _p, isSidechain: _s, ...rest }) => rest)
  if (HYDRATE_CACHE.size >= HYDRATE_CACHE_MAX) {
    const oldest = HYDRATE_CACHE.keys().next().value
    if (oldest !== undefined) HYDRATE_CACHE.delete(oldest)
  }
  HYDRATE_CACHE.set(args.parentLastUuid, prefix)
  return prefix
}

/** Clear the hydrate cache (testing). */
export function _clearHydrateCache(): void {
  HYDRATE_CACHE.clear()
}
