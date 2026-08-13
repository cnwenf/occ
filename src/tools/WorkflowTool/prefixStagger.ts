/**
 * CC 2.1.229 (changelog #24 / binary `IZp`): workflow prefix stagger gate.
 *
 * When a workflow fans out same-prefix sibling agents, later siblings wait
 * briefly (up to `capMs`) for a same-prefix sibling's first response so they
 * read the cached prompt prefix instead of all re-paying the uncached prefix
 * simultaneously.
 *
 * Verbatim mechanism from the 2.1.229 linux-x64 binary:
 *   - gate class `IZp` with enter()/done()/responded()/markWarm()/stateOf()/clear()
 *   - warming entry factory `a_v` ({state:'warming', ready, release})
 *   - wait race `l_v` (ready vs timeout vs inherited-abort)
 *   - singleton `RZp` (xZp ??= new IZp)
 *   - cap default `i_v` = 5000 ms, warm TTL `s_v` = 270000 ms
 *   - cap override via CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS; cap 0 when
 *     DISABLE_PROMPT_CACHING is set (call-site condition in the binary)
 *
 * Prefix key (binary `Ze`): [resolvedModel, effort, agentType,
 * toolNames.join(","), schema?JSON.stringify:"", worktreePath ?? cwd]
 * joined with "\n" — built by the caller (WorkflowTool primitives).
 */

import { isEnvTruthy } from '../../utils/envUtils.js'

/** Warm-entry TTL in ms (binary `s_v`). */
export const WORKFLOW_PREFIX_WARM_TTL_MS = 270_000

/** Default stagger cap in ms (binary `i_v`). */
export const WORKFLOW_PREFIX_STAGGER_DEFAULT_MS = 5_000

type WarmingEntry = {
  state: 'warming'
  ready: Promise<void>
  release: () => void
}
type WarmEntry = { state: 'warm'; until: number }
type StaggerEntry = WarmingEntry | WarmEntry

/** Handle returned by enter() (binary: {leader, waitedMs, responded, done}). */
export interface StaggerHandle {
  /** True when this caller created the warming entry (the cache warmer). */
  readonly leader: boolean
  /** Time spent waiting on a same-prefix sibling's first response. */
  readonly waitedMs: number
  /** Signal that this agent produced its first response (marks prefix warm). */
  responded: () => void
  /** Release the warming entry if this leader never responded. */
  done: () => void
}

/** Warming entry factory (binary `a_v`). */
function createWarmingEntry(): WarmingEntry {
  let release: (() => void) | undefined
  const ready = new Promise<void>(resolve => {
    release = resolve
  })
  return { state: 'warming', ready, release: () => release?.() }
}

/** Abortable sleep (binary `vr` — resolves early when the signal aborts). */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wait for `ready` with a timeout and inherited-abort propagation
 * (binary `l_v`).
 */
function raceReadyWithTimeout(
  ready: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  return Promise.race([ready, sleepWithAbort(timeoutMs, controller.signal)]).finally(() => {
    controller.abort()
    signal?.removeEventListener('abort', onAbort)
  })
}

/**
 * The prefix stagger gate (binary `IZp`, verbatim semantics).
 *
 * - First enter() per key creates a "warming" entry (the leader warms the
 *   prompt cache); its `ready` promise resolves on responded()/release.
 * - Later enter() calls on a warming key wait up to capMs for `ready`.
 * - responded() marks the key warm for WORKFLOW_PREFIX_WARM_TTL_MS; enters
 *   on a warm key pass through immediately.
 * - done() by a leader that never responded deletes the warming entry and
 *   releases any waiters (so a failed leader doesn't strand siblings).
 */
export class WorkflowPrefixStaggerGate {
  private readonly now: () => number
  private readonly entries = new Map<string, StaggerEntry>()

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  async enter(
    key: string,
    opts: { capMs: number; signal?: AbortSignal },
  ): Promise<StaggerHandle> {
    const now = this.now()
    // Sweep expired warm entries (binary: `if(l.state==="warm"&&l.until<=r)`).
    for (const [k, entry] of this.entries) {
      if (entry.state === 'warm' && entry.until <= now) {
        this.entries.delete(k)
      }
    }
    const existing = this.entries.get(key)
    let warming: WarmingEntry | undefined
    let waitedMs = 0
    if (existing === undefined) {
      warming = createWarmingEntry()
      this.entries.set(key, warming)
    } else if (existing.state === 'warming' && opts.capMs > 0) {
      const start = this.now()
      await raceReadyWithTimeout(existing.ready, opts.capMs, opts.signal)
      waitedMs = Math.max(0, this.now() - start)
    }
    let respondedFired = false
    return {
      leader: warming !== undefined,
      waitedMs,
      responded: () => {
        respondedFired = true
        this.markWarm(key)
      },
      done: () => {
        if (respondedFired || warming === undefined) return
        if (this.entries.get(key) === warming && warming.state === 'warming') {
          this.entries.delete(key)
          warming.release()
        }
      },
    }
  }

  /** Binary `stateOf` — test/inspection helper. */
  stateOf(key: string): 'cold' | 'warming' | 'warm' {
    const entry = this.entries.get(key)
    if (entry === undefined) return 'cold'
    if (entry.state === 'warm') {
      return entry.until > this.now() ? 'warm' : 'cold'
    }
    return 'warming'
  }

  /** Binary `clear` — release all warming entries. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === 'warming') entry.release()
    }
    this.entries.clear()
  }

  /** Binary `markWarm` — mark key warm for the TTL, releasing waiters. */
  markWarm(key: string): void {
    const existing = this.entries.get(key)
    this.entries.set(key, {
      state: 'warm',
      until: this.now() + WORKFLOW_PREFIX_WARM_TTL_MS,
    })
    if (existing?.state === 'warming') existing.release()
  }
}

let singleton: WorkflowPrefixStaggerGate | undefined

/** Gate singleton (binary `RZp`: `xZp ??= new IZp`). */
export function getWorkflowPrefixStaggerGate(): WorkflowPrefixStaggerGate {
  return (singleton ??= new WorkflowPrefixStaggerGate())
}

/**
 * Stagger cap resolution (binary call site:
 * `capMs: Q.DISABLE_PROMPT_CACHING ? 0 : LZp(Q.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS)`,
 * with `LZp(e) { return e ?? 5000 }` and the env var int-parsed, min 0).
 * OCC uses isEnvTruthy for DISABLE_PROMPT_CACHING (same semantics as
 * src/services/api/claude.ts).
 */
export function getWorkflowPrefixStaggerCapMs(env: NodeJS.ProcessEnv = process.env): number {
  if (isEnvTruthy(env.DISABLE_PROMPT_CACHING)) {
    return 0
  }
  const raw = env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return WORKFLOW_PREFIX_STAGGER_DEFAULT_MS
}

/**
 * Build the prefix key (binary `Ze`):
 * `[model ?? "", String(effort ?? ""), agentType, toolNames.join(","),
 *   schema ? JSON.stringify(schema) : "", worktreePath ?? cwd].join("\n")`
 */
export function buildWorkflowPrefixKey(parts: {
  model: string | undefined
  effort: string | undefined
  agentType: string
  toolNames: string
  schemaJson: string
  cwd: string
}): string {
  return [
    parts.model ?? '',
    String(parts.effort ?? ''),
    parts.agentType,
    parts.toolNames,
    parts.schemaJson,
    parts.cwd,
  ].join('\n')
}
