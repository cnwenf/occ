import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  // OCC-97 (Gap-97c): xhigh added — official 2.1.233 argumentHint is built
  // from ["low","medium","high","xhigh","max"] + ultracode + auto.
  argumentHint: '[low|medium|high|xhigh|max|ultracode|auto]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
