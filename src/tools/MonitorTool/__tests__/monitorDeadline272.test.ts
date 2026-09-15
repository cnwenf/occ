import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../../Tool.js'
import { getIsInteractive, setIsInteractive } from '../../../bootstrap/state.js'
import {
  MonitorTool,
  monitorExpiredNotice,
  normalizeMonitorInput,
  stopMonitor,
} from '../MonitorTool.js'

/**
 * 2.1.271/2.1.272: Monitor-tool deadline change (Gap-126a). Official gate
 * `tengu_breezy_crescent` flipped false→true in 2.1.271, so the gated-ON
 * behavior ships (verbatim from the 2.1.272 linux-x64 binary):
 *
 *   var Aqe=300000, lat=3600000, o=1800000, r=600000
 *   function VSe(){return BAe()?r:o}          // BAe() = singleShotPrintSession
 *   function _kr(e,t){if(t)return{timeout_ms:Math.min(e.timeout_ms,VSe()),persistent:!1};…}
 *   PMt(ms) = `${Math.round(ms/60000)} minutes`
 *   Crn(e,t) → `[Monitor expired after ${Lt(e,{hideTrailingZeros:!0})} …]`
 *
 * Every monitor now dies at the cap (30 min interactive / 10 min in print
 * sessions); `persistent` stays in the schema as a compat field but
 * normalization forces it false. The schema describes are UNCHANGED upstream.
 */

const CTX = {} as unknown as ToolUseContext

// call() signature is (args, context, canUseTool, parentMessage, onProgress?);
// MonitorTool's implementation only reads (input, _context).
type CallFn = (input: {
  command?: string
  ws?: { url: string; protocols?: string[] }
  description: string
  timeout_ms?: number
  persistent?: boolean
}) => Promise<{ data: { taskId: string; persistent: boolean; timeoutMs: number } }>
const callMonitor = MonitorTool.call.bind(
  MonitorTool,
) as unknown as CallFn

let savedInteractive: boolean
beforeAll(() => {
  savedInteractive = getIsInteractive()
})
afterAll(() => {
  setIsInteractive(savedInteractive)
})

// STATE.isInteractive defaults to false (print mode), so every test sets the
// mode it needs explicitly. Interactive = cap 1_800_000; print = cap 600_000.
beforeEach(() => {
  setIsInteractive(true)
})

const spawnedTaskIds: string[] = []
function trackTask(taskId: string): string {
  spawnedTaskIds.push(taskId)
  return taskId
}

afterAll(() => {
  // Best-effort cleanup of any `sleep` processes spawned by call() tests.
  while (spawnedTaskIds.length > 0) {
    const id = spawnedTaskIds.pop()
    if (id) stopMonitor(id)
  }
})

describe('2.1.272: normalizeMonitorInput (binary _kr gate-ON path)', () => {
  test('persistent:true is forced false and timeout is capped at 30 minutes (interactive)', () => {
    setIsInteractive(true)
    const out = normalizeMonitorInput({ timeout_ms: 3_600_000, persistent: true })
    expect(out.persistent).toBe(false)
    expect(out.timeoutMs).toBe(1_800_000)
  })

  test('timeout above the cap is capped; below the cap is unchanged', () => {
    setIsInteractive(true)
    expect(normalizeMonitorInput({ timeout_ms: 3_600_000 }).timeoutMs).toBe(1_800_000)
    expect(normalizeMonitorInput({ timeout_ms: 120_000 }).timeoutMs).toBe(120_000)
  })

  test('exactly at the cap is unchanged', () => {
    setIsInteractive(true)
    expect(normalizeMonitorInput({ timeout_ms: 1_800_000 }).timeoutMs).toBe(1_800_000)
  })

  test('undefined timeout falls back to the 5-minute default (below both caps)', () => {
    setIsInteractive(true)
    expect(normalizeMonitorInput({}).timeoutMs).toBe(300_000)
    setIsInteractive(false)
    expect(normalizeMonitorInput({}).timeoutMs).toBe(300_000)
  })

  test('print (-p) sessions cap at 10 minutes', () => {
    setIsInteractive(false)
    expect(normalizeMonitorInput({ timeout_ms: 1_800_000 }).timeoutMs).toBe(600_000)
    expect(normalizeMonitorInput({ timeout_ms: 3_600_000, persistent: true }).timeoutMs).toBe(
      600_000,
    )
    expect(normalizeMonitorInput({ timeout_ms: 600_000 }).timeoutMs).toBe(600_000)
    expect(normalizeMonitorInput({ timeout_ms: 120_000 }).timeoutMs).toBe(120_000)
  })
})

describe('2.1.272: monitorExpiredNotice (binary Crn, Lt = formatDuration hideTrailingZeros)', () => {
  test('zero events → the "no events delivered … widen the filter" variant', () => {
    expect(monitorExpiredNotice(300_000, 0)).toBe(
      '[Monitor expired after 5m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]',
    )
  })

  test('N>0 → "with N event(s) delivered" with correct pluralization', () => {
    expect(monitorExpiredNotice(300_000, 1)).toBe(
      '[Monitor expired after 5m with 1 event delivered. Re-arm it if you still need the watch.]',
    )
    expect(monitorExpiredNotice(1_800_000, 3)).toBe(
      '[Monitor expired after 30m with 3 events delivered. Re-arm it if you still need the watch.]',
    )
    expect(monitorExpiredNotice(600_000, 12)).toBe(
      '[Monitor expired after 10m with 12 events delivered. Re-arm it if you still need the watch.]',
    )
  })

  test('duration renders via the OCC formatter with hideTrailingZeros', () => {
    expect(monitorExpiredNotice(3_600_000, 2)).toBe(
      '[Monitor expired after 1h with 2 events delivered. Re-arm it if you still need the watch.]',
    )
    expect(monitorExpiredNotice(90_000, 1)).toBe(
      '[Monitor expired after 1m 30s with 1 event delivered. Re-arm it if you still need the watch.]',
    )
  })
})

