/**
 * CC 2.1.311 Item 12 — the subagent *occupant index* the agent worktree
 * cleanup consults before deleting a worktree.
 *
 * Official v311 bytes (READ-ONLY binaries, verified with grep -aboF + dd, never
 * executed):
 *
 *   Go  @246833024  function Go(e){return e==="completed"||e==="failed"||e==="killed"}
 *   ax  @251643778  function ax(e,n){return e===n||e.startsWith(n.endsWith(wSn)?n:n+wSn)}
 *                   (wSn = `sep` from "path", @251642260)
 *   Nn  @256753600  function Nn(n,e,s=(h)=>!Go(h.status)){
 *                     for(let h of Object.values(n)){
 *                       let y=h.cwd;
 *                       if(y===void 0||!s(h))continue;
 *                       if(e.some((S)=>Kc(y,S)))return h
 *                     }
 *                     return
 *                   }
 *   caller @256785050  let F=(te)=>Nn(q.all(),E===void 0?[r]:[r,E],te)
 *
 * No real git worktree is created here — these are pure registry/helper units.
 */

import { describe, expect, test } from 'bun:test'
import {
  type AgentTaskRecord,
  TaskRegistryImpl,
  findAgentTaskOccupant,
  getNoopTaskRegistry,
  getProcessTaskRegistry,
  isPathInsideOrEqual,
  isTerminalAgentTaskStatus,
} from '../taskRegistry.js'

const WORKTREE = '/tmp/occ-worktrees/wt-x'

function task(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  return {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    cwd: WORKTREE,
    ...overrides,
  }
}

describe('isTerminalAgentTaskStatus (official Go @246833024)', () => {
  test('treats completed/failed/killed as terminal', () => {
    expect(isTerminalAgentTaskStatus('completed')).toBe(true)
    expect(isTerminalAgentTaskStatus('failed')).toBe(true)
    expect(isTerminalAgentTaskStatus('killed')).toBe(true)
  })

  test('treats running as non-terminal', () => {
    expect(isTerminalAgentTaskStatus('running')).toBe(false)
  })
})

describe('isPathInsideOrEqual (official ax @251643778)', () => {
  test('matches an identical path', () => {
    expect(isPathInsideOrEqual(WORKTREE, WORKTREE)).toBe(true)
  })

  test('matches a nested path', () => {
    expect(isPathInsideOrEqual(`${WORKTREE}/packages/app`, WORKTREE)).toBe(true)
  })

  test('does NOT match a sibling that merely shares a prefix', () => {
    // The separator boundary is the whole point: `/wt-xy` starts with `/wt-x`
    // but is not inside it.
    expect(isPathInsideOrEqual('/tmp/occ-worktrees/wt-xy', WORKTREE)).toBe(
      false,
    )
  })

  test('does not match an ancestor', () => {
    expect(isPathInsideOrEqual('/tmp/occ-worktrees', WORKTREE)).toBe(false)
  })

  test('handles a root that already ends in a separator', () => {
    expect(isPathInsideOrEqual(`${WORKTREE}/sub`, `${WORKTREE}/`)).toBe(true)
    expect(isPathInsideOrEqual(`${WORKTREE}/`, `${WORKTREE}/`)).toBe(true)
  })

  test('does not match unrelated paths', () => {
    expect(isPathInsideOrEqual('/home/user/repo', WORKTREE)).toBe(false)
  })
})

describe('findAgentTaskOccupant (official Nn @256753600)', () => {
  test('returns a running task whose cwd is the root', () => {
    const occupant = findAgentTaskOccupant([task()], [WORKTREE])
    expect(occupant?.id).toBe('agent-1')
  })

  test('returns a running task whose cwd is nested inside the root', () => {
    const occupant = findAgentTaskOccupant(
      [task({ cwd: `${WORKTREE}/packages/app` })],
      [WORKTREE],
    )
    expect(occupant?.id).toBe('agent-1')
  })

  test('does NOT match a sibling worktree sharing a prefix', () => {
    const occupant = findAgentTaskOccupant(
      [task({ cwd: '/tmp/occ-worktrees/wt-xy/deep' })],
      [WORKTREE],
    )
    expect(occupant).toBeUndefined()
  })

  test('skips tasks with no cwd (official `y===void 0` continue)', () => {
    const occupant = findAgentTaskOccupant(
      [task({ cwd: undefined })],
      [WORKTREE],
    )
    expect(occupant).toBeUndefined()
  })

  test('skips terminal tasks under the default predicate', () => {
    for (const status of ['completed', 'failed', 'killed'] as const) {
      expect(findAgentTaskOccupant([task({ status })], [WORKTREE])).toBeUndefined()
    }
  })

  test('accepts a caller predicate that widens past terminality', () => {
    // The official second scan passes `(te)=>te.id!==ye&&Gt(te,q)`, which sees
    // parked terminal tasks. Same mechanism here.
    const parked = task({ status: 'completed', parked: true })
    expect(
      findAgentTaskOccupant([parked], [WORKTREE], t => t.parked === true)?.id,
    ).toBe('agent-1')
    expect(findAgentTaskOccupant([parked], [WORKTREE])).toBeUndefined()
  })

  test('matches against any of several roots', () => {
    const occupant = findAgentTaskOccupant(
      [task({ cwd: '/tmp/other-wt/sub' })],
      [WORKTREE, '/tmp/other-wt'],
    )
    expect(occupant?.id).toBe('agent-1')
  })

  test('returns the first match in iteration order', () => {
    const occupant = findAgentTaskOccupant(
      [task({ id: 'first' }), task({ id: 'second' })],
      [WORKTREE],
    )
    expect(occupant?.id).toBe('first')
  })

  test('returns undefined for an empty task list', () => {
    expect(findAgentTaskOccupant([], [WORKTREE])).toBeUndefined()
  })
})

