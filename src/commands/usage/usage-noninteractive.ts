import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { computeUsageEffortState } from './usageEffortState.js'
import { computeUsageWindows } from './usageScan.js'
import { formatBehaviors } from './usageWarnings.js'

// Non-interactive (-p) variant of /usage. Shows session cost, plan usage, and
// what's contributing to limits. Mirrors the official 2.1.200 description:
// "Show session cost, plan usage, and what's contributing to your limits".
export const call: LocalCommandCall = async () => {
  const parts: string[] = []

  // Session cost
  parts.push(formatTotalCost())

  // Plan usage / limit contribution
  if (isClaudeAISubscriber()) {
    if (currentLimits.isUsingOverage) {
      parts.push(
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset',
      )
    } else {
      parts.push(
        'You are currently using your subscription to power your Claude Code usage',
      )
    }
    if (typeof currentLimits.utilization === 'number') {
      parts.push(
        // Clamp at 100%: upstream utilization can exceed 1.0 briefly before a
        // reset lands, and displaying >100% is wrong (anthropics/claude-code#92238).
        `Current utilization: ${Math.min(100, Math.round(currentLimits.utilization * 100))}%`,
      )
    }
    // CC 2.1.299 (#017): "Added `/usage` warnings for max effort, workflows,
    // always-on context and large tool results." Official `G` (call) gates
    // the behaviors section on the subscriber check (`vt()`, mirrored by this
    // isClaudeAISubscriber() block) and builds it from a LOCAL transcript
    // scan, appended with `\n\n` — here via parts.join. The official also
    // gates on an `allow_usage_transcript_scan` org policy; OCC has no policy
    // subsystem for this key and the scan never leaves the machine, so the
    // gate is omitted (documented in usageScan.ts). A scan failure must
    // never break /usage — fall back to no behaviors section.
    //
    // CC 2.1.305 (/usage item): "each warning is now a one-line fix that
    // names its source" — the official v306 `G` (call) now passes
    // `includeBehaviors` into the scan (`rOn`), receives per-window
    // `recommendations` (+ the machine-readable `fix` payload, interactive-
    // only) and renders them via `S` (formatBehaviors). OCC mirrors the
    // text half: computeUsageWindows (official `wYe`) + the effort state
    // (official `vYe` adaptation) feed the recommendation catalog; the
    // `fix` payload is built by the interactive `f` action instead
    // (usageFixEnqueue.ts).
    try {
      const windows = await computeUsageWindows(computeUsageEffortState())
      if (windows !== null) {
        const section = formatBehaviors({
          day: {
            ...windows.day.pcts,
            recommendations: windows.day.recommendations,
          },
          week: {
            ...windows.week.pcts,
            recommendations: windows.week.recommendations,
          },
        })
        if (section !== null) parts.push(section)
      }
    } catch {
      // Behaviors are best-effort; the rest of /usage still renders.
    }
  }

  return { type: 'text', value: parts.join('\n\n') }
}
