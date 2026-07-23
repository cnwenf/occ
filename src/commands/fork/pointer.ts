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

/**
 * CC 2.1.218 #24: fork-session lineage was lost after compaction in headless
 * and SDK sessions. A fork's transcript begins with a `fork-context-ref`
 * pointer (parentSessionId + parentLastUuid) that `hydrateForkPrefix` reads to
 * rebuild the fork's conversation prefix from the parent session. Compaction
 * replaces the older transcript entries with a single compact-summary message;
 * if the pointer lived in the summarized (pruned) segment, the fork lost its
 * lineage and could no longer hydrate its prefix on resume.
 *
 * The helpers below let the compaction path carry the pointer forward so the
 * post-compact transcript still begins with the fork-context-ref. They are
 * pure (no I/O) so the lineage-preservation contract is unit-testable.
 */

type TranscriptEntry = { type?: string; [k: string]: unknown }

function isForkContextRef(
  entry: unknown,
): entry is ForkContextRef {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return false
  }
  const e = entry as Partial<ForkContextRef>
  return (
    e.type === 'fork-context-ref' &&
    typeof e.parentSessionId === 'string' &&
    e.parentSessionId !== '' &&
    typeof e.parentLastUuid === 'string' &&
    e.parentLastUuid !== ''
  )
}

/**
 * Scan a list of transcript entries (pre- or post-compact) for a well-formed
 * `fork-context-ref` pointer. Returns the first match, or null when none is
 * present (or the entry is malformed — missing parentSessionId/parentLastUuid).
 */
export function extractForkLineage(
  entries: ReadonlyArray<unknown>,
): ForkContextRef | null {
  for (const entry of entries) {
    if (isForkContextRef(entry)) return entry
  }
  return null
}

/**
 * Preserve fork-session lineage across compaction. Given the pre-compact
 * transcript entries and the post-compact (compacted) entries, ensure the
 * fork-context-ref pointer survives at the head of the post-compact
 * transcript so a fork resumed after compaction can still hydrate its prefix.
 *
 * - If a pointer existed pre-compact and is absent post-compact, prepend it.
 * - If a well-formed pointer is already present post-compact, leave it (no
 *   duplication).
 * - If no pointer existed pre-compact, this is a no-op (the session was not a
 *   fork).
 *
 * Pure: returns a new array, never mutates inputs.
 */
export function preserveForkLineageAcrossCompaction(
  preCompactEntries: ReadonlyArray<unknown>,
  postCompactEntries: ReadonlyArray<unknown>,
): unknown[] {
  const ref = extractForkLineage(preCompactEntries)
  if (!ref) {
    // Not a fork session, or lineage already absent — nothing to preserve.
    return [...postCompactEntries]
  }
  // Already preserved by the compaction path? Don't duplicate.
  if (extractForkLineage(postCompactEntries)) {
    return [...postCompactEntries]
  }
  return [ref, ...postCompactEntries]
}
