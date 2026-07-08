import * as React from 'react'
import { useEffect, useState } from 'react'
import { Text } from '../ink.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { isFableModel } from '../utils/fable/isFableModel.js'
import { getRemainingFableCredits } from '../utils/fable/fableCredits.js'

/** Refresh cadence for the credits read (ms). The counter lives on disk. */
const CREDITS_REFRESH_MS = 2000

/**
 * Status indicator shown in the REPL footer when Fable 5 is the active model.
 * Displays remaining research-preview credits. Renders nothing for other
 * models so the footer is unchanged in the common case. Polls the credits
 * file on a slow interval only while Fable 5 is active.
 */
export function FableCreditsIndicator(): React.ReactNode {
  const model = useMainLoopModel()
  const isFable = isFableModel(model)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!isFable) {
      setRemaining(0)
      return
    }
    setRemaining(getRemainingFableCredits())
    const id = setInterval(() => setRemaining(getRemainingFableCredits()), CREDITS_REFRESH_MS)
    return () => clearInterval(id)
  }, [isFable])

  if (!isFable) return null
  return <Text dimColor>Fable {remaining} credits</Text>
}
