import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  canUserConfigureAdvisor,
  getEffectiveAdvisorModel,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../utils/advisor.js'
import {
  getDefaultMainLoopModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { isModelAllowed } from '../utils/model/modelAllowlist.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim().toLowerCase()
  const baseModel = parseUserSpecifiedModel(
    context.getAppState().mainLoopModel ?? getDefaultMainLoopModelSetting(),
  )

  if (!arg) {
    // CC 2.1.295 port: a saved advisor model that is no longer available
    // reads as "No advisor" — the official dialog fix ("it now opens on 'No
    // advisor'") instead of showing a checkmark on the unavailable saved
    // model. Display-only: the saved setting is left untouched, exactly like
    // the official fix. See getEffectiveAdvisorModel in utils/advisor.ts.
    const current = getEffectiveAdvisorModel(
      context.getAppState().advisorModel,
      model => isValidAdvisorModel(model) && isModelAllowed(model),
    )
    if (!current) {
      return {
        type: 'text',
        value:
          'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor opus").',
      }
    }
    if (!modelSupportsAdvisor(baseModel)) {
      return {
        type: 'text',
        value: `Advisor: ${current} (inactive)\nThe current model (${baseModel}) does not support advisors.`,
      }
    }
    return {
      type: 'text',
      value: `Advisor: ${current}\nUse "/advisor unset" to disable or "/advisor <model>" to change.`,
    }
  }

  if (arg === 'unset' || arg === 'off') {
    const prev = context.getAppState().advisorModel
    context.setAppState(s => {
      if (s.advisorModel === undefined) return s
      return { ...s, advisorModel: undefined }
    })
    updateSettingsForSource('userSettings', { advisorModel: undefined })
    return {
      type: 'text',
      value: prev
        ? `Advisor disabled (was ${prev}).`
        : 'Advisor already unset.',
    }
  }

  const normalizedModel = normalizeModelStringForAPI(arg)
  const resolvedModel = parseUserSpecifiedModel(arg)
  const { valid, error } = await validateModel(resolvedModel)
  if (!valid) {
    return {
      type: 'text',
      value: error
        ? `Invalid advisor model: ${error}`
        : `Unknown model: ${arg} (${resolvedModel})`,
    }
  }

  if (!isValidAdvisorModel(resolvedModel)) {
    return {
      type: 'text',
      value: `The model ${arg} (${resolvedModel}) cannot be used as an advisor`,
    }
  }

  // E34 (2.1.174): block a saved advisor model that's outside the
  // availableModels allowlist. Mirrors the official 2.1.200 binary's model
  // allowlist refusal: `Model '<model>' is not available. Your organization
  // restricts model selection.`
  if (!isModelAllowed(resolvedModel)) {
    return {
      type: 'text',
      value: `Model '${resolvedModel}' is not available. Your organization restricts model selection.`,
    }
  }

  context.setAppState(s => {
    if (s.advisorModel === normalizedModel) return s
    return { ...s, advisorModel: normalizedModel }
  })
  updateSettingsForSource('userSettings', { advisorModel: normalizedModel })

  if (!modelSupportsAdvisor(baseModel)) {
    return {
      type: 'text',
      value: `Advisor set to ${normalizedModel}.\nNote: Your current model (${baseModel}) does not support advisors. Switch to a supported model to use the advisor.`,
    }
  }

  return {
    type: 'text',
    value: `Advisor set to ${normalizedModel}.`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  description: 'Let Claude consult a stronger model at key moments',
  argumentHint: '[<model>|off]',
  isEnabled: () => canUserConfigureAdvisor(),
  get isHidden() {
    return !canUserConfigureAdvisor()
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
