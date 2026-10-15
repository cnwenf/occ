/**
 * Official Claude Code 2.1.299 (#074): ScheduleCronTool reports the ACTUAL
 * next run time computed from the cron expression (scheduler per-job jitter
 * offset included) in CronCreate/CronList output, the tool-result
 * announcement, and the Ink UI suffix.
 *
 * Byte-exact strings verified from the v299 ELF (offsets into
 * /tmp/cc-diff-299/v299/package/claude):
 *   - schema describe `MLn` @223044643:
 *     "Epoch ms of the job's next run, the scheduler's per-job offset included"
 *   - result text @248823000:
 *     `t=e.nextFireAt===void 0?"":` Next run: ${Vke(Oat(e.nextFireAt))}.``
 *     `Scheduled recurring job ${e.id} (${e.humanSchedule}).${t} ${n}.
 *      Auto-expires after ${xRe} days. Use CronDelete to cancel sooner.`
 *     `Scheduled one-shot task ${e.id} (${e.humanSchedule}).${t} ${n}.
 *      It will fire once then auto-delete.`
 *   - list result row @248837119: `…, next run ${Vke(Oat(t.nextFireAt))}: …`
 *   - `Iat` @223031264 / `Oat` @223031378 / `Vke` @248814432.
 * v296 has ZERO hits for " Next run: " / ", next run " — surface is new in
 * v299.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { removeSessionCronTasks } from '../../../bootstrap/state.js'
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  taskNextFireAt,
} from '../../../utils/cronTasks.js'
import { CronCreateTool } from '../CronCreateTool.js'
import { CronListTool } from '../CronListTool.js'
import {
  formatNextRunDate,
  nextRunSentence,
  nextRunUiSuffix,
  roundToMinute,
} from '../nextRunDisplay.js'

// Fixed fake "now": Jan 15 2026, 14:30 local (cron evaluates in local time).
const FAKE_NOW = new Date(2026, 0, 15, 14, 30, 0).getTime()
// Next hourly mark after FAKE_NOW.
const NEXT_HOUR = new Date(2026, 0, 15, 15, 0, 0).getTime()

type CallResult<T> = Promise<{ data: T }>
const callCreate = CronCreateTool.call as unknown as (input: {
  cron: string
  prompt: string
  recurring?: boolean
  durable?: boolean
}) => CallResult<{
  id: string
  humanSchedule: string
  recurring: boolean
  durable?: boolean
  nextFireAt?: number
}>

const createdIds: string[] = []
let dateNowSpy: ReturnType<typeof spyOn> | null = null

afterEach(() => {
  dateNowSpy?.mockRestore()
  dateNowSpy = null
  while (createdIds.length > 0) {
    const id = createdIds.pop()
    if (id) removeSessionCronTasks([id])
  }
})

describe('2.1.299 #074: taskNextFireAt (official Iat)', () => {
  test('recurring task anchors at createdAt with zero-jitter id', () => {
    // jitterFrac('00000000') === 0 → no forward delay: exact next cron mark.
    const next = taskNextFireAt(
      { id: '00000000', cron: '0 * * * *', createdAt: FAKE_NOW, recurring: true },
      DEFAULT_CRON_JITTER_CONFIG,
    )
    expect(next).toBe(NEXT_HOUR)
  })

  test('recurring task anchors at lastFiredAt when present', () => {
    const lastFiredAt = new Date(2026, 0, 15, 14, 0, 0).getTime()
    const next = taskNextFireAt(
      {
        id: '00000000',
        cron: '0 * * * *',
        createdAt: FAKE_NOW - 10 * 86400000,
        lastFiredAt,
        recurring: true,
      },
      DEFAULT_CRON_JITTER_CONFIG,
    )
    // From 14:00 the next hourly mark is 15:00 (same as from 14:30 here);
    // prove the anchor by using a cron that differs between the two anchors.
    expect(next).toBe(NEXT_HOUR)
    const pinned = taskNextFireAt(
      {
        id: '00000000',
        cron: '30 14 15 1 *',
        createdAt: FAKE_NOW,
        lastFiredAt: new Date(2026, 0, 15, 14, 30).getTime(),
        recurring: true,
      },
      DEFAULT_CRON_JITTER_CONFIG,
    )
    // Anchored from lastFiredAt (14:30 Jan 15) → next Jan 15 14:30 is a year out.
    expect(pinned).toBe(new Date(2027, 0, 15, 14, 30).getTime())
  })

  test('recurring jitter matches jitteredNextCronRunMs for the same id', () => {
    const task = {
      id: 'ffffffff',
      cron: '0 * * * *',
      createdAt: FAKE_NOW,
      recurring: true as const,
    }
    expect(taskNextFireAt(task, DEFAULT_CRON_JITTER_CONFIG)).toBe(
      jitteredNextCronRunMs(task.cron, task.createdAt, task.id, DEFAULT_CRON_JITTER_CONFIG),
    )
    // Max-jitter id fires within the documented [t1, t1 + frac*period) window.
    const next = taskNextFireAt(task, DEFAULT_CRON_JITTER_CONFIG)!
    expect(next).toBeGreaterThan(NEXT_HOUR)
    expect(next).toBeLessThanOrEqual(NEXT_HOUR + 15 * 60 * 1000)
  })

  test('one-shot task uses the backward minute-gated jitter', () => {
    // 14:30 landing → minute 30 % 30 === 0 → jitter window applies, but
    // zero-jitter id keeps the exact mark.
    const next = taskNextFireAt(
      { id: '00000000', cron: '30 14 15 1 *', createdAt: FAKE_NOW - 60000 },
      DEFAULT_CRON_JITTER_CONFIG,
    )
    expect(next).toBe(new Date(2026, 0, 15, 14, 30).getTime())
  })

  test('invalid cron returns null (no nextFireAt reported)', () => {
    expect(
      taskNextFireAt(
        { id: '00000000', cron: 'not a cron', createdAt: FAKE_NOW },
        DEFAULT_CRON_JITTER_CONFIG,
      ),
    ).toBeNull()
  })
})

describe('2.1.299 #074: roundToMinute (official Oat)', () => {
  test('rounds epoch ms to the nearest minute', () => {
    const base = new Date(2026, 0, 15, 14, 30).getTime()
    expect(roundToMinute(base).getTime()).toBe(base)
    expect(roundToMinute(base + 29_999).getTime()).toBe(base)
    expect(roundToMinute(base + 30_000).getTime()).toBe(base + 60_000)
  })

  test('NaN produces an Invalid Date (UI suffix gate)', () => {
    expect(Number.isNaN(roundToMinute(Number.NaN).getTime())).toBe(true)
  })
})

describe('2.1.299 #074: formatNextRunDate (official Vke)', () => {
  test('formats en-US short month, numeric day, lowercase meridiem', () => {
    expect(formatNextRunDate(new Date(2026, 0, 15, 14, 30))).toBe(
      'Jan 15 2:30pm',
    )
  })

  test('midnight formats as 12:NNam', () => {
    expect(formatNextRunDate(new Date(2026, 0, 15, 0, 5))).toBe(
      'Jan 15 12:05am',
    )
  })

  test('includeYear option keeps the year', () => {
    expect(
      formatNextRunDate(new Date(2026, 0, 15, 14, 30), { includeYear: true }),
    ).toBe('Jan 15, 2026 2:30pm')
  })
})

describe('2.1.299 #074: nextRunSentence / nextRunUiSuffix', () => {
  const at230 = new Date(2026, 0, 15, 14, 30).getTime()

  test('sentence: undefined → empty, value → " Next run: …. "', () => {
    expect(nextRunSentence(undefined)).toBe('')
    expect(nextRunSentence(at230)).toBe(' Next run: Jan 15 2:30pm.')
  })

  test('sentence rounds seconds away (official Oat pre-round)', () => {
    expect(nextRunSentence(at230 + 29_000)).toBe(' Next run: Jan 15 2:30pm.')
  })

  test('UI suffix: undefined/NaN → empty, value → ", next run …"', () => {
    expect(nextRunUiSuffix(undefined)).toBe('')
    expect(nextRunUiSuffix(at230)).toBe(', next run Jan 15 2:30pm')
  })
})

describe('2.1.299 #074: CronCreateTool result text (byte-exact official)', () => {
  const mapCreate = CronCreateTool.mapToolResultToToolResultBlockParam
  const at230 = new Date(2026, 0, 15, 14, 30).getTime()

  test('recurring + durable + nextFireAt', () => {
    const block = mapCreate(
      {
        id: 'abc12345',
        humanSchedule: 'every hour',
        recurring: true,
        durable: true,
        nextFireAt: at230,
      },
      'tu1',
    )
    expect(block.content).toBe(
      'Scheduled recurring job abc12345 (every hour). Next run: Jan 15 2:30pm. Persisted to .claude/scheduled_tasks.json. Auto-expires after 7 days. Use CronDelete to cancel sooner.',
    )
  })

  test('one-shot + session-only + nextFireAt', () => {
    const block = mapCreate(
      {
        id: 'abc12345',
        humanSchedule: 'Jan 15 at 2:30pm',
        recurring: false,
        durable: false,
        nextFireAt: at230,
      },
      'tu1',
    )
    expect(block.content).toBe(
      'Scheduled one-shot task abc12345 (Jan 15 at 2:30pm). Next run: Jan 15 2:30pm. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.',
    )
  })

  test('missing nextFireAt keeps the pre-299 spacing', () => {
    const block = mapCreate(
      { id: 'abc12345', humanSchedule: 'every hour', recurring: true, durable: false },
      'tu1',
    )
    expect(block.content).toBe(
      'Scheduled recurring job abc12345 (every hour). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.',
    )
  })
})

describe('2.1.299 #074: CronListTool result text', () => {
  const at230 = new Date(2026, 0, 15, 14, 30).getTime()

  test('row includes ", next run …" before the prompt', () => {
    const block = CronListTool.mapToolResultToToolResultBlockParam(
      {
        jobs: [
          {
            id: 'abc12345',
            cron: '0 * * * *',
            humanSchedule: 'every hour',
            prompt: 'tick',
            recurring: true,
            durable: false,
            nextFireAt: at230,
          },
        ],
      },
      'tu1',
    )
    expect(block.content).toBe(
      'abc12345 — every hour (recurring) [session-only], next run Jan 15 2:30pm: tick',
    )
  })

  test('row without nextFireAt omits the suffix', () => {
    const block = CronListTool.mapToolResultToToolResultBlockParam(
      {
        jobs: [
          {
            id: 'abc12345',
            cron: '0 * * * *',
            humanSchedule: 'every hour',
            prompt: 'tick',
          },
        ],
      },
      'tu1',
    )
    expect(block.content).toBe('abc12345 — every hour (one-shot): tick')
  })
})

describe('2.1.299 #074: CronCreateTool.call reports the real next run', () => {
  test('known cron expr + fixed fake now → scheduler-accurate nextFireAt', async () => {
    dateNowSpy = spyOn(Date, 'now').mockReturnValue(FAKE_NOW)
    const { data } = await callCreate({
      cron: '0 * * * *',
      prompt: 'tick',
      recurring: true,
      durable: false,
    })
    createdIds.push(data.id)

    expect(data.nextFireAt).toBeDefined()
    // The reported value must equal the scheduler's own first-sight
    // computation for the SAME id/createdAt anchor (jitter included).
    expect(data.nextFireAt).toBe(
      taskNextFireAt(
        { id: data.id, cron: '0 * * * *', createdAt: FAKE_NOW, recurring: true },
        DEFAULT_CRON_JITTER_CONFIG,
      ),
    )
    // Zero-jitter window bounds: [15:00, 15:00 + 10% of period).
    expect(data.nextFireAt!).toBeGreaterThanOrEqual(NEXT_HOUR)
    expect(data.nextFireAt!).toBeLessThan(NEXT_HOUR + 6 * 60 * 1000)
  })

  test('announcement text includes the computed next run', async () => {
    // Minute 37 is not a multiple of oneShotMinuteMod (30) → the one-shot
    // backward jitter never applies, so the expected time is id-independent.
    const fakeNow = new Date(2026, 0, 15, 14, 0, 0).getTime()
    dateNowSpy = spyOn(Date, 'now').mockReturnValue(fakeNow)
    const { data } = await callCreate({
      cron: '37 14 15 1 *',
      prompt: 'remind me',
      recurring: false,
      durable: false,
    })
    createdIds.push(data.id)

    expect(data.nextFireAt).toBe(new Date(2026, 0, 15, 14, 37).getTime())
    const block = CronCreateTool.mapToolResultToToolResultBlockParam(
      data,
      'tu1',
    )
    expect(block.content).toContain(' Next run: Jan 15 2:37pm.')
    expect(block.content).toBe(
      `Scheduled one-shot task ${data.id} (${data.humanSchedule}). Next run: Jan 15 2:37pm. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.`,
    )
  })
})
