import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { computeNextCronRun, parseCronExpression } from '../cron.js'
import {
  findMissedTasks,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  taskNextFireAt,
} from '../cronTasks.js'

/**
 * CC 2.1.299 (#102): "Fixed scheduled tasks/loops firing again or early
 * during the DST repeated hour." Official v299 `yPt` walker + `k` ambiguity
 * detector (byte-exact forensics: `yPt` @223024523, `MJt`/`uuo`/`Vys`/`Iat`
 * @223030478-223031387 in the v299 ELF; v296 `kAt`/`fKe`/`iMn`/`Lcs`
 * @215324509+ had none of this).
 *
 * The fix, verified against the binary:
 * - Walk starts from ABSOLUTE epoch time: `Math.floor(s/60000)*60000+60000`
 *   (+ Invalid-Date guard), not wall-clock setSeconds/setMinutes.
 * - `k(u)` = setMinutes-roundtrip detector: true exactly for the SECOND
 *   occurrence of a fall-back repeated local time. Recurring crons skip
 *   those candidates in absolute +60 s steps (no double fire); `oneShot`
 *   walks may still MATCH a second occurrence (a one-shot pinned to a
 *   wall-clock time that didn't fire during the first occurrence fires
 *   during the repeat).
 * - `{oneShot}` threads through nextCronRunMs (`MJt`),
 *   oneShotJitteredNextCronRunMs (`uuo`, `{oneShot:!0}`) and
 *   findMissedTasks (`Vys`, `{oneShot:!n.recurring}`).
 *
 * Fixture timezone: America/New_York.
 * Fall-back 2023-11-05: 01:30 EDT = 05:30Z (first), 01:30 EST = 06:30Z
 * (second); transition at 06:00Z. Spring-forward 2023-03-12: local 02:00–
 * 02:59 nonexistent; 02:00 EST would be 07:00Z.
 */

const ORIGINAL_TZ = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

/** Local-time epoch helper (reads the pinned TZ at call time). */
function local(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  return new Date(year, month1 - 1, day, hour, minute, second).getTime()
}

function fields(cron: string) {
  const f = parseCronExpression(cron)
  if (!f) throw new Error(`bad cron: ${cron}`)
  return f
}

describe('computeNextCronRun — DST fall-back repeated hour (CC 2.1.299 #102)', () => {
  test('recurring fires at the FIRST occurrence normally', () => {
    // From 01:00 EDT, `30 1 * * *` → 01:30 EDT (first occurrence, 05:30Z).
    const next = computeNextCronRun(
      fields('30 1 * * *'),
      new Date(local(2023, 11, 5, 1, 0)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 5, 5, 30))
  })

  test('recurring does NOT fire again at the second occurrence (the #102 double fire)', () => {
    // Just after firing at 01:30 EDT (05:30Z): v296 returned 01:30 EST
    // (06:30Z, 60 min later — the double fire). v299 skips the whole second
    // occurrence → next day 01:30 EST.
    const next = computeNextCronRun(
      fields('30 1 * * *'),
      new Date(Date.UTC(2023, 10, 5, 5, 30)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 6, 6, 30))
  })

  test('recurring reschedule from mid-first-occurrence skips the repeat', () => {
    // From 01:45 EDT (05:45Z) the recurring walk must land on Nov 6.
    const next = computeNextCronRun(
      fields('30 1 * * *'),
      new Date(Date.UTC(2023, 10, 5, 5, 45)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 6, 6, 30))
  })

  test('hourly recurring skips the repeated 01:00 EST occurrence', () => {
    // From 01:30 EDT: next `0 * * * *` is 02:00 EST (07:00Z) — the repeated
    // 01:00 EST (06:00Z) is skipped, no double fire.
    const next = computeNextCronRun(
      fields('0 * * * *'),
      new Date(local(2023, 11, 5, 1, 30)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 5, 7, 0))
  })

  test('every-minute recurring never fires during the second occurrence', () => {
    // From 01:59:30 EDT (05:59:30Z): the walk starts at 06:00Z (01:00 EST,
    // k=true) and absolute-steps through the whole repeated hour to
    // 02:00 EST (07:00Z).
    const next = computeNextCronRun(
      fields('* * * * *'),
      new Date(Date.UTC(2023, 10, 5, 5, 59, 30)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 5, 7, 0))
  })

  test('one-shot DOES match the second occurrence (wall-clock intent preserved)', () => {
    // One-shot `30 1 * * *` created at 01:45 EDT missed the first occurrence;
    // official oneShot semantics fire it at 01:30 EST (06:30Z) the same day.
    const next = computeNextCronRun(
      fields('30 1 * * *'),
      new Date(Date.UTC(2023, 10, 5, 5, 45)),
      { oneShot: true },
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 5, 6, 30))
  })
})

describe('computeNextCronRun — absolute-time start + guards (CC 2.1.299 #102)', () => {
  test('start is floor-to-minute + 60s of EPOCH time, not wall clock', () => {
    // From 01:30:30.500 EDT: `31 1 * * *` → exactly 05:31:00.000Z.
    const next = computeNextCronRun(
      fields('31 1 * * *'),
      new Date(Date.UTC(2023, 10, 5, 5, 30, 30, 500)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 10, 5, 5, 31))
  })

  test('Invalid Date input returns null (official NaN guard)', () => {
    expect(computeNextCronRun(fields('30 1 * * *'), new Date(NaN))).toBeNull()
    expect(nextCronRunMs('30 1 * * *', Number.NaN)).toBeNull()
  })
})

