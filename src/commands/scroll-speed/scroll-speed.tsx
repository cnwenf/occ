import * as React from 'react'
import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * /scroll-speed — opens the settings panel on the Config tab so the user can
 * adjust the mouse-wheel scroll acceleration setting
 * (wheelScrollAccelerationEnabled). Mirrors the official 2.1.139 /scroll-speed.
 */
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Config" />
}
