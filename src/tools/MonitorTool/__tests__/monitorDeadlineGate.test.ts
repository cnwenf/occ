import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../../Tool.js'
import { getIsInteractive, setIsInteractive } from '../../../bootstrap/state.js'
import {
  MonitorTool,
  fireMonitorDeadline,
  monitorExpiredNotice,
  stopMonitor,
} from '../MonitorTool.js'

/**
 * E2E-1 fix (OCC-126 acceptance follow-up): the deadline expiry notice must be
 * gated on the monitor still being live. Official 2.1.272 binary call site
 * (verbatim):
 *
 *   let W = setTimeout((u,O,D,C,E,x)=>{ if(u.isKilled())return; …
 *     D1(O,Crn(x.timeoutMs,u.eventCount(),x.bounded),D,{isHousekeeping:!0,…}),
 *     l2(D,E) }, …)
 *   _.result.then(()=>{ if(W)clearTimeout(W); … })
 *
 * A naturally-exited or stopped watch therefore never produces a false
 * "expired" notice. These tests cover: the fake-registry emit gate, the real
 * natural-exit path, the real manual-stop path, the live-expiry kill path, and
 * the description's OCC delivery-divergence banner.
 */

const CTX = {} as unknown as ToolUseContext

type CallFn = (input: {
  command?: string
  description: string
  timeout_ms?: number
}) => Promise<{ data: { taskId: string; persistent: boolean; timeoutMs: number } }>
const callMonitor = MonitorTool.call.bind(MonitorTool) as unknown as CallFn

let savedInteractive: boolean
beforeAll(() => {
  savedInteractive = getIsInteractive()
})
afterAll(() => {
  setIsInteractive(savedInteractive)
})

// STATE.isInteractive defaults to false (print mode); interactive cap 1_800_000
// keeps every timeout_ms used here uncapped.
beforeEach(() => {
  setIsInteractive(true)
})

const spawnedTaskIds: string[] = []
function trackTask(taskId: string): string {
  spawnedTaskIds.push(taskId)
  return taskId
}
afterAll(() => {
  while (spawnedTaskIds.length > 0) {
    const id = spawnedTaskIds.pop()
    if (id) stopMonitor(id)
  }
})

function makeEmitter(): { emitted: string[]; emit: (line: string) => void } {
  const emitted: string[] = []
  return { emitted, emit: (line) => emitted.push(line) }
}

describe('fireMonitorDeadline: registry-gated expiry notice (binary liveness gate)', () => {
  test('live handle → true: notice emitted, kill invoked, handle deregistered', () => {
    const registry = new Map<string, { taskId: string; kill: () => void }>()
    let killed = 0
    registry.set('t1', { taskId: 't1', kill: () => { killed++ } })
    const { emitted, emit } = makeEmitter()

    const fired = fireMonitorDeadline({
      taskId: 't1',
      timeoutMs: 300_000,
      eventCount: 3,
      emit,
      registry,
    })

    expect(fired).toBe(true)
    expect(killed).toBe(1)
    expect(emitted).toEqual([monitorExpiredNotice(300_000, 3)])
    expect(registry.has('t1')).toBe(false)
  })

  test('absent handle (already ended) → false: NO notice, nothing touched', () => {
    const registry = new Map<string, { taskId: string; kill: () => void }>()
    const { emitted, emit } = makeEmitter()

    const fired = fireMonitorDeadline({
      taskId: 'gone',
      timeoutMs: 300_000,
      eventCount: 0,
      emit,
      registry,
    })

    expect(fired).toBe(false)
    expect(emitted).toEqual([])
    expect(registry.size).toBe(0)
  })
})

describe('real call(): natural exit / manual stop produce no false expiry notice', () => {
  test('natural exit deregisters before the deadline → fireMonitorDeadline is a no-op', async () => {
    // `echo` exits within milliseconds; streamCommand's finally block deletes
    // the registry entry long before the 10s deadline.
    const res = await callMonitor({
      command: 'echo hello',
      description: 'natural exit',
      timeout_ms: 10_000,
    })
    trackTask(res.data.taskId)
    await Bun.sleep(1000)

    const { emitted, emit } = makeEmitter()
    const fired = fireMonitorDeadline({
      taskId: res.data.taskId,
      timeoutMs: res.data.timeoutMs,
      eventCount: 0,
      emit,
    })

    expect(fired).toBe(false)
    expect(emitted).toEqual([])
  })

  test('manual stop (TaskStop path) before the deadline → no notice on later expiry', async () => {
    const res = await callMonitor({
      command: 'sleep 30',
      description: 'manual stop',
      timeout_ms: 10_000,
    })
    expect(stopMonitor(res.data.taskId)).toBe(true)

    const { emitted, emit } = makeEmitter()
    const fired = fireMonitorDeadline({
      taskId: res.data.taskId,
      timeoutMs: res.data.timeoutMs,
      eventCount: 0,
      emit,
    })

    expect(fired).toBe(false)
    expect(emitted).toEqual([])
  })

  test('live monitor at the deadline → notice with the event count, killed + deregistered', async () => {
    const res = await callMonitor({
      command: 'sleep 30',
      description: 'live expiry',
      timeout_ms: 60_000, // far above the test window; fire the seam directly
    })
    trackTask(res.data.taskId)

    const { emitted, emit } = makeEmitter()
    const fired = fireMonitorDeadline({
      taskId: res.data.taskId,
      timeoutMs: res.data.timeoutMs,
      eventCount: 2,
      emit,
    })

    expect(fired).toBe(true)
    expect(emitted).toEqual([monitorExpiredNotice(60_000, 2)])
    // Killed + deregistered: a second fire and TaskStop both find nothing.
    expect(fireMonitorDeadline({
      taskId: res.data.taskId,
      timeoutMs: res.data.timeoutMs,
      eventCount: 2,
      emit,
    })).toBe(false)
    expect(stopMonitor(res.data.taskId)).toBe(false)
    expect(emitted.length).toBe(1)
  })
})

describe('description: OCC delivery-divergence banner (contract-text truth)', () => {
  const BANNER_HEAD = '**OCC build note (event delivery not yet wired):**'

  test.each([true, false])(
    'interactive=%s: banner present, mentions occ127, precedes the official text',
    async (interactive) => {
      setIsInteractive(interactive)
      const desc = await MonitorTool.description(undefined as never, undefined as never)

      expect(desc).toContain(BANNER_HEAD)
      expect(desc).toContain('recorded internally but are NOT delivered to the chat')
      expect(desc).toContain('occ127')
      expect(desc).toContain('The deadline itself IS enforced')
      // Official description kept verbatim below the banner.
      const officialStart =
        'Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat.'
      expect(desc).toContain(officialStart)
      expect(desc.indexOf('OCC build note')).toBeLessThan(
        desc.indexOf('Start a background monitor'),
      )
      expect(desc.startsWith(BANNER_HEAD)).toBe(true)
    },
  )

  test('prompt() mirrors description() including the banner', async () => {
    setIsInteractive(true)
    const desc = await MonitorTool.description(undefined as never, undefined as never)
    const prompt = await MonitorTool.prompt()
    expect(prompt).toBe(desc)
    expect(prompt).toContain(BANNER_HEAD)
  })
})