describe('2.1.272: MonitorTool.call() normalization + always-armed deadline', () => {
  test('persistent:true input reports persistent false and the 30-min-capped timeoutMs', async () => {
    setIsInteractive(true)
    const res = await callMonitor({
      command: 'sleep 30',
      description: 'deploy events',
      timeout_ms: 3_600_000,
      persistent: true,
    })
    trackTask(res.data.taskId)
    expect(res.data.persistent).toBe(false)
    expect(res.data.timeoutMs).toBe(1_800_000)
  })

  test('print mode caps call() timeoutMs at 600_000', async () => {
    setIsInteractive(false)
    const res = await callMonitor({
      command: 'sleep 30',
      description: 'deploy events',
      timeout_ms: 1_800_000,
    })
    trackTask(res.data.taskId)
    expect(res.data.timeoutMs).toBe(600_000)
  })

  test('baseline: a fresh monitor is registered and stopMonitor kills it', async () => {
    setIsInteractive(true)
    const res = await callMonitor({
      command: 'sleep 30',
      description: 'd',
      timeout_ms: 60_000,
    })
    expect(stopMonitor(res.data.taskId)).toBe(true)
  })

  test('kill timer is ALWAYS armed — persistent:true no longer bypasses the deadline', async () => {
    setIsInteractive(true)
    const res = await callMonitor({
      command: 'sleep 30',
      description: 'd',
      timeout_ms: 1000, // schema min
      persistent: true,
    })
    trackTask(res.data.taskId)
    // Still live immediately after arming…
    // …but the deadline timer kills + deregisters it shortly after expiry.
    await Bun.sleep(1400)
    expect(stopMonitor(res.data.taskId)).toBe(false)
  })
})

describe('2.1.272: description deadline section (gate-ON text, dynamic cap)', () => {
  const OFFICIAL_SECTION_INTERACTIVE =
    'Every monitor expires after `timeout_ms` (default 5 minutes, at most 30 minutes): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set `timeout_ms` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected.'

  test('interactive mode: full official sentence with the 30-minute cap', async () => {
    setIsInteractive(true)
    const desc = await MonitorTool.description(undefined as never, undefined as never)
    expect(desc).toContain(OFFICIAL_SECTION_INTERACTIVE)
    // Surrounding sentences kept exactly (prefix + suffix).
    expect(desc).toContain(
      'The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Every monitor expires',
    )
    expect(desc).toContain('unexpected. Use TaskStop to cancel early.')
  })

  test('print mode: cap renders as "at most 10 minutes"', async () => {
    setIsInteractive(false)
    const desc = await MonitorTool.description(undefined as never, undefined as never)
    expect(desc).toContain(
      'Every monitor expires after `timeout_ms` (default 5 minutes, at most 10 minutes)',
    )
    expect(desc).not.toContain('at most 30 minutes')
  })

  test('old persistent-escape-hatch sentence is gone', async () => {
    setIsInteractive(true)
    const desc = await MonitorTool.description(undefined as never, undefined as never)
    expect(desc).not.toContain('Set `persistent: true` for session-length watches')
    expect(desc).not.toContain('Timeout → killed')
  })

  test('prompt() mirrors description()', async () => {
    setIsInteractive(true)
    const desc = await MonitorTool.description(undefined as never, undefined as never)
    const prompt = await MonitorTool.prompt()
    expect(prompt).toBe(desc)
  })

  test('rest of the description is untouched (spot pins)', async () => {
    setIsInteractive(true)
    const desc = await MonitorTool.description(undefined as never, undefined as never)
    expect(desc).toContain(
      'Start a background monitor that streams events from a long-running script',
    )
    expect(desc).toContain('Each stdout line is an event')
    expect(desc).toContain(
      'Stdout lines within 200ms are batched into a single notification',
    )
    expect(desc).toContain('open a WebSocket and stream each incoming text frame')
  })
})

describe('2.1.272: input schema describes UNCHANGED (compat surface pinned)', () => {
  test('timeout_ms describe still says "Ignored when persistent is true."', () => {
    const shape = (MonitorTool.inputSchema as any).shape
    expect(shape.timeout_ms.description).toBe(
      'Kill the monitor after this deadline. Default 300000ms, max 3600000ms. Ignored when persistent is true.',
    )
  })

  test('persistent describe still "Run for the lifetime of the session (no timeout)…"', () => {
    const shape = (MonitorTool.inputSchema as any).shape
    expect(shape.persistent.description).toBe(
      'Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop.',
    )
  })

  test('schema bounds + defaults unchanged (min 1000, max 3_600_000, defaults applied)', () => {
    const schema = MonitorTool.inputSchema as any
    const parsed = schema.parse({ command: 'true', description: 'd' })
    expect(parsed.timeout_ms).toBe(300_000)
    expect(parsed.persistent).toBe(false)
    expect(
      schema.safeParse({ command: 'true', description: 'd', timeout_ms: 999 }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ command: 'true', description: 'd', timeout_ms: 3_600_001 }).success,
    ).toBe(false)
    // The 1h schema max stays — the 30-min cap lands in normalization, not the schema.
    expect(
      schema.safeParse({ command: 'true', description: 'd', timeout_ms: 3_600_000 }).success,
    ).toBe(true)
  })
})
