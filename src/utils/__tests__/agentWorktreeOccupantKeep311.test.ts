/**
 * CC 2.1.311 Item 12 — do not remove an agent worktree while another
 * (background) subagent task still runs inside it.
 *
 * Official v311 cleanup core, byte-verified at @256785050 in
 * /tmp/cc-diff-311/v311/package/claude (READ-ONLY; extracted with
 * `dd bs=1 skip=256785050 count=1500`, never executed):
 *
 *   if(W&&(V===void 0||E===void 0))return t(`Hook-based agent worktree kept at: ${r}`),{worktreePath:r};
 *   if(d4n(q.get(ye)))return t(`Agent worktree kept at ${r}: backgrounded owner awaits keepalive, resume pending`),{worktreePath:r,worktreeBranch:_};
 *   if(v||V!==void 0){
 *     let F=(te)=>Nn(q.all(),E===void 0?[r]:[r,E],te),
 *         ee=()=>F()??F((te)=>te.id!==ye&&Gt(te,q)),
 *         J=ee(),
 *         j=<async dirty check>,
 *         oe=J??ee();
 *     if(oe){
 *       if(t(`Agent worktree ${r} is still the working directory of ${oe.type} task ${oe.id}; kept`),
 *         a("tengu_agent_worktree_kept",{reason:Go(oe.status)?b("parked_task"):b("live_task"),
 *           task_type:c(oe.type),seen:J?b("before_check"):b("after_check"),changed:j}),
 *         C)Fn({worktreePath:r,gitRoot:C,taskRegistry:q,findOccupant:F});
 *       return{worktreePath:r,worktreeBranch:_}}
 *     if(!j&&(await Jde(r,_,C,W??!1,"agent_tool")).outcome==="removed")...
 *
 * No real git worktree is spawned: `shouldRemoveUnchangedAgentWorktree` and
 * `removeAgentWorktree` are injected as recorded stubs through the deps seam.
 */

import { describe, expect, test } from 'bun:test'
import { type AgentTaskRecord, TaskRegistryImpl } from '../taskRegistry.js'
import {
  AGENT_WORKTREE_KEPT_EVENT,
  type AgentWorktreeCleanupDeps,
  type AgentWorktreeCleanupParams,
  type DeferredAgentWorktreeCleanupParams,
  cleanupAgentWorktree,
  rearmAgentWorktreeCleanup,
  releaseParkedWorktreeOccupant,
  runDeferredAgentWorktreeCleanup,
} from '../worktree.js'

const WORKTREE_PATH = '/tmp/occ-wt-tests/wt-keep'
const WORKTREE_BRANCH = 'agent-wt-keep'
const GIT_ROOT = '/tmp/occ-wt-tests/repo'
const HEAD_COMMIT = 'abc123'
const OWNER_AGENT_ID = 'owner-agent'
const OCCUPANT_ID = 'child-agent'
const OCCUPANT_TYPE = 'local_agent'
/** The official keeps the tree even when the occupant sits in a subdirectory. */
const OCCUPANT_CWD = `${WORKTREE_PATH}/packages/app`

interface RecordedEvent {
  readonly name: string
  readonly metadata: Record<string, string | number | boolean>
}

interface Recorded {
  readonly logs: string[]
  readonly events: RecordedEvent[]
  readonly removals: Array<{
    path: string
    branch: string | undefined
    root: string | undefined
  }>
  readonly unchangedChecks: Array<{ path: string; headCommit: string | undefined }>
  readonly removedMetadataClears: number[]
  readonly rearms: DeferredAgentWorktreeCleanupParams[]
}

interface Harness {
  readonly recorded: Recorded
  readonly deps: AgentWorktreeCleanupDeps
}

interface HarnessOptions {
  /** `shouldRemoveUnchangedAgentWorktree` result — true means "unchanged". */
  readonly unchanged?: boolean
  /** `removeAgentWorktree` result. */
  readonly removalSucceeds?: boolean
  /** Runs while the dirty check is in flight — models a concurrent spawn. */
  readonly onCheck?: () => void
  /** Overrides the `Fn` re-arm dep (default: record + resolve). */
  readonly rearm?: AgentWorktreeCleanupDeps['rearm']
}

