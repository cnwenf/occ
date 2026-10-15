// Minimal cron expression parsing and next-run calculation.
//
// Supports the standard 5-field cron subset:
//   minute hour day-of-month month day-of-week
//
// Field syntax: wildcard, N, step (star-slash-N), range (N-M), list (N,M,...).
// No L, W, ?, or name aliases. All times are interpreted in the process's
// local timezone — "0 9 * * *" means 9am wherever the CLI is running.

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
]

// Parse a single cron field into a sorted array of matching values.
// Supports: wildcard, N, star-slash-N (step), N-M (range), and comma-lists.
// Returns null if invalid.
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(',')) {
    // wildcard or star-slash-N
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/)
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }

    // N-M or N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10)
      const hi = parseInt(rangeMatch[2]!, 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      // dayOfWeek: accept 7 as Sunday alias in ranges (e.g. 5-7 = Fri,Sat,Sun → [5,6,0])
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i)
      }
      continue
    }

    // plain N
    const singleMatch = part.match(/^\d+$/)
    if (singleMatch) {
      let n = parseInt(part, 10)
      // dayOfWeek: accept 7 as Sunday alias → 0
      if (min === 0 && max === 6 && n === 7) n = 0
      if (n < min || n > max) return null
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) return null
  return Array.from(out).sort((a, b) => a - b)
}

/**
 * Parse a 5-field cron expression into expanded number arrays.
 * Returns null if invalid or unsupported syntax.
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) return null
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}

/**
 * Official v299 helper `k` (CC 2.1.299 #102, byte-exact:
 * `function k(e){let s=new Date(e.getTime());return s.setMinutes(s.getMinutes()),
 * s.getTime()!==e.getTime()}` @223024556 region).
 *
 * Ambiguous-local-time detector: rebuilding the date from its own local
 * fields (setMinutes with the SAME minute) re-resolves an ambiguous wall
 * clock to the EARLIER UTC offset. The epoch therefore changes exactly when
 * `d` is the SECOND occurrence of a DST fall-back repeated local time
 * (e.g. 1:30 EST after 1:30 EDT). First occurrences and all unambiguous
 * times round-trip unchanged.
 */
function isRepeatedLocalTime(d: Date): boolean {
  const probe = new Date(d.getTime())
  probe.setMinutes(probe.getMinutes())
  return probe.getTime() !== d.getTime()
}

/**
 * Compute the next Date strictly after `from` that matches the cron fields,
 * using the process's local timezone. Bounded at 366 days; returns null if
 * no match (impossible for valid cron, but satisfies the type) or if `from`
 * is an Invalid Date.
 *
 * Standard cron semantics: when both dayOfMonth and dayOfWeek are constrained
 * (neither is the full range), a date matches if EITHER matches.
 *
 * CC 2.1.299 (#102) — official v299 `yPt(fields, from, {oneShot})`
 * (@223024523; v296 `kAt` had none of this and double/early-fired crons
 * during the DST fall-back repeated hour):
 * - The walk starts from ABSOLUTE epoch time (floor to minute + 60 000 ms),
 *   never wall-clock setSeconds/setMinutes which re-resolve across a
 *   transition.
 * - Candidates in the SECOND occurrence of a repeated local hour are detected
 *   via {@link isRepeatedLocalTime} and stepped past in absolute time. For
 *   recurring crons they are never matched → a `30 1 * * *` task that fired
 *   at 1:30 EDT does NOT fire again at 1:30 EST (the #102 double fire). For
 *   `oneShot` a fully-matching second occurrence IS returned — a one-shot
 *   pinned to a wall-clock time that hasn't fired during the first occurrence
 *   still fires during the repeat.
 * - `oneShot` also steps hour/minute mismatches in absolute time; recurring
 *   keeps the wall-clock setHours/setMinutes jumps (fast path over long gaps).
 *
 * Spring-forward gaps: a fixed-hour cron targeting the gap (e.g. `30 2 * * *`
 * on the transition day) skips to the next matching calendar day — the gap
 * local time never appears. Wildcard-hour crons (`30 * * * *`) fire at the
 * first valid minute after the gap.
 */
