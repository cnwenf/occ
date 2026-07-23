import * as React from 'react'
import { useEffect, useState } from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState } from '../../state/AppState.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { getBranch } from '../../utils/git.js'
import { getLogoDisplayData } from '../../utils/logoV2Utils.js'
import { renderModelSetting } from '../../utils/model/model.js'
import { isScreenReaderEnabled } from '../../utils/screenReader.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import {
  GuestPassesUpsell,
  incrementGuestPassesSeenCount,
  useShowGuestPassesUpsell,
} from './GuestPassesUpsell.js'
import { OccWelcome } from './OccWelcome.js'
import {
  incrementOverageCreditUpsellSeenCount,
  OverageCreditUpsell,
  useShowOverageCreditUpsell,
} from './OverageCreditUpsell.js'
import { pickWelcomeTip } from './welcomeTips.js'

export function CondensedLogo(): React.ReactNode {
  const { columns } = useTerminalSize()
  const agent = useAppState(state => state.agent)
  const effortValue = useAppState(state => state.effortValue)
  const model = useMainLoopModel()
  const modelDisplayName = renderModelSetting(model)
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings,
  } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const effortSuffix = getEffortSuffix(model, effortValue)
  const showGuestPassesUpsell = useShowGuestPassesUpsell()
  const showOverageCreditUpsell = useShowOverageCreditUpsell()
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [branch, setBranch] = useState<string>()
  const tip = pickWelcomeTip(
    getSessionId() ?? '',
    getGlobalConfig().numStartups ?? 0,
  )

  useEffect(() => {
    let active = true
    getBranch()
      .then(currentBranch => {
        if (active) {
          setBranch(currentBranch === 'HEAD' ? undefined : currentBranch)
        }
      })
      .catch(() => {
        if (active) setBranch(undefined)
      })
    return () => {
      active = false
    }
  }, [cwd])

  useEffect(() => {
    if (showGuestPassesUpsell) {
      incrementGuestPassesSeenCount()
    }
  }, [showGuestPassesUpsell])

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount()
    }
  }, [showGuestPassesUpsell, showOverageCreditUpsell])

  const plain =
    isScreenReaderEnabled() || process.env.TERM?.toLowerCase() === 'dumb'
  const upsell = showGuestPassesUpsell ? (
    <GuestPassesUpsell />
  ) : showOverageCreditUpsell ? (
    <OverageCreditUpsell
      maxWidth={Math.max(columns - 6, 20)}
      twoLine
    />
  ) : null

  return (
    <OffscreenFreeze>
      <OccWelcome
        columns={columns}
        version={version}
        model={modelDisplayName + effortSuffix}
        billing={billingType}
        cwd={cwd}
        branch={branch}
        agentName={agentName}
        tip={tip}
        reducedMotion={reducedMotion || plain}
        plain={plain}
      >
        {upsell}
      </OccWelcome>
    </OffscreenFreeze>
  )
}
