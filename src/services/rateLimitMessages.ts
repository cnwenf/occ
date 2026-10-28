/**
 * Centralized rate limit message generation
 * Single source of truth for all rate limit-related messages
 */

import {
  getOauthAccountInfo,
  getSubscriptionType,
  isOverageProvisioningAllowed,
} from '../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../utils/billing.js'
import { formatResetTime } from '../utils/format.js'
import type { ClaudeAILimits } from './claudeAiLimits.js'

const FEEDBACK_CHANNEL_ANT = '#briarpatch-cc'

/**
 * All possible rate limit error message prefixes
 * Export this to avoid fragile string matching in UI components
 */
export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

/**
 * Check if a message is a rate limit error
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

/**
 * Get the appropriate rate limit message based on limit state
 * Returns null if no message should be shown
 */
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  model: string,
): RateLimitMessage | null {
  // Check overage scenarios first (when subscription is rejected but overage is available)
  // getUsingOverageText is rendered separately from warning.
  if (limits.isUsingOverage) {
    // Show warning if approaching overage spending limit
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: "You're close to your extra usage spending limit",
        severity: 'warning',
      }
    }
    return null
  }

  // ERROR STATES - when limits are rejected
  if (limits.status === 'rejected') {
    return { message: getLimitReachedText(limits, model), severity: 'error' }
  }

  // WARNING STATES - when approaching limits with early warning
  if (limits.status === 'allowed_warning') {
    // Only show warnings when utilization is above threshold (70%)
    // This prevents false warnings after week reset when API may send
    // allowed_warning with stale data at low usage levels
    const WARNING_THRESHOLD = 0.7
    if (
      limits.utilization !== undefined &&
      limits.utilization < WARNING_THRESHOLD
    ) {
      return null
    }

    // Don't warn non-billing Team/Enterprise users about approaching plan limits
    // if overages are enabled - they'll seamlessly roll into overage
    const subscriptionType = getSubscriptionType()
    const isTeamOrEnterprise =
      subscriptionType === 'team' || subscriptionType === 'enterprise'
    const hasExtraUsageEnabled =
      getOauthAccountInfo()?.hasExtraUsageEnabled === true

    if (
      isTeamOrEnterprise &&
      hasExtraUsageEnabled &&
      !hasClaudeAiBillingAccess()
    ) {
      return null
    }

    const text = getEarlyWarningText(limits)
    if (text) {
      return { message: text, severity: 'warning' }
    }
  }

  // No message needed
  return null
}

/**
 * Get error message for API errors (used in errors.ts)
 * Returns the message string or null if no error message should be shown
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return error messages, not warnings
  if (message && message.severity === 'error') {
    return message.message
  }

  return null
}

/**
 * Get warning message for UI footer
 * Returns the warning message string or null if no warning should be shown
 */
export function getRateLimitWarning(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return warnings for the footer - errors are shown in AssistantTextMessages
  if (message && message.severity === 'warning') {
    return message.message
  }

  // Don't show errors in the footer
  return null
}