export function computeNextCronRun(
  fields: CronFields,
  from: Date,
  opts?: { oneShot?: boolean },
): Date | null {
  const oneShot = opts?.oneShot ?? false
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  // Is the field wildcarded (full range)?
  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7
  // When both dom/dow are constrained, either match is sufficient (OR semantics)
  const dayMatches = (d: Date): boolean =>
    domWild && dowWild
      ? true
      : domWild
        ? dowSet.has(d.getDay())
        : dowWild
          ? domSet.has(d.getDate())
          : domSet.has(d.getDate()) || dowSet.has(d.getDay())

  // Absolute-time start: floor to the minute boundary, then +1 minute of
  // epoch time (official `new Date(Math.floor(s.getTime()/60000)*60000+60000)`).
  const t = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000)
  if (Number.isNaN(t.getTime())) return null

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    if (isRepeatedLocalTime(t)) {
      // Second occurrence of a DST-repeated local hour. One-shots may match
      // it (user pinned that wall-clock time and it hasn't fired yet);
      // recurring crons never match it — step past in absolute time.
      if (
        oneShot &&
        monthSet.has(t.getMonth() + 1) &&
        dayMatches(t) &&
        hourSet.has(t.getHours()) &&
        minuteSet.has(t.getMinutes())
      ) {
        return t
      }
      t.setTime(t.getTime() + 60000)
      continue
    }

    const month = t.getMonth() + 1
    if (!monthSet.has(month)) {
      // Jump to start of next month
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!dayMatches(t)) {
      // Jump to start of next day
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours()) || !minuteSet.has(t.getMinutes())) {
      if (oneShot) {
        t.setTime(t.getTime() + 60000)
      } else if (!hourSet.has(t.getHours())) {
        t.setHours(t.getHours() + 1, 0, 0, 0)
      } else {
        t.setMinutes(t.getMinutes() + 1)
      }
      continue
    }

    return t
  }

  return null
}

// --- cronToHuman ------------------------------------------------------------
// Intentionally narrow: covers common patterns; falls through to the raw cron
// string for anything else. The `utc` option exists for CCR remote triggers
// (agents-platform.tsx), which run on servers and always use UTC cron strings
// — that path translates UTC→local for display and needs midnight-crossing
// logic for the weekday case. Local scheduled tasks (the default) need neither.

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

function formatLocalTime(minute: number, hour: number): string {
  // January 1 — no DST gap anywhere. Using `new Date()` (today) would roll
  // 2am→3am on the one spring-forward day per year.
  const d = new Date(2000, 0, 1, hour, minute)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatUtcTimeAsLocal(minute: number, hour: number): string {
  // Create a date in UTC and format in user's local timezone
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export function cronToHuman(cron: string, opts?: { utc?: boolean }): string {
  const utc = opts?.utc ?? false
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  // Every N minutes: step/N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/)
  if (
    everyMinMatch &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyMinMatch[1]!, 10)
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  // Every hour: 0 * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const m = parseInt(minute, 10)
    if (m === 0) return 'Every hour'
    return `Every hour at :${m.toString().padStart(2, '0')}`
  }

  // Every N hours: 0 step/N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/)
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHourMatch[1]!, 10)
    const m = parseInt(minute, 10)
    const suffix = m === 0 ? '' : ` at :${m.toString().padStart(2, '0')}`
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`
  }

  // --- Remaining cases reference hour+minute: branch on utc ----------------

  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) return cron
  const m = parseInt(minute, 10)
  const h = parseInt(hour, 10)
  const fmtTime = utc ? formatUtcTimeAsLocal : formatLocalTime

  // Daily at specific time: M H * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${fmtTime(m, h)}`
  }

  // Specific day of week: M H * * D
  if (dayOfMonth === '*' && month === '*' && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7 // normalize 7 (Sunday alias) -> 0
    let dayName: string | undefined
    if (utc) {
      // UTC day+time may land on a different local day (midnight crossing).
      // Compute the actual local weekday by constructing the UTC instant.
      const ref = new Date()
      const daysToAdd = (dayIndex - ref.getUTCDay() + 7) % 7
      ref.setUTCDate(ref.getUTCDate() + daysToAdd)
      ref.setUTCHours(h, m, 0, 0)
      dayName = DAY_NAMES[ref.getDay()]
    } else {
      dayName = DAY_NAMES[dayIndex]
    }
    if (dayName) return `Every ${dayName} at ${fmtTime(m, h)}`
  }

  // Weekdays: M H * * 1-5
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Weekdays at ${fmtTime(m, h)}`
  }

  return cron
}
