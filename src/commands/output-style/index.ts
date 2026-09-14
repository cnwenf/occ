import type { Command } from '../../commands.js'

// 2.1.270 official definition (binary offset 195160405, minified name oLt):
//   {type:"local",name:"output-style",supportsNonInteractive:!0,
//    description:"List output styles or switch to one",argumentHint:"[style]",
//    isEnabled:()=>ke()||!E9(),get isHidden(){return!ke()&&E9()},load:...}
// E9() = I("tengu_maple_sundial",!1) → false in OCC (statsig trimmed), so
// `isEnabled` collapses to always-true and `isHidden` to always-false — both
// omitted here per the CommandBase defaults. The official also carries a dead
// local-jsx variant (wNr, "moved to /config", isEnabled:()=>E9()) which never
// runs — not ported.
const outputStyle = {
  type: 'local',
  name: 'output-style',
  supportsNonInteractive: true,
  description: 'List output styles or switch to one',
  argumentHint: '[style]',
  load: () => import('./output-style.js'),
} satisfies Command

export default outputStyle