describe('TaskRegistryImpl occupant store (CC 2.1.311 Item 12)', () => {
  test('registers a task and reads it back by id', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task())
    expect(registry.getAgentTask('agent-1')?.cwd).toBe(WORKTREE)
  })

  test('stores a copy — later caller mutation cannot change the record', () => {
    const registry = new TaskRegistryImpl()
    const record = task()
    registry.registerAgentTask(record)
    // The record handed in is readonly by type; prove the store did not keep
    // the identity so a cast-and-mutate cannot reach it either.
    expect(registry.getAgentTask('agent-1')).not.toBe(record)
    expect(registry.getAgentTask('agent-1')).toEqual(record)
  })

  test('allAgentTasks returns an insertion-ordered snapshot', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task({ id: 'a' }))
    registry.registerAgentTask(task({ id: 'b' }))
    expect(registry.allAgentTasks().map(t => t.id)).toEqual(['a', 'b'])
  })

  test('updateAgentTask is copy-on-update — the earlier record is untouched', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task())
    const before = registry.getAgentTask('agent-1')
    registry.updateAgentTask('agent-1', { status: 'completed' })
    expect(before?.status).toBe('running')
    expect(registry.getAgentTask('agent-1')?.status).toBe('completed')
    expect(registry.getAgentTask('agent-1')).not.toBe(before)
  })

  test('updateAgentTask on an unknown id is a no-op', () => {
    const registry = new TaskRegistryImpl()
    registry.updateAgentTask('missing', { status: 'completed' })
    expect(registry.getAgentTask('missing')).toBeUndefined()
    expect(registry.allAgentTasks()).toEqual([])
  })

  test('updateAgentTask cannot rewrite the id', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task())
    // `id` is Omit-ed from the patch type; prove runtime agrees.
    registry.updateAgentTask('agent-1', { id: 'other' } as never)
    expect(registry.getAgentTask('agent-1')?.id).toBe('agent-1')
    expect(registry.getAgentTask('other')).toBeUndefined()
  })

  test('unregisterAgentTask drops the record', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task())
    registry.unregisterAgentTask('agent-1')
    expect(registry.getAgentTask('agent-1')).toBeUndefined()
  })

  test('unregisterAgentTask on an unknown id is a no-op', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task())
    registry.unregisterAgentTask('missing')
    expect(registry.allAgentTasks()).toHaveLength(1)
  })

  test('findOccupant sees a running task inside the worktree', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task({ id: 'child', cwd: `${WORKTREE}/pkg` }))
    expect(registry.findOccupant([WORKTREE])?.id).toBe('child')
  })

  test('findOccupant ignores terminal tasks by default but sees them via predicate', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(
      task({ id: 'child', status: 'completed', parked: true }),
    )
    expect(registry.findOccupant([WORKTREE])).toBeUndefined()
    expect(
      registry.findOccupant([WORKTREE], t => t.parked === true)?.id,
    ).toBe('child')
  })

  test('a running→completed transition removes the occupant', () => {
    const registry = new TaskRegistryImpl()
    registry.registerAgentTask(task({ id: 'child' }))
    expect(registry.findOccupant([WORKTREE])?.id).toBe('child')
    registry.updateAgentTask('child', { status: 'completed' })
    expect(registry.findOccupant([WORKTREE])).toBeUndefined()
  })

  test('occupant tracking is independent of the web-search/concurrency counters', () => {
    const registry = new TaskRegistryImpl()
    registry.incrementWebSearchCalls()
    const release = registry.takeConcurrencySlot()
    registry.registerAgentTask(task())
    expect(registry.getWebSearchCalls()).toBe(1)
    expect(registry.getConcurrentSubagents()).toBe(1)
    registry.unregisterAgentTask('agent-1')
    release()
    expect(registry.getWebSearchCalls()).toBe(1)
    expect(registry.getConcurrentSubagents()).toBe(0)
  })
})

describe('getNoopTaskRegistry occupant store (headless stub)', () => {
  test('tracks nothing — findOccupant is always undefined', () => {
    const registry = getNoopTaskRegistry()
    registry.registerAgentTask(task())
    expect(registry.getAgentTask('agent-1')).toBeUndefined()
    expect(registry.allAgentTasks()).toEqual([])
    expect(registry.findOccupant([WORKTREE])).toBeUndefined()
  })

  test('update/unregister are safe no-ops', () => {
    const registry = getNoopTaskRegistry()
    registry.updateAgentTask('agent-1', { status: 'completed' })
    registry.unregisterAgentTask('agent-1')
    expect(registry.allAgentTasks()).toEqual([])
  })
})

describe('getProcessTaskRegistry (process-wide occupant store)', () => {
  test('returns the same registry across calls', () => {
    expect(getProcessTaskRegistry()).toBe(getProcessTaskRegistry())
  })

  test('tracks occupants registered through it', () => {
    const registry = getProcessTaskRegistry()
    const id = `agent-proc-${Date.now()}`
    registry.registerAgentTask(task({ id, cwd: '/tmp/occ-proc-wt' }))
    expect(registry.findOccupant(['/tmp/occ-proc-wt'])?.id).toBe(id)
    registry.unregisterAgentTask(id)
    expect(registry.getAgentTask(id)).toBeUndefined()
  })
})
