import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import React, { useEffect } from 'react'
import { permissionModeIndicator } from '../utils/permissions/PermissionMode.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

/**
 * 2.1.296 auto-default nudge dialog (Gap B port of official `qhe`).
 *
 * Verbatim strings from the official linux-x64 binary:
 * - Title: "Make auto mode your default permission mode?"
 * - Body: "Auto mode lets Claude handle permission prompts automatically.
 *   Claude checks each tool call for risky actions and prompt injection
 *   before executing, runs the ones it assesses as lower-risk, and blocks the
 *   rest."
 * - Accept option: "Yes, set auto mode as my default permission mode"
 * - Decline option: `No, keep ${permissionModeIndicator(currentMode)}`
 *
 * Official semantics reproduced here:
 * - Mount logs `tengu_auto_default_nudge_shown {current_mode}`.
 * - Select rendered with `hideIndexes: true`.
 * - Esc/cancel resolves to "decline" (official `onCancel -> at("decline")`).
 *
 * Divergence: the official dialog has a refusedWithin/noteRefused cooldown
 * tied to its dialog-queue infra. OCC's one-shot showSetupDialog has no such
 * queue, so the cooldown is not ported — the one-shot `hasSeenAutoDefaultNudge`
 * config flag (set by resolveAutoDefaultNudge) is what prevents re-prompting.
 */

/** Body paragraph — verbatim from the official `qhe` component. */
export const AUTO_DEFAULT_NUDGE_BODY =
  'Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest.'

/** Dialog title — verbatim from the official `qhe` Dialog. */
export const AUTO_DEFAULT_NUDGE_TITLE =
  'Make auto mode your default permission mode?'

export const AUTO_DEFAULT_NUDGE_ACCEPT_LABEL =
  'Yes, set auto mode as my default permission mode'

type Props = {
  currentMode: PermissionMode
  /**
   * Called once with the user's choice. 'decline' covers both the explicit
   * "No, keep …" option and Esc/cancel (official onCancel maps to decline).
   */
  onDone: (choice: 'accept' | 'decline') => void
}

export function AutoDefaultNudgeDialog({ currentMode, onDone }: Props) {
  useEffect(() => {
    logEvent('tengu_auto_default_nudge_shown', {
      current_mode:
        currentMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }, [currentMode])

  const options = [
    { label: AUTO_DEFAULT_NUDGE_ACCEPT_LABEL, value: 'accept' as const },
    {
      label: `No, keep ${permissionModeIndicator(currentMode)}`,
      value: 'decline' as const,
    },
  ]

  return (
    <Dialog
      title={AUTO_DEFAULT_NUDGE_TITLE}
      onCancel={() => onDone('decline')}
    >
      <Text>{AUTO_DEFAULT_NUDGE_BODY}</Text>
      <Select
        options={options}
        hideIndexes
        onChange={value => onDone(value)}
        onCancel={() => onDone('decline')}
      />
    </Dialog>
  )
}