describe('computeNextCronRun — spring-forward gap (regression, both modes)', () => {
  test('recurring fixed-hour cron skips the gap day', () => {
    // `30 2 * * *` on 2023-03-12: local 02:30 does not exist → Mar 13.
    const next = computeNextCronRun(
      fields('30 2 * * *'),
      new Date(local(2023, 3, 12, 1, 0)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 2, 13, 6, 30))
  })

  test('one-shot absolute stepping also lands after the gap', () => {
    const next = computeNextCronRun(
      fields('30 2 * * *'),
      new Date(local(2023, 3, 12, 1, 0)),
      { oneShot: true },
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 2, 13, 6, 30))
  })
})

describe('computeNextCronRun — DST-free regression', () => {
  test('daily cron on a normal day is unchanged', () => {
    const next = computeNextCronRun(
      fields('30 9 * * *'),
      new Date(local(2023, 6, 15, 8, 0)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 5, 15, 13, 30))
  })

  test('hourly cron on a normal day is unchanged', () => {
    const next = computeNextCronRun(
      fields('0 * * * *'),
      new Date(local(2023, 6, 15, 8, 15)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2023, 5, 15, 13, 0))
  })

  test('pinned date cron walks to next year', () => {
    const next = computeNextCronRun(
      fields('30 14 27 2 *'),
      new Date(local(2023, 6, 15, 8, 0)),
    )
    expect(next?.getTime()).toBe(Date.UTC(2024, 1, 27, 19, 30))
  })

  test('oneShot flag is a no-op away from transitions', () => {
    const from = new Date(local(2023, 6, 15, 8, 0))
    const recurring = computeNextCronRun(fields('30 9 * * *'), from)
    const oneShot = computeNextCronRun(fields('30 9 * * *'), from, {
      oneShot: true,
    })
    expect(oneShot?.getTime()).toBe(recurring?.getTime())
  })

  test('UTC timezone has no repeated hour at all (DST-free regression)', () => {
    process.env.TZ = 'UTC'
    try {
      const next = computeNextCronRun(
        fields('30 1 * * *'),
        new Date(Date.UTC(2023, 10, 5, 1, 30)),
      )
      expect(next?.getTime()).toBe(Date.UTC(2023, 10, 6, 1, 30))
    } finally {
      process.env.TZ = 'America/New_York'
    }
  })
})

describe('nextCronRunMs option threading (official MJt)', () => {
  test('default walk skips the repeated hour, {oneShot:true} matches it', () => {
    const from = Date.UTC(2023, 10, 5, 5, 45) // 01:45 EDT
    expect(nextCronRunMs('30 1 * * *', from)).toBe(Date.UTC(2023, 10, 6, 6, 30))
    expect(nextCronRunMs('30 1 * * *', from, { oneShot: true })).toBe(
      Date.UTC(2023, 10, 5, 6, 30),
    )
  })
})

describe('oneShotJitteredNextCronRunMs (official uuo, {oneShot:!0})', () => {
  test('zero-jitter task id reaches the second occurrence on fall-back day', () => {
    // taskId '00000000' → jitterFrac 0 → lead 0 → t1 unchanged.
    const from = Date.UTC(2023, 10, 5, 5, 45) // 01:45 EDT
    expect(oneShotJitteredNextCronRunMs('30 1 * * *', from, '00000000')).toBe(
      Date.UTC(2023, 10, 5, 6, 30),
    )
  })
})

describe('findMissedTasks (official Vys, {oneShot:!recurring})', () => {
  test('recurring anchored past the repeat is not missed; one-shot is', () => {
    const createdAt = Date.UTC(2023, 10, 5, 5, 45) // 01:45 EDT
    const now = Date.UTC(2023, 10, 5, 6, 45) // 01:45 EST
    const base = { id: 'aaaaaaaa', cron: '30 1 * * *', prompt: 'p', createdAt }
    // Recurring: next = Nov 6 06:30Z > now → NOT missed.
    expect(findMissedTasks([{ ...base, recurring: true }], now)).toEqual([])
    // One-shot: next = Nov 5 06:30Z (second occurrence) < now → missed.
    expect(findMissedTasks([base], now)).toHaveLength(1)
  })
})

describe('taskNextFireAt scheduler anchor (official Iat) — DST dedup via lastFiredAt', () => {
  test('recurring anchored at lastFiredAt=first occurrence never re-fires in the repeat', () => {
    // The scheduler fired at 01:30 EDT and persisted lastFiredAt=05:30Z.
    // First-sight after restart must anchor to Nov 6, not 01:30 EST.
    const next = taskNextFireAt(
      {
        id: '00000000',
        cron: '30 1 * * *',
        createdAt: Date.UTC(2023, 10, 1),
        recurring: true,
        lastFiredAt: Date.UTC(2023, 10, 5, 5, 30),
      },
      // frac 0 → zero jitter regardless of config.
    )
    expect(next).toBe(Date.UTC(2023, 10, 6, 6, 30))
  })

  test('one-shot anchor keeps the repeated-hour fire', () => {
    const next = taskNextFireAt({
      id: '00000000',
      cron: '30 1 * * *',
      createdAt: Date.UTC(2023, 10, 5, 5, 45),
    })
    expect(next).toBe(Date.UTC(2023, 10, 5, 6, 30))
  })
})
