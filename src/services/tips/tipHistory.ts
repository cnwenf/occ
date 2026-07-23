import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

/**
 * Claude Code 2.1.217 #17: lifetime impression cap for the frontend-design
 * plugin suggestion tip. After this many lifetime shows (persisted per-user in
 * `tipsShownCount`), the tip no longer appears.
 */
export const FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS = 3

export function recordTipShown(tipId: string): void {
  const numStartups = getGlobalConfig().numStartups
  saveGlobalConfig(c => {
    const history = c.tipsHistory ?? {}
    const shownCount = c.tipsShownCount ?? {}
    const nextShownCount = { ...shownCount, [tipId]: (shownCount[tipId] ?? 0) + 1 }
    // Cooldown history is unchanged when the same startup already recorded it.
    if (history[tipId] === numStartups && shownCount[tipId] !== undefined) {
      return { ...c, tipsShownCount: nextShownCount }
    }
    return {
      ...c,
      tipsHistory: { ...history, [tipId]: numStartups },
      tipsShownCount: nextShownCount,
    }
  })
}

export function getSessionsSinceLastShown(tipId: string): number {
  const config = getGlobalConfig()
  const lastShown = config.tipsHistory?.[tipId]
  if (!lastShown) return Infinity
  return config.numStartups - lastShown
}

/** Lifetime number of times `tipId` has been shown (persisted per-user). */
export function getTipShownCount(tipId: string): number {
  return getGlobalConfig().tipsShownCount?.[tipId] ?? 0
}

/**
 * Whether a tip has reached its lifetime impression cap and should be
 * permanently suppressed. Returns false when no cap (`maxImpressions`
 * undefined/<=0) is configured.
 */
export function isTipLifetimeCapped(
  tipId: string,
  maxImpressions: number | undefined,
): boolean {
  if (maxImpressions === undefined || maxImpressions <= 0) return false
  return getTipShownCount(tipId) >= maxImpressions
}
