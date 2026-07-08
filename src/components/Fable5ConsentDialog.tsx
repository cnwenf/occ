import * as React from 'react'
import { Box, Text, type Root } from '../ink.js'
import { showSetupDialog } from '../interactiveHelpers.js'
import { Select } from './CustomSelect/index.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'
import {
  hasFableConsent,
  hasFableConsentRecord,
  saveFableConsent,
} from '../utils/fable/fableConsent.js'
import { isFableModel } from '../utils/fable/isFableModel.js'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  type ModelSetting,
} from '../utils/model/model.js'

type FableConsentChoice = 'accept' | 'decline'

type Props = {
  /** Resolves the gate promise with the user's decision (persisted internally). */
  onDone: (accepted: boolean) => void
}

/**
 * First-use consent dialog for the Fable 5 research preview model. Mirrors the
 * TrustDialog pattern: a `PermissionDialog` + two-option `Select`. Accept
 * proceeds with Fable 5; decline (or Esc) falls back to the default model.
 * The choice is persisted via `saveFableConsent` so the dialog never repeats.
 */
export function Fable5ConsentDialog({ onDone }: Props): React.ReactNode {
  const options: { label: string; value: FableConsentChoice }[] = [
    { label: 'Yes, use Fable 5', value: 'accept' },
    { label: 'No, use default model', value: 'decline' },
  ]

  const handleChange = (value: FableConsentChoice): void => {
    const accepted = value === 'accept'
    saveFableConsent(accepted)
    onDone(accepted)
  }

  return (
    <PermissionDialog color="warning" titleColor="warning" title="Fable 5 research preview">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text>Fable 5 is a research preview model. Usage may be tracked for quality improvement.</Text>
        <Text>Do you consent to using Fable 5?</Text>
        <Select
          options={options}
          onChange={value => handleChange(value as FableConsentChoice)}
          onCancel={() => handleChange('decline')}
        />
        <Text dimColor>Enter to confirm · Esc to cancel</Text>
      </Box>
    </PermissionDialog>
  )
}

/**
 * Interactive Fable 5 consent gate. Runs after setup screens so the Ink root
 * is available. Non-Fable models pass through unchanged. A recorded consent
 * (true or false) is honored without re-prompting; only a missing record
 * triggers the dialog. Returns the model to use (the Fable model when
 * consented, `null` to fall back to the default model otherwise).
 */
export async function ensureFableConsent(
  root: Root,
  modelSetting: ModelSetting,
): Promise<ModelSetting> {
  const resolved = parseUserSpecifiedModel(modelSetting ?? getDefaultMainLoopModelSetting())
  if (!isFableModel(resolved)) return modelSetting

  // A recorded decision is sticky either way.
  if (hasFableConsentRecord()) {
    return hasFableConsent() ? modelSetting : null
  }

  // First use: prompt. The dialog persists the choice before resolving.
  const accepted = await showSetupDialog<boolean>(root, done => (
    <Fable5ConsentDialog onDone={done} />
  ))
  return accepted ? modelSetting : null
}

/**
 * Non-interactive consent gate for pipe / headless sessions, where a dialog
 * cannot be shown. Requires prior consent to use Fable 5; otherwise falls
 * back to the default model (`null`). Non-Fable models pass through unchanged.
 */
export function ensureFableConsentSync(modelSetting: ModelSetting): ModelSetting {
  const resolved = parseUserSpecifiedModel(modelSetting ?? getDefaultMainLoopModelSetting())
  if (!isFableModel(resolved)) return modelSetting
  return hasFableConsent() ? modelSetting : null
}
