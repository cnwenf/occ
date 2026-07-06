import type { Command } from '../../commands.js'

const rewind = {
  description: `Restore the code and/or conversation to a previous point`,
  name: 'rewind',
  // 2.1.108: /undo is now an alias for /rewind.
  aliases: ['checkpoint', 'undo'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind

// 2.1.191: /rewind can resume from BEFORE a /clear. The pre-clear conversation
// is preserved on disk as a previous session; /rewind surfaces it as the
// "previous-session entry at the top" and hydrates its messages on demand.
export { rewindPastClearSituation } from './situations.js'
export type { RewindSituation } from './situations.js'
export {
  findPreClearSession,
  loadPreClearMessages,
  preClearTranscriptPath,
  readPreClearTranscript,
  resumeFromBeforeClear,
} from './resumeBeforeClear.js'
