/**
 * CC 2.1.292 (C10 carryover, docs/gap-research-293/cluster-c-h-carryover.md
 * §C10): instruction-file freshness — the official withheld-notice store
 * (minified `rfe` module @212089000), byte-recovered from the official
 * 2.1.292 linux-x64 binary.
 *
 * Official 2.1.292 replaced the root-keyed "already told" map with a
 * SESSION-scoped store — `{owed, logged, token, seen}` — so instruction-file
 * withheld notices survive `/cd` (root changes) without duplicate tells:
 *   owed   — entries withheld inside an agent, owed to a later main-thread
 *            turn (official `kMe`/`bMe`/`wMe`)
 *   logged — paths that already emitted the `Instruction file not loaded`
 *            debug line this session (official `QB`, capped at XR=200)
 *   token  — per-session nonce stamped on `withheld_memory` attachments; the
 *            transcript re-scan only trusts attachments carrying it
 *   seen   — paths already told to the user this session (official `EMe`)
 *
 * Official minified → OCC name map:
 *   XR  ≡ KEPT_MOST (200)        Soe ≡ SHOWN_MOST (20)
 *   vMe ≡ PATH_MARK ('path:')    XB  ≡ REASONS (4 arms, new `unjudged`)
 *   F_  ≡ withheldToldsOf        QB  ≡ noteWithheld
 *   kMe ≡ oweWithheld            bMe ≡ owedNoMore
 *   wMe ≡ owedWithheld           TMe ≡ toldIn
 *   EMe ≡ toldBy                 F1t ≡ withheldLine
 *   U1t ≡ withheldMore           Zgt ≡ withheldShown
 *
 * Documented deviations (unrecoverable from the binary — not guessed):
 *  - Official `F_` is a `gt` session container (`.of(session)`); OCC keys a
 *    plain module Map by SessionId — same observable contract.
 *  - Official `ve()` gates in `kMe`/`Kun` (semantics unrecovered) are omitted.
 *  - Official `AX` display formatter inside `F1t` is unrecovered; OCC applies
 *    only the recovered whitespace collapse (`replace(/\s+/g," ")`).
 */
import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionId } from '../types/ids.js'
import { logForDebugging } from './debug.js'
import { plural } from './stringUtils.js'

/** Official `XR` — per-session cap on kept entries (logged/owed/seen). */
export const KEPT_MOST = 200

/** Official `Soe` — cap on rendered rows before the overflow line. */
export const SHOWN_MOST = 20

/** Official `vMe` — transcript marker prefixed before each withheld path. */
export const PATH_MARK = 'path:'

/** Official `XB` (2.1.292) — the four withheld reasons, verbatim. */
export const REASONS = {
  denied: 'a Read deny rule covers it',
  outside:
    "it's read from outside your working directories, where reads are blocked",
  unjudged: "a Read deny rule couldn't be checked without a working directory",
  unsettled: "where it leads couldn't be worked out",
} as const

export type WithheldReason = keyof typeof REASONS

export type WithheldEntry = {
  path: string
  why: WithheldReason
}

/** Official `F_` store shape: `{owed, logged, token, seen}`. */
export type WithheldTolds = {
  owed: Map<string, WithheldEntry>
  logged: Set<string>
  token: string
  seen: Set<string>
}

const stores = new Map<string, WithheldTolds>()

/** Official `F_.of(session)` — lazily create the per-session store. */
export function withheldToldsOf(
  sessionId: SessionId | string,
): WithheldTolds {
  const key = String(sessionId)
  let store = stores.get(key)
  if (!store) {
    store = {
      owed: new Map<string, WithheldEntry>(),
      logged: new Set<string>(),
      token: randomUUID(),
      seen: new Set<string>(),
    }
    stores.set(key, store)
  }
  return store
}

/**
 * Official `QB`: `for(let{path,why}of n) if(!r.has(s)&&r.size<XR)
 * r.add(s), t(\`Instruction file not loaded: ${s} (${XB[g]})\`)` — log each
 * not-yet-logged path once per session, capped at KEPT_MOST.
 */
export function noteWithheld(
  sessionId: SessionId | string,
  entries: WithheldEntry[],
): void {
  const { logged } = withheldToldsOf(sessionId)
  for (const { path, why } of entries) {
    if (!logged.has(path) && logged.size < KEPT_MOST) {
      logged.add(path)
      logForDebugging(
        `Instruction file not loaded: ${path} (${REASONS[why]})`,
      )
    }
  }
}

/**
 * Official `kMe`: note + owe each entry for a later main-thread turn. The
 * `ve()?[]:n` gate is omitted (unrecovered — see header deviations).
 */
export function oweWithheld(
  sessionId: SessionId | string,
  entries: WithheldEntry[],
): void {
  const { owed } = withheldToldsOf(sessionId)
  noteWithheld(sessionId, entries)
  for (const entry of entries) {
    if (!owed.has(entry.path) && owed.size < KEPT_MOST) {
      owed.set(entry.path, entry)
    }
  }
}