function getLimitReachedText(limits: ClaudeAILimits, model: string): string {
  const resetsAt = limits.resetsAt
  const resetTime = resetsAt ? formatResetTime(resetsAt, true) : undefined
  const overageResetTime = limits.overageResetsAt
    ? formatResetTime(limits.overageResetsAt, true)
    : undefined
  const resetMessage = resetTime ? ` · resets ${resetTime}` : ''

  // if BOTH subscription (checked before this method) and overage are exhausted
  if (limits.overageStatus === 'rejected') {
    // Show the earliest reset time to indicate when user can resume
    let overageResetMessage = ''
    if (resetsAt && limits.overageResetsAt) {
      // Both timestamps present - use the earlier one
      if (resetsAt < limits.overageResetsAt) {
        overageResetMessage = ` · resets ${resetTime}`
      } else {
        overageResetMessage = ` · resets ${overageResetTime}`
      }
    } else if (resetTime) {
      overageResetMessage = ` · resets ${resetTime}`
    } else if (overageResetTime) {
      overageResetMessage = ` · resets ${overageResetTime}`
    }

    if (limits.overageDisabledReason === 'out_of_credits') {
      return `You're out of extra usage${overageResetMessage}`
    }

    return formatLimitReachedText('limit', overageResetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    const limit = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
    return formatLimitReachedText(limit, resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_opus') {
    return formatLimitReachedText('Opus limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day') {
    return formatLimitReachedText('weekly limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'five_hour') {
    // CC 2.1.312 (item 20): official display map renamed five_hour
    // "session limit" → "5-hour limit" (v311 `wce` @246735413 → v312 `Hce` @246569205).
    return formatLimitReachedText('5-hour limit', resetMessage, model)
  }

  return formatLimitReachedText('usage limit', resetMessage, model)
}

function getEarlyWarningText(limits: ClaudeAILimits): string | null {
  let limitName: string | null = null
  switch (limits.rateLimitType) {
    case 'seven_day':
      limitName = 'weekly limit'
      break
    case 'five_hour':
      limitName = '5-hour limit' // CC 2.1.312 (item 20) rename
      break
    case 'seven_day_opus':
      limitName = 'Opus limit'
      break
    case 'seven_day_sonnet':
      limitName = 'Sonnet limit'
      break
    case 'overage':
      limitName = 'extra usage'
      break
    case undefined:
      return null
  }

  // utilization and resetsAt should be defined since early warning is calculated with them.
  // Clamp at 100% (anthropics/claude-code#92238) except for overage/extra-usage,
  // which the official binary intentionally leaves unclamped (can exceed the base limit).
  const used = limits.utilization
    ? Math.floor(
        limits.rateLimitType === 'overage'
          ? limits.utilization * 100
          : Math.min(limits.utilization * 100, 100),
      )
    : undefined
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined

  // Get upsell command based on subscription type and limit type
  const upsell = getWarningUpsellText(limits.rateLimitType)

  // CC 2.1.312 (item 20): when no utilization percent is available but the
  // server sent a surpassed-threshold fraction, render "Over N% of your
  // <limit> used". Official `$t` @246574430: `m=n?void 0:Ke(e.surpassedThreshold)`
  // with `Ke` clamping to integers 1..99 (new-in-312).
  const overPercent = used
    ? undefined
    : clampSurpassedThreshold(limits.surpassedThreshold)

  if (!used && limits.rateLimitType === 'overage') {
    // For the "Approaching <x>"/"Over N% of <x> used" verbiage, "extra usage
    // limit" makes more sense than "extra usage" (official overage branch:
    // `r=n?"usage credits":"usage credit limit"` — same short/long split).
    limitName += ' limit'
  }

  const base = used
    ? `You've used ${used}% of your ${limitName}`
    : overPercent !== undefined
      ? `Over ${overPercent}% of your ${limitName} used`
      : `Approaching ${limitName}`

  // Official joins base · resets · upsell with " · " (filter(Boolean)).
  const parts = [base, resetTime ? `resets ${resetTime}` : null, upsell].filter(
    Boolean,
  )
  return parts.join(' · ')
}

/**
 * CC 2.1.312 (item 20) — official `Ke` @246573773 (byte-verbatim semantics):
 * `function Ke(e){if(e===void 0||!Number.isFinite(e)||e<=0||e>=1)return;
 * return Math.min(99,Math.floor(Math.round(e*1e4)/100))}`
 * Fraction (0,1) → integer percent clamped to at most 99; anything else → undefined.
 */
function clampSurpassedThreshold(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value >= 1) {
    return undefined
  }
  return Math.min(99, Math.floor(Math.round(value * 1e4) / 100))
}

/**
 * Get the upsell command text for warning messages based on subscription and limit type.
 * Returns null if no upsell should be shown.
 * Only used for warnings because actual rate limit hits will see an interactive menu of options.
 */
function getWarningUpsellText(
  rateLimitType: ClaudeAILimits['rateLimitType'],
): string | null {
  const subscriptionType = getSubscriptionType()
  const hasExtraUsageEnabled =
    getOauthAccountInfo()?.hasExtraUsageEnabled === true

  // 5-hour session limit warning
  if (rateLimitType === 'five_hour') {
    // Teams/Enterprise with overages disabled: prompt to request extra usage
    // Only show if overage provisioning is allowed for this org type (e.g., not AWS marketplace)
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '/extra-usage to request more'
      }
      // Teams/Enterprise with overages enabled or unsupported billing type don't need upsell
      return null
    }

    // Pro/Max users: prompt to upgrade
    if (subscriptionType === 'pro' || subscriptionType === 'max') {
      return '/upgrade to keep using Claude Code'
    }
  }

  // Overage warning (approaching spending limit)
  if (rateLimitType === 'overage') {
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '/extra-usage to request more'
      }
    }
  }

  // Weekly limit warnings don't show upsell per spec
  return null
}

/**
 * Get notification text for overage mode transitions
 * Used for transient notifications when entering overage mode
 */
export function getUsingOverageText(limits: ClaudeAILimits): string {
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : ''

  let limitName = ''
  if (limits.rateLimitType === 'five_hour') {
    limitName = '5-hour limit' // CC 2.1.312 (item 20) rename
  } else if (limits.rateLimitType === 'seven_day') {
    limitName = 'weekly limit'
  } else if (limits.rateLimitType === 'seven_day_opus') {
    limitName = 'Opus limit'
  } else if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    limitName = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
  }

  if (!limitName) {
    return 'Now using extra usage'
  }

  const resetMessage = resetTime
    ? ` · Your ${limitName} resets ${resetTime}`
    : ''
  return `You're now using extra usage${resetMessage}`
}

function formatLimitReachedText(
  limit: string,
  resetMessage: string,
  _model: string,
): string {
  // Enhanced messaging for Ant users
  if (process.env.USER_TYPE === 'ant') {
    return `You've hit your ${limit}${resetMessage}. If you have feedback about this limit, post in ${FEEDBACK_CHANNEL_ANT}. You can reset your limits with /reset-limits`
  }

  return `You've hit your ${limit}${resetMessage}`
}