function harness(options: HarnessOptions = {}): Harness {
  const { unchanged = true, removalSucceeds = true, onCheck } = options
  const logs: string[] = []
  const events: RecordedEvent[] = []
  const removals: Recorded['removals'] = []
  const unchangedChecks: Recorded['unchangedChecks'] = []
  const removedMetadataClears: number[] = []
  const rearms: DeferredAgentWorktreeCleanupParams[] = []
  const recorded: Recorded = {
    logs,
    events,
    removals,
    unchangedChecks,
    removedMetadataClears,
    rearms,
  }
  const deps: AgentWorktreeCleanupDeps = {
    shouldRemoveUnchanged: async params => {
      unchangedChecks.push({
        path: params.worktreePath,
        headCommit: params.headCommit,
      })
      onCheck?.()
      return unchanged
    },
    removeWorktree: async (path, branch, root) => {
      removals.push({ path, branch, root })
      return removalSucceeds
    },
    log: message => {
      logs.push(message)
    },
    logEvent: (name, metadata) => {
      events.push({ name, metadata })
    },
    onRemoved: () => {
      removedMetadataClears.push(Date.now())
    },
    rearm:
      options.rearm ??
      (params => {
        rearms.push(params)
        return Promise.resolve()
      }),
  }
  return { recorded, deps }
}

interface OccupantOptions {
  readonly id?: string
  readonly status?: AgentTaskRecord['status']
  readonly parked?: boolean
  readonly cwd?: string
}

function registryWithOccupant(options: OccupantOptions = {}): TaskRegistryImpl {
  const registry = new TaskRegistryImpl()
  registry.registerAgentTask({
    id: options.id ?? OCCUPANT_ID,
    type: OCCUPANT_TYPE,
    status: options.status ?? 'running',
    cwd: options.cwd ?? OCCUPANT_CWD,
    ...(options.parked === undefined ? {} : { parked: options.parked }),
  })
  return registry
}

function baseParams(
  taskRegistry: TaskRegistryImpl,
  overrides: Partial<AgentWorktreeCleanupParams> = {},
): AgentWorktreeCleanupParams {
  return {
    worktreePath: WORKTREE_PATH,
    worktreeBranch: WORKTREE_BRANCH,
    headCommit: HEAD_COMMIT,
    gitRoot: GIT_ROOT,
    agentId: OWNER_AGENT_ID,
    taskRegistry,
    ...overrides,
  }
}