/** Official `bMe` — drop paths that are no longer withheld. */
export function owedNoMore(
  sessionId: SessionId | string,
  paths: string[],
): void {
  const { owed } = withheldToldsOf(sessionId)
  for (const path of paths) {
    owed.delete(path)
  }
}

/** Official `wMe` — delete the named paths, return the remaining owed entries. */
export function owedWithheld(
  sessionId: SessionId | string,
  paths: string[],
): WithheldEntry[] {
  const { owed } = withheldToldsOf(sessionId)
  for (const path of paths) {
    owed.delete(path)
  }
  return Array.from(owed.values())
}

/** Official `Zgt` — first SHOWN_MOST entries + the overflow count. */
export function withheldShown<T>(entries: T[]): {
  shown: T[]
  more: number
} {
  return {
    shown: entries.slice(0, SHOWN_MOST),
    more: Math.max(entries.length - SHOWN_MOST, 0),
  }
}

/**
 * Official `F1t` — one transcript row for a withheld file:
 * `{lead: \`Instruction file not loaded (${XB[e]}):\`, mark: vMe,
 *   path: AX(n.replace(/\s+/g," ")).replace(/\s+/g," ")}`.
 * `AX` unrecovered — only the whitespace collapse is applied (see header).
 */
export function withheldLine(
  reason: WithheldReason,
  path: string,
): { lead: string; mark: string; path: string } {
  return {
    lead: `Instruction file not loaded (${REASONS[reason]}):`,
    mark: PATH_MARK,
    path: path.replace(/\s+/g, ' '),
  }
}

/** Official `U1t` — the overflow row under the shown list. */
export function withheldMore(shown: { more: number }): string {
  return `and ${shown.more} more instruction ${plural(shown.more, 'file')} not loaded`
}

/**
 * Official `TMe` — paths told by `withheld_memory` attachments stamped with
 * this session's token. Structural typing so the store module stays free of
 * message-type imports (the official scans normalized history messages of
 * `type:"attachment"`).
 */
export function toldIn(
  messages: readonly unknown[],
  token: string,
): Set<string> {
  const paths = new Set<string>()
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      continue
    }
    const wrapper = message as { type?: string; attachment?: unknown }
    if (
      wrapper.type !== 'attachment' ||
      typeof wrapper.attachment !== 'object' ||
      wrapper.attachment === null
    ) {
      continue
    }
    const attachment = wrapper.attachment as {
      type?: string
      by?: string
      entries?: unknown
    }
    if (
      attachment.type !== 'withheld_memory' ||
      attachment.by !== token ||
      !Array.isArray(attachment.entries)
    ) {
      continue
    }
    for (const entry of attachment.entries) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === 'string'
      ) {
        paths.add((entry as { path: string }).path)
      }
    }
  }
  return paths
}

/**
 * Official `EMe` — merge the transcript scan into the session's `seen` set
 * (KEPT_MOST-capped) and return the union.
 */
export function toldBy(
  sessionId: SessionId | string,
  messages: readonly unknown[],
): Set<string> {
  const { seen, token } = withheldToldsOf(sessionId)
  const told = toldIn(messages, token)
  for (const path of told) {
    if (seen.size < KEPT_MOST) {
      seen.add(path)
    }
  }
  return new Set([...seen, ...told])
}

// ─── per-pass collector (official Vun's `G` map) ────────────────────────────
//
// The official threads a per-call `Map(path → why)` through its reader
// wrapper (`Hxr(toolPermissionContext, (path, why) => { G.set(path, why) })`)
// so each nested-memory pass knows which instruction files were withheld.
// OCC's equivalent chokepoint (`safelyReadMemoryFileAsync` in claudemd.ts)
// sits five signatures deep, so the pass collector rides an
// AsyncLocalStorage instead — same per-call isolation, zero threading
// churn, concurrency-safe across interleaved passes.

const withheldPass = new AsyncLocalStorage<Map<string, WithheldReason>>()

/** Run `fn` collecting every withheld entry reported during the pass. */
export async function collectWithheldPass<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; withheld: WithheldEntry[] }> {
  const map = new Map<string, WithheldReason>()
  const result = await withheldPass.run(map, fn)
  return {
    result,
    withheld: Array.from(map, ([path, why]) => ({ path, why })),
  }
}

/** Chokepoint-side report into the active pass (no-op outside a pass). */
export function recordWithheldInPass(entry: WithheldEntry): void {
  withheldPass.getStore()?.set(entry.path, entry.why)
}

/** OCC test seam (convention: `resetPersistedReadDenyContextForTesting`). */
export function resetWithheldToldsForTesting(
  sessionId?: SessionId | string,
): void {
  if (sessionId === undefined) {
    stores.clear()
  } else {
    stores.delete(String(sessionId))
  }
}
