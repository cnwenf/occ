// CC 2.1.299 #060 (anthropics/claude-code#92238): the status line's
// rate_limits.used_percentage must never exceed 100. Official v299 wraps the
// raw header utilization in `ume(e) = Math.min(Math.round(e*1000)/10, 100)`
// (byte-verified at offset 225614128 in the 2.1.299 linux-x64 binary; v296
// passed the raw fraction through). OCC keeps its existing float precision and
// adds only the clamp. Extracted from StatusLine.tsx (same precedent as
// statusLineUpdateGate.ts) so the clamp is unit-testable without the Ink graph.

export type StatusLineRawUtilization = {
  five_hour?: { utilization: number; resets_at: number }
  seven_day?: { utilization: number; resets_at: number }
}

export type StatusLineRateLimits = {
  five_hour?: { used_percentage: number; resets_at: number }
  seven_day?: { used_percentage: number; resets_at: number }
}

export function clampUsedPercentage(utilization: number): number {
  return Math.min(utilization * 100, 100)
}

export function buildStatusLineRateLimits(
  rawUtil: StatusLineRawUtilization,
): StatusLineRateLimits {
  return {
    ...(rawUtil.five_hour && {
      five_hour: {
        used_percentage: clampUsedPercentage(rawUtil.five_hour.utilization),
        resets_at: rawUtil.five_hour.resets_at,
      },
    }),
    ...(rawUtil.seven_day && {
      seven_day: {
        used_percentage: clampUsedPercentage(rawUtil.seven_day.utilization),
        resets_at: rawUtil.seven_day.resets_at,
      },
    }),
  }
}
