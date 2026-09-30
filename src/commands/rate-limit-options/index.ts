import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

// Official 2.1.284 (OCC-141, changelog bullet 5): added to /help and the
// command menu for claude.ai subscribers. Binary delta 283→284:
//   283: {type:"local-jsx",name:"rate-limit-options",description:"Show options when rate limit is reached",isEnabled:()=>pt()||!1,isHidden:!0,requires:{ink:!0}}
//   284: {type:"local-jsx",name:"rate-limit-options",description:"Manage usage limits and upgrade options",isEnabled:()=>ut()||!1,requires:{ink:!0}}
// i.e. description reworded (byte-identical below) and `isHidden` REMOVED so the
// command surfaces in /help + the command menu when isEnabled() (subscriber gate
// semantics unchanged: `ut()` is the claude.ai-subscriber scopes check).
const rateLimitOptions = {
  type: 'local-jsx',
  name: 'rate-limit-options',
  description: 'Manage usage limits and upgrade options',
  isEnabled: () => {
    if (!isClaudeAISubscriber()) {
      return false
    }

    return true
  },
  load: () => import('./rate-limit-options.js'),
} satisfies Command

export default rateLimitOptions
