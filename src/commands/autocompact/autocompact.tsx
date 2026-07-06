import * as React from 'react'
import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * /autocompact — opens the settings panel on the Config tab so the user can
 * configure the auto-compact threshold (autoCompactEnabled /
 * autoCompactThreshold). Mirrors the official 2.1.x /autocompact command.
 *
 * The argumentHint "[auto|<tokens>]" is shown in typeahead; the interactive
 * command opens the panel. The official also has a non-interactive (-p) variant
 * ("Configure the auto-compact window size") for direct value setting.
 */
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Config" />
}
