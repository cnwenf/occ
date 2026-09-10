import type { Command } from '../../commands.js'
import { buildEffortArgumentHint } from '../../utils/effort/cap.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  // OCC-82 (official 2.1.267 `txr`): the argumentHint is cap-aware — built
  // from S9 (allowed levels under the effective cap) + conditional ultracode
  // (zS) + auto. Getter so it reflects the model/settings at access time.
  get argumentHint() {
    return buildEffortArgumentHint('[', ']', getMainLoopModel())
  },
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
