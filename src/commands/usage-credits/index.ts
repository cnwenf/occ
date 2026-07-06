import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isOverageProvisioningAllowed } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

function isExtraUsageAllowed(): boolean {
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false
  }
  return isOverageProvisioningAllowed()
}

export const usageCredits = {
  type: 'local-jsx',
  name: 'usage-credits',
  description: 'Configure usage credits to keep working when you hit a limit',
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  requires: { ink: true },
  load: () => import('./usage-credits.js'),
} satisfies Command

export const usageCreditsNonInteractive = {
  type: 'local',
  name: 'usage-credits',
  supportsNonInteractive: true,
  description: 'Configure usage credits to keep working when you hit a limit',
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./usage-credits-noninteractive.js'),
} satisfies Command