/** Let already-resolved promise chains (and their .catch handlers) settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const KEPT_LOG = `Agent worktree ${WORKTREE_PATH} is still the working directory of ${OCCUPANT_TYPE} task ${OCCUPANT_ID}; kept`

describe('cleanupAgentWorktree — occupant seen before_check', () => {
  test('keeps the worktree with the official log, telemetry and re-arm — never removes', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({
      worktreePath: WORKTREE_PATH,
      worktreeBranch: WORKTREE_BRANCH,
    })
    expect(recorded.removals).toEqual([])
    expect(recorded.logs).toContain(KEPT_LOG)
    expect(recorded.events).toEqual([
      {
        name: AGENT_WORKTREE_KEPT_EVENT,
        metadata: {
          reason: 'live_task',
          task_type: OCCUPANT_TYPE,
          seen: 'before_check',
          changed: false,
        },
      },
    ])
    expect(recorded.rearms).toHaveLength(1)
    expect(recorded.rearms[0]?.worktreePath).toBe(WORKTREE_PATH)
    expect(recorded.rearms[0]?.gitRoot).toBe(GIT_ROOT)
  })

  test('still runs the dirty check so `changed` reflects the real tree state', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness({ unchanged: false })

    await cleanupAgentWorktree(baseParams(registry), deps)

    // The official computes `j` BEFORE it looks at the occupant, so a
    // before_check keep still reports an accurate `changed`.
    expect(recorded.unchangedChecks).toHaveLength(1)
    expect(recorded.unchangedChecks[0]).toEqual({
      path: WORKTREE_PATH,
      headCommit: HEAD_COMMIT,
    })
    expect(recorded.events[0]?.metadata.changed).toBe(true)
  })

  test('reports reason parked_task for a terminal-but-parked occupant', async () => {
    const registry = registryWithOccupant({ status: 'completed', parked: true })
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result.worktreePath).toBe(WORKTREE_PATH)
    expect(recorded.removals).toEqual([])
    expect(recorded.events[0]?.metadata).toMatchObject({
      reason: 'parked_task',
      seen: 'before_check',
    })
  })

  test('does NOT keep for a settled occupant that owns nothing (no parked flag)', async () => {
    const registry = registryWithOccupant({ status: 'completed' })
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({})
    expect(recorded.removals).toHaveLength(1)
    expect(recorded.events).toEqual([])
  })

  test("excludes this agent's own record from the relevance scan by id", async () => {
    // The owner's own parked record must not keep its own tree alive — the
    // official second scan is `(te)=>te.id!==ye&&Gt(te,q)`.
    const registry = registryWithOccupant({
      id: OWNER_AGENT_ID,
      status: 'completed',
      parked: true,
      cwd: WORKTREE_PATH,
    })
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({})
    expect(recorded.removals).toHaveLength(1)
    expect(recorded.events).toEqual([])
  })

  test('does not match an occupant in a sibling worktree sharing a prefix', async () => {
    const registry = registryWithOccupant({ cwd: `${WORKTREE_PATH}2/packages` })
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({})
    expect(recorded.removals).toHaveLength(1)
  })
})

describe('cleanupAgentWorktree — occupant seen after_check', () => {
  test('keeps with seen:after_check when a subagent spawns during the dirty check', async () => {
    const registry = new TaskRegistryImpl()
    const { recorded, deps } = harness({
      onCheck: () => {
        registry.registerAgentTask({
          id: OCCUPANT_ID,
          type: OCCUPANT_TYPE,
          status: 'running',
          cwd: OCCUPANT_CWD,
        })
      },
    })

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({
      worktreePath: WORKTREE_PATH,
      worktreeBranch: WORKTREE_BRANCH,
    })
    expect(recorded.removals).toEqual([])
    expect(recorded.logs).toContain(KEPT_LOG)
    expect(recorded.events[0]?.metadata).toMatchObject({
      reason: 'live_task',
      seen: 'after_check',
      changed: false,
    })
    expect(recorded.rearms).toHaveLength(1)
  })
})

describe('cleanupAgentWorktree — backgrounded owner keep (official d4n)', () => {
  test('keeps with the official keepalive string and skips the dirty check', async () => {
    const registry = new TaskRegistryImpl()
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(
      baseParams(registry, { isOwnerAwaitingKeepalive: true }),
      deps,
    )

    expect(result).toEqual({
      worktreePath: WORKTREE_PATH,
      worktreeBranch: WORKTREE_BRANCH,
    })
    expect(recorded.logs).toContain(
      `Agent worktree kept at ${WORKTREE_PATH}: backgrounded owner awaits keepalive, resume pending`,
    )
    // Official returns before the `if(v||V!==void 0)` block — no probe, no scan.
    expect(recorded.unchangedChecks).toEqual([])
    expect(recorded.removals).toEqual([])
    expect(recorded.events).toEqual([])
  })

  test('the keepalive keep wins over an otherwise-removable unchanged tree', async () => {
    const registry = new TaskRegistryImpl()
    const { recorded, deps } = harness({ unchanged: true })

    await cleanupAgentWorktree(
      baseParams(registry, { isOwnerAwaitingKeepalive: true }),
      deps,
    )

    expect(recorded.removals).toEqual([])
  })
})

describe('cleanupAgentWorktree — no occupant (existing behaviour preserved)', () => {
  test('removes an unchanged worktree and clears the resumable metadata', async () => {
    const registry = new TaskRegistryImpl()
    const { recorded, deps } = harness({ unchanged: true })

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({})
    expect(recorded.removals).toEqual([
      {
        path: WORKTREE_PATH,
        branch: WORKTREE_BRANCH,
        root: GIT_ROOT,
      },
    ])
    expect(recorded.removedMetadataClears).toHaveLength(1)
    expect(recorded.events).toEqual([])
    expect(recorded.rearms).toEqual([])
  })

  test('keeps a changed worktree with the existing log line', async () => {
    const registry = new TaskRegistryImpl()
    const { recorded, deps } = harness({ unchanged: false })

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({
      worktreePath: WORKTREE_PATH,
      worktreeBranch: WORKTREE_BRANCH,
    })
    expect(recorded.removals).toEqual([])
    expect(recorded.removedMetadataClears).toEqual([])
    expect(recorded.logs).toContain(
      `Agent worktree has changes, keeping: ${WORKTREE_PATH}`,
    )
  })

  test('returns {} when the removal itself fails (pre-existing OCC divergence)', async () => {
    // The official gates the metadata clear on `outcome==="removed"`. OCC's
    // pre-Item-12 code did not inspect the removal result, and Item 12 keeps
    // that behaviour — documented, not newly introduced.
    const registry = new TaskRegistryImpl()
    const { recorded, deps } = harness({
      unchanged: true,
      removalSucceeds: false,
    })

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({})
    expect(recorded.removals).toHaveLength(1)
    expect(recorded.removedMetadataClears).toHaveLength(1)
  })

  test('keeps a hook-based worktree without probing or scanning', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(
      baseParams(registry, { hookBased: true }),
      deps,
    )

    expect(result).toEqual({ worktreePath: WORKTREE_PATH })
    expect(recorded.logs).toContain(
      `Hook-based agent worktree kept at: ${WORKTREE_PATH}`,
    )
    expect(recorded.unchangedChecks).toEqual([])
    expect(recorded.removals).toEqual([])
    expect(recorded.events).toEqual([])
  })

  test('a noop-style empty registry never blocks removal', async () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask({
      id: 'no-cwd-task',
      type: OCCUPANT_TYPE,
      status: 'running',
      // No cwd — the official `Nn` skips such records outright.
    })
    const { recorded, deps } = harness()

    const result = await cleanupAgentWorktree(baseParams(registry), deps)

    expect(result).toEqual({})
    expect(recorded.removals).toHaveLength(1)
  })
})

describe('runDeferredAgentWorktreeCleanup (re-armed cleanup)', () => {
  test('removes the worktree once, after the occupant finishes', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness({ unchanged: true })
    setTimeout(() => {
      registry.updateAgentTask(OCCUPANT_ID, { status: 'completed' })
    }, 5)

    await runDeferredAgentWorktreeCleanup({
      ...baseParams(registry),
      cleanupDeps: deps,
      pollIntervalMs: 1,
      maxWaitMs: 2000,
      isPathPresent: () => true,
    })

    expect(recorded.removals).toHaveLength(1)
    expect(recorded.removedMetadataClears).toHaveLength(1)
  })

  test('gives up WITHOUT removing when the occupant never leaves (fail-closed)', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness()

    await runDeferredAgentWorktreeCleanup({
      ...baseParams(registry),
      cleanupDeps: deps,
      pollIntervalMs: 1,
      maxWaitMs: 20,
      isPathPresent: () => true,
    })

    expect(recorded.removals).toEqual([])
    expect(recorded.removedMetadataClears).toEqual([])
  })

  test('stops immediately when the worktree path is already gone', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness()

    await runDeferredAgentWorktreeCleanup({
      ...baseParams(registry),
      cleanupDeps: deps,
      pollIntervalMs: 1,
      maxWaitMs: 2000,
      isPathPresent: () => false,
    })

    expect(recorded.removals).toEqual([])
    expect(recorded.unchangedChecks).toEqual([])
  })
})

describe('rearmAgentWorktreeCleanup (idempotent arming)', () => {
  test('two arms for one path remove the worktree at most once', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness({ unchanged: true })
    const params: DeferredAgentWorktreeCleanupParams = {
      ...baseParams(registry),
      cleanupDeps: deps,
      pollIntervalMs: 1,
      maxWaitMs: 2000,
      isPathPresent: () => true,
    }
    setTimeout(() => {
      registry.unregisterAgentTask(OCCUPANT_ID)
    }, 5)

    await Promise.all([
      rearmAgentWorktreeCleanup(params),
      rearmAgentWorktreeCleanup(params),
    ])

    expect(recorded.removals).toHaveLength(1)
  })
})

describe('releaseParkedWorktreeOccupant (official lock release iye)', () => {
  test('drops the parked record once the owned work drains', async () => {
    const registry = registryWithOccupant({ status: 'completed', parked: true })
    let ownedWork = true
    setTimeout(() => {
      ownedWork = false
    }, 5)

    await releaseParkedWorktreeOccupant({
      agentId: OCCUPANT_ID,
      taskRegistry: registry,
      hasOwnedWork: () => ownedWork,
      pollIntervalMs: 1,
      maxWaitMs: 2000,
    })

    expect(registry.getAgentTask(OCCUPANT_ID)).toBeUndefined()
    expect(registry.findOccupant([WORKTREE_PATH])).toBeUndefined()
  })

  test('KEEPS the parked record when the owned work never drains (fail-closed)', async () => {
    const registry = registryWithOccupant({ status: 'completed', parked: true })

    await releaseParkedWorktreeOccupant({
      agentId: OCCUPANT_ID,
      taskRegistry: registry,
      hasOwnedWork: () => true,
      pollIntervalMs: 1,
      maxWaitMs: 20,
    })

    expect(registry.getAgentTask(OCCUPANT_ID)?.parked).toBe(true)
    // Still visible to the relevance scan cleanupAgentWorktree uses
    // (`!terminal || parked`) — the default non-terminal scan would not see it,
    // which is exactly why the official second scan exists.
    expect(
      registry.findOccupant([WORKTREE_PATH], task => task.parked === true)?.id,
    ).toBe(OCCUPANT_ID)
  })

  test('a parked occupant keeps an ancestor worktree, then releases it for reclaim', async () => {
    const registry = registryWithOccupant({ status: 'completed', parked: true })
    const { recorded, deps } = harness({ unchanged: true })

    // Ancestor cleanup while the parked record is live → kept.
    const kept = await cleanupAgentWorktree(baseParams(registry), deps)
    expect(kept.worktreePath).toBe(WORKTREE_PATH)
    expect(recorded.removals).toEqual([])
    expect(recorded.events[0]?.metadata.reason).toBe('parked_task')

    // Owned work drains → the record is released.
    await releaseParkedWorktreeOccupant({
      agentId: OCCUPANT_ID,
      taskRegistry: registry,
      hasOwnedWork: () => false,
      pollIntervalMs: 1,
      maxWaitMs: 2000,
    })

    // The re-armed cleanup can now reclaim the tree.
    await runDeferredAgentWorktreeCleanup({
      ...baseParams(registry),
      cleanupDeps: deps,
      pollIntervalMs: 1,
      maxWaitMs: 2000,
      isPathPresent: () => true,
    })
    expect(recorded.removals).toHaveLength(1)
  })
})

describe('armDeferredCleanup failure isolation', () => {
  test('a rejecting re-arm does not undo the keep and is logged', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness({
      rearm: () => Promise.reject(new Error('rearm boom')),
    })

    const result = await cleanupAgentWorktree(baseParams(registry), deps)
    await flushMicrotasks()

    expect(result.worktreePath).toBe(WORKTREE_PATH)
    expect(recorded.removals).toEqual([])
    expect(recorded.events).toHaveLength(1)
    expect(
      recorded.logs.some(
        line =>
          line.includes('Failed to re-arm deferred agent worktree cleanup') &&
          line.includes('rearm boom'),
      ),
    ).toBe(true)
  })

  test('a synchronously throwing re-arm is caught the same way', async () => {
    const registry = registryWithOccupant()
    const { recorded, deps } = harness({
      rearm: () => {
        throw new Error('rearm sync boom')
      },
    })

    const result = await cleanupAgentWorktree(baseParams(registry), deps)
    await flushMicrotasks()

    expect(result.worktreePath).toBe(WORKTREE_PATH)
    expect(recorded.removals).toEqual([])
    expect(
      recorded.logs.some(line => line.includes('rearm sync boom')),
    ).toBe(true)
  })
})
