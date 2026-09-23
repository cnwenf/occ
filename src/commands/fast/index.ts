import type { Command } from '../../commands.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeEnabled,
} from '../../utils/fastMode.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const fast = {
  type: 'local-jsx',
  name: 'fast',
  get description() {
    return `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY} only)`
  },
  // OCC-134 acceptance (E2E PROBE-4): no `availability` gate — official 2.1.280
  // keeps /fast visible in every environment (custom base URLs, Bedrock/Vertex/
  // Foundry) and explains unavailability through the FastModePicker panel
  // (`getFastModeUnavailableReason()` reason strings), rather than answering
  // "Unknown command: /fast". The previously declared
  // `availability: ['claude-ai','console']` was an OCC-invented visibility
  // layer that suppressed the very panel the #082 footer port delivered.
  isEnabled: () => isFastModeEnabled(),
  get isHidden() {
    return !isFastModeEnabled()
  },
  argumentHint: '[on|off]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./fast.js'),
} satisfies Command

export default fast
