import { describe, expect, test, beforeEach } from 'bun:test'
import { saveGlobalConfig } from '../../../utils/config.js'
import {
  FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS,
  getTipShownCount,
  isTipLifetimeCapped,
  recordTipShown,
} from '../tipHistory.js'

/**
 * Claude Code 2.1.217 #17: "Capped the frontend-design plugin suggestion
 * tip at 3 lifetime impressions instead of repeating indefinitely"
 *
 * Before this fix the `frontend-design-plugin` spinner tip gated only on a
 * 3-session cooldown (`cooldownSessions: 3`) — once the cooldown elapsed it
 * reappeared forever. The fix adds a per-tip lifetime impression counter
 * persisted in the global config (`tipsShownCount`). After the tip has been
 * shown 3 times (lifetime, across all sessions) it is permanently suppressed.
 *
 * The persistence seam is the existing per-user global config store used by
 * `tipsHistory`; under `NODE_ENV=test` `getGlobalConfig`/`saveGlobalConfig`
 * operate on an in-memory object, which acts as the mock persistence seam.
 */

const TIP_ID = 'frontend-design-plugin'

describe('2.1.217 #17: frontend-design tip lifetime impression cap', () => {
  beforeEach(() => {
    // Reset the persisted impression store + cooldown history between cases.
    saveGlobalConfig(c => ({
      ...c,
      tipsHistory: {},
      tipsShownCount: {},
    }))
  })

  test('FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS is exactly 3', () => {
    expect(FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS).toBe(3)
  })

  test('(i) tip is NOT capped when shown-count < 3', () => {
    // 0 impressions
    expect(getTipShownCount(TIP_ID)).toBe(0)
    expect(isTipLifetimeCapped(TIP_ID, FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS)).toBe(
      false,
    )

    // 1 impression
    recordTipShown(TIP_ID)
    expect(getTipShownCount(TIP_ID)).toBe(1)
    expect(isTipLifetimeCapped(TIP_ID, FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS)).toBe(
      false,
    )

    // 2 impressions
    recordTipShown(TIP_ID)
    expect(getTipShownCount(TIP_ID)).toBe(2)
    expect(isTipLifetimeCapped(TIP_ID, FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS)).toBe(
      false,
    )
  })

  test('(ii) tip IS capped when shown-count >= 3', () => {
    for (let i = 0; i < 3; i++) recordTipShown(TIP_ID)
    expect(getTipShownCount(TIP_ID)).toBe(3)
    expect(isTipLifetimeCapped(TIP_ID, FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS)).toBe(
      true,
    )

    // stays capped as count grows past 3
    recordTipShown(TIP_ID)
    expect(isTipLifetimeCapped(TIP_ID, FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS)).toBe(
      true,
    )
  })

  test('(iii) showing the tip increments the persisted count', () => {
    expect(getTipShownCount(TIP_ID)).toBe(0)
    recordTipShown(TIP_ID)
    expect(getTipShownCount(TIP_ID)).toBe(1)
    recordTipShown(TIP_ID)
    expect(getTipShownCount(TIP_ID)).toBe(2)
    // Count survives across "sessions" (no reset) — it is lifetime-persisted.
    recordTipShown(TIP_ID)
    expect(getTipShownCount(TIP_ID)).toBe(3)
  })

  test('(iv) cap is exactly 3: shows on impressions 1,2,3; suppressed on 4+', () => {
    const canShow = () =>
      !isTipLifetimeCapped(TIP_ID, FRONTEND_DESIGN_TIP_MAX_IMPRESSIONS)

    // Impressions 1, 2, 3 are shown (not yet at cap when the show decision
    // is made — decision happens BEFORE incrementing).
    expect(canShow()).toBe(true) // before impression 1
    recordTipShown(TIP_ID) // impression 1 shown
    expect(canShow()).toBe(true) // before impression 2
    recordTipShown(TIP_ID) // impression 2 shown
    expect(canShow()).toBe(true) // before impression 3
    recordTipShown(TIP_ID) // impression 3 shown

    // 4th and onward: suppressed
    expect(canShow()).toBe(false)
    recordTipShown(TIP_ID) // would-be impression 4
    expect(canShow()).toBe(false)
  })
})
