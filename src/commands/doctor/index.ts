import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const doctor: Command = {
  name: 'doctor',
  // 2.1.205 #21: /checkup is an alias for /doctor. Mirrors the official
  // binary's `{name:"doctor", aliases:["checkup"]}` registration.
  aliases: ['checkup'],
  description: 'Diagnose and verify your Claude Code installation and settings',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  type: 'local-jsx',
  load: () => import('./doctor.js'),
}

export default doctor
