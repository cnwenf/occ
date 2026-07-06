import type { Command } from '../../commands.js'

// E25 (2.1.92): /release-notes is an interactive "What's new" version picker
// (local-jsx, requires Ink). Mirrors the 2.1.200 binary:
// `{description:"View release notes",name:"release-notes",type:"local-jsx",
//   requires:{ink:!0}}`.
const releaseNotes: Command = {
  description: 'View release notes',
  name: 'release-notes',
  type: 'local-jsx',
  requires: { ink: true },
  load: () => import('./release-notes.js'),
}

export default releaseNotes
